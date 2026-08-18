import type {
  GeoBaselineEngineId,
  GeoBaselineProviderSnapshot,
  GeoProbeAnalysis,
  GeoProbeCitation,
} from "./baseline";

export const POST_PUBLISH_MONITOR_POLICY_VERSION =
  "xiaojing-post-publish-monitor-v1" as const;

export type PostPublishMonitorPlanStatus =
  | "draft"
  | "active"
  | "completed"
  | "provisioning-failed";

export type PostPublishMonitorUnitKind =
  | "publish-status"
  | "access-indexing"
  | "baseline-probe";

export type PostPublishMonitorUnitStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface PostPublishMonitorEndConditions {
  deadline?: number;
  maxRuns?: number;
}

export interface PostPublishMonitorAttempt {
  attemptNumber: number;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PostPublishStatusEvidence {
  platformStatusCode: number;
  platformStatus: "submitted" | "published" | "indexed" | "rejected";
  externalOrderId: string;
  externalRequestSn: string;
  publishedUrl?: string;
  rawEvidence: unknown;
}

export interface PostPublishAccessEvidence {
  url: string;
  httpStatus?: number;
  accessible: boolean;
  indexingState: "indexed" | "not-indexed" | "unknown";
  platformStatusCode?: number;
  rawEvidence: unknown;
}

export interface PostPublishBaselineEvidence {
  questionId: string;
  engineId: GeoBaselineEngineId;
  rawAnswer: string;
  rawEvidence: unknown;
  sourceProviderSnapshot: GeoBaselineProviderSnapshot;
  providerSnapshot: GeoBaselineProviderSnapshot;
  citations: GeoProbeCitation[];
  analysis: GeoProbeAnalysis;
  rankPosition: 1 | 2 | 3 | null;
  citedArticleIds: string[];
  citedUrls: string[];
}

export interface PostPublishMonitorUnitProjection {
  id: string;
  revision: number;
  kind: PostPublishMonitorUnitKind;
  status: PostPublishMonitorUnitStatus;
  attemptNumber: number;
  publishItemId?: string;
  baselineUnitId?: string;
  questionId?: string;
  engineId?: GeoBaselineEngineId;
  observedAt?: string;
  nextAttemptAt?: string;
  errorCode?: string;
  errorMessage?: string;
  evidence?:
    | PostPublishStatusEvidence
    | PostPublishAccessEvidence
    | PostPublishBaselineEvidence;
  attempts: PostPublishMonitorAttempt[];
}

export interface PostPublishMonitorPrepareInput {
  publishExecutionId: string;
  baselineId: string;
  engineIds: GeoBaselineEngineId[];
  intervalMinutes: number;
  endConditions: PostPublishMonitorEndConditions;
  planId?: string;
  expectedRevision?: number;
}

export interface PostPublishMonitorActivateInput {
  planId: string;
  expectedRevision: number;
}

export interface PostPublishMonitorRetryInput {
  planId: string;
  unitId: string;
  expectedUnitRevision: number;
}

export interface PostPublishMonitorRunProjection {
  id: string;
  ordinal: number;
  scheduledFor: string;
  status: "running" | "succeeded" | "partial" | "failed";
  units: PostPublishMonitorUnitProjection[];
  createdAt: string;
  finishedAt?: string;
}

export interface PostPublishMonitorPlanProjection {
  id: string;
  operationId: string;
  sourceOperationId: string;
  workspaceId: string;
  createdBySessionId: string;
  publishExecutionId: string;
  publishItemIds: string[];
  baselineId: string;
  baselinePolicyVersion: string;
  baselineQuestionPoolId: string;
  baselineQuestionPoolRevision: number;
  engineIds: GeoBaselineEngineId[];
  intervalMinutes: number;
  endConditions: PostPublishMonitorEndConditions;
  policyVersion: typeof POST_PUBLISH_MONITOR_POLICY_VERSION;
  revision: number;
  status: PostPublishMonitorPlanStatus;
  scheduleId?: string;
  runCount: number;
  nextRunAt?: string;
  recoveryState: "ready" | "overdue" | "recovering" | "completed";
  latestRun?: PostPublishMonitorRunProjection;
  /** Newest-first, bounded BrandWorkspace history (currently at most 20 runs). */
  recentRuns: PostPublishMonitorRunProjection[];
  createdAt: string;
  updatedAt: string;
}

export interface PostPublishMonitorAggregate {
  successfulUnits: number;
  failedUnits: number;
  publishedItems: number;
  indexedItems: number;
  accessibleItems: number;
  /** Successful access/indexing units; the denominator for 可访问率. */
  accessSamples: number;
  baselineProbes: number;
  brandMentioned: number;
  topThree: number;
  citedArticleIds: string[];
  citedUrls: string[];
}

export function mapSupermediaStatus(
  code: number,
): PostPublishStatusEvidence["platformStatus"] | null {
  switch (code) {
    case 1:
    case 3:
    case 6:
    case 8:
      return "submitted";
    case 4:
    case 10:
    case 11:
      return "published";
    case 12:
      return "indexed";
    case 2:
    case 5:
    case 7:
    case 9:
      return "rejected";
    default:
      return null;
  }
}

/**
 * js_ai's D8 contract only recognizes an explicitly parseable TOP 1/2/3.
 * It must never estimate a position from prose order or a generic mention.
 */
export function parseExplicitTopThreeRank(
  answer: string,
  brandNames: readonly string[],
): 1 | 2 | 3 | null {
  for (const brand of brandNames.map((value) => value.trim()).filter(Boolean)) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `(?:^|[\\n\\r；。])\\s*(?:TOP|Top|top)\\s*([123])[：:、.\\s-]{0,4}${escaped}(?=$|[\\s，,。；;：:（(])`,
      ),
      new RegExp(
        `(?:^|[\\n\\r；。])\\s*第\\s*([一二三123])(?:名|位)?[：:、.\\s-]{0,4}${escaped}(?=$|[\\s，,。；;：:（(])`,
      ),
      new RegExp(
        `(?:^|[\\n\\r；。])\\s*${escaped}[：:、.\\s-]{0,4}(?:TOP|Top|top)\\s*([123])(?=$|[\\s，,。；;：:（(])`,
      ),
      new RegExp(
        `(?:^|[\\n\\r；。])\\s*${escaped}\\s*(?:排名)?第\\s*([一二三123])(?:名|位)?(?=$|[\\s，,。；;：:（(])`,
      ),
    ];
    for (const pattern of patterns) {
      const match = answer.match(pattern)?.[1];
      if (!match) continue;
      if (match === "1" || match === "一") return 1;
      if (match === "2" || match === "二") return 2;
      if (match === "3" || match === "三") return 3;
    }
  }
  return null;
}

