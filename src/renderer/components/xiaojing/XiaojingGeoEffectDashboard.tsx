import {
  Activity,
  LineChart,
  Loader2,
  RefreshCcw,
  TrendingUp,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  loadGeoBaselineEngines,
  loadLatestGeoBaseline,
} from "@/api/geoBaselineClient";
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
  return value === null ? "暂无真实数据" : `${value}%`;
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
  if (evidence) return "未进前三";
  return "—";
}

interface CurvePoint {
  ordinal: number;
  rate: number | null;
}

function CurveSvg({
  baseRate,
  points,
}: {
  baseRate: number | null;
  points: readonly CurvePoint[];
}) {
  const step = points.length > 1 ? 480 / (points.length - 1) : 0;
  const xAt = (index: number) => 50 + index * step;
  const yAt = (value: number) =>
    160 - (Math.max(0, Math.min(100, value)) / 100) * 130;
  const solid = points
    .map((point, index) => ({ ...point, x: xAt(index) }))
    .filter((point) => point.rate !== null);
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
      data-testid="geo-effect-curve"
      viewBox="0 0 580 180"
      className="mt-3 w-full"
      role="img"
      aria-label="优化效果曲线"
    >
      <defs>
        <linearGradient id="geoEffectArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[30, 95].map((y) => (
        <line
          key={y}
          x1="50"
          y1={y}
          x2="540"
          y2={y}
          stroke="var(--line-subtle)"
          strokeWidth="1"
        />
      ))}
      <line
        x1="50"
        y1="160"
        x2="540"
        y2="160"
        stroke="var(--line)"
        strokeWidth="1"
      />
      <text x="8" y="34" fontSize="9" fill="var(--ink-subtle)">
        100%
      </text>
      <text x="8" y="99" fontSize="9" fill="var(--ink-subtle)">
        50%
      </text>
      <text x="8" y="163" fontSize="9" fill="var(--ink-subtle)">
        0%
      </text>

      {baseRate !== null && (
        <line
          data-testid="geo-effect-curve-baseline"
          x1="50"
          y1={yAt(baseRate)}
          x2="540"
          y2={yAt(baseRate)}
          stroke="var(--ink-muted)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
          opacity="0.7"
        />
      )}
      {areaPath && <path d={areaPath} fill="url(#geoEffectArea)" />}
      {linePath && (
        <path
          data-testid="geo-effect-curve-runs"
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {solid.map((point) => (
        <circle
          key={point.ordinal}
          cx={point.x}
          cy={yAt(point.rate ?? 0)}
          r="3.5"
          fill="var(--paper-elevated)"
          stroke="var(--accent)"
          strokeWidth="2"
        />
      ))}
      {points.map((point, index) => (
        <text
          key={point.ordinal}
          x={xAt(index)}
          y="175"
          textAnchor="middle"
          fontSize="9"
          fill="var(--ink-subtle)"
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
      if (!identity) {
        setEngines([]);
        setBaseline(null);
        setPlan(null);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const [nextEngines, nextBaseline, nextPlan] = await Promise.all([
          loadGeoBaselineEngines(apiPost, identity),
          loadLatestGeoBaseline(apiPost, identity),
          loadLatestPostPublishMonitor(identity),
        ]);
        if (signal?.aborted) return;
        setEngines(nextEngines);
        setBaseline(nextBaseline);
        setPlan(nextPlan);
        setEngineId((current) => {
          if (nextEngines.some((engine) => engine.id === current)) return current;
          const fromPlan = nextPlan?.engineIds.find((id) =>
            nextEngines.some((engine) => engine.id === id),
          );
          return fromPlan ?? nextEngines[0]?.id ?? "doubao";
        });
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!signal?.aborted) setBusy(false);
      }
    },
    [apiPost, identity],
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

  const engineLabel =
    engines.find((engine) => engine.id === engineId)?.label ?? engineId;
  const aggregate = plan?.latestRun
    ? aggregatePostPublishMonitorUnits(plan.latestRun.units)
    : null;

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

  const matrixRows = useMemo(() => {
    const rows = new Map<
      string,
      {
        questionId: string;
        fallbackOrdinal: number;
        cells: Array<{
          runId: string;
          ordinal: number;
          rank: string;
          cited: number;
        }>;
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
            cells: [],
          });
        }
        rows
          .get(questionId)!
          .cells.push({
            runId: run.id,
            ordinal: run.ordinal,
            rank: rankLabel(evidence, unit.status),
            cited: evidence?.citedArticleIds.length ?? 0,
          });
      }
    }
    return [...rows.values()].sort((left, right) => {
      const leftLabel = questionLabels.get(left.questionId);
      const rightLabel = questionLabels.get(right.questionId);
      if (leftLabel && rightLabel) {
        const baselineOrder = baseline?.units.findIndex(
          (unit) => unit.questionId === left.questionId,
        );
        const rightOrder = baseline?.units.findIndex(
          (unit) => unit.questionId === right.questionId,
        );
        if (baselineOrder !== undefined && rightOrder !== undefined)
          return baselineOrder - rightOrder;
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
      className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-4 py-3">
        <TrendingUp className="h-4 w-4 text-[var(--accent)]" />
        <h3 className="text-sm font-semibold">效果看板</h3>
        <button
          type="button"
          aria-label="刷新效果看板"
          onClick={() => void load()}
          disabled={busy || !identity}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
        >
          <RefreshCcw
            className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
          />
        </button>
      </div>
      <div className="space-y-3 p-4 text-xs">
        <p className="leading-5 text-[var(--ink-muted)]">
          全部数值来自真实基线探测与发布后监测证据，缺失时如实标注，不使用演示数据。
        </p>

        {!identity ? (
          <p className="rounded-lg bg-[var(--paper-inset)] p-2 leading-5 text-[var(--ink-muted)]">
            建立真实会话后，即可查看该品牌的效果数据。
          </p>
        ) : (
          <>
            {error && (
              <p
                role="alert"
                className="break-words rounded-lg bg-[var(--error-bg)] p-2 text-[var(--error)]"
              >
                效果数据读取失败：{error}
              </p>
            )}

            {engines.length > 0 && (
              <div className="flex flex-wrap items-center gap-1" aria-label="效果看板引擎">
                {engines.map((engine) => (
                  <button
                    key={engine.id}
                    type="button"
                    aria-pressed={engine.id === engineId}
                    onClick={() => setEngineId(engine.id)}
                    className={`rounded-md border px-2 py-1 ${
                      engine.id === engineId
                        ? "border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]"
                        : "border-[var(--line)] text-[var(--ink-muted)]"
                    }`}
                  >
                    {engine.label}
                  </button>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2" data-testid="geo-effect-kpi-strip">
              <article className="rounded-xl bg-[var(--paper)] p-3" data-testid="geo-effect-kpi-mention">
                <p className="text-[var(--ink-muted)]">品牌出现率</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-[var(--ink)]">
                  {percentText(
                    aggregate
                      ? percentage(aggregate.brandMentioned, aggregate.baselineProbes)
                      : null,
                  )}
                </p>
                <p className="mt-1 text-[var(--ink-subtle)]">
                  {aggregate && aggregate.baselineProbes > 0
                    ? `最新一轮 品牌出现 ${aggregate.brandMentioned}/${aggregate.baselineProbes} 题`
                    : "暂无监测复测"}
                </p>
              </article>
              <article className="rounded-xl bg-[var(--paper)] p-3" data-testid="geo-effect-kpi-top3">
                <p className="text-[var(--ink-muted)]">进入前三</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-[var(--ink)]">
                  {aggregate && aggregate.baselineProbes > 0
                    ? `${aggregate.topThree} 题`
                    : "暂无真实数据"}
                </p>
                <p className="mt-1 text-[var(--ink-subtle)]">按可解析的明确排名统计</p>
              </article>
              <article className="rounded-xl bg-[var(--paper)] p-3" data-testid="geo-effect-kpi-indexing">
                <p className="text-[var(--ink-muted)]">收录率</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-[var(--ink)]">
                  {percentText(
                    aggregate
                      ? percentage(aggregate.indexedItems, aggregate.publishedItems)
                      : null,
                  )}
                </p>
                <p className="mt-1 text-[var(--ink-subtle)]">
                  {aggregate && aggregate.publishedItems > 0
                    ? `已收录 ${aggregate.indexedItems}/${aggregate.publishedItems} 项`
                    : "暂无可对照的已发布项"}
                </p>
              </article>
              <article className="rounded-xl bg-[var(--paper)] p-3" data-testid="geo-effect-kpi-access">
                <p className="text-[var(--ink-muted)]">可访问率</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-[var(--ink)]">
                  {percentText(
                    aggregate
                      ? percentage(aggregate.accessibleItems, aggregate.accessSamples)
                      : null,
                  )}
                </p>
                <p className="mt-1 text-[var(--ink-subtle)]">
                  {aggregate && aggregate.accessSamples > 0
                    ? `可访问 ${aggregate.accessibleItems}/${aggregate.accessSamples} 项`
                    : "暂无发布页访问检测"}
                </p>
              </article>
            </div>

            <section
              aria-label="优化效果曲线"
              className="rounded-xl bg-[var(--paper)] p-3"
            >
              <div className="flex items-center gap-2">
                <LineChart className="h-3.5 w-3.5 text-[var(--accent)]" />
                <h4 className="text-xs font-semibold">优化效果曲线</h4>
                <span className="ml-auto text-[var(--ink-subtle)]">
                  品牌出现率 · {engineLabel}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-[var(--ink-muted)]">
                <span className="inline-flex items-center gap-1.5">
                  <svg width="18" height="6" aria-hidden="true">
                    <line
                      x1="0"
                      y1="3"
                      x2="18"
                      y2="3"
                      stroke="var(--ink-muted)"
                      strokeWidth="1.5"
                      strokeDasharray="4 4"
                    />
                  </svg>
                  基线：
                  {curveBaseRate === null ? "暂无" : `${curveBaseRate}%`}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[3px] w-4 rounded-full bg-[var(--accent)]" />
                  各轮监测
                </span>
              </div>
              {hasCurveData ? (
                <CurveSvg baseRate={curveBaseRate} points={curvePoints} />
              ) : (
                <p className="mt-3 leading-5 text-[var(--ink-muted)]">
                  暂无真实曲线数据。请先在上方完成基线探测；启用发布后监测后，每一轮复测都会成为曲线上的真实节点。
                </p>
              )}
            </section>

            <section
              aria-label="问题排名矩阵"
              className="rounded-xl bg-[var(--paper)] p-3"
            >
              <h4 className="text-xs font-semibold">问题排名矩阵</h4>
              {matrixRows.length === 0 ? (
                <p className="mt-2 leading-5 text-[var(--ink-muted)]">
                  暂无该引擎的真实复测记录。
                </p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table
                    data-testid="geo-effect-matrix"
                    className="w-full min-w-[240px] border-collapse text-left"
                  >
                    <thead>
                      <tr className="text-[var(--ink-subtle)]">
                        <th scope="col" className="py-1 pr-2 font-normal">
                          问题
                        </th>
                        {runs.map((run) => (
                          <th
                            key={run.id}
                            scope="col"
                            className="py-1 pr-2 text-right font-normal"
                          >
                            第{run.ordinal}轮
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line-subtle)]">
                      {matrixRows.map((row) => (
                        <tr key={row.questionId}>
                          <th
                            scope="row"
                            className="max-w-[140px] truncate py-1.5 pr-2 font-normal text-[var(--ink)]"
                          >
                            {questionLabels.get(row.questionId) ??
                              `问题 ${row.fallbackOrdinal}`}
                          </th>
                          {runs.map((run) => {
                            const cell = row.cells.find(
                              (candidate) => candidate.runId === run.id,
                            );
                            return (
                              <td
                                key={run.id}
                                className="py-1.5 pr-2 text-right align-top"
                              >
                                {cell ? (
                                  <span>
                                    <span
                                      className={`rounded px-1.5 py-0.5 font-semibold ${
                                        cell.rank.startsWith("TOP")
                                          ? "bg-[var(--accent-warm-subtle)] text-[var(--accent)]"
                                          : "bg-[var(--paper-inset)] text-[var(--ink-muted)]"
                                      }`}
                                    >
                                      {cell.rank}
                                    </span>
                                    {cell.cited > 0 && (
                                      <span className="ml-1 text-[var(--ink-subtle)]">
                                        引用{cell.cited}
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-[var(--ink-subtle)]">
                                    —
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 leading-4 text-[var(--ink-subtle)]">
                排名只统计回答中可明确解析的前三名；“未进前三”表示品牌被提及但无明确名次。
              </p>
            </section>

            <section
              aria-label="监测观测日志"
              className="rounded-xl bg-[var(--paper)] p-3"
            >
              <div className="flex items-center gap-2">
                <Activity className="h-3.5 w-3.5 text-[var(--accent)]" />
                <h4 className="text-xs font-semibold">监测观测日志</h4>
              </div>
              {logRuns.length === 0 ? (
                <p className="mt-2 leading-5 text-[var(--ink-muted)]">
                  尚未产生真实监测轮次。启用发布后监测后，这里按轮次展示观测与原始证据。
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {logRuns.map((run) => {
                    const summary = aggregatePostPublishMonitorUnits(run.units);
                    const probes = run.units
                      .filter((unit) => unit.kind === "baseline-probe")
                      .slice(0, LOG_PROBE_LIMIT);
                    return (
                      <details
                        key={run.id}
                        data-testid={`geo-effect-log-run-${run.ordinal}`}
                        className="rounded-lg border border-[var(--line-subtle)] p-2"
                      >
                        <summary className="cursor-pointer list-none">
                          第{run.ordinal}轮 ·{" "}
                          {run.status === "succeeded"
                            ? "完成"
                            : run.status === "partial"
                              ? "部分成功"
                              : run.status === "failed"
                                ? "失败"
                                : "进行中"}
                          <span className="ml-2 text-[var(--ink-subtle)]">
                            品牌出现 {summary.brandMentioned}/{summary.baselineProbes} ·
                            进入前三 {summary.topThree} · 已收录 {summary.indexedItems}
                          </span>
                        </summary>
                        <p className="mt-1 text-[var(--ink-subtle)]">
                          计划时间 {run.scheduledFor}
                        </p>
                        {probes.map((unit, index) => {
                          const evidence = probeEvidence(unit);
                          return (
                            <div
                              key={unit.id}
                              className="mt-1 rounded bg-[var(--paper-inset)] p-1.5"
                            >
                              <p className="text-[var(--ink)]">
                                {questionLabels.get(evidence?.questionId ?? "") ??
                                  `复测问题 ${index + 1}`}
                                <span className="ml-1 text-[var(--ink-muted)]">
                                  {rankLabel(evidence, unit.status)}
                                </span>
                              </p>
                              {evidence && (
                                <>
                                  <p className="mt-1 whitespace-pre-wrap break-words leading-4 text-[var(--ink-secondary)]">
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
                                        className="mt-1 block break-all text-[var(--accent)]"
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
                          <p className="mt-1 text-[var(--ink-subtle)]">
                            另有 {run.units.length - probes.length} 个观测单元未展开。
                          </p>
                        )}
                      </details>
                    );
                  })}
                </div>
              )}
            </section>

            {busy && (
              <p className="flex items-center gap-1 text-[var(--ink-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在读取真实效果数据…
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
});
