import { describe, expect, it, vi } from 'vitest';

import {
  applyTopicPlanRevisionOperation,
  createArticleGateRevisionHandler,
  createDistributionPlanGateRevisionHandler,
  createPublishPreparationGateRevisionHandler,
  createQuestionPoolGateRevisionHandler,
  createTopicPlanGateRevisionHandler,
  dispatchGateRevision,
  distributionPlanEditForOperation,
  gateRevisionErrorCode,
  GATE_REVISION_GATE_TYPES,
  GATE_REVISION_TOOL_DESCRIPTION,
  GATE_REVISION_TOOL_NAME,
  knowledgeGateRevisionHandler,
  registerGateRevisionHandler,
  validateGateRevisionOperations,
  type GateRevisionContext,
  type GateRevisionOpResult,
} from './gate-revision';
import type { TopicPlanItem, TopicPlanProjection } from '../../shared/geo/topicPlan';
import type { DistributionPlanProjection } from '../../shared/geo/distributionPlan';

const context: GateRevisionContext = { workspaceId: 'brand-1', sessionId: 'session-1' };

describe('gate revision tool contract', () => {
  it('pins the tool name and the explicit-instruction deletion discipline in the description', () => {
    expect(GATE_REVISION_TOOL_NAME).toBe('revise_gate_content');
    // ADR 0003：工具描述写死「仅基于用户显式指令；不得自行判断删除」。
    expect(GATE_REVISION_TOOL_DESCRIPTION).toContain('仅基于用户显式指令');
    expect(GATE_REVISION_TOOL_DESCRIPTION).toContain('不得自行判断删除');
    expect(GATE_REVISION_TOOL_DESCRIPTION).toContain("user's explicit instruction");
  });

  it('enumerates every existing gate so later gates plug in without contract changes', () => {
    expect(GATE_REVISION_GATE_TYPES).toContain('knowledge');
    expect(GATE_REVISION_GATE_TYPES).toContain('question-pool');
    expect(GATE_REVISION_GATE_TYPES).toContain('topic-plan');
    expect(GATE_REVISION_GATE_TYPES).toContain('article');
    expect(GATE_REVISION_GATE_TYPES).toContain('distribution-plan');
    expect(GATE_REVISION_GATE_TYPES).toContain('publish-preparation');
  });
});

