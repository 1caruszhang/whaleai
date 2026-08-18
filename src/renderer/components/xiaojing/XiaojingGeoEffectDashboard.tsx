import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Database,
  LineChart,
  Loader2,
  RefreshCcw,
  TrendingUp,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import { loadGeoBaselineEngines, loadLatestGeoBaseline } from "@/api/geoBaselineClient";
import { loadLatestPostPublishMonitor } from "@/api/postPublishMonitoringClient";
import ExternalLink from "@/components/ExternalLink";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  GeoBaselineEngineAvailability,
  GeoBaselineEngineId,
  GeoBaselineProjection,
} from "../../../shared/geo/baseline";
import {
  aggregatePostPublishMonitorUnits,
  type PostPublishBaselineEvidence,
  type PostPublishMonitorPlanProjection,
  type PostPublishMonitorUnitProjection,
} from "../../../shared/geo/postPublishMonitoring";

interface Props {
  workspaceId: string;
  /** Bumped by the effects entry after a baseline/monitor mutation. */
  refreshKey?: number;
}

const CURVE_RUN_LIMIT = 8;
const LOG_RUN_LIMIT = 6;
const LOG_PROBE_LIMIT = 3;
const RAW_ANSWER_EXCERPT = 160;

const ENGINE_LABELS: Record<string, string> = { doubao: "豆包" };

function engineLabel(engineId: string): string {
  return ENGINE_LABELS[engineId] ?? engineId;
}

function probeEvidence(
  unit: PostPublishMonitorUnitProjection,
): PostPublishBaselineEvidence | null {
  if (unit.kind !== "baseline-probe" || unit.status !== "succeeded")
    return null;
  return unit.evidence && "rawAnswer" in unit.evidence ? unit.evidence : null;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0
    ? Math.round((numerator / denominator) * 100)
    : null;
}

