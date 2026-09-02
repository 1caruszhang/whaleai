import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { managementApi } from "../utils/management-api-client";

vi.mock("../utils/management-api-client", () => ({
  managementApi: vi.fn(),
}));

import type { GeoOperationProjection } from '../../shared/geo/operation';
import type { DistributionPlanProjection } from '../../shared/geo/distributionPlan';
import type { PublishExecutionProjection } from '../../shared/geo/publishScheduler';
import {
  accountTokenCacheFingerprint,
  articleOperationSourceFromGenerateInput,
  brandWorkspaceStateSummary,
  listUnfinishedGeoRounds,
  configureXiaojingGeo,
  confirmRankingCompetitors,
  distributionPlanCardProjection,
  geoOperationControlFailure,
  geoOperationProjectionPayload,
  geoProbeSamplesFailure,
  planDistributionBudgetCny,
  publishExecutionCardProjection,
  RankingCompetitorConfirmationGate,
  rankingCompetitorRequirement,
  sessionRankingCompetitorGate,
  startGeoOperation,
} from "./xiaojing-geo-tool";

describe("RankingCompetitorConfirmationGate", () => {
  const source = {
    kind: "direct" as const,
    count: 1,
    themes: ["本地服务六家对比"],
    contentType: "ranking" as const,
    constraints: "",
  };

  it("requires a prior insufficiency gate and a later verbatim user message", () => {
    const gate = new RankingCompetitorConfirmationGate();
    const input = {
      names: ["竞品丁", "竞品戊"],
    };
    expect(() =>
      gate.authorize(input, {
        id: "user-2",
        content: "补充竞品丁和竞品戊",
      }),
    ).toThrow("ranking_competitor_confirmation_not_requested");

    gate.issue({
      subject: "目标品牌",
      source,
      issuedAfterUserMessageId: "user-1",
    });
    expect(() =>
      gate.authorize(input, {
        id: "user-1",
        content: "补充竞品丁和竞品戊",
      }),
    ).toThrow("ranking_competitor_confirmation_user_reply_required");
    expect(
      gate.authorize(input, {
        id: "user-2",
        content: "补充竞品丁和竞品戊",
      }),
    ).toMatchObject({
      subject: "目标品牌",
      source,
      userInstruction: "补充竞品丁和竞品戊",
    });
  });

  it("rejects names that are not present in the latest user message", () => {
    const gate = new RankingCompetitorConfirmationGate();
    gate.issue({
      subject: "目标品牌",
      source,
      issuedAfterUserMessageId: "user-1",
    });
    expect(() =>
      gate.authorize(
        {
          names: ["模型搜索品牌"],
        },
        { id: "user-2", content: "补充竞品丁" },
      ),
    ).toThrow("ranking_competitor_confirmation_name_not_user_stated");
  });

  it("keeps the pending challenge across consecutive agent turns in one Session", () => {
    const firstTurnGate = sessionRankingCompetitorGate("session-ranking-cross-turn");
    firstTurnGate.clear();
    firstTurnGate.issue({
      subject: "目标品牌",
      source,
      issuedAfterUserMessageId: "user-1",
    });

    const secondTurnGate = sessionRankingCompetitorGate("session-ranking-cross-turn");
    expect(
      secondTurnGate.authorize(
        {
          names: ["竞品丁", "竞品戊"],
        },
        { id: "user-2", content: "补充竞品丁和竞品戊" },
      ),
    ).toMatchObject({ subject: "目标品牌", source });
    secondTurnGate.clear();
  });

  it("keeps the original user-reply fence when the same generation is retried", () => {
    const gate = new RankingCompetitorConfirmationGate();
    gate.issue({
      subject: "目标品牌",
      source,
      issuedAfterUserMessageId: "user-1",
    });
    gate.issue({
      subject: "目标品牌",
      source,
      issuedAfterUserMessageId: "user-2",
    });

    expect(
      gate.authorize(
        { names: ["竞品丁", "竞品戊"] },
        { id: "user-2", content: "补充竞品丁和竞品戊" },
      ),
    ).toMatchObject({ issuedAfterUserMessageId: "user-1" });
  });

  it("advances the fence past a partially consumed user message", () => {
    // 回归：部分采纳后必须推进围栏。曾经走 issue() 推进，但同主体去重把
    // 它变成空操作，同一条消息可以一轮一轮把「顺带提到」的名字全部直采纳。
    const gate = new RankingCompetitorConfirmationGate();
    gate.issue({
      subject: "目标品牌",
      source,
      issuedAfterUserMessageId: "user-1",
    });
    gate.authorize(
      { names: ["竞品丁"] },
      { id: "user-2", content: "补充竞品丁，另外聊到过竞品戊" },
    );
    gate.advanceFence("user-2");

    expect(() =>
      gate.authorize(
        { names: ["竞品戊"] },
        { id: "user-2", content: "补充竞品丁，另外聊到过竞品戊" },
      ),
    ).toThrow("ranking_competitor_confirmation_user_reply_required");

    expect(
      gate.authorize(
        { names: ["竞品戊"] },
        { id: "user-3", content: "确认补上竞品戊" },
      ),
    ).toMatchObject({ subject: "目标品牌", source });
  });
});

