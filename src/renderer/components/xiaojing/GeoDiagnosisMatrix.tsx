import { memo } from "react";

import type { GeoMetricTrend } from "../../../shared/geo/postPublishMonitoring";
import {
  baselineSideLabel,
  diagnosisLabel,
  latestSideLabel,
  percentage,
  type GeoEffectQuestionRow,
  type GeoQuestionDisplay,
} from "./geoEffectViewModel";

/**
 * 问题诊断矩阵：每题一行 = 诊断徽章（文字为载体，颜色仅辅助分层）+
 * 基线 → 最新轮 before/after + 两轮确认的趋势箭头；竞品命中行显示竞品名。
 * 失败单元显示「失败」，绝不落入「缺席」（classify 对无 analysis 的单元的
 * 缺省）——门控在 geoEffectViewModel.buildRows 完成。
 */

const DIAGNOSIS_STYLES: Record<GeoQuestionDisplay, string> = {
  "suspected-negative":
    "bg-[var(--geo-dash-badge-amber-bg,var(--warning-bg))] text-[var(--geo-dash-amber,var(--warning))]",
  "competitor-dominated":
    "bg-[var(--geo-dash-badge-coral-bg,var(--accent-warm-subtle))] text-[var(--geo-dash-coral,var(--accent))]",
  absent:
    "bg-[var(--geo-dash-badge-mute-bg,var(--hover-bg))] text-[var(--geo-dash-text-mute,var(--ink-muted))]",
  "low-ranked":
    "bg-[var(--geo-dash-badge-primary-bg,var(--accent-warm-subtle))] text-[var(--geo-dash-primary,var(--accent))]",
  ok: "bg-[var(--geo-dash-badge-success-bg,var(--success-bg))] text-[var(--geo-dash-success,var(--success))]",
  failed:
    "bg-[var(--geo-dash-badge-danger-bg,var(--error-bg))] text-[var(--geo-dash-danger,var(--error))]",
  "no-data":
    "border border-[var(--geo-dash-border,var(--line))] text-[var(--geo-dash-text-mute,var(--ink-muted))]",
};

export const DiagnosisBadge = memo(function DiagnosisBadge({
  display,
}: {
  display: GeoQuestionDisplay;
}) {
  return (
    <span
      data-diagnosis={display}
      className={`inline-flex w-[76px] shrink-0 items-center justify-center rounded px-1.5 py-0.5 text-center text-xs font-semibold ${DIAGNOSIS_STYLES[display]}`}
    >
      {diagnosisLabel(display)}
    </span>
  );
});

const TREND_GLYPHS: Record<
  GeoMetricTrend,
  { glyph: string; label: string; color: string }
> = {
  up: {
    glyph: "↗",
    label: "连续两轮上升",
    color: "var(--geo-dash-success)",
  },
  down: {
    glyph: "↘",
    label: "连续两轮下降",
    color: "var(--geo-dash-secondary)",
  },
  flat: { glyph: "→", label: "持平", color: "var(--geo-dash-text-mute)" },
  fluctuating: {
    glyph: "～",
    label: "观测波动（单轮变化，未确认趋势）",
    color: "var(--geo-dash-text-mute)",
  },
  insufficient: {
    glyph: "—",
    label: "数据不足",
    color: "var(--geo-dash-text-mute)",
  },
};

export function TrendGlyph({ trend }: { trend: GeoMetricTrend }) {
  const entry = TREND_GLYPHS[trend];
  return (
    <span
      role="img"
      aria-label={entry.label}
      title={entry.label}
      className="w-4 shrink-0 text-center font-mono text-xs"
      style={{ color: entry.color }}
    >
      {entry.glyph}
    </span>
  );
}

export default memo(function GeoDiagnosisMatrix({
  rows,
  compact = false,
  onLocate,
}: {
  rows: readonly GeoEffectQuestionRow[];
  /** 报告视图精简版：隐藏 before/after 双值与命中率。 */
  compact?: boolean;
  /** 看板模式：点击题面锚点跳到证据库对应条目。 */
  onLocate?: (questionId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="mt-3 leading-5 text-[var(--geo-dash-text-mute)]">
        暂无该引擎的真实复测记录。
      </p>
    );
  }
  return (
    <>
      <div data-testid="geo-effect-matrix" className="mt-3 space-y-2.5">
        {rows.map((row) => {
          const hitRate = percentage(row.mentionedRuns, row.totalRuns);
          return (
            <div key={row.questionId} className="flex items-center gap-3">
              <DiagnosisBadge display={row.display} />
              <span className="min-w-0 flex-1">
                {onLocate ? (
                  <button
                    type="button"
                    onClick={() => onLocate(row.questionId)}
                    aria-label={`查看「${row.question}」的证据`}
                    className="block w-full truncate text-left text-xs text-[var(--geo-dash-text-dim)] transition-colors hover:text-[var(--geo-dash-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--geo-dash-secondary)]"
                  >
                    {row.question}
                  </button>
                ) : (
                  <span className="block truncate text-xs text-[var(--geo-dash-text-dim)]">
                    {row.question}
                  </span>
                )}
                {row.competitorMentions.length > 0 && (
                  <span className="block truncate text-xs text-[var(--geo-dash-coral)]">
                    竞品：{row.competitorMentions.join("、")}
                  </span>
                )}
              </span>
              {!compact && (
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  <span className="text-[var(--geo-dash-text-mute)]">
                    {baselineSideLabel(row)}
                  </span>
                  <span className="mx-1 text-[var(--geo-dash-text-mute)]">
                    →
                  </span>
                  <span className="text-[var(--geo-dash-text)]">
                    {latestSideLabel(row)}
                  </span>
                </span>
              )}
              <TrendGlyph trend={row.trend} />
              {!compact && (
                <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-[var(--geo-dash-text)]">
                  {hitRate === null ? "—" : `${hitRate}%`}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {!compact && (
        <p className="mt-3 text-xs leading-4 text-[var(--geo-dash-text-mute)]">
          徽章为最新一轮诊断；趋势箭头需连续两轮同向才确认，单轮变化记为观测波动；疑似负面为复核线索，请展开证据库核对原文。
        </p>
      )}
    </>
  );
});
