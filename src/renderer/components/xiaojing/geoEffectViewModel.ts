import {
  classifyGeoQuestionDiagnosis,
  type GeoBaselineEvidenceUnit,
  type GeoBaselineProjection,
  type GeoQuestionDiagnosis,
} from "../../../shared/geo/baseline";
import {
  aggregatePostPublishMonitorUnits,
  classifyGeoMetricTrend,
  type GeoMetricTrend,
  type PostPublishBaselineEvidence,
  type PostPublishMonitorPlanProjection,
  type PostPublishMonitorRunProjection,
  type PostPublishMonitorUnitProjection,
} from "../../../shared/geo/postPublishMonitoring";

/**
 * 效果看板/报告共用的纯推导层：把基线投影与监测计划投影确定性推导为
 * 四个区块（结论条、KPI、诊断矩阵、证据库）所需的视图模型。不做任何
 * IO，不造数——任何缺失都以 null/缺省如实上抛给显示层。
 */

export const CURVE_RUN_LIMIT = 8;
export const EVIDENCE_RUN_LIMIT = 6;
export const RAW_ANSWER_EXCERPT = 160;

const ENGINE_LABELS: Record<string, string> = { doubao: "豆包" };

export function engineLabel(engineId: string): string {
  return ENGINE_LABELS[engineId] ?? engineId;
}

export function probeEvidence(
  unit: PostPublishMonitorUnitProjection,
): PostPublishBaselineEvidence | null {
  if (unit.kind !== "baseline-probe" || unit.status !== "succeeded")
    return null;
  return unit.evidence && "rawAnswer" in unit.evidence ? unit.evidence : null;
}

export function percentage(
  numerator: number,
  denominator: number,
): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : null;
}

