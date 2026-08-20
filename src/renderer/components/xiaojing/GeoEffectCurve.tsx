import { memo } from "react";

import type { CurvePoint } from "./geoEffectViewModel";

/** js_ai-style 双线优化效果曲线：基线为灰虚线水平参考，各轮监测为渐变主线
 * + 面积；几何沿用 js_ai GeoDemoDashboard 的 580×180 坐标系（x∈[50,540]）。 */
export default memo(function GeoEffectCurve({
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
          <stop
            offset="0%"
            stopColor="var(--geo-dash-primary)"
            stopOpacity="0.25"
          />
          <stop
            offset="100%"
            stopColor="var(--geo-dash-secondary)"
            stopOpacity="0"
          />
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
          stroke="var(--geo-dash-grid-soft, rgba(0, 0, 0, 0.04))"
          strokeWidth="1"
        />
      ))}
      <line
        x1="50"
        y1="160"
        x2="540"
        y2="160"
        stroke="var(--geo-dash-grid-axis, rgba(0, 0, 0, 0.12))"
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
});
