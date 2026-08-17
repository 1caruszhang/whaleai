import { AlertTriangle, CheckCircle2, Clock3, Rocket } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import {
  loadLatestPublishExecution,
  loadPublishExecution,
} from "@/api/publishSchedulerClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  PublishExecutionProjection,
  PublishItemProjection,
} from "../../../shared/geo/publishScheduler";

interface XiaojingPublishSchedulerPanelProps {
  workspaceId: string;
  executionId?: string;
  /** 会话内工具推进后的产物刷新信号（票 29：面板只读化后的刷新联动）。 */
  refreshKey?: number;
}

const STATUS_LABEL: Record<PublishExecutionProjection["status"], string> = {
  "awaiting-confirmation": "待独立确认",
  confirmed: "已确认，尚未开始",
  running: "执行中",
  scheduled: "已排期",
  "partially-succeeded": "部分成功",
  succeeded: "已提交完成",
  failed: "执行失败",
  superseded: "已被新预览替代",
  "reconciliation-required": "需要人工核对",
};

const ITEM_STATUS_LABEL: Record<PublishItemProjection["status"], string> = {
  pending: "等待排期",
  uploading: "上传正文中",
  uploaded: "正文已上传",
  submitting: "渠道受理中",
  submitted: "渠道已受理",
  "failed-retryable": "可安全重试",
  "failed-nonretryable": "不可自动重试",
  "reconciliation-required": "结果未知，需人工核对",
};

/**
 * 票 29：发布阶段面板是纯只读投影。预览、不可逆授权、启动与失败项
 * 重试只出现在聊天里的卡片（PublishAuthorizationGateCard，授权走 Rust
 * UI 命令）上。
 */
export default memo(function XiaojingPublishSchedulerPanel({
  workspaceId,
  executionId,
  refreshKey = 0,
}: XiaojingPublishSchedulerPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [execution, setExecution] = useState<PublishExecutionProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const identity = useMemo(
    () =>
      sessionId && !isPendingSessionId(sessionId)
        ? { workspaceId, sessionId }
        : null,
    [sessionId, workspaceId],
  );

  useEffect(() => {
    if (!identity) return;
    let active = true;
    void (executionId
      ? loadPublishExecution(apiPost, identity, executionId)
      : loadLatestPublishExecution(apiPost, identity))
      .then((value) => {
        if (!active) return;
        setError(null);
        setExecution(value);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [apiPost, executionId, identity, refreshKey]);

  return (
    <section
      aria-label="确定性发布计划"
      className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-4 py-3">
        <Rocket className="h-4 w-4 text-[var(--accent)]" />
        <h3 className="text-sm font-semibold">确定性发布</h3>
        {execution && (
          <span className="ml-auto text-xs text-[var(--ink-muted)]">
            {STATUS_LABEL[execution.status]}
          </span>
        )}
      </div>

      <div className="space-y-3 p-4 text-xs">
        {!identity ? (
          <p className="text-[var(--ink-muted)]">建立真实会话后才能查看发布计划。</p>
        ) : !execution ? (
          <p className="leading-5 text-[var(--ink-muted)]">
            {error
              ? null
              : "暂无发布执行。发布预览从已确认分发计划创建；此步不会上传、扣费或下单。"}
          </p>
        ) : (
          <>
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-3">
              <div className="flex items-center justify-between gap-2">
                <strong>执行快照 #{execution.revision}</strong>
              </div>
              <p className="mt-2 text-[var(--ink-muted)]">
                分发计划 {execution.distributionPlanId} · revision {execution.distributionPlanRevision}
              </p>
              <p className="mt-1">
                预计 ¥{execution.estimatedSpendCny.toFixed(2)} / 预算 ¥{execution.budgetCny.toFixed(2)}
              </p>
              <p className="mt-1 flex items-center gap-1 text-[var(--ink-muted)]">
                <Clock3 className="h-3.5 w-3.5" /> {new Date(execution.publishStartAt).toLocaleString()}
              </p>
            </div>

            {execution.items.map((item) => (
              <article key={item.id} className="rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <strong>{item.article.title}</strong>
                  <span className="shrink-0 text-[var(--ink-muted)]">{ITEM_STATUS_LABEL[item.status]}</span>
                </div>
                <p className="mt-1 text-[var(--ink-muted)]">
                  批准 revision {item.article.approvedRevision} · SHA-256 {item.article.approvedBodySha256.slice(0, 12)}… · {item.article.bodyBytes} bytes
                </p>
                <p className="mt-2 leading-5">{item.article.bodySummary}</p>
                <div className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2 leading-5">
                  <p>{item.channel.name}（{item.channel.kind === "media" ? "媒体" : "自媒体"}）</p>
                  <p>资源 #{item.channel.resourceId} · 预计 ¥{item.channel.estimatedPriceCny.toFixed(2)} · 历史发布率 {item.channel.publishedRate}%</p>
                  <p>排期：{new Date(item.scheduledAt).toLocaleString()}</p>
                </div>
                {item.externalOrderId && <p className="mt-2 text-[var(--success)]">外部订单：{item.externalOrderId}</p>}
                {item.failureReason && <p className="mt-2 text-[var(--danger)]">{item.failureReason}</p>}
              </article>
            ))}

            {execution.status === "awaiting-confirmation" && (
              <div className="rounded-xl border border-[var(--warning)] bg-[var(--warning-bg)] p-3">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="leading-5">{execution.irreversibleImpact}</p>
                </div>
                <p className="mt-3 leading-5 text-[var(--ink-muted)]">
                  发布授权是不可逆操作：请回到聊天中的确认卡片核对并完成授权。
                </p>
              </div>
            )}

            {execution.status === "confirmed" && (
              <p className="leading-5 text-[var(--ink-muted)]">
                发布执行已确认：请在聊天中的确认卡片启动发布。
              </p>
            )}

            {execution.status === "succeeded" && (
              <p className="flex items-center gap-2 text-[var(--success)]">
                <CheckCircle2 className="h-4 w-4" /> 所有稳定发布项均已由渠道受理。
              </p>
            )}
          </>
        )}

        {error && <p className="rounded-lg bg-[var(--danger-bg)] p-2 text-[var(--danger)]">{error}</p>}
      </div>
    </section>
  );
});
