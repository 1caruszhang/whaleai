import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArticleProjection } from '../../shared/geo/articleGeneration';
import type { DistributionPlanProjection } from '../../shared/geo/distributionPlan';
import type { TopicPlanConfirmation } from '../../shared/geo/topicPlan';

// 24 号票回归：文章批准与分发确认两个确认门此前只落库不唤醒 agent，
// 用户裁决后必须手动再发一条消息。本测试在路由处理器接缝上断言：决策
// 提交成功后注入正确信封的隐藏决策回执（经 enqueueUserMessage 作为新
// 用户回合唤醒）、响应携带 notification 状态、投递失败不回滚决策也不
// 把响应变成失败——与知识/问题池/选题门既有行为同构
// （knowledge_authority.md 提醒契约、system_reminder_protocol.md）。
// 临时 HOME 与临时工作区隔离；GEO 服务与用户消息入队全部 mock，默认
// 测试不依赖真实网络、真实密钥或真实用户目录。

const gateMocks = vi.hoisted(() => ({
  enqueueUserMessage: vi.fn(),
  approveArticle: vi.fn(),
  confirmDistribution: vi.fn(),
  confirmTopicPlan: vi.fn(),
  recordGeoOperationMilestone: vi.fn(),
  quoteGeoNextStepForGateKind: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  enqueueUserMessage: gateMocks.enqueueUserMessage,
  getSessionId: () => 'session-1',
}));

vi.mock('../routes/xiaojing-shared', () => ({
  getRuntimeSessionIdForRequest: () => 'session-1',
  // 测试请求不带账号 token 头，与真实现对缺头请求的返回一致（undefined）。
  requestAccountAccessToken: () => undefined,
  getXiaojingTopicPlanService: () => ({ confirm: gateMocks.confirmTopicPlan }),
  getXiaojingArticleService: () => ({ approve: gateMocks.approveArticle }),
  getXiaojingDistributionPlanService: () => ({ confirm: gateMocks.confirmDistribution }),
}));

vi.mock('../geo/operation-progress', () => ({
  recordGeoOperationMilestone: gateMocks.recordGeoOperationMilestone,
  quoteGeoNextStepForGateKind: gateMocks.quoteGeoNextStepForGateKind,
}));

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let handleXiaojingContentPipelineRoute: typeof import('../routes/xiaojing-content-pipeline')['handleXiaojingContentPipelineRoute'];

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-receipt-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-receipt-ws-'));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
  vi.resetModules();
  ({ handleXiaojingContentPipelineRoute } = await import('../routes/xiaojing-content-pipeline'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  gateMocks.enqueueUserMessage.mockResolvedValue({ accepted: true });
  // 默认无可引述的 next-step（无活跃操作）：信封保持收据形态。
  gateMocks.quoteGeoNextStepForGateKind.mockResolvedValue(null);
});

const approvedArticle = {
  id: 'article-1',
  operationId: 'article-op-1',
  knowledgeVersion: 3,
  status: 'approved',
  revision: 7,
  approvedRevision: 7,
} as ArticleProjection;

const confirmedPlan = {
  id: 'plan-1',
  operationId: 'geo-op-1',
  articleOperationId: 'article-op-1',
  status: 'confirmed',
  revision: 4,
  assignments: [{ articleId: 'a-1' }, { articleId: 'a-2' }],
} as DistributionPlanProjection;

