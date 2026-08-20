import {
  Database,
  LineChart,
  Loader2,
  RefreshCcw,
  TrendingUp,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { loadGeoBaselineEngines, loadLatestGeoBaseline } from "@/api/geoBaselineClient";
import { loadLatestPostPublishMonitor } from "@/api/postPublishMonitoringClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  GeoBaselineEngineAvailability,
  GeoBaselineEngineId,
  GeoBaselineProjection,
} from "../../../shared/geo/baseline";
import type { PostPublishMonitorPlanProjection } from "../../../shared/geo/postPublishMonitoring";
import GeoDiagnosisMatrix from "./GeoDiagnosisMatrix";
import GeoEffectCurve from "./GeoEffectCurve";
import GeoEffectKpiStrip from "./GeoEffectKpiStrip";
import GeoEffectVerdict from "./GeoEffectVerdict";
import GeoEvidenceLibrary from "./GeoEvidenceLibrary";
import {
  buildGeoEffectViewModel,
  buildGeoEvidenceEntries,
  engineLabel,
} from "./geoEffectViewModel";

interface Props {
  workspaceId: string;
  /** Bumped by the effects entry after a baseline/monitor mutation. */
  refreshKey?: number;
}

/**
 * 效果看板组装层：数据加载（Rust IPC 投影读取 + 借用会话的引擎可用性
 * 探测）与四区块拼装（结论条 / KPI 六卡 / 优化曲线 + 问题诊断矩阵 /
 * 证据样本库）。全部推导在 geoEffectViewModel 纯函数层完成，这里不做
 * 任何指标计算，也不生成演示数据。
 */