describe('dispatchGateRevision', () => {
  it('routes operations to the registered gate handler and aggregates per-op receipts', async () => {
    registerGateRevisionHandler('knowledge', async (operations, received) => {
      expect(received).toEqual(context);
      const results: GateRevisionOpResult[] = operations.map((operation) => ({
        action: operation.action,
        ...(operation.targetId ? { targetId: operation.targetId } : {}),
        candidateId: `resolved-${operation.targetId ?? operation.subject}`,
        ok: operation.action !== 'delete',
        status: 'awaiting-confirmation',
      }));
      return results;
    });
    const receipt = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', value: '新值', userInstruction: '行业改成汽车后市场装具' },
      { action: 'delete', targetId: 'candidate-2', userInstruction: '删掉核心产品第三条' },
    ], context);
    expect(receipt).toMatchObject({ kind: 'gate-revision', gate: 'knowledge', ok: false });
    expect(receipt.hint).toContain('已裁决的权威事实');
    expect(receipt.results).toHaveLength(2);
    expect(receipt.results[0]).toMatchObject({ action: 'modify', targetId: 'candidate-1', ok: true });
    expect(receipt.results[1]).toMatchObject({ action: 'delete', targetId: 'candidate-2', ok: false });
  });

  it('returns ok when every operation succeeds', async () => {
    registerGateRevisionHandler('knowledge', async (operations) =>
      operations.map((operation) => ({
        action: operation.action,
        ok: true,
        status: 'awaiting-confirmation',
      })),
    );
    const receipt = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', value: '新值', userInstruction: '改一下' },
    ], context);
    expect(receipt.ok).toBe(true);
    expect(receipt.hint).toBeUndefined();
  });

  it('routes every registered gate type to a domain handler (票 38)', async () => {
    // 真实 handler 在模块加载时注册；未注册的回执是 gate_revision_not_available
    // 且 results 为空。测试环境没有 Sidecar 身份，服务构造失败也会按单条
    // 回执结构化——足以证明路由命中了域 handler。
    registerGateRevisionHandler('knowledge', knowledgeGateRevisionHandler);
    for (const gate of GATE_REVISION_GATE_TYPES) {
      const receipt = await dispatchGateRevision(gate, [
        { action: 'modify', targetId: `${gate}-1`, value: { v: 1 }, userInstruction: '改一下' },
      ], context);
      expect(receipt.code, `gate ${gate}`).not.toBe('gate_revision_not_available');
      expect(receipt.results, `gate ${gate}`).toHaveLength(1);
      expect(receipt.results[0].ok, `gate ${gate}`).toBe(false);
    }
  });

  it('rejects knowledge add operations without the pending card materialId', async () => {
    // 真实知识 handler（前面的用例会临时注册测试替身，这里先恢复参考实现）。
    registerGateRevisionHandler('knowledge', knowledgeGateRevisionHandler);
    const receipt = await dispatchGateRevision('knowledge', [
      {
        action: 'add',
        subject: '品牌',
        predicate: 'enterprise-profile.core-products',
        value: ['隐形车衣'],
        userInstruction: '加一条核心产品：隐形车衣',
      },
    ], context);
    expect(receipt.ok).toBe(false);
    expect(receipt.results[0]).toMatchObject({ action: 'add', ok: false, code: 'material_required' });
    expect(receipt.results[0].error).toContain('propose_brand_fact');
  });

  it('rejects unknown gate types without touching any handler', async () => {
    const receipt = await dispatchGateRevision('billing', [], context);
    expect(receipt).toMatchObject({ kind: 'gate-revision', ok: false, code: 'gate_unknown' });
  });

  it('validates the operation list before dispatch', async () => {
    const invalid = await dispatchGateRevision('knowledge', [], context);
    expect(invalid).toMatchObject({ ok: false, code: 'operations_invalid' });

    const noTarget = await dispatchGateRevision('knowledge', [
      { action: 'delete', userInstruction: '删掉' },
    ], context);
    expect(noTarget.error).toContain('(delete) requires targetId');

    const noValue = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', userInstruction: '改一下' },
    ], context);
    expect(noValue.error).toContain('(modify) requires a value');

    const noInstruction = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', value: 'x', userInstruction: '' },
    ], context);
    expect(noInstruction.error).toContain("user's verbatim instruction");
  });
});

describe('validateGateRevisionOperations', () => {
  it('bounds the batch size and requires complete add keys', () => {
    const tooMany = Array.from({ length: 21 }, () => ({
      action: 'delete' as const,
      targetId: 'candidate-1',
      userInstruction: '删',
    }));
    expect(validateGateRevisionOperations(tooMany)).toContain('at most 20');

    expect(
      validateGateRevisionOperations([
        { action: 'add', value: 'x', userInstruction: '加一条' },
      ]),
    ).toContain('requires a subject and predicate');
  });

  it('keeps the fact-key add contract for knowledge and frees value-only adds for other gates', () => {
    expect(
      validateGateRevisionOperations(
        [{ action: 'add', value: '隐形车衣多少钱', userInstruction: '加个搜索词' }],
        'question-pool',
      ),
    ).toBeNull();
    expect(
      validateGateRevisionOperations(
        [{ action: 'add', value: '新选题', userInstruction: '加个选题' }],
        'topic-plan',
      ),
    ).toBeNull();
    expect(
      validateGateRevisionOperations(
        [{ action: 'add', value: '新选题', userInstruction: '加个选题' }],
        'knowledge',
      ),
    ).toContain('requires a subject and predicate');
    expect(
      validateGateRevisionOperations(
        [{ action: 'add', subject: 's', predicate: 'p', userInstruction: '加一条' }],
        'knowledge',
      ),
    ).toContain('requires a value');
  });
});

