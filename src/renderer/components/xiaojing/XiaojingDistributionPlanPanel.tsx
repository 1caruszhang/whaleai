import { AlertTriangle, CheckCircle2, Radar } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { loadLatestDistributionPlan } from "@/api/distributionPlanClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type { DistributionPlanProjection } from "../../../shared/geo/distributionPlan";

interface XiaojingDistributionPlanPanelProps {
  workspaceId: string;
  /** 会话内工具推进后的产物刷新信号（票 29：面板只读化后的刷新联动）。 */
  refreshKey?: number;
}

const KIND_LABEL = { media: "媒体", "we-media": "自媒体" } as const;
const PATH_LABEL = {
  passive: "真实来源命中",
  active: "行业与人群",
  fallback: "GEO 兜底召回",
  preference: "显式偏好",
} as const;

function localDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 票 29：分发阶段面板是纯只读投影。渠道发现、候选勾选、映射编辑与
 * 确认只出现在聊天里的卡片（DistributionGateCard）上。
 */
export default memo(function XiaojingDistributionPlanPanel({
  workspaceId,
  refreshKey = 0,
}: XiaojingDistributionPlanPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [plan, setPlan] = useState<DistributionPlanProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const identity = useMemo(
    () => (sessionId ? { workspaceId, sessionId } : null),
    [sessionId, workspaceId],
  );

  useEffect(() => {
    if (!hasRealSession || !identity) return;
    let active = true;
    void loadLatestDistributionPlan(apiPost, identity)
      .then((latest) => {
        if (!active) return;
        setError(null);
        setPlan(latest);
      })
      .catch((cause) => {
        if (!active) return;
        setPlan(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [apiPost, hasRealSession, identity, refreshKey]);

  return (
    <section
      aria-label="渠道发现与分发计划"
      className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-4 py-3">
        <Radar className="h-4 w-4 text-[var(--accent)]" />
        <h3 className="text-sm font-semibold">渠道发现与分发计划</h3>
      </div>

      <div className="space-y-3 p-4 text-xs">
        {!hasRealSession && (
          <p className="text-[var(--ink-muted)]">
            等待真实会话后加载分发计划。
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--error-bg)] p-2 text-[var(--error)]"
          >
            {error}
          </p>
        )}
        {hasRealSession && !plan && !error && (
          <p className="leading-5 text-[var(--ink-muted)]">
            暂无分发计划；渠道发现与计划确认在聊天中的卡片上发起与完成。
          </p>
        )}

        {plan && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-[var(--hover-bg)] p-2">
              <span>
                {plan.providerSnapshot.provider} ·{" "}
                {plan.providerState === "available"
                  ? "目录快照可用"
                  : "能力不可用"}
              </span>
              <span>rev {plan.revision}</span>
            </div>
            {plan.candidates.length === 0 && (
              <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-2 text-[var(--warning)]">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                没有真实可用候选；未生成替代或随机渠道。
              </div>
            )}
            {plan.candidates.map((candidate) => (
              <article
                key={`${candidate.kind}:${candidate.resourceId}`}
                className="rounded-xl border border-[var(--line)] p-3"
              >
                <div>
                  <span className="block font-semibold">
                    {candidate.name}
                    {plan.selectedResourceIds.includes(candidate.resourceId) &&
                      "（已选）"}
                  </span>
                  <span className="text-[var(--ink-muted)]">
                    {KIND_LABEL[candidate.kind]} · Provider 状态 2（可发） ·
                    权重 {candidate.recommendationWeight.toFixed(1)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1 text-[var(--ink-muted)]">
                  <span>
                    报价：
                    {candidate.estimatedPriceCny === null
                      ? "未知"
                      : `¥${candidate.estimatedPriceCny}`}
                  </span>
                  <span>
                    成功率：
                    {candidate.publishedRate === 0 ||
                    candidate.publishedRate === null
                      ? "未知"
                      : `${candidate.publishedRate}%`}
                  </span>
                </div>
                <p className="mt-2">适配：{candidate.fitReasons.join("；")}</p>
                <div className="mt-2">
                  {candidate.evidence.map((evidence) => (
                    <p key={evidence.path} className="text-[var(--ink-muted)]">
                      {PATH_LABEL[evidence.path]} +{evidence.weight.toFixed(1)}
                      ：{evidence.reference}
                    </p>
                  ))}
                </div>
                {(candidate.risks.length > 0 ||
                  candidate.uncertainties.length > 0) && (
                  <p className="mt-2 text-[var(--warning)]">
                    风险：
                    {[...candidate.risks, ...candidate.uncertainties].join(
                      "；",
                    )}
                  </p>
                )}
              </article>
            ))}

            <div className="space-y-2">
              <p className="font-semibold">文章 → 渠道映射</p>
              {plan.articles.map((article) => {
                const assignment = plan.assignments.find(
                  (item) => item.articleId === article.id,
                );
                return (
                  <div key={article.id} className="block">
                    <span className="mb-1 block truncate text-[var(--ink-muted)]">
                      {article.title}
                    </span>
                    <span className="block">
                      {assignment
                        ? plan.candidates.find(
                            (candidate) =>
                              candidate.resourceId === assignment.resourceId,
                          )?.name ?? "未分配"
                        : "未分配"}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <span>预算（元）：{plan.budgetCny}</span>
              <span>发布时间：{localDateTime(plan.publishStartAt)}</span>
            </div>
            {plan.blockingIssues.length > 0 && (
              <div
                role="alert"
                className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-2 text-[var(--warning)]"
              >
                <p className="font-semibold">确认已阻断</p>
                {plan.blockingIssues.map((issue) => (
                  <p key={issue}>· {issue}</p>
                ))}
              </div>
            )}
            {plan.status === "confirmed" ? (
              <p className="flex items-center gap-2 rounded-lg bg-[var(--success-bg)] p-2 text-[var(--success)]">
                <CheckCircle2 className="h-4 w-4" />
                计划已确认；尚未扣费、下单或发布。
              </p>
            ) : (
              <p className="leading-5 text-[var(--ink-muted)]">
                计划待确认：请回到聊天中的确认卡片完成操作。
              </p>
            )}
            <p className="text-[var(--ink-subtle)]">
              本步骤只确认推荐与分配计划。任何付费、下单或发布仍需后续独立确认。
            </p>
          </div>
        )}
      </div>
    </section>
  );
});
