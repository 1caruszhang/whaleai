import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 票 07 验收集成：Sidecar 域服务 + 真实运营后端 Hono app（进程内
// app.request，不起端口、不触公网）+ mock Provider 上游。覆盖：
// 余额/流水扣点、部分单位失败仅成功结转、幂等重试不二次扣、缓存命中
// 不扣点、监测余额不足自动暂停与充值恢复、浏览/读取面零 permit 调用。
// 后端 helpers（backend/tests/helpers.ts 模式）注入 mock 上游 fetch。
import {
  postJson,
  provisionLoggedInAccount,
  startTestBackend,
  type TestBackend,
} from "../../../backend/tests/helpers";
import { OPERATION_PRICES } from "../../../backend/src/domain/pricing";
import { createGatewayBillingPermitChannel } from "./billing-permit";
import { GatewayBillingError } from "./billing-permit";
import { ArticleGenerationService, type ArticlePersistencePort } from "./article-generation";
import { DistributionPlanningService } from "./distribution-plan";
import { GeoBaselineService, type GeoBaselinePersistencePort } from "./baseline";
import {
  MONITORING_PATROL_UNIT_POINTS,
  PostPublishBaselineProbeService,
} from "./post-publish-monitoring";
import { createGeoProviderCapabilities } from "./provider-capabilities";
import { QuestionPoolService, type QuestionPoolPersistencePort } from "./question-pool";
import type { ArticleGenerationContext, ArticleProjection } from "../../shared/geo/articleGeneration";
import {
  GEO_BASELINE_POLICY_VERSION,
  aggregateGeoBaselineUnits,
  type GeoBaselineEvidenceUnit,
  type GeoBaselineProjection,
  type GeoBaselineProviderSnapshot,
} from "../../shared/geo/baseline";
import type { QuestionPoolProjection, QuestionPoolStage } from "../../shared/geo/questionPool";

const GATEWAY_BASE = "https://gw.example.test";