describe("confirmRankingCompetitors", () => {
  it("adopts only the names explicitly confirmed in natural language and reports readiness", async () => {
    const propose = vi.fn(async (input) => ({
      id: "candidate-ranking",
      baseVersion: 3,
      ...input,
    }));
    const decide = vi.fn(async () => ({
      current: {
        normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
      },
    }));
    const authority = {
      inspect: vi.fn(async () => null),
      propose,
      decide,
    } as never;
    const result = await confirmRankingCompetitors(
      {
        subject: "目标品牌",
        names: ["竞品丁", "竞品戊"],
        userInstruction: "补充竞品丁和竞品戊，并确认它们是竞品",
      },
      authority,
    );

    expect(propose).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "user-stated",
        intent: "knowledge-update",
        value: ["竞品丁", "竞品戊"],
        source: expect.objectContaining({ profileProvenance: "asked" }),
      }),
    );
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "candidate-ranking",
        decision: "adopt-new",
        expectedCurrentVersion: 3,
      }),
    );
    expect(result).toMatchObject({ confirmedCount: 5, readyForRanking: true });
  });
});

describe("rankingCompetitorRequirement", () => {
  it("turns the generation guard into a natural-language supplementation request", () => {
    expect(
      rankingCompetitorRequirement(
        new Error("article_generation_ranking_competitors_insufficient:3"),
      ),
    ).toEqual({
      kind: "ranking-competitors-required",
      confirmedCount: 3,
      missingCount: 2,
      instruction:
        "当前已确认 3 家竞品，还差 2 家。请用户直接在聊天中回复要补充并确认的竞品名称。",
    });
    expect(
      rankingCompetitorRequirement(new Error("provider unavailable")),
    ).toBeNull();
  });
});

function operation(
  overrides: Partial<GeoOperationProjection> = {},
): GeoOperationProjection {
  return {
    id: 'op-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    kind: 'full-optimization',
    goal: '完整优化',
    status: 'ready',
    steps: [],
    inputRefs: [],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    revision: 1,
    executionGeneration: 0,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    terminalAt: null,
    ...overrides,
  };
}

describe('accountTokenCacheFingerprint', () => {
  it('hashes the raw token into a stable 16-hex fingerprint', () => {
    const fingerprint = accountTokenCacheFingerprint('account-token-secret-1');
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain('account-token-secret-1');
    // 同 token 同指纹（实例复用），不同 token 不同指纹（轮换后重建）。
    expect(accountTokenCacheFingerprint('account-token-secret-1')).toBe(fingerprint);
    expect(accountTokenCacheFingerprint('account-token-secret-2')).not.toBe(fingerprint);
  });

  it('maps a missing token to an empty fingerprint', () => {
    expect(accountTokenCacheFingerprint(undefined)).toBe('');
    expect(accountTokenCacheFingerprint('')).toBe('');
  });
});

