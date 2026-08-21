import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import {
  confirmDistributionPlan,
  editDistributionPlan,
  loadLatestDistributionPlan,
} from "@/api/distributionPlanClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  DistributionPlanEditInput,
  DistributionPlanProjection,
} from "../../../shared/geo/distributionPlan";
import { cnyToPoints, pointsToCny } from "../../../shared/geo/points";
import { unwrapToolResultText } from "../../../shared/toolResult";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 分发计划确认卡：内容由 plan_distribution 的工具结果携带。用户在卡上
 * 勾选渠道候选并确认（先 edit 持久化选择，再 confirm，均走既有端点，
 * CAS revision）。确认只锁定计划，不下单、不扣费。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订（增删渠道、改派、预算/
 * 开始时间）按服务端胜合并——服务端改过渠道选择时采信服务端选择，否则
 * 保留本地勾选。
 */
export interface DistributionGateCardData {
  kind: "distribution-plan";
  plan: GatePlan;
}

/**
 * 卡片初始数据是 plan_distribution 工具结果里的瘦身投影：费用字段为
 * 点数（budgetPoints / estimatedPricePoints），CNY 不进聊天转录；3s 轮询
 * /latest 后切换为完整权威投影（含 CNY）。两处形状都合法，展示与确认
 * 取值一律点数优先、CNY 回退。
 */
type GateCandidate = Omit<
  DistributionPlanProjection["candidates"][number],
  "estimatedPriceCny"
> & {
  estimatedPriceCny?: number | null;
  estimatedPricePoints?: number | null;
};

type GatePlan = Omit<
  DistributionPlanProjection,
  "candidates" | "budgetCny" | "perArticleMaxPoints" | "totalMaxPoints"
> & {
  budgetCny?: number;
  budgetPoints?: number;
  perArticleMaxPoints?: number;
  totalMaxPoints?: number;
  candidates: GateCandidate[];
};

/** 候选单价点数：瘦身数据直接给点数；水合后的完整投影只有 CNY，现场换算。 */
function candidatePricePoints(candidate: GateCandidate): number | null {
  return (
    candidate.estimatedPricePoints ??
    (candidate.estimatedPriceCny == null
      ? null
      : cnyToPoints(candidate.estimatedPriceCny))
  );
}

/** 召回路命中的展示词（与四路召回契约 passive/active/fallback/preference 一一对应）。 */
const PATH_LABEL: Record<string, string> = {
  passive: "被动召回",
  active: "主动召回",
  fallback: "保底召回",
  preference: "偏好召回",
};

function isPlan(value: unknown): value is DistributionPlanProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DistributionPlanProjection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.candidates)
  );
}

function parseEnvelope(value: unknown): DistributionGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parseDistributionGateCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: unknown;
    plan?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parseDistributionGateCard(text) : null;
  }
  if (envelope.kind === "distribution-plan" && isPlan(envelope.plan)) {
    return { kind: "distribution-plan", plan: envelope.plan };
  }
  return null;
}

export function parseDistributionGateCard(
  result: string,
): DistributionGateCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

const KIND_LABEL = { media: "媒体", "we-media": "自媒体" } as const;

