import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 票 08 验收集成（确定性发布测试模式）：Sidecar distribution typed port +
// 真实运营后端 Hono app（进程内 app.request，不起端口、不触公网）+ mock
// 超级媒介上游（内存状态机）。覆盖：网关下单预扣、查单驱动状态机
// （结转/退点/保持冻结）、sn 幂等重放不重复下单不重复扣点、取消/催稿/
// 申请退款/申请补发经网关代理。全部确定性，不触真实媒介。
import {
  postJson,
  provisionLoggedInAccount,
  startTestBackend,
  TEST_ADMIN_PASSWORD,
  type TestBackend,
} from "../../../backend/tests/helpers";
import { createGeoProviderCapabilities } from "./provider-capabilities";
import { distributionOrderSn } from "./provider-capabilities";

const GATEWAY_BASE = "https://gw.example.test";

interface UpstreamOrderState {
  kind: "media" | "we-media";
  sn: string;
  status: number;
}

/** mock 超级媒介：与 backend/tests/publish-orders.test.ts 同款最小状态机。 */
function supermediaMock() {
  const orders = new Map<string, UpstreamOrderState>();
  const calls: Array<{ method: string; path: string; params: URLSearchParams }> = [];
  const respond = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "");
    const params = url.searchParams;
    calls.push({ method: request.method, path, params });
    const kind: "media" | "we-media" = path.startsWith("/we-media")
      ? "we-media"
      : "media";
    const envelope = (data: unknown, code = 200) =>
      new Response(JSON.stringify({ code, message: "ok", data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (request.method === "POST" && path === `/${kind}/order`) {
      const sn = params.get("sn") ?? "";
      if (!orders.has(sn)) {
        orders.set(sn, { kind, sn, status: 1 });
      }
      return envelope({ partner_sn: "9".repeat(25) + String(orders.size) });
    }
    if (request.method === "GET" && path === `/${kind}/order/query`) {
      const items = params
        .getAll("sn[]")
        .map((sn) => orders.get(sn))
        .filter((order): order is UpstreamOrderState => order !== undefined)
        .map((order) => ({
          sn: order.sn,
          url: order.status === 4 ? "https://news.example.com/a" : null,
          screenshot: null,
          published_at: order.status === 4 ? "2026-08-19T08:00:00Z" : null,
          status: order.status,
          feedback: null,
        }));
      return envelope(items);
    }
    if (request.method === "POST" && path === `/${kind}/order/cancel`) {
      const order = orders.get(params.get("sn") ?? "");
      if (order && order.status === 1) order.status = 5;
      return envelope(true);
    }
    if (request.method === "POST" && path.startsWith(`/${kind}/order/`)) {
      return envelope(true);
    }
    if (request.method === "GET" && path === `/${kind}/resource/query`) {
      const ids = params.getAll("id[]").map((id) => Number.parseInt(id, 10));
      return envelope(
        ids.map((id) => ({
          id,
          name: "网易网",
          price: id === 101 ? "88.00" : "50.00",
          status: 2,
        })),
      );
    }
    return new Response(JSON.stringify({ code: 404, message: "not found" }), {
      status: 404,
    });
  };
  return { fetch: respond as typeof fetch, orders, calls };
}

/** 路由 fetch：网关流量 → 后端 app.request；其余 → mock 上游。 */
function gatewayFetch(app: TestBackend["app"], upstream: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
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
  return { fetchImpl };
}

describe("ticket 08: distribution order port against the real backend (deterministic publishing pattern)", () => {
  let tb: TestBackend;
  let accessToken: string;
  let accountId: string;
  let upstream: ReturnType<typeof supermediaMock>;
  let routing: ReturnType<typeof gatewayFetch>;

  beforeEach(async () => {
    upstream = supermediaMock();
    tb = await startTestBackend({
      fetch: upstream.fetch as unknown as typeof globalThis.fetch,
    });
    const provisioned = await provisionLoggedInAccount(tb.app);
    accessToken = provisioned.accessToken;
    accountId = provisioned.accountId;
    // 赠 500 + 2000：¥88 渠道单 1408 点可冻结。
    const login = await postJson(tb.app, "/admin/login", {
      password: TEST_ADMIN_PASSWORD,
    });
    await postJson(
      tb.app,
      "/admin/ledger/adjust",
      { accountId, delta: 2000, note: "测试充值" },
      String((login.body as { adminToken: string }).adminToken),
    );
    routing = gatewayFetch(tb.app, upstream.fetch);
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  const capabilities = () =>
    createGeoProviderCapabilities(
      { gatewayBaseUrl: GATEWAY_BASE, accountAccessToken: accessToken },
      { fetch: routing.fetchImpl },
    );

  const frozenLimits = (executionId: string, itemId: string) => ({
    executionId,
    itemId,
    perArticleMaxPoints: 3_000,
    executionMaxPoints: 20_000,
  });

  async function balance(): Promise<{ total: number; frozen: number; available: number }> {
    const response = await tb.app.request("/billing/balance", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json()) as {
      balance: { total: number; frozen: number; available: number };
    };
    return body.balance;
  }

  function consumeEntries(): Array<{ delta: number; kind: string; note: string }> {
    return tb.db.all(
      "SELECT delta, kind, note FROM ledger_entries WHERE account_id = ? AND kind IN ('consume', 'refund') ORDER BY seq",
      [accountId],
    );
  }

  it("places an order via the gateway port, freezes points, and settles through 发布中", async () => {
    const sn = distributionOrderSn("execution-1", "item-1");
    const placed = await capabilities().distribution.placeOrder("media", {
      sn,
      ...frozenLimits("execution-1", "item-1"),
      resourceId: 101,
      title: "测试品牌知识服务怎么选",
      contentUrl: "https://cdn.example.test/geo/a.html",
    });
    // 服务器定价：¥88.00 × 1.6 × 10 → 1408 点，冻结中。
    expect(placed).toMatchObject({
      sn,
      points: 1408,
      ledgerStatus: "frozen",
    });
    expect(placed.partnerSn).toMatch(/^\d{26}$/);
    expect(await balance()).toMatchObject({ total: 2500, frozen: 1408, available: 1092 });

    // 待处理：保持冻结。
    let statuses = await capabilities().distribution.queryOrders("media", [sn]);
    expect(statuses).toMatchObject([{ sn, status: 1 }]);
    expect(await balance()).toMatchObject({ frozen: 1408 });

    // 发布中 → 结转（consume 流水）；已发布 → 终态、发布链接回传。
    upstream.orders.get(sn)!.status = 3;
    statuses = await capabilities().distribution.queryOrders("media", [sn]);
    expect(statuses[0]).toMatchObject({ sn, status: 3 });
    expect(await balance()).toMatchObject({ total: 1092, frozen: 0 });
    expect(consumeEntries()).toEqual([
      { delta: -1408, kind: "consume", note: `publish_order ${sn}` },
    ]);

    upstream.orders.get(sn)!.status = 4;
    statuses = await capabilities().distribution.queryOrders("media", [sn]);
    expect(statuses[0]).toMatchObject({
      status: 4,
      url: "https://news.example.com/a",
      publishedAt: "2026-08-19T08:00:00Z",
    });
    expect(consumeEntries()).toHaveLength(1);
  });

  it("replays the same sn without a second upstream order or a second freeze", async () => {
    const sn = distributionOrderSn("execution-2", "item-1");
    const distribution = capabilities().distribution;
    const first = await distribution.placeOrder("media", {
      sn,
      ...frozenLimits("execution-2", "item-1"),
      resourceId: 101,
      title: "标题",
      contentUrl: "https://cdn.example.test/geo/a.html",
    });
    const replay = await distribution.placeOrder("media", {
      sn,
      ...frozenLimits("execution-2", "item-1"),
      resourceId: 101,
      title: "标题",
      contentUrl: "https://cdn.example.test/geo/a.html",
    });
    expect(replay.partnerSn).toBe(first.partnerSn);
    expect(replay.points).toBe(1408);
    // 上游只收到一次下单；冻结不叠加。
    const placeCalls = upstream.calls.filter(
      (call) => call.method === "POST" && call.path === "/media/order",
    );
    expect(placeCalls).toHaveLength(1);
    expect(await balance()).toMatchObject({ frozen: 1408, available: 1092 });
  });

  it("refunds frozen points on 已拒稿 and settled points on 已退款 via the gateway", async () => {
    const distribution = capabilities().distribution;
    const rejectedSn = distributionOrderSn("execution-3", "item-1");
    await distribution.placeOrder("media", {
      sn: rejectedSn,
      ...frozenLimits("execution-3", "item-1"),
      resourceId: 101,
      title: "标题A",
      contentUrl: "https://cdn.example.test/geo/a.html",
    });
    upstream.orders.get(rejectedSn)!.status = 2;
    await distribution.queryOrders("media", [rejectedSn]);
    expect(await balance()).toMatchObject({ total: 2500, frozen: 0, available: 2500 });

    // 结转后退款：consume + refund 成对流（同一充值周期内可用余额复原）。
    const refundedSn = distributionOrderSn("execution-3", "item-2");
    await distribution.placeOrder("media", {
      sn: refundedSn,
      ...frozenLimits("execution-3", "item-2"),
      resourceId: 101,
      title: "标题B",
      contentUrl: "https://cdn.example.test/geo/b.html",
    });
    upstream.orders.get(refundedSn)!.status = 3;
    await distribution.queryOrders("media", [refundedSn]);
    upstream.orders.get(refundedSn)!.status = 7;
    await distribution.queryOrders("media", [refundedSn]);
    expect(consumeEntries()).toEqual([
      { delta: -1408, kind: "consume", note: `publish_order ${refundedSn}` },
      { delta: 1408, kind: "refund", note: `publish_order ${refundedSn} refund` },
    ]);
    expect(await balance()).toMatchObject({ total: 2500, frozen: 0, available: 2500 });
  });

  it("proxies urge / cancel / apply-refund / apply-republish with owned sns", async () => {
    const distribution = capabilities().distribution;
    const sn = distributionOrderSn("execution-4", "item-1");
    await distribution.placeOrder("media", {
      sn,
      ...frozenLimits("execution-4", "item-1"),
      resourceId: 101,
      title: "标题",
      contentUrl: "https://cdn.example.test/geo/a.html",
    });
    await distribution.urgeOrder("media", sn);
    await distribution.cancelOrder("media", sn, "排期变更");
    expect(upstream.orders.get(sn)!.status).toBe(5);
    // 取消后的冻结释放由查单/回调驱动。
    await distribution.queryOrders("media", [sn]);
    expect(await balance()).toMatchObject({ total: 2500, frozen: 0, available: 2500 });
    expect(consumeEntries()).toHaveLength(0);

    const activeSn = distributionOrderSn("execution-4", "item-2");
    await distribution.placeOrder("media", {
      sn: activeSn,
      ...frozenLimits("execution-4", "item-2"),
      resourceId: 101,
      title: "标题2",
      contentUrl: "https://cdn.example.test/geo/c.html",
    });
    await expect(distribution.applyRefund("media", activeSn, "内容修改")).resolves.toBeUndefined();
    await expect(distribution.applyRepublish("media", activeSn)).resolves.toBeUndefined();
    const actionPaths = upstream.calls
      .filter((call) => call.method === "POST" && call.path.startsWith("/media/order/"))
      .map((call) => call.path);
    expect(actionPaths).toEqual([
      "/media/order/urge",
      "/media/order/cancel",
      "/media/order/apply-refund",
      "/media/order/apply-republish",
    ]);
  });
});
