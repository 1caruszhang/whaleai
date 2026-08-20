import { Activity, Loader2, RefreshCcw, RotateCcw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { loadLatestGeoBaseline } from "@/api/geoBaselineClient";
import CustomSelect from "@/components/CustomSelect";
import {
  activatePostPublishMonitor,
  loadLatestPostPublishMonitor,
  loadPostPublishMonitor,
  preparePostPublishMonitor,
  retryPostPublishMonitorUnit,
} from "@/api/postPublishMonitoringClient";
import { loadLatestPublishExecution } from "@/api/publishSchedulerClient";
import { useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type { GeoBaselineEngineId } from "../../../shared/geo/baseline";
import {
  aggregatePostPublishMonitorUnits,
  type PostPublishMonitorPlanProjection,
  type PostPublishMonitorUnitProjection,
} from "../../../shared/geo/postPublishMonitoring";

interface Props {
  workspaceId: string;
  /** 精确读取的监测计划 id（通知深链落点）；缺省时读取 latest。 */
  planId?: string;
  /** 工作台只读挂载：仅展示监测结果，配置/启用/重试交互只出现在效果页与聊天卡片。 */
  readOnly?: boolean;
  /** Re-runs the initial load (effects entry linkage after a new baseline). */
  refreshKey?: number;
  /** Fired after prepare/activate/retry committed a plan mutation. */
  onPlanMutated?: () => void;
}

const UNIT_LABEL: Record<PostPublishMonitorUnitProjection["kind"], string> = {
  "publish-status": "平台发布状态",
  "access-indexing": "真实发布页访问 / 收录",
  "baseline-probe": "Baseline 问题复测",
};

export default memo(function XiaojingPostPublishMonitoringPanel({ workspaceId, planId, readOnly = false, refreshKey = 0, onPlanMutated }: Props) {
  const { sessionId } = useTabState();
  const identity = useMemo(
    () => sessionId && !isPendingSessionId(sessionId) ? { workspaceId, sessionId } : null,
    [sessionId, workspaceId],
  );
  const [plan, setPlan] = useState<PostPublishMonitorPlanProjection | null>(null);
  const [publishExecutionId, setPublishExecutionId] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [engineIds, setEngineIds] = useState<GeoBaselineEngineId[]>(["doubao"]);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [maxRuns, setMaxRuns] = useState(12);
  const [deadline, setDeadline] = useState("");
  const [newPlan, setNewPlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    // 计划与冻结来源都是 Rust IPC 投影读取：效果页无会话时也照常展示；
    // sessionId 仅在会话存在时随读传递，保持与既有门控行为一致。
    void Promise.all([
      planId
        ? loadPostPublishMonitor({ workspaceId, sessionId }, planId)
        : loadLatestPostPublishMonitor({ workspaceId, sessionId }),
      loadLatestPublishExecution(workspaceId),
      loadLatestGeoBaseline(workspaceId),
    ])
      .then(([latestPlan, execution, baseline]) => {
        if (!active) return;
        setPlan(latestPlan);
        setPublishExecutionId(execution?.id ?? null);
        setBaselineId(baseline?.id ?? null);
        if (latestPlan) {
          setIntervalMinutes(latestPlan.intervalMinutes);
          setEngineIds(latestPlan.engineIds);
          setMaxRuns(latestPlan.endConditions.maxRuns ?? 12);
          setDeadline(
            latestPlan.endConditions.deadline
              ? new Date(latestPlan.endConditions.deadline).toISOString().slice(0, 16)
              : "",
          );
        }
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => active && setBusy(false));
    return () => { active = false; };
  }, [planId, refreshKey, sessionId, workspaceId]);

  const refresh = useCallback(async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await loadPostPublishMonitor({ workspaceId, sessionId }, plan.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, plan, sessionId, workspaceId]);

  const prepare = useCallback(async () => {
    if (!identity || !publishExecutionId || !baselineId || engineIds.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const editable = plan?.status === "draft" && !newPlan ? plan : null;
      setPlan(await preparePostPublishMonitor(identity, {
        publishExecutionId,
        baselineId,
        engineIds,
        intervalMinutes,
        endConditions: {
          maxRuns,
          ...(deadline ? { deadline: new Date(deadline).getTime() } : {}),
        },
        ...(editable ? { planId: editable.id, expectedRevision: editable.revision } : {}),
      }));
      setNewPlan(false);
      onPlanMutated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [baselineId, busy, deadline, engineIds, identity, intervalMinutes, maxRuns, newPlan, onPlanMutated, plan, publishExecutionId]);

  const activate = useCallback(async () => {
    if (!identity || !plan || plan.status !== "draft" || busy) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await activatePostPublishMonitor(identity, {
        planId: plan.id,
        expectedRevision: plan.revision,
      }));
      onPlanMutated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, identity, onPlanMutated, plan]);

  const retry = useCallback(async (unit: PostPublishMonitorUnitProjection) => {
    if (!identity || !plan || unit.status !== "failed" || busy) return;
    setBusy(true);
    setError(null);
    try {
      setPlan(await retryPostPublishMonitorUnit(identity, {
        planId: plan.id,
        unitId: unit.id,
        expectedUnitRevision: unit.revision,
      }));
      onPlanMutated?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, identity, onPlanMutated, plan]);

  const units = plan?.latestRun?.units ?? [];
  const aggregate = aggregatePostPublishMonitorUnits(units);
  const editing = !plan || plan.status === "draft" || newPlan;
  // 票 32：通知深链按精确计划 id 读取——该计划已完成（终态），其最新
  // 时间序列 run 即告警对应的监测结果，标出定位记号。
  const located = !!plan && !!planId && plan.id === planId;
  const interactive = !readOnly && !!identity;

  return (
    <section
      aria-label="发布后 GEO 监测"
      data-geo-monitor-located={located || undefined}
      className="rounded-2xl border border-[var(--geo-dash-border,var(--line))] bg-[var(--geo-dash-card,var(--paper-elevated))]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--geo-dash-border,var(--line-subtle))] px-4 py-2.5">
        <Activity className="h-4 w-4 text-[var(--geo-dash-secondary,var(--accent))]" />
        <h3 className="text-sm font-semibold text-[var(--geo-dash-text,var(--ink))]">发布后监测</h3>
        {plan && <span className="ml-auto text-xs text-[var(--geo-dash-text-mute,var(--ink-muted))]">{plan.status} · {plan.recoveryState}</span>}
      </div>
      <div className="space-y-2.5 p-3.5 text-xs">
        <p className="leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
          仅监测已由确定性发布提交成功的稳定发布项。应用退出时本地监测暂停；重启后显示待恢复或逾期，并按固定策略继续。
        </p>
        {plan && (
          <p className="leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
            来源 Operation {plan.sourceOperationId} · 每 {plan.intervalMinutes} 分钟 · 目标引擎 {plan.engineIds.join("、")}
          </p>
        )}
        {plan?.status === "paused" && (
          <div
            role="alert"
            aria-label="监测已暂停（余额不足）"
            data-geo-monitor-paused
            className="rounded-xl border border-[var(--geo-dash-coral,var(--accent))]/50 bg-[rgba(255,182,137,0.10)] p-3"
          >
            <p className="font-medium text-[var(--geo-dash-coral,var(--accent))]">已暂停（余额不足），充值后恢复</p>
            <p className="mt-1 leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
              点数余额低于单次巡检价，监测已自动暂停且不再扣点；充值到账后下一轮巡检自动恢复，无需重新启用。
            </p>
          </div>
        )}
        {interactive && editing && (
          <div className="space-y-3 rounded-xl border border-[var(--geo-dash-border,var(--line))] bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-3">
            <p>冻结来源：发布执行 {publishExecutionId ?? "无可用执行"}</p>
            <p>冻结 Baseline：{baselineId ?? "无可用基线"}</p>
            <fieldset className="space-y-1" aria-label="目标引擎">
              <legend className="mb-1">目标引擎</legend>
              <label className="flex items-center gap-2">
                <input
                  aria-label="豆包"
                  type="checkbox"
                  checked={engineIds.includes("doubao")}
                  onChange={(event) => setEngineIds(event.target.checked ? ["doubao"] : [])}
                />
                豆包
              </label>
              <label className="flex items-center gap-2 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
                <input aria-label="其他引擎（当前不可用）" type="checkbox" disabled />
                其他引擎（当前不可用）
              </label>
              {engineIds.length === 0 && <p className="text-[var(--geo-dash-danger,var(--danger))]">至少选择一个可用目标引擎</p>}
            </fieldset>
            <label className="block">频率
              <CustomSelect
                ariaLabel="监测频率"
                value={String(intervalMinutes)}
                options={[
                  { value: "15", label: "每 15 分钟" },
                  { value: "60", label: "每小时" },
                  { value: "360", label: "每 6 小时" },
                  { value: "1440", label: "每天" },
                ]}
                onChange={(value) => setIntervalMinutes(Number(value))}
                className="mt-1 w-full"
              />
            </label>
            <label className="block">最多运行次数
              <input aria-label="监测最多运行次数" type="number" min={1} max={10000} value={maxRuns} onChange={(event) => setMaxRuns(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-[var(--geo-dash-border,var(--line))] bg-[var(--geo-dash-card,var(--paper-elevated))] p-2" />
            </label>
            <label className="block">可选截止时间
              <input aria-label="监测截止时间" type="datetime-local" value={deadline} onChange={(event) => setDeadline(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--geo-dash-border,var(--line))] bg-[var(--geo-dash-card,var(--paper-elevated))] p-2" />
            </label>
            <button type="button" disabled={busy || !identity || !publishExecutionId || !baselineId || engineIds.length === 0 || maxRuns < 1} onClick={() => void prepare()} className="rounded-lg border border-[var(--geo-dash-border,var(--line))] px-3 py-2 disabled:opacity-50">{plan?.status === "draft" && !newPlan ? "保存 draft revision" : "创建新监测计划"}</button>
          </div>
        )}
        {interactive && plan?.status === "draft" && !newPlan && (
          <button type="button" disabled={busy} onClick={() => void activate()} className="w-full rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 font-medium text-[var(--button-primary-text)] disabled:opacity-50">启用确定性监测</button>
        )}
        {!interactive && (
          <p className="leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
            {identity
              ? "监测计划的配置与启用在聊天中的确认卡片里完成；这里只展示监测结果。"
              : "监测结果已按真实数据展示；打开该品牌的会话后，才能配置、启用监测或重试失败单元。"}
          </p>
        )}
        {interactive && plan && plan.status !== "draft" && !newPlan && (
          <div className="flex gap-2">
            <button type="button" aria-label="刷新监测状态" disabled={busy} onClick={() => void refresh()} className="inline-flex items-center gap-1 rounded-lg border border-[var(--geo-dash-border,var(--line))] px-2 py-1.5"><RefreshCcw className="h-3.5 w-3.5" />刷新</button>
            <button type="button" disabled={busy} onClick={() => setNewPlan(true)} className="rounded-lg border border-[var(--geo-dash-border,var(--line))] px-2 py-1.5">以明确新计划变更配置</button>
          </div>
        )}
        {plan?.latestRun && (
          <div
            className={`rounded-xl border p-3 ${located ? "border-[var(--geo-dash-coral,var(--accent))]/60" : "border-[var(--geo-dash-border,var(--line))]"}`}
            data-geo-monitor-run-located={located || undefined}
          >
            <p className="font-medium text-[var(--geo-dash-text,var(--ink))]">
              时间序列 Run #{plan.latestRun.ordinal} · {plan.latestRun.status}
              {located && (
                <span className="ml-2 rounded-full bg-[rgba(255,182,137,0.16)] px-2 py-0.5 text-xs font-medium text-[var(--geo-dash-coral,var(--accent))]">
                  通知定位
                </span>
              )}
            </p>
            <p className="mt-2 text-[var(--geo-dash-text-mute,var(--ink-muted))]">已发布 {aggregate.publishedItems} · 可访问 {aggregate.accessibleItems} · 已收录 {aggregate.indexedItems} · 品牌出现 {aggregate.brandMentioned}/{aggregate.baselineProbes} · TOP3 {aggregate.topThree}</p>
            {units.map((unit) => (
              <article key={unit.id} className="mt-2 rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2">
                <div className="flex items-center justify-between gap-2"><strong className="text-[var(--geo-dash-text,var(--ink))]">{UNIT_LABEL[unit.kind]}</strong><span className="text-[var(--geo-dash-text-mute,var(--ink-muted))]">{unit.status} · attempt {unit.attemptNumber}</span></div>
                {unit.questionId && <p className="mt-1 text-[var(--geo-dash-text-mute,var(--ink-muted))]">问题 {unit.questionId} · {unit.engineId}</p>}
                {unit.evidence && "platformStatus" in unit.evidence && (
                  <p className="mt-1 text-[var(--geo-dash-text-mute,var(--ink-muted))]">平台 {unit.evidence.platformStatus}（code {unit.evidence.platformStatusCode}）{unit.evidence.publishedUrl ? ` · ${unit.evidence.publishedUrl}` : ""}</p>
                )}
                {unit.evidence && "accessible" in unit.evidence && (
                  <p className="mt-1 text-[var(--geo-dash-text-mute,var(--ink-muted))]">发布页 {unit.evidence.accessible ? "可访问" : "不可访问"} · 收录 {unit.evidence.indexingState} · {unit.evidence.url}</p>
                )}
                {unit.evidence && "rawAnswer" in unit.evidence && (
                  <div className="mt-1">
                    <p className="text-[var(--geo-dash-text,var(--ink))]">品牌出现 {unit.evidence.analysis.brandMentioned ? "是" : "否"} · 排名 {unit.evidence.rankPosition ? `TOP${unit.evidence.rankPosition}` : "不可解析"}</p>
                    {unit.evidence.citedArticleIds.length > 0 && <p className="text-[var(--geo-dash-text-mute,var(--ink-muted))]">引用文章：{unit.evidence.citedArticleIds.join("、")}</p>}
                    {unit.evidence.citedUrls.length > 0 && <p className="text-[var(--geo-dash-text-mute,var(--ink-muted))]">引用 URL：{unit.evidence.citedUrls.join("、")}</p>}
                  </div>
                )}
                {unit.observedAt && <p className="mt-1 text-[var(--geo-dash-text-mute,var(--ink-muted))]">观察于 {new Date(unit.observedAt).toLocaleString()}</p>}
                {unit.errorMessage && <p className="mt-1 text-[var(--geo-dash-danger,var(--danger))]">{unit.errorCode}：{unit.errorMessage}</p>}
                {unit.status === "failed" && interactive && plan.status !== "paused" && (
                  <button type="button" disabled={busy} onClick={() => void retry(unit)} className="mt-2 inline-flex items-center gap-1 rounded border border-[var(--geo-dash-border,var(--line))] px-2 py-1"><RotateCcw className="h-3 w-3" />仅重试此单元</button>
                )}
              </article>
            ))}
          </div>
        )}
        {plan && plan.recentRuns.length > 0 && (
          <div aria-label="最近监测历史" className="rounded-xl border border-[var(--geo-dash-border,var(--line))] p-3">
            <p className="font-medium text-[var(--geo-dash-text,var(--ink))]">最近监测历史（最多 20 次）</p>
            <div className="mt-2 space-y-1">
              {plan.recentRuns.map((run) => {
                const summary = aggregatePostPublishMonitorUnits(run.units);
                return (
                  <p key={run.id} className="text-[var(--geo-dash-text-mute,var(--ink-muted))]">
                    Run #{run.ordinal} · {run.status} · 已发布 {summary.publishedItems} · 可访问 {summary.accessibleItems} · 已收录 {summary.indexedItems} · 品牌出现 {summary.brandMentioned}/{summary.baselineProbes}
                  </p>
                );
              })}
            </div>
          </div>
        )}
        {busy && <p className="flex items-center gap-1 text-[var(--geo-dash-text-mute,var(--ink-muted))]"><Loader2 className="h-3.5 w-3.5 animate-spin" />处理中…</p>}
        {error && <p className="rounded-lg bg-[var(--geo-dash-danger,var(--danger))]/10 p-2 text-[var(--geo-dash-danger,var(--danger))]">{error}</p>}
      </div>
    </section>
  );
});
