/** 预览载荷哈希公式的输入（Rust 侧同名 POLICY_VERSION 逐字同步）：钉的是
 * 「发布什么 + 不可逆影响」的冻结身份，不含执行循环的重试表——重试语义
 * 变更（如 2026-09-01 的 3s×2 停车）不升版本，否则存量执行的对账哈希
 * 全部失配。 */
export const PUBLISH_SCHEDULER_POLICY_VERSION =
  "js-ai-dev-deterministic-publish-v1";

/** 自动重试 2 次、间隔 3 秒（与 Rust 侧 RETRY_BACKOFF_MS 同源契约）：
 * 耗尽即落终态 failed-nonretryable 跳过，深度恢复交由「重新发布」按钮。 */
export const PUBLISH_RETRY_BACKOFF_MS = [3_000, 3_000] as const;
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
  | "reconciliation-required"
  | "cancelled";

export type PublishItemStatus =
  | "pending"
  | "uploading"
  | "uploaded"
  | "submitting"
  | "submitted"
  | "failed-retryable"
  | "failed-nonretryable"
  | "reconciliation-required"
  | "cancelled";

export interface PublishProviderSnapshot {
  objectStorage: {
    provider: "aliyun-oss";
    /** 票 08 起：发布 egress 经运营网关（服务器侧重签），不再直连 OSS。 */
    endpointFamily: "gateway-oss-put";
    configured: boolean;
    configurationFingerprint: string | null;
  };
  distribution: {
    provider: "超级媒介";
    /** 票 08 起：下单经网关 port（服务器定价 + 预扣冻结 + sn 幂等）。 */
    endpointFamily: "gateway-order-api";
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
  /**
   * 该渠道单笔订单的点数单价（票 09）：媒介价 ×1.6 → 点数向上取整，
   * 由 Rust 在执行投影构建时按与网关 `publishOrderPoints` 同式的整数分
   * 运算算好——renderer 只展示，不重复实现倍率。
   */
  pricePoints: number;
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
  /** 全部发布项的点数总价（票 09）：逐项 pricePoints 之和，服务端算好。 */
  totalPricePoints: number;
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

/**
 * `prepare_publish` 工具结果的转录投影（聊天价格脱敏）：只携带点数字段
 * （budgetPoints / totalPricePoints / pricePoints），CNY 金额与换算倍率
 * 不进转录。服务端 `publishExecutionCardProjection` 产出，授权卡解析时
 * 水合为完整投影形状首渲染，3s 轮询 /latest 后由权威投影纠正。
 */
export interface PublishExecutionCardItem {
  id: string;
  status: PublishItemStatus;
  scheduledAt: string;
  article: { title: string; bodySummary: string };
  channel: {
    resourceId: number;
    kind: "media" | "we-media";
    name: string;
    pricePoints: number;
  };
}

export interface PublishExecutionCardProjection {
  id: string;
  revision: number;
  status: PublishExecutionStatus;
  workspaceId: string;
  distributionPlanId: string;
  publishStartAt: string;
  confirmationDigest: string;
  irreversibleImpact: string;
  totalPricePoints: number;
  budgetPoints: number;
  items: PublishExecutionCardItem[];
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

/** 取消发布（2026-09）：在途单跑完当前阶段，其余未完结条目转 cancelled。 */
export interface PublishCancelInput {
  executionId: string;
  expectedRevision: number;
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

// ---------------------------------------------------------------------------
// 渠道订单状态投影（票 09）
// ---------------------------------------------------------------------------

/**
 * 上游渠道订单状态码（超级媒介契约，与后端 `publish-orders` 状态机同源）：
 * 1 待处理、2 已拒稿、3 发布中、4 已发布、5 已取消、6 退款中、7 已退款、
 * 8 退款被拒、9 已关闭、10 补发中、11 已补发、12 已收录。
 */
export type PublishOrderUpstreamStatus =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12;

/** 状态码 → 文案映射（超级媒介契约 1–12）。 */
export const PUBLISH_ORDER_STATUS_LABEL: Record<
  PublishOrderUpstreamStatus,
  string
> = {
  1: "待处理",
  2: "已拒稿",
  3: "发布中",
  4: "已发布",
  5: "已取消",
  6: "退款中",
  7: "已退款",
  8: "退款被拒",
  9: "已关闭",
  10: "补发中",
  11: "已补发",
  12: "已收录",
};

/**
 * 是否为原路退点状态（后端 REFUND_STATUSES 同源）：已拒稿(2)、已取消(5)、
 * 已退款(7)。进入这些状态时订单点数退回余额，UI 需联动余额刷新展示。
 * 未知状态码（上游契约外的漂移）不判定退点，按需人工核对。
 */
export function publishOrderRefundsPoints(status: number | null): boolean {
  return status === 2 || status === 5 || status === 7;
}

/**
 * 订单是否仍在流转（客户端继续轮询查单投影）：未知（上游未返回，订单
 * 可能尚未受理）、待处理(1)、发布中(3)、退款中(6)。
 */
export function publishOrderStatusActive(status: number | null): boolean {
  return status === null || status === 1 || status === 3 || status === 6;
}

/** 用户可见的订单状态文案；颜色不是唯一载体，文案即状态。 */
export function publishOrderStatusLabel(status: number | null): string {
  if (status === null) return "订单尚未受理";
  return (
    PUBLISH_ORDER_STATUS_LABEL[status as PublishOrderUpstreamStatus] ??
    `渠道状态 ${status}`
  );
}

/**
 * 单个发布项的渠道订单状态投影（票 09）：Sidecar 用执行项确定性派生的
 * sn（`distributionOrderSn(executionId, itemId)`）查单后回给 renderer；
 * 计费权威在网关，本投影只承载展示。`screenshot` 为渠道回传的用户来源
 * HTML，仅经 renderer 现有 sanitize 栈渲染，绝不入持久层。
 */
export interface PublishOrderStatusEntry {
  itemId: string;
  sn: string;
  kind: "media" | "we-media";
  /** 渠道订单状态码（1–12 契约值原样透传）；上游未返回该 sn 时为 null。 */
  status: number | null;
  url: string | null;
  screenshot: string | null;
  publishedAt: string | null;
}