function post(pathname: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function callRoute(pathname: string, body: Record<string, unknown>) {
  const response = await handleXiaojingContentPipelineRoute(
    pathname,
    post(pathname, body),
    { workspacePath: workspace },
  );
  expect(response).not.toBeNull();
  return {
    status: response!.status,
    body: await response!.json() as Record<string, unknown>,
  };
}

function identityPayload(extra: Record<string, unknown>): Record<string, unknown> {
  return { workspaceId: basename(workspace), sessionId: 'session-1', ...extra };
}

function expectGateReceipt(
  envelopeKind: string,
  instructionFragment: string,
  expectedFields: string[],
) {
  expect(gateMocks.enqueueUserMessage).toHaveBeenCalledTimes(1);
  const [text, images] = gateMocks.enqueueUserMessage.mock.calls[0] as [string, unknown];
  expect(images).toBeUndefined();
  expect(text).toContain('<system-reminder>');
  expect(text).toContain(`<${envelopeKind}>`);
  expect(text).toContain('<instruction>');
  expect(text).toContain(instructionFragment);
  for (const field of expectedFields) expect(text).toContain(field);
}

describe('article approval gate injects a decision receipt and continues', () => {
  it('批准成功后注入 XIAOJING_ARTICLE_APPROVAL_DECISION 回执，响应携带 notification 状态', async () => {
    gateMocks.approveArticle.mockResolvedValueOnce(approvedArticle);
    const { status, body } = await callRoute('/api/xiaojing/articles/approve', identityPayload({
      operationId: 'article-op-1',
      articleId: 'article-1',
      expectedRevision: 6,
    }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.article).toMatchObject({ id: 'article-1', status: 'approved' });
    expect(body.notificationQueued).toBe(true);
    expect(body.notificationError).toBeUndefined();
    expectGateReceipt('XIAOJING_ARTICLE_APPROVAL_DECISION', 'do not re-ask about this article', [
      '<operation-id>article-op-1</operation-id>',
      '<article-id>article-1</article-id>',
      '<status>approved</status>',
      '<revision>7</revision>',
      '<approved-revision>7</approved-revision>',
      '<knowledge-version>3</knowledge-version>',
    ]);
    expect(gateMocks.recordGeoOperationMilestone).toHaveBeenCalledWith(
      { workspaceId: basename(workspace), sessionId: 'session-1' },
      'articles-approved',
    );
  });

  it('回执只带结构化标识，不复制文章正文', async () => {
    gateMocks.approveArticle.mockResolvedValueOnce({
      ...approvedArticle,
      currentVersion: {
        revision: 7,
        title: '# 机密正文标题',
        bodyPath: 'articles/body.md',
        bodySha256: 'deadbeef',
        origin: 'generated',
        basedOnRevision: null,
        review: null,
        createdAt: '2026-08-17T00:00:00Z',
        approvedAt: null,
      },
    } as ArticleProjection);
    await callRoute('/api/xiaojing/articles/approve', identityPayload({
      operationId: 'article-op-1',
      articleId: 'article-1',
      expectedRevision: 6,
    }));
    const [text] = gateMocks.enqueueUserMessage.mock.calls[0] as [string];
    expect(text).not.toContain('机密正文标题');
    expect(text).not.toContain('deadbeef');
  });

  it('入队拒绝或抛错不回滚决策：响应仍成功并显式返回 notification 失败', async () => {
    gateMocks.approveArticle.mockResolvedValue(approvedArticle);
    gateMocks.enqueueUserMessage.mockResolvedValueOnce({ accepted: false, error: 'Agent is already responding.' });
    const rejected = await callRoute('/api/xiaojing/articles/approve', identityPayload({
      operationId: 'article-op-1',
      articleId: 'article-1',
      expectedRevision: 6,
    }));
    expect(rejected.status).toBe(200);
    expect(rejected.body.success).toBe(true);
    expect(rejected.body.article).toMatchObject({ id: 'article-1' });
    expect(rejected.body.notificationQueued).toBe(false);
    expect(rejected.body.notificationError).toBe('Agent is already responding.');

    gateMocks.enqueueUserMessage.mockRejectedValueOnce(new Error('transient enqueue crash'));
    const crashed = await callRoute('/api/xiaojing/articles/approve', identityPayload({
      operationId: 'article-op-1',
      articleId: 'article-1',
      expectedRevision: 6,
    }));
    expect(crashed.status).toBe(200);
    expect(crashed.body.success).toBe(true);
    expect(crashed.body.notificationQueued).toBe(false);
    expect(String(crashed.body.notificationError)).toContain('transient enqueue crash');
  });

  it('决策提交失败（revision 冲突）不投递回执，返回 409', async () => {
    gateMocks.approveArticle.mockRejectedValueOnce(new Error('article_generation_revision_conflict'));
    const { status, body } = await callRoute('/api/xiaojing/articles/approve', identityPayload({
      operationId: 'article-op-1',
      articleId: 'article-1',
      expectedRevision: 0,
    }));
    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(gateMocks.enqueueUserMessage).not.toHaveBeenCalled();
  });

  // 票 #30（ADR-0011 Decision 2）：确认门回执携带从持久化计划引述的
  // next-step（工具名 + 一句话指引 + 计划快照 revision），agent 照单执行。
  it('回执携带从持久化计划引述的 next-step 与计划快照 revision', async () => {
    gateMocks.approveArticle.mockResolvedValueOnce(approvedArticle);
    gateMocks.quoteGeoNextStepForGateKind.mockResolvedValueOnce({
      stepId: 'plan-distribution',
      tool: 'plan_distribution',
      guidance: 'Plan channel distribution for the approved articles.',
      planRevision: 12,
    });
    const { status } = await callRoute('/api/xiaojing/articles/approve', identityPayload({
      operationId: 'article-op-1',
      articleId: 'article-1',
      expectedRevision: 6,
    }));
    expect(status).toBe(200);
    expect(gateMocks.quoteGeoNextStepForGateKind).toHaveBeenCalledWith(
      { workspaceId: basename(workspace), sessionId: 'session-1' },
      'article-approval',
    );
    const [text] = gateMocks.enqueueUserMessage.mock.calls[0] as [string];
    expect(text).toContain('<next-step>');
    expect(text).toContain('<step-id>plan-distribution</step-id>');
    expect(text).toContain('<tool>plan_distribution</tool>');
    expect(text).toContain('<plan-revision>12</plan-revision>');
    expect(text).toContain('execute the next-step quoted in this envelope');
  });
});

describe('distribution confirmation gate injects a decision receipt and continues', () => {
  it('确认成功后注入 XIAOJING_DISTRIBUTION_PLAN_DECISION 回执，响应携带 notification 状态', async () => {
    gateMocks.confirmDistribution.mockResolvedValueOnce(confirmedPlan);
    const { status, body } = await callRoute('/api/xiaojing/distribution-plans/confirm', identityPayload({
      planId: 'plan-1',
      expectedRevision: 3,
    }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.plan).toMatchObject({ id: 'plan-1', status: 'confirmed' });
    expect(body.notificationQueued).toBe(true);
    expect(body.notificationError).toBeUndefined();
    expectGateReceipt('XIAOJING_DISTRIBUTION_PLAN_DECISION', 'do not re-ask about this plan', [
      '<plan-id>plan-1</plan-id>',
      '<operation-id>geo-op-1</operation-id>',
      '<article-operation-id>article-op-1</article-operation-id>',
      '<status>confirmed</status>',
      '<revision>4</revision>',
      '<assignment-count>2</assignment-count>',
    ]);
    expect(gateMocks.recordGeoOperationMilestone).toHaveBeenCalledWith(
      { workspaceId: basename(workspace), sessionId: 'session-1' },
      'distribution-confirmed',
    );
  });

  it('入队拒绝或抛错不回滚决策：响应仍成功并显式返回 notification 失败', async () => {
    gateMocks.confirmDistribution.mockResolvedValue(confirmedPlan);
    gateMocks.enqueueUserMessage.mockResolvedValueOnce({ accepted: false, error: 'Agent is already responding.' });
    const rejected = await callRoute('/api/xiaojing/distribution-plans/confirm', identityPayload({
      planId: 'plan-1',
      expectedRevision: 3,
    }));
    expect(rejected.status).toBe(200);
    expect(rejected.body.success).toBe(true);
    expect(rejected.body.plan).toMatchObject({ id: 'plan-1' });
    expect(rejected.body.notificationQueued).toBe(false);
    expect(rejected.body.notificationError).toBe('Agent is already responding.');

    gateMocks.enqueueUserMessage.mockRejectedValueOnce(new Error('transient enqueue crash'));
    const crashed = await callRoute('/api/xiaojing/distribution-plans/confirm', identityPayload({
      planId: 'plan-1',
      expectedRevision: 3,
    }));
    expect(crashed.status).toBe(200);
    expect(crashed.body.success).toBe(true);
    expect(crashed.body.notificationQueued).toBe(false);
    expect(String(crashed.body.notificationError)).toContain('transient enqueue crash');
  });

  it('决策提交失败（revision 冲突）不投递回执，返回 409', async () => {
    gateMocks.confirmDistribution.mockRejectedValueOnce(new Error('distribution_plan_revision_conflict'));
    const { status, body } = await callRoute('/api/xiaojing/distribution-plans/confirm', identityPayload({
      planId: 'plan-1',
      expectedRevision: 0,
    }));
    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(gateMocks.enqueueUserMessage).not.toHaveBeenCalled();
  });
});

describe('both gates share the existing gate contract (topic-plan isomorphism)', () => {
  it('选题门在同一接缝上呈现相同的回执与响应契约', async () => {
    gateMocks.confirmTopicPlan.mockResolvedValueOnce({
      planId: 'topic-plan-1',
      decisionId: 'decision-1',
      revision: 2,
      questionPoolId: 'pool-1',
      questionPoolRevision: 3,
      knowledgeVersion: 4,
      selectedItemIds: ['item-1', 'item-2'],
    } as TopicPlanConfirmation);
    const { status, body } = await callRoute('/api/xiaojing/topic-plans/confirm', identityPayload({
      planId: 'topic-plan-1',
      expectedRevision: 1,
      selectedItemIds: ['item-1', 'item-2'],
    }));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.notificationQueued).toBe(true);
    expect(body.notificationError).toBeUndefined();
    expectGateReceipt('XIAOJING_TOPIC_PLAN_DECISION', 'Use only its selected items downstream', [
      '<plan-id>topic-plan-1</plan-id>',
      '<revision>2</revision>',
    ]);
  });
});
