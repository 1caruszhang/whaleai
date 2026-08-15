/**
 * Explicit real-provider smoke. Never part of the default test command.
 *
 * Run intentionally with both the credentialed project and the extra opt-in:
 *   RUN_XIAOJING_PROVIDER_SMOKE=1 npm run test:credentialed -- provider-capabilities
 *
 * The object-storage PUT is deliberately excluded because a connectivity test
 * must not create external objects. Its signed wire shape is covered by unit
 * tests and the UI verifier uses a read-only bucket request.
 */
import { describe, expect, it } from "vitest";

import { createGeoProviderCapabilities } from "./provider-capabilities";

const explicitlyEnabled = process.env.RUN_XIAOJING_PROVIDER_SMOKE === "1";
const capabilities = createGeoProviderCapabilities({
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  arkApiKey: process.env.ARK_API_KEY,
  embeddingApiKey: process.env.ARK_EMBEDDING_API_KEY,
  embeddingEndpointId: process.env.ARK_EMBEDDING_MODEL,
  distributionAppId: process.env.CHAOJIMEIJIE_APPID,
  distributionSecret: process.env.CHAOJIMEIJIE_SECRET,
  distributionBaseUrl: process.env.CHAOJIMEIJIE_API_BASE_URL,
});

describe.runIf(explicitlyEnabled)("Xiaojing GEO real-provider smoke", () => {
  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    "reaches fixed DeepSeek extraction route",
    async () => {
      const result = await capabilities.extraction.complete([
        { role: "user", content: "只回复 OK" },
      ]);
      expect(result.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(!process.env.ARK_API_KEY)(
    "reaches fixed ARK generation route",
    async () => {
      const result = await capabilities.generation.complete([
        { role: "user", content: "只回复 OK" },
      ]);
      expect(result.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(
    !process.env.ARK_EMBEDDING_MODEL ||
      !(process.env.ARK_EMBEDDING_API_KEY || process.env.ARK_API_KEY),
  )("returns a 2048-dimensional ARK embedding", async () => {
    const [vector] = await capabilities.embedding.embed(["连接检查"]);
    expect(vector).toHaveLength(2048);
  });

  it.skipIf(
    !process.env.CHAOJIMEIJIE_APPID || !process.env.CHAOJIMEIJIE_SECRET,
  )(
    "reads the signed distribution resource pool without creating an order",
    async () => {
      const page = await capabilities.distribution.listResources("media", 1, 1);
      expect(page.total).toBeGreaterThanOrEqual(0);
    },
  );
});
