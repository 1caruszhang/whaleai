import {
  distributionOrderSn,
  GeoCapabilityUnavailableError,
  GeoUpstreamHttpError,
  type GeoDistributionPlacedOrder,
  type GeoProviderCapabilities,
} from "./provider-capabilities";

/**
 * 发布执行器的 Provider egress（票 08 闭环）：Rust PublishScheduler 的两个
 * 外发动作（文章 HTML 上传、渠道下单）经本服务走 typed port——网关模式下
 * 由网关重签计费（`/gw/oss/*` 与 `/gw/distribution/{kind}/order`），
 * 直连模式仅为开发兜底（capability 自行决定），本层不感知传输细节。
 *
 * 结果一律分类为 Rust `PublishProviderOutcome` 的三态 + 成功：
 * - success：外发被受理，携带回执。
 * - safe-retryable：确定未被受理，可按既有退避安全重试。
 * - non-retryable：确定性拒绝（渠道拒单、网关 402 余额不足、未配置）。
 * - unknown：受理结果未知（传输中断、网关 5xx、成功信封不可解析），
 *   绝不自动重试，转人工核对。
 *
 * 下单幂等 sn 的单一权威在本层：按 `distributionOrderSn(executionId,
 * itemId)` 派生，调用方（Rust）只传 executionId + itemId。
 */

export type PublishEgressFailureOutcome = {
  outcome: "safe-retryable" | "non-retryable" | "unknown";
  code: string;
  reason: string;
};

export type PublishEgressUploadResult =
  | { outcome: "success"; objectUrl: string; externalContentId: string }
  | PublishEgressFailureOutcome;

export type PublishEgressOrderResult =
  | {
      outcome: "success";
      /** 网关/上游订单标识；partner_sn 未知时回退 sn（sn 即幂等主键）。 */
      externalOrderId: string;
      sn: string;
      partnerSn: string | null;
      points: number;
      ledgerStatus: GeoDistributionPlacedOrder["ledgerStatus"];
    }
  | PublishEgressFailureOutcome;

export interface PublishEgressUploadInput {
  executionId: string;
  itemId: string;
  objectKey: string;
  html: string;
}

export interface PublishEgressOrderInput {
  executionId: string;
  itemId: string;
  perArticleMaxPoints: number;
  executionMaxPoints: number;
  kind: "media" | "we-media";
  resourceId: number;
  title: string;
  /** 上传阶段落库的对象 URL（订单 content 参数，用户可点开预览）。 */
  contentUrl: string;
}

/** 自媒体订单结构三元组（上游契约；媒体订单不携带）。 */
const WE_MEDIA_STRUCTURAL_FIELDS = {
  publishForm: 1,
  publishType: 1,
  accountRule: 2,
} as const;

export class PublishEgressService {
  constructor(
    private readonly capabilities: Pick<
      GeoProviderCapabilities,
      "objectStorage" | "distribution"
    >,
  ) {}

  /**
   * 稳定对象键的 HTML 上传：网关用服务器 AK/SK 重签投 OSS。键幂等
   * （同键 PUT 可重放），除确定性拒绝外一切失败都可安全重试。
   */
  async upload(input: PublishEgressUploadInput): Promise<PublishEgressUploadResult> {
    try {
      const receipt = await this.capabilities.objectStorage.putHtml(
        input.objectKey,
        input.html,
      );
      if (typeof receipt.url !== "string" || receipt.url.length === 0) {
        return {
          outcome: "safe-retryable",
          code: "object-storage-response-invalid",
          reason: "上传未返回对象 URL，可安全重试稳定对象键",
        };
      }
      return {
        outcome: "success",
        objectUrl: receipt.url,
        externalContentId: input.objectKey,
      };
    } catch (error) {
      return classifyUploadFailure(error);
    }
  }

