import { describe, expect, it, vi } from "vitest";

import { GEO_BASELINE_POLICY_VERSION } from "../../shared/geo/baseline";
import {
  GEO_DASHBOARD_POLICY_VERSION,
  geoDashboardMetric,
  type GeoDashboardDrilldown,
} from "../../shared/geo/dashboard";
import {
  GeoDashboardService,
  type GeoDashboardPersistencePort,
  type RustGeoDashboardProjection,
} from "./dashboard";

function projection(): RustGeoDashboardProjection {
  return {
    workspaceId: "brand-15",
    workspaceName: "真实品牌",
    policyVersion: GEO_DASHBOARD_POLICY_VERSION,
    generatedAt: "2026-08-15T00:00:00Z",
    filters: { engineId: "doubao" },
    filterSemantics: {
      timeInterval: "[from,toExclusive)",
      timezone: "UTC",
      monitorOperationLineage: "monitor-or-source-operation",
      observationPolicy: "all-observations",
      engineApplicability: "engine-metrics-only",
    },
    dimensions: {
      sessions: [],
      operations: [],
      engines: [{ id: "doubao", label: "豆包 AI 搜索" }],
    },
    metrics: [
      {
        key: "brand-mention",
        numerator: null,
        denominator: null,
        value: null,
        sampleTime: null,
        sampleCount: 0,
        completeness: { successful: 0, failed: 0, pending: 0, total: 0 },
        availability: "empty",
        sampleSufficiency: "none",
        dataNotes: [],
        methodology: "真实口径",
        engineFilterApplies: true,
        evidence: [],
      },
    ],
    trend: [],
    questionEngineMatrix: [],
    observationLog: [],
    contentPublish: {
      articles: {},
      articlesWithApprovedRevision: 0,
      publishExecutions: {},
      publishItems: {},
      submittedItems: 0,
    },
  };
}

const providerSnapshot = {
  engineId: "doubao" as const,
  provider: "volcengine" as const,
  capabilitySlot: "keyword-search" as const,
  model: "doubao-seed-2-0-lite-260428",
  endpointFamily: "ark-responses" as const,
  searchMode: "doubao-app-ai-search" as const,
  configurationFingerprint: "not-configured",
  policyVersion: GEO_BASELINE_POLICY_VERSION,
} as const;

describe("GeoDashboardService", () => {
  it("gets the exact Rust aggregate and projects typed capability unavailability", async () => {
    const persistence: GeoDashboardPersistencePort = {
      get: vi.fn(async () => projection()),
      drilldown: vi.fn(),
    };
    const service = new GeoDashboardService(persistence, {
      baselineEngines: () => [
        {
          id: "doubao",
          label: "豆包 AI 搜索",
          available: false,
          unavailableReason: "keyword-search 能力尚未配置",
          snapshot: providerSnapshot,
        },
      ],
    });
    const result = await service.get({ engineId: "doubao" });
    expect(persistence.get).toHaveBeenCalledWith({ engineId: "doubao" });
    expect(geoDashboardMetric(result, "brand-mention").availability).toBe(
      "unavailable",
    );
    expect(result.providerEngines[0]).not.toHaveProperty("credential");
  });

  it("forwards one exact bounded evidence anchor to Rust drilldown", async () => {
    const exact: GeoDashboardDrilldown = {
      kind: "article",
      operationId: "op-11",
      sessionId: "session-a",
      article: {
        id: "article-11",
        title: "真实文章",
        status: "approved",
        revision: 2,
        approvedRevision: 2,
        approvedBodyPath: "articles/approved/article-11/v2.md",
        approvedBodySha256: "hash",
        createdAt: "2026-08-15T00:00:00Z",
        updatedAt: "2026-08-15T00:01:00Z",
      },
    };
    const persistence: GeoDashboardPersistencePort = {
      get: vi.fn(),
      drilldown: vi.fn(async () => exact),
    };
    const service = new GeoDashboardService(persistence, {
      baselineEngines: () => [],
    });
    await expect(
      service.drilldown({ kind: "article", id: "article-11" }),
    ).resolves.toEqual(exact);
    expect(persistence.drilldown).toHaveBeenCalledWith({
      kind: "article",
      id: "article-11",
    });
  });
});
