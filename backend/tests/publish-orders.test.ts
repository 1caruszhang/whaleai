import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  postJson,
  provisionLoggedInAccount,
  startTestBackend,
  TEST_ADMIN_PASSWORD,
  TEST_DISTRIBUTION_APP_ID,
  TEST_DISTRIBUTION_SECRET,
  type TestBackend,
} from './helpers';

/**
 * 票 08 验收：发布订单状态机 + 账本 + 事件回调，全部走 HTTP 合约边界
 * （Hono app.request + mock 超级媒介上游），不触真实媒介、真实网络或
 * 真实密钥。mock 上游实现最小状态机（下单/查单/取消/资源查询），订单
 * 状态由测试显式推进——确定性发布测试模式。
 */

const FIXED_MS = 1_787_117_340_000; // 2026-08-19T05:29:00Z
const FIXED_TIMESTAMP_SECONDS = 1_787_117_340;

interface UpstreamCall {
  method: string;
  path: string;
  params: URLSearchParams;
}

interface UpstreamOrder {
  kind: 'media' | 'we-media';
  sn: string;
  partnerSn: string;
  status: number;
  url: string | null;
  publishedAt: string | null;
}

interface UpstreamResource {
  kind: 'media' | 'we-media';
  id: number;
  name: string;
  price: string;
  status: number;
}

/** mock 超级媒介：记录请求、维护内存订单/资源状态机。 */
function supermediaMock(seed: { resources: UpstreamResource[] }) {
  // 逐条克隆种子：setPrice 只改本 mock 的副本，不跨测试泄漏。
  const resources = new Map(
    seed.resources.map(resource => [`${resource.kind}:${resource.id}`, { ...resource }]),
  );
  const orders = new Map<string, UpstreamOrder>();
  const calls: UpstreamCall[] = [];
  const controls = {
    /** 'lose' = 上游落单但回 500（响应丢失）；'reject' = 不落单直接 500。 */
    nextPlaceMode: null as null | 'lose' | 'reject',
  };
  let partnerSeq = 26;

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const params = url.searchParams;
    calls.push({ method: request.method, path, params });

    const kind: 'media' | 'we-media' = path.startsWith('/we-media') ? 'we-media' : 'media';
    const envelope = (data: unknown, code = 200) =>
      Response.json({ code, message: 'ok', data }, { status: 200 });

    if (request.method === 'POST' && path === `/${kind}/order`) {
      const sn = params.get('sn') ?? '';
      if (controls.nextPlaceMode === 'reject') {
        controls.nextPlaceMode = null;
        return Response.json({ code: 500, message: 'mock 下单失败' }, { status: 500 });
      }
      if (!orders.has(sn)) {
        const seq = String(++partnerSeq).padStart(26, '9');
        orders.set(sn, {
          kind,
          sn,
          partnerSn: seq,
          status: 1,
          url: null,
          publishedAt: null,
        });
      }
      if (controls.nextPlaceMode === 'lose') {
        controls.nextPlaceMode = null;
        return Response.json({ code: 500, message: 'mock 网络中断' }, { status: 500 });
      }
      return envelope({ partner_sn: orders.get(sn)!.partnerSn });
    }

    if (request.method === 'GET' && path === `/${kind}/order/query`) {
      const sns = params.getAll('sn[]');
      const items = sns
        .map(sn => orders.get(sn))
        .filter((order): order is UpstreamOrder => order !== undefined)
        .map(order => ({
          sn: order.sn,
          url: order.url,
          screenshot: null,
          published_at: order.publishedAt,
          status: order.status,
          feedback: null,
        }));
      return envelope(items);
    }

    if (request.method === 'POST' && path === `/${kind}/order/cancel`) {
      const order = orders.get(params.get('sn') ?? '');
      if (order && order.status === 1) order.status = 5;
      return envelope(true);
    }
    if (request.method === 'POST' && path === `/${kind}/order/apply-refund`) {
      const order = orders.get(params.get('sn') ?? '');
      if (order && order.status === 3) order.status = 6;
      return envelope(true);
    }
    if (request.method === 'POST' && (path === `/${kind}/order/urge` || path === `/${kind}/order/apply-republish`)) {
      return envelope(true);
    }

    if (request.method === 'GET' && path === `/${kind}/resource/query`) {
      const ids = params.getAll('id[]').map(id => Number.parseInt(id, 10));
      const items = ids
        .map(id => resources.get(`${kind}:${id}`))
        .filter((resource): resource is UpstreamResource => resource !== undefined)
        .map(resource => ({ id: resource.id, name: resource.name, price: resource.price, status: resource.status }));
      return envelope(items);
    }

    return Response.json({ code: 404, message: `mock 未实现 ${path}` }, { status: 404 });
  }) as typeof globalThis.fetch;

  const setStatus = (sn: string, status: number, extra: Partial<UpstreamOrder> = {}) => {
    const order = orders.get(sn);
    if (!order) throw new Error(`mock upstream has no order ${sn}`);
    Object.assign(order, { status, ...extra });
  };

  const setPrice = (kind: UpstreamResource['kind'], id: number, price: string) => {
    const resource = resources.get(`${kind}:${id}`);
    if (!resource) throw new Error(`mock upstream has no resource ${kind}:${id}`);
    resource.price = price;
  };

  return { fetch, calls, orders, setStatus, setPrice, controls };
}