describe('geoOperationProjectionPayload', () => {
  it('attaches a modeling hint exactly when the session list is empty', () => {
    const empty = geoOperationProjectionPayload([]);
    expect(empty.kind).toBe('geo-operation-projection');
    if (empty.kind !== 'geo-operation-projection') throw new Error('projection envelope expected');
    expect(empty.result).toEqual([]);
    expect(typeof empty.hint).toBe('string');
    expect(empty.hint).toContain('start_geo_operation');
  });

  it('keeps non-empty lists and single-operation reads hint-free', () => {
    const listed = geoOperationProjectionPayload([operation()]);
    if (listed.kind !== 'geo-operation-projection') throw new Error('projection envelope expected');
    expect(listed.hint).toBeUndefined();
    expect(listed.result).toHaveLength(1);

    const single = geoOperationProjectionPayload(operation({ id: 'op-2' }));
    if (single.kind !== 'geo-operation-projection') throw new Error('projection envelope expected');
    expect(single.hint).toBeUndefined();
    expect(single.result).toMatchObject({ id: 'op-2' });
  });
});

describe('geoOperationControlFailure', () => {
  it('keeps the Rust error verbatim and adds a recovery hint for invalid transitions', () => {
    const failure = geoOperationControlFailure(
      new Error('geo_operation_transition_invalid:ready (valid control actions: pause, cancel)'),
    );
    expect(failure).toMatchObject({
      kind: 'geo-operation-control',
      ok: false,
      error: 'geo_operation_transition_invalid:ready (valid control actions: pause, cancel)',
    });
    expect(failure.hint).toContain('合法的控制动作');
    expect(failure.hint).toContain('inspect_geo_operations');
  });

  it('guides terminal operations toward a new operation instead of more control calls', () => {
    const failure = geoOperationControlFailure(new Error('geo_operation_already_terminal'));
    expect(failure.hint).toContain('start_geo_operation');
  });

  it('points stale revisions back to a fresh inspect read', () => {
    const failure = geoOperationControlFailure(new Error('geo_operation_revision_conflict'));
    expect(failure.hint).toContain('revision');
  });

  it('falls back to a generic inspect-first hint for unknown errors', () => {
    const failure = geoOperationControlFailure('sidecar lock poisoned');
    expect(failure).toMatchObject({ kind: 'geo-operation-control', ok: false, error: 'sidecar lock poisoned' });
    expect(failure.hint).toContain('inspect_geo_operations');
  });
});

describe('geoProbeSamplesFailure', () => {
  it('keeps the Rust error verbatim and points at the effects page', () => {
    const failure = geoProbeSamplesFailure(new Error('geo_dashboard_drilldown_not_found'));
    expect(failure).toMatchObject({
      kind: 'geo-probe-samples',
      ok: false,
      error: 'geo_dashboard_drilldown_not_found',
    });
    expect(failure.hint).toContain('效果');
  });

  it('stringifies non-Error rejections', () => {
    const failure = geoProbeSamplesFailure('management_unavailable');
    expect(failure).toMatchObject({ kind: 'geo-probe-samples', ok: false, error: 'management_unavailable' });
  });
});

/**
 * 票 #27（ADR-0010 Decision 5）：start_geo_operation 的起点推导理由
 * 通道——agent 经「带推荐选项问」得到用户选择后传入 startingPointReason，
 * 它只落在持久化 create 请求里认可门 confirmation 的 summary 上（既有
 * 卡片 payload 通道，renderer 零改动），不改步骤序列。
 */
