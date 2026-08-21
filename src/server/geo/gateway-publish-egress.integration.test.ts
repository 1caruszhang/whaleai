import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 票 08 闭环验收集成（确定性发布测试模式）：发布执行器 egress 服务
// （PublishEgressService）+ 真实运营后端 Hono app（进程内 app.request，
// 不起端口、不触公网）+ mock 上游（OSS PUT 与超级媒介最小状态机）。
// 覆盖生产路径：网关 OSS 上传（服务器重签 + 公网基地址解析）、下单
// 预扣冻结 → 查单结转、sn 幂等派生、网关 402 余额不足 → NonRetryable
// （充值语义）、上游 429 经网关透传 → SafeRetryable。全部确定性。
import {
  postJson,
  provisionLoggedInAccount,
  startTestBackend,
  TEST_ADMIN_PASSWORD,
  type TestBackend,
} from '../../../backend/tests/helpers';
import { createGeoProviderCapabilities, distributionOrderSn } from './provider-capabilities';
import { PublishEgressService } from './publish-egress';

const GATEWAY_BASE = 'https://gw.example.test';
const EXECUTION_ID = 'publish-execution-egress-1';
const ITEM_ID = 'publish-item-egress-1';
const OBJECT_KEY = 'articles/w-1/a-1/approved-v1-abc.html';
const CDN_BASE = 'https://cdn.example.test';

interface UpstreamState {
  orders: Map<string, { sn: string; status: number }>;
  ossPuts: Array<{ url: string; authorization: string; body: string }>;
}

/** mock 上游：OSS PUT 全收（记录重签后的请求）+ 超级媒介最小订单状态机。 */
function upstreamMock() {
  const state: UpstreamState = { orders: new Map(), ossPuts: [] };
  let rateLimitOnce = true;
  const respond = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // OSS 上游（网关用服务器 AK/SK 重签后投递，内网 host 形态）。
    if (request.method === 'PUT' && url.hostname.endsWith('.aliyuncs.com')) {
      state.ossPuts.push({
        url: request.url,
        authorization: request.headers.get('authorization') ?? '',
        body: await request.text(),
      });
      return new Response('', { status: 200 });
    }
    const path = url.pathname.replace(/^\/api/, '');
    const params = url.searchParams;
    const kind: 'media' | 'we-media' = path.startsWith('/we-media')
      ? 'we-media'
      : 'media';
    const envelope = (data: unknown, code = 200) =>
      new Response(JSON.stringify({ code, message: 'ok', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    if (request.method === 'POST' && path === `/${kind}/order`) {
      const sn = params.get('sn') ?? '';
      // 首次下单模拟上游限流一次（429 经网关透传 → SafeRetryable，且网关
      // 对账后释放冻结，同 sn 重放不重复扣点）。
      if (rateLimitOnce) {
        rateLimitOnce = false;
        return new Response(JSON.stringify({ code: 429, message: '限流' }), {
          status: 429,
        });
      }
      if (!state.orders.has(sn)) {
        state.orders.set(sn, { sn, status: 1 });
      }
      return envelope({ partner_sn: '9'.repeat(25) + String(state.orders.size) });
    }
    if (request.method === 'GET' && path === `/${kind}/order/query`) {
      const items = params
        .getAll('sn[]')
        .map((sn) => state.orders.get(sn))
        .filter((order): order is { sn: string; status: number } => order !== undefined)
        .map((order) => ({
          sn: order.sn,
          url: order.status === 4 ? 'https://news.example.com/a' : null,
          screenshot: null,
          published_at: order.status === 4 ? '2026-08-19T08:00:00Z' : null,
          status: order.status,
          feedback: null,
        }));
      return envelope(items);
    }
    if (request.method === 'GET' && path === `/${kind}/resource/query`) {
      const ids = params.getAll('id[]').map((id) => Number.parseInt(id, 10));
      return envelope(
        ids.map((id) => ({ id, name: '网易网', price: '88.00', status: 2 })),
      );
    }
    return new Response(JSON.stringify({ code: 404, message: 'not found' }), {
      status: 404,
    });
  };
  return { fetch: respond as typeof fetch, state };
}

/** 路由 fetch：网关流量 → 后端 app.request；其余 → mock 上游。 */
function gatewayFetch(
  app: TestBackend['app'],
  upstream: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(GATEWAY_BASE)) {
      const parsed = new URL(url);
      return app.request(parsed.pathname + parsed.search, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
    }
    return upstream(url, init);
  }) as unknown as typeof fetch;
}

