import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";
import { useCallback, useState } from "react";

import {
  confirmPublishExecution,
  loadLatestPublishExecution,
  loadPublishExecution,
  startPublishExecution,
} from "@/api/publishSchedulerClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  PublishExecutionProjection,
  PublishItemProjection,
} from "../../../shared/geo/publishScheduler";
import { unwrapToolResultText } from "../../../shared/toolResult";
import {
  orderStage,
  ossStage,
  PUBLISH_STAGE_TONE_CLASS,
  type PublishStageBadge,
} from "./publishStageStatus";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 付费发布授权卡：内容由 prepare_publish 的工具结果携带。不可逆授权与
 * 启动发布只能由用户在本卡完成（走 Rust UI 命令，Agent 无权跨越）；
 * 与工作台面板共用同一授权端点。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订（预算/排期）重算确认
 * 摘要，卡片采信新摘要并重置不可逆确认勾选，用户必须重新核对后授权。
 * 启动后进入「发布状态」视图（参考 js_ai 的监控卡设计）：逐条目呈现
 * OSS 上传与超级媒介订单两段状态，非终态期间继续轮询并支持手动刷新。
 */
export interface PublishAuthorizationGateCardData {
  kind: "publish-execution";
  execution: PublishExecutionProjection;
}

function isExecution(value: unknown): value is PublishExecutionProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublishExecutionProjection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.items)
  );
}

function parseEnvelope(value: unknown): PublishAuthorizationGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parsePublishAuthorizationGateCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: unknown;
    execution?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parsePublishAuthorizationGateCard(text) : null;
  }
  if (
    envelope.kind === "publish-execution" &&
    isExecution(envelope.execution)
  ) {
    return { kind: "publish-execution", execution: envelope.execution };
  }
  return null;
}

export function parsePublishAuthorizationGateCard(
  result: string,
): PublishAuthorizationGateCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

const KIND_LABEL = { media: "媒体", "we-media": "自媒体" } as const;

const EXECUTION_STATUS_LABEL: Record<PublishExecutionProjection["status"], string> =
  {
    "awaiting-confirmation": "待独立确认",
    confirmed: "已确认，尚未开始",
    running: "执行中",
    scheduled: "已排期，等待调度",
    "partially-succeeded": "部分成功",
    succeeded: "已提交完成",
    failed: "执行失败",
    superseded: "已被新预览替代",
    "reconciliation-required": "需要人工核对",
  };

/** 启动后的非终态：继续轮询直至调度器收敛到终态。 */
const POST_START_ACTIVE = new Set<PublishExecutionProjection["status"]>([
  "running",
  "scheduled",
  "partially-succeeded",
  "reconciliation-required",
]);

function progressFingerprint(execution: PublishExecutionProjection): string {
  return [
    execution.revision,
    execution.status,
    execution.items
      .map(
        (item) =>
          `${item.status}:${item.objectUrl ? 1 : 0}:${item.externalOrderId ?? "-"}:${item.attempts}:${item.uploadAttempts}:${item.nextAttemptAt ?? "-"}`,
      )
      .join("|"),
  ].join(":");
}

