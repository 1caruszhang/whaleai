import type { GeoBaselineEngineAvailability } from "./baseline";

export const GEO_DASHBOARD_POLICY_VERSION =
  "xiaojing-real-geo-dashboard-v1" as const;
export const GEO_DASHBOARD_EVIDENCE_LIMIT = 8;
export const GEO_DASHBOARD_MATRIX_LIMIT = 50;
export const GEO_DASHBOARD_LOG_LIMIT = 30;
export const GEO_DASHBOARD_TREND_LIMIT = 20;

export type GeoDashboardAvailability =
  | "empty"
  | "unavailable"
  | "partial"
  | "available";

export type GeoDashboardMetricKey =
  | "brand-mention"
  | "recommendation"
  | "citation-coverage"
  | "question-coverage"
  | "content-publish"
  | "monitor-change";

export type GeoDashboardEvidenceKind =
  | "baseline-unit"
  | "monitor-unit"
  | "article"
  | "publish-item"
  | "monitor-run";

export interface GeoDashboardFilter {
  sessionId?: string;
  operationId?: string;
  /** Inclusive RFC3339 instant, normalized by the Rust owner to UTC. */
  from?: string;
  /** Exclusive RFC3339 instant, normalized by the Rust owner to UTC. */
  toExclusive?: string;
  engineId?: string;
}

export interface GeoDashboardCompleteness {
  successful: number;
  failed: number;
  pending: number;
  total: number;
}

export interface GeoDashboardEvidenceAnchor {
  kind: GeoDashboardEvidenceKind;
  id: string;
  parentId: string;
  label: string;
  occurredAt: string;
  operationId: string;
  sessionId: string;
  engineId?: string;
}

export interface GeoDashboardMetric {
  key: GeoDashboardMetricKey;
  numerator: number | null;
  denominator: number | null;
  /** Integer percentage for rate cards. Null means no valid denominator. */
  value: number | null;
  sampleTime: string | null;
  sampleCount: number;
  completeness: GeoDashboardCompleteness;
  availability: GeoDashboardAvailability;
  sampleSufficiency: "none" | "insufficient" | "sufficient";
  /** Deterministic, user-visible data quality signals (for example partial-failure). */
  dataNotes: string[];
  methodology: string;
  /** Engine selection changes this metric when true. */
  engineFilterApplies: boolean;
  evidence: GeoDashboardEvidenceAnchor[];
  delta?: number | null;
}

export interface GeoDashboardSessionDimension {
  id: string;
  label: string;
}

export interface GeoDashboardOperationDimension {
  id: string;
  kind: "baseline" | "article" | "publish" | "monitor";
  createdAt: string;
  sourceOperationId?: string;
}

export interface GeoDashboardDimensions {
  sessions: GeoDashboardSessionDimension[];
  operations: GeoDashboardOperationDimension[];
  engines: Array<{ id: string; label: string }>;
}

export interface GeoDashboardTrendPoint {
  runId: string;
  planId: string;
  ordinal: number;
  sampledAt: string;
  mentionRate: number | null;
  recommendationRate: number | null;
  citationRate: number | null;
  successful: number;
  failed: number;
  pending: number;
  evidence: GeoDashboardEvidenceAnchor;
}

export interface GeoDashboardQuestionEngineRow {
  questionId: string;
  question: string;
  engineId: string;
  observations: number;
  successful: number;
  failed: number;
  pending: number;
  mentioned: number;
  recommended: number;
  cited: number;
  lastObservedAt: string;
  evidence: GeoDashboardEvidenceAnchor;
}

export interface GeoDashboardObservationLogEntry {
  anchor: GeoDashboardEvidenceAnchor;
  status: "succeeded" | "failed" | "pending";
  summary: string;
}

export interface GeoDashboardContentPublishBreakdown {
  articles: Record<string, number>;
  articlesWithApprovedRevision: number;
  publishExecutions: Record<string, number>;
  publishItems: Record<string, number>;
  /** Durable submit acknowledgements; not proof of publication or indexing. */
  submittedItems: number;
}

export interface GeoDashboardProjection {
  workspaceId: string;
  workspaceName: string;
  policyVersion: typeof GEO_DASHBOARD_POLICY_VERSION;
  generatedAt: string;
  filters: GeoDashboardFilter;
  filterSemantics: {
    timeInterval: "[from,toExclusive)";
    timezone: "UTC";
    monitorOperationLineage: "monitor-or-source-operation";
    observationPolicy: "all-observations";
    engineApplicability: "engine-metrics-only";
  };
  dimensions: GeoDashboardDimensions;
  providerEngines: GeoBaselineEngineAvailability[];
  metrics: GeoDashboardMetric[];
  trend: GeoDashboardTrendPoint[];
  questionEngineMatrix: GeoDashboardQuestionEngineRow[];
  observationLog: GeoDashboardObservationLogEntry[];
  contentPublish: GeoDashboardContentPublishBreakdown;
}

export type GeoDashboardDrilldown =
  | {
      kind: "baseline-unit";
      baselineId: string;
      operationId: string;
      sessionId: string;
      unit: unknown;
    }
  | {
      kind: "monitor-unit";
      planId: string;
      runId: string;
      operationId: string;
      sourceOperationId: string;
      sessionId: string;
      unit: unknown;
    }
  | {
      kind: "article";
      operationId: string;
      sessionId: string;
      article: {
        id: string;
        title: string;
        status: string;
        revision: number;
        approvedRevision: number | null;
        approvedBodyPath: string | null;
        approvedBodySha256: string | null;
        createdAt: string;
        updatedAt: string;
      };
    }
  | {
      kind: "publish-item";
      executionId: string;
      operationId: string;
      sessionId: string;
      item: unknown;
    }
  | {
      kind: "monitor-run";
      planId: string;
      operationId: string;
      sourceOperationId: string;
      sessionId: string;
      run: unknown;
    };

/**
 * Capability availability is owned by the typed Node provider port, while
 * data availability is owned by Rust. Combining them here keeps the policy in
 * one pure cross-surface function instead of duplicating it in the component.
 */
export function applyGeoDashboardProviderAvailability(
  projection: Omit<GeoDashboardProjection, "providerEngines">,
  providerEngines: readonly GeoBaselineEngineAvailability[],
): GeoDashboardProjection {
  const selected = projection.filters.engineId;
  const relevant = selected
    ? providerEngines.filter((engine) => engine.id === selected)
    : providerEngines;
  const providerAvailable = relevant.some((engine) => engine.available);
  return {
    ...projection,
    providerEngines: [...providerEngines],
    metrics: projection.metrics.map((metric) =>
      metric.engineFilterApplies &&
      metric.availability === "empty" &&
      !providerAvailable
        ? { ...metric, availability: "unavailable" as const }
        : metric,
    ),
  };
}

export function geoDashboardMetric(
  projection: GeoDashboardProjection,
  key: GeoDashboardMetricKey,
): GeoDashboardMetric {
  const metric = projection.metrics.find((candidate) => candidate.key === key);
  if (!metric) throw new Error(`geo_dashboard_metric_missing:${key}`);
  return metric;
}