describe('ticket 08 closure: publish executor egress through the real gateway', () => {
  let tb: TestBackend;
  let richToken: string;
  let poorToken: string;
  let upstream: ReturnType<typeof upstreamMock>;

  beforeEach(async () => {
    upstream = upstreamMock();
    tb = await startTestBackend({
      fetch: upstream.fetch as unknown as typeof globalThis.fetch,
      config: { ossPublicBaseUrl: CDN_BASE },
    });
    const rich = await provisionLoggedInAccount(
      tb.app,
      '13800000001',
      'initial-pass-1',
    );
    richToken = rich.accessToken;
    const poor = await provisionLoggedInAccount(
      tb.app,
      '13800000002',
      'initial-pass-2',
    );
    poorToken = poor.accessToken;
    // 富账户：赠 500 + 充 1600（¥88 渠道单 1408 点可冻结并结转）。
    // 穷账户：清零余额（触发网关 402）。
    const login = await postJson(tb.app, '/admin/login', {
      password: TEST_ADMIN_PASSWORD,
    });
    const adminToken = String((login.body as { adminToken: string }).adminToken);
    await postJson(
      tb.app,
      '/admin/ledger/adjust',
      { accountId: rich.accountId, delta: 1600, note: '充值' },
      adminToken,
    );
    await postJson(
      tb.app,
      '/admin/ledger/adjust',
      { accountId: poor.accountId, delta: -500, note: '清零' },
      adminToken,
    );
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  async function balanceOf(token: string): Promise<{ total: number; frozen: number }> {
    const response = await tb.app.request('/billing/balance', {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as {
      balance: { total: number; frozen: number };
    };
    return body.balance;
  }

  const service = (token: string) =>
    new PublishEgressService(
      createGeoProviderCapabilities(
        { gatewayBaseUrl: GATEWAY_BASE, accountAccessToken: token },
        { fetch: gatewayFetch(tb.app, upstream.fetch) },
      ),
    );

  it('uploads article html through the gateway with server-side signing', async () => {
    const html = '<!DOCTYPE html><html><body>批准正文</body></html>';
    const result = await service(richToken).upload({
      executionId: EXECUTION_ID,
      itemId: ITEM_ID,
      objectKey: OBJECT_KEY,
      html,
    });
    expect(result).toEqual({
      outcome: 'success',
      objectUrl: `${CDN_BASE}/articles/w-1/a-1/approved-v1-abc.html`,
      externalContentId: OBJECT_KEY,
    });
    // 网关用服务器 AK/SK 重签投 OSS：body 原文到达上游，签名是 OSS 形态，
    // 账号 token 绝不出现在对上游的请求里。
    expect(upstream.state.ossPuts).toHaveLength(1);
    expect(upstream.state.ossPuts[0]!.body).toBe(html);
    expect(upstream.state.ossPuts[0]!.authorization).toMatch(
      /^OSS test-oss-access-key-id:/,
    );
    expect(upstream.state.ossPuts[0]!.authorization).not.toContain(richToken);
  });

  it('places the order with the derived sn, freezes points, then settles through 发布中', async () => {
    const egress = service(richToken);
    const upload = await egress.upload({
      executionId: EXECUTION_ID,
      itemId: ITEM_ID,
      objectKey: OBJECT_KEY,
      html: '<html></html>',
    });
    if (upload.outcome !== 'success') throw new Error('upload failed');

    // 上游首次限流（429 经网关透传）→ 网关对账释放冻结 → SafeRetryable。
    const rateLimited = await egress.placeOrder({
      executionId: EXECUTION_ID,
      itemId: ITEM_ID,
      perArticleMaxPoints: 3_000,
      executionMaxPoints: 20_000,
      kind: 'media',
      resourceId: 101,
      title: '品牌知识服务怎么选',
      contentUrl: upload.objectUrl,
    });
    expect(rateLimited).toMatchObject({
      outcome: 'safe-retryable',
      code: 'distribution-http-429',
    });
    expect(await balanceOf(richToken)).toMatchObject({ frozen: 0 });

    const placed = await egress.placeOrder({
      executionId: EXECUTION_ID,
      itemId: ITEM_ID,
      perArticleMaxPoints: 3_000,
      executionMaxPoints: 20_000,
      kind: 'media',
      resourceId: 101,
      title: '品牌知识服务怎么选',
      contentUrl: upload.objectUrl,
    });
    const sn = distributionOrderSn(EXECUTION_ID, ITEM_ID);
    // sn 单一权威：服务端按 (executionId, itemId) 派生，与查单路由同式。
    expect(placed).toMatchObject({
      outcome: 'success',
      sn,
      points: 1408,
      ledgerStatus: 'frozen',
    });
    expect(placed.outcome === 'success' && placed.externalOrderId).toMatch(
      /^\d{26}$/,
    );
    expect(await balanceOf(richToken)).toMatchObject({ total: 2100, frozen: 1408 });

    // 上游进入发布中 → 查单驱动结转（consume 流水、冻结清零）。
    upstream.state.orders.get(sn)!.status = 3;
    const statuses = await createGeoProviderCapabilities(
      { gatewayBaseUrl: GATEWAY_BASE, accountAccessToken: richToken },
      { fetch: gatewayFetch(tb.app, upstream.fetch) },
    ).distribution.queryOrders('media', [sn]);
    expect(statuses[0]).toMatchObject({ sn, status: 3 });
    expect(await balanceOf(richToken)).toMatchObject({ total: 692, frozen: 0 });
    const consume = tb.db.all(
      "SELECT delta FROM ledger_entries WHERE kind = 'consume'",
      [],
    );
    expect(consume).toEqual([{ delta: -1408 }]);
  });

  it('maps insufficient gateway balance (402) to non-retryable top-up semantics', async () => {
    const result = await service(poorToken).placeOrder({
      executionId: 'publish-execution-poor',
      itemId: 'publish-item-poor',
      perArticleMaxPoints: 3_000,
      executionMaxPoints: 20_000,
      kind: 'media',
      resourceId: 101,
      title: '标题',
      contentUrl: 'https://cdn.example.test/a.html',
    });
    expect(result).toMatchObject({
      outcome: 'non-retryable',
      code: 'distribution-insufficient-balance',
    });
    expect(
      result.outcome === 'non-retryable' && result.reason,
    ).toContain('充值');
    // 未受理：上游无此单，也不产生任何冻结。
    expect(upstream.state.orders.size).toBe(0);
    expect(await balanceOf(poorToken)).toMatchObject({ total: 0, frozen: 0 });
  });
});