function percentText(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/** Brand-mention rate over one engine's successful probes in one unit set. */
function unitMentionRate(
  units: readonly PostPublishMonitorUnitProjection[],
  engineId: string,
): number | null {
  const probes = units.filter(
    (unit) => unit.engineId === engineId && probeEvidence(unit) !== null,
  );
  if (probes.length === 0) return null;
  const mentioned = probes.filter(
    (unit) => probeEvidence(unit)?.analysis.brandMentioned === true,
  ).length;
  return percentage(mentioned, probes.length);
}

/** Independent recommendation / citation rates from probe evidence. */
function probeAnalysisRates(units: readonly PostPublishMonitorUnitProjection[]) {
  const evidence = units
    .map((unit) => probeEvidence(unit))
    .filter((value): value is PostPublishBaselineEvidence => value !== null);
  return {
    probes: evidence.length,
    recommended: evidence.filter((value) => value.analysis.brandRecommended).length,
    cited: evidence.filter((value) => value.analysis.hasCitationEvidence).length,
  };
}

function baselineMentionRate(
  baseline: GeoBaselineProjection | null,
  engineId: string,
): number | null {
  if (!baseline) return null;
  const units = baseline.units.filter(
    (unit) => unit.engineId === engineId && unit.status === "succeeded",
  );
  if (units.length === 0) return null;
  const mentioned = units.filter(
    (unit) => unit.analysis?.brandMentioned === true,
  ).length;
  return percentage(mentioned, units.length);
}

function rankLabel(
  evidence: PostPublishBaselineEvidence | null,
  status: PostPublishMonitorUnitProjection["status"],
): string {
  if (evidence?.rankPosition) return `TOP${evidence.rankPosition}`;
  if (status === "failed") return "失败";
  if (evidence?.analysis.brandMentioned) return "未进前三";
  if (evidence) return "未提及";
  return "—";
}

/** js_ai-style rank badge tiers: TOP=coral, mentioned=lavender, else muted. */
function rankTierClass(label: string): string {
  if (label.startsWith("TOP")) {
    return "bg-[rgba(255,182,137,0.16)] text-[var(--geo-dash-coral)]";
  }
  if (label === "未进前三") {
    return "bg-[rgba(190,194,255,0.14)] text-[var(--geo-dash-primary)]";
  }
  if (label === "未提及" || label === "失败") {
    return "bg-[rgba(143,143,161,0.12)] text-[var(--geo-dash-text-mute)]";
  }
  return "bg-[rgba(80,216,233,0.12)] text-[var(--geo-dash-secondary)]";
}

function DeltaBadge({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  const direction = delta >= 0 ? "up" : "down";
  const color =
    direction === "up"
      ? "var(--geo-dash-success)"
      : "var(--geo-dash-secondary)";
  return (
    <span
      data-testid="geo-effect-kpi-delta"
      className="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums"
      style={{ color }}
    >
      {direction === "up" ? (
        <ArrowUpRight className="h-3 w-3" />
      ) : (
        <ArrowDownRight className="h-3 w-3" />
      )}
      {direction === "up" ? "+" : ""}
      {delta}pp
    </span>
  );
}

interface KpiCardData {
  key: string;
  label: string;
  value: string;
  sub: string;
  delta: number | null;
}

interface CurvePoint {
  ordinal: number;
  rate: number | null;
}

/** 双线优化效果曲线：基线为灰虚线水平参考，各轮监测为渐变主线 + 面积；
 * 几何沿用 js_ai GeoDemoDashboard 的 580×180 坐标系（x∈[50,540]）。 */
function CurveSvg({
  baseRate,
  points,
  testId = "geo-effect-curve",
}: {
  baseRate: number | null;
  points: readonly CurvePoint[];
  testId?: string;
}) {
  const step = points.length > 1 ? 490 / (points.length - 1) : 0;
  const xAt = (index: number) => 50 + index * step;
  const yAt = (value: number) =>
    160 - (Math.max(0, Math.min(100, value)) / 100) * 130;
  const solid = points
    .map((point, index) => ({ ...point, x: xAt(index) }))
    .filter((point) => point.rate !== null);
  const lastPoint = solid.length > 0 ? solid[solid.length - 1] : null;
  const linePath =
    solid.length > 1
      ? `M ${solid.map((p) => `${p.x.toFixed(1)} ${yAt(p.rate ?? 0).toFixed(1)}`).join(" L ")}`
      : "";
  const areaPath =
    solid.length > 1
      ? `${linePath} L ${solid[solid.length - 1]!.x.toFixed(1)} 160 L ${solid[0]!.x.toFixed(1)} 160 Z`
      : "";

  return (
    <svg
      data-testid={testId}
      viewBox="0 0 580 180"
      className="mt-3 w-full"
      role="img"
      aria-label="优化效果曲线"
    >
      <defs>
        <linearGradient id="geoEffectArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--geo-dash-primary)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--geo-dash-secondary)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="geoEffectLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--geo-dash-primary)" />
          <stop offset="100%" stopColor="var(--geo-dash-coral)" />
        </linearGradient>
      </defs>
      {[30, 95].map((y) => (
        <line
          key={y}
          x1="50"
          y1={y}
          x2="540"
          y2={y}
          stroke="rgba(255,255,255,0.03)"
          strokeWidth="1"
        />
      ))}
      <line
        x1="50"
        y1="160"
        x2="540"
        y2="160"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
      />
      <text x="8" y="34" fontSize="9" fill="var(--geo-dash-text-mute)">
        100%
      </text>
      <text x="8" y="99" fontSize="9" fill="var(--geo-dash-text-mute)">
        50%
      </text>
      <text x="8" y="163" fontSize="9" fill="var(--geo-dash-text-mute)">
        0%
      </text>

      {baseRate !== null && (
        <line
          data-testid="geo-effect-curve-baseline"
          x1="50"
          y1={yAt(baseRate)}
          x2="540"
          y2={yAt(baseRate)}
          stroke="var(--geo-dash-text-mute)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          opacity="0.6"
        />
      )}
      {areaPath && <path d={areaPath} fill="url(#geoEffectArea)" />}
      {linePath && (
        <path
          data-testid="geo-effect-curve-runs"
          className="geo-dash-curve-draw"
          style={{ ["--geo-dash-curve-len" as string]: "620" }}
          d={linePath}
          fill="none"
          stroke="url(#geoEffectLine)"
          strokeWidth="3.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {solid.map((point) => (
        <circle
          key={point.ordinal}
          cx={point.x}
          cy={yAt(point.rate ?? 0)}
          r="4"
          fill="var(--geo-dash-bg)"
          stroke="url(#geoEffectLine)"
          strokeWidth="2"
        />
      ))}
      {lastPoint && (
        <>
          <circle
            cx={lastPoint.x}
            cy={yAt(lastPoint.rate ?? 0)}
            r="10"
            fill="none"
            stroke="var(--geo-dash-coral)"
            strokeWidth="1.5"
            opacity="0.6"
          />
          <text
            x={Math.min(lastPoint.x, 505)}
            y={yAt(lastPoint.rate ?? 0) - 16}
            textAnchor="middle"
            fontSize="10"
            fill="var(--geo-dash-coral)"
            fontWeight="600"
          >
            最新
          </text>
        </>
      )}
      {points.map((point, index) => (
        <text
          key={point.ordinal}
          x={xAt(index)}
          y="176"
          textAnchor="middle"
          fontSize="9"
          fill="var(--geo-dash-text-mute)"
        >
          第{point.ordinal}轮
        </text>
      ))}
    </svg>
  );
}

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

  /** Ascending, bounded run series; merges latestRun when history lacks it. */
  const runs = useMemo(() => {
    if (!plan) return [];
    const byId = new Map(plan.recentRuns.map((run) => [run.id, run]));
    if (plan.latestRun) byId.set(plan.latestRun.id, plan.latestRun);
    return [...byId.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .slice(-CURVE_RUN_LIMIT);
  }, [plan]);

  const selectedEngineLabel = engines.some((engine) => engine.id === engineId)
    ? (engines.find((engine) => engine.id === engineId)?.label ?? engineLabel(engineId))
    : engineLabel(engineId);

  const aggregate = plan?.latestRun
    ? aggregatePostPublishMonitorUnits(plan.latestRun.units)
    : null;
  const latestRates = probeAnalysisRates(plan?.latestRun?.units ?? []);
  // Previous run by ordinal powers the KPI delta badges (较上一轮).
  const previousRun = useMemo(() => {
    const latestOrdinal = plan?.latestRun?.ordinal;
    if (latestOrdinal === undefined) return null;
    return (
      [...runs]
        .filter((run) => run.ordinal < latestOrdinal)
        .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null
    );
  }, [plan?.latestRun?.ordinal, runs]);
  const previousAggregate = previousRun
    ? aggregatePostPublishMonitorUnits(previousRun.units)
    : null;

  const mentionRate = aggregate
    ? percentage(aggregate.brandMentioned, aggregate.baselineProbes)
    : null;
  const previousMentionRate = previousAggregate
    ? percentage(previousAggregate.brandMentioned, previousAggregate.baselineProbes)
    : null;
  const recommendRate = percentage(latestRates.recommended, latestRates.probes);
  const citationRate = percentage(latestRates.cited, latestRates.probes);

  const kpis: KpiCardData[] = useMemo(() => {
    const hasMonitorProbes = (aggregate?.baselineProbes ?? 0) > 0;
    return [
      {
        key: "mention",
        label: "品牌出现率",
        value: percentText(
          mentionRate ?? baseline?.metrics.mentionRate ?? null,
        ),
        sub: hasMonitorProbes
          ? `最新一轮 品牌出现 ${aggregate!.brandMentioned}/${aggregate!.baselineProbes} 题`
          : baseline
            ? `基线探测 ${baseline.metrics.succeeded} 题`
            : "暂无监测复测",
        delta:
          mentionRate !== null && previousMentionRate !== null
            ? mentionRate - previousMentionRate
            : null,
      },
      {
        key: "recommend",
        label: "被推荐率",
        value: percentText(
          recommendRate ?? baseline?.metrics.recommendationRate ?? null,
        ),
        sub: hasMonitorProbes
          ? `最新一轮 被推荐 ${latestRates.recommended}/${latestRates.probes} 题`
          : baseline
            ? "来自最新基线探测"
            : "暂无监测复测",
        delta: null,
      },
      {
        key: "citation",
        label: "引用率",
        value: percentText(
          citationRate ?? baseline?.metrics.citationRate ?? null,
        ),
        sub: hasMonitorProbes
          ? `回答携带引用证据 ${latestRates.cited}/${latestRates.probes} 题`
          : baseline
            ? "来自最新基线探测"
            : "暂无监测复测",
        delta: null,
      },
      {
        key: "top3",
        label: "进入前三",
        value:
          aggregate && aggregate.baselineProbes > 0
            ? `${aggregate.topThree} 题`
            : "—",
        sub: "按可解析的明确排名统计",
        delta: null,
      },
      {
        key: "indexing",
        label: "收录率",
        value: percentText(
          aggregate
            ? percentage(aggregate.indexedItems, aggregate.publishedItems)
            : null,
        ),
        sub:
          aggregate && aggregate.publishedItems > 0
            ? `已收录 ${aggregate.indexedItems}/${aggregate.publishedItems} 项`
            : "暂无可对照的已发布项",
        delta: null,
      },
      {
        key: "access",
        label: "可访问率",
        value: percentText(
          aggregate
            ? percentage(aggregate.accessibleItems, aggregate.accessSamples)
            : null,
        ),
        sub:
          aggregate && aggregate.accessSamples > 0
            ? `可访问 ${aggregate.accessibleItems}/${aggregate.accessSamples} 项`
            : "暂无发布页访问检测",
        delta: null,
      },
    ];
  }, [
    aggregate,
    baseline,
    citationRate,
    latestRates,
    mentionRate,
    previousMentionRate,
    recommendRate,
  ]);

  const curveBaseRate = baselineMentionRate(baseline, engineId);
  const curvePoints: CurvePoint[] = runs.map((run) => ({
    ordinal: run.ordinal,
    rate: unitMentionRate(run.units, engineId),
  }));
  const hasCurveData =
    curveBaseRate !== null || curvePoints.some((point) => point.rate !== null);

  const questionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    baseline?.units.forEach((unit) =>
      labels.set(unit.questionId, unit.question),
    );
    return labels;
  }, [baseline]);

  /** js_ai-style question rows: hit-rate bar + mono value + rank badge. */
  const matrixRows = useMemo(() => {
    const rows = new Map<
      string,
      {
        questionId: string;
        fallbackOrdinal: number;
        mentionedRuns: number;
        totalRuns: number;
        latestRank: string;
      }
    >();
    let fallback = 0;
    for (const run of runs) {
      for (const unit of run.units) {
        if (unit.kind !== "baseline-probe" || unit.engineId !== engineId)
          continue;
        const evidence = probeEvidence(unit);
        const questionId = evidence?.questionId ?? unit.questionId;
        if (!questionId) continue;
        if (!rows.has(questionId)) {
          fallback += 1;
          rows.set(questionId, {
            questionId,
            fallbackOrdinal: fallback,
            mentionedRuns: 0,
            totalRuns: 0,
            latestRank: "—",
          });
        }
        const row = rows.get(questionId)!;
        row.totalRuns += 1;
        if (evidence?.analysis.brandMentioned) row.mentionedRuns += 1;
        row.latestRank = rankLabel(evidence, unit.status);
      }
    }
    return [...rows.values()].sort((left, right) => {
      const leftLabel = questionLabels.get(left.questionId);
      const rightLabel = questionLabels.get(right.questionId);
      if (leftLabel && rightLabel && baseline) {
        const leftOrder = baseline.units.findIndex(
          (unit) => unit.questionId === left.questionId,
        );
        const rightOrder = baseline.units.findIndex(
          (unit) => unit.questionId === right.questionId,
        );
        if (leftOrder !== -1 && rightOrder !== -1) return leftOrder - rightOrder;
      }
      return left.fallbackOrdinal - right.fallbackOrdinal;
    });
  }, [baseline, engineId, questionLabels, runs]);

  const logRuns = useMemo(
    () => [...runs].reverse().slice(0, LOG_RUN_LIMIT),
    [runs],
  );

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
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--geo-dash-border-strong)] bg-[var(--geo-dash-card-2)] text-[var(--geo-dash-text-dim)] transition-colors hover:border-[var(--geo-dash-secondary)] hover:text-[var(--geo-dash-secondary)] disabled:opacity-50"
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
                className={`rounded border px-2.5 py-1 font-medium transition-colors ${
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
        {engines.length === 0 && runs.length > 0 && (
          <p className="leading-5 text-[var(--geo-dash-text-mute)]">
            平台：{selectedEngineLabel}
            <span className="ml-2">（可用性需打开品牌会话后探测）</span>
          </p>
        )}

        <div
          className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
          data-testid="geo-effect-kpi-strip"
        >
          {kpis.map((kpi) => (
            <article
              key={kpi.key}
              data-testid={`geo-effect-kpi-${kpi.key}`}
              className="geo-dash-shimmer relative overflow-hidden rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-4"
            >
              <div className="text-xs uppercase tracking-wide text-[var(--geo-dash-text-mute)]">
                {kpi.label}
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-lg font-semibold tabular-nums text-[var(--geo-dash-text)]">
                  {kpi.value}
                </span>
                <DeltaBadge delta={kpi.delta} />
              </div>
              <div className="mt-1 text-xs leading-4 text-[var(--geo-dash-text-mute)]">
                {kpi.sub}
              </div>
            </article>
          ))}
        </div>

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
                基线：{curveBaseRate === null ? "暂无" : `${curveBaseRate}%`}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[var(--geo-dash-text-dim)]">
                <span className="h-[3px] w-4 rounded-full bg-[var(--geo-dash-coral)]" />
                各轮监测
              </span>
            </div>
            {hasCurveData ? (
              <CurveSvg baseRate={curveBaseRate} points={curvePoints} />
            ) : (
              <div
                data-testid="geo-effect-curve-empty"
                className="mt-3 rounded-lg border border-dashed border-[var(--geo-dash-border-strong)] p-3"
              >
                <CurveSvg baseRate={null} points={[]} testId="geo-effect-curve-skeleton" />
                <p className="mt-2 leading-5 text-[var(--geo-dash-text-mute)]">
                  暂无真实曲线数据。请先在下方完成基线探测；启用发布后监测后，每一轮复测都会成为曲线上的真实节点。
                </p>
              </div>
            )}
          </section>

          <div className="space-y-4">
            <section
              aria-label="问题排名矩阵"
              className="rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-5"
            >
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
                问题排名
              </div>
              <h4 className="mt-1 text-sm font-semibold text-[var(--geo-dash-text)]">
                监测问题最新表现
              </h4>
              {matrixRows.length === 0 ? (
                <p className="mt-3 leading-5 text-[var(--geo-dash-text-mute)]">
                  暂无该引擎的真实复测记录。
                </p>
              ) : (
                <div data-testid="geo-effect-matrix" className="mt-3 space-y-2.5">
                  {matrixRows.map((row) => {
                    const hitRate = percentage(row.mentionedRuns, row.totalRuns);
                    return (
                      <div key={row.questionId} className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--geo-dash-text-dim)]">
                          {questionLabels.get(row.questionId) ??
                            `问题 ${row.fallbackOrdinal}`}
                        </span>
                        <div className="flex items-center gap-2">
                          <div className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-[var(--geo-dash-bg-2)] sm:block">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${hitRate ?? 0}%`,
                                background:
                                  "linear-gradient(90deg, var(--geo-dash-primary), var(--geo-dash-coral))",
                              }}
                            />
                          </div>
                          <span className="w-10 text-right font-mono text-xs tabular-nums text-[var(--geo-dash-text)]">
                            {hitRate === null ? "—" : `${hitRate}%`}
                          </span>
                          <span
                            className={`w-[68px] shrink-0 rounded px-1.5 py-0.5 text-center text-xs font-semibold ${rankTierClass(row.latestRank)}`}
                          >
                            {row.latestRank}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="mt-3 text-xs leading-4 text-[var(--geo-dash-text-mute)]">
                条形为该问题在监测轮次中的品牌出现率；徽章为最新一轮的可解析排名。
              </p>
            </section>

            <section
              aria-label="监测观测日志"
              className="rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-5"
            >
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-[var(--geo-dash-secondary)]" />
                <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
                  监测观测日志
                </span>
              </div>
              {logRuns.length === 0 ? (
                <p className="mt-3 leading-5 text-[var(--geo-dash-text-mute)]">
                  尚未产生真实监测轮次。启用发布后监测后，这里按轮次展示观测与原始证据。
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {logRuns.map((run) => {
                    const summary = aggregatePostPublishMonitorUnits(run.units);
                    const probes = run.units
                      .filter((unit) => unit.kind === "baseline-probe")
                      .slice(0, LOG_PROBE_LIMIT);
                    return (
                      <details
                        key={run.id}
                        data-testid={`geo-effect-log-run-${run.ordinal}`}
                        className="rounded-lg border border-[var(--geo-dash-border)] bg-[var(--geo-dash-bg-2)] p-2"
                      >
                        <summary className="cursor-pointer list-none">
                          <span className="font-mono text-[var(--geo-dash-text-mute)]">
                            [{new Date(run.scheduledFor).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}]
                          </span>{" "}
                          <span className="font-medium text-[var(--geo-dash-primary)]">
                            第{run.ordinal}轮
                          </span>
                          <span className="text-[var(--geo-dash-text-mute)]">
                            {" "}
                            ·{" "}
                            {run.status === "succeeded"
                              ? "完成"
                              : run.status === "partial"
                                ? "部分成功"
                                : run.status === "failed"
                                  ? "失败"
                                  : "进行中"}
                            · 品牌出现 {summary.brandMentioned}/{summary.baselineProbes} ·
                            进入前三 {summary.topThree} · 已收录 {summary.indexedItems}
                          </span>
                        </summary>
                        {probes.map((unit, index) => {
                          const evidence = probeEvidence(unit);
                          return (
                            <div
                              key={unit.id}
                              className="mt-1 rounded bg-[var(--geo-dash-card)] p-1.5"
                            >
                              <p className="text-[var(--geo-dash-text)]">
                                {questionLabels.get(evidence?.questionId ?? "") ??
                                  `复测问题 ${index + 1}`}
                                <span className="ml-1 text-[var(--geo-dash-text-mute)]">
                                  {rankLabel(evidence, unit.status)}
                                </span>
                              </p>
                              {evidence && (
                                <>
                                  <p className="mt-1 whitespace-pre-wrap break-words leading-4 text-[var(--geo-dash-text-dim)]">
                                    {evidence.rawAnswer.length > RAW_ANSWER_EXCERPT
                                      ? `${evidence.rawAnswer.slice(0, RAW_ANSWER_EXCERPT)}…`
                                      : evidence.rawAnswer}
                                  </p>
                                  {evidence.citedUrls
                                    .slice(0, 3)
                                    .map((url) => (
                                      <ExternalLink
                                        key={url}
                                        href={url}
                                        className="mt-1 block break-all text-[var(--geo-dash-secondary)]"
                                      >
                                        {url}
                                      </ExternalLink>
                                    ))}
                                </>
                              )}
                            </div>
                          );
                        })}
                        {run.units.length > probes.length && (
                          <p className="mt-1 text-[var(--geo-dash-text-mute)]">
                            另有 {run.units.length - probes.length} 个观测单元未展开。
                          </p>
                        )}
                      </details>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>

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
