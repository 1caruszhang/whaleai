import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronUp,
  ExternalLink as ExternalLinkIcon,
  Loader2,
  RefreshCcw,
  Search,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  loadGeoDashboard,
  loadGeoDashboardDrilldown,
} from "@/api/geoDashboardClient";
import CustomSelect from "@/components/CustomSelect";
import ExternalLink from "@/components/ExternalLink";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  geoDashboardMetric,
  type GeoDashboardDrilldown,
  type GeoDashboardEvidenceAnchor,
  type GeoDashboardFilter,
  type GeoDashboardMetric,
  type GeoDashboardMetricKey,
  type GeoDashboardProjection,
} from "../../../shared/geo/dashboard";

interface Props {
  workspaceId: string;
}

const METRIC_LABEL: Record<GeoDashboardMetricKey, string> = {
  "brand-mention": "品牌提及",
  recommendation: "推荐倾向",
  "citation-coverage": "引用覆盖",
  "question-coverage": "问题覆盖",
  "content-publish": "内容 / 发布状态",
  "monitor-change": "监测变化",
};

export function dateInputToUtc(value: string): string | undefined {
  if (!value) return undefined;
  // `datetime-local` deliberately carries no zone. This control is labelled
  // UTC, so append Z before parsing instead of applying the machine timezone.
  const date = new Date(`${value}Z`);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function availabilityText(metric: GeoDashboardMetric): string {
  if (metric.availability === "unavailable") return "Provider 未配置";
  if (metric.availability === "empty") return "暂无真实数据";
  if (metric.availability === "partial") return "数据部分可用";
  return "数据完整";
}

function metricValue(metric: GeoDashboardMetric): string {
  return metric.value === null ? "暂无真实检测数据" : `${metric.value}%`;
}

function metricTone(metric: GeoDashboardMetric): string {
  if (
    metric.availability === "unavailable" ||
    metric.availability === "empty"
  ) {
    return "text-[var(--ink-muted)]";
  }
  if (
    metric.availability === "partial" ||
    metric.sampleSufficiency === "insufficient"
  ) {
    return "text-[var(--warning)]";
  }
  return "text-[var(--ink)]";
}

function statusBreakdown(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 0
    ? "暂无"
    : entries.map(([status, count]) => `${status} ${count}`).join("、");
}

export default memo(function XiaojingRealGeoDashboard({ workspaceId }: Props) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const identity = useMemo(
    () =>
      sessionId && !isPendingSessionId(sessionId)
        ? { workspaceId, sessionId }
        : null,
    [sessionId, workspaceId],
  );
  const [expanded, setExpanded] = useState(true);
  const [dashboard, setDashboard] = useState<GeoDashboardProjection | null>(
    null,
  );
  const [appliedFilters, setAppliedFilters] = useState<GeoDashboardFilter>({});
  const [sessionFilter, setSessionFilter] = useState("");
  const [operationFilter, setOperationFilter] = useState("");
  const [engineFilter, setEngineFilter] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<GeoDashboardDrilldown | null>(
    null,
  );
  const [drilldownBusy, setDrilldownBusy] = useState(false);

  const load = useCallback(async () => {
    if (!identity) {
      setDashboard(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setDashboard(await loadGeoDashboard(apiPost, identity, appliedFilters));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiPost, appliedFilters, identity]);

  useEffect(() => {
    let active = true;
    if (!identity) return;
    setBusy(true);
    setError(null);
    void loadGeoDashboard(apiPost, identity, appliedFilters)
      .then((result) => active && setDashboard(result))
      .catch(
        (cause) =>
          active &&
          setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [apiPost, appliedFilters, identity]);

  const applyFilters = useCallback(() => {
    setDrilldown(null);
    const from = dateInputToUtc(fromInput);
    const toExclusive = dateInputToUtc(toInput);
    setAppliedFilters({
      ...(sessionFilter ? { sessionId: sessionFilter } : {}),
      ...(operationFilter ? { operationId: operationFilter } : {}),
      ...(engineFilter ? { engineId: engineFilter } : {}),
      ...(from ? { from } : {}),
      ...(toExclusive ? { toExclusive } : {}),
    });
  }, [engineFilter, fromInput, operationFilter, sessionFilter, toInput]);

  const openEvidence = useCallback(
    async (anchor: GeoDashboardEvidenceAnchor) => {
      if (!identity || drilldownBusy) return;
      setDrilldownBusy(true);
      setError(null);
      try {
        setDrilldown(
          await loadGeoDashboardDrilldown(apiPost, identity, {
            kind: anchor.kind,
            id: anchor.id,
          }),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setDrilldownBusy(false);
      }
    },
    [apiPost, drilldownBusy, identity],
  );

  const empty =
    dashboard?.metrics.every((metric) => metric.completeness.total === 0) ??
    false;
  const providerUnavailable =
    dashboard &&
    dashboard.providerEngines.length > 0 &&
    !dashboard.providerEngines.some(
      (engine) =>
        engine.available &&
        (!dashboard.filters.engineId ||
          engine.id === dashboard.filters.engineId),
    );

  return (
    <section
      className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
      data-testid="real-geo-dashboard"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-[var(--hover-bg)]"
        aria-expanded={expanded}
      >
        <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold">真实品牌 GEO 仪表盘</span>
        <span className="ml-auto text-xs text-[var(--ink-muted)]">
          {dashboard?.workspaceName ?? "当前品牌"}
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[var(--ink-muted)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--ink-muted)]" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--line-subtle)] p-3">
          {!identity ? (
            <p className="rounded-xl border border-dashed border-[var(--line)] p-4 text-xs text-[var(--ink-muted)]">
              建立真实 Session 后可读取该品牌的跨 Session 累计投影。
            </p>
          ) : (
            <>
              <DashboardFilters
                dashboard={dashboard}
                sessionFilter={sessionFilter}
                operationFilter={operationFilter}
                engineFilter={engineFilter}
                fromInput={fromInput}
                toInput={toInput}
                busy={busy}
                onSession={setSessionFilter}
                onOperation={setOperationFilter}
                onEngine={setEngineFilter}
                onFrom={setFromInput}
                onTo={setToInput}
                onApply={applyFilters}
                onRefresh={() => void load()}
              />

              {error && (
                <div
                  role="alert"
                  className="mt-3 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]"
                >
                  仪表盘读取失败：{error}
                </div>
              )}
              {providerUnavailable && (
                <div className="mt-3 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-3 text-xs text-[var(--warning)]">
                  当前筛选引擎的 Provider
                  未配置；历史真实数据仍可查看，但无法产生新样本。
                </div>
              )}
              {empty && !busy && (
                <div
                  data-testid="geo-dashboard-empty"
                  className="mt-3 rounded-xl border border-dashed border-[var(--line)] p-4 text-center text-xs text-[var(--ink-muted)]"
                >
                  暂无真实检测数据。仪表盘不会用 0%、演示值或随机结果替代。
                </div>
              )}
              {busy && !dashboard ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--ink-muted)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在读取真实品牌数据…
                </div>
              ) : dashboard ? (
                <>
                  <KpiStrip dashboard={dashboard} onEvidence={openEvidence} />
                  <TrendPanel dashboard={dashboard} onEvidence={openEvidence} />
                  <QuestionMatrix
                    dashboard={dashboard}
                    onEvidence={openEvidence}
                  />
                  <ObservationLog
                    dashboard={dashboard}
                    onEvidence={openEvidence}
                  />
                  {drilldownBusy && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      读取 exact 证据…
                    </div>
                  )}
                  {drilldown && (
                    <DrilldownCard
                      value={drilldown}
                      onEvidence={openEvidence}
                      onClose={() => setDrilldown(null)}
                    />
                  )}
                </>
              ) : null}
            </>
          )}
        </div>
      )}
    </section>
  );
});

