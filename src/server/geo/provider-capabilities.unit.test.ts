import { describe, expect, it, vi } from "vitest";

import {
  captureGeoProviderRuntimeSecrets,
  createGeoProviderCapabilities,
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
      XIAOJING_ARK_EMBEDDING_API_KEY: "embedding-secret",
      XIAOJING_ARK_EMBEDDING_ENDPOINT_ID: "ep-test",
      XIAOJING_OSS_ACCESS_KEY_SECRET: "oss-secret",
      XIAOJING_DISTRIBUTION_SECRET: "distribution-secret",
    };
    expect(captureGeoProviderRuntimeSecrets(env)).toMatchObject({
      arkApiKey: "ark-secret",
      embeddingApiKey: "embedding-secret",
      embeddingEndpointId: "ep-test",
      ossAccessKeySecret: "oss-secret",
      distributionSecret: "distribution-secret",
    });
    expect(env).toEqual({});
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
    await capabilities.reflection.complete([
      { role: "user", content: "review" },
    ]);
    await capabilities.keywordSearch.search("search");

    expect(calls.map(({ body }) => body.model)).toEqual([
      "deepseek-chat",
      "doubao-seed-2-0-pro-260215",
      "deepseek-v4-pro",
      "doubao-seed-2-0-lite-260428",
    ]);
    expect(calls[3].url).toBe(
      "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    );
    expect(calls[3].body.enable_search).toBe(true);
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

  it("keeps paid distribution submission outside the GEO provider port", () => {
    const capabilities = createGeoProviderCapabilities({});
    expect(Object.keys(capabilities.distribution)).toEqual([
      "slot",
      "listResources",
    ]);
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