export function percentText(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/** Brand-mention rate over one engine's successful probes in one unit set. */
export function unitMentionRate(
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
export function probeAnalysisRates(
  units: readonly PostPublishMonitorUnitProjection[],
) {
  const evidence = units
    .map((unit) => probeEvidence(unit))
    .filter((value): value is PostPublishBaselineEvidence => value !== null);
  return {
    probes: evidence.length,
    recommended: evidence.filter((value) => value.analysis.brandRecommended)
      .length,
    cited: evidence.filter((value) => value.analysis.hasCitationEvidence)
      .length,
  };
}

export function baselineMentionRate(
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

/** 诊断矩阵行级展示态：在五档诊断之外补充失败与无数据两种单元态。 */
export type GeoQuestionDisplay = GeoQuestionDiagnosis | "failed" | "no-data";

export interface GeoEffectQuestionRow {
  questionId: string;
  question: string;
  fallbackOrdinal: number;
  /** 基线侧 before：无基线单元为 null。 */
  baselineStatus: "succeeded" | "failed" | null;
  baselineMentioned: boolean | null;
  /** 最新一轮监测单元；该题无监测记录为 null。 */
  latestStatus: PostPublishMonitorUnitProjection["status"] | null;
  latestEvidence: PostPublishBaselineEvidence | null;
  display: GeoQuestionDisplay;
  competitorMentions: string[];
  trend: GeoMetricTrend;
  mentionedRuns: number;
  totalRuns: number;
}

export interface GeoEffectKpi {
  key: string;
  label: string;
  value: string;
  sub: string;
  delta: number | null;
  trend: GeoMetricTrend;
}

export interface GeoEffectVerdictData {
  engineLabel: string;
  scope: "monitor" | "baseline";
  runOrdinal: number | null;
  total: number;
  mentioned: number;
  deltaPp: number | null;
  competitorDominated: number;
  suspectedNegative: number;
}

export interface CurvePoint {
  ordinal: number;
  rate: number | null;
}

export interface GeoEffectViewModel {
  runs: PostPublishMonitorRunProjection[];
  verdict: GeoEffectVerdictData | null;
  kpis: GeoEffectKpi[];
  rows: GeoEffectQuestionRow[];
  curveBaseRate: number | null;
  curvePoints: CurvePoint[];
}

export function diagnosisLabel(display: GeoQuestionDisplay): string {
  switch (display) {
    case "suspected-negative":
      return "疑似负面";
    case "competitor-dominated":
      return "竞品主导";
    case "absent":
      return "缺席";
    case "low-ranked":
      return "排名低";
    case "ok":
      return "正常";
    case "failed":
      return "失败";
    case "no-data":
      return "无数据";
  }
}

/** 基线 → 最新轮 before/after 双值的文字形态。 */
export function baselineSideLabel(row: GeoEffectQuestionRow): string {
  if (row.baselineStatus === null) return "无基线";
  if (row.baselineStatus === "failed") return "失败";
  return row.baselineMentioned === true ? "提及" : "未提及";
}

export function latestSideLabel(row: GeoEffectQuestionRow): string {
  if (row.latestStatus === null) return "—";
  if (row.latestStatus === "failed") return "失败";
  if (row.latestStatus !== "succeeded") return "进行中";
  const evidence = row.latestEvidence;
  if (!evidence) return "—";
  if (evidence.rankPosition) return `TOP${evidence.rankPosition}`;
  return evidence.analysis.brandMentioned ? "未进前三" : "未提及";
}

export function runStatusLabel(
  status: PostPublishMonitorRunProjection["status"],
): string {
  switch (status) {
    case "succeeded":
      return "完成";
    case "partial":
      return "部分成功";
    case "failed":
      return "失败";
    case "running":
      return "进行中";
  }
}

/** 一句话结论：仅由真实数据确定性拼接，调用方在无数据时不要调用本函数。 */
export function buildGeoEffectVerdictText(
  verdict: GeoEffectVerdictData,
): string {
  let text =
    verdict.scope === "monitor"
      ? `${verdict.engineLabel} · ${verdict.total} 题中品牌出现 ${verdict.mentioned} 题`
      : `${verdict.engineLabel} · 基线 ${verdict.total} 题中品牌出现 ${verdict.mentioned} 题（暂无监测轮次对照）`;
  if (verdict.scope === "monitor" && verdict.deltaPp !== null) {
    text += `（较基线 ${verdict.deltaPp >= 0 ? "+" : ""}${verdict.deltaPp}pp）`;
  }
  if (verdict.competitorDominated > 0) {
    text += ` · ${verdict.competitorDominated} 题竞品主导`;
  }
  if (verdict.suspectedNegative > 0) {
    text += ` · ${verdict.suspectedNegative} 题疑似负面`;
  }
  return text;
}

/** Ascending, bounded run series; merges latestRun when history lacks it. */
export function collectRuns(
  plan: PostPublishMonitorPlanProjection | null,
): PostPublishMonitorRunProjection[] {
  if (!plan) return [];
  const byId = new Map(plan.recentRuns.map((run) => [run.id, run]));
  if (plan.latestRun) byId.set(plan.latestRun.id, plan.latestRun);
  return [...byId.values()]
    .sort((left, right) => left.ordinal - right.ordinal)
    .slice(-CURVE_RUN_LIMIT);
}

/** 在一次 run 内按题+引擎定位 baseline-probe 单元（evidence.questionId 优先于 unit.questionId）。 */
function findProbeUnit(
  run: PostPublishMonitorRunProjection,
  questionId: string,
  engineId: string,
): PostPublishMonitorUnitProjection | undefined {
  return run.units.find(
    (candidate) =>
      candidate.kind === "baseline-probe" &&
      candidate.engineId === engineId &&
      (candidate.evidence && "rawAnswer" in candidate.evidence
        ? candidate.evidence.questionId
        : candidate.questionId) === questionId,
  );
}

function latestUnitForQuestion(
  runs: readonly PostPublishMonitorRunProjection[],
  questionId: string,
  engineId: string,
): PostPublishMonitorUnitProjection | null {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const unit = findProbeUnit(runs[index], questionId, engineId);
    if (unit) return unit;
  }
  return null;
}

function buildRows(input: {
  baseline: GeoBaselineProjection | null;
  runs: readonly PostPublishMonitorRunProjection[];
  engineId: string;
  questionLabels: ReadonlyMap<string, string>;
}): GeoEffectQuestionRow[] {
  const { baseline, runs, engineId, questionLabels } = input;
  const questionIds: string[] = [];
  const seen = new Set<string>();
  const push = (questionId: string | undefined) => {
    if (!questionId || seen.has(questionId)) return;
    seen.add(questionId);
    questionIds.push(questionId);
  };
  // 题序：基线题序优先，监测轮里新出现的题按首见顺序随后。
  baseline?.units.forEach((unit) => {
    if (unit.engineId === engineId) push(unit.questionId);
  });
  for (const run of runs) {
    for (const unit of run.units) {
      if (unit.kind !== "baseline-probe" || unit.engineId !== engineId)
        continue;
      const evidence = probeEvidence(unit);
      push(evidence?.questionId ?? unit.questionId);
    }
  }

  return questionIds.map((questionId, index) => {
    const baselineUnit =
      baseline?.units.find(
        (unit) => unit.engineId === engineId && unit.questionId === questionId,
      ) ?? null;
    const latestUnit = latestUnitForQuestion(runs, questionId, engineId);
    const latestEvidence = latestUnit ? probeEvidence(latestUnit) : null;

    // 逐题趋势序列：提及=1、未提及=0、失败/缺失=null（不参与）。
    const series: (number | null)[] = [];
    let mentionedRuns = 0;
    let totalRuns = 0;
    for (const run of runs) {
      const unit = findProbeUnit(run, questionId, engineId);
      if (!unit) continue;
      const evidence = probeEvidence(unit);
      if (!evidence) {
        series.push(null);
        continue;
      }
      totalRuns += 1;
      const mentioned = evidence.analysis.brandMentioned === true;
      if (mentioned) mentionedRuns += 1;
      series.push(mentioned ? 1 : 0);
    }

    // 诊断门控：失败单元必须先标「失败」，不能落入 classify 的 absent 缺省。
    let display: GeoQuestionDisplay;
    if (latestUnit) {
      if (latestUnit.status === "failed") display = "failed";
      else if (latestUnit.status !== "succeeded" || !latestEvidence)
        display = "no-data";
      else
        display = classifyGeoQuestionDiagnosis({
          analysis: latestEvidence.analysis,
          rankPosition: latestEvidence.rankPosition,
        });
    } else if (baselineUnit) {
      if (baselineUnit.status === "failed") display = "failed";
      else if (baselineUnit.status !== "succeeded") display = "no-data";
      else
        display = classifyGeoQuestionDiagnosis({
          analysis: baselineUnit.analysis,
        });
    } else {
      display = "no-data";
    }

    const analysis = latestEvidence?.analysis ?? baselineUnit?.analysis ?? null;
    return {
      questionId,
      question: questionLabels.get(questionId) ?? `问题 ${index + 1}`,
      fallbackOrdinal: index + 1,
      baselineStatus:
        baselineUnit === null
          ? null
          : baselineUnit.status === "failed"
            ? "failed"
            : baselineUnit.status === "succeeded"
              ? "succeeded"
              : null,
      baselineMentioned:
        baselineUnit?.status === "succeeded"
          ? baselineUnit.analysis?.brandMentioned === true
          : null,
      latestStatus: latestUnit?.status ?? null,
      latestEvidence,
      display,
      competitorMentions: analysis?.competitorMentions ?? [],
      trend: classifyGeoMetricTrend(series),
      mentionedRuns,
      totalRuns,
    };
  });
}

export function buildGeoEffectViewModel(input: {
  baseline: GeoBaselineProjection | null;
  plan: PostPublishMonitorPlanProjection | null;
  engineId: string;
  engineLabel: string;
}): GeoEffectViewModel {
  const { baseline, plan, engineId } = input;
  const runs = collectRuns(plan);

  const questionLabels = new Map<string, string>();
  baseline?.units.forEach((unit) =>
    questionLabels.set(unit.questionId, unit.question),
  );

  const rows = buildRows({ baseline, runs, engineId, questionLabels });

  const aggregate = plan?.latestRun
    ? aggregatePostPublishMonitorUnits(plan.latestRun.units)
    : null;
  const latestRates = probeAnalysisRates(plan?.latestRun?.units ?? []);
  const mentionRateSeries = runs.map((run) =>
    unitMentionRate(run.units, engineId),
  );
  const mentionTrend = classifyGeoMetricTrend(mentionRateSeries);
  const mentionRate = aggregate
    ? percentage(aggregate.brandMentioned, aggregate.baselineProbes)
    : null;
  const usableRates = mentionRateSeries.filter(
    (rate): rate is number => rate !== null,
  );
  const mentionDelta =
    usableRates.length >= 2
      ? usableRates[usableRates.length - 1] -
        usableRates[usableRates.length - 2]
      : null;
  const recommendRate = percentage(latestRates.recommended, latestRates.probes);
  const citationRate = percentage(latestRates.cited, latestRates.probes);

  const hasMonitorProbes = (aggregate?.baselineProbes ?? 0) > 0;
  const kpis: GeoEffectKpi[] = [
    {
      key: "mention",
      label: "品牌出现率",
      value: percentText(mentionRate ?? baseline?.metrics.mentionRate ?? null),
      sub: hasMonitorProbes
        ? `最新一轮 品牌出现 ${aggregate!.brandMentioned}/${aggregate!.baselineProbes} 题`
        : baseline
          ? `基线探测 ${baseline.metrics.succeeded} 题`
          : "暂无监测复测",
      delta: mentionDelta,
      trend: mentionTrend,
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
      trend: "insufficient",
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
      trend: "insufficient",
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
      trend: "insufficient",
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
      trend: "insufficient",
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
      trend: "insufficient",
    },
  ];

  // 结论条：监测轮优先，无监测轮回退基线，两者皆无则交由显示层如实标注。
  const baseRate = baselineMentionRate(baseline, engineId);
  let verdict: GeoEffectVerdictData | null = null;
  const competitorDominated = rows.filter(
    (row) => row.display === "competitor-dominated",
  ).length;
  const suspectedNegative = rows.filter(
    (row) => row.display === "suspected-negative",
  ).length;
  if (hasMonitorProbes && mentionRate !== null) {
    verdict = {
      engineLabel: input.engineLabel,
      scope: "monitor",
      runOrdinal: plan?.latestRun?.ordinal ?? null,
      total: aggregate!.baselineProbes,
      mentioned: aggregate!.brandMentioned,
      deltaPp: baseRate !== null ? mentionRate - baseRate : null,
      competitorDominated,
      suspectedNegative,
    };
  } else if (baseline && baseline.metrics.succeeded > 0) {
    verdict = {
      engineLabel: input.engineLabel,
      scope: "baseline",
      runOrdinal: null,
      total: baseline.metrics.succeeded,
      mentioned: baseline.metrics.brandMentioned,
      deltaPp: null,
      competitorDominated,
      suspectedNegative,
    };
  }

  return {
    runs,
    verdict,
    kpis,
    rows,
    curveBaseRate: baseRate,
    curvePoints: runs.map((run) => ({
      ordinal: run.ordinal,
      rate: unitMentionRate(run.units, engineId),
    })),
  };
}

export interface GeoEvidenceRound {
  run: PostPublishMonitorRunProjection;
  unit: PostPublishMonitorUnitProjection;
  evidence: PostPublishBaselineEvidence | null;
}

export interface GeoEvidenceEntry {
  questionId: string;
  question: string;
  display: GeoQuestionDisplay;
  competitorMentions: string[];
  baselineUnit: GeoBaselineEvidenceUnit | null;
  /** 该题各轮观测，最新在前。 */
  rounds: GeoEvidenceRound[];
}

/** 证据/样本库：按题聚合，每题可展开看各轮原始证据；轮次数有界。 */
export function buildGeoEvidenceEntries(input: {
  rows: readonly GeoEffectQuestionRow[];
  runs: readonly PostPublishMonitorRunProjection[];
  baseline: GeoBaselineProjection | null;
  engineId: string;
}): GeoEvidenceEntry[] {
  const { rows, runs, baseline, engineId } = input;
  const newestFirst = [...runs].reverse().slice(0, EVIDENCE_RUN_LIMIT);
  return rows.map((row) => ({
    questionId: row.questionId,
    question: row.question,
    display: row.display,
    competitorMentions: row.competitorMentions,
    baselineUnit:
      baseline?.units.find(
        (unit) =>
          unit.engineId === engineId && unit.questionId === row.questionId,
      ) ?? null,
    rounds: newestFirst.flatMap((run) => {
      const unit = findProbeUnit(run, row.questionId, engineId);
      return unit ? [{ run, unit, evidence: probeEvidence(unit) }] : [];
    }),
  }));
}

export function truncateRawAnswer(answer: string): string {
  return answer.length > RAW_ANSWER_EXCERPT
    ? `${answer.slice(0, RAW_ANSWER_EXCERPT)}…`
    : answer;
}
