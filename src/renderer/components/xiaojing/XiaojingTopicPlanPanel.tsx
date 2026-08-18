import { Sparkles } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { loadLatestTopicPlan } from "@/api/topicPlanClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  type TopicPlanProjection,
} from "../../../shared/geo/topicPlan";
import { CONTENT_TYPE_LABELS } from "./contentTypeLabels";

interface XiaojingTopicPlanPanelProps {
  workspaceId: string;
  /** 会话内工具推进后的产物刷新信号（票 29：面板只读化后的刷新联动）。 */
  refreshKey?: number;
}

/**
 * 票 29：主题计划阶段面板是纯只读投影。勾选、编辑、局部重算与确认
 * 只出现在聊天里的确认卡片（TopicPlanGateCard）上。
 */
export default memo(function XiaojingTopicPlanPanel({
  workspaceId,
  refreshKey = 0,
}: XiaojingTopicPlanPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [plan, setPlan] = useState<TopicPlanProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  useEffect(() => {
    let active = true;
    if (!hasRealSession || !sessionId) {
      queueMicrotask(() => {
        if (active) setPlan(null);
      });
      return () => {
        active = false;
      };
    }
    void loadLatestTopicPlan(apiPost, { workspaceId, sessionId })
      .then((latest) => {
        if (!active) return;
        setError(null);
        setPlan(latest);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [apiPost, hasRealSession, refreshKey, sessionId, workspaceId]);

  const topicNames = useMemo(
    () => new Map(plan?.topics.map((topic) => [topic.id, topic.name]) ?? []),
    [plan?.topics],
  );

  const confirmed = plan?.status === "confirmed";

  return (
    <section
      aria-label="主题与内容计划"
      className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
    >
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium">主题、类型与标题计划</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--ink-muted)]">
            计划的编辑与确认在聊天卡片上完成；这里只展示已确认的计划。
          </p>
        </div>
      </div>

      {!hasRealSession && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          请先建立真实 Session。
        </p>
      )}

      {error && (
        <p className="mt-2 break-words rounded-lg bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}

      {hasRealSession && !plan && !error && (
        <p className="mt-3 text-center text-xs text-[var(--ink-subtle)]">
          暂无内容计划；在聊天中发起后这里展示结果。
        </p>
      )}

      {plan && !confirmed && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          计划尚未确认；请回到聊天中的确认卡片完成批准，确认后这里展示计划内容。
        </p>
      )}

      {plan && confirmed && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              知识 v{plan.knowledgeVersion}
            </span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              {plan.topics.length} 个主题
            </span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              {plan.reused ? "已复用" : "模型规划"}
            </span>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-700">
              已确认
            </span>
          </div>

          <div className="mt-2 space-y-2">
            {plan.items.map((item) => (
              <article
                key={item.id}
                className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap gap-1 text-xs text-[var(--ink-muted)]">
                      <span>{topicNames.get(item.topicId)}</span>
                      <span>· {CONTENT_TYPE_LABELS[item.contentType]}</span>
                      <span>· 问题 {item.sourceQuestionIds.length}</span>
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
            ))}
          </div>
        </div>
      )}
    </section>
  );
});
