import { describe, expect, it, vi } from "vitest";

import {
  captureGeoProviderRuntimeSecrets,
  createGeoProviderCapabilities,
  distributionOrderSn,
  GeoTransientUpstreamError,
  GeoUpstreamHttpError,
  isTransientGeoUpstreamFailure,
  sanitizeGeoProviderError,
  type GeoProviderRuntimeSecrets,
} from "./provider-capabilities";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("GEO typed provider capabilities", () => {
  it("captures and erases every Rust secret transport variable", () => {
    const env: NodeJS.ProcessEnv = {
      XIAOJING_ARK_API_KEY: "ark-secret",
      XIAOJING_DOUBAO_SEARCH_API_KEY: "doubao-search-secret",
      XIAOJING_ARK_EMBEDDING_API_KEY: "embedding-secret",
      XIAOJING_ARK_EMBEDDING_ENDPOINT_ID: "ep-test",
      XIAOJING_OSS_ACCESS_KEY_SECRET: "oss-secret",
      XIAOJING_DISTRIBUTION_SECRET: "distribution-secret",
      XIAOJING_ARK_PAYGO_BASE_URL: "https://gateway.example.test/api/v3",
      XIAOJING_DOUBAO_SEARCH_BASE_URL: "https://gateway.example.test/search",
    };
    expect(captureGeoProviderRuntimeSecrets(env)).toMatchObject({
      arkApiKey: "ark-secret",
      doubaoSearchApiKey: "doubao-search-secret",
      embeddingApiKey: "embedding-secret",
      embeddingEndpointId: "ep-test",
      ossAccessKeySecret: "oss-secret",
      distributionSecret: "distribution-secret",
      arkPaygoBaseUrl: "https://gateway.example.test/api/v3",
      doubaoSearchBaseUrl: "https://gateway.example.test/search",
    });
    expect(env).toEqual({});
  });

  it("leaves the account admission transport to its xiaojing-native-secret owner", () => {
    // 回归：账号 admission 双捕获曾产生模块加载顺序竞争——先求值者擦掉
    // env，后到者丢网关模式（材料抽取报「extraction 能力尚未配置」）。
    // 本函数必须既不读也不擦这两个传输名。
    const env: NodeJS.ProcessEnv = {
      XIAOJING_GATEWAY_BASE_URL: "https://gw.example.test",
      XIAOJING_ACCOUNT_ACCESS_TOKEN: "account-access-token-secret",
    };
    const secrets = captureGeoProviderRuntimeSecrets(env);
    expect(secrets.gatewayBaseUrl).toBeUndefined();
    expect(secrets.accountAccessToken).toBeUndefined();
    expect(env).toEqual({
      XIAOJING_GATEWAY_BASE_URL: "https://gw.example.test",
      XIAOJING_ACCOUNT_ACCESS_TOKEN: "account-access-token-secret",
    });
  });

  it("routes every billed provider wire route to the gateway with the account token (ticket 07)", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const gatewayFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(
            [...request.headers].map(([k, v]) => [k.toLowerCase(), v]),
          ),
          body: await request.text(),
        });
        const url = request.url;
        if (url.endsWith("/embeddings/multimodal"))
          return jsonResponse({
            data: { embedding: Array.from({ length: 2048 }, (_, i) => i) },
          });
        if (url.endsWith("/responses")) return jsonResponse({ output_text: "ok" });
        if (url.includes("/gw/oss/"))
          return jsonResponse({ url: "https://cdn.example.test/geo/a.html" });
        if (url.includes("/gw/distribution/media/resource"))
          return jsonResponse({
            code: 200,
            data: { total: 1, items: [{ id: 7, name: "渠道" }] },
          });
        if (url.includes("/search_api/web_search"))
          return jsonResponse({
            Result: {
              WebResults: [{ Title: "t", Url: "https://e.test/a", Summary: "s" }],
            },
          });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    );
    // 网关模式只依赖票 06 admission 注入的网关基地址 + 账号 token；Provider
    // 密钥一概缺省（Rust 账号 admission 已清洗旧传输名）。
    const capabilities = createGeoProviderCapabilities(
      {
        gatewayBaseUrl: "https://gw.example.test/",
        accountAccessToken: "account-token-1",
      },
      { fetch: gatewayFetch as typeof fetch },
    );

    expect(capabilities.keywordSearch.baselineEngines()).toMatchObject([
      { id: "doubao", available: true },
    ]);

    await capabilities.extraction.complete([{ role: "user", content: "e" }]);
    await capabilities.reflection.complete([{ role: "user", content: "r" }]);
    await capabilities.keywordSearch.search("search");
    await capabilities.generation.complete([{ role: "user", content: "g" }]);
    await capabilities.keywordSearch.probeQuestion("doubao", "问一句");
    await capabilities.embedding.embed(["one"]);
    await capabilities.keywordSearch.searchSources!("query");
    const uploaded = await capabilities.objectStorage.putHtml(
      "geo/a.html",
      "<html></html>",
    );
    const resources = await capabilities.distribution.listResources("media", 1, 20);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://gw.example.test/gw/deepseek/chat/completions",
      "POST https://gw.example.test/gw/deepseek/chat/completions",
      "POST https://gw.example.test/gw/ark/chat/completions",
      "POST https://gw.example.test/gw/ark/chat/completions",
      "POST https://gw.example.test/gw/ark/responses",
      "POST https://gw.example.test/gw/ark/embeddings/multimodal",
      "POST https://gw.example.test/gw/doubao-search/search_api/web_search",
      "PUT https://gw.example.test/gw/oss/geo/a.html",
      "GET https://gw.example.test/gw/distribution/media/resource?page=1&size=20",
    ]);
    // 鉴权一律账号 token；wire body 形状不变（embedding 在网关模式省略
    // model 字段，交由网关按服务器配置补齐）。
    for (const call of calls) {
      expect(call.headers.authorization).toBe("Bearer account-token-1");
    }
    const embeddingBody = JSON.parse(calls[5]!.body);
    expect(embeddingBody).toEqual({
      input: [{ type: "text", text: "one" }],
    });
    expect(calls[7]!.body).toBe("<html></html>");
    expect(calls[8]!.headers["content-type"]).toBeUndefined();
    expect(uploaded).toEqual({ url: "https://cdn.example.test/geo/a.html" });
    expect(resources).toEqual({
      total: 1,
      items: [{ id: 7, name: "渠道" }],
    });
    // 账号 token 不得出现在任何错误投影里（脱敏名单含 admission 传输名）。
    const sanitized = sanitizeGeoProviderError(
      new Error("upstream said Bearer account-token-1 failed"),
      {
        gatewayBaseUrl: "https://gw.example.test",
        accountAccessToken: "account-token-1",
      },
    );
    expect(sanitized.message).not.toContain("account-token-1");
  });

  it("pins extraction, generation, reflection and keyword-search wire routes", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      {
        deepseekApiKey: "deepseek-test",
        arkApiKey: "ark-test",
      },
      { fetch: fakeFetch as typeof fetch },
    );

    await capabilities.extraction.complete([
      { role: "user", content: "extract" },
    ]);
    await capabilities.generation.complete([
      { role: "user", content: "generate" },
    ]);
    await capabilities.generation.complete(
      [{ role: "user", content: "title plan" }],
      { purpose: "title-planning" },
    );
    await capabilities.reflection.complete([
      { role: "user", content: "review" },
    ]);
    await capabilities.keywordSearch.search("search");

    expect(calls.map(({ body }) => body.model)).toEqual([
      "deepseek-chat",
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-2-0-lite-260428",
      "deepseek-v4-pro",
      "doubao-seed-2-0-lite-260428",
    ]);
    expect(calls[4].url).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    );
    expect(calls[4].body.enable_search).toBe(true);
  });

  it("routes searchSources to the doubao search API and maps structured results", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
    const fakeFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          auth: (init?.headers as Record<string, string>)?.Authorization,
        });
        return jsonResponse({
          Result: {
            WebResults: [
              { Title: "新都医美排行", Url: "https://rank.example/1", Summary: "本地同行讨论" },
              { Url: "https://rank.example/1", Summary: "同 URL 重复条目" },
              { SiteName: "口碑站", Url: "https://word.example/2", Snippet: "哪家好" },
            ],
          },
        });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      // 解析链：专用豆包搜索 key 优先于 ARK key。
      { arkApiKey: "ark-test", doubaoSearchApiKey: "doubao-search-test" },
      { fetch: fakeFetch as typeof fetch },
    );

    const sources = await capabilities.keywordSearch.searchSources!(
      "成都新都 医美 排行榜",
      { count: 20 },
    );

    expect(calls[0].url).toBe(
      "https://open.feedcoopapi.com/search_api/web_search",
    );
    expect(calls[0].body).toEqual({
      Query: "成都新都 医美 排行榜",
      Count: 20,
      SearchType: "web",
      NeedSummary: true,
    });
    expect(calls[0].auth).toBe("Bearer doubao-search-test");
    expect(sources).toEqual([
      { title: "新都医美排行", url: "https://rank.example/1", summary: "本地同行讨论" },
      { title: "口碑站", url: "https://word.example/2", summary: "哪家好" },
    ]);
  });

  it("redirects every provider wire route to injected endpoint overrides without changing wire shapes", async () => {
    const urls: string[] = [];
    const okFetch = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        return jsonResponse(
          url.endsWith("/embeddings/multimodal")
            ? { data: { embedding: Array.from({ length: 2048 }, (_, i) => i) } }
            : url.endsWith("/responses")
              ? { output_text: "ok" }
              : { choices: [{ message: { content: "ok" } }] },
        );
      },
    );
    // 尾斜杠证明归一化；覆盖值来自 Rust admission 一次性注入传输。
    const capabilities = createGeoProviderCapabilities(
      {
        deepseekApiKey: "deepseek-test",
        arkApiKey: "ark-test",
        embeddingEndpointId: "ep-test",
        deepseekOpenAiBaseUrl: "https://gw.example.test/deepseek",
        arkPaygoBaseUrl: "https://gw.example.test/ark/",
        doubaoSearchBaseUrl: "https://gw.example.test/doubao-search",
      },
      { fetch: okFetch as typeof fetch },
    );

    await capabilities.extraction.complete([
      { role: "user", content: "extract" },
    ]);
    await capabilities.reflection.complete([
      { role: "user", content: "review" },
    ]);
    await capabilities.keywordSearch.search("search");
    await capabilities.generation.complete([
      { role: "user", content: "generate" },
    ]);
    await capabilities.keywordSearch.probeQuestion("doubao", "问一句");
    await capabilities.embedding.embed(["one"]);
    await capabilities.keywordSearch.searchSources!("query");

    expect(urls).toEqual([
      "https://gw.example.test/deepseek/chat/completions",
      "https://gw.example.test/deepseek/chat/completions",
      "https://gw.example.test/ark/chat/completions",
      "https://gw.example.test/ark/chat/completions",
      "https://gw.example.test/ark/responses",
      "https://gw.example.test/ark/embeddings/multimodal",
      "https://gw.example.test/doubao-search/search_api/web_search",
    ]);
  });

  it("exposes honest baseline availability and uses the real ARK doubao_app route", async () => {
    const fakeFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse({
          output_text: "鲸跃汽车值得考虑。",
          output: [],
        }),
    );
    const unavailable = createGeoProviderCapabilities({});
    expect(unavailable.keywordSearch.baselineEngines()).toMatchObject([
      { id: "doubao", available: false },
    ]);

    const capabilities = createGeoProviderCapabilities(
      {
        arkApiKey: "ark-test",
        arkConfigurationFingerprint: "config-fingerprint-1",
      },
      { fetch: fakeFetch as typeof fetch },
    );
    expect(capabilities.keywordSearch.baselineEngines()).toMatchObject([
      {
        id: "doubao",
        available: true,
        snapshot: {
          provider: "volcengine",
          endpointFamily: "ark-responses",
          searchMode: "doubao-app-ai-search",
          configurationFingerprint: "config-fingerprint-1",
        },
      },
    ]);
    expect(
      JSON.stringify(capabilities.keywordSearch.baselineEngines()),
    ).not.toContain("ark-test");

    const result = await capabilities.keywordSearch.probeQuestion(
      "doubao",
      "成都汽车音响改装哪家好？",
    );
    expect(result.rawEvidence).toMatchObject({
      output_text: "鲸跃汽车值得考虑。",
    });
    const [url, init] = fakeFetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/responses",
    );
    expect((init?.headers as Record<string, string>)["ark-beta-doubao-app"]).toBe(
      "true",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "doubao-seed-2-0-lite-260428",
      input: [{ role: "user", content: "成都汽车音响改装哪家好？" }],
      stream: false,
      tools: [
        {
          type: "doubao_app",
          feature: { ai_search: { type: "enabled" } },
        },
      ],
    });
  });

  it("uses one text per ARK embedding request, preserves order, and enforces 2048 dimensions", async () => {
    const seenTexts: string[] = [];
    const fakeFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          input: Array<{ text: string }>;
        };
        seenTexts.push(body.input[0].text);
        return jsonResponse({
          data: { embedding: Array.from({ length: 2048 }, (_, i) => i) },
        });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      {
        arkApiKey: "ark-test",
        embeddingEndpointId: "ep-test",
      },
      { fetch: fakeFetch as typeof fetch },
    );

    const vectors = await capabilities.embedding.embed([
      "first",
      "second",
      "third",
    ]);
    expect(seenTexts).toHaveLength(3);
    expect(vectors).toHaveLength(3);
    expect(vectors.every((vector) => vector.length === 2048)).toBe(true);
  });

  it("retries ARK embedding twice with the verified 500ms/1000ms backoff", async () => {
    let attempts = 0;
    const fakeFetch = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) return jsonResponse({}, 503);
      return jsonResponse({
        data: { embedding: Array.from({ length: 2048 }, () => 0) },
      });
    });
    const sleep = vi.fn(async () => undefined);
    const capabilities = createGeoProviderCapabilities(
      {
        arkApiKey: "ark-test",
        embeddingEndpointId: "ep-test",
      },
      { fetch: fakeFetch as typeof fetch, sleep },
    );

    await expect(
      capabilities.embedding.embed(["retry-me"]),
    ).resolves.toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it("signs an OSS v1 HTML PUT without placing a credential in the URL", async () => {
    const fakeFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response("", { status: 200 }),
    );
    const capabilities = createGeoProviderCapabilities(
      {
        ossAccessKeyId: "test-access-id",
        ossAccessKeySecret: "test-access-secret",
        ossBucket: "test-bucket",
        ossRegion: "oss-cn-beijing",
        ossPublicBaseUrl: "https://cdn.example.test",
      },
      {
        fetch: fakeFetch as typeof fetch,
        now: () => new Date("2026-08-15T00:00:00Z"),
      },
    );

    await expect(
      capabilities.objectStorage.putHtml("articles/one.html", "<h1>one</h1>"),
    ).resolves.toEqual({ url: "https://cdn.example.test/articles/one.html" });
    const [url, init] = fakeFetch.mock.calls[0];
    expect(String(url)).toBe(
      "https://test-bucket.oss-cn-beijing.aliyuncs.com/articles/one.html",
    );
    expect(String(url)).not.toContain("test-access");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>).Authorization).toMatch(
      /^OSS test-access-id:/,
    );
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("exposes the ticket-08 order surface on the distribution port and requires gateway mode", async () => {
    const capabilities = createGeoProviderCapabilities({});
    // 票 08：下单/查单/催稿/取消/申请退款/申请补发并入 distribution typed
    // port；直连模式（无账号 token，即无计费主体）全部拒绝。
    expect(Object.keys(capabilities.distribution).sort()).toEqual([
      "applyRefund",
      "applyRepublish",
      "cancelOrder",
      "listResources",
      "placeOrder",
      "queryOrders",
      "slot",
      "urgeOrder",
    ]);
    await expect(
      capabilities.distribution.placeOrder("media", {
        sn: "xj-order-0001-directmode1",
        resourceId: 1,
        title: "标题",
        contentUrl: "https://cdn.example.test/a.html",
      }),
    ).rejects.toThrow(/网关模式/);
    await expect(capabilities.distribution.queryOrders("media", ["sn-1"])).rejects.toThrow(
      /网关模式/,
    );

    // sn 幂等键：执行项确定性派生，重试同 sn，≤64 且落在安全字符集。
    const first = distributionOrderSn("exec-1", "item-1");
    expect(distributionOrderSn("exec-1", "item-1")).toBe(first);
    expect(distributionOrderSn("exec-1", "item-2")).not.toBe(first);
    expect(distributionOrderSn("exec-2", "item-1")).not.toBe(first);
    expect(first).toMatch(/^xj-[0-9a-f]{32}$/);
  });

  it("routes distribution order wire routes to the gateway with the account token (ticket 08)", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const gatewayFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(
            [...request.headers].map(([k, v]) => [k.toLowerCase(), v]),
          ),
          body: await request.text(),
        });
        const url = request.url;
        if (url.endsWith("/media/order") || url.endsWith("/we-media/order")) {
          return jsonResponse({
            order: {
              sn: "xj-order-0001-gw-aaaa1111",
              partnerSn: "99999999999999999999999999",
              points: 1408,
              ledgerStatus: "frozen",
            },
          });
        }
        if (url.includes("/order/query")) {
          return jsonResponse({
            code: 200,
            data: [
              {
                sn: "xj-order-0001-gw-aaaa1111",
                url: "https://news.example.com/a",
                screenshot: "<img src=x>",
                published_at: "2026-08-19T08:00:00Z",
                status: 4,
                feedback: null,
              },
            ],
          });
        }
        if (url.includes("/order/")) {
          return jsonResponse({ code: 200, message: "ok", data: true });
        }
        return jsonResponse({ code: 200, data: { total: 0, items: [] } });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      {
        gatewayBaseUrl: "https://gw.example.test",
        accountAccessToken: "account-token-1",
      },
      { fetch: gatewayFetch as typeof fetch },
    );

    const sn = "xj-order-0001-gw-aaaa1111";
    const placed = await capabilities.distribution.placeOrder("media", {
      sn,
      resourceId: 101,
      title: "测试标题",
      contentUrl: "https://cdn.example.test/geo/a.html",
      remark: "加急",
    });
    expect(placed).toEqual({
      sn,
      partnerSn: "99999999999999999999999999",
      points: 1408,
      ledgerStatus: "frozen",
    });
    // 自媒体下单携带三元组。
    await capabilities.distribution.placeOrder("we-media", {
      sn: "xj-order-0002-gw-bbbb2222",
      resourceId: 202,
      title: "自媒体",
      contentUrl: "https://cdn.example.test/geo/w.html",
      publishForm: 1,
      publishType: 1,
      accountRule: 2,
    });
    const statuses = await capabilities.distribution.queryOrders("media", [
      sn,
      "xj-order-0002-gw-bbbb2222",
    ]);
    expect(statuses).toEqual([
      {
        sn,
        status: 4,
        url: "https://news.example.com/a",
        screenshot: "<img src=x>",
        publishedAt: "2026-08-19T08:00:00Z",
        feedback: null,
      },
    ]);
    await capabilities.distribution.urgeOrder("media", sn);
    await capabilities.distribution.cancelOrder("media", sn, "排期变更");
    await capabilities.distribution.applyRefund("media", sn, "内容修改");
    await capabilities.distribution.applyRepublish("media", sn);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://gw.example.test/gw/distribution/media/order",
      "POST https://gw.example.test/gw/distribution/we-media/order",
      "GET https://gw.example.test/gw/distribution/media/order/query?sn=xj-order-0001-gw-aaaa1111&sn=xj-order-0002-gw-bbbb2222",
      "POST https://gw.example.test/gw/distribution/media/order/urge",
      "POST https://gw.example.test/gw/distribution/media/order/cancel",
      "POST https://gw.example.test/gw/distribution/media/order/apply-refund",
      "POST https://gw.example.test/gw/distribution/media/order/apply-republish",
    ]);
    for (const call of calls) {
      expect(call.headers.authorization).toBe("Bearer account-token-1");
    }
    expect(JSON.parse(calls[0]!.body)).toEqual({
      sn,
      resourceId: 101,
      title: "测试标题",
      contentUrl: "https://cdn.example.test/geo/a.html",
      remark: "加急",
    });
    expect(JSON.parse(calls[1]!.body)).toEqual({
      sn: "xj-order-0002-gw-bbbb2222",
      resourceId: 202,
      title: "自媒体",
      contentUrl: "https://cdn.example.test/geo/w.html",
      publishForm: 1,
      publishType: 1,
      accountRule: 2,
    });
    expect(JSON.parse(calls[3]!.body)).toEqual({ sn });
    expect(JSON.parse(calls[4]!.body)).toEqual({ sn, reason: "排期变更" });

    // 网关业务错误信封（code != 200）与坏投影按类型化错误终止。
    const badEnvelope = vi.fn(async () =>
      jsonResponse({ code: 401, message: "订单不存在" }),
    );
    const badCaps = createGeoProviderCapabilities(
      { gatewayBaseUrl: "https://gw.example.test", accountAccessToken: "t" },
      { fetch: badEnvelope as typeof fetch },
    );
    await expect(
      badCaps.distribution.queryOrders("media", [sn]),
    ).rejects.toThrow(/业务错误/);
  });

  it("redacts literal secrets, bearer values and key-shaped fragments from failures", () => {
    const secrets: GeoProviderRuntimeSecrets = { arkApiKey: "ark-live-secret" };
    const safe = sanitizeGeoProviderError(
      new Error(
        "Bearer ark-live-secret api_key=ark-live-secret signature=abcdef",
      ),
      secrets,
    );
    expect(safe.message).not.toContain("ark-live-secret");
    expect(safe.message).not.toContain("abcdef");
    expect(safe.message).toContain("[REDACTED]");
  });
});