describe('startGeoOperation starting-point derivation reason (ticket #27)', () => {
  const api = vi.mocked(managementApi);
  let previousSidecarId: string | undefined;

  beforeEach(() => {
    previousSidecarId = process.env.XIAOJING_SIDECAR_ID;
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-derivation';
  });

  afterEach(() => {
    if (previousSidecarId === undefined) {
      delete process.env.XIAOJING_SIDECAR_ID;
    } else {
      process.env.XIAOJING_SIDECAR_ID = previousSidecarId;
    }
    vi.clearAllMocks();
  });

  it('persists the derived starting point on the plan-ack confirmation summary', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'session-round-two',
      workspace: 'C:/ws/brand-a',
    });
    api.mockResolvedValue({ ok: true, operation: operation() });

    await startGeoOperation({
      intent: 'full-optimization',
      goal: '一轮完整的 GEO 优化',
      startingPointReason: '知识 3 天前刚确认，直接从问题机会继续',
    });

    expect(api).toHaveBeenCalledTimes(1);
    const [path, , body] = api.mock.calls[0] as unknown as [
      string,
      string,
      { payload: { steps: Array<{ id: string; confirmation?: { kind: string; summary: string } }> } },
    ];
    expect(path).toBe('/api/brand-geo-operations/create');
    const ack = body.payload.steps.find((step) => step.id === 'acknowledge-plan');
    expect(ack?.confirmation?.kind).toBe('plan-ack');
    expect(ack?.confirmation?.summary).toContain('从哪里开始');
    expect(ack?.confirmation?.summary).toContain('知识 3 天前刚确认，直接从问题机会继续');
  });

  // 起止推导：endingPhase/endingPointReason 随创建透传，认可门呈现完整跨度。
  it('spans the plan from the derived start through the endingPhase on the plan-ack gate', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'session-round-two',
      workspace: 'C:/ws/brand-a',
    });
    api.mockResolvedValue({ ok: true, operation: operation() });

    await startGeoOperation({
      intent: 'article-generation',
      goal: '从文章一路做到发布',
      startingPointReason: '知识、问题池与内容计划均已确认',
      endingPhase: 'publishing',
      endingPointReason: '用户选择先发文验证效果',
    });

    expect(api).toHaveBeenCalledTimes(1);
    const [path, , body] = api.mock.calls[0] as unknown as [
      string,
      string,
      { payload: { steps: Array<{ id: string; confirmation?: { kind: string; summary: string } }> } },
    ];
    expect(path).toBe('/api/brand-geo-operations/create');
    const ids = body.payload.steps.map((step) => step.id);
    // 跨度 = 文章直达段 + 分发段 + 发布段；计划认可门仍在首位。
    expect(ids).toEqual([
      'acknowledge-plan',
      'generate-articles',
      'confirm-articles',
      'plan-distribution',
      'confirm-distribution',
      'prepare-publish',
      'confirm-publish',
      'observe-publish',
    ]);
    const ack = body.payload.steps.find((step) => step.id === 'acknowledge-plan');
    expect(ack?.confirmation?.summary).toContain('到哪里结束：发布——用户选择先发文验证效果');
  });
});

/**
 * 聊天价格脱敏回归：plan_distribution / prepare_publish 的转录投影只携带
 * 点数字段——CNY 金额（*Cny）与 ¥ 符号一律不进聊天，模型只能引用点数。
 */
