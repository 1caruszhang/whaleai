import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublishExecutionProjection } from '../../shared/geo/publishScheduler';

// 票 09：/api/xiaojing/publish-scheduler/orders 订单状态投影路由。计费权威
// 在网关（查单即对账），本测试在 HTTP 边界钉住：sn 用
// distributionOrderSn(executionId, itemId) 确定性派生、按 kind 分组查询、
// 上游未返回的 sn 投影为 status=null、网关模式错误不伪装成空数据。
// 全程 mock typed port 与 distribution capability，不触真实网络。

const mocks = vi.hoisted(() => ({
  sessionId: 'session-orders-42',
  getExecution: vi.fn(),
  queryOrders: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  getSessionId: () => mocks.sessionId,
}));

vi.mock('../geo/publish-scheduler', () => ({
  createPublishSchedulerPort: () => ({
    get: mocks.getExecution,
  }),
}));

vi.mock('../geo/provider-runtime', () => ({
  getXiaojingGeoProviderCapabilities: () => ({
    distribution: { queryOrders: mocks.queryOrders },
  }),
  getXiaojingGeoProviderCapabilitiesForRequest: () => ({
    distribution: { queryOrders: mocks.queryOrders },
  }),
  getXiaojingGeoBillingPermitChannel: () => undefined,
  getXiaojingGeoBillingPermitChannelForRequest: () => undefined,
}));

