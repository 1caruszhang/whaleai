import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import {
  confirmPublishExecution,
  loadLatestPublishExecution,
  startPublishExecution,
} from "@/api/publishSchedulerClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type { PublishExecutionProjection } from "../../../shared/geo/publishScheduler";
import { unwrapToolResultText } from "../../../shared/toolResult";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 付费发布授权卡：内容由 prepare_publish 的工具结果携带。不可逆授权与
 * 启动发布只能由用户在本卡完成（走 Rust UI 命令，Agent 无权跨越）；
 * 与工作台面板共用同一授权端点。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订（预算/排期）重算确认
 * 摘要，卡片采信新摘要并重置不可逆确认勾选，用户必须重新核对后授权。
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
  // 已勾选的不可逆确认随之重置，防止拿旧印象确认新内容。
  const mergeRefreshed = useCallback(
    (latest: PublishExecutionProjection) => {
      setExecution(latest);
      setStatus(latest.status);
      setConfirmedImpact(false);
    },
    [],
  );
  useGateCardRefresh<PublishExecutionProjection>({
    enabled: status === "awaiting-confirmation" && hasRealSession,
    projectionId: data.execution.id,
    initialFingerprint: `${data.execution.revision}:${data.execution.confirmationDigest}`,
    fingerprintOf: (latest) =>
      `${latest.revision}:${latest.confirmationDigest}`,
    fetchLatest: () =>
      loadLatestPublishExecution(apiPost, {
        workspaceId: data.execution.workspaceId,
        sessionId: sessionId ?? "",
      }),
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
      setStatus(next.status);
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
      setStatus(next.status);
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

      {(status === "succeeded" || status === "scheduled" || status === "running") && (
        <p className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--success-bg)] p-2 text-sm text-[var(--success)]">
          <CheckCircle2 className="h-4 w-4" />
          发布执行已由渠道受理/推进中，后续进展由监测跟进。
        </p>
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