describe('transcript card projections keep CNY out of chat', () => {
  it('distributionPlanCardProjection converts budget and candidate prices to points', () => {
    const plan = {
      id: 'plan-1',
      status: 'draft',
      revision: 1,
      budgetCny: 1000,
      perArticleMaxPoints: 3_200,
      totalMaxPoints: 16_000,
      workspaceId: 'brand-1',
      publishStartAt: '2026-08-20T02:00:00Z',
      selectedResourceIds: [8],
      blockingIssues: [],
      articles: [{ id: 'article-1' }],
      assignments: [],
      candidates: [
        {
          resourceId: 8,
          kind: 'media',
          name: '汽车产业观察',
          estimatedPriceCny: 88,
          pathHits: ['passive'],
          fitReasons: [],
          evidence: [{ path: 'passive', label: '真实问题来源域名命中' }],
        },
        {
          resourceId: 9,
          kind: 'we-media',
          name: '车主生活圈',
          estimatedPriceCny: null,
          pathHits: [],
          fitReasons: [],
          evidence: [],
        },
      ],
    } as unknown as DistributionPlanProjection;

    const card = distributionPlanCardProjection(plan);
    expect(card.budgetPoints).toBe(16000);
    expect(card.perArticleMaxPoints).toBe(3200);
    expect(card.totalMaxPoints).toBe(16000);
    expect(card.candidates[0]?.estimatedPricePoints).toBe(1408);
    expect(card.candidates[1]?.estimatedPricePoints).toBeNull();

    const json = JSON.stringify({ kind: 'distribution-plan', plan: card });
    expect(json).not.toContain('Cny');
    expect(json).not.toContain('¥');
  });

  it('publishExecutionCardProjection strips every CNY field from the preview', () => {
    const execution = {
      id: 'exec-1',
      revision: 1,
      status: 'awaiting-confirmation',
      workspaceId: 'brand-1',
      distributionPlanId: 'plan-1',
      publishStartAt: '2026-08-20T02:00:00Z',
      confirmationDigest: 'digest-1',
      irreversibleImpact: '将付费并向外部渠道发布，不可撤销。',
      totalPricePoints: 1408,
      budgetCny: 1000,
      estimatedSpendCny: 88,
      items: [
        {
          id: 'item-1',
          status: 'pending',
          scheduledAt: '2026-08-20T02:00:00Z',
          article: { title: '成都汽车音响改装怎么选', bodySummary: '批准稿摘要。' },
          channel: {
            resourceId: 8,
            kind: 'media',
            name: '汽车产业观察',
            estimatedPriceCny: 88,
            pricePoints: 1408,
          },
          requestSummary: { estimatedPriceCny: 88 },
        },
      ],
    } as unknown as PublishExecutionProjection;

    const preview = publishExecutionCardProjection(execution);
    expect(preview.budgetPoints).toBe(16000);
    expect(preview.totalPricePoints).toBe(1408);
    expect(preview.items[0]?.channel.pricePoints).toBe(1408);
    expect(preview.confirmationDigest).toBe('digest-1');

    const json = JSON.stringify({ kind: 'publish-execution', execution: preview });
    expect(json).not.toContain('Cny');
    expect(json).not.toContain('¥');
    expect(json).not.toContain('estimatedPrice');
    expect(json).not.toContain('estimatedSpend');
  });
});

describe('planDistributionBudgetCny', () => {
  it('defaults to the product default budget when no points are given', () => {
    expect(planDistributionBudgetCny(undefined)).toBe(1_250);
  });

  it('converts a points budget cap back to internal CNY', () => {
    // 16000 点 → ¥1000；聊天边界只携带点数，换算倍率不进转录。
    expect(planDistributionBudgetCny(16_000)).toBe(1_000);
    expect(planDistributionBudgetCny(0)).toBe(0);
  });

  it('allows a lower plan budget but clamps it to the user total limit', () => {
    expect(planDistributionBudgetCny(8_000, 16_000)).toBe(500);
    expect(planDistributionBudgetCny(20_000, 16_000)).toBe(1_000);
  });
});