function StageBadge({ badge }: { badge: PublishStageBadge }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 ${PUBLISH_STAGE_TONE_CLASS[badge.tone]}`}
    >
      {badge.tone === "active" && (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      )}
      {badge.label}
    </span>
  );
}

function PublishStatusItem({ item }: { item: PublishItemProjection }) {
  return (
    <article
      className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
      data-publish-item={item.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium leading-5">
            {item.article.title}
          </p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {item.channel.name}（{KIND_LABEL[item.channel.kind]}）· 排期{" "}
            {new Date(item.scheduledAt).toLocaleString()}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-subtle)]">
          <CloudUpload className="h-3 w-3" aria-hidden="true" />
        </span>
        <StageBadge badge={ossStage(item)} />
        <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-subtle)]">
          <Send className="h-3 w-3" aria-hidden="true" />
        </span>
        <StageBadge badge={orderStage(item)} />
      </div>
      {item.objectUrl && (
        <a
          href={item.objectUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 block truncate text-xs text-[var(--accent)] underline"
        >
          {item.objectUrl}
        </a>
      )}
      {item.externalOrderId && (
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          超级媒介订单：{item.externalOrderId}
        </p>
      )}
      {item.failureReason && (
        <p className="mt-1 break-words text-xs text-[var(--error)]">
          {item.failureCode ? `${item.failureCode}：` : ""}
          {item.failureReason}
        </p>
      )}
      {item.status === "failed-retryable" && item.nextAttemptAt && (
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          将于 {new Date(item.nextAttemptAt).toLocaleString()} 自动重试。
        </p>
      )}
    </article>
  );
}

export default function PublishAuthorizationGateCard({
  data,
}: {
  data: PublishAuthorizationGateCardData;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [execution, setExecution] = useState(data.execution);
  const [status, setStatus] = useState(data.execution.status);
  const [confirmedImpact, setConfirmedImpact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  // 修订（预算/排期）会重算确认摘要：卡片采信新投影并要求用户重新核对；
  // 已勾选的不可逆确认随之重置，防止拿旧印象确认新内容。启动后的发布
  // 进度同样走这条「服务端胜」合并。
  const mergeRefreshed = useCallback(
    (latest: PublishExecutionProjection) => {
      setExecution(latest);
      setStatus(latest.status);
      setConfirmedImpact(false);
    },
    [],
  );
  useGateCardRefresh<PublishExecutionProjection>({
    enabled:
      hasRealSession &&
      (status === "awaiting-confirmation" || POST_START_ACTIVE.has(status)),
    projectionId: data.execution.id,
    initialFingerprint: progressFingerprint(data.execution),
    fingerprintOf: progressFingerprint,
    fetchLatest: () =>
      loadLatestPublishExecution(data.execution.workspaceId),
    onChange: mergeRefreshed,
  });
  const identity = { workspaceId: execution.workspaceId, sessionId: sessionId ?? "" };

  const confirm = async () => {
    if (busy || !confirmedImpact) return;
    setBusy(true);
    setError(null);
    try {
      const next = await confirmPublishExecution(identity, {
        executionId: execution.id,
        expectedRevision: execution.revision,
        confirmationDigest: execution.confirmationDigest,
      });
      // confirm 会把 revision+1：必须采信服务端权威投影，否则随后的
      // 「开始确定性发布」带着过期 revision 提交，被 CAS 判为冲突。
      mergeRefreshed(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await startPublishExecution(identity, {
        executionId: execution.id,
        expectedRevision: execution.revision,
      });
      mergeRefreshed(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshStatus = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      mergeRefreshed(
        await loadPublishExecution(apiPost, identity, execution.id),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const disabled = !sessionId || isPendingSessionId(sessionId);

  return (
    <section
      aria-label="付费发布授权"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-publish-gate-card={execution.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          预计 ¥{execution.estimatedSpendCny.toFixed(2)} / 预算 ¥
          {execution.budgetCny.toFixed(2)}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {execution.items.length} 个发布项
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          计划发布 {new Date(execution.publishStartAt).toLocaleString()}
        </span>
      </div>

      <div className="mt-2 space-y-2">
        {execution.items.map((item) => (
          <article
            key={item.id}
            className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
          >
            <p className="text-sm font-medium leading-5">{item.article.title}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              {item.channel.name}（{KIND_LABEL[item.channel.kind]}）· 预计 ¥
              {item.channel.estimatedPriceCny.toFixed(2)} · 排期{" "}
              {new Date(item.scheduledAt).toLocaleString()}
            </p>
            <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
              {item.article.bodySummary}
            </p>
          </article>
        ))}
      </div>

      {status === "awaiting-confirmation" && (
        <div className="mt-2 rounded-lg border border-[var(--warning)] bg-[var(--warning-bg)] p-3">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs leading-5">{execution.irreversibleImpact}</p>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5">
            <input
              type="checkbox"
              checked={confirmedImpact}
              onChange={(event) => setConfirmedImpact(event.target.checked)}
              aria-label="确认最终文章渠道预算排期和不可逆影响"
              className="mt-0.5"
            />
            我已核对上述最终批准文章、渠道、价格、预算和排期，并明确授权创建此发布执行。
          </label>
          <button
            type="button"
            onClick={() => {
              void confirm();
            }}
            disabled={!confirmedImpact || busy || disabled}
            className="mt-3 w-full rounded-lg bg-[var(--danger)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "确认中…" : "独立确认发布执行"}
          </button>
        </div>
      )}

      {status === "confirmed" && (
        <button
          type="button"
          onClick={() => {
            void start();
          }}
          disabled={busy || disabled}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          开始确定性发布
        </button>
      )}

      {POST_START_ACTIVE.has(status) && (
        <div
          className="mt-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-2"
          data-publish-status={execution.id}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">发布状态</span>
            <span className="rounded-full bg-[var(--paper-elevated)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
              {EXECUTION_STATUS_LABEL[status]}
            </span>
            <button
              type="button"
              onClick={() => {
                void refreshStatus();
              }}
              disabled={busy || disabled}
              aria-label="刷新发布状态"
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              />
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {execution.items.map((item) => (
              <PublishStatusItem key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {status === "succeeded" && (
        <div
          className="mt-2 rounded-lg bg-[var(--success-bg)] p-2"
          data-publish-status={execution.id}
        >
          <p className="flex items-center gap-2 text-sm text-[var(--success)]">
            <CheckCircle2 className="h-4 w-4" />
            {execution.items.length} 个发布项均已由超级媒介受理。
          </p>
          <div className="mt-2 space-y-2">
            {execution.items.map((item) => (
              <PublishStatusItem key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {status === "failed" && (
        <p
          role="alert"
          className="mt-2 rounded-lg bg-[var(--error-bg)] p-2 text-sm text-[var(--error)]"
        >
          发布执行失败：失败的发布项与原因见下方状态，可在聊天中让小鲸重试失败项。
        </p>
      )}
      {status === "failed" &&
        execution.items.some((item) => item.status !== "submitted") && (
          <div className="mt-2 space-y-2">
            {execution.items
              .filter((item) => item.status !== "submitted")
              .map((item) => (
                <PublishStatusItem key={item.id} item={item} />
              ))}
          </div>
        )}

      {error && (
        <p role="alert" className="mt-2 break-words rounded-lg bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
        这是系统维护的确认卡片，不是用户发送的消息；付费、上传与外部发布的不可逆授权只能由你在此完成。
      </p>
    </section>
  );
}