describe('gateRevisionErrorCode', () => {
  it('maps authority rejections to structured target codes', () => {
    expect(gateRevisionErrorCode(new Error('knowledge candidate is no longer pending'))).toBe('target_not_pending');
    expect(
      gateRevisionErrorCode(new Error('knowledge candidate does not belong to the current brand Session')),
    ).toBe('target_not_in_session');
    expect(gateRevisionErrorCode(new Error('knowledge candidate not found for this Session'))).toBe('target_not_found');
    expect(gateRevisionErrorCode(new Error('boom'))).toBe('revision_rejected');
  });

  it('maps the five gates’ domain persistence codes (票 38)', () => {
    // 非未决。
    expect(gateRevisionErrorCode(new Error('question_pool_confirmed_immutable'))).toBe('target_not_pending');
    expect(gateRevisionErrorCode(new Error('question_pool_not_selectable'))).toBe('target_not_pending');
    expect(gateRevisionErrorCode(new Error('topic_plan_confirmed_immutable'))).toBe('target_not_pending');
    expect(gateRevisionErrorCode(new Error('distribution_plan_confirmed_immutable'))).toBe('target_not_pending');
    expect(gateRevisionErrorCode(new Error('publish_execution_already_immutable'))).toBe('target_not_pending');
    expect(gateRevisionErrorCode(new Error('article is no longer pending (awaiting approval)'))).toBe('target_not_pending');
    // 跨 Session / 品牌。
    expect(gateRevisionErrorCode(new Error('question_pool_identity_mismatch'))).toBe('target_not_in_session');
    expect(gateRevisionErrorCode(new Error('topic_plan_draft_session_mismatch'))).toBe('target_not_in_session');
    expect(gateRevisionErrorCode(new Error('article_draft_session_mismatch'))).toBe('target_not_in_session');
    expect(gateRevisionErrorCode(new Error('publish_execution_session_mismatch'))).toBe('target_not_in_session');
    // 目标缺失与 CAS 冲突。
    expect(gateRevisionErrorCode(new Error('article_generation_article_not_found'))).toBe('target_not_found');
    expect(gateRevisionErrorCode(new Error('question_pool_revision_target_not_found'))).toBe('target_not_found');
    expect(gateRevisionErrorCode(new Error('publish_execution_revision_conflict'))).toBe('revision_conflict');
  });
});

describe('cross-session rejections surface per gate (票 38)', () => {
  // 越权拒绝在工具层的最低要求：各域 handler 把持久层的身份拒绝结构化为
  // target_not_in_session 回执，绝不静默落到别的 Session 的目标上。
  const identityError = () => {
    const error = new Error('domain identity_mismatch');
    return Promise.reject(error);
  };

  it('maps identity rejections for every non-knowledge gate handler', async () => {
    const questionPool = createQuestionPoolGateRevisionHandler(() => ({
      revise: vi.fn(identityError),
    }));
    const topicPlan = createTopicPlanGateRevisionHandler(() => ({
      latest: vi.fn(identityError),
      saveItems: vi.fn(),
    }));
    const article = createArticleGateRevisionHandler(() => ({
      latest: vi.fn(identityError),
      edit: vi.fn(),
    }));
    const distribution = createDistributionPlanGateRevisionHandler(() => ({
      latest: vi.fn(identityError),
      edit: vi.fn(),
    }));
    const publish = createPublishPreparationGateRevisionHandler(() => ({
      latest: vi.fn(identityError),
      revise: vi.fn(),
    }));
    const op = {
      action: 'modify' as const,
      targetId: 'entry-1',
      value: { v: 1 },
      userInstruction: '改一下',
    };
    const results = await Promise.all([
      questionPool([op], context),
      topicPlan([op], context),
      article([op], context),
      distribution([op], context),
      publish([op], context),
    ]);
    for (const [gate, gateResults] of [
      ['question-pool', results[0]],
      ['topic-plan', results[1]],
      ['article', results[2]],
      ['distribution-plan', results[3]],
      ['publish-preparation', results[4]],
    ] as const) {
      expect(gateResults, gate).toHaveLength(1);
      expect(gateResults[0], gate).toMatchObject({
        ok: false,
        code: 'target_not_in_session',
      });
    }
  });
});