export function aggregatePostPublishMonitorUnits(
  units: readonly PostPublishMonitorUnitProjection[],
): PostPublishMonitorAggregate {
  const successful = units.filter((unit) => unit.status === "succeeded");
  const failed = units.filter((unit) => unit.status === "failed");
  const publish = successful.filter((unit) => unit.kind === "publish-status");
  const access = successful.filter((unit) => unit.kind === "access-indexing");
  const probes = successful.filter((unit) => unit.kind === "baseline-probe");
  const probeEvidence = probes
    .map((unit) => unit.evidence)
    .filter(
      (evidence): evidence is PostPublishBaselineEvidence =>
        !!evidence && "rawAnswer" in evidence,
    );
  return {
    successfulUnits: successful.length,
    failedUnits: failed.length,
    publishedItems: publish.filter((unit) => {
      const evidence = unit.evidence;
      return (
        !!evidence &&
        "platformStatus" in evidence &&
        (evidence.platformStatus === "published" ||
          evidence.platformStatus === "indexed")
      );
    }).length,
    indexedItems: new Set(
      [...publish, ...access]
        .filter((unit) => {
          const evidence = unit.evidence;
          return (
            !!evidence &&
            (("platformStatus" in evidence &&
              evidence.platformStatus === "indexed") ||
              ("indexingState" in evidence &&
                evidence.indexingState === "indexed"))
          );
        })
        .map((unit) => unit.publishItemId)
        .filter((id): id is string => id !== undefined),
    ).size,
    accessibleItems: access.filter(
      (unit) =>
        !!unit.evidence &&
        "accessible" in unit.evidence &&
        unit.evidence.accessible,
    ).length,
    accessSamples: access.length,
    baselineProbes: probeEvidence.length,
    brandMentioned: probeEvidence.filter(
      (evidence) => evidence.analysis.brandMentioned,
    ).length,
    topThree: probeEvidence.filter((evidence) => evidence.rankPosition !== null)
      .length,
    citedArticleIds: [...new Set(probeEvidence.flatMap((e) => e.citedArticleIds))]
      .sort(),
    citedUrls: [...new Set(probeEvidence.flatMap((e) => e.citedUrls))].sort(),
  };
}
