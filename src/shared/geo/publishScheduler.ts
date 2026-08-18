export const PUBLISH_SCHEDULER_POLICY_VERSION =
  "js-ai-dev-deterministic-publish-v1";

export const PUBLISH_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const;
export const PUBLISH_MAX_SAFE_RETRIES = PUBLISH_RETRY_BACKOFF_MS.length;

export type PublishExecutionStatus =
  | "awaiting-confirmation"
  | "confirmed"
  | "running"
  | "scheduled"
  | "partially-succeeded"
  | "succeeded"
  | "failed"
  | "superseded"
  | "reconciliation-required";

export type PublishItemStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "submitting"
  | "submitted"
  | "failed-retryable"
  | "failed-nonretryable"
  | "reconciliation-required";

export interface PublishProviderSnapshot {
  objectStorage: {
    provider: "aliyun-oss";
    endpointFamily: "oss-v1-put";
    configured: boolean;
    configurationFingerprint: string | null;
  };
  distribution: {
    provider: "超级媒介";
    endpointFamily: "chaojimeijie-order-api";
    configured: boolean;
    configurationFingerprint: string | null;
  };
}

export interface PublishArticleSnapshot {
  articleId: string;
  approvedRevision: number;
  approvedBodySha256: string;
  title: string;
  bodyBytes: number;
  bodySummary: string;
}

export interface PublishChannelSnapshot {
  resourceId: number;
  kind: "media" | "we-media";
  name: string;
  estimatedPriceCny: number;
  publishedRate: number;
}

export interface PublishItemProjection {
  id: string;
  revision: number;
  sequence: number;
  article: PublishArticleSnapshot;
  channel: PublishChannelSnapshot;
  scheduledAt: string;
  status: PublishItemStatus;
  idempotencyKey: string;
  externalRequestSn: string;
  payloadHash: string;
  objectKey: string;
  objectUrl: string | null;
  externalOrderId: string | null;
  externalContentId: string | null;
  attempts: number;
  uploadAttempts: number;
  nextAttemptAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestSummary: {
    articleId: string;
    approvedRevision: number;
    approvedBodySha256: string;
    resourceId: number;
    scheduledAt: string;
    plannedObjectUrl: string;
    estimatedPriceCny: number;
  };
  failureCode: string | null;
  failureReason: string | null;
}

export interface PublishExecutionProjection {
  id: string;
  operationId: string;
  workspaceId: string;
  createdBySessionId: string;
  distributionPlanId: string;
  distributionPlanRevision: number;
  policyVersion: typeof PUBLISH_SCHEDULER_POLICY_VERSION;
  revision: number;
  status: PublishExecutionStatus;
  budgetCny: number;
  estimatedSpendCny: number;
  publishStartAt: string;
  irreversibleImpact: string;
  confirmationDigest: string;
  providerSnapshot: PublishProviderSnapshot;
  items: PublishItemProjection[];
  confirmedAt: string | null;
  executionStartedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishExecutionConfirmInput {
  executionId: string;
  expectedRevision: number;
  confirmationDigest: string;
}

export interface PublishExecutionStartInput {
  executionId: string;
  expectedRevision: number;
}

export interface PublishItemRetryInput {
  executionId: string;
  itemId: string;
  expectedItemRevision: number;
}

export function publishRetryBackoffMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return PUBLISH_RETRY_BACKOFF_MS[attempt - 1] ?? null;
}

export function isPublishExecutionImmutable(
  status: PublishExecutionStatus,
): boolean {
  return status !== "awaiting-confirmation";
}

export function publishExecutionCanStart(
  execution: PublishExecutionProjection,
): boolean {
  return execution.status === "confirmed";
}
