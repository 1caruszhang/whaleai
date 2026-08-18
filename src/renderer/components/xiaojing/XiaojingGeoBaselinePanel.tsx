import { ExternalLink as ExternalLinkIcon, Loader2, Radar, RotateCcw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  loadGeoBaselineEngines,
  loadLatestGeoBaseline,
  retryGeoBaselineUnits,
  startGeoBaseline,
} from "@/api/geoBaselineClient";
import { loadLatestQuestionPool } from "@/api/brandQuestionPoolClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import ExternalLink from "@/components/ExternalLink";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  GeoBaselineEngineAvailability,
  GeoBaselineEngineId,
  GeoBaselineProjection,
} from "../../../shared/geo/baseline";
import type { QuestionPoolProjection } from "../../../shared/geo/questionPool";

interface XiaojingGeoBaselinePanelProps {
  workspaceId: string;
  refreshKey?: number;
  /** 工作台只读挂载：仅展示基线结果，引擎选择/启动/重试交互在「效果」
   * 整页与聊天 geo-observation 确认面板。 */
  readOnly?: boolean;
  /** Fired after a start/retry committed real evidence (effects entry linkage). */
  onResultCommitted?: () => void;
}

function requestId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `geo-baseline-${crypto.randomUUID()}`;
  }
  return `geo-baseline-${Date.now()}`;
}

function percentage(value: number | null): string {
  return value === null ? "暂无数据" : `${value}%`;
}