describe('brandWorkspaceStateSummary', () => {
  const api = vi.mocked(managementApi);
  let previousSidecarId: string | undefined;

  beforeEach(() => {
    previousSidecarId = process.env.XIAOJING_SIDECAR_ID;
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-summary';
  });

  afterEach(() => {
    if (previousSidecarId === undefined) {
      delete process.env.XIAOJING_SIDECAR_ID;
    } else {
      process.env.XIAOJING_SIDECAR_ID = previousSidecarId;
    }
    vi.clearAllMocks();
  });

  function routeBrandWorkspace(
    responses: Record<string, unknown>,
  ): void {
    api.mockImplementation(async (path: string): Promise<Record<string, unknown>> => {
      const response = responses[path] as Record<string, unknown> | undefined;
      if (response === undefined) {
        return { ok: false, error: `unrouted:${path}` };
      }
      return response;
    });
  }

  it('returns null without a workspace identity', async () => {
    configureXiaojingGeo({}, { sessionId: 'summary-session' });
    expect(await brandWorkspaceStateSummary()).toBeNull();
  });

  it('summarizes persisted cross-session state from the Rust latest ports', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'summary-session',
      workspace: 'C:/ws/brand-a',
    });
    routeBrandWorkspace({
      '/api/brand-materials/context': {
        ok: true,
        context: { workspaceId: 'brand-a', brandName: '目标品牌', productLines: ['汽车音响改装'] },
      },
      '/api/brand-knowledge/current': {
        ok: true,
        current: { normalizedValueJson: '["甲","乙","丙","丁","戊"]' },
      },
      '/api/brand-question-pools/latest': {
        ok: true,
        pool: {
          id: 'pool-latest-1', revision: 2,
          status: 'confirmed', productLine: '汽车音响改装', targetRegion: '成都',
          questions: [{}, {}], updatedAt: '2026-08-27T10:00:00Z',
        },
      },
      '/api/brand-topic-plans/latest': {
        ok: true,
        plan: {
          id: 'plan-latest-1', revision: 4,
          status: 'confirmed', productLine: '汽车音响改装', topics: [{}],
          updatedAt: '2026-08-27T11:00:00Z',
        },
      },
      '/api/brand-articles/latest': {
        ok: true,
        operation: {
          id: 'article-op-latest-1',
          status: 'completed',
          articles: [{ approvedVersion: { id: 'v' } }, { approvedVersion: null }],
          updatedAt: '2026-08-27T12:00:00Z',
        },
      },
      '/api/brand-distribution-plans/latest': {
        ok: true,
        plan: { status: 'confirmed', industry: '汽车后市场', updatedAt: '2026-08-27T13:00:00Z' },
      },
      '/api/brand-publish-scheduler/latest': {
        ok: true,
        execution: {
          status: 'scheduled', publishStartAt: '2026-08-28T09:00:00Z',
          updatedAt: '2026-08-27T14:00:00Z',
        },
      },
    });

    const summary = await brandWorkspaceStateSummary();

    expect(summary).toMatchObject({
      kind: 'brand-workspace-state',
      brandName: '目标品牌',
      productLines: ['汽车音响改装'],
      confirmedCompetitors: ['甲', '乙', '丙', '丁', '戊'],
      // id/revision 让 Agent 无需重跑 pool/plan 打捞句柄（起点推导直连）。
      questionPool: { present: true, state: { id: 'pool-latest-1', revision: 2, status: 'confirmed', questionCount: 2 } },
      topicPlan: { present: true, state: { id: 'plan-latest-1', revision: 4, topicCount: 1 } },
      articles: { present: true, state: { operationId: 'article-op-latest-1', articleCount: 2, approvedCount: 1 } },
      distributionPlan: { present: true, state: { industry: '汽车后市场' } },
      publish: { present: true, state: { status: 'scheduled' } },
    });
  });

  it('degrades a failing stage to absent instead of failing the summary', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'summary-session',
      workspace: 'C:/ws/brand-a',
    });
    routeBrandWorkspace({
      '/api/brand-materials/context': {
        ok: true,
        context: { workspaceId: 'brand-a', brandName: '目标品牌', productLines: [] },
      },
      '/api/brand-knowledge/current': {
        ok: true,
        current: null,
      },
    });

    const summary = await brandWorkspaceStateSummary();

    expect(summary).toMatchObject({
      brandName: '目标品牌',
      confirmedCompetitors: [],
      questionPool: { present: false },
    });
  });

  it('marks a failed knowledge read as unknown (null), not an empty competitor list', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'summary-session',
      workspace: 'C:/ws/brand-a',
    });
    // 品牌材料上下文失败 → brandName/竞品均为 null（未知），
    // 不得与「确认过但一家都没有」（[]）混淆。
    routeBrandWorkspace({});

    const summary = await brandWorkspaceStateSummary();

    expect(summary).toMatchObject({
      brandName: null,
      confirmedCompetitors: null,
      questionPool: { present: false },
    });
  });

  it('marks a failed competitor fact read as unknown even when brand context succeeds', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'summary-session',
      workspace: 'C:/ws/brand-a',
    });
    routeBrandWorkspace({
      '/api/brand-materials/context': {
        ok: true,
        context: { workspaceId: 'brand-a', brandName: '目标品牌', productLines: [] },
      },
      '/api/brand-knowledge/current': {
        ok: false,
        error: 'knowledge_read_failed',
      },
    });

    const summary = await brandWorkspaceStateSummary();

    expect(summary).toMatchObject({
      brandName: '目标品牌',
      confirmedCompetitors: null,
    });
  });

  it('no longer consumes the cross-session unfinished list (ticket #10 revision)', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'summary-session',
      workspace: 'C:/ws/brand-a',
    });
    const calls: string[] = [];
    api.mockImplementation(async (path: string): Promise<Record<string, unknown>> => {
      calls.push(path);
      if (path === '/api/brand-materials/context') {
        return { ok: true, context: { workspaceId: 'brand-a', brandName: '目标品牌', productLines: [] } };
      }
      return { ok: false, error: `unrouted:${path}` };
    });

    const summary = await brandWorkspaceStateSummary();

    // 摘要不携带未完成轮次：他轮信息在场会诱发起点推导的现场取舍
    // （17,742 字思考实测）。轮次元信息只经点名续轮查询按需读取。
    expect(summary && 'unfinishedOperations' in summary).toBe(false);
    expect(calls).not.toContain('/api/brand-geo-operations/unfinished');
  });
});

