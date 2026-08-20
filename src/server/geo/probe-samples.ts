import type {
  GeoProbeAnalysis,
  GeoProbeCitation,
} from "../../shared/geo/baseline";
import type { GeoBaselinePersistencePort } from "./baseline";
import type { GeoDashboardPersistencePort } from "./dashboard";

/**
 * Agent 读取侧证据样本（Phase C）：包装既有只读持久化端口——基线
 * `latest()` 与 geo-dashboard `get`/`drilldown`——把「最近基线轮 + 最近
 * 监测轮」的真实探测回答投影成有界样本，供模型发现高频出现的第三方品牌
 * 并走 propose_brand_fact 提议竞品。纯读取，不产生任何写副作用，也不
 * 新增 SSE 事件（请求-响应）。
 */

/** 每轮（基线/监测各一）返回的样本条数契约。 */
export const GEO_PROBE_SAMPLE_LIMIT_DEFAULT = 6;
export const GEO_PROBE_SAMPLE_LIMIT_MAX = 12;
/** rawAnswer 截断上限：足够模型识别第三方品牌，又不至于刷屏聊天转录。 */
export const GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS = 1_200;
export const GEO_PROBE_SAMPLE_CITATION_MAX = 8;

export interface GeoProbeSamplesReadPort {
  latestBaseline: GeoBaselinePersistencePort["latest"];
  getDashboard: GeoDashboardPersistencePort["get"];
  drilldown: GeoDashboardPersistencePort["drilldown"];
}

export interface GeoProbeSample {
  unitId: string;
  questionId: string;
  question: string;
  engineId: string;
  status: string;
  observedAt: string | null;
  rawAnswer: string;
  rawAnswerTruncated: boolean;
  analysis: GeoProbeAnalysis | null;
  citations: GeoProbeCitation[];
}

export interface GeoProbeSamplesReport {
  kind: "geo-probe-samples";
  limit: number;
  answerMaxChars: number;
  baseline: {
    baselineId: string | null;
    sampledAt: string | null;
    samples: GeoProbeSample[];
  };
  monitor: {
    planId: string | null;
    runId: string | null;
    runOrdinal: number | null;
    sampledAt: string | null;
    samples: GeoProbeSample[];
  };
  /** 数据缺口如实说明（无基线/无监测轮/该轮暂无可读回答），不造句。 */
  notes: string[];
}

/** 工具边界之外的防御校验：缺省给默认值，非法值（非整数/越界）拒绝。 */
export function resolveGeoProbeSampleLimit(limit?: number): number {
  if (limit === undefined) return GEO_PROBE_SAMPLE_LIMIT_DEFAULT;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > GEO_PROBE_SAMPLE_LIMIT_MAX
  ) {
    throw new Error("geo_probe_sample_limit_invalid");
  }
  return limit;
}

export function truncateGeoProbeAnswer(
  answer: string,
  maxChars: number = GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS,
): { text: string; truncated: boolean } {
  return answer.length > maxChars
    ? { text: answer.slice(0, maxChars), truncated: true }
    : { text: answer, truncated: false };
}