export default function DistributionGateCard({
  data,
}: {
  data: DistributionGateCardData;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [plan, setPlan] = useState<GatePlan>(data.plan);
  const [selectedIds, setSelectedIds] = useState<number[]>(
    () => plan.candidates.map((candidate) => candidate.resourceId),
  );
  const [confirmed, setConfirmed] = useState(data.plan.status === "confirmed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const serverSelectionRef = useRef(
    data.plan.selectedResourceIds.join(","),
  );

  // 服务端胜（票 38）：服务端渠道选择变化（聊天增删渠道）时采信服务端，
  // 否则保留本地勾选；其余字段（预算/排期/阻断项）始终采信服务端。
  const mergeRefreshed = useCallback((latest: DistributionPlanProjection) => {
    setPlan(latest);
    if (latest.status === "confirmed") setConfirmed(true);
    const serverSelection = latest.selectedResourceIds.join(",");
    if (serverSelection !== serverSelectionRef.current) {
      serverSelectionRef.current = serverSelection;
      setSelectedIds(latest.selectedResourceIds);
    }
  }, []);
  useGateCardRefresh<DistributionPlanProjection>({
    enabled: !confirmed && hasRealSession,
    projectionId: data.plan.id,
    initialFingerprint: String(data.plan.revision),
    fingerprintOf: (latest) => String(latest.revision),
    fetchLatest: () =>
      loadLatestDistributionPlan(apiPost, {
        workspaceId: data.plan.workspaceId,
        sessionId: sessionId ?? "",
      }),
    onChange: mergeRefreshed,
  });

  const confirm = async () => {
    if (!sessionId || !hasRealSession || busy || selectedIds.length === 0) return;
    if (plan.blockingIssues.length > 0) return;
    // fail-closed：预算数据缺失（畸形转录）时不以 0 元预算提交确认。
    const budgetCny =
      plan.budgetCny ??
      (plan.budgetPoints !== undefined
        ? pointsToCny(plan.budgetPoints)
        : undefined);
    if (budgetCny === undefined) {
      setError("预算数据缺失，请等待卡片刷新后再确认。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const identity = { workspaceId: plan.workspaceId, sessionId };
      const edit: DistributionPlanEditInput = {
        selectedResourceIds: selectedIds,
        assignments: plan.assignments,
        budgetCny,
        publishStartAt: plan.publishStartAt,
      };
      const saved = await editDistributionPlan(apiPost, identity, {
        planId: plan.id,
        expectedRevision: plan.revision,
        edit,
      });
      await confirmDistributionPlan(apiPost, identity, {
        planId: plan.id,
        expectedRevision: saved.revision,
      });
      setConfirmed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="分发计划确认"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-distribution-gate-card={plan.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {plan.articles.length} 篇已批准文章
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {plan.candidates.length} 个真实渠道候选
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          预算 {plan.budgetPoints ?? cnyToPoints(plan.budgetCny ?? 0)} 点
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          单篇上限 {plan.perArticleMaxPoints ?? "—"} 点
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          本次最高 {plan.totalMaxPoints ?? "—"} 点
        </span>
        <span className="ml-auto">已选 {selectedIds.length}/{plan.candidates.length}</span>
      </div>

      {plan.candidates.length === 0 && (
        <p className="mt-2 flex items-center gap-1 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-2 text-xs text-[var(--warning)]">
          <AlertTriangle className="h-3.5 w-3.5" />
          没有真实可用候选；未生成替代或随机渠道。
        </p>
      )}

      <div className="mt-2 space-y-2">
        {plan.candidates.map((candidate) => {
          const checked = selectedIds.includes(candidate.resourceId);
          const pricePoints = candidatePricePoints(candidate);
          return (
            <article
              key={`${candidate.kind}:${candidate.resourceId}`}
              className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
            >
              <label className="flex items-start gap-2">
                {!confirmed && (
                  <input
                    type="checkbox"
                    aria-label={`选择渠道 ${candidate.name}`}
                    checked={checked}
                    onChange={(event) =>
                      setSelectedIds((current) =>
                        event.target.checked
                          ? [...current, candidate.resourceId]
                          : current.filter((id) => id !== candidate.resourceId),
                      )
                    }
                    className="mt-1"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {KIND_LABEL[candidate.kind]} · {candidate.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
                    所需点数：
                    {pricePoints === null
                      ? "点数待定"
                      : `${pricePoints} 点`}
                  </span>
                  <span className="mt-1 block text-xs leading-4 text-[var(--ink-muted)]">
                    召回路命中：
                    {candidate.pathHits
                      .map((path) => {
                        const evidence = candidate.evidence.find(
                          (item) => item.path === path,
                        );
                        return `${PATH_LABEL[path] ?? path}${
                          evidence ? `（${evidence.label}）` : ""
                        }`;
                      })
                      .join("；")}
                  </span>
                  {candidate.fitReasons.length > 0 && (
                    <span className="mt-1 block text-xs leading-4 text-[var(--ink-muted)]">
                      适配：{candidate.fitReasons.join("；")}
                    </span>
                  )}
                </span>
              </label>
            </article>
          );
        })}
      </div>

      {plan.blockingIssues.length > 0 && (
        <div role="alert" className="mt-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-2 text-xs text-[var(--warning)]">
          <p className="font-semibold">确认已阻断</p>
          {plan.blockingIssues.map((issue) => (
            <p key={issue}>· {issue}</p>
          ))}
        </div>
      )}

      {confirmed ? (
        <p className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--success-bg)] p-2 text-sm text-[var(--success)]">
          <CheckCircle2 className="h-4 w-4" />
          分发计划已确认；尚未扣费、下单或发布。
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            void confirm();
          }}
          disabled={
            busy ||
            selectedIds.length === 0 ||
            plan.blockingIssues.length > 0 ||
            !hasRealSession
          }
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          确认分发计划（{selectedIds.length} 个渠道）
        </button>
      )}
      {error && (
        <p role="alert" className="mt-2 break-words rounded-lg bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
        这是系统维护的确认卡片，不是用户发送的消息；本步骤只确认推荐与分配计划，任何付费、下单或发布仍需后续独立授权。
      </p>
    </section>
  );
}
