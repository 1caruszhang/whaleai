import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { distributionOrderSn } from '../geo/provider-capabilities';
import type { GeoDistributionOrderStatus } from '../geo/provider-capabilities';

// 票 14：/api/xiaojing/post-publish-monitor/order-query 与 /balance 是
// Rust 监测 executor 专用的 localhost 控制面路由。本测试在 HTTP 边界钉住：
// 身份门先于任何 Provider 调用、查单 sn 由服务端按
// distributionOrderSn(executionId, itemId) 派生（请求体不接受 sn）、
// gateway-era 订单条目原样透传、paused 恢复预检只读余额且零扣点、
// 开发直连模式返回 configured=false。全程 mock typed capability 与计费
// 通道，不触真实网络。

const mocks = vi.hoisted(() => ({
  sessionId: 'session-monitor-gw-14',
  queryOrders: vi.fn(),
  balance: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  getSessionId: () => mocks.sessionId,
}));

vi.mock('../geo/provider-runtime', () => ({
  getXiaojingGeoProviderCapabilities: () => ({
    distribution: { queryOrders: mocks.queryOrders },
  }),
  getXiaojingGeoBillingPermitChannel: () =>
    mocks.balance.getMockImplementation()
      ? { balance: mocks.balance }
      : undefined,
}));

let workspace: string;
let workspaceId: string;
let handleXiaojingRoute: typeof import('../routes/xiaojing')['handleXiaojingRoute'];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-monitor-gw-ws-'));
  workspaceId = basename(resolve(workspace));
  ({ handleXiaojingRoute } = await import('../routes/xiaojing'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function post(pathname: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function gatewayOrder(
  executionId: string,
  itemId: string,
  overrides: Partial<GeoDistributionOrderStatus> = {},
): GeoDistributionOrderStatus {
  return {
    sn: distributionOrderSn(executionId, itemId),
    status: 3,
    url: null,
    screenshot: null,
    publishedAt: null,
    feedback: null,
    ...overrides,
  };
}

const QUERY_BODY = {
  workspaceId: 'replaced-in-test',
  sessionId: mocks.sessionId,
  executionId: 'publish-exec-14',
  itemId: 'publish-item-14',
  kind: 'we-media',
};

describe('post-publish monitor gateway routes', () => {
  beforeEach(() => {
    mocks.queryOrders.mockReset();
    mocks.balance.mockReset();
  });

  it('queries the gateway with the server-derived sn and returns the matched record', async () => {
    const record = gatewayOrder('publish-exec-14', 'publish-item-14', {
      status: 4,
      url: 'https://news.example.com/a',
      publishedAt: '2026-08-19T08:00:00Z',
    });
    mocks.queryOrders.mockResolvedValue([record]);
    const response = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/order-query',
      post('/api/xiaojing/post-publish-monitor/order-query', {
        ...QUERY_BODY,
        workspaceId,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(200);
    // sn 单一权威在服务端：与票 08 下单同口径派生，请求体不带 sn。
    const expectedSn = distributionOrderSn('publish-exec-14', 'publish-item-14');
    expect(mocks.queryOrders).toHaveBeenCalledWith('we-media', [expectedSn]);
    const body = (await response?.json()) as {
      success: boolean;
      result: { sn: string; kind: string; record: GeoDistributionOrderStatus };
    };
    expect(body.success).toBe(true);
    expect(body.result).toEqual({ sn: expectedSn, kind: 'we-media', record });
  });

  it('returns a null record when the gateway has not observed the sn yet', async () => {
    mocks.queryOrders.mockResolvedValue([]);
    const response = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/order-query',
      post('/api/xiaojing/post-publish-monitor/order-query', {
        ...QUERY_BODY,
        workspaceId,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      success: boolean;
      result: { record: null };
    };
    expect(body.result.record).toBeNull();
  });

  it('rejects identity mismatch and invalid payloads before any provider call', async () => {
    const mismatched = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/order-query',
      post('/api/xiaojing/post-publish-monitor/order-query', {
        ...QUERY_BODY,
        workspaceId,
        sessionId: 'another-session',
      }),
      { workspacePath: workspace },
    );
    expect(mismatched?.status).toBe(403);
    expect(mocks.queryOrders).not.toHaveBeenCalled();

    const invalid = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/order-query',
      post('/api/xiaojing/post-publish-monitor/order-query', {
        ...QUERY_BODY,
        workspaceId,
        kind: 'sms',
      }),
      { workspacePath: workspace },
    );
    expect(invalid?.status).toBe(400);
    expect(mocks.queryOrders).not.toHaveBeenCalled();
  });

  it('probes the balance read-only for paused-plan recovery', async () => {
    mocks.balance.mockResolvedValue({ total: 7, frozen: 0, available: 7 });
    const response = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/balance',
      post('/api/xiaojing/post-publish-monitor/balance', {
        workspaceId,
        sessionId: mocks.sessionId,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      success: boolean;
      result: { configured: boolean; available: number; required: number; sufficient: boolean };
    };
    expect(body.result).toEqual({
      configured: true,
      available: 7,
      required: 5,
      sufficient: true,
    });
    // 只读预检：只碰余额读，绝不查单。
    expect(mocks.queryOrders).not.toHaveBeenCalled();
  });

  it('reports insufficient balance and unconfigured direct mode without resuming', async () => {
    mocks.balance.mockResolvedValue({ total: 2, frozen: 0, available: 2 });
    const insufficient = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/balance',
      post('/api/xiaojing/post-publish-monitor/balance', {
        workspaceId,
        sessionId: mocks.sessionId,
      }),
      { workspacePath: workspace },
    );
    const insufficientBody = (await insufficient?.json()) as {
      result: { sufficient: boolean };
    };
    expect(insufficientBody.result.sufficient).toBe(false);

    mocks.balance.mockReset();
    const unconfigured = await handleXiaojingRoute(
      '/api/xiaojing/post-publish-monitor/balance',
      post('/api/xiaojing/post-publish-monitor/balance', {
        workspaceId,
        sessionId: mocks.sessionId,
      }),
      { workspacePath: workspace },
    );
    const unconfiguredBody = (await unconfigured?.json()) as {
      result: { configured: boolean; sufficient: boolean };
    };
    expect(unconfiguredBody.result).toEqual({
      configured: false,
      sufficient: false,
    });
  });
});