const topicPlanItem = (id: string, overrides: Partial<TopicPlanItem> = {}): TopicPlanItem => ({
  id,
  topicId: 'topic-1',
  sourceQuestionIds: ['q-1'],
  contentType: 'guide',
  typeSelectionReason: '指南类型适合该搜索意图。',
  title: `${id} 标题`,
  titleCandidates: [`${id} 标题`],
  titleRationale: {
    questionCoverage: '覆盖来源问题',
    searchIntent: '匹配搜索意图',
    differentiation: '差异说明',
    brandFit: '品牌匹配',
    chinaMarketExpression: '中文表达',
  },
  plannedFacts: [
    {
      factKey: 'brand.industry',
      predicate: 'enterprise-profile.industry',
      normalizedValueJson: '"汽车改装"',
    },
  ],
  deduplication: {
    method: 'embedding',
    comparedItemIds: [],
    maxSimilarity: null,
    threshold: 0.87,
  },
  userEdited: false,
  approvalStatus: 'draft',
  origin: 'model',
  ...overrides,
});

const topicPlan = (items: TopicPlanItem[], status: TopicPlanProjection['status'] = 'awaiting-confirmation'): TopicPlanProjection => ({
  id: 'plan-1',
  operationId: 'operation-1',
  workspaceId: context.workspaceId,
  questionPoolId: 'pool-1',
  questionPoolRevision: 3,
  knowledgeVersion: 7,
  productLine: '汽车音响',
  targetRegion: '苏州',
  policyVersion: 'js-ai-dev-topic-v1' as TopicPlanProjection['policyVersion'],
  status,
  revision: 2,
  topics: [
    {
      id: 'topic-1',
      name: '汽车音响改装',
      summary: '主题摘要',
      questionIds: ['q-1'],
      searchIntent: 'commercial-investigation',
      namingReason: '聚类命名',
    },
  ],
  items,
  selectedItemIds: [],
  modelAudit: {
    clustering: 'embedding+generation-llm',
    naming: 'generation-llm',
    typeRecommendation: 'generation-llm',
    titleGeneration: 'generation-llm',
    titleDeduplication: 'embedding',
  },
  providerSnapshot: {
    generation: { provider: 'volcengine', capabilitySlot: 'generation', model: 'doubao' },
    titlePlanning: { provider: 'volcengine', capabilitySlot: 'generation', model: 'doubao' },
    embedding: { provider: 'volcengine', capabilitySlot: 'embedding', modelFamily: 'doubao-embedding-vision', dimensions: 1024 },
    policyVersion: 'js-ai-dev-topic-v1' as TopicPlanProjection['policyVersion'],
  },
  modelAttempts: [],
  reused: false,
  createdAt: '2026-08-15T00:00:00Z',
  updatedAt: '2026-08-15T00:00:00Z',
});

describe('question-pool gate handler (票 38)', () => {
  it('maps modify/add/delete onto service revise with target kind and verbatim instruction', async () => {
    const revise = vi
      .fn()
      .mockResolvedValue({ pool: { status: 'awaiting-selection' } });
    const handler = createQuestionPoolGateRevisionHandler(() => ({ revise }));
    const results = await handler(
      [
        { action: 'modify', targetId: 'q-1', value: '新问题文本', userInstruction: '把第一个问题改短' },
        { action: 'add', subject: 'keyword', value: '隐形车衣多少钱', userInstruction: '加个搜索词' },
        { action: 'delete', targetId: 'kw-2', subject: 'keyword', userInstruction: '删掉第二个搜索词' },
      ],
      context,
    );
    expect(revise).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      action: 'modify',
      targetKind: 'question',
      targetId: 'q-1',
      value: '新问题文本',
      reason: '把第一个问题改短',
      actorId: 'desktop-user',
    }));
    expect(revise).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'add',
      targetKind: 'keyword',
      value: '隐形车衣多少钱',
    }));
    expect(revise).toHaveBeenNthCalledWith(3, expect.objectContaining({
      action: 'delete',
      targetKind: 'keyword',
      targetId: 'kw-2',
    }));
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]).toMatchObject({ action: 'modify', targetId: 'q-1', status: 'awaiting-selection' });
  });

  it('structures non-pending, cross-session and missing-target rejections per op', async () => {
    const revise = vi
      .fn()
      .mockRejectedValueOnce(new Error('question_pool_confirmed_immutable'))
      .mockRejectedValueOnce(new Error('question_pool_identity_mismatch'))
      .mockRejectedValueOnce(new Error('question_pool_revision_target_not_found'));
    const handler = createQuestionPoolGateRevisionHandler(() => ({ revise }));
    const results = await handler(
      [
        { action: 'modify', targetId: 'q-1', value: 'x', userInstruction: '改' },
        { action: 'delete', targetId: 'q-2', userInstruction: '删' },
        { action: 'delete', targetId: 'q-9', userInstruction: '删一个不存在的' },
      ],
      context,
    );
    expect(results.map((result) => result.code)).toEqual([
      'target_not_pending',
      'target_not_in_session',
      'target_not_found',
    ]);
    expect(results.every((result) => !result.ok)).toBe(true);
  });
});

