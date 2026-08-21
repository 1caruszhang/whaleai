import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  distributionOrderSn,
  GeoUpstreamHttpError,
} from '../geo/provider-capabilities';
import type { PublishEgressOrderResult } from '../geo/publish-egress';

// 票 08 闭环：/api/xiaojing/publish-scheduler/egress/* 是 Rust 确定性调度器
// 专用的 localhost 控制面路由。本测试在 HTTP 边界钉住：身份门先于任何
// Provider 调用、上传/下单回 egress 分类信封（control-plane 恒 200）、
// 下单 sn 由服务端按 distributionOrderSn(executionId, itemId) 派生（请求
// 体不接受 sn）、网关 402 映射为 NonRetryable（充值语义）。全程 mock
// typed capability，不触真实网络。

const mocks = vi.hoisted(() => ({
  sessionId: 'session-egress-42',
  putHtml: vi.fn(),
  placeOrder: vi.fn(),
  requestTokens: [] as (string | undefined)[],
}));

vi.mock('../agent-session', () => ({
  getSessionId: () => mocks.sessionId,
}));

vi.mock('../geo/provider-runtime', () => ({
  getXiaojingGeoProviderCapabilities: () => ({
    objectStorage: { putHtml: mocks.putHtml },
    distribution: { placeOrder: mocks.placeOrder },
  }),
  getXiaojingGeoProviderCapabilitiesForRequest: (token?: string) => {
    mocks.requestTokens.push(token);
    return {
      objectStorage: { putHtml: mocks.putHtml },
      distribution: { placeOrder: mocks.placeOrder },
    };
  },
  getXiaojingGeoBillingPermitChannel: () => undefined,
  getXiaojingGeoBillingPermitChannelForRequest: () => undefined,
}));

let workspace: string;
let workspaceId: string;
let handleXiaojingRoute: typeof import('../routes/xiaojing')['handleXiaojingRoute'];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-publish-egress-ws-'));
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

const UPLOAD_BODY = {
  workspaceId: 'replaced-in-test',
  sessionId: mocks.sessionId,
  executionId: 'execution-egress-1',
  itemId: 'item-egress-1',
  objectKey: 'articles/w-1/a-1/approved-v1-abc.html',
  html: '<!DOCTYPE html><html><body>正文</body></html>',
};

const ORDER_BODY = {
  workspaceId: 'replaced-in-test',
  sessionId: mocks.sessionId,
  executionId: 'execution-egress-1',
  itemId: 'item-egress-1',
  perArticleMaxPoints: 3_000,
  executionMaxPoints: 20_000,
  kind: 'media',
  resourceId: 101,
  title: '品牌知识服务怎么选',
  contentUrl: 'https://cdn.example.test/articles/w-1/a-1/approved-v1-abc.html',
};

