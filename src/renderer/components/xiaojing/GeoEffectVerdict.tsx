import { ScanLine } from "lucide-react";
import { memo } from "react";

import {
  buildGeoEffectVerdictText,
  type GeoEffectVerdictData,
} from "./geoEffectViewModel";

/**
 * 一句话结论条：文本由真实数据确定性拼接（见 buildGeoEffectVerdictText）；
 * 无数据时如实标注「暂无真实数据」，不造句。
 */
export default memo(function GeoEffectVerdict({
  verdict,
}: {
  verdict: GeoEffectVerdictData | null;
}) {
  return (
    <div
      data-testid="geo-effect-verdict"
      className="geo-dash-grid-texture relative overflow-hidden rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] px-4 py-3"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
        <ScanLine className="h-3.5 w-3.5" aria-hidden="true" />
        一句话结论
      </div>
      {verdict ? (
        <p className="mt-1 break-words text-sm font-medium leading-6 text-[var(--geo-dash-text)]">
          {buildGeoEffectVerdictText(verdict)}
        </p>
      ) : (
        <p className="mt-1 text-sm leading-6 text-[var(--geo-dash-text-mute)]">
          暂无真实数据：完成基线探测并产生监测轮次后，这里给出确定性结论。
        </p>
      )}
      {verdict && verdict.suspectedNegative > 0 && (
        <p className="mt-1 text-xs leading-4 text-[var(--geo-dash-amber)]">
          疑似负面为复核线索而非判决，请在下方证据库核对原文。
        </p>
      )}
    </div>
  );
});