describe('topic-plan gate revision mapping (票 38)', () => {
  const plan = () => topicPlan([topicPlanItem('item-1'), topicPlanItem('item-2')]);

  it('modify merges whitelisted fields and delete removes the item', () => {
    const modified = applyTopicPlanRevisionOperation(plan(), {
      action: 'modify',
      targetId: 'item-1',
      value: { title: '新标题' },
      userInstruction: '改标题',
    });
    expect(modified.find((item) => item.id === 'item-1')?.title).toBe('新标题');
    expect(modified).toHaveLength(2);

    const deleted = applyTopicPlanRevisionOperation(plan(), {
      action: 'delete',
      targetId: 'item-2',
      userInstruction: '删掉第二个选题',
    });
    expect(deleted.map((item) => item.id)).toEqual(['item-1']);
  });

  it('add builds a user-origin item and unknown targets are rejected', () => {
    const added = applyTopicPlanRevisionOperation(plan(), {
      action: 'add',
      value: {
        topicId: 'topic-1',
        sourceQuestionIds: ['q-1'],
        contentType: 'showcase',
        typeSelectionReason: '用户指定',
        title: '用户补充的选题',
        plannedFacts: [
          { factKey: 'brand.industry', predicate: 'enterprise-profile.industry', normalizedValueJson: '"汽车改装"' },
        ],
      },
      userInstruction: '加一个展示型选题',
    });
    const newItem = added.at(-1);
    expect(newItem).toMatchObject({
      topicId: 'topic-1',
      contentType: 'showcase',
      title: '用户补充的选题',
      origin: 'user',
      userEdited: true,
      approvalStatus: 'draft',
    });
    expect(newItem?.id).toMatch(/^item-user-/);

    expect(() =>
      applyTopicPlanRevisionOperation(plan(), {
        action: 'delete',
        targetId: 'item-404',
        userInstruction: '删',
      }),
    ).toThrow('topic_plan_revision_target_not_found');

    expect(() =>
      applyTopicPlanRevisionOperation(topicPlan([topicPlanItem('only-1')]), {
        action: 'delete',
        targetId: 'only-1',
        userInstruction: '删掉唯一选题',
      }),
    ).toThrow('topic_plan_items_invalid');
  });

  it('routes ops through saveItems with the verbatim instruction and chains revisions', async () => {
    let current = plan();
    const saveItems = vi.fn().mockImplementation(async ({ items }: { items: TopicPlanItem[] }) => {
      current = { ...current, items, revision: current.revision + 1 };
      return { plan: current, mutationId: 'mutation-1', preservedItemIds: [] };
    });
    const latest = vi.fn().mockImplementation(async () => current);
    const handler = createTopicPlanGateRevisionHandler(() => ({ latest, saveItems }));
    const results = await handler(
      [
        { action: 'modify', targetId: 'item-1', value: { title: '新标题' }, userInstruction: '改标题' },
        { action: 'delete', targetId: 'item-2', userInstruction: '删掉第二个' },
      ],
      context,
    );
    expect(saveItems).toHaveBeenCalledTimes(2);
    expect(saveItems).toHaveBeenNthCalledWith(1, expect.objectContaining({
      planId: 'plan-1',
      expectedRevision: 2,
      reason: '改标题',
    }));
    // 第二条操作基于第一条提交后的新 revision。
    expect(saveItems).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRevision: 3,
      reason: '删掉第二个',
    }));
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('rejects confirmed plans and missing plans as non-pending / not-found', async () => {
    const latest = vi.fn().mockResolvedValue(topicPlan([topicPlanItem('item-1')], 'confirmed'));
    const saveItems = vi.fn();
    const handler = createTopicPlanGateRevisionHandler(() => ({ latest, saveItems }));
    const results = await handler(
      [{ action: 'delete', targetId: 'item-1', userInstruction: '删' }],
      context,
    );
    expect(results[0]).toMatchObject({ ok: false, code: 'target_not_pending' });
    expect(saveItems).not.toHaveBeenCalled();

    const empty = createTopicPlanGateRevisionHandler(() => ({
      latest: vi.fn().mockResolvedValue(null),
      saveItems,
    }));
    const missing = await empty(
      [{ action: 'delete', targetId: 'item-1', userInstruction: '删' }],
      context,
    );
    expect(missing[0]).toMatchObject({ ok: false, code: 'target_not_found' });
  });
});