function capGeoProbeCitations(
  citations: GeoProbeCitation[],
): GeoProbeCitation[] {
  return citations.slice(0, GEO_PROBE_SAMPLE_CITATION_MAX);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** drilldown 的 analysis 是 JSON blob（旧行可能是 parseError 壳），按最小形状验收。 */
function parseProbeAnalysis(value: unknown): GeoProbeAnalysis | null {
  const record = asRecord(value);
  return record && typeof record.brandMentioned === "boolean"
    ? (record as unknown as GeoProbeAnalysis)
    : null;
}

function parseProbeCitations(value: unknown): GeoProbeCitation[] {
  if (!Array.isArray(value)) return [];
  const citations: GeoProbeCitation[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const url = record && stringOrNull(record.url);
    if (!record || !url) continue;
    citations.push({
      url,
      ...(typeof record.title === "string" && record.title
        ? { title: record.title }
        : {}),
      provenance:
        record.provenance === "structured-provider"
          ? "structured-provider"
          : "answer-link",
    });
  }
  return capGeoProbeCitations(citations);
}

interface MonitorRunUnitEntry {
  id: string;
  kind: string;
  status: string;
  questionId: string | null;
  engineId: string | null;
  observedAt: string | null;
}

function parseMonitorRunUnits(run: unknown): MonitorRunUnitEntry[] {
  const holder = asRecord(run);
  const units = Array.isArray(holder?.units) ? holder.units : [];
  const entries: MonitorRunUnitEntry[] = [];
  for (const item of units) {
    const record = asRecord(item);
    const id = record && stringOrNull(record.id);
    if (!record || !id) continue;
    entries.push({
      id,
      kind: stringOrNull(record.kind) ?? "",
      status: stringOrNull(record.status) ?? "unknown",
      questionId: stringOrNull(record.questionId),
      engineId: stringOrNull(record.engineId),
      observedAt: stringOrNull(record.observedAt),
    });
  }
  return entries;
}

function parseMonitorProbeEvidence(unit: unknown): {
  questionId: string | null;
  engineId: string | null;
  rawAnswer: string;
  analysis: GeoProbeAnalysis | null;
  citations: GeoProbeCitation[];
} | null {
  const evidence = asRecord(asRecord(unit)?.evidence);
  const rawAnswer =
    evidence && typeof evidence.rawAnswer === "string"
      ? evidence.rawAnswer.trim()
      : "";
  if (!evidence || !rawAnswer) return null;
  return {
    questionId: stringOrNull(evidence.questionId),
    engineId: stringOrNull(evidence.engineId),
    rawAnswer,
    analysis: parseProbeAnalysis(evidence.analysis),
    citations: parseProbeCitations(evidence.citations),
  };
}

export class GeoProbeSamplesService {
  constructor(private readonly port: GeoProbeSamplesReadPort) {}

  async inspect(
    input: { limit?: number } = {},
  ): Promise<GeoProbeSamplesReport> {
    const limit = resolveGeoProbeSampleLimit(input.limit);
    const notes: string[] = [];

    const baseline = await this.port.latestBaseline();
    // 监测单元只携带 questionId：问题文本从基线单元（主）与看板矩阵（备）回填。
    const questionById = new Map<string, string>();
    for (const unit of baseline?.units ?? []) {
      if (!questionById.has(unit.questionId)) {
        questionById.set(unit.questionId, unit.question);
      }
    }

    const baselineSamples: GeoProbeSample[] = (baseline?.units ?? [])
      .filter(
        (unit) =>
          typeof unit.rawAnswer === "string" &&
          unit.rawAnswer.trim().length > 0,
      )
      .slice(0, limit)
      .map((unit) => {
        const answer = truncateGeoProbeAnswer(unit.rawAnswer ?? "");
        return {
          unitId: unit.id,
          questionId: unit.questionId,
          question: unit.question,
          engineId: unit.engineId,
          status: unit.status,
          observedAt: unit.finishedAt ?? unit.startedAt ?? null,
          rawAnswer: answer.text,
          rawAnswerTruncated: answer.truncated,
          analysis: unit.analysis ?? null,
          citations: capGeoProbeCitations(unit.citations),
        };
      });
    if (!baseline) {
      notes.push("尚无已冻结的基线轮；先在「效果」页按需执行一次基线探测。");
    } else if (baselineSamples.length === 0) {
      notes.push("最近基线轮暂无可读探测回答（可能仍在执行或全部失败）。");
    }

    const dashboard = await this.port.getDashboard({});
    for (const row of dashboard.questionEngineMatrix) {
      if (!questionById.has(row.questionId)) {
        questionById.set(row.questionId, row.question);
      }
    }
    const monitor = await this.monitorSamples(
      dashboard,
      limit,
      questionById,
      notes,
    );

    return {
      kind: "geo-probe-samples",
      limit,
      answerMaxChars: GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS,
      baseline: {
        baselineId: baseline?.id ?? null,
        sampledAt: baseline?.updatedAt ?? null,
        samples: baselineSamples,
      },
      monitor,
      notes,
    };
  }

  private async monitorSamples(
    dashboard: Awaited<ReturnType<GeoProbeSamplesReadPort["getDashboard"]>>,
    limit: number,
    questionById: ReadonlyMap<string, string>,
    notes: string[],
  ): Promise<GeoProbeSamplesReport["monitor"]> {
    const empty = {
      planId: null,
      runId: null,
      runOrdinal: null,
      sampledAt: null,
      samples: [] as GeoProbeSample[],
    };
    // trend 按 sampledAt 升序、Rust 端只保留最近 TREND_LIMIT 轮——末位即最近监测轮。
    const latest = dashboard.trend[dashboard.trend.length - 1];
    if (!latest) {
      notes.push("尚无监测轮次；监测启用并跑过一轮后这里才有样本。");
      return empty;
    }
    const runDrilldown = await this.port.drilldown({
      kind: "monitor-run",
      id: latest.runId,
    });
    if (runDrilldown.kind !== "monitor-run") {
      throw new Error("geo_dashboard_drilldown_unexpected_kind");
    }
    const samples: GeoProbeSample[] = [];
    const probeEntries = parseMonitorRunUnits(runDrilldown.run).filter(
      (entry) => entry.kind === "baseline-probe",
    );
    for (const entry of probeEntries) {
      if (samples.length >= limit) break;
      const drilldown = await this.port.drilldown({
        kind: "monitor-unit",
        id: entry.id,
      });
      if (drilldown.kind !== "monitor-unit") {
        throw new Error("geo_dashboard_drilldown_unexpected_kind");
      }
      const parsed = parseMonitorProbeEvidence(drilldown.unit);
      if (!parsed) continue;
      const questionId = parsed.questionId ?? entry.questionId ?? "";
      const answer = truncateGeoProbeAnswer(parsed.rawAnswer);
      samples.push({
        unitId: entry.id,
        questionId,
        question: questionById.get(questionId) ?? (questionId || "未知问题"),
        engineId: parsed.engineId ?? entry.engineId ?? "",
        status: entry.status,
        observedAt: entry.observedAt,
        rawAnswer: answer.text,
        rawAnswerTruncated: answer.truncated,
        analysis: parsed.analysis,
        citations: parsed.citations,
      });
    }
    if (samples.length === 0) {
      notes.push("最近监测轮暂无可读探测回答（可能仍在执行或全部失败）。");
    }
    return {
      planId: runDrilldown.planId,
      runId: latest.runId,
      runOrdinal: latest.ordinal,
      sampledAt: latest.sampledAt,
      samples,
    };
  }
}