describe('listUnfinishedGeoRounds (票 #10 点名续轮专用查询)', () => {
  const api = vi.mocked(managementApi);
  let previousSidecarId: string | undefined;

  beforeEach(() => {
    previousSidecarId = process.env.XIAOJING_SIDECAR_ID;
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-named-rounds';
  });

  afterEach(() => {
    if (previousSidecarId === undefined) {
      delete process.env.XIAOJING_SIDECAR_ID;
    } else {
      process.env.XIAOJING_SIDECAR_ID = previousSidecarId;
    }
    vi.clearAllMocks();
  });

  function routeBrandWorkspace(
    responses: Record<string, unknown>,
  ): void {
    api.mockImplementation(async (path: string): Promise<Record<string, unknown>> => {
      const response = responses[path] as Record<string, unknown> | undefined;
      if (response === undefined) {
        return { ok: false, error: `unrouted:${path}` };
      }
      return response;
    });
  }
  it('maps the unfinished metadata entries with display phase and degrades nothing', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'named-session',
      workspace: 'C:/ws/brand-a',
    });
    routeBrandWorkspace({
      '/api/brand-geo-operations/unfinished': {
        ok: true,
        total: 2,
        operations: [
          {
            id: 'op-prior-round',
            sessionId: 'session-prior',
            kind: 'full-optimization',
            goal: '上一轮优化',
            status: 'awaiting-confirmation',
            stuckStep: {
              id: 'confirm-articles',
              title: '批准文章',
              capability: 'content-production',
              status: 'awaiting-confirmation',
            },
            pendingConfirmation: {
              kind: 'article-approval',
              authority: 'brand-workspace',
              title: '批准文章',
              summary: 'confirm article-approval',
            },
            pendingReviewCount: 2,
            createdAt: '2026-08-29T09:00:00Z',
            updatedAt: '2026-08-30T18:00:00Z',
          },
          {
            // 无主轮（票 10 验收实证）：sessionId null 必须原样透传。
            id: 'op-ownerless',
            sessionId: null,
            kind: 'next-round-optimization',
            goal: '新一轮内容优化到发布',
            status: 'awaiting-confirmation',
            stuckStep: {
              id: 'select-next-question-pool',
              title: '从问题池选择',
              capability: 'question-opportunities',
              status: 'awaiting-confirmation',
            },
            pendingConfirmation: null,
            pendingReviewCount: 0,
            createdAt: '2026-08-29T09:00:00Z',
            updatedAt: '2026-08-30T18:00:00Z',
            updateKnowledge: false,
          },
        ],
      },
    });

    const payload = await listUnfinishedGeoRounds();

    // 元信息六要素 + 展示阶段；无正文字段。updateKnowledge 缺省 → null
    // 不臆断（票 #04），显式 false → 复用轮。
    expect(payload).toEqual({
      kind: 'geo-operation-unfinished-rounds',
      total: 2,
      truncatedCount: 0,
      rounds: [
        {
          operationId: 'op-prior-round',
          sessionId: 'session-prior',
          kind: 'full-optimization',
          goal: '上一轮优化',
          status: 'awaiting-confirmation',
          stuckStep: {
            id: 'confirm-articles',
            title: '批准文章',
            capability: 'content-production',
            status: 'awaiting-confirmation',
            phase: { id: 'content', title: '内容生产' },
          },
          pendingConfirmation: { kind: 'article-approval', title: '批准文章' },
          pendingReviewCount: 2,
          createdAt: '2026-08-29T09:00:00Z',
          updatedAt: '2026-08-30T18:00:00Z',
          updateKnowledge: null,
        },
        {
          operationId: 'op-ownerless',
          sessionId: null,
          kind: 'next-round-optimization',
          goal: '新一轮内容优化到发布',
          status: 'awaiting-confirmation',
          stuckStep: {
            id: 'select-next-question-pool',
            title: '从问题池选择',
            capability: 'question-opportunities',
            status: 'awaiting-confirmation',
            phase: { id: 'questions', title: '问题机会' },
          },
          pendingConfirmation: null,
          pendingReviewCount: 0,
          createdAt: '2026-08-29T09:00:00Z',
          updatedAt: '2026-08-30T18:00:00Z',
          updateKnowledge: false,
        },
      ],
    });
  });

  it('derives truncatedCount when the unfinished list is capped below the total', async () => {
    configureXiaojingGeo({}, {
      sessionId: 'named-session',
      workspace: 'C:/ws/brand-a',
    });
    routeBrandWorkspace({
      '/api/brand-geo-operations/unfinished': {
        ok: true,
        operations: [
          {
            id: 'op-newest',
            sessionId: 'session-prior',
            kind: 'full-optimization',
            goal: '最新一轮',
            status: 'awaiting-confirmation',
            stuckStep: null,
            pendingConfirmation: null,
            pendingReviewCount: 0,
            createdAt: '2026-08-29T09:00:00Z',
            updatedAt: '2026-08-31T18:00:00Z',
          },
        ],
        total: 7,
      },
    });

    const payload = await listUnfinishedGeoRounds();

    expect(payload.rounds).toHaveLength(1);
    expect(payload.total).toBe(7);
    expect(payload.truncatedCount).toBe(6);
  });
});