describe('article gate handler (票 38)', () => {
  const draftArticle = {
    id: 'article-1',
    operationId: 'operation-1',
    revision: 4,
    status: 'draft_ready',
  };

  it('edits pending articles with the full new body and verbatim instruction', async () => {
    const latest = vi.fn().mockResolvedValue({
      id: 'operation-1',
      articles: [draftArticle],
    });
    const edit = vi.fn().mockResolvedValue({ ...draftArticle, revision: 5 });
    const handler = createArticleGateRevisionHandler(() => ({ latest, edit }));
    const results = await handler(
      [
        {
          action: 'modify',
          targetId: 'article-1',
          value: { body: '# 新标题\n\n正文更温和。' },
          userInstruction: '语气改温和一点',
        },
      ],
      context,
    );
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'operation-1',
      articleId: 'article-1',
      expectedRevision: 4,
      title: '新标题',
      body: '# 新标题\n\n正文更温和。',
      reason: '语气改温和一点',
    }));
    expect(results[0]).toMatchObject({ ok: true, status: 'draft_ready' });
  });

  it('supports modify only and rejects non-pending or missing articles', async () => {
    const latest = vi.fn().mockResolvedValue({
      id: 'operation-1',
      articles: [
        { ...draftArticle, id: 'article-approved', status: 'approved' },
        draftArticle,
      ],
    });
    const edit = vi.fn();
    const handler = createArticleGateRevisionHandler(() => ({ latest, edit }));
    const results = await handler(
      [
        { action: 'delete', targetId: 'article-1', userInstruction: '删掉草稿' },
        { action: 'modify', targetId: 'article-approved', value: { body: '# t\nb' }, userInstruction: '改已批准文章' },
        { action: 'modify', targetId: 'article-404', value: { body: '# t\nb' }, userInstruction: '改不存在的' },
      ],
      context,
    );
    expect(results.map((result) => result.code)).toEqual([
      'action_not_supported',
      'target_not_pending',
      'target_not_found',
    ]);
    expect(edit).not.toHaveBeenCalled();
  });
});

const distributionPlan = (
  overrides: Partial<DistributionPlanProjection> = {},
): DistributionPlanProjection =>
  ({
    id: 'plan-1',
    workspaceId: context.workspaceId,
    status: 'draft',
    revision: 3,
    budgetCny: 500,
    publishStartAt: '2026-08-20T10:00:00Z',
    candidates: [
      { resourceId: 11, kind: 'media', name: '渠道甲', estimatedPriceCny: 100, publishedRate: 80, fitReasons: [], risks: [], uncertainties: [] },
      { resourceId: 22, kind: 'we-media', name: '渠道乙', estimatedPriceCny: 60, publishedRate: 70, fitReasons: [], risks: [], uncertainties: [] },
    ],
    selectedResourceIds: [11],
    assignments: [
      { articleId: 'a-1', resourceId: 11, reason: 'source-evidence', scheduledAt: '2026-08-20T10:00:00Z' },
      { articleId: 'a-2', resourceId: null, reason: 'unassigned', scheduledAt: '2026-08-20T10:00:00Z' },
    ],
    blockingIssues: [],
    ...overrides,
  }) as unknown as DistributionPlanProjection;

