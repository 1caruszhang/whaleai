import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { memo } from "react";

import type { GeoMetricTrend } from "../../../shared/geo/postPublishMonitoring";
import type { GeoEffectKpi } from "./geoEffectViewModel";

/**
 * KPI 六卡 + delta 噪声纪律：单轮变化标「观测波动」中性样式，连续两轮
 * 同向才标趋势色（判断逻辑见 shared classifyGeoMetricTrend）。传 onJump
 * 时整卡为可点击锚点，跳到证据库。
 */
function DeltaBadge({
  delta,
  trend,
}: {
  delta: number | null;
  trend: GeoMetricTrend;
}) {
  if (delta === null || trend === "insufficient") return null;
  if (trend === "flat") {
    return (
      <span
        data-testid="geo-effect-kpi-delta"
        className="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums"
        style={{ color: "var(--geo-dash-text-mute)" }}
      >
        持平
      </span>
    );
  }
  const direction = delta >= 0 ? "up" : "down";
  // 只有两轮确认的同向变化才给趋势色；单轮波动保持中性并文字标注。
  const color =
    trend === "up"
      ? "var(--geo-dash-success)"
      : trend === "down"
        ? "var(--geo-dash-secondary)"
        : "var(--geo-dash-text-mute)";
  return (
    <span
      data-testid="geo-effect-kpi-delta"
      className="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums"
      style={{ color }}
    >
      {direction === "up" ? (
        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      ) : (
        <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
      )}
      {direction === "up" ? "+" : ""}
      {delta}pp
      {trend === "fluctuating" && (
        <span className="ml-1 font-normal">观测波动</span>
      )}
    </span>
  );
}

function KpiCardBody({ kpi }: { kpi: GeoEffectKpi }) {
  return (
    <>
      <span className="block text-xs uppercase tracking-wide text-[var(--geo-dash-text-mute)]">
        {kpi.label}
      </span>
      <span className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-lg font-semibold tabular-nums text-[var(--geo-dash-text)]">
          {kpi.value}
        </span>
        <DeltaBadge delta={kpi.delta} trend={kpi.trend} />
      </span>
      <span className="mt-1 block text-xs leading-4 text-[var(--geo-dash-text-mute)]">
        {kpi.sub}
      </span>
    </>
  );
}

export default memo(function GeoEffectKpiStrip({
  kpis,
  onJump,
}: {
  kpis: readonly GeoEffectKpi[];
  /** 看板模式：点击卡片锚点跳到证据库。报告模式省略（纯展示）。 */
  onJump?: () => void;
}) {
  const cardClass =
    "geo-dash-shimmer relative overflow-hidden rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-4";
  return (
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
      data-testid="geo-effect-kpi-strip"
    >
      {kpis.map((kpi) =>
        onJump ? (
          <button
            key={kpi.key}
            type="button"
            data-testid={`geo-effect-kpi-${kpi.key}`}
            aria-label={`查看${kpi.label}证据`}
            onClick={onJump}
            className={`${cardClass} w-full text-left transition-colors hover:border-[var(--geo-dash-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--geo-dash-secondary)]`}
          >
            <KpiCardBody kpi={kpi} />
          </button>
        ) : (
          <article
            key={kpi.key}
            data-testid={`geo-effect-kpi-${kpi.key}`}
            className={cardClass}
          >
            <KpiCardBody kpi={kpi} />
          </article>
        ),
      )}
    </div>
  );
});