describe('articleOperationSourceFromGenerateInput (票 #34 生成时选取)', () => {
  it('defaults to the latest confirmed plan and carries an explicit subset', () => {
    expect(articleOperationSourceFromGenerateInput({})).toEqual({
      kind: 'confirmed-topic-plan',
    });
    expect(
      articleOperationSourceFromGenerateInput({
        planId: 'plan-7',
        itemIds: ['item-b', 'item-a'],
      }),
    ).toEqual({
      kind: 'confirmed-topic-plan',
      planId: 'plan-7',
      itemIds: ['item-b', 'item-a'],
    });
  });

  it('keeps planId and direct mutually exclusive', () => {
    expect(() =>
      articleOperationSourceFromGenerateInput({
        planId: 'plan-7',
        direct: {
          count: 1,
          themes: ['主题'],
          contentType: 'guide',
          constraints: '',
        },
      }),
    ).toThrow(/never both/);
  });

  it('rejects a plan item subset combined with direct', () => {
    expect(() =>
      articleOperationSourceFromGenerateInput({
        itemIds: ['item-a'],
        direct: {
          count: 1,
          themes: ['主题'],
          contentType: 'guide',
          constraints: '',
        },
      }),
    ).toThrow(/cannot be combined with direct/);
  });

  it('maps the direct payload verbatim', () => {
    expect(
      articleOperationSourceFromGenerateInput({
        direct: {
          count: 2,
          themes: ['主题一', '主题二'],
          contentType: 'ranking',
          constraints: '六家并列',
        },
      }),
    ).toEqual({
      kind: 'direct',
      count: 2,
      themes: ['主题一', '主题二'],
      contentType: 'ranking',
      constraints: '六家并列',
    });
  });
});