  /**
   * 渠道下单：sn 由 (executionId, itemId) 确定性派生（幂等权威在网关
   * publish_orders 表）；自媒体订单自动携带结构三元组。网关按服务器侧
   * 渠道价预扣冻结，查单/回调驱动结转退点——本层只回传受理回执。
   */
  async placeOrder(
    input: PublishEgressOrderInput,
  ): Promise<PublishEgressOrderResult> {
    const sn = distributionOrderSn(input.executionId, input.itemId);
    try {
      const placed = await this.capabilities.distribution.placeOrder(
        input.kind,
        {
          sn,
          executionId: input.executionId,
          itemId: input.itemId,
          perArticleMaxPoints: input.perArticleMaxPoints,
          executionMaxPoints: input.executionMaxPoints,
          resourceId: input.resourceId,
          title: input.title,
          contentUrl: input.contentUrl,
          ...(input.kind === "we-media" ? WE_MEDIA_STRUCTURAL_FIELDS : {}),
        },
      );
      return {
        outcome: "success",
        externalOrderId: placed.partnerSn ?? sn,
        sn: placed.sn,
        partnerSn: placed.partnerSn,
        points: placed.points,
        ledgerStatus: placed.ledgerStatus,
      };
    } catch (error) {
      return classifyOrderFailure(error);
    }
  }
}

/**
 * 上传失败分类：稳定键 PUT 幂等——除「确定性拒绝」（网关明确 4xx 且
 * 非限流/非服务端故障、能力未配置）外，传输中断与服务端故障都可安全
 * 重试（重试只会把同一键重写一遍）。
 */
function classifyUploadFailure(error: unknown): PublishEgressUploadResult {
  if (error instanceof GeoCapabilityUnavailableError) {
    return unavailable("object-storage");
  }
  if (error instanceof GeoUpstreamHttpError) {
    if (error.status === 429 || error.status >= 500) {
      return retryable("object-storage", error, "可安全重试稳定对象键");
    }
    return rejected("object-storage", error);
  }
  return {
    outcome: "safe-retryable",
    code: "object-storage-transport",
    reason: "上传传输中断，可安全重试稳定对象键",
  };
}

/**
 * 下单失败分类（对齐 Rust `PublishProviderOutcome` 既有语义）：
 * - 402：余额不足 → NonRetryable（提示充值，绝不静默重试）。
 * - 429：明确限流未受理 → SafeRetryable（同 sn 重放不重复扣点）。
 * - 5xx：受理结果未知 → Unknown（可能已预扣/已受理，人工核对）。
 * - 其余 4xx：网关确定性拒绝（sn 冲突、参数校验、鉴权失败）→ NonRetryable。
 * - 传输中断/响应不可解析：可能已受理 → Unknown。
 */
function classifyOrderFailure(error: unknown): PublishEgressOrderResult {
  if (error instanceof GeoCapabilityUnavailableError) {
    return unavailable("distribution");
  }
  if (error instanceof GeoUpstreamHttpError) {
    if (error.status === 402) {
      return {
        outcome: "non-retryable",
        code: "distribution-insufficient-balance",
        reason: `${error.message}（请充值后重新发起发布）`,
      };
    }
    if (error.status === 429) {
      return retryable("distribution", error, "渠道明确限流，尚未受理，可安全重试");
    }
    if (error.status >= 500) {
      return unknown(error, "渠道服务异常，受理结果未知，必须人工核对");
    }
    return rejected("distribution", error);
  }
  return unknown(error, "下单响应未知，可能已受理，必须人工核对");
}

function unavailable(
  slot: "object-storage" | "distribution",
): PublishEgressFailureOutcome {
  return {
    outcome: "non-retryable",
    code: `${slot}-egress-unconfigured`,
    reason: `${slot} 发布出口未配置（需要账号 admission 注入网关地址与账号 token）`,
  };
}

function retryable(
  slot: "object-storage" | "distribution",
  error: GeoUpstreamHttpError,
  reason: string,
): PublishEgressFailureOutcome {
  return {
    outcome: "safe-retryable",
    code: `${slot}-http-${error.status}`,
    reason,
  };
}

function rejected(
  slot: "object-storage" | "distribution",
  error: GeoUpstreamHttpError,
): PublishEgressFailureOutcome {
  return {
    outcome: "non-retryable",
    code:
      error.errorCode !== undefined
        ? `${slot}-gateway-${error.errorCode}`
        : `${slot}-http-${error.status}`,
    reason: error.message,
  };
}

function unknown(
  error: unknown,
  reason: string,
): PublishEgressFailureOutcome {
  return {
    outcome: "unknown",
    code: error instanceof GeoUpstreamHttpError
      ? `distribution-http-${error.status}-unknown`
      : "distribution-transport-unknown",
    reason,
  };
}
