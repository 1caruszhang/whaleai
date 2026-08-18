import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GEO_PROVIDER_CAPABILITY_CATALOG,
  GEO_PROVIDER_CAPABILITY_SLOTS,
  XIAOJING_GEO_PROVIDER_DEFAULTS,
} from "./providerCapabilities";

describe("Xiaojing fixed GEO provider capability catalog", () => {
  it("contains exactly the eight product slots in their stable UI order", () => {
    expect(GEO_PROVIDER_CAPABILITY_CATALOG.map(({ slot }) => slot)).toEqual(
      GEO_PROVIDER_CAPABILITY_SLOTS,
    );
  });

  it("pins the js_ai dev model and endpoint semantics", () => {
    expect(XIAOJING_GEO_PROVIDER_DEFAULTS).toMatchObject({
      mainAgentModel: "deepseek-v4-pro",
      extractionModel: "deepseek-chat",
      keywordSearchModel: "doubao-seed-2-0-lite-260428",
      generationModel: "doubao-seed-2-0-pro-260215",
      reflectionModel: "deepseek-v4-pro",
      embeddingDimensions: 2048,
      embeddingConcurrency: 2,
      embeddingMaxRetries: 2,
      doubaoSearchBaseUrl: "https://open.feedcoopapi.com",
      distributionCacheTtlMs: 1_800_000,
    });
    expect(
      GEO_PROVIDER_CAPABILITY_CATALOG.find(
        ({ slot }) => slot === "keyword-search",
      ),
    ).toMatchObject({
      semantics: {
        enable_search: true,
        billingSurface: "paygo",
        searchSourcesEndpoint:
          "https://open.feedcoopapi.com/search_api/web_search",
      },
    });
    expect(
      GEO_PROVIDER_CAPABILITY_CATALOG.find(({ slot }) => slot === "embedding"),
    ).toMatchObject({
      semantics: { singleTextPerRequest: true, dimensions: 2048 },
    });
  });

  it("keeps the development template Xiaojing-only and every value empty", () => {
    const source = readFileSync(resolve(".env.example"), "utf8");
    const assignments = source
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((line) => line.endsWith("="))).toBe(true);
    expect(source).not.toMatch(/ANTHROPIC|OPENAI|TAURI_SIGNING|APPLE_/);
    // 票 06：DeepSeek 凭据/端点变量移除（主 Agent 流量在票 07 切网关），
    // 新增账号网关地址 GATEWAY_BASE_URL。
    expect(assignments.map((line) => line.slice(0, line.indexOf("=")))).toEqual(
      [
        "GATEWAY_BASE_URL",
        "ARK_API_KEY",
        "ARK_PAYGO_BASE_URL",
        "DOUBAO_SEARCH_BASE_URL",
        "ARK_EMBEDDING_API_KEY",
        "ARK_EMBEDDING_MODEL",
        "ALI_OSS_ACCESS_KEY_ID",
        "ALI_OSS_ACCESS_KEY_SECRET",
        "ALI_OSS_BUCKET",
        "ALI_OSS_REGION",
        "ALI_OSS_PUBLIC_BASE_URL",
        "CHAOJIMEIJIE_APPID",
        "CHAOJIMEIJIE_SECRET",
        "CHAOJIMEIJIE_API_BASE_URL",
      ],
    );
  });
});
