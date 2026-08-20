import { Library } from "lucide-react";
import { memo } from "react";

import ExternalLink from "@/components/ExternalLink";
import { DiagnosisBadge } from "./GeoDiagnosisMatrix";
import {
  runStatusLabel,
  truncateRawAnswer,
  type GeoEvidenceEntry,
} from "./geoEffectViewModel";

/**
 * 证据/样本库（合并原「监测观测日志」职责）：按题聚合，每题可展开看基线
 * 与各轮 rawAnswer 截断、引用 URL 外链与解析依据 excerpt。轮次条目标
 * `geo-effect-log-run-*`；同一轮次会在多题下各出现一次。
 * 人工修正入口（geolook sample correction）本期不做——如需，在此按题挂修正 UI。
 */
export default memo(function GeoEvidenceLibrary({
  entries,
}: {
  entries: readonly GeoEvidenceEntry[];
}) {
  return (
    <section
      aria-label="证据样本库"
      id="geo-effect-evidence"
      className="rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card-2)] p-5"
    >
      <div className="flex items-center gap-2">
        <Library className="h-3.5 w-3.5 text-[var(--geo-dash-secondary)]" />
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--geo-dash-secondary)]">
          证据样本库
        </span>
      </div>
      <p className="mt-1 text-xs leading-4 text-[var(--geo-dash-text-mute)]">
        数字来源：真实基线探测与监测轮次；原始回答截断展示，解析依据为确定性规则命中片段。
      </p>
      {entries.length === 0 ? (
        <p className="mt-3 leading-5 text-[var(--geo-dash-text-mute)]">
          尚未产生真实监测轮次。启用发布后监测后，这里按轮次展示观测与原始证据。
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map((entry) => (
            <details
              key={entry.questionId}
              id={`geo-effect-evidence-${entry.questionId}`}
              className="rounded-lg border border-[var(--geo-dash-border)] bg-[var(--geo-dash-bg-2)] p-2"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <DiagnosisBadge display={entry.display} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--geo-dash-text)]">
                  {entry.question}
                </span>
                <span className="shrink-0 text-xs text-[var(--geo-dash-text-mute)]">
                  {entry.rounds.length > 0
                    ? `${entry.rounds.length} 轮记录`
                    : "仅基线"}
                </span>
              </summary>

              {entry.baselineUnit && (
                <div className="mt-1 rounded bg-[var(--geo-dash-card)] p-1.5">
                  <p className="text-xs text-[var(--geo-dash-text)]">
                    <span className="font-medium text-[var(--geo-dash-primary)]">
                      基线
                    </span>
                    <span className="ml-1 text-[var(--geo-dash-text-mute)]">
                      {entry.baselineUnit.status === "failed"
                        ? "失败"
                        : entry.baselineUnit.analysis?.brandMentioned === true
                          ? "提及"
                          : "未提及"}
                    </span>
                  </p>
                  {entry.baselineUnit.rawAnswer && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-4 text-[var(--geo-dash-text-dim)]">
                      {truncateRawAnswer(entry.baselineUnit.rawAnswer)}
                    </p>
                  )}
                  {entry.baselineUnit.analysis?.mentionExcerpt && (
                    <p className="mt-1 break-words text-xs leading-4 text-[var(--geo-dash-text-mute)]">
                      解析依据（品牌）：
                      {entry.baselineUnit.analysis.mentionExcerpt}
                    </p>
                  )}
                </div>
              )}

              {entry.rounds.map(({ run, unit, evidence }) => (
                <div
                  key={run.id}
                  data-testid={`geo-effect-log-run-${run.ordinal}`}
                  className="mt-1 rounded bg-[var(--geo-dash-card)] p-1.5"
                >
                  <p className="text-xs">
                    <span className="font-mono text-[var(--geo-dash-text-mute)]">
                      [
                      {new Date(run.scheduledFor).toLocaleTimeString("zh-CN", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                      ]
                    </span>{" "}
                    <span className="font-medium text-[var(--geo-dash-primary)]">
                      第{run.ordinal}轮
                    </span>
                    <span className="text-[var(--geo-dash-text-mute)]">
                      {" "}
                      · {runStatusLabel(run.status)} ·{" "}
                      {unit.status === "failed"
                        ? "本题失败"
                        : evidence
                          ? evidence.rankPosition
                            ? `TOP${evidence.rankPosition}`
                            : evidence.analysis.brandMentioned
                              ? "未进前三"
                              : "未提及"
                          : "无数据"}
                    </span>
                  </p>
                  {evidence && (
                    <>
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-4 text-[var(--geo-dash-text-dim)]">
                        {truncateRawAnswer(evidence.rawAnswer)}
                      </p>
                      {evidence.analysis.mentionExcerpt && (
                        <p className="mt-1 break-words text-xs leading-4 text-[var(--geo-dash-text-mute)]">
                          解析依据（品牌）：{evidence.analysis.mentionExcerpt}
                        </p>
                      )}
                      {evidence.analysis.competitorExcerpt && (
                        <p className="mt-1 break-words text-xs leading-4 text-[var(--geo-dash-text-mute)]">
                          解析依据（竞品
                          {entry.competitorMentions.length > 0
                            ? `：${entry.competitorMentions.join("、")}`
                            : ""}
                          ）：{evidence.analysis.competitorExcerpt}
                        </p>
                      )}
                      {evidence.citedUrls.slice(0, 3).map((url) => (
                        <ExternalLink
                          key={url}
                          href={url}
                          className="mt-1 block break-all text-xs text-[var(--geo-dash-secondary)]"
                        >
                          {url}
                        </ExternalLink>
                      ))}
                    </>
                  )}
                  {unit.status === "failed" && unit.errorMessage && (
                    <p className="mt-1 break-words text-xs leading-4 text-[var(--geo-dash-danger)]">
                      {unit.errorCode}：{unit.errorMessage}
                    </p>
                  )}
                </div>
              ))}
            </details>
          ))}
        </div>
      )}
    </section>
  );
});