let workspace: string;
let workspaceId: string;
let handleXiaojingRoute: typeof import('../routes/xiaojing')['handleXiaojingRoute'];
let distributionOrderSn: typeof import('../geo/provider-capabilities')['distributionOrderSn'];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-publish-orders-ws-'));
  workspaceId = basename(resolve(workspace));
  ({ handleXiaojingRoute } = await import('../routes/xiaojing'));
  ({ distributionOrderSn } = await import('../geo/provider-capabilities'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function execution(overrides: Partial<PublishExecutionProjection> = {}): PublishExecutionProjection {
  return {
    id: 'exec-orders-1',
    operationId: 'operation-1',
    workspaceId,
    createdBySessionId: mocks.sessionId,
    distributionPlanId: 'plan-1',
    distributionPlanRevision: 2,
    policyVersion: 'js-ai-dev-deterministic-publish-v1',
    revision: 5,
    status: 'running',
    budgetCny: 500,
    estimatedSpendCny: 100,
    totalPricePoints: 1600,
    publishStartAt: '2026-08-20T02:00:00Z',
    irreversibleImpact: '将付费并向外部渠道发布，不可撤销。',
    confirmationDigest: 'digest-1',
    providerSnapshot: {
      objectStorage: {
        provider: 'aliyun-oss',
        endpointFamily: 'gateway-oss-put',
        configured: true,
        configurationFingerprint: 'fp-oss',
      },
      distribution: {
        provider: '超级媒介',
        endpointFamily: 'gateway-order-api',
        configured: true,
        configurationFingerprint: 'fp-dist',
      },
    },
    items: [
      {
        id: 'item-media-1',
        revision: 1,
        sequence: 1,
        article: {
          articleId: 'article-1',
          approvedRevision: 1,
          approvedBodySha256: 'abc',
          title: '媒体文章',
          bodyBytes: 128,
          bodySummary: '摘要。',
        },
        channel: {
          resourceId: 8,
          kind: 'media',
          name: '渠道甲',
          estimatedPriceCny: 100,
          publishedRate: 90,
          pricePoints: 1600,
        },
        scheduledAt: '2026-08-20T02:00:00Z',
        status: 'submitted',
        idempotencyKey: 'idem-1',
        externalRequestSn: 'sn-legacy-1',
        payloadHash: 'hash-1',
        objectKey: 'articles/a.html',
        objectUrl: 'https://oss.example/articles/a.html',
        externalOrderId: 'SN-1',
        externalContentId: null,
        attempts: 1,
        uploadAttempts: 1,
        nextAttemptAt: null,
        startedAt: null,
        finishedAt: null,
        requestSummary: {
          articleId: 'article-1',
          approvedRevision: 1,
          approvedBodySha256: 'abc',
          resourceId: 8,
          scheduledAt: '2026-08-20T02:00:00Z',
          plannedObjectUrl: 'https://oss.example/articles/a.html',
          estimatedPriceCny: 100,
        },
        failureCode: null,
        failureReason: null,
      },
      {
        id: 'item-we-media-2',
        revision: 1,
        sequence: 2,
        article: {
          articleId: 'article-2',
          approvedRevision: 1,
          approvedBodySha256: 'def',
          title: '自媒体文章',
          bodyBytes: 128,
          bodySummary: '摘要。',
        },
        channel: {
          resourceId: 9,
          kind: 'we-media',
          name: '渠道乙',
          estimatedPriceCny: 0,
          publishedRate: 0,
          pricePoints: 0,
        },
        scheduledAt: '2026-08-20T02:00:00Z',
        status: 'pending',
        idempotencyKey: 'idem-2',
        externalRequestSn: 'sn-legacy-2',
        payloadHash: 'hash-2',
        objectKey: 'articles/b.html',
        objectUrl: null,
        externalOrderId: null,
        externalContentId: null,
        attempts: 0,
        uploadAttempts: 0,
        nextAttemptAt: null,
        startedAt: null,
        finishedAt: null,
        requestSummary: {
          articleId: 'article-2',
          approvedRevision: 1,
          approvedBodySha256: 'def',
          resourceId: 9,
          scheduledAt: '2026-08-20T02:00:00Z',
          plannedObjectUrl: 'https://oss.example/articles/b.html',
          estimatedPriceCny: 0,
        },
        failureCode: null,
        failureReason: null,
      },
    ],
    confirmedAt: null,
    executionStartedAt: '2026-08-19T00:00:00Z',
    finishedAt: null,
    createdAt: '2026-08-18T00:00:00Z',
    updatedAt: '2026-08-18T00:00:00Z',
    ...overrides,
  };
}

function post(body: unknown): Request {
  return new Request('http://127.0.0.1:1/api/xiaojing/publish-scheduler/orders', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('publish scheduler order status route', () => {
  beforeEach(() => {
    mocks.getExecution.mockReset();
    mocks.queryOrders.mockReset();
  });

  it('projects per-item gateway order status with deterministic sns', async () => {
    mocks.getExecution.mockResolvedValue(execution());
    const mediaSn = distributionOrderSn('exec-orders-1', 'item-media-1');
    const pendingSn = distributionOrderSn('exec-orders-1', 'item-we-media-2');
    mocks.queryOrders.mockImplementation(async (kind: string, sns: readonly string[]) => {
      expect(sns.length).toBeLessThanOrEqual(20);
      if (kind === 'media') {
        expect(sns).toEqual([mediaSn]);
        return [
          {
            sn: mediaSn,
            status: 4,
            url: 'https://news.example/article-1',
            screenshot: '<p>回传截图</p>',
            publishedAt: '2026-08-21T00:00:00Z',
            feedback: null,
          },
        ];
      }
      expect(kind).toBe('we-media');
      return [];
    });

    const response = await handleXiaojingRoute('/api/xiaojing/publish-scheduler/orders', post({
      workspaceId,
      sessionId: mocks.sessionId,
      executionId: 'exec-orders-1',
    }), { workspacePath: workspace });

    expect(response?.status).toBe(200);
    const body = await response?.json() as {
      success: boolean;
      orders: Array<{
        itemId: string;
        sn: string;
        kind: string;
        status: number | null;
        url: string | null;
        screenshot: string | null;
        publishedAt: string | null;
      }>;
    };
    expect(body.success).toBe(true);
    // sn 与票 08 幂等键同式派生，不由 Rust 旧 sn 字段决定。
    expect(body.orders).toHaveLength(2);
    expect(body.orders[0]).toEqual({
      itemId: 'item-media-1',
      sn: mediaSn,
      kind: 'media',
      status: 4,
      url: 'https://news.example/article-1',
      screenshot: '<p>回传截图</p>',
      publishedAt: '2026-08-21T00:00:00Z',
    });
    // 上游未返回的 sn：订单尚未受理，不伪装成具体状态。
    expect(body.orders[1]).toMatchObject({
      itemId: 'item-we-media-2',
      kind: 'we-media',
      status: null,
      url: null,
      screenshot: null,
    });
    expect(body.orders[1].sn).toBe(distributionOrderSn('exec-orders-1', 'item-we-media-2'));
    // 未提交 item（externalOrderId=null 且 status 未过提交节点）的 sn 不发给网关：
    // 其订单尚不在网关 publish_orders 表，查询会整批 404。
    for (const call of mocks.queryOrders.mock.calls) {
      expect(call[1]).not.toContain(pendingSn);
    }
  });

  it('does not query unsubmitted items at all, returning them with status null', async () => {
    mocks.getExecution.mockResolvedValue(execution({
      items: [
        { ...execution().items[1], id: 'item-pending-a', status: 'pending' },
        { ...execution().items[1], id: 'item-uploaded-b', status: 'uploaded' },
        // 上传阶段失败也可能是 failed-retryable：此时网关侧无订单，不查单。
        { ...execution().items[1], id: 'item-retryable-c', status: 'failed-retryable' },
      ],
    }));

    const response = await handleXiaojingRoute('/api/xiaojing/publish-scheduler/orders', post({
      workspaceId,
      sessionId: mocks.sessionId,
      executionId: 'exec-orders-1',
    }), { workspacePath: workspace });

    expect(response?.status).toBe(200);
    const body = await response?.json() as {
      success: boolean;
      orders: Array<{ itemId: string; status: number | null }>;
    };
    expect(body.success).toBe(true);
    expect(body.orders).toHaveLength(3);
    for (const order of body.orders) {
      expect(order.status).toBeNull();
    }
    expect(mocks.queryOrders).not.toHaveBeenCalled();
  });

  it('queries items whose status passed the submit node even without externalOrderId', async () => {
    mocks.getExecution.mockResolvedValue(execution({
      items: [
        { ...execution().items[0], externalOrderId: null, status: 'submitted' },
        { ...execution().items[1], status: 'reconciliation-required' },
      ],
    }));
    const mediaSn = distributionOrderSn('exec-orders-1', 'item-media-1');
    const weMediaSn = distributionOrderSn('exec-orders-1', 'item-we-media-2');
    mocks.queryOrders.mockImplementation(async (kind: string) =>
      kind === 'media'
        ? [{ sn: mediaSn, status: 3, url: null, screenshot: null, publishedAt: null, feedback: null }]
        : [{ sn: weMediaSn, status: 4, url: 'https://mp.example/a', screenshot: null, publishedAt: '2026-08-21T00:00:00Z', feedback: null }],
    );

    const response = await handleXiaojingRoute('/api/xiaojing/publish-scheduler/orders', post({
      workspaceId,
      sessionId: mocks.sessionId,
      executionId: 'exec-orders-1',
    }), { workspacePath: workspace });

    expect(response?.status).toBe(200);
    const body = await response?.json() as {
      success: boolean;
      orders: Array<{ itemId: string; status: number | null }>;
    };
    expect(body.success).toBe(true);
    expect(body.orders[0]).toMatchObject({ itemId: 'item-media-1', status: 3 });
    expect(body.orders[1]).toMatchObject({ itemId: 'item-we-media-2', status: 4 });
    const queriedSns = mocks.queryOrders.mock.calls.flatMap((call) => call[1] as string[]);
    expect(queriedSns.sort()).toEqual([mediaSn, weMediaSn].sort());
  });

  it('returns 403 before any port or provider call on identity mismatch', async () => {
    const response = await handleXiaojingRoute('/api/xiaojing/publish-scheduler/orders', post({
      workspaceId: 'not-this-workspace',
      sessionId: mocks.sessionId,
      executionId: 'exec-orders-1',
    }), { workspacePath: workspace });

    expect(response?.status).toBe(403);
    expect(mocks.getExecution).not.toHaveBeenCalled();
    expect(mocks.queryOrders).not.toHaveBeenCalled();
  });

  it('surfaces gateway-mode provider failures instead of faking empty orders', async () => {
    mocks.getExecution.mockResolvedValue(execution());
    mocks.queryOrders.mockRejectedValue(
      new Error('distribution 查单需要网关模式（账号 admission 注入网关地址与账号 token）'),
    );

    const response = await handleXiaojingRoute('/api/xiaojing/publish-scheduler/orders', post({
      workspaceId,
      sessionId: mocks.sessionId,
      executionId: 'exec-orders-1',
    }), { workspacePath: workspace });

    expect(response?.status).toBe(400);
    const body = await response?.json() as { success: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('网关模式');
  });
});