describe("embedding 错误分类与透出", () => {
  const directSecrets: GeoProviderRuntimeSecrets = {
    arkApiKey: "ark-test",
    embeddingEndpointId: "ep-test",
  };
  const silentSleep = () => vi.fn(async (_ms: number) => {});
  const vector2048 = () => Array.from({ length: 2048 }, () => 0.5);

  it("网关模式 400 透出上游错误体、附配置指向且不重试（真实事故回归）", async () => {
    const sleep = silentSleep();
    const failFetch = vi.fn(async () =>
      jsonResponse(
        { error: { code: "InvalidParameter", message: "model 缺失" } },
        400,
      ),
    );
    const capabilities = createGeoProviderCapabilities(
      {
        gatewayBaseUrl: "https://gw.example.test",
        accountAccessToken: "account-token-1",
      },
      { fetch: failFetch as typeof fetch, sleep },
    );

    const failure = await capabilities.embedding.embed(["x"]).catch((e) => e);

    expect(failure).toBeInstanceOf(GeoUpstreamHttpError);
    expect(failure.status).toBe(400);
    expect(failure.errorCode).toBe("InvalidParameter");
    expect(failure.message).toContain("model 缺失");
    expect(failure.message).toContain("请检查 embedding 模型/端点配置");
    expect(isTransientGeoUpstreamFailure(failure)).toBe(false);
    // 配置类失败（4xx≠429）立即失败，不退避重试。
    expect(failFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("网关模式 503 + embedding_endpoint_not_configured 判配置类：不重试、透出 code", async () => {
    // 回归：网关缺 ARK_EMBEDDING_ENDPOINT_ID 时 requireEmbeddingModel 抛 503
    // （provider-proxy-routes），按状态启发式会被误判瞬时并静默降级；
    // 分类必须优先信封里的机器可读 errorCode。
    const sleep = silentSleep();
    const failFetch = vi.fn(async () =>
      jsonResponse(
        {
          error: "embedding_endpoint_not_configured",
          message:
            "embedding 服务暂不可用：服务器缺少 ARK_EMBEDDING_ENDPOINT_ID 配置",
        },
        503,
      ),
    );
    const capabilities = createGeoProviderCapabilities(
      {
        gatewayBaseUrl: "https://gw.example.test",
        accountAccessToken: "account-token-1",
      },
      { fetch: failFetch as typeof fetch, sleep },
    );

    const failure = await capabilities.embedding.embed(["x"]).catch((e) => e);

    expect(failure).toBeInstanceOf(GeoUpstreamHttpError);
    expect(failure.status).toBe(503);
    expect(failure.errorCode).toBe("embedding_endpoint_not_configured");
    expect(failure.message).toContain("ARK_EMBEDDING_ENDPOINT_ID");
    expect(isTransientGeoUpstreamFailure(failure)).toBe(false);
    expect(failFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("5xx 退避重试后可恢复；持续失败归类为瞬时", async () => {
    const sleep = silentSleep();
    let calls = 0;
    const flakyFetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("upstream boom", { status: 500 });
      return jsonResponse({ data: { embedding: vector2048() } });
    });
    const capabilities = createGeoProviderCapabilities(directSecrets, {
      fetch: flakyFetch as typeof fetch,
      sleep,
    });

    const vectors = await capabilities.embedding.embed(["x"]);

    expect(vectors).toEqual([vector2048()]);
    expect(calls).toBe(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000]);

    const down = vi.fn(async () => new Response("down", { status: 503 }));
    const downCaps = createGeoProviderCapabilities(directSecrets, {
      fetch: down as typeof fetch,
      sleep: silentSleep(),
    });
    const failure = await downCaps.embedding.embed(["x"]).catch((e) => e);
    expect(failure).toBeInstanceOf(GeoUpstreamHttpError);
    expect(failure.message).toContain("down");
    expect(isTransientGeoUpstreamFailure(failure)).toBe(true);
    expect(down).toHaveBeenCalledTimes(3); // 1 + embeddingMaxRetries
  });

  it("429 限流退避重试并归类为瞬时", async () => {
    const sleep = silentSleep();
    const limited = vi.fn(async () =>
      jsonResponse({ error: { message: "rate limited" } }, 429),
    );
    const capabilities = createGeoProviderCapabilities(directSecrets, {
      fetch: limited as typeof fetch,
      sleep,
    });

    const failure = await capabilities.embedding.embed(["x"]).catch((e) => e);

    expect(failure).toBeInstanceOf(GeoUpstreamHttpError);
    expect(failure.status).toBe(429);
    expect(isTransientGeoUpstreamFailure(failure)).toBe(true);
    expect(limited).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([500, 1000]);
  });

  it("网络错误包装为 GeoTransientUpstreamError 并退避重试", async () => {
    const sleep = silentSleep();
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const capabilities = createGeoProviderCapabilities(directSecrets, {
      fetch: down as typeof fetch,
      sleep,
    });

    const failure = await capabilities.embedding.embed(["x"]).catch((e) => e);

    expect(failure).toBeInstanceOf(GeoTransientUpstreamError);
    expect(failure.message).toContain("fetch failed");
    expect(isTransientGeoUpstreamFailure(failure)).toBe(true);
    expect(down).toHaveBeenCalledTimes(3);
  });

  it("透出的上游错误体先脱敏密钥", async () => {
    const failFetch = vi.fn(async () =>
      jsonResponse({ error: { message: "bad key ark-test leaked" } }, 400),
    );
    const capabilities = createGeoProviderCapabilities(directSecrets, {
      fetch: failFetch as typeof fetch,
      sleep: silentSleep(),
    });

    const failure = await capabilities.embedding.embed(["x"]).catch((e) => e);

    expect(failure.message).toContain("bad key [REDACTED] leaked");
    expect(failure.message).not.toContain("ark-test");
  });
});
