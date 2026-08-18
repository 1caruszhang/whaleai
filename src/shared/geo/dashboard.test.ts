import { describe, expect, it } from "vitest";

import {
  GEO_DASHBOARD_POLICY_VERSION,
  applyGeoDashboardProviderAvailability,
  geoDashboardMetric,
  type GeoDashboardProjection,
} from "./dashboard";
import { GEO_BASELINE_POLICY_VERSION } from "./baseline";

function projection(): Omit<GeoDashboardProjection, "providerEngines"> {
  return {
    workspaceId: "brand-15",
    workspaceName: "真实品牌",
    policyVersion: GEO_DASHBOARD_POLICY_VERSION,
    generatedAt: "2026-08-15T00:00:00Z",
    filters: {},
    filterSemantics: {
      timeInterval: "[from,toExclusive)",
      timezone: "UTC",
      monitorOperationLineage: "monitor-or-source-operation",
      observationPolicy: "all-observations",
      engineApplicability: "engine-metrics-only",
    },
    dimensions: { sessions: [], operations: [], engines: [] },
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
        methodology: "成功真实 observation 中品牌被提及 / 成功 observation",
        engineFilterApplies: true,
        evidence: [],
      },
      {
        key: "content-publish",
        numerator: null,
        denominator: null,
        value: null,
        sampleTime: null,
        sampleCount: 0,
        completeness: { successful: 0, failed: 0, pending: 0, total: 0 },
        availability: "empty",
        sampleSufficiency: "none",
        dataNotes: [],
        methodology: "批准文章 / 全部文章；发布项只展示状态分布",
        engineFilterApplies: false,
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

const engine = {
  id: "doubao" as const,
  label: "豆包 AI 搜索",
  available: false,
  unavailableReason: "keyword-search 能力尚未配置",
  snapshot: {
    engineId: "doubao" as const,
    provider: "volcengine" as const,
    capabilitySlot: "keyword-search" as const,
    model: "doubao-seed-2-0-lite-260428",
    endpointFamily: "ark-responses" as const,
    searchMode: "doubao-app-ai-search" as const,
    configurationFingerprint: "missing",
    policyVersion: GEO_BASELINE_POLICY_VERSION,
  },
} as const;

describe("real GEO dashboard shared contract", () => {
  it("projects typed provider unavailability only onto empty engine metrics", () => {
    const result = applyGeoDashboardProviderAvailability(projection(), [
      engine,
    ]);
    expect(geoDashboardMetric(result, "brand-mention").availability).toBe(
      "unavailable",
    );
    expect(geoDashboardMetric(result, "content-publish").availability).toBe(
      "empty",
    );
  });

  it("keeps historical real data available when the provider is now unavailable", () => {
    const source = projection();
    source.metrics[0] = {
      ...source.metrics[0],
      numerator: 0,
      denominator: 2,
      value: 0,
      sampleCount: 2,
      availability: "available",
    };
    const result = applyGeoDashboardProviderAvailability(source, [engine]);
    expect(geoDashboardMetric(result, "brand-mention")).toMatchObject({
      value: 0,
      availability: "available",
    });
  });
});