export default memo(function XiaojingGeoBaselinePanel({
  workspaceId,
  refreshKey = 0,
  readOnly = false,
  onResultCommitted,
}: XiaojingGeoBaselinePanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const [engines, setEngines] = useState<GeoBaselineEngineAvailability[]>([]);
  const [selectedEngines, setSelectedEngines] = useState<GeoBaselineEngineId[]>([]);
  const [pool, setPool] = useState<QuestionPoolProjection | null>(null);
  const [baseline, setBaseline] = useState<GeoBaselineProjection | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "running" | "retrying">("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      // 最新基线是 Rust IPC 投影读取：效果页无会话时也照常展示真实结果；
      // 引擎可用性与问题池属于会话控制面，仅在有真实会话时读取。
      const nextBaseline = await loadLatestGeoBaseline(workspaceId);
      if (!hasRealSession || !sessionId) {
        setEngines([]);
        setPool(null);
        setBaseline(nextBaseline);
        return;
      }
      const identity = { workspaceId, sessionId };
      const [nextEngines, nextPool] = await Promise.all([
        loadGeoBaselineEngines(apiPost, identity),
        loadLatestQuestionPool(apiPost, identity),
      ]);
      setEngines(nextEngines);
      setSelectedEngines((current) => {
        const stillAvailable = current.filter((id) =>
          nextEngines.some((engine) => engine.id === id && engine.available),
        );
        return stillAvailable.length > 0
          ? stillAvailable
          : nextEngines.filter((engine) => engine.available).map((engine) => engine.id);
      });
      setPool(nextPool);
      setBaseline(nextBaseline);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStatus("idle");
    }
  }, [apiPost, hasRealSession, sessionId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const available = engines.filter((engine) => engine.available);
  const confirmedPool = pool?.status === "confirmed" ? pool : null;
  const canStart = Boolean(
    confirmedPool && selectedEngines.length > 0 && status === "idle",
  );

  const start = useCallback(async () => {
    if (!sessionId || !canStart || !confirmedPool) return;
    setStatus("running");
    setError(null);
    try {
      // Re-read immediately before execution so a stale UI projection cannot
      // start against a pool that has not actually been confirmed.
      const currentPool = await loadLatestQuestionPool(
        apiPost,
        { workspaceId, sessionId },
      );
      if (!currentPool || currentPool.status !== "confirmed") {
        throw new Error("请先确认问题池，再开始优化前检测");
      }
      const result = await startGeoBaseline(
        apiPost,
        { workspaceId, sessionId },
        {
          questionPoolId: currentPool.id,
          engineIds: selectedEngines,
          idempotencyKey: requestId(),
        },
      );
      setPool(currentPool);
      setBaseline(result);
      onResultCommitted?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStatus("idle");
    }
  }, [apiPost, canStart, confirmedPool, onResultCommitted, selectedEngines, sessionId, workspaceId]);

  const retry = useCallback(
    async (unitId: string) => {
      if (!sessionId || !baseline || status !== "idle") return;
      setStatus("retrying");
      setError(null);
      try {
        const next = await retryGeoBaselineUnits(
          apiPost,
          { workspaceId, sessionId },
          { baselineId: baseline.id, unitIds: [unitId] },
        );
        setBaseline(next);
        onResultCommitted?.();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setStatus("idle");
      }
    },
    [apiPost, baseline, onResultCommitted, sessionId, status, workspaceId],
  );

  const metricCards = useMemo(() => {
    if (!baseline) return [];
    return [
      {
        label: "被提及",
        value: percentage(baseline.metrics.mentionRate),
        ids: baseline.metrics.evidenceUnitIds.brandMentioned,
      },
      {
        label: "被推荐",
        value: percentage(baseline.metrics.recommendationRate),
        ids: baseline.metrics.evidenceUnitIds.brandRecommended,
      },
      {
        label: "有引用依据",
        value: percentage(baseline.metrics.citationRate),
        ids: baseline.metrics.evidenceUnitIds.withCitationEvidence,
      },
    ];
  }, [baseline]);

  return (
    <section
      aria-label="优化前 GEO 基线"
      className="rounded-xl border border-[var(--geo-dash-border,var(--line))] bg-[var(--geo-dash-card,var(--paper-elevated))] p-3"
    >
      <div className="flex items-start gap-2">
        <Radar className="mt-0.5 h-4 w-4 shrink-0 text-[var(--geo-dash-secondary,var(--accent))]" />
        <div>
          <h3 className="text-sm font-medium text-[var(--geo-dash-text,var(--ink))]">优化前检测</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
            对已确认问题逐题执行真实 AI 搜索，并保留可下钻原始回答。
          </p>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={() => void load()}
            disabled={status !== "idle"}
            className="ml-auto text-xs font-medium text-[var(--geo-dash-secondary,var(--accent))] disabled:opacity-50"
          >
            刷新
          </button>
        )}
      </div>

      {!hasRealSession ? (
        <p className="mt-3 rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-xs leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
          基线结果已按真实数据展示；打开该品牌的会话后，才能选择引擎并执行检测与重试。
        </p>
      ) : available.length === 0 && status !== "loading" ? (
        <div className="mt-3 rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-xs leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
          <p className="font-medium text-[var(--geo-dash-text,var(--ink))]">当前不可检测</p>
          <p>{engines[0]?.unavailableReason ?? "没有可用的真实检测 Provider"}</p>
        </div>
      ) : !readOnly ? (
        <>
          <div className="mt-3 space-y-1.5" aria-label="目标引擎">
            {engines.map((engine) => (
              <label
                key={engine.id}
                className="flex items-center gap-2 rounded-md border border-[var(--geo-dash-border,var(--line))] px-2 py-1.5 text-xs text-[var(--geo-dash-text,var(--ink))]"
              >
                <input
                  type="checkbox"
                  checked={selectedEngines.includes(engine.id)}
                  disabled={!engine.available || status !== "idle"}
                  onChange={(event) => {
                    setSelectedEngines((current) =>
                      event.target.checked
                        ? [...new Set([...current, engine.id])]
                        : current.filter((id) => id !== engine.id),
                    );
                  }}
                />
                <span>{engine.label}</span>
                <span className="ml-auto text-[var(--geo-dash-text-mute,var(--ink-subtle))]">
                  {engine.available ? engine.snapshot.searchMode : "未配置"}
                </span>
              </label>
            ))}
          </div>

          {!confirmedPool && status !== "loading" && (
            <p className="mt-2 rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-xs text-[var(--geo-dash-text-mute,var(--ink-muted))]">
              请先在会话中确认问题池，再启动优化前检测。
            </p>
          )}
          <button
            type="button"
            onClick={() => void start()}
            disabled={!canStart}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
          >
            {status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {status === "running" ? "正在逐题检测" : "开始优化前检测"}
          </button>
        </>
      ) : (
        <p className="mt-3 rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-xs leading-5 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
          检测的引擎选择与启动在「效果」页或聊天中的确认卡片完成；这里只展示真实检测结果。
        </p>
      )}

      {error && (
        <p className="mt-2 break-words rounded-lg bg-[var(--geo-dash-danger,var(--error))]/10 p-2 text-xs text-[var(--geo-dash-danger,var(--error))]">
          {error}
        </p>
      )}

      {!baseline && status === "idle" && (
        <p className="mt-3 text-center text-xs text-[var(--geo-dash-text-mute,var(--ink-subtle))]">
          暂无真实检测数据
        </p>
      )}

      {baseline && (
        <div className="mt-3" role="region" aria-label="真实 GEO 基线结果">
          <div className="flex flex-wrap gap-1 text-xs text-[var(--geo-dash-text-mute,var(--ink-muted))]">
            <span className="rounded-full bg-[var(--geo-dash-bg-2,var(--paper-inset))] px-2 py-0.5">
              知识 v{baseline.knowledgeVersion}
            </span>
            <span className="rounded-full bg-[var(--geo-dash-bg-2,var(--paper-inset))] px-2 py-0.5">
              问题池 v{baseline.questionPoolRevision}
            </span>
            <span className="rounded-full bg-[var(--geo-dash-bg-2,var(--paper-inset))] px-2 py-0.5">
              {baseline.metrics.succeeded}/{baseline.metrics.total} 个真实结果
            </span>
          </div>

          {baseline.metrics.succeeded === 0 && (
            <p className="mt-2 rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-xs text-[var(--geo-dash-text-mute,var(--ink-muted))]">
              暂无真实检测数据。Provider 失败不会被计为成功，请查看下方诊断并逐项重试。
            </p>
          )}

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {metricCards.map((metric) => (
              <a
                key={metric.label}
                href={metric.ids[0] ? `#geo-evidence-${metric.ids[0]}` : undefined}
                className="rounded-lg bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-center"
              >
                <span className="block text-xs text-[var(--geo-dash-text-mute,var(--ink-muted))]">{metric.label}</span>
                <span className="mt-0.5 block text-sm font-semibold text-[var(--geo-dash-text,var(--ink))]">{metric.value}</span>
                {metric.ids.length > 0 && (
                  <span className="text-xs text-[var(--geo-dash-secondary,var(--accent))]">查看 {metric.ids.length} 条证据</span>
                )}
              </a>
            ))}
          </div>

          <div className="mt-2 space-y-2">
            {baseline.units.map((unit) => (
              <details
                id={`geo-evidence-${unit.id}`}
                key={unit.id}
                className="rounded-lg border border-[var(--geo-dash-border,var(--line))] p-2 text-xs"
              >
                <summary className="cursor-pointer list-none">
                  <span className="font-medium text-[var(--geo-dash-text,var(--ink))]">{unit.question}</span>
                  <span className="ml-1 text-[var(--geo-dash-text-mute,var(--ink-subtle))]">· {unit.engineId}</span>
                  <span
                    className={`ml-1 ${unit.status === "failed" ? "text-[var(--geo-dash-danger,var(--error))]" : "text-[var(--geo-dash-secondary,var(--accent))]"}`}
                  >
                    {unit.status === "succeeded"
                      ? "成功"
                      : unit.status === "failed"
                        ? "失败"
                        : "检测中"}
                  </span>
                </summary>
                {unit.status === "failed" ? (
                  <div className="mt-2 rounded bg-[var(--geo-dash-danger,var(--error))]/10 p-2 text-[var(--geo-dash-danger,var(--error))]">
                    <p>{unit.errorCode}: {unit.errorMessage}</p>
                    {!readOnly && hasRealSession && (
                      <button
                        type="button"
                        onClick={() => void retry(unit.id)}
                        disabled={status !== "idle"}
                        className="mt-1 flex items-center gap-1 font-medium disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        只重试此问题
                      </button>
                    )}
                  </div>
                ) : unit.status === "succeeded" ? (
                  <div className="mt-2 space-y-2 text-[var(--geo-dash-text-mute,var(--ink-muted))]">
                    <p className="whitespace-pre-wrap break-words rounded bg-[var(--geo-dash-bg-2,var(--paper-inset))] p-2 text-[var(--geo-dash-text,var(--ink))]">
                      {unit.rawAnswer}
                    </p>
                    <p>
                      提及：{unit.analysis?.brandMentioned ? "是" : "否"} · 推荐：
                      {unit.analysis?.brandRecommended ? "是" : "否"} · 引用：
                      {unit.analysis?.hasCitationEvidence ? "是" : "否"}
                    </p>
                    {unit.citations.map((citation) => (
                      <ExternalLink
                        key={citation.url}
                        href={citation.url}
                        className="flex items-center gap-1 break-all text-[var(--geo-dash-secondary,var(--accent))]"
                      >
                        <ExternalLinkIcon className="h-3 w-3 shrink-0" />
                        {citation.title || citation.url} · {citation.provenance}
                      </ExternalLink>
                    ))}
                  </div>
                ) : null}
                {unit.attempts.length > 1 && (
                  <p className="mt-2 text-[var(--geo-dash-text-mute,var(--ink-subtle))]">
                    已保留 {unit.attempts.length} 次尝试记录
                  </p>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  );
});