export default memo(function XiaojingGeoEffectDashboard({
  workspaceId,
  refreshKey = 0,
}: Props) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const identity = useMemo(
    () =>
      sessionId && !isPendingSessionId(sessionId)
        ? { workspaceId, sessionId }
        : null,
    [sessionId, workspaceId],
  );
  const [engines, setEngines] = useState<GeoBaselineEngineAvailability[]>([]);
  const [engineId, setEngineId] = useState<GeoBaselineEngineId>("doubao");
  const [baseline, setBaseline] = useState<GeoBaselineProjection | null>(null);
  const [plan, setPlan] = useState<PostPublishMonitorPlanProjection | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true);
      setError(null);
      try {
        // Projection reads ride the Rust IPC data plane: the real dashboard
        // renders even before the brand has any open chat session. Only the
        // engine-availability read needs the borrowed session sidecar.
        const [nextBaseline, nextPlan] = await Promise.all([
          loadLatestGeoBaseline(workspaceId),
          loadLatestPostPublishMonitor({ workspaceId, sessionId }),
        ]);
        const nextEngines = identity
          ? await loadGeoBaselineEngines(apiPost, identity).catch(() => [])
          : [];
        if (signal?.aborted) return;
        setEngines(nextEngines);
        setBaseline(nextBaseline);
        setPlan(nextPlan);
        setEngineId((current) => {
          const known = new Set<string>([
            ...nextEngines.map((engine) => engine.id),
            ...(nextPlan?.engineIds ?? []),
            ...(nextBaseline?.providerSnapshots.map(
              (snapshot) => snapshot.engineId,
            ) ?? []),
          ]);
          if (known.has(current)) return current;
          return nextEngines[0]?.id ?? nextPlan?.engineIds[0] ?? "doubao";
        });
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [apiPost, identity, sessionId, workspaceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const selectedEngineLabel = engines.some((engine) => engine.id === engineId)
    ? (engines.find((engine) => engine.id === engineId)?.label ?? engineLabel(engineId))
    : engineLabel(engineId);

  const viewModel = useMemo(
    () =>
      buildGeoEffectViewModel({
        baseline,
        plan,
        engineId,
        engineLabel: selectedEngineLabel,
      }),
    [baseline, plan, engineId, selectedEngineLabel],
  );

  const evidenceEntries = useMemo(
    () =>
      buildGeoEvidenceEntries({
        rows: viewModel.rows,
        runs: viewModel.runs,
        baseline,
        engineId,
      }),
    [baseline, engineId, viewModel],
  );

  const hasCurveData =
    viewModel.curveBaseRate !== null ||
    viewModel.curvePoints.some((point) => point.rate !== null);

  // KPI 卡片 / 诊断矩阵题面点击 → 锚点跳到证据库对应条目。
  const jumpToEvidence = useCallback(() => {
    document
      .getElementById("geo-effect-evidence")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const locateQuestion = useCallback((questionId: string) => {
    document
      .getElementById(`geo-effect-evidence-${questionId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <section
      aria-label="GEO 效果看板"
      data-testid="geo-effect-dashboard"
      className="overflow-hidden rounded-2xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--geo-dash-border)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--geo-dash-secondary)] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--geo-dash-secondary)]" />
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--geo-dash-secondary)]">
              GEO 效果监测
            </span>
          </div>
          <h3 className="mt-2 flex items-center gap-2 text-sm font-semibold text-[var(--geo-dash-text)]">
            <TrendingUp className="h-4 w-4 text-[var(--geo-dash-secondary)]" />
            效果看板
          </h3>
          <p className="mt-1 text-xs leading-5 text-[var(--geo-dash-text-mute)]">
            全部数值来自真实基线探测与发布后监测证据，缺失时如实标注，不使用演示数据。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            data-testid="geo-effect-real-badge"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--geo-dash-border-strong)] bg-[var(--geo-dash-card-2)] px-3 py-1 text-xs font-medium text-[var(--geo-dash-coral)]"
          >
            <Database className="h-3 w-3" />
            真实数据
          </span>
          <button
            type="button"
            aria-label="刷新效果看板"
            onClick={() => void load()}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--geo-dash-border-strong)] bg-[var(--geo-dash-card-2)] text-[var(--geo-dash-text-dim)] transition-colors hover:border-[var(--geo-dash-secondary)] hover:text-[var(--geo-dash-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--geo-dash-secondary)] disabled:opacity-50"
          >
            <RefreshCcw
              className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      <div className="space-y-4 p-5 text-xs">
        {error && (
          <p
            role="alert"
            className="break-words rounded-lg border border-[var(--geo-dash-border)] bg-[var(--geo-dash-bg-2)] p-2 leading-5 text-[var(--geo-dash-danger)]"
          >
            效果数据读取失败：{error}
          </p>
        )}

        {engines.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" aria-label="效果看板引擎">
            <span className="text-[var(--geo-dash-text-mute)]">平台：</span>
            {engines.map((engine) => (
              <button
                key={engine.id}
                type="button"
                aria-pressed={engine.id === engineId}
                onClick={() => setEngineId(engine.id)}
                className={`rounded border px-2.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--geo-dash-secondary)] ${
                  engine.id === engineId
                    ? "border-[var(--geo-dash-primary)] bg-[var(--geo-dash-primary)]/20 text-[var(--geo-dash-primary)]"
                    : "border-transparent text-[var(--geo-dash-text-mute)] hover:text-[var(--geo-dash-text-dim)]"
                }`}
              >
                {engine.label}
              </button>
            ))}
          </div>
        )}
        {engines.length === 0 && viewModel.runs.length > 0 && (
          <p className="leading-5 text-[var(--geo-dash-text-mute)]">
            平台：{selectedEngineLabel}
            <span className="ml-2">（可用性需打开品牌会话后探测）</span>
          </p>
        )}

        <GeoEffectVerdict verdict={viewModel.verdict} />

        <GeoEffectKpiStrip kpis={viewModel.kpis} onJump={jumpToEvidence} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <section
            aria-label="优化效果曲线"
            className="rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-5"
          >
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
              平台优化效果曲线
            </div>
            <h4 className="mt-1 flex items-center gap-2 text-sm font-semibold text-[var(--geo-dash-text)]">
              <LineChart className="h-3.5 w-3.5 text-[var(--geo-dash-secondary)]" />
              品牌出现率 · {selectedEngineLabel}
            </h4>

            <div className="mt-3 flex flex-wrap gap-5 text-xs">
              <span className="inline-flex items-center gap-1.5 text-[var(--geo-dash-text-dim)]">
                <svg width="18" height="6" aria-hidden="true">
                  <line
                    x1="0"
                    y1="3"
                    x2="18"
                    y2="3"
                    stroke="var(--geo-dash-text-mute)"
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                  />
                </svg>
                基线：{viewModel.curveBaseRate === null ? "暂无" : `${viewModel.curveBaseRate}%`}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--geo-dash-text-dim)]">
                <span className="h-[3px] w-4 rounded-full bg-[var(--geo-dash-coral)]" />
                各轮监测
              </span>
            </div>
            {hasCurveData ? (
              <GeoEffectCurve
                baseRate={viewModel.curveBaseRate}
                points={viewModel.curvePoints}
              />
            ) : (
              <div
                data-testid="geo-effect-curve-empty"
                className="mt-3 rounded-lg border border-dashed border-[var(--geo-dash-border-strong)] p-3"
              >
                <GeoEffectCurve baseRate={null} points={[]} testId="geo-effect-curve-skeleton" />
                <p className="mt-2 leading-5 text-[var(--geo-dash-text-mute)]">
                  暂无真实曲线数据。请先在下方完成基线探测；启用发布后监测后，每一轮复测都会成为曲线上的真实节点。
                </p>
              </div>
            )}
          </section>

          <section
            aria-label="问题诊断矩阵"
            className="rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-5"
          >
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
              问题诊断
            </div>
            <h4 className="mt-1 text-sm font-semibold text-[var(--geo-dash-text)]">
              监测问题诊断矩阵
            </h4>
            <GeoDiagnosisMatrix rows={viewModel.rows} onLocate={locateQuestion} />
          </section>
        </div>

        <GeoEvidenceLibrary entries={evidenceEntries} />

        {busy && (
          <p className="flex items-center gap-1 text-[var(--geo-dash-text-mute)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在读取真实效果数据…
          </p>
        )}
      </div>
    </section>
  );
});
