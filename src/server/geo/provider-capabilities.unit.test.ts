import { createHash, createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import storedImageContract from "../../shared/geo/storedImageContract.json";
import {
  captureGeoProviderRuntimeSecrets,
  createGeoProviderCapabilities,
  distributionOrderSn,
  GeoTransientUpstreamError,
  GeoUpstreamHttpError,
  isTransientGeoUpstreamFailure,
  sanitizeGeoProviderError,
  STORED_IMAGE_EXTENSION_BY_MEDIA_TYPE,
  type GeoProviderRuntimeSecrets,
} from "./provider-capabilities";

const TEST_ORDER_LIMITS = {
  executionId: "test-execution",
  itemId: "test-item",
  perArticleMaxPoints: 3_000,
  executionMaxPoints: 20_000,
} as const;

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

  it("sends image tagging through the lite model with an image_url block and thinking disabled first", async () => {
    const calls: Array<{
      url: string;
      body: Record<string, unknown>;
      auth?: string;
    }> = [];
    const fakeFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          auth: (init?.headers as Record<string, string>)?.Authorization,
        });
        return jsonResponse({
          choices: [
            { message: { content: '{"description":"展台实拍","category":"产品实拍"}' } },
          ],
        });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      { arkApiKey: "ark-test" },
      { fetch: fakeFetch as typeof fetch },
    );

    const bytes = new Uint8Array([1, 2, 3]);
    const content = await capabilities.keywordSearch.describeImage!({
      system: "你是打标引擎",
      prompt: "打标",
      bytes,
      mediaType: "image/png",
    });

    expect(content).toContain("产品实拍");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    );
    expect(calls[0].auth).toBe("Bearer ark-test");
    const body = calls[0].body as {
      model: string;
      messages: unknown;
      thinking?: { type: string };
      stream: boolean;
      max_tokens: number;
    };
    expect(body.model).toBe("doubao-seed-2-0-lite-260428");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.messages).toEqual([
      { role: "system", content: "你是打标引擎" },
      {
        role: "user",
        content: [
          { type: "text", text: "打标" },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
            },
          },
        ],
      },
    ]);
  });

  it("retries image tagging once without thinking when the upstream rejects the parameter", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fakeFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        call += 1;
        bodies.push(JSON.parse(String(init?.body)));
        if (call === 1) {
          return jsonResponse(
            { error: { message: "thinking parameter not supported" } },
            400,
          );
        }
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      { arkApiKey: "ark-test" },
      { fetch: fakeFetch as typeof fetch },
    );

    const content = await capabilities.keywordSearch.describeImage!({
      system: "s",
      prompt: "p",
      bytes: new Uint8Array([9]),
      mediaType: "image/jpeg",
    });

    expect(content).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].thinking).toEqual({ type: "disabled" });
    expect(bodies[1]).not.toHaveProperty("thinking");
  });

  it("does not retry image tagging on deterministic rejections or server failures", async () => {
    const statuses = [401, 503];
    let call = 0;
    const fakeFetch = vi.fn(async () => {
      const status = statuses[call] ?? 500;
      call += 1;
      return jsonResponse({ error: { message: "upstream says no" } }, status);
    });
    const capabilities = createGeoProviderCapabilities(
      { arkApiKey: "ark-test" },
      { fetch: fakeFetch as typeof fetch },
    );

    for (const _status of statuses) {
      await expect(
        capabilities.keywordSearch.describeImage!({
          system: "s",
          prompt: "p",
          bytes: new Uint8Array([9]),
          mediaType: "image/png",
        }),
      ).rejects.toThrow();
    }
    expect(call).toBe(2);
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

  // ── putImage（票 #15 / ADR-0008 D4）：sha256 内容寻址 images/ 层 + 公共读
  // ACL，网关与直连两路都在注入 fetch 上断言 URL/签名/ACL/Content-Type。
  const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const IMAGE_SHA256 = createHash("sha256").update(IMAGE_BYTES).digest("hex");

  it("puts images through the gateway route with the public-read ACL and account token", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body: Uint8Array;
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
          body: new Uint8Array(await request.arrayBuffer()),
        });
        return jsonResponse({
          url: `https://cdn.example.test/images/${IMAGE_SHA256}.jpg`,
        });
      },
    );
    const capabilities = createGeoProviderCapabilities(
      {
        gatewayBaseUrl: "https://gw.example.test/",
        accountAccessToken: "account-token-1",
      },
      { fetch: gatewayFetch as typeof fetch },
    );

    const receipt = await capabilities.objectStorage.putImage({
      bytes: IMAGE_BYTES,
      mediaType: "image/jpeg",
    });

    // 独立 images/ 层 + sha256 命名（jpeg 统一 .jpg 扩展名）。
    expect(receipt).toEqual({
      url: `https://cdn.example.test/images/${IMAGE_SHA256}.jpg`,
      objectKey: `images/${IMAGE_SHA256}.jpg`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe(
      `https://gw.example.test/gw/oss/images/${IMAGE_SHA256}.jpg`,
    );
    // 网关重签通道同 putHtml：账号 token Bearer + 二进制 body 原样透传。
    expect(calls[0]!.headers.authorization).toBe("Bearer account-token-1");
    expect(calls[0]!.headers["content-type"]).toBe("image/jpeg");
    // 公共读 ACL 头必须透传给网关并计入其重签（部署要求见票 #15）。
    expect(calls[0]!.headers["x-oss-object-acl"]).toBe("public-read");
    expect(calls[0]!.body).toEqual(IMAGE_BYTES);
  });

  it("signs a direct OSS v1 image PUT with the ACL header inside the string-to-sign", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          headers: init?.headers as Record<string, string>,
        });
        return new Response("", { status: 200 });
      },
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
        now: () => new Date("2026-08-31T00:00:00Z"),
      },
    );

    const first = await capabilities.objectStorage.putImage({
      bytes: IMAGE_BYTES,
      mediaType: "image/png",
    });
    // 同字节重传：内容寻址键幂等（去重 + URL 稳定，用户故事 #18）。
    const second = await capabilities.objectStorage.putImage({
      bytes: IMAGE_BYTES,
      mediaType: "image/png",
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      url: `https://cdn.example.test/images/${IMAGE_SHA256}.png`,
      objectKey: `images/${IMAGE_SHA256}.png`,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    const [url, init] = fakeFetch.mock.calls[0];
    expect(String(url)).toBe(
      `https://test-bucket.oss-cn-beijing.aliyuncs.com/images/${IMAGE_SHA256}.png`,
    );
    expect(String(url)).not.toContain("test-access");
    expect(init?.method).toBe("PUT");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["x-oss-object-acl"]).toBe("public-read");
    // 签名契约：ACL 头以 CanonicalizedOSSHeaders 形态进入 string-to-sign
    //（小写、插在 Date 与资源之间），缺了它 OSS 会拒绝或按私有写覆盖。
    const expectedStringToSign = [
      "PUT",
      "",
      "image/png",
      new Date("2026-08-31T00:00:00Z").toUTCString(),
      "x-oss-object-acl:public-read",
      `/test-bucket/images/${IMAGE_SHA256}.png`,
    ].join("\n");
    const expectedSignature = createHmac("sha1", "test-access-secret")
      .update(expectedStringToSign)
      .digest("base64");
    expect(headers.Authorization).toBe(
      `OSS test-access-id:${expectedSignature}`,
    );
  });

  it("rejects putImage media types outside the stored-image whitelist", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 200 }));
    const capabilities = createGeoProviderCapabilities(
      {
        ossAccessKeyId: "test-access-id",
        ossAccessKeySecret: "test-access-secret",
        ossBucket: "test-bucket",
      },
      { fetch: fakeFetch as typeof fetch },
    );

    await expect(
      capabilities.objectStorage.putImage({
        bytes: IMAGE_BYTES,
        // emf/wmf/tiff 等白名单外类型在出口即拒绝（ADR-0008 D4）。
        mediaType: "image/tiff" as never,
      }),
    ).rejects.toThrow(/不支持的图片类型/);
    expect(fakeFetch).not.toHaveBeenCalled();
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
        ...TEST_ORDER_LIMITS,
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
      ...TEST_ORDER_LIMITS,
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
      ...TEST_ORDER_LIMITS,
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
      ...TEST_ORDER_LIMITS,
      resourceId: 101,
      title: "测试标题",
      contentUrl: "https://cdn.example.test/geo/a.html",
      remark: "加急",
    });
    expect(JSON.parse(calls[1]!.body)).toEqual({
      sn: "xj-order-0002-gw-bbbb2222",
      ...TEST_ORDER_LIMITS,
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

  it("chat 补全路径对网络层错误自愈重试（文章生成 fetch failed 修复，2026-08-27）", async () => {
    // 首次网络层失败（undici TypeError: fetch failed），第二次成功——
    // openAiChat 内部退避重试自愈，不再整篇落 generation_failed。
    const sleep = silentSleep();
    let calls = 0;
    const flakyFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse({ choices: [{ message: { content: "正文" } }] });
    });
    const capabilities = createGeoProviderCapabilities(directSecrets, {
      fetch: flakyFetch as typeof fetch,
      sleep,
    });

    const content = await capabilities.generation.complete([
      { role: "user", content: "generate" },
    ]);

    expect(content).toBe("正文");
    expect(calls).toBe(2);
    // 持续网络失败：1 次原始 + 2 次重试后仍抛（重试不吞错）。
    const alwaysDown = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const failing = createGeoProviderCapabilities(directSecrets, {
      fetch: alwaysDown as typeof fetch,
      sleep: silentSleep(),
    });
    const failure = await failing.generation
      .complete([{ role: "user", content: "g" }])
      .catch((e) => e);
    // 外层错误分类器会包装为 Geo 上游错误族，但底层网络原因保留可溯。
    expect(failure.message).toContain("fetch failed");
    expect(alwaysDown).toHaveBeenCalledTimes(3);
  });

  describe("chat 流式传输（2026-09-02 非流式 120s 死线误杀修复）", () => {
    const encoder = new TextEncoder();

    /**
     * SSE 形态的 ReadableStream。stallAfter 有值时发完第 stallAfter 个
     * chunk 后不 close（模拟连接挂死），并监听 fetch signal 的 abort——
     * 真实 undici 在 abort 时以 signal.reason 拒绝 pending read，mock 用
     * controller.error(reason) 复刻同一语义（对持锁流调 cancel 会被拒绝
     * 且 pending read 永不返回，测不出断流）。
     */
    const sseStream = (
      chunks: readonly string[],
      opts?: { stallAfter?: number; signal?: AbortSignal },
    ): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          chunks.forEach((chunk, index) => {
            if (opts?.stallAfter !== undefined && index > opts.stallAfter) {
              return;
            }
            controller.enqueue(encoder.encode(chunk));
          });
          if (opts?.stallAfter === undefined) {
            controller.close();
            return;
          }
          opts?.signal?.addEventListener(
            "abort",
            () => {
              const signal = opts.signal as AbortSignal;
              try {
                controller.error(
                  signal.reason ??
                    new DOMException("This operation was aborted", "AbortError"),
                );
              } catch {
                // 流已关闭（abort 晚于正常读完）：无需处理。
              }
            },
            { once: true },
          );
        },
      });

    const sseResponse = (stream: ReadableStream<Uint8Array>) =>
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });

    const fastChatTimeouts = { firstChunkMs: 150, idleMs: 30, totalMs: 5_000 };

    /**
     * 按时间表发块的 SSE 形态 ReadableStream（真实定时器，毫秒级缩小
     * 生产三段超时的刻度）。closeAfterMs 未给时不 close（模拟挂死），
     * fetch signal abort 时以 signal.reason 拒绝 pending read（语义对齐
     * 真实 undici，见 sseStream 注释）。
     */
    const timedSseStream = (
      schedule: ReadonlyArray<{ chunk: string; afterMs: number }>,
      opts?: { closeAfterMs?: number; signal?: AbortSignal },
    ): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          let aborted = false;
          const timers = schedule.map(({ chunk, afterMs }) =>
            setTimeout(() => {
              if (!aborted) controller.enqueue(encoder.encode(chunk));
            }, afterMs),
          );
          if (opts?.closeAfterMs !== undefined) {
            timers.push(
              setTimeout(() => {
                if (!aborted) controller.close();
              }, opts.closeAfterMs),
            );
          }
          opts?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              timers.forEach(clearTimeout);
              const signal = opts.signal as AbortSignal;
              try {
                controller.error(
                  signal.reason ??
                    new DOMException("This operation was aborted", "AbortError"),
                );
              } catch {
                // 流已关闭（abort 晚于正常读完）：无需处理。
              }
            },
            { once: true },
          );
        },
      });

    it("SSE 分块跨 JSON 行边界仍完整拼接，且请求体带 stream:true", async () => {
      const bodies: unknown[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(
          sseStream([
            'data: {"choices":[{"delta":{"cont',
            'ent":"你好"}}]}\n\nda',
            'ta: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        );
      });
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
      });

      const content = await capabilities.generation.complete([
        { role: "user", content: "g" },
      ]);

      expect(content).toBe("你好，世界");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ stream: true });
    });

    it("上游对 stream 请求整包返回 JSON（网关缓冲/无 content-type）时按信封兜底", async () => {
      const fetchMock = vi.fn(async () =>
        // 无 Content-Type 头：判形必须靠文本嗅探而非仅看 header。
        new Response(
          JSON.stringify({ choices: [{ message: { content: "兜底" } }] }),
          { status: 200 },
        ),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
      });

      const content = await capabilities.generation.complete([
        { role: "user", content: "g" },
      ]);

      expect(content).toBe("兜底");
    });

    it("断流触发空闲超时重试，且重试不拼接上一次的半截正文", async () => {
      let calls = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          // 只发一个 delta 后挂死：空闲计时器到点必须中断并整次重来。
          return sseResponse(
            sseStream(
              ['data: {"choices":[{"delta":{"content":"半截"}}]}\n\n'],
              { stallAfter: 0, signal: init?.signal as AbortSignal },
            ),
          );
        }
        return sseResponse(
          sseStream([
            'data: {"choices":[{"delta":{"content":"完整正文"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
        );
      });
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
        chatTimeouts: fastChatTimeouts,
      });

      const content = await capabilities.generation.complete([
        { role: "user", content: "g" },
      ]);

      expect(content).toBe("完整正文");
      expect(calls).toBe(2);
    });

    it("持续断流耗尽重试后以可读超时文案失败（不再裸 This operation was aborted）", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        sseResponse(
          sseStream(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'], {
            stallAfter: 0,
            signal: init?.signal as AbortSignal,
          }),
        ),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
        chatTimeouts: fastChatTimeouts,
      });

      const failure = await capabilities.generation
        .complete([{ role: "user", content: "g" }])
        .catch((e) => e);

      expect(failure.message).toContain("空闲超时");
      expect(failure.message).not.toContain("This operation was aborted");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("SSE 流无任何 delta 内容判无效响应且不重试", async () => {
      const fetchMock = vi.fn(async () =>
        sseResponse(sseStream(["data: [DONE]\n\n"])),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
      });

      const failure = await capabilities.generation
        .complete([{ role: "user", content: "g" }])
        .catch((e) => e);

      expect(failure.message).toContain("返回了无效响应");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("调用方取消不重试，AbortError 文案经脱敏层原样保留", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        // undici 对已中止 signal 的 fetch 立即拒绝，mock 对齐该行为。
        if (init?.signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return sseResponse(
          sseStream(['data: {"choices":[{"delta":{"content":"正文"}}]}\n\n']),
        );
      });
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
      });
      const controller = new AbortController();
      controller.abort();

      const failure = await capabilities.generation
        .complete([{ role: "user", content: "g" }], {
          signal: controller.signal,
        })
        .catch((e) => e);

      // sanitizeGeoProviderError 按普通 Error 重建（name 不保留），断言
      // 落在文案与「只调一次」上。
      expect(failure.message).toContain("This operation was aborted");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("上游首字节前完全静默触发首字节超时并以可读文案耗尽重试", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        sseResponse(
          // 一个字节都不发且不 close：首块预算是这段静默的唯一裁判。
          sseStream([], {
            stallAfter: -1,
            signal: init?.signal as AbortSignal,
          }),
        ),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
        chatTimeouts: { firstChunkMs: 80, idleMs: 30, totalMs: 60_000 },
      });

      const failure = await capabilities.generation
        .complete([{ role: "user", content: "g" }])
        .catch((e) => e);

      expect(failure.message).toContain("首字节超时");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("首字节慢于空闲预算但在首块预算内不误杀（高推理慢思考场景）", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        sseResponse(
          timedSseStream(
            [
              {
                chunk: 'data: {"choices":[{"delta":{"content":"想"}}]}\n\n',
                afterMs: 100,
              },
              {
                chunk: 'data: {"choices":[{"delta":{"content":"好了"}}]}\n\n',
                afterMs: 130,
              },
              { chunk: "data: [DONE]\n\n", afterMs: 150 },
            ],
            { closeAfterMs: 170, signal: init?.signal as AbortSignal },
          ),
        ),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
        // idleMs 50 而首字节 100ms 才到：空闲只从首字节后起算，首块
        // 预算 400ms 放行。
        chatTimeouts: { firstChunkMs: 400, idleMs: 50, totalMs: 60_000 },
      });

      const content = await capabilities.generation.complete([
        { role: "user", content: "g" },
      ]);

      expect(content).toBe("想好了");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("涓流不断流（间隙小于空闲）触发总时长超时兜底并以可读文案失败", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
        sseResponse(
          timedSseStream(
            Array.from({ length: 30 }, (_, i) => ({
              chunk: `data: {"choices":[{"delta":{"content":"字${i}"}}]}\n\n`,
              afterMs: 40 * i,
            })),
            { closeAfterMs: 10_000, signal: init?.signal as AbortSignal },
          ),
        ),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
        // 总时长 200ms：40ms 间隙远小于 idleMs，空闲永不触发，由
        // totalMs 收口（防涓流挂死语义的唯一用例）。
        chatTimeouts: { firstChunkMs: 1_000, idleMs: 10_000, totalMs: 200 },
      });

      const failure = await capabilities.generation
        .complete([{ role: "user", content: "g" }])
        .catch((e) => e);

      expect(failure.message).toContain("总时长超时");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("总时长超过旧固定死线刻度但持续吐字的流存活到底（误杀修复主场景）", async () => {
      const chunks = Array.from({ length: 12 }, (_, i) => ({
        chunk: `data: {"choices":[{"delta":{"content":"段${i}"}}]}\n\n`,
        afterMs: 60 * i,
      }));
      const fetchMock = vi.fn(async () =>
        sseResponse(timedSseStream(chunks, { closeAfterMs: 60 * 11 + 40 })),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
        // 刻度映射生产值：idleMs 200ms ≈ 旧 120s 固定死线；流总时长
        // 660ms ≫ 200ms 且相邻间隙 60ms < 200ms——旧死线必杀，新
        // 「只要持续吐字就不中断」语义存活到底。
        chatTimeouts: { firstChunkMs: 300, idleMs: 200, totalMs: 60_000 },
      });

      const content = await capabilities.generation.complete([
        { role: "user", content: "g" },
      ]);

      expect(content).toBe(chunks.map((_, i) => `段${i}`).join(""));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("Content-Type 误报 application/json 但实为 SSE 时按文本嗅探走 SSE 解析", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          sseStream([
            'data: {"choices":[{"delta":{"content":"嗅探"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
      });

      const content = await capabilities.generation.complete([
        { role: "user", content: "g" },
      ]);

      expect(content).toBe("嗅探");
    });

    it("非 JSON 非 SSE 的异常响应体判无效响应（不裸抛 SyntaxError、不重试）", async () => {
      const fetchMock = vi.fn(async () =>
        new Response("<html>bad gateway</html>", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      const capabilities = createGeoProviderCapabilities(directSecrets, {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: silentSleep(),
      });

      const failure = await capabilities.generation
        .complete([{ role: "user", content: "g" }])
        .catch((e) => e);

      expect(failure.message).toContain("返回了无效响应");
      expect(failure.message).not.toContain("SyntaxError");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
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

describe("stored image 契约 pin（ADR-0012 双侧裁判）", () => {
  it("白名单映射与 storedImageContract.json 严格相等（键集＝白名单）", () => {
    expect(STORED_IMAGE_EXTENSION_BY_MEDIA_TYPE).toEqual(
      storedImageContract.extensionsByMediaType,
    );
    // 键集即格式白名单本身：JSON 加键而 Record 未扩会在此红（编译期已
    // 保证 Record 键完备，这里钉反向——契约多出的键不许静默存在）。
    expect(
      Object.keys(storedImageContract.extensionsByMediaType).sort(),
    ).toEqual(Object.keys(STORED_IMAGE_EXTENSION_BY_MEDIA_TYPE).sort());
  });
});