function DashboardFilters({
  dashboard,
  sessionFilter,
  operationFilter,
  engineFilter,
  fromInput,
  toInput,
  busy,
  onSession,
  onOperation,
  onEngine,
  onFrom,
  onTo,
  onApply,
  onRefresh,
}: {
  dashboard: GeoDashboardProjection | null;
  sessionFilter: string;
  operationFilter: string;
  engineFilter: string;
  fromInput: string;
  toInput: string;
  busy: boolean;
  onSession: (value: string) => void;
  onOperation: (value: string) => void;
  onEngine: (value: string) => void;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  onApply: () => void;
  onRefresh: () => void;
}) {
  return (
    <div data-testid="geo-dashboard-filters" className="space-y-2">
      <div className="grid grid-cols-1 gap-2">
        <CustomSelect
          ariaLabel="按 Session 筛选"
          value={sessionFilter}
          onChange={onSession}
          compact
          options={[
            { value: "", label: "全部 Session" },
            ...(dashboard?.dimensions.sessions.map((item) => ({
              value: item.id,
              label: item.label,
            })) ?? []),
          ]}
        />
        <CustomSelect
          ariaLabel="按 GEO Operation 筛选"
          value={operationFilter}
          onChange={onOperation}
          compact
          options={[
            { value: "", label: "全部 GEO Operation" },
            ...(dashboard?.dimensions.operations.map((item) => ({
              value: item.id,
              label: `${item.kind} · ${item.id}`,
            })) ?? []),
          ]}
        />
        <CustomSelect
          ariaLabel="按真实引擎筛选"
          value={engineFilter}
          onChange={onEngine}
          compact
          options={[
            { value: "", label: "全部真实引擎" },
            ...(dashboard?.dimensions.engines.map((item) => ({
              value: item.id,
              label: item.label,
            })) ?? []),
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-[var(--ink-muted)]">
          UTC 起点（含）
          <input
            aria-label="UTC 起点（含）"
            type="datetime-local"
            value={fromInput}
            onChange={(event) => onFrom(event.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)]"
          />
        </label>
        <label className="text-xs text-[var(--ink-muted)]">
          UTC 终点（不含）
          <input
            aria-label="UTC 终点（不含）"
            type="datetime-local"
            value={toInput}
            onChange={(event) => onTo(event.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)]"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={busy}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-xs font-semibold text-[var(--button-primary-text)] disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
          应用组合筛选
        </button>
        <button
          type="button"
          aria-label="刷新仪表盘"
          onClick={onRefresh}
          disabled={busy}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--ink-muted)] disabled:opacity-50"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
        </button>
      </div>
      <p className="text-xs leading-4 text-[var(--ink-subtle)]">
        时间口径：UTC 半开区间 [from,
        to)。引擎筛选只影响探测指标、趋势与问题矩阵，内容 /
        发布状态不随引擎归零。
      </p>
    </div>
  );
}

