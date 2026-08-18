import { CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  confirmTopicPlan,
  loadLatestTopicPlan,
  saveTopicPlanItems,
} from "@/api/topicPlanClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  TopicPlanItem,
  TopicPlanProjection,
} from "../../../shared/geo/topicPlan";
import { unwrapToolResultText } from "../../../shared/toolResult";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 内容计划确认卡：内容由 plan_topics 的工具结果携带。用户在卡上
 * 勾选批准计划项并确认：确认点击先把勾选批准经 /topic-plans/items
 * （user-edit mutation）落盘——confirm 只接受持久化 approved 的 selected
 * IDs——再走既有 /topic-plans/confirm（CAS revision）；确认后 reminder
 * 通知 agent 继续。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订的选题按服务端胜合并——
 * 内容被改/被删/新增的项采信服务端，未改项保留本地批准勾选。
 */
export interface TopicPlanGateCardData {
  kind: "topic-plan";
  plan: TopicPlanProjection;
}

function isPlan(value: unknown): value is TopicPlanProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TopicPlanProjection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.items) &&
    Array.isArray(candidate.topics)
  );
}

function parseEnvelope(value: unknown): TopicPlanGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parseTopicPlanGateCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: unknown;
    plan?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parseTopicPlanGateCard(text) : null;
  }
  if (envelope.kind === "topic-plan" && isPlan(envelope.plan)) {
    return { kind: "topic-plan", plan: envelope.plan };
  }
  return null;
}

export function parseTopicPlanGateCard(
  result: string,
): TopicPlanGateCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

const TYPE_LABELS: Record<TopicPlanItem["contentType"], string> = {
  guide: "指南",
  showcase: "品牌详情",
  ranking: "对比清单",
  news: "深度新闻",
  news_light: "轻量新闻",
};

export default function TopicPlanGateCard({
  data,
}: {
  data: TopicPlanGateCardData;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [plan, setPlan] = useState<TopicPlanProjection>(data.plan);
  const topicNames = useMemo(
    () => new Map(plan.topics.map((topic) => [topic.id, topic.name])),
    [plan.topics],
  );
  const [approvedIds, setApprovedIds] = useState<Set<string>>(
    () =>
      new Set(
        data.plan.items
          .filter((item) => item.approvalStatus === "approved")
          .map((item) => item.id),
      ),
  );
  const [confirmed, setConfirmed] = useState(data.plan.status === "confirmed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  // 服务端胜（票 38）：内容（标题/类型/选择理由）被服务端修订的项按服务端
  // 批准态重渲染；未改项保留本地勾选；被删项消失、新增项默认未批准。
  const initialFingerprints = useMemo(
    () =>
      new Map(
        data.plan.items.map((item) => [
          item.id,
          `${item.title}|${item.contentType}|${item.typeSelectionReason}`,
        ]),
      ),
    [data.plan.items],
  );
  const mergeRefreshed = useCallback(
    (latest: TopicPlanProjection) => {
      setPlan(latest);
      if (latest.status === "confirmed") setConfirmed(true);
      setApprovedIds((current) => {
        const next = new Set<string>();
        for (const incoming of latest.items) {
          const fingerprint = `${incoming.title}|${incoming.contentType}|${incoming.typeSelectionReason}`;
          const unchanged =
            initialFingerprints.get(incoming.id) === fingerprint;
          if (unchanged ? current.has(incoming.id) : incoming.approvalStatus === "approved") {
            next.add(incoming.id);
          }
        }
        return next;
      });
    },
    [initialFingerprints],
  );
  useGateCardRefresh<TopicPlanProjection>({
    enabled: !confirmed && hasRealSession,
    projectionId: data.plan.id,
    initialFingerprint: String(data.plan.revision),
    fingerprintOf: (latest) => String(latest.revision),
    fetchLatest: () =>
      loadLatestTopicPlan(
        apiPost,
        { workspaceId: data.plan.workspaceId, sessionId: sessionId ?? "" },
      ),
    onChange: mergeRefreshed,
  });

  const confirm = async () => {
    if (!sessionId || !hasRealSession || busy || approvedIds.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      // 勾选只是本地暂存；服务端 confirm 校验持久化 approvalStatus，
      // 因此先经 user-edit mutation 把勾选批准落盘，再用新 revision 确认。
      let revision = plan.revision;
      if (
        plan.items.some(
          (item) =>
            approvedIds.has(item.id) && item.approvalStatus !== "approved",
        )
      ) {
        const mutation = await saveTopicPlanItems(
          apiPost,
          { workspaceId: plan.workspaceId, sessionId },
          {
            planId: plan.id,
            expectedRevision: plan.revision,
            items: plan.items.map((item) => ({
              ...item,
              approvalStatus: approvedIds.has(item.id)
                ? ("approved" as const)
                : item.approvalStatus,
            })),
          },
        );
        revision = mutation.plan.revision;
        setPlan(mutation.plan);
      }
      await confirmTopicPlan(
        apiPost,
        { workspaceId: plan.workspaceId, sessionId },
        {
          planId: plan.id,
          expectedRevision: revision,
          selectedItemIds: [...approvedIds],
        },
      );
      setConfirmed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="内容计划确认"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-topic-plan-gate-card={plan.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          知识 v{plan.knowledgeVersion}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {plan.topics.length} 个主题 · {plan.items.length} 个计划项
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {plan.reused ? "已复用计划" : "本轮新规划"}
        </span>
        <span className="ml-auto">已批准 {approvedIds.size}/{plan.items.length}</span>
      </div>

      <div className="mt-2 space-y-2">
        {plan.items.map((item) => {
          const checked = approvedIds.has(item.id);
          return (
            <article
              key={item.id}
              className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
            >
              <div className="flex items-start gap-2">
                {!confirmed && (
                  <input
                    type="checkbox"
                    aria-label={`批准 ${item.title}`}
                    checked={checked}
                    onChange={(event) =>
                      setApprovedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                    className="mt-1"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap gap-1 text-xs text-[var(--ink-muted)]">
                    <span>{topicNames.get(item.topicId) ?? "主题"}</span>
                    <span>· {TYPE_LABELS[item.contentType]}</span>
                    <span>· 来源问题 {item.sourceQuestionIds.length}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium leading-5">{item.title}</p>
                  <p className="mt-1 text-xs leading-4 text-[var(--ink-muted)]">
                    {item.typeSelectionReason}
                  </p>
                  <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
                    拟覆盖事实：{item.plannedFacts.map((fact) => fact.predicate).join("、")}
                  </p>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {confirmed ? (
        <p className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--success-bg)] p-2 text-sm text-[var(--success)]">
          <CheckCircle2 className="h-4 w-4" />
          内容计划已确认（{approvedIds.size} 项）；小鲸会继续生成文章。
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            void confirm();
          }}
          disabled={busy || approvedIds.size === 0 || !hasRealSession}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          确认内容计划（{approvedIds.size}）
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words rounded-lg bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
        这是系统维护的确认卡片，不是用户发送的消息；只有你在此批准并确认的计划项才会进入文章生成。
      </p>
    </section>
  );
}