describe('distribution-plan gate revision mapping (票 38)', () => {
  it('channel add selects a known candidate and delete unassigns its articles', () => {
    const added = distributionPlanEditForOperation(distributionPlan(), {
      action: 'add',
      subject: 'channel',
      targetId: '22',
      userInstruction: '加上渠道乙',
    });
    expect(added.selectedResourceIds).toEqual([11, 22]);

    const removed = distributionPlanEditForOperation(distributionPlan(), {
      action: 'delete',
      subject: 'channel',
      targetId: '11',
      userInstruction: '不要渠道甲',
    });
    expect(removed.selectedResourceIds).toEqual([]);
    expect(removed.assignments[0]).toMatchObject({ articleId: 'a-1', resourceId: null, reason: 'unassigned' });

    expect(() =>
      distributionPlanEditForOperation(distributionPlan(), {
        action: 'add',
        subject: 'channel',
        targetId: '404',
        userInstruction: '加未知渠道',
      }),
    ).toThrow('distribution_plan_revision_target_not_found');
  });

  it('assignment modify re-assigns within selected channels and plan modify changes budget', () => {
    const assigned = distributionPlanEditForOperation(distributionPlan(), {
      action: 'modify',
      subject: 'assignment',
      targetId: 'a-2',
      value: { resourceId: 11, scheduledAt: '2026-08-21T09:30:00Z' },
      userInstruction: '第二篇改到渠道甲晚一点发',
    });
    expect(assigned.assignments[1]).toMatchObject({
      articleId: 'a-2',
      resourceId: 11,
      scheduledAt: '2026-08-21T09:30:00Z',
    });

    const budgeted = distributionPlanEditForOperation(distributionPlan(), {
      action: 'modify',
      value: { budgetCny: 800 },
      userInstruction: '预算改成 800',
    });
    expect(budgeted.budgetCny).toBe(800);

    // 聊天价格脱敏：转录只携带点数，budgetPoints 优先并按 pointsToCny
    // 换算回内部 CNY（12800 点 → ¥800，预算上限语义）。
    const budgetedInPoints = distributionPlanEditForOperation(distributionPlan(), {
      action: 'modify',
      value: { budgetPoints: 12800 },
      userInstruction: '预算改成 12800 点',
    });
    expect(budgetedInPoints.budgetCny).toBe(800);

    expect(() =>
      distributionPlanEditForOperation(distributionPlan(), {
        action: 'modify',
        value: { budgetPoints: 'abc' },
        userInstruction: '乱改预算',
      }),
    ).toThrow('distribution_plan_budget_invalid');

    expect(() =>
      distributionPlanEditForOperation(distributionPlan(), {
        action: 'modify',
        subject: 'assignment',
        targetId: 'a-2',
        value: { resourceId: 22 },
        userInstruction: '改到未选择渠道',
      }),
    ).toThrow('distribution_plan_channel_not_selected');
  });

  it('rejects confirmed and discovering plans before touching the edit seam', async () => {
    const latest = vi
      .fn()
      .mockResolvedValueOnce(distributionPlan({ status: 'confirmed' }))
      .mockResolvedValueOnce(distributionPlan({ status: 'discovering' }))
      .mockResolvedValueOnce(null);
    const edit = vi.fn();
    const handler = createDistributionPlanGateRevisionHandler(() => ({ latest, edit }));
    const results = await handler(
      [
        { action: 'modify', value: { budgetCny: 1 }, userInstruction: '改' },
        { action: 'modify', value: { budgetCny: 1 }, userInstruction: '改' },
        { action: 'modify', value: { budgetCny: 1 }, userInstruction: '改' },
      ],
      context,
    );
    expect(results.map((result) => result.code)).toEqual([
      'target_not_pending',
      'target_not_pending',
      'target_not_found',
    ]);
    expect(edit).not.toHaveBeenCalled();
  });
});