function KpiStrip({
  dashboard,
  onEvidence,
}: {
  dashboard: GeoDashboardProjection;
  onEvidence: (anchor: GeoDashboardEvidenceAnchor) => void;
}) {
  const keys: GeoDashboardMetricKey[] = [
    "brand-mention",
    "recommendation",
    "citation-coverage",
    "question-coverage",
    "content-publish",
    "monitor-change",
  ];
  return (
    <div
      className="mt-3 grid grid-cols-2 gap-2"
      data-testid="geo-dashboard-kpi-strip"
    >
      {keys.map((key) => {
        const metric = geoDashboardMetric(dashboard, key);
        return (
          <article
            key={key}
            data-testid={`geo-dashboard-kpi-${key}`}
            className="min-w-0 rounded-xl bg-[var(--paper)] p-3"
          >
            <p className="text-xs font-semibold text-[var(--ink-muted)]">
              {METRIC_LABEL[key]}
            </p>
            <p
              className={`mt-1 text-sm font-semibold tabular-nums ${metricTone(metric)}`}
            >
              {metricValue(metric)}
            </p>
            {key === "monitor-change" && metric.delta !== undefined && (
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                {metric.delta === null
                  ? "无可比较前后样本"
                  : `较上次 ${metric.delta >= 0 ? "+" : ""}${metric.delta}pp`}
              </p>
            )}
            <p className="mt-1 text-xs text-[var(--ink-subtle)]">
              {availabilityText(metric)} · 成功 {metric.completeness.successful}
              /{metric.completeness.total}
            </p>
            <p
              data-testid={`geo-dashboard-sufficiency-${key}`}
              className="mt-1 text-xs text-[var(--ink-subtle)]"
            >
              样本：
              {metric.sampleSufficiency === "sufficient"
                ? "充足"
                : metric.sampleSufficiency === "insufficient"
                  ? "不足"
                  : "无"}
            </p>
            {metric.dataNotes.map((note) => (
              <p
                key={note}
                className="mt-1 text-xs leading-4 text-[var(--warning)]"
              >
                {note}
              </p>
            ))}
            <details className="mt-2 text-xs text-[var(--ink-muted)]">
              <summary className="cursor-pointer">口径与证据</summary>
              <p className="mt-1 leading-4">{metric.methodology}</p>
              <p className="mt-1">数据时间：{metric.sampleTime ?? "暂无"}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {metric.evidence.slice(0, 2).map((anchor) => (
                  <button
                    type="button"
                    key={`${anchor.kind}:${anchor.id}`}
                    onClick={() => onEvidence(anchor)}
                    className="rounded bg-[var(--paper-inset)] px-1.5 py-1 text-[var(--accent)]"
                  >
                    下钻 {anchor.label.slice(0, 12)}
                  </button>
                ))}
              </div>
            </details>
            {key === "content-publish" && (
              <div className="mt-2 space-y-1 text-xs leading-4 text-[var(--ink-muted)]">
                <p>
                  文章：{statusBreakdown(dashboard.contentPublish.articles)} ·
                  有批准版本{" "}
                  {dashboard.contentPublish.articlesWithApprovedRevision}
                </p>
                <p>
                  Execution：
                  {statusBreakdown(dashboard.contentPublish.publishExecutions)}
                </p>
                <p>
                  发布项：
                  {statusBreakdown(dashboard.contentPublish.publishItems)}
                  ；submitted {dashboard.contentPublish.submittedItems}
                  （不等于已发布 / 已收录）
                </p>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function TrendPanel({
  dashboard,
  onEvidence,
}: {
  dashboard: GeoDashboardProjection;
  onEvidence: (anchor: GeoDashboardEvidenceAnchor) => void;
}) {
  return (
    <section
      className="mt-3 rounded-xl bg-[var(--paper)] p-3"
      data-testid="geo-dashboard-trend"
    >
      <div className="flex items-center gap-2">
        <Activity className="h-3.5 w-3.5 text-[var(--accent)]" />
        <h3 className="text-xs font-semibold">真实监测趋势（逐 run）</h3>
      </div>
      {dashboard.trend.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          暂无真实监测 run。
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {dashboard.trend.map((point) => (
            <button
              key={point.runId}
              type="button"
              onClick={() => onEvidence(point.evidence)}
              className="block w-full rounded-lg p-2 text-left hover:bg-[var(--hover-bg)]"
            >
              <div className="flex items-center justify-between text-xs">
                <span>Run {point.ordinal}</span>
                <span className="text-[var(--ink-muted)]">
                  {point.sampledAt}
                </span>
              </div>
              {point.mentionRate === null ? (
                <p
                  data-testid={`geo-dashboard-trend-no-sample-${point.runId}`}
                  className="mt-1 text-xs text-[var(--ink-subtle)]"
                >
                  无真实成功样本
                </p>
              ) : (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--paper-inset)]">
                  <div
                    data-testid={`geo-dashboard-trend-fill-${point.runId}`}
                    className="h-full rounded-full bg-[var(--accent)]"
                    style={{ width: `${point.mentionRate}%` }}
                  />
                </div>
              )}
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                提及{" "}
                {point.mentionRate === null ? "暂无" : `${point.mentionRate}%`}{" "}
                · 推荐{" "}
                {point.recommendationRate === null
                  ? "暂无"
                  : `${point.recommendationRate}%`}{" "}
                · 引用{" "}
                {point.citationRate === null
                  ? "暂无"
                  : `${point.citationRate}%`}{" "}
                · 失败 {point.failed}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function QuestionMatrix({
  dashboard,
  onEvidence,
}: {
  dashboard: GeoDashboardProjection;
  onEvidence: (anchor: GeoDashboardEvidenceAnchor) => void;
}) {
  return (
    <section
      className="mt-3 rounded-xl bg-[var(--paper)] p-3"
      data-testid="geo-dashboard-matrix"
    >
      <h3 className="text-xs font-semibold">问题 × 引擎真实证据</h3>
      {dashboard.questionEngineMatrix.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          暂无真实问题探测。
        </p>
      ) : (
        <div className="mt-2 divide-y divide-[var(--line-subtle)]">
          {dashboard.questionEngineMatrix.slice(0, 12).map((row) => (
            <button
              type="button"
              key={`${row.questionId}:${row.engineId}`}
              onClick={() => onEvidence(row.evidence)}
              className="block w-full py-2 text-left"
            >
              <p className="truncate text-xs text-[var(--ink)]">
                {row.question}
              </p>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                {row.engineId} · 样本 {row.successful}/{row.observations} · 提及{" "}
                {row.mentioned} · 推荐 {row.recommended} · 引用 {row.cited}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ObservationLog({
  dashboard,
  onEvidence,
}: {
  dashboard: GeoDashboardProjection;
  onEvidence: (anchor: GeoDashboardEvidenceAnchor) => void;
}) {
  return (
    <section
      className="mt-3 rounded-xl bg-[var(--paper)] p-3"
      data-testid="geo-dashboard-log"
    >
      <h3 className="text-xs font-semibold">观察日志</h3>
      {dashboard.observationLog.length === 0 ? (
        <p className="mt-3 text-xs text-[var(--ink-muted)]">
          暂无真实 observation。
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {dashboard.observationLog.slice(0, 12).map((entry) => (
            <button
              type="button"
              key={`${entry.anchor.kind}:${entry.anchor.id}`}
              onClick={() => onEvidence(entry.anchor)}
              className="block w-full rounded-lg p-2 text-left hover:bg-[var(--hover-bg)]"
            >
              <p className="text-xs text-[var(--ink)]">{entry.summary}</p>
              <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                {entry.anchor.occurredAt}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function DrilldownCard({
  value,
  onEvidence,
  onClose,
}: {
  value: GeoDashboardDrilldown;
  onEvidence: (anchor: GeoDashboardEvidenceAnchor) => void;
  onClose: () => void;
}) {
  const unit = "unit" in value ? record(value.unit) : null;
  const article = value.kind === "article" ? value.article : null;
  const item = value.kind === "publish-item" ? record(value.item) : null;
  const run = value.kind === "monitor-run" ? record(value.run) : null;
  const runUnits = Array.isArray(run?.units)
    ? run.units
        .map(record)
        .filter(
          (candidate): candidate is Record<string, unknown> =>
            candidate !== null,
        )
    : [];
  const itemArticle = item ? record(item.article) : null;
  const itemChannel = item ? record(item.channel) : null;
  const answer = unit ? stringValue(unit.rawAnswer) : null;
  const evidence = unit ? record(unit.evidence) : null;
  const evidenceAnswer = evidence ? stringValue(evidence.rawAnswer) : null;
  const citationsValue = unit?.citations ?? evidence?.citations;
  const citations = Array.isArray(citationsValue)
    ? citationsValue
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
    : [];
  const objectUrl = item ? stringValue(item.objectUrl) : null;
  return (
    <section
      data-testid="geo-dashboard-drilldown"
      className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold">Exact 证据 · {value.kind}</h3>
        <button
          type="button"
          aria-label="关闭证据下钻"
          onClick={onClose}
          className="ml-auto p-1 text-[var(--ink-muted)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {(answer || evidenceAnswer) && (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-[var(--ink-secondary)]">
          {answer ?? evidenceAnswer}
        </p>
      )}
      {unit && (
        <p className="mt-2 text-xs leading-5 text-[var(--ink-muted)]">
          单元 {stringValue(unit.kind) ?? "baseline-probe"} · 状态{" "}
          {stringValue(unit.status) ?? "unknown"} · engine{" "}
          {stringValue(unit.engineId) ?? "不适用"}
          {stringValue(unit.errorMessage)
            ? ` · ${stringValue(unit.errorMessage)}`
            : ""}
        </p>
      )}
      {article && (
        <div className="mt-2 text-xs leading-5 text-[var(--ink-secondary)]">
          <p>{article.title}</p>
          <p>
            状态：{article.status} · revision {article.revision} · approved{" "}
            {article.approvedRevision ?? "无"}
          </p>
          <p>正文仍由 Ticket 11 exact body 数据面读取，本仪表盘不复制正文。</p>
        </div>
      )}
      {citations.length > 0 && (
        <div className="mt-2 space-y-1">
          {citations.map((citation, index) => {
            const url = stringValue(citation.url);
            return url ? (
              <ExternalLink
                key={`${url}:${index}`}
                href={url}
                className="flex items-center gap-1 text-xs text-[var(--accent)]"
              >
                <ExternalLinkIcon className="h-3 w-3" />
                {stringValue(citation.title) ?? url}
              </ExternalLink>
            ) : null;
          })}
        </div>
      )}
      {item && (
        <div className="mt-2 text-xs leading-5 text-[var(--ink-secondary)]">
          <p>发布项状态：{stringValue(item.status) ?? "unknown"}</p>
          <p>
            文章：{stringValue(itemArticle?.title) ?? "未知文章"} · 渠道：
            {stringValue(itemChannel?.name) ?? "未知渠道"}
          </p>
          <p>排期：{stringValue(item.scheduledAt) ?? "暂无"}</p>
        </div>
      )}
      {objectUrl && (
        <ExternalLink
          href={objectUrl}
          className="mt-2 flex items-center gap-1 text-xs text-[var(--accent)]"
        >
          <ExternalLinkIcon className="h-3 w-3" />
          对象 URL（仅审计，不代表已发布）
        </ExternalLink>
      )}
      {run && value.kind === "monitor-run" && (
        <div className="mt-2 text-xs text-[var(--ink-secondary)]">
          <p>
            Run {String(run.ordinal ?? "?")} · 单元{" "}
            {String(run.unitCount ?? runUnits.length)}
            {run.truncated === true ? " · 摘要已截断" : ""}
          </p>
          <div className="mt-2 space-y-1">
            {runUnits.slice(0, 12).map((runUnit) => {
              const id = stringValue(runUnit.id);
              if (!id) return null;
              const kind = stringValue(runUnit.kind) ?? "monitor-unit";
              const status = stringValue(runUnit.status) ?? "unknown";
              return (
                <button
                  type="button"
                  key={id}
                  onClick={() =>
                    onEvidence({
                      kind: "monitor-unit",
                      id,
                      parentId: stringValue(run.id) ?? "",
                      label: `${kind} · ${status}`,
                      occurredAt: stringValue(runUnit.observedAt) ?? "",
                      operationId: value.operationId,
                      sessionId: value.sessionId,
                      ...(stringValue(runUnit.engineId)
                        ? {
                            engineId:
                              stringValue(runUnit.engineId) ?? undefined,
                          }
                        : {}),
                    })
                  }
                  className="block w-full rounded bg-[var(--paper-inset)] px-2 py-1.5 text-left text-[var(--accent)]"
                >
                  {kind} · {status}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {!answer &&
        !evidenceAnswer &&
        !article &&
        !item &&
        !run &&
        !objectUrl && (
          <p className="mt-2 text-xs text-[var(--ink-muted)]">
            已读取 exact 状态与有界证据摘要；单元原始 evidence 只存在于对应
            exact unit 下钻。
          </p>
        )}
    </section>
  );
}