const SEED_RESOURCE: UpstreamResource = {
  kind: 'media',
  id: 101,
  name: '网易网',
  price: '88.00',
  status: 2,
};

const SEED_WE_MEDIA_RESOURCE: UpstreamResource = {
  kind: 'we-media',
  id: 202,
  name: '百家号-科技',
  price: '50.00',
  status: 2,
};

async function adminTopUp(tb: TestBackend, accountId: string, points: number): Promise<void> {
  const login = await postJson(tb.app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
  const adjust = await postJson(
    tb.app,
    '/admin/ledger/adjust',
    { accountId, delta: points, note: '测试充值' },
    String((login.body as { adminToken: string }).adminToken),
  );
  if (adjust.status !== 200) throw new Error(`topup failed: ${JSON.stringify(adjust.body)}`);
}

async function placeOrder(
  tb: TestBackend,
  token: string,
  input: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson(tb.app, '/gw/distribution/media/order', input, token);
}

async function queryOrders(tb: TestBackend, token: string, sns: string[]) {
  const query = sns.map(sn => `sn=${encodeURIComponent(sn)}`).join('&');
  const response = await tb.app.request(`/gw/distribution/media/order/query?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function orderRow(tb: TestBackend, sn: string) {
  return tb.db.get<{
    ledger_status: string;
    placement_status: string;
    points: number;
    media_price_cents: number;
    partner_sn: string | null;
    upstream_status: number | null;
    closed_observed_at: string | null;
    url: string | null;
  }>('SELECT * FROM publish_orders WHERE sn = ?', [sn]);
}

function ledgerEntries(tb: TestBackend, accountId: string) {
  return tb.db.all<{ delta: number; kind: string; note: string }>(
    'SELECT delta, kind, note FROM ledger_entries WHERE account_id = ? ORDER BY seq',
    [accountId],
  );
}

async function balanceOf(tb: TestBackend, token: string) {
  const response = await tb.app.request('/billing/balance', {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { balance: { total: number; frozen: number; available: number } };
  return body.balance;
}

/** 事件回调正文（黄金向量：展平串按官方 PHP 算法手写，签名独立计算）。 */
function signedCallbackBody(input: {
  event: 1 | 2;
  payload: Record<string, string | number>;
  timestamp: number;
  signatureOverride?: string;
}): string {
  const params: Record<string, unknown> = {
    appid: TEST_DISTRIBUTION_APP_ID,
    timestamp: input.timestamp,
    algorithm: 'sha256',
    event: input.event,
    payload: input.payload,
  };
  // 展平串（键升序：algorithm, appid, event, payload, timestamp；payload 内
  // 键升序）：手写字面量，独立于实现。
  const payloadFlat = Object.keys(input.payload)
    .sort()
    .map(key => `${key}=${input.payload[key]}`)
    .join('');
  const flattened =
    `algorithm=sha256` +
    `appid=${TEST_DISTRIBUTION_APP_ID}` +
    `event=${input.event}` +
    `payload=${payloadFlat}` +
    `timestamp=${input.timestamp}`;
  const signature = input.signatureOverride ?? createHmac('sha256', TEST_DISTRIBUTION_SECRET).update(flattened).digest('hex');
  return JSON.stringify({ ...params, signature });
}

async function postCallback(tb: TestBackend, body: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await tb.app.request('/callbacks/distribution', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const ORDER_INPUT = {
  sn: 'xj-order-0001-a1b2c3d4e5f6',
  resourceId: SEED_RESOURCE.id,
  title: '测试品牌知识服务怎么选',
  contentUrl: 'https://cdn.example.test/geo/a.html',
};

describe('publish ordering: state machine, ledger and callbacks (ticket 08)', () => {
  let tb: TestBackend;
  let upstream: ReturnType<typeof supermediaMock>;
  let accessToken: string;
  let accountId: string;

  beforeEach(async () => {
    upstream = supermediaMock({ resources: [SEED_RESOURCE, SEED_WE_MEDIA_RESOURCE] });
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const provisioned = await provisionLoggedInAccount(tb.app);
    accessToken = provisioned.accessToken;
    accountId = provisioned.accountId;
    await adminTopUp(tb, accountId, 2000); // 500 赠 + 2000 = 2500
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('walks 待处理 → 发布中 → 已发布 with freeze → settle and a correct ledger', async () => {
    const placed = await placeOrder(tb, accessToken, ORDER_INPUT);
    expect(placed.status).toBe(201);
    const order = (placed.body as { order: Record<string, unknown> }).order;
    // 定价：¥88.00 × 1.6 × 10 → ceil(8800×4/25) = 1408 点，冻结不动流水。
    expect(order).toMatchObject({
      sn: ORDER_INPUT.sn,
      points: 1408,
      placementStatus: 'placed',
      ledgerStatus: 'frozen',
      mediaPriceCents: 8800,
    });
    expect(order.partnerSn).toMatch(/^\d{26}$/);
    expect(order.partnerSn).toBe(upstream.orders.get(ORDER_INPUT.sn)!.partnerSn);
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 1408, available: 1092 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume')).toHaveLength(0);

    // 待处理(1)：保持冻结。
    upstream.setStatus(ORDER_INPUT.sn, 1);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)!.ledger_status).toBe('frozen');
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 1408 });

    // 发布中(3)：结转（consume 负流水），冻结归零。
    upstream.setStatus(ORDER_INPUT.sn, 3);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)).toMatchObject({ ledger_status: 'settled', upstream_status: 3 });
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 1092, frozen: 0, available: 1092 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume')).toEqual([
      { delta: -1408, kind: 'consume', note: `publish_order ${ORDER_INPUT.sn}` },
    ]);

    // 已发布(4)：终态成功，重复查询幂等，不二次结转。
    upstream.setStatus(ORDER_INPUT.sn, 4, { url: 'https://news.example.com/a', publishedAt: '2026-08-19T08:00:00Z' });
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)).toMatchObject({
      ledger_status: 'settled',
      url: 'https://news.example.com/a',
    });
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 1092 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume')).toHaveLength(1);

    // 上游签名 wire：下单请求带全部业务参数 + 公共参数 + 签名，账号 token 不外发。
    const placeCall = upstream.calls.find(call => call.method === 'POST' && call.path === '/media/order')!;
    expect(placeCall.params.get('sn')).toBe(ORDER_INPUT.sn);
    expect(placeCall.params.get('resource_id')).toBe('101');
    expect(placeCall.params.get('title')).toBe(ORDER_INPUT.title);
    expect(placeCall.params.get('content')).toBe(ORDER_INPUT.contentUrl);
    expect(placeCall.params.get('appid')).toBe(TEST_DISTRIBUTION_APP_ID);
    expect(placeCall.params.get('timestamp')).toBe(String(FIXED_TIMESTAMP_SECONDS));
    expect(placeCall.params.get('signature')).toMatch(/^[0-9a-f]{64}$/);
    const queryCall = upstream.calls.find(call => call.path === '/media/order/query')!;
    expect(queryCall.method).toBe('GET');
    expect(queryCall.params.getAll('sn[]')).toEqual([ORDER_INPUT.sn]);
  });

  it('refunds frozen points verbatim on 已拒稿 / 已取消 / 已退款 and keeps 退款中 frozen', async () => {
    // 已拒稿(2)：冻结释放，无 consume/refund 流水。
    await placeOrder(tb, accessToken, ORDER_INPUT);
    upstream.setStatus(ORDER_INPUT.sn, 2);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)!.ledger_status).toBe('refunded');
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 0, available: 2500 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind !== 'grant' && entry.kind !== 'adjust')).toHaveLength(0);

    // 已取消(5)：经网关取消代理 → 状态由查单对账回补。
    const cancelled = { ...ORDER_INPUT, sn: 'xj-order-0002-cancel-000111' };
    await placeOrder(tb, accessToken, cancelled);
    const cancelRes = await postJson(
      tb.app,
      '/gw/distribution/media/order/cancel',
      { sn: cancelled.sn, reason: '排期变更' },
      accessToken,
    );
    expect(cancelRes.status).toBe(200);
    expect(upstream.orders.get(cancelled.sn)!.status).toBe(5);
    await queryOrders(tb, accessToken, [cancelled.sn]);
    expect(orderRow(tb, cancelled.sn)!.ledger_status).toBe('refunded');
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 0, available: 2500 });

    // 退款中(6)保持冻结；已退款(7)释放。
    const refundCase = { ...ORDER_INPUT, sn: 'xj-order-0003-refund-0022' };
    await placeOrder(tb, accessToken, refundCase);
    upstream.setStatus(refundCase.sn, 3);
    await queryOrders(tb, accessToken, [refundCase.sn]); // 结转
    const refundReq = await postJson(
      tb.app,
      '/gw/distribution/media/order/apply-refund',
      { sn: refundCase.sn, reason: '内容需要修改' },
      accessToken,
    );
    expect(refundReq.status).toBe(200);
    expect(upstream.orders.get(refundCase.sn)!.status).toBe(6);
    await queryOrders(tb, accessToken, [refundCase.sn]);
    expect(orderRow(tb, refundCase.sn)!.ledger_status).toBe('settled'); // 退款中不改变已结转事实
    // 结转后已退款(7)：refund 正流水原路回补，Σdelta==balance。
    upstream.setStatus(refundCase.sn, 7);
    await queryOrders(tb, accessToken, [refundCase.sn]);
    expect(orderRow(tb, refundCase.sn)!.ledger_status).toBe('refunded');
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 0, available: 2500 });
    const entries = ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume' || entry.kind === 'refund');
    expect(entries).toEqual([
      { delta: -1408, kind: 'consume', note: `publish_order ${refundCase.sn}` },
      { delta: 1408, kind: 'refund', note: `publish_order ${refundCase.sn} refund` },
    ]);
  });

  it('keeps 冻结中订单 frozen through 退款中 then releases on 已退款', async () => {
    // 未进入发布中即申请退款：1 → 6（保持冻结）→ 7（释放）。
    await placeOrder(tb, accessToken, ORDER_INPUT);
    upstream.setStatus(ORDER_INPUT.sn, 6);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)).toMatchObject({ ledger_status: 'frozen', upstream_status: 6 });
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 1408, available: 1092 });

    upstream.setStatus(ORDER_INPUT.sn, 7);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)!.ledger_status).toBe('refunded');
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 0, available: 2500 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume' || entry.kind === 'refund')).toHaveLength(0);
  });

  it('replays the same sn idempotently without a second order or a second freeze', async () => {
    const first = await placeOrder(tb, accessToken, ORDER_INPUT);
    expect(first.status).toBe(201);
    expect((first.body as { created: boolean }).created).toBe(true);

    const replay = await placeOrder(tb, accessToken, ORDER_INPUT);
    expect(replay.status).toBe(200);
    expect((replay.body as { created: boolean }).created).toBe(false);
    expect((replay.body as { order: { partnerSn: string } }).order.partnerSn).toBe(
      (first.body as { order: { partnerSn: string } }).order.partnerSn,
    );
    // 上游只收到一次下单；冻结不叠加。
    expect(upstream.calls.filter(call => call.method === 'POST' && call.path === '/media/order')).toHaveLength(1);
    expect(await balanceOf(tb, accessToken)).toMatchObject({ frozen: 1408, available: 1092 });

    // 同 sn 换参数：客户端 bug，拒绝。
    const conflict = await placeOrder(tb, accessToken, { ...ORDER_INPUT, title: '换个标题' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: 'sn_conflict' });
  });

  it('rejects callbacks with bad signatures or stale timestamps without touching state', async () => {
    await placeOrder(tb, accessToken, ORDER_INPUT);
    upstream.setStatus(ORDER_INPUT.sn, 3);

    const badSignature = await postCallback(
      tb,
      signedCallbackBody({
        event: 2,
        payload: { type: 1, sn: ORDER_INPUT.sn },
        timestamp: FIXED_TIMESTAMP_SECONDS,
        signatureOverride: '0'.repeat(64),
      }),
    );
    expect(badSignature.status).toBe(401);
    expect(badSignature.body).toMatchObject({ error: 'callback_bad_signature' });

    const stale = await postCallback(
      tb,
      signedCallbackBody({
        event: 2,
        payload: { type: 1, sn: ORDER_INPUT.sn },
        timestamp: FIXED_TIMESTAMP_SECONDS - 301,
      }),
    );
    expect(stale.status).toBe(401);
    expect(stale.body).toMatchObject({ error: 'callback_stale_timestamp' });

    // 验签被拒：状态机零动作（查单对账也没发生 → 上游无查单调用）。
    expect(orderRow(tb, ORDER_INPUT.sn)!.ledger_status).toBe('frozen');
    expect(upstream.calls.filter(call => call.path === '/media/order/query')).toHaveLength(0);
  });

  it('drives order state and resource cache refresh from verified callbacks', async () => {
    await placeOrder(tb, accessToken, ORDER_INPUT);
    upstream.setStatus(ORDER_INPUT.sn, 3);

    const orderEvent = await postCallback(
      tb,
      signedCallbackBody({
        event: 2,
        payload: { type: 1, sn: ORDER_INPUT.sn },
        timestamp: FIXED_TIMESTAMP_SECONDS,
      }),
    );
    expect(orderEvent.status).toBe(200);
    expect(orderEvent.body).toMatchObject({ ok: true, event: 'order', applied: true });
    // 回调回源查单并驱动结转。
    expect(orderRow(tb, ORDER_INPUT.sn)).toMatchObject({ ledger_status: 'settled', upstream_status: 3 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume')).toHaveLength(1);

    // 未知 sn 的订单回调：确认收到但不动作。
    const unknown = await postCallback(
      tb,
      signedCallbackBody({
        event: 2,
        payload: { type: 1, sn: 'xj-order-unknown-99999999' },
        timestamp: FIXED_TIMESTAMP_SECONDS,
      }),
    );
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ applied: false });

    // 资源变更回调：价格 88 → 100，快照缓存刷新，下一单按新价预扣。
    upstream.setPrice('media', SEED_RESOURCE.id, '100.00');
    const resourceEvent = await postCallback(
      tb,
      signedCallbackBody({
        event: 1,
        payload: { type: 1, id: SEED_RESOURCE.id },
        timestamp: FIXED_TIMESTAMP_SECONDS,
      }),
    );
    expect(resourceEvent.status).toBe(200);
    expect(resourceEvent.body).toMatchObject({ ok: true, event: 'resource', refreshed: true });

    // 服务器侧缓存现价 100.00：第二单预扣 ceil(10000×4/25) = 1600 点
    //（首单已结转，充值补足可用余额）。
    await adminTopUp(tb, accountId, 2000);
    const second = await placeOrder(tb, accessToken, { ...ORDER_INPUT, sn: 'xj-order-0009-newprice33' });
    expect(second.status).toBe(201);
    expect((second.body as { order: { points: number } }).order.points).toBe(1600);
  });

  it('keeps 已关闭 frozen and stamps an observation marker', async () => {
    await placeOrder(tb, accessToken, ORDER_INPUT);
    upstream.setStatus(ORDER_INPUT.sn, 9);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    const row = orderRow(tb, ORDER_INPUT.sn)!;
    expect(row.ledger_status).toBe('frozen');
    expect(row.closed_observed_at).not.toBeNull();
    expect(await balanceOf(tb, accessToken)).toMatchObject({ frozen: 1408, available: 1092 });
    expect(ledgerEntries(tb, accountId).filter(entry => entry.kind === 'consume' || entry.kind === 'refund')).toHaveLength(0);
    // 重复观察幂等：标记时间不变。
    const firstObserved = row.closed_observed_at;
    tb.setNow(FIXED_MS + 60_000);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(orderRow(tb, ORDER_INPUT.sn)!.closed_observed_at).toBe(firstObserved);
  });

  it('prices from the server-side snapshot, rejects insufficient balance before touching upstream', async () => {
    const poor = await provisionLoggedInAccount(tb.app, '13800000002', 'initial-pass-2');
    const response = await placeOrder(tb, poor.accessToken, { ...ORDER_INPUT, sn: 'xj-order-0010-poor-4444' });
    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({
      error: 'insufficient_balance',
      required: 1408,
      available: 500,
    });
    expect(upstream.calls.filter(call => call.path === '/media/order')).toHaveLength(0);
    expect(orderRow(tb, 'xj-order-0010-poor-4444')).toBeUndefined();
  });

  it('releases the freeze when upstream truly rejects, and reconciles lost responses', async () => {
    // 真失败：上游不落单 → 释放冻结（failed 可重试），错误清洗回传。
    upstream.controls.nextPlaceMode = 'reject';
    const rejected = await placeOrder(tb, accessToken, ORDER_INPUT);
    expect(rejected.status).toBe(500);
    expect(JSON.stringify(rejected.body)).not.toContain(TEST_DISTRIBUTION_SECRET);
    expect(JSON.stringify(rejected.body)).not.toContain(accessToken);
    const failedRow = orderRow(tb, ORDER_INPUT.sn)!;
    expect(failedRow).toMatchObject({ placement_status: 'failed', ledger_status: 'refunded' });
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 0, available: 2500 });

    // 同 sn 重试（failed → 重新冻结 → 上游落单成功）。
    const retried = await placeOrder(tb, accessToken, ORDER_INPUT);
    expect(retried.status).toBe(200);
    expect((retried.body as { order: Record<string, unknown> }).order).toMatchObject({
      placementStatus: 'placed',
      ledgerStatus: 'frozen',
    });
    expect(upstream.orders.has(ORDER_INPUT.sn)).toBe(true);
    expect(await balanceOf(tb, accessToken)).toMatchObject({ frozen: 1408 });

    // 响应丢失：上游已落单但回 500 → 对账查单兜底，订单 placed、冻结保留
    //（首单在冻结中，充值补足可用余额）。
    await adminTopUp(tb, accountId, 2000);
    const lost = { ...ORDER_INPUT, sn: 'xj-order-0011-lost-5555' };
    upstream.controls.nextPlaceMode = 'lose';
    const lostResponse = await placeOrder(tb, accessToken, lost);
    expect(lostResponse.status).toBe(201);
    expect((lostResponse.body as { order: Record<string, unknown> }).order).toMatchObject({
      placementStatus: 'placed',
      ledgerStatus: 'frozen',
    });
    expect(upstream.orders.has(lost.sn)).toBe(true);
    expect(await balanceOf(tb, accessToken)).toMatchObject({ frozen: 1408 + 1408 });
  });

  it('guards order access by account and kind, and enforces we-media required fields', async () => {
    await placeOrder(tb, accessToken, ORDER_INPUT);
    const stranger = await provisionLoggedInAccount(tb.app, '13800000003', 'initial-pass-3');

    // 他人 sn 查单：404，不泄露。
    const probe = await queryOrders(tb, stranger.accessToken, [ORDER_INPUT.sn]);
    expect(probe.status).toBe(404);
    expect(probe.body).toMatchObject({ error: 'order_not_found' });
    // 他人 sn 取消：404，上游零调用。
    const cancelProbe = await postJson(
      tb.app,
      '/gw/distribution/media/order/cancel',
      { sn: ORDER_INPUT.sn, reason: 'x' },
      stranger.accessToken,
    );
    expect(cancelProbe.status).toBe(404);
    expect(upstream.calls.filter(call => call.path === '/media/order/cancel')).toHaveLength(0);

    // 自媒体下单缺三元组：400；补齐后走 we-media 路径下单成功。
    const weMedia = {
      sn: 'xj-order-0012-wemedia-666',
      resourceId: SEED_WE_MEDIA_RESOURCE.id,
      title: '自媒体稿件',
      contentUrl: 'https://cdn.example.test/geo/w.html',
    };
    const missing = await postJson(tb.app, '/gw/distribution/we-media/order', weMedia, accessToken);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: 'validation_error' });
    const placed = await postJson(tb.app, '/gw/distribution/we-media/order', {
      ...weMedia,
      publishForm: 1,
      publishType: 1,
      accountRule: 2,
    }, accessToken);
    expect(placed.status).toBe(201);
    const weMediaCall = upstream.calls.find(call => call.path === '/we-media/order')!;
    expect(weMediaCall.params.get('publish_form')).toBe('1');
    expect(weMediaCall.params.get('publish_type')).toBe('1');
    expect(weMediaCall.params.get('account_rule')).toBe('2');

    // 申请补发仅新闻媒体：we-media 400，media 200。
    const republishWe = await postJson(
      tb.app,
      '/gw/distribution/we-media/order/apply-republish',
      { sn: weMedia.sn },
      accessToken,
    );
    expect(republishWe.status).toBe(400);
    expect(republishWe.body).toMatchObject({ error: 'action_not_supported' });
    const republish = await postJson(
      tb.app,
      '/gw/distribution/media/order/apply-republish',
      { sn: ORDER_INPUT.sn },
      accessToken,
    );
    expect(republish.status).toBe(200);
    // 催稿代理：上游收到 sn。
    const urge = await postJson(tb.app, '/gw/distribution/media/order/urge', { sn: ORDER_INPUT.sn }, accessToken);
    expect(urge.status).toBe(200);
    expect(upstream.calls.find(call => call.path === '/media/order/urge')!.params.get('sn')).toBe(ORDER_INPUT.sn);
  });

  it('counts order freezes inside the account frozen balance invariant', async () => {
    // 冻结中的订单与 open permit 同时计入 frozen：total = available + frozen。
    const permit = await postJson(tb.app, '/billing/permits', {
      permitId: 'permit-order-0001',
      operation: 'question_pool',
      units: 1,
    }, accessToken);
    expect(permit.status).toBe(201);
    await placeOrder(tb, accessToken, ORDER_INPUT);
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500, frozen: 1408 + 15, available: 2500 - 1408 - 15 });
    // 结转后订单冻结退出，permit 冻结仍在。
    upstream.setStatus(ORDER_INPUT.sn, 3);
    await queryOrders(tb, accessToken, [ORDER_INPUT.sn]);
    expect(await balanceOf(tb, accessToken)).toMatchObject({ total: 2500 - 1408, frozen: 15 });
  });
});