describe('publish scheduler egress routes', () => {
  beforeEach(() => {
    mocks.putHtml.mockReset();
    mocks.placeOrder.mockReset();
    mocks.requestTokens.length = 0;
  });

  it('forwards the request-level account token header to the typed ports', async () => {
    mocks.putHtml.mockResolvedValue({
      url: 'https://cdn.example.test/articles/w-1/a-1/approved-v1-abc.html',
    });
    const request = post('/api/xiaojing/publish-scheduler/egress/upload', {
      ...UPLOAD_BODY,
      workspaceId,
    });
    // Rust 代理/worker 附带的当前新鲜 token（临期已自动 refresh）。
    request.headers.set('x-xiaojing-account-token', 'fresh-jwt-egress');
    const response = await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/upload',
      request,
      { workspacePath: workspace },
    );
    expect(response?.status).toBe(200);
    expect(mocks.requestTokens).toEqual(['fresh-jwt-egress']);

    // 无头请求（旧客户端/直连）：回退 admission env token 的单例口径。
    mocks.requestTokens.length = 0;
    await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/upload',
      post('/api/xiaojing/publish-scheduler/egress/upload', {
        ...UPLOAD_BODY,
        workspaceId,
      }),
      { workspacePath: workspace },
    );
    expect(mocks.requestTokens).toEqual([undefined]);
  });

  it('uploads through the port and returns the typed success envelope', async () => {
    mocks.putHtml.mockResolvedValue({
      url: 'https://cdn.example.test/articles/w-1/a-1/approved-v1-abc.html',
    });
    const response = await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/upload',
      post('/api/xiaojing/publish-scheduler/egress/upload', {
        ...UPLOAD_BODY,
        workspaceId,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      success: boolean;
      result: { outcome: string; objectUrl: string; externalContentId: string };
    };
    expect(body.success).toBe(true);
    expect(body.result).toEqual({
      outcome: 'success',
      objectUrl: 'https://cdn.example.test/articles/w-1/a-1/approved-v1-abc.html',
      externalContentId: 'articles/w-1/a-1/approved-v1-abc.html',
    });
    expect(mocks.putHtml).toHaveBeenCalledWith(
      'articles/w-1/a-1/approved-v1-abc.html',
      UPLOAD_BODY.html,
    );
  });

  it('derives the order sn server-side and never accepts a client sn', async () => {
    mocks.placeOrder.mockResolvedValue({
      sn: distributionOrderSn('execution-egress-1', 'item-egress-1'),
      partnerSn: '99999999999999999999999999',
      points: 1408,
      ledgerStatus: 'frozen',
    });
    const response = await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/order',
      // Rust 不传 sn；即便恶意多带一个 sn 字段也不得进入 port。
      post('/api/xiaojing/publish-scheduler/egress/order', {
        ...ORDER_BODY,
        workspaceId,
        sn: 'client-forged-sn-000000000000000',
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      success: boolean;
      result: PublishEgressOrderResult;
    };
    expect(body.success).toBe(true);
    expect(body.result).toMatchObject({
      outcome: 'success',
      sn: distributionOrderSn('execution-egress-1', 'item-egress-1'),
      externalOrderId: '99999999999999999999999999',
      points: 1408,
      ledgerStatus: 'frozen',
    });
    const [kind, placement] = mocks.placeOrder.mock.calls[0] as [
      'media' | 'we-media',
      {
        sn: string;
        resourceId: number;
        title: string;
        contentUrl: string;
        perArticleMaxPoints: number;
        executionMaxPoints: number;
      },
    ];
    expect(kind).toBe('media');
    expect(placement.sn).toBe(distributionOrderSn('execution-egress-1', 'item-egress-1'));
    expect(placement.resourceId).toBe(101);
    expect(placement.title).toBe('品牌知识服务怎么选');
    expect(placement.perArticleMaxPoints).toBe(3_000);
    expect(placement.executionMaxPoints).toBe(20_000);
    // media 订单不携带自媒体三元组。
    expect(placement).not.toHaveProperty('publishForm');
  });

  it('maps a gateway 402 to a non-retryable top-up outcome', async () => {
    mocks.placeOrder.mockRejectedValue(
      new GeoUpstreamHttpError(
        'distribution',
        402,
        'distribution 点数不足：本次需 1408 点，当前可用 100 点，请充值后再试。',
        'insufficient_balance',
      ),
    );
    const response = await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/order',
      post('/api/xiaojing/publish-scheduler/egress/order', {
        ...ORDER_BODY,
        workspaceId,
      }),
      { workspacePath: workspace },
    );

    // 控制面成功（200），egress 结果是分类值：余额不足绝不静默重试。
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      success: boolean;
      result: PublishEgressOrderResult;
    };
    expect(body.success).toBe(true);
    expect(body.result).toMatchObject({
      outcome: 'non-retryable',
      code: 'distribution-insufficient-balance',
    });
    expect(
      body.result.outcome === 'non-retryable' && body.result.reason,
    ).toContain('充值');
  });

  it('returns 403 before any provider call on identity mismatch', async () => {
    for (const pathname of [
      '/api/xiaojing/publish-scheduler/egress/upload',
      '/api/xiaojing/publish-scheduler/egress/order',
    ]) {
      const response = await handleXiaojingRoute(
        pathname,
        post(pathname, { ...ORDER_BODY, workspaceId: 'not-this-workspace' }),
        { workspacePath: workspace },
      );
      expect(response?.status).toBe(403);
    }
    expect(mocks.putHtml).not.toHaveBeenCalled();
    expect(mocks.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects malformed egress payloads with 400 and no provider call', async () => {
    const upload = await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/upload',
      post('/api/xiaojing/publish-scheduler/egress/upload', {
        workspaceId,
        sessionId: mocks.sessionId,
        executionId: 'execution-egress-1',
        itemId: 'item-egress-1',
        objectKey: 'articles/a.html',
        // html 缺失。
      }),
      { workspacePath: workspace },
    );
    expect(upload?.status).toBe(400);
    const order = await handleXiaojingRoute(
      '/api/xiaojing/publish-scheduler/egress/order',
      post('/api/xiaojing/publish-scheduler/egress/order', {
        workspaceId,
        sessionId: mocks.sessionId,
        executionId: 'execution-egress-1',
        itemId: 'item-egress-1',
        kind: 'unknown-kind',
        resourceId: 101,
        title: '标题',
        contentUrl: 'https://cdn.example.test/a.html',
      }),
      { workspacePath: workspace },
    );
    expect(order?.status).toBe(400);
    expect(mocks.putHtml).not.toHaveBeenCalled();
    expect(mocks.placeOrder).not.toHaveBeenCalled();
  });
});