describe('publish-preparation gate handler (票 38)', () => {
  const execution = {
    id: 'exec-1',
    revision: 2,
    status: 'awaiting-confirmation',
    budgetCny: 500,
    publishStartAt: '2026-08-20T10:00:00Z',
  };

  it('modifies execution budget and per-item schedules through the port', async () => {
    const latest = vi.fn().mockResolvedValue(execution);
    const revise = vi
      .fn()
      .mockImplementationOnce(async () => ({ ...execution, revision: 3 }))
      .mockImplementationOnce(async () => ({ ...execution, revision: 4 }));
    const handler = createPublishPreparationGateRevisionHandler(() => ({ latest, revise }));
    const results = await handler(
      [
        { action: 'modify', value: { budgetCny: 650 }, userInstruction: '预算提高到 650' },
        { action: 'modify', subject: 'item', targetId: 'publish-item-1', value: { scheduledAt: '2026-08-21T08:00:00Z' }, userInstruction: '第一篇推迟一天' },
      ],
      context,
    );
    expect(revise).toHaveBeenNthCalledWith(1, expect.objectContaining({
      executionId: 'exec-1',
      expectedRevision: 2,
      budgetCny: 650,
      reason: '预算提高到 650',
      actorId: 'desktop-user',
    }));
    expect(revise).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedRevision: 3,
      itemUpdates: [{ itemId: 'publish-item-1', scheduledAt: '2026-08-21T08:00:00Z' }],
    }));
    expect(results.every((result) => result.ok)).toBe(true);
  });

  // 聊天价格脱敏：执行级预算补丁只携带点数，按 pointsToCny 换算后
  // 提交 Rust 权威口（10400 点 → ¥650）。
  it('accepts execution budget patches in points', async () => {
    const latest = vi.fn().mockResolvedValue(execution);
    const revise = vi
      .fn()
      .mockImplementation(async () => ({ ...execution, revision: 3 }));
    const handler = createPublishPreparationGateRevisionHandler(() => ({ latest, revise }));
    const results = await handler(
      [
        { action: 'modify', value: { budgetPoints: 10400 }, userInstruction: '预算改成 10400 点' },
      ],
      context,
    );
    expect(revise).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-1',
      budgetCny: 650,
    }));
    expect(results[0]?.ok).toBe(true);
  });

  it('supports modify only and rejects immutable or missing executions', async () => {
    const latest = vi
      .fn()
      .mockResolvedValueOnce({ ...execution, status: 'confirmed' })
      .mockResolvedValueOnce(null);
    const revise = vi.fn();
    const handler = createPublishPreparationGateRevisionHandler(() => ({ latest, revise }));
    const results = await handler(
      [
        { action: 'delete', targetId: 'publish-item-1', userInstruction: '删掉一项' },
        { action: 'modify', value: { budgetCny: 1 }, userInstruction: '改已确认的' },
        { action: 'modify', value: { budgetCny: 1 }, userInstruction: '改不存在的' },
      ],
      context,
    );
    expect(results.map((result) => result.code)).toEqual([
      'action_not_supported',
      'target_not_pending',
      'target_not_found',
    ]);
    expect(revise).not.toHaveBeenCalled();
  });

  it('rejects item revisions without a scheduledAt', async () => {
    const latest = vi.fn().mockResolvedValue(execution);
    const revise = vi.fn();
    const handler = createPublishPreparationGateRevisionHandler(() => ({ latest, revise }));
    const results = await handler(
      [
        {
          action: 'modify',
          subject: 'item',
          targetId: 'publish-item-1',
          value: {},
          userInstruction: '改排期但没给时间',
        },
      ],
      context,
    );
    expect(results[0]).toMatchObject({ ok: false, code: 'revision_rejected' });
    expect(results[0].error).toContain('scheduledAt');
    expect(revise).not.toHaveBeenCalled();
  });
});
