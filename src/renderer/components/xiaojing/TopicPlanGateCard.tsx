import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  confirmTopicPlan,
  loadLatestTopicPlan,
  regenerateTopicPlan,
  saveTopicPlanItems,
} from "@/api/topicPlanClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  TOPIC_PLAN_REUSE_OUTCOME,
  type TopicPlanCardProjection,
  type TopicPlanItem,
  type TopicPlanProjection,
} from "../../../shared/geo/topicPlan";
import { unwrapToolResultText } from "../../../shared/toolResult";
import GateCardFooter, { GateCardSuccess } from "./GateCardFooter";
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
  /** 复用命中信封携带（TOPIC_PLAN_REUSE_OUTCOME）：confirmed 计划 +
   * 本标记 → 重选模式（预勾上次的已批准项，可收窄），用户沿用确认或
   * 付费重新生成；内容计划门只在用户的卡片确认后放行。未知 outcome
   * 按旧信封处理（只读展示）。 */
  outcome?: typeof TOPIC_PLAN_REUSE_OUTCOME;
  /** plan_topics 信封携带瘦身投影（审计字段与事实详情已剔除，防超限
   * 被 MCP 宿主客户端持久化成文件导致卡片不渲染）；/latest 轮询返回的
   * 完整投影结构兼容（字段只多不少）。 */
  plan: TopicPlanCardProjection;
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
    outcome?: unknown;
    plan?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parseTopicPlanGateCard(text) : null;
  }
  if (envelope.kind === "topic-plan" && isPlan(envelope.plan)) {
    return {
      kind: "topic-plan",
      outcome:
        envelope.outcome === TOPIC_PLAN_REUSE_OUTCOME
          ? TOPIC_PLAN_REUSE_OUTCOME
          : undefined,
      plan: envelope.plan,
    };
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
  const [plan, setPlan] = useState<TopicPlanCardProjection>(data.plan);
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
  // 复用命中（TOPIC_PLAN_REUSE_OUTCOME）：confirmed 计划停卡重选——预勾
  // 上次的已批准项、可收窄（未批准项在冻结计划上不可新勾），「沿用此计划」
  // 走同一 confirm 端点（Rust 允许对 confirmed 计划再确认）；无 outcome 的
  // confirmed 计划是旧信封，保持只读成功态兼容。
  const [reselect, setReselect] = useState(
    data.outcome === TOPIC_PLAN_REUSE_OUTCOME && data.plan.status === "confirmed",
  );
  const [initiallyConfirmed] = useState(
    data.plan.status === "confirmed" && data.outcome !== TOPIC_PLAN_REUSE_OUTCOME,
  );
  const [confirmed, setConfirmed] = useState(initiallyConfirmed);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
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
    (latest: TopicPlanCardProjection) => {
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
  useGateCardRefresh<TopicPlanCardProjection>({
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
    if (!sessionId || !hasRealSession || busy || regenerating || approvedIds.size === 0) return;
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

  // 「重新生成内容计划」：跳过零成本复用、强制重新规划（真实 provider
  // 花费）；成功后以正常待决流程呈现新计划。
  const regenerate = async () => {
    if (!sessionId || !hasRealSession || regenerating || busy) return;
    setRegenerating(true);
    setError(null);
    try {
      const fresh = await regenerateTopicPlan(
        apiPost,
        { workspaceId: plan.workspaceId, sessionId },
        {},
      );
      setPlan(fresh);
      setApprovedIds(
        new Set(fresh.items.filter((item) => item.approvalStatus === "approved").map((item) => item.id)),
      );
      setReselect(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRegenerating(false);
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

      <div className="mt-2 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
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
                    // 重选模式：冻结计划只允许收窄（取消已批准项），未批准
                    // 项不可新勾（改内容须走「重新生成内容计划」）。
                    disabled={reselect && item.approvalStatus !== "approved"}
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

      {error && (
        <p role="alert" className="mt-2 break-words rounded-lg bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      <GateCardFooter
        note={
          confirmed
            ? undefined
            : reselect
              ? "已复用此前确认的内容计划——预勾上次的已批准项，可收窄后沿用"
              : "确认后进入文章生成"
        }
      >
        {confirmed ? (
          <GateCardSuccess>内容计划已确认（{approvedIds.size}）</GateCardSuccess>
        ) : (
          <>
            {reselect && (
              <button
                type="button"
                onClick={() => {
                  void regenerate();
                }}
                disabled={regenerating || busy || !hasRealSession}
                className="flex items-center gap-1.5 rounded-md bg-[var(--paper-inset)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] disabled:opacity-50"
              >
                {regenerating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                重新生成内容计划
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void confirm();
              }}
              disabled={busy || regenerating || approvedIds.size === 0 || !hasRealSession}
              className="flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {reselect ? `沿用此计划（${approvedIds.size}）` : `确认内容计划（${approvedIds.size}）`}
            </button>
          </>
        )}
      </GateCardFooter>
    </section>
  );
}
