import type { PublishItemProjection } from "../../../shared/geo/publishScheduler";

export type PublishStageTone = "done" | "active" | "pending" | "failed";

export interface PublishStageBadge {
  label: string;
  tone: PublishStageTone;
}

function isFailure(item: PublishItemProjection): boolean {
  return (
    item.status === "failed-retryable" ||
    item.status === "failed-nonretryable" ||
    item.status === "reconciliation-required"
  );
}

/**
 * 发布条目的两段式状态（参考 js_ai 的排期卡设计）：每个条目先由调度器
 * 上传批准稿到 OSS，再向超级媒介创建订单。两段各自独立呈现，失败按
 * objectUrl 是否已产出归属到对应一段。
 */
export function ossStage(item: PublishItemProjection): PublishStageBadge {
  if (item.objectUrl) return { label: "OSS 已上传", tone: "done" };
  if (item.status === "uploading") return { label: "OSS 上传中", tone: "active" };
  if (isFailure(item)) return { label: "OSS 上传失败", tone: "failed" };
  return { label: "OSS 未上传", tone: "pending" };
}

export function orderStage(item: PublishItemProjection): PublishStageBadge {
  if (item.externalOrderId)
    return { label: "订单已提交", tone: "done" };
  if (item.status === "submitting")
    return { label: "订单提交中", tone: "active" };
  if (item.status === "submitted")
    return { label: "渠道已受理", tone: "done" };
  if (item.status === "reconciliation-required")
    return { label: "提交结果未知", tone: "failed" };
  if (isFailure(item)) return { label: "订单提交失败", tone: "failed" };
  return { label: "订单未提交", tone: "pending" };
}

/**
 * 渠道订单上游状态（票 09，1–12 契约值）的徽章色调。颜色不是唯一载体：
 * 文案由 publishOrderStatusLabel 给出，这里只做辅助层级——已发布/补发
 * 完成为完成态，发布中/退款中/补发中为流转态，拒稿/取消/退款被拒为
 * 失败态，未受理与已退款/已关闭为中性态。
 */
export function orderStatusTone(status: number | null): PublishStageTone {
  if (status === 4 || status === 11 || status === 12) return "done";
  if (status === 3 || status === 6 || status === 10) return "active";
  if (status === 2 || status === 5 || status === 8) return "failed";
  return "pending";
}

/** 两段徽章渲染共用的样式映射。 */
export const PUBLISH_STAGE_TONE_CLASS: Record<PublishStageTone, string> = {
  done: "bg-[var(--success)]/10 text-[var(--success)]",
  active: "bg-[var(--accent)]/10 text-[var(--accent)]",
  pending: "bg-[var(--paper-inset)] text-[var(--ink-muted)]",
  failed: "bg-[var(--error)]/10 text-[var(--error)]",
};