/** 路由 fetch：网关流量 → 后端 app.request；其余 → mock Provider 上游。 */
function gatewayFetch(app: TestBackend["app"], upstream: (url: string, init?: RequestInit) => Response) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(GATEWAY_BASE)) {
      seen.push(`gw ${new URL(url).pathname}`);
      return app.request(new URL(url).pathname + new URL(url).search, init);
    }
    seen.push(`upstream ${url}`);
    return upstream(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const chatContent = (text: string) =>
  JSON.stringify({ choices: [{ message: { content: text } }] });

function upstreamMock(options: { failThemes?: string[] } = {}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  // 既当 backend 的 fetchImpl 注入（(input, init) 形态），也被本测试的路由
  // fetch 直接调用：body 一律从 init.body 解析。
  const respond = (url: string, init?: RequestInit): Response => {
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    const body = bodyText === undefined ? undefined : JSON.parse(bodyText);
    calls.push({ url, body });
    const parsed = body as {
      model?: string;
      enable_search?: boolean;
      messages?: Array<{ content: string }>;
    } | undefined;
    const prompt = parsed?.messages?.map((message) => message.content).join("\n") ?? "";
    if (
      url.endsWith("/chat/completions") &&
      parsed?.model?.includes("pro") &&
      options.failThemes?.some((theme) => prompt.includes(theme))
    ) {
      return new Response(JSON.stringify({ error: "mock upstream failure" }), { status: 500 });
    }
    if (url.endsWith("/chat/completions")) {
      // 关键词挖掘（enable_search 生成语料）。
      if (parsed?.enable_search === true) {
        return new Response(
          chatContent(
            JSON.stringify({
              core: [{ term: "成都汽车改装", heat: "high" }],
              scene: [{ term: "锦江区汽车隔音", heat: "medium" }],
              longtail: [{ term: "成都汽车音响改装店资质怎么看", heat: "low" }],
            }),
          ),
          { status: 200 },
        );
      }
      // direct 路径标题规划（lite 模型）：3–5 候选。
      if (parsed?.model?.includes("lite")) {
        return new Response(
          chatContent(
            JSON.stringify({
              candidates: [
                "测试品牌知识服务怎么选",
                "知识服务怎么选看这3点",
                "想做知识服务先搞清这几个问题",
              ],
            }),
          ),
          { status: 200 },
        );
      }
      if (prompt.includes("最高原则")) {
        return new Response(
          chatContent(
            JSON.stringify({
              questions: [
                {
                  text: "成都汽车改装哪家好？",
                  recommended: true,
                  sourceKeywords: ["成都汽车改装"],
                },
                {
                  text: "锦江区汽车隔音推荐哪家？",
                  sourceKeywords: ["锦江区汽车隔音"],
                },
              ],
            }),
          ),
          { status: 200 },
        );
      }
      // 文章正文（direct 路径标题腿已在上方 lite 分支返回候选）。
      return new Response(
        chatContent(`# 测试品牌知识服务怎么选\n\n## 定义\n品牌成立10年。\n\n## 清单\n- 核对事实\n- 固定版本`),
        { status: 200 },
      );
    }
    if (url.endsWith("/responses")) {
      return new Response(
        JSON.stringify({
          output_text: "TOP 1：鲸跃汽车值得考虑。",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "TOP 1：鲸跃汽车值得考虑。",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: { url: "https://brand.test/article-1", title: "品牌站" },
                    },
                  ],
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/embeddings/multimodal")) {
      const inputs = (body as { input?: unknown[] })?.input ?? [];
      return new Response(
        JSON.stringify({
          data: { embedding: Array.from({ length: 2048 }, (_, index) => index % 7) },
          usage: { prompt_tokens: inputs.length * 10 },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/media/resource") || url.includes("/we-media/resource")) {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            total: 1,
            items: [
              { id: 11, name: "汽车日报", status: 2, price: "88", published_rate: 90, entrance_link: "https://auto.example.com" },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { respond, calls };
}

// ---------------------------------------------------------------------------
// 域服务 Fake 持久化（Rust 管理端口在进程内以最小确定性桩替代）
// ---------------------------------------------------------------------------

function questionPoolPersistence() {
  const status = new Map<QuestionPoolStage, string>();
  const outputs = new Map<QuestionPoolStage, unknown>();
  const keyword = {
    id: "kw-1",
    term: "成都汽车改装",
    category: "core" as const,
    heat: "high" as const,
    platform: "doubao" as const,
  };
  const pool: QuestionPoolProjection = {
    id: "pool-int",
    attemptId: "attempt-int",
    operationId: "operation-int",
    workspaceId: "brand-int",
    knowledgeVersion: 1,
    productLine: "汽车音响",
    targetRegion: "成都",
    generationParameters: {
      policyVersion: "xiaojing-content-prompt-v1",
      candidateLimit: 20,
      recentSelectionLimit: 20,
      priorityThresholds: { highAtSum: 150, mediumAtSum: 100 },
    },
    status: "generating",
    revision: 0,
    keywords: [],
    questions: [],
    sourceEvidence: [],
    checkpoints: [],
    reused: false,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
  };
  const context = () => ({
    knowledgeVersion: 1,
    brandName: "鲸跃",
    productLines: ["汽车音响"],
    facts: [
      {
        factKey: "industry",
        subject: "鲸跃",
        predicate: "enterprise-profile.industry",
        scopeJson: '{"entityScope":"brand"}',
        normalizedValueJson: '"汽车改装"',
        sources: [],
      },
    ],
    recentSelectedQuestions: [],
    keywordLibrary: [],
  });
  return {
    markAllCached() {
      outputs.set("keyword-search", {
        raw: "raw",
        keywords: [
          keyword,
          {
            id: "kw-2",
            term: "锦江区汽车隔音",
            category: "scene" as const,
            heat: "medium" as const,
            platform: "doubao" as const,
          },
          {
            id: "kw-3",
            term: "成都汽车音响改装店资质怎么看",
            category: "longtail" as const,
            heat: "low" as const,
            platform: "doubao" as const,
          },
        ],
      });
      outputs.set("question-generation", {
        raw: "raw",
        candidates: [
          { text: "成都汽车改装哪家好？", recommended: true, sourceKeywords: ["成都汽车改装"] },
          { text: "锦江区汽车隔音推荐哪家？", recommended: false, sourceKeywords: ["锦江区汽车隔音"] },
        ],
      });
      outputs.set("embedding", { vectors: [[1, 0], [0, 1], [1, 1]] });
      outputs.set("persist", { poolId: pool.id, revision: 1 });
      for (const stage of ["keyword-search", "question-generation", "embedding", "persist"] as const) {
        status.set(stage, "completed");
      }
    },
    port: {
      async latest() {
        return null;
      },
      async prepare() {
        return {
          kind: "attempt" as const,
          context: context(),
          attempt: {
            id: "attempt-int",
            poolId: pool.id,
            state: "running",
            idempotencyKey: "request-int",
          },
          pool,
        };
      },
      async claim(input: { stage: QuestionPoolStage }) {
        if (status.get(input.stage) === "completed") {
          return {
            action: "cached" as const,
            output: outputs.get(input.stage),
            attemptNumber: 1,
            billingKey: `attempt-int:${input.stage}`,
          };
        }
        return {
          action: "execute" as const,
          claimToken: `claim:${input.stage}`,
          attemptNumber: 1,
          billingKey: `attempt-int:${input.stage}`,
        };
      },
      async finish(input: { stage: QuestionPoolStage; status: string; output?: unknown }) {
        status.set(input.stage, input.status);
        if (input.status === "completed" && input.output !== undefined) {
          outputs.set(input.stage, input.output);
        }
      },
      async persist() {
        return { ...pool, status: "awaiting-selection" };
      },
      async cancel() {
        return { ...pool, status: "cancelled" };
      },
      async decide() {
        throw new Error("not used");
      },
      async revise() {
        throw new Error("not used");
      },
    } as unknown as QuestionPoolPersistencePort,
  };
}

function baselinePersistence(unitCount: number) {
  const snapshot: GeoBaselineProviderSnapshot = {
    engineId: "doubao",
    provider: "volcengine",
    capabilitySlot: "keyword-search",
    model: "doubao-seed-2-0-lite-260428",
    endpointFamily: "ark-responses",
    searchMode: "doubao-app-ai-search",
    configurationFingerprint: "integration-fingerprint",
    policyVersion: GEO_BASELINE_POLICY_VERSION,
  };
  const units: GeoBaselineEvidenceUnit[] = Array.from({ length: unitCount }, (_, index) => ({
    id: `unit-${index + 1}`,
    questionId: `q-${index + 1}`,
    question: `成都汽车改装哪家好？${index + 1}`,
    engineId: "doubao",
    providerSnapshot: snapshot,
    status: "pending",
    attemptNumber: 0,
    citations: [],
    attempts: [],
  }));
  const projection: GeoBaselineProjection = {
    id: "baseline-int",
    operationId: "operation-int",
    workspaceId: "brand-int",
    createdBySessionId: "session-int",
    questionPoolId: "pool-int",
    questionPoolRevision: 1,
    knowledgeVersion: 1,
    brandNames: ["鲸跃"],
    competitorNames: [],
    providerSnapshots: [snapshot],
    policyVersion: GEO_BASELINE_POLICY_VERSION,
    status: "running",
    metrics: aggregateGeoBaselineUnits(units),
    units,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
  };
  return {
    projection,
    port: {
      async latest() {
        return projection;
      },
      async get(id: string) {
        return id === projection.id ? projection : null;
      },
      async prepare() {
        return {
          baseline: projection,
          brandNames: projection.brandNames,
          competitorNames: projection.competitorNames,
        };
      },
      async claim(input: { unitId: string }) {
        const target = projection.units.find((unit) => unit.id === input.unitId)!;
        if (target.status === "succeeded") {
          return { action: "cached" as const, claimToken: null, attemptNumber: target.attemptNumber };
        }
        target.attemptNumber += 1;
        return {
          action: "execute" as const,
          claimToken: `claim-${target.id}-${target.attemptNumber}`,
          attemptNumber: target.attemptNumber,
        };
      },
      async finish(input: { unitId: string; status: "succeeded" | "failed" }) {
        const target = projection.units.find((unit) => unit.id === input.unitId)!;
        target.status = input.status;
        projection.metrics = aggregateGeoBaselineUnits(projection.units);
      },
    } as unknown as GeoBaselinePersistencePort,
  };
}

function articlePersistence(count: number) {
  const articles: ArticleProjection[] = Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`,
    operationId: "operation-int",
    workspaceId: "brand-int",
    sourcePlanItemId: null,
    knowledgeVersion: 1,
    contentType: "guide" as const,
    topic: `主题 a${index + 1}`,
    requestedTitle: "测试品牌知识服务怎么选",
    constraints: "",
    plannedFacts: [
      {
        factKey: "fact-1",
        predicate: "profile.history",
        normalizedValueJson: '"成立10年"',
      },
    ],
    status: "planned" as const,
    revision: 0,
    approvedRevision: null,
    failureReason: null,
    generationAttempt: 0,
    currentVersion: null,
    approvedVersion: null,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
  }));
  const operation = {
    id: "operation-int",
    workspaceId: "brand-int",
    createdBySessionId: "session-int",
    sourceKind: "direct" as const,
    topicPlanId: null,
    topicPlanRevision: null,
    knowledgeVersion: 1,
    policyVersion: "xiaojing-content-prompt-v2",
    status: "running" as const,
    articles,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
  };
  const claimAttempt = new Map<string, number>();
  return {
    operation,
    port: {
      async latest() {
        return operation;
      },
      async getOperation() {
        return operation;
      },
      async start() {
        return operation;
      },
      async get(_operationId: string, articleId: string) {
        return articles.find((article) => article.id === articleId)!;
      },
      async claimGeneration(input: { articleId: string }) {
        const article = articles.find((candidate) => candidate.id === input.articleId)!;
        const attempt = (claimAttempt.get(input.articleId) ?? 0) + 1;
        claimAttempt.set(input.articleId, attempt);
        return {
          article: { ...article, generationAttempt: attempt },
          brandName: "测试品牌",
          productLine: "知识服务",
          targetRegion: "中国",
          claimToken: `claim-${input.articleId}-${attempt}`,
        } satisfies ArticleGenerationContext;
      },
      async finishGeneration(input: { articleId: string }) {
        const article = articles.find((candidate) => candidate.id === input.articleId)!;
        article.status = "draft_ready";
        return { ...article, revision: 1 };
      },
      async failGeneration(input: { articleId: string; failureReason: string }) {
        const article = articles.find((candidate) => candidate.id === input.articleId)!;
        article.status = "generation_failed";
        article.failureReason = input.failureReason;
        return { ...article };
      },
      async edit() {
        throw new Error("not used");
      },
      async body() {
        throw new Error("not used");
      },
      async claimReview() {
        throw new Error("not used");
      },
      async finishReview() {
        throw new Error("not used");
      },
    } as unknown as ArticlePersistencePort,
  };
}

function distributionPersistence() {
  let sequence = 0;
  const plan = () => ({
    id: `plan-int-${++sequence}`,
    operationId: `operation-plan-${sequence}`,
    workspaceId: "brand-int",
    createdBySessionId: "session-int",
    articleOperationId: "article-operation",
    policyVersion: "js-ai-dev-four-path-distribution-v1",
    status: "discovering" as unknown as never,
    revision: 0,
    industry: "汽车改装",
    targetAudience: "新能源车主",
    questionSources: [],
    articles: [
      {
        articleId: "article-1",
        title: "汽车行业观察",
        contentType: "news",
        approvedRevision: 1,
        approvedBodySha256: "hash",
      },
    ],
    mappingMode: "one-to-one",
    ratio: { media: 2, weMedia: 1 },
    budgetCny: 100,
    publishStartAt: "2026-08-20T01:00:00.000Z",
    providerState: "pending",
    providerSnapshot: null,
    resourceSnapshot: [],
    candidates: [],
    selectedResourceIds: [],
    assignments: [],
    discoverySummary: {
      inputResources: 0,
      approvedResources: 0,
      filteredUnavailable: 0,
      filteredHighPrice: 0,
      alignedResources: 0,
      recommendedResources: 0,
    },
    blockingIssues: [],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    confirmedAt: null,
  });
  const current = plan();
  const context = () => ({
    articleOperationId: "article-operation",
    knowledgeVersion: 1,
    industry: "汽车改装",
    articles: [
      {
        id: "article-1",
        operationId: "article-operation",
        approvedRevision: 1,
        title: "汽车行业观察",
        topic: "新能源车售后",
        contentType: "news" as const,
      },
    ],
    questions: [
      { id: "q-1", question: "新能源车售后怎么选？", articleIds: ["article-1"] },
    ],
    derivedKeywords: ["汽车音响"],
  });
  const finishInputs: unknown[] = [];
  return {
    current,
    finishInputs,
    port: {
      async context() {
        return context();
      },
      async channelPreferences() {
        return undefined;
      },
      async latest() {
        return current;
      },
      async get() {
        return current;
      },
      async prepare() {
        return { plan: current, claimToken: `claim-${sequence}` };
      },
      async finishDiscovery(input: { providerState: string; candidates: unknown[] }) {
        finishInputs.push(input);
        (current as unknown as Record<string, unknown>).status =
          input.providerState === "available" && input.candidates.length > 0 ? "draft" : "unavailable";
        return current;
      },
      async edit() {
        return current;
      },
      async confirm() {
        return current;
      },
    } as never,
  };
}

// ---------------------------------------------------------------------------
// 验收用例
// ---------------------------------------------------------------------------

describe("ticket 07: client gateway transport + permit billing against the real backend", () => {
  let tb: TestBackend;
  let accessToken: string;
  let accountId: string;
  let upstream: ReturnType<typeof upstreamMock>;
  let routing: ReturnType<typeof gatewayFetch>;

  beforeEach(async () => {
    upstream = upstreamMock();
    // 测试后端按生产口径配置 embedding 兜底 endpoint id：缺失时网关 503
    // （embedding_endpoint_not_configured）属配置类显式失败，不再静默降级。
    tb = await startTestBackend({
      fetch: upstream.respond as unknown as typeof fetch,
      config: { arkEmbeddingEndpointId: 'ep-test-embedding' },
    });
    const provisioned = await provisionLoggedInAccount(tb.app);
    accessToken = provisioned.accessToken;
    accountId = provisioned.accountId;
    routing = gatewayFetch(tb.app, upstream.respond);
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  const capabilities = () =>
    createGeoProviderCapabilities(
      {
        gatewayBaseUrl: GATEWAY_BASE,
        accountAccessToken: accessToken,
        arkConfigurationFingerprint: "integration-fingerprint",
      },
      { fetch: routing.fetchImpl },
    );

  const channel = () =>
    createGatewayBillingPermitChannel(
      { baseUrl: GATEWAY_BASE, accessToken },
      { fetch: routing.fetchImpl, transportRetries: 0 },
    );

  async function availablePoints(): Promise<number> {
    const snapshot = await channel().balance();
    return snapshot.available;
  }

  function ledgerEntries(): Array<{ delta: number; kind: string; note: string }> {
    return tb.db.all(
      "SELECT delta, kind, note FROM ledger_entries WHERE account_id = ? ORDER BY rowid",
      [accountId],
    );
  }

  async function adminTopUp(points: number): Promise<void> {
    const adminLogin = await postJson(tb.app, "/admin/login", { password: "ops-password-123" });
    const adminToken = adminLogin.body.adminToken as string;
    const adjust = await postJson(
      tb.app,
      "/admin/ledger/adjust",
      { accountId, delta: points, note: "测试充值" },
      adminToken,
    );
    if (adjust.status !== 200) throw new Error(`topup failed: ${JSON.stringify(adjust.body)}`);
  }

  it("routes question-pool generation through the gateway and settles 15 points with ledger entries", async () => {
    const persistence = questionPoolPersistence();
    const caps = capabilities();
    const service = new QuestionPoolService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      persistence.port,
      caps.keywordSearch,
      caps.generation,
      caps.embedding,
      channel(),
    );

    const pool = await service.generate({
      workspaceId: "brand-int",
      sessionId: "session-int",
      productLine: "汽车音响",
      targetRegion: "成都",
      idempotencyKey: "request-int",
    });

    expect(pool.status).toBe("awaiting-selection");
    // 验收 1：余额出现对应扣点（赠 500 → 扣 15）。
    expect(await availablePoints()).toBe(500 - 15);
    const consume = ledgerEntries().filter((entry) => entry.kind === "consume");
    expect(consume).toEqual([
      { delta: -15, kind: "consume", note: "question_pool unit 0" },
    ]);
    // 计费流量确实经网关 /gw/*（含 embedding 的 model 兜底无关路径）。
    const gwPaths = routing.seen.filter((entry) => entry.startsWith("gw "));
    expect(gwPaths.some((entry) => entry.includes("/gw/ark/chat/completions"))).toBe(true);
    expect(gwPaths.some((entry) => entry.includes("/gw/ark/embeddings/multimodal"))).toBe(true);
  });

  it("settles only successful units when 3 of 10 articles fail upstream", async () => {
    await tb.cleanup();
    upstream = upstreamMock({ failThemes: ["主题 a3", "主题 a5", "主题 a8"] });
    tb = await startTestBackend({
      fetch: upstream.respond as unknown as typeof fetch,
      config: { arkEmbeddingEndpointId: 'ep-test-embedding' },
    });
    const provisioned = await provisionLoggedInAccount(tb.app);
    accessToken = provisioned.accessToken;
    accountId = provisioned.accountId;
    routing = gatewayFetch(tb.app, upstream.respond);

    const persistence = articlePersistence(10);

    const caps = capabilities();
    const service = new ArticleGenerationService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      persistence.port,
      caps.generation,
      caps.reflection,
      channel(),
    );

    const operation = await service.start({
      workspaceId: "brand-int",
      sessionId: "session-int",
      source: {
        kind: "direct",
        count: 10,
        themes: Array.from({ length: 10 }, (_, index) => `主题 a${index + 1}`),
        contentType: "guide",
        constraints: "",
      },
    });

    const succeeded = operation.articles.filter((article) => article.status === "draft_ready");
    const failed = operation.articles.filter((article) => article.status === "generation_failed");
    expect(succeeded).toHaveLength(7);
    expect(failed.map((article) => article.id)).toEqual(["a3", "a5", "a8"]);

    // 验收 2：仅成功单位结转（7 × 20 = 140），失败 60 点回补。
    expect(await availablePoints()).toBe(500 - 140);
    const consume = ledgerEntries().filter((entry) => entry.kind === "consume");
    expect(consume).toHaveLength(7);
    expect(consume.every((entry) => entry.delta === -20)).toBe(true);
  });

  it("replays a cached recovery re-run without a second deduction", async () => {
    const persistence = questionPoolPersistence();
    const caps = capabilities();
    const service = new QuestionPoolService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      persistence.port,
      caps.keywordSearch,
      caps.generation,
      caps.embedding,
      channel(),
    );
    await service.generate({
      workspaceId: "brand-int",
      sessionId: "session-int",
      productLine: "汽车音响",
      targetRegion: "成都",
      idempotencyKey: "request-int",
    });
    expect(await availablePoints()).toBe(500 - 15);

    // 验收 3：恢复重跑（全阶段缓存命中）重放同一 permitId，不二次扣。
    persistence.markAllCached();
    const gwCallsBefore = routing.seen.filter((entry) => entry.includes("/billing/permits")).length;
    await service.generate({
      workspaceId: "brand-int",
      sessionId: "session-int",
      productLine: "汽车音响",
      targetRegion: "成都",
      idempotencyKey: "request-int",
    });
    expect(await availablePoints()).toBe(500 - 15);
    const gwCallsAfter = routing.seen.filter((entry) => entry.includes("/billing/permits")).length;
    // 仅幂等重放（1 apply + 1 report），无第二笔预扣/结转。
    expect(gwCallsAfter - gwCallsBefore).toBe(2);
    const consume = ledgerEntries().filter((entry) => entry.kind === "consume");
    expect(consume).toHaveLength(1);
  });

  it("keeps cached baseline units and the channel resource cache free of charge", async () => {
    const persistence = baselinePersistence(3);
    const caps = capabilities();
    const service = new GeoBaselineService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      persistence.port,
      caps.keywordSearch,
      Date.now,
      channel(),
    );
    const first = await service.start({
      workspaceId: "brand-int",
      sessionId: "session-int",
      questionPoolId: "pool-int",
      engineIds: ["doubao"],
      idempotencyKey: "run-int",
    });
    expect(first.metrics.succeeded).toBe(3);
    expect(await availablePoints()).toBe(500 - 15);

    // 验收 4：探测缓存命中（已完成问 claim=cached）不发 permit。
    const billingCallsBefore = routing.seen.filter((entry) =>
      entry.endsWith("/billing/permits"),
    ).length;
    const upstreamCallsBefore = upstream.calls.filter((call) => call.url.endsWith("/responses")).length;
    const second = await service.start({
      workspaceId: "brand-int",
      sessionId: "session-int",
      questionPoolId: "pool-int",
      engineIds: ["doubao"],
      idempotencyKey: "run-int",
    });
    expect(second.metrics.succeeded).toBe(3);
    expect(await availablePoints()).toBe(500 - 15);
    const billingCallsAfter = routing.seen.filter((entry) =>
      entry.endsWith("/billing/permits"),
    ).length;
    expect(billingCallsAfter - billingCallsBefore).toBe(0);
    const upstreamCallsAfter = upstream.calls.filter((call) => call.url.endsWith("/responses")).length;
    expect(upstreamCallsAfter - upstreamCallsBefore).toBe(0);

    // 渠道资源缓存（30 分钟 TTL）：分发计划重跑不再重放 /gw/distribution 上游
    // 请求，且同源重跑重放同一 permitId，余额零变化。
    const caps2 = capabilities();
    const distributionPersistenceHandle = distributionPersistence();
    const distribution = new DistributionPlanningService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      distributionPersistenceHandle.port,
      caps2.distribution,
      caps2.keywordSearch,
      () => new Date("2026-08-15T00:00:00.000Z"),
      channel(),
    );
    const distributionSource = {
      articleOperationId: "article-operation",
      articleIds: ["article-1"],
      industry: "汽车改装",
      targetAudience: "新能源车主",
      questionSources: [],
      preferredResourceIds: [],
      mappingMode: "one-to-one" as const,
      ratio: { media: 2, weMedia: 1 },
      budgetCny: 100,
      publishStartAt: "2026-08-20T01:00:00.000Z",
    };
    await distribution.start({
      workspaceId: "brand-int",
      sessionId: "session-int",
      source: distributionSource,
    });
    expect(await availablePoints()).toBe(500 - 15 - 35);

    const resourceFetchesBefore = upstream.calls.filter((call) =>
      call.url.includes("/media/resource") || call.url.includes("/we-media/resource"),
    ).length;
    expect(resourceFetchesBefore).toBeGreaterThan(0);
    await distribution.start({
      workspaceId: "brand-int",
      sessionId: "session-int",
      source: distributionSource,
    });
    // 缓存命中：零上游资源请求；同源 permit 重放：余额不变。
    const resourceFetchesAfter = upstream.calls.filter((call) =>
      call.url.includes("/media/resource") || call.url.includes("/we-media/resource"),
    ).length;
    expect(resourceFetchesAfter).toBe(resourceFetchesBefore);
    expect(await availablePoints()).toBe(500 - 15 - 35);
  });

  it("auto-pauses monitoring when balance is below one patrol unit and resumes after top-up", async () => {
    const caps = capabilities();
    const probeSnapshot: GeoBaselineProviderSnapshot = {
      engineId: "doubao",
      provider: "volcengine",
      capabilitySlot: "keyword-search",
      model: "doubao-seed-2-0-lite-260428",
      endpointFamily: "ark-responses",
      searchMode: "doubao-app-ai-search",
      configurationFingerprint: "integration-fingerprint",
      policyVersion: GEO_BASELINE_POLICY_VERSION,
    };
    const probeInput = {
      engineId: "doubao" as const,
      questionId: "q-1",
      question: "小鲸同学值得选吗？",
      sourceProviderSnapshot: probeSnapshot,
      brandNames: ["鲸跃"],
      publishedArticles: [{ articleId: "article-1", url: "https://brand.test/article-1" }],
    };
    const service = () =>
      new PostPublishBaselineProbeService(caps.keywordSearch, channel(), () => `round-${randomUUID()}`);

    // 余额耗到 4 点（不足单问巡检价 5 点）：运营调点模拟欠费。
    await adminTopUp(-496);
    expect(await availablePoints()).toBe(4);

    // 验收 5：余额低于单问巡检价 → 类型化终止，零 permit、零探测。
    const permitsBefore = routing.seen.filter((entry) => entry.endsWith("/billing/permits")).length;
    const probesBefore = upstream.calls.filter((call) => call.url.endsWith("/responses")).length;
    await expect(service().probe(probeInput)).rejects.toMatchObject({
      name: "PostPublishInsufficientBalanceError",
    });
    expect(routing.seen.filter((entry) => entry.endsWith("/billing/permits")).length).toBe(
      permitsBefore,
    );
    expect(upstream.calls.filter((call) => call.url.endsWith("/responses")).length).toBe(
      probesBefore,
    );

    // 充值后自动恢复：巡检正常计费 5 点。
    await adminTopUp(100);
    const result = await service().probe(probeInput);
    expect(result.evidence.questionId).toBe("q-1");
    expect(await availablePoints()).toBe(4 + 100 - 5);
  });

  it("keeps browsing, preview and history reads free of any permit call (network-layer assertion)", async () => {
    const caps = capabilities();
    const qpool = new QuestionPoolService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      questionPoolPersistence().port,
      caps.keywordSearch,
      caps.generation,
      caps.embedding,
      channel(),
    );
    const baseline = new GeoBaselineService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      baselinePersistence(1).port,
      caps.keywordSearch,
      Date.now,
      channel(),
    );
    const articles = new ArticleGenerationService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      articlePersistence(1).port,
      caps.generation,
      caps.reflection,
      channel(),
    );

    const billingPaths = ["/billing/permits", "/billing/balance"];
    const billingCallsBefore = routing.seen.filter((entry) =>
      billingPaths.some((path) => entry.includes(path)),
    ).length;

    // 浏览/预览/读取历史：全部零计费、零 Provider 调用。
    await qpool.latest({ workspaceId: "brand-int", sessionId: "session-int" });
    await baseline.latest({ workspaceId: "brand-int", sessionId: "session-int" });
    await baseline.engines();
    await articles.latest({ workspaceId: "brand-int", sessionId: "session-int" });
    await articles.operation({
      workspaceId: "brand-int",
      sessionId: "session-int",
      operationId: "operation-int",
    });

    const billingCallsAfter = routing.seen.filter((entry) =>
      billingPaths.some((path) => entry.includes(path)),
    ).length;
    expect(billingCallsAfter - billingCallsBefore).toBe(0);
    expect(upstream.calls).toHaveLength(0);
  });

  it("keeps the client-side patrol threshold aligned with the server price table", () => {
    // 防漂移对照：监测余额预检阈值 = 服务端价目 monitoring_patrol.perUnit。
    expect(MONITORING_PATROL_UNIT_POINTS).toBe(
      OPERATION_PRICES.monitoring_patrol.perUnit,
    );
    // permit 申请客户端口径不带价目（服务端定价权威）由网关侧用例覆盖；
    // 这里再校验客户端镜像不越权定义未知操作。
    expect(OPERATION_PRICES.question_pool.perUnit).toBe(15);
  });

  it("propagates typed insufficient_balance from a billed question-pool run", async () => {
    await adminTopUp(-496);
    expect(await availablePoints()).toBe(4);
    const caps = capabilities();
    const service = new QuestionPoolService(
      { workspaceId: "brand-int", sessionId: "session-int" },
      questionPoolPersistence().port,
      caps.keywordSearch,
      caps.generation,
      caps.embedding,
      channel(),
    );
    const thrown = await service
      .generate({
        workspaceId: "brand-int",
        sessionId: "session-int",
        productLine: "汽车音响",
        targetRegion: "成都",
        idempotencyKey: "request-int",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(GatewayBillingError);
    expect(thrown).toMatchObject({
      code: "insufficient_balance",
      status: 402,
      details: { required: 15, available: 4 },
    });
    // 未扣点、未发起任何 Provider 调用。
    expect(await availablePoints()).toBe(4);
    expect(upstream.calls).toHaveLength(0);
  });
});
