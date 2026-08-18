/**
 * Explicit real-provider smoke for the material extraction pipeline. Never
 * part of the default test command.
 *
 * Run intentionally with both the credentialed project and the extra opt-in:
 *   DEEPSEEK_API_KEY=... RUN_XIAOJING_PROVIDER_SMOKE=1 \
 *     npm run test:credentialed -- material-import
 *
 * The real DeepSeek extraction slot walks the full MaterialImportService.process
 * chain (prompt → parse → propose) against a fake storage port, so no Rust
 * management hop, brand workspace, or ARK enrichment spend is involved.
 */
import { describe, expect, it } from "vitest";

import type { KnowledgeCandidate } from "./knowledge-authority";
import { MaterialImportService, type BrandMaterial, type BrandMaterialPort } from "./material-import";
import { createGeoProviderCapabilities } from "./provider-capabilities";

const explicitlyEnabled = process.env.RUN_XIAOJING_PROVIDER_SMOKE === "1";

const SMOKE_MATERIAL_TEXT = [
  "# 星澜智能科技有限公司",
  "",
  "## 关于我们",
  "",
  "星澜智能科技（StarTide AI）成立于 2019 年，总部位于成都高新区，专注为中小型制造企业提供工业视觉质检解决方案。",
  "核心产品线包括：星澜质检相机 S 系列、星澜缺陷检测平台、星澜边缘推理盒。",
  "主要竞争对手是海康威视、大恒图像和思谋科技。",
  "目标客户为 3C 电子与汽车零部件制造商；核心优势是交付周期短（平均 14 天）与本地化实施团队。",
  "已获得 ISO 9001 认证，服务过 120 余家工厂，代表案例包括某头部连接器厂商的全产线目检替换。",
  "客户常见痛点是漏检率高与换型调机耗时长。",
  "联系电话 028-88889999，官网 https://example-startide-ai.cn。",
].join("\n");

class SmokeMaterialPort implements BrandMaterialPort {
  readonly finishes: Array<{ status: string; errorCode?: string }> = [];

  async context() {
    return { workspaceId: "brand-smoke", brandName: "星澜智能科技", productLines: ["工业视觉质检"] };
  }
  async importFile(): Promise<BrandMaterial> {
    throw new Error("unused");
  }
  async importText(input: { displayName: string; text: string }) {
    this.stored = {
      id: "material-smoke-1",
      workspaceId: "brand-smoke",
      importedBySessionId: "session-smoke",
      inputKind: "pasted-text",
      displayName: input.displayName,
      fileExt: "txt",
      mediaType: "text/plain",
      relativePath: "materials/material-smoke-1.txt",
      byteSize: input.text.length,
      sha256: "0".repeat(64),
      source: { type: "pasted-text" },
      status: "stored",
      attemptCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.stored;
  }
  stored!: Awaited<ReturnType<BrandMaterialPort["importText"]>>;
  async get() {
    return this.stored;
  }
  async content() {
    return new TextEncoder().encode(SMOKE_MATERIAL_TEXT);
  }
  async begin() {
    return { id: "attempt-smoke-1", materialId: "material-smoke-1", attemptNumber: 1 };
  }
  async finish(input: { status: "awaiting-confirmation" | "failed"; errorCode?: string }) {
    this.finishes.push({ status: input.status, errorCode: input.errorCode });
    return this.stored;
  }
  async list() {
    return [];
  }
}

function smokeCandidate(predicate: string): KnowledgeCandidate {
  return {
    id: `candidate-${predicate}`,
    workspaceId: "brand-smoke",
    sessionId: "session-smoke",
    key: {
      subject: "星澜智能科技",
      predicate,
      scopeJson: "{}",
      effectiveFrom: null,
      effectiveTo: null,
      identity: `brand|${predicate}|{}||`,
    },
    valueJson: '"星澜智能科技"',
    normalizedValueJson: '"星澜智能科技"',
    unit: null,
    source: { materialId: "material-smoke-1", excerpt: "smoke", confidence: 0.9 },
    origin: "model-inferred",
    intent: "knowledge-update",
    status: "awaiting-confirmation",
    baseVersion: 0,
    proposedAt: new Date().toISOString(),
    current: null,
  };
}

describe.runIf(explicitlyEnabled)("Xiaojing material import real-provider smoke", () => {
  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    "walks the real DeepSeek extraction through the full process chain",
    async () => {
      const capabilities = createGeoProviderCapabilities({
        deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      });
      const port = new SmokeMaterialPort();
      const service = new MaterialImportService(
        { workspaceId: "brand-smoke", sessionId: "session-smoke" },
        port,
        capabilities.extraction,
        { propose: async (input) => smokeCandidate(input.key.predicate), inspect: async () => null },
      );

      const result = await service.importPastedText(SMOKE_MATERIAL_TEXT, "星澜智能科技-关于我们.txt");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.candidateIds.length).toBeGreaterThan(0);
      expect(port.finishes.at(-1)).toMatchObject({ status: "awaiting-confirmation" });
    },
    240_000,
  );

  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    "recovers from one unparseable response using the automatic re-extraction",
    async () => {
      const capabilities = createGeoProviderCapabilities({
        deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      });
      let calls = 0;
      const flakyExtraction = {
        slot: "extraction" as const,
        complete: async (...args: Parameters<typeof capabilities.extraction.complete>) => {
          calls += 1;
          if (calls === 1) {
            // 带内层花括号的截断 JSON：真实故障形态（SyntaxError → 曾落入泛化兜底）。
            return '{"facts": [{"field": "industry", "value": "工业视觉质检"';
          }
          return capabilities.extraction.complete(...args);
        },
      };
      const port = new SmokeMaterialPort();
      const service = new MaterialImportService(
        { workspaceId: "brand-smoke", sessionId: "session-smoke" },
        port,
        flakyExtraction,
        { propose: async (input) => smokeCandidate(input.key.predicate), inspect: async () => null },
      );

      const result = await service.importPastedText(SMOKE_MATERIAL_TEXT, "星澜智能科技-关于我们.txt");

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(result.ok).toBe(true);
    },
    240_000,
  );
});
