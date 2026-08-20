import { describe, expect, it, vi } from "vitest";

import {
  GEO_BASELINE_POLICY_VERSION,
  type GeoBaselineEvidenceUnit,
  type GeoBaselineProjection,
  type GeoProbeAnalysis,
} from "../../shared/geo/baseline";
import {
  GEO_DASHBOARD_POLICY_VERSION,
  type GeoDashboardDrilldown,
  type GeoDashboardTrendPoint,
} from "../../shared/geo/dashboard";
import type { RustGeoDashboardProjection } from "./dashboard";
import {
  GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS,
  GEO_PROBE_SAMPLE_CITATION_MAX,
  GEO_PROBE_SAMPLE_LIMIT_DEFAULT,
  GEO_PROBE_SAMPLE_LIMIT_MAX,
  GeoProbeSamplesService,
  resolveGeoProbeSampleLimit,
  truncateGeoProbeAnswer,
  type GeoProbeSamplesReadPort,
} from "./probe-samples";

const providerSnapshot = {
  engineId: "doubao" as const,
  provider: "volcengine" as const,
  capabilitySlot: "keyword-search" as const,
  model: "doubao-seed-2-0-lite-260428",
  endpointFamily: "ark-responses" as const,
  searchMode: "doubao-app-ai-search" as const,
  configurationFingerprint: "not-configured",
  policyVersion: GEO_BASELINE_POLICY_VERSION,
} as const;

function analysis(overrides: Partial<GeoProbeAnalysis> = {}): GeoProbeAnalysis {
  return {
    brandMentioned: true,
    brandRecommended: false,
    hasCitationEvidence: true,
    competitorMentions: ["云帆信息"],
    suspectedNegative: false,
    ...overrides,
  };
}

function baselineUnit(
  overrides: Partial<GeoBaselineEvidenceUnit> = {},
): GeoBaselineEvidenceUnit {
  return {
    id: "baseline-unit-1",
    questionId: "question-1",
    question: "问题一",
    engineId: "doubao",
    providerSnapshot,
    status: "succeeded",
    attemptNumber: 1,
    rawAnswer: "推荐鲸跃汽车，云帆信息也不错。",
    citations: [{ url: "https://example.com/a", provenance: "answer-link" }],
    analysis: analysis(),
    startedAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:05.000Z",
    attempts: [],
    ...overrides,
  };
}

function baseline(
  overrides: Partial<GeoBaselineProjection> = {},
): GeoBaselineProjection {
  return {
    id: "baseline-1",
    operationId: "op-baseline",
    workspaceId: "brand-1",
    createdBySessionId: "session-1",
    questionPoolId: "pool-1",
    questionPoolRevision: 1,
    knowledgeVersion: 3,
    brandNames: ["鲸跃汽车"],
    competitorNames: ["云帆信息"],
    providerSnapshots: [providerSnapshot],
    policyVersion: GEO_BASELINE_POLICY_VERSION,
    status: "succeeded",
    metrics: {
      total: 1,
      completed: 1,
      succeeded: 1,
      failed: 0,
      pending: 0,
      brandMentioned: 1,
      brandRecommended: 0,
      withCitationEvidence: 1,
      mentionRate: 100,
      recommendationRate: 0,
      citationRate: 100,
      evidenceUnitIds: {
        brandMentioned: ["baseline-unit-1"],
        brandRecommended: [],
        withCitationEvidence: ["baseline-unit-1"],
        failed: [],
      },
    },
    units: [baselineUnit()],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:10.000Z",
    ...overrides,
  };
}

function trendPoint(
  overrides: Partial<GeoDashboardTrendPoint> = {},
): GeoDashboardTrendPoint {
  return {
    runId: "run-1",
    planId: "plan-1",
    ordinal: 1,
    sampledAt: "2026-08-19T00:00:00.000Z",
    mentionRate: 100,
    recommendationRate: 0,
    citationRate: 100,
    successful: 1,
    failed: 0,
    pending: 0,
    evidence: {
      kind: "monitor-run",
      id: "run-1",
      parentId: "plan-1",
      label: "监测第 1 次",
      occurredAt: "2026-08-19T00:00:00.000Z",
      operationId: "op-monitor",
      sessionId: "session-1",
    },
    ...overrides,
  };
}

function dashboard(
  overrides: Partial<RustGeoDashboardProjection> = {},
): RustGeoDashboardProjection {
  return {
    workspaceId: "brand-1",
    workspaceName: "鲸跃汽车",
    policyVersion: GEO_DASHBOARD_POLICY_VERSION,
    generatedAt: "2026-08-19T01:00:00.000Z",
    filters: {},
    filterSemantics: {
      timeInterval: "[from,toExclusive)",
      timezone: "UTC",
      monitorOperationLineage: "monitor-or-source-operation",
      observationPolicy: "all-observations",
      engineApplicability: "engine-metrics-only",
    },
    dimensions: { sessions: [], operations: [], engines: [] },
    metrics: [],
    trend: [trendPoint()],
    questionEngineMatrix: [],
    observationLog: [],
    contentPublish: {
      articles: {},
      articlesWithApprovedRevision: 0,
      publishExecutions: {},
      publishItems: {},
      submittedItems: 0,
    },
    ...overrides,
  };
}

function monitorRunDrilldown(units: unknown[]): GeoDashboardDrilldown {
  return {
    kind: "monitor-run",
    planId: "plan-1",
    operationId: "op-monitor",
    sourceOperationId: "op-baseline",
    sessionId: "session-1",
    run: { id: "run-1", ordinal: 1, unitCount: units.length, units },
  };
}

function monitorUnitDrilldown(evidence: unknown): GeoDashboardDrilldown {
  return {
    kind: "monitor-unit",
    planId: "plan-1",
    runId: "run-1",
    operationId: "op-monitor",
    sourceOperationId: "op-baseline",
    sessionId: "session-1",
    unit: {
      id: "monitor-unit-1",
      kind: "baseline-probe",
      status: "succeeded",
      questionId: "question-1",
      engineId: "doubao",
      observedAt: "2026-08-19T00:00:01.000Z",
      evidence,
    },
  };
}

function probeEvidence(overrides: Record<string, unknown> = {}) {
  return {
    questionId: "question-1",
    engineId: "doubao",
    rawAnswer: "本轮回答提到云帆信息与星河智能。",
    citations: [{ url: "https://example.com/b", provenance: "answer-link" }],
    analysis: analysis({ competitorMentions: ["云帆信息", "星河智能"] }),
    ...overrides,
  };
}

function port(overrides: Partial<GeoProbeSamplesReadPort> = {}) {
  const readPort: GeoProbeSamplesReadPort = {
    latestBaseline: vi.fn(async () => baseline()),
    getDashboard: vi.fn(async () => dashboard()),
    drilldown: vi.fn(),
    ...overrides,
  };
  return readPort;
}

describe("resolveGeoProbeSampleLimit", () => {
  it("defaults when omitted and accepts the inclusive bounds", () => {
    expect(resolveGeoProbeSampleLimit(undefined)).toBe(
      GEO_PROBE_SAMPLE_LIMIT_DEFAULT,
    );
    expect(resolveGeoProbeSampleLimit(1)).toBe(1);
    expect(resolveGeoProbeSampleLimit(GEO_PROBE_SAMPLE_LIMIT_MAX)).toBe(
      GEO_PROBE_SAMPLE_LIMIT_MAX,
    );
  });

  it("rejects out-of-range and non-integer values", () => {
    for (const invalid of [
      0,
      -1,
      GEO_PROBE_SAMPLE_LIMIT_MAX + 1,
      1.5,
      Number.NaN,
    ]) {
      expect(() => resolveGeoProbeSampleLimit(invalid)).toThrow(
        "geo_probe_sample_limit_invalid",
      );
    }
  });
});

describe("truncateGeoProbeAnswer", () => {
  it("keeps short answers intact and truncates over-limit ones with a flag", () => {
    const short = truncateGeoProbeAnswer("短回答");
    expect(short).toEqual({ text: "短回答", truncated: false });

    const long = "长".repeat(GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS + 10);
    const truncated = truncateGeoProbeAnswer(long);
    expect(truncated.truncated).toBe(true);
    expect(truncated.text).toHaveLength(GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS);
  });
});

describe("GeoProbeSamplesService", () => {
  it("returns baseline samples from the latest frozen baseline round", async () => {
    const readPort = port({
      getDashboard: vi.fn(async () => dashboard({ trend: [] })),
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({});

    expect(report.kind).toBe("geo-probe-samples");
    expect(report.limit).toBe(GEO_PROBE_SAMPLE_LIMIT_DEFAULT);
    expect(report.baseline.baselineId).toBe("baseline-1");
    expect(report.baseline.samples).toHaveLength(1);
    expect(report.baseline.samples[0]).toMatchObject({
      unitId: "baseline-unit-1",
      question: "问题一",
      engineId: "doubao",
      rawAnswerTruncated: false,
      observedAt: "2026-08-18T00:00:05.000Z",
    });
    expect(report.baseline.samples[0].analysis?.competitorMentions).toEqual([
      "云帆信息",
    ]);
  });

  it("truncates long raw answers and caps citations", async () => {
    const longAnswer = "答".repeat(GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS + 50);
    const citations = Array.from(
      { length: GEO_PROBE_SAMPLE_CITATION_MAX + 4 },
      (_, index) => ({
        url: `https://example.com/${index}`,
        provenance: "answer-link" as const,
      }),
    );
    const readPort = port({
      latestBaseline: vi.fn(async () =>
        baseline({
          units: [baselineUnit({ rawAnswer: longAnswer, citations })],
        }),
      ),
      getDashboard: vi.fn(async () => dashboard({ trend: [] })),
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({});

    const sample = report.baseline.samples[0];
    expect(sample.rawAnswerTruncated).toBe(true);
    expect(sample.rawAnswer).toHaveLength(GEO_PROBE_SAMPLE_ANSWER_MAX_CHARS);
    expect(sample.citations).toHaveLength(GEO_PROBE_SAMPLE_CITATION_MAX);
  });

  it("honours the per-round sample limit", async () => {
    const units = Array.from({ length: 5 }, (_, index) =>
      baselineUnit({ id: `baseline-unit-${index}`, question: `问题${index}` }),
    );
    const readPort = port({
      latestBaseline: vi.fn(async () => baseline({ units })),
      getDashboard: vi.fn(async () => dashboard({ trend: [] })),
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({
      limit: 2,
    });
    expect(report.limit).toBe(2);
    expect(report.baseline.samples.map((sample) => sample.unitId)).toEqual([
      "baseline-unit-0",
      "baseline-unit-1",
    ]);
  });

  it("reads monitor samples from the latest trend run via run + unit drilldowns", async () => {
    const drilldown = vi.fn(async (input: { kind: string; id: string }) => {
      if (input.kind === "monitor-run") {
        return monitorRunDrilldown([
          {
            id: "monitor-unit-status",
            kind: "publish-status",
            status: "succeeded",
          },
          {
            id: "monitor-unit-1",
            kind: "baseline-probe",
            status: "succeeded",
            questionId: "question-1",
            engineId: "doubao",
            observedAt: "2026-08-19T00:00:01.000Z",
          },
        ]);
      }
      return monitorUnitDrilldown(probeEvidence());
    });
    const readPort = port({
      getDashboard: vi.fn(async () =>
        dashboard({
          trend: [
            trendPoint({ runId: "run-older", ordinal: 1 }),
            trendPoint({
              runId: "run-1",
              ordinal: 2,
              sampledAt: "2026-08-19T01:00:00.000Z",
            }),
          ],
        }),
      ),
      drilldown,
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({});

    // 只读最近一轮（trend 末位 run-1），不钻取旧轮。
    expect(drilldown).toHaveBeenCalledWith({
      kind: "monitor-run",
      id: "run-1",
    });
    expect(drilldown).toHaveBeenCalledWith({
      kind: "monitor-unit",
      id: "monitor-unit-1",
    });
    expect(drilldown).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "monitor-unit-status" }),
    );
    expect(drilldown).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-older" }),
    );

    expect(report.monitor).toMatchObject({
      planId: "plan-1",
      runId: "run-1",
      runOrdinal: 2,
      sampledAt: "2026-08-19T01:00:00.000Z",
    });
    expect(report.monitor.samples).toHaveLength(1);
    expect(report.monitor.samples[0]).toMatchObject({
      unitId: "monitor-unit-1",
      questionId: "question-1",
      // 问题文本从基线单元回填（监测单元只携带 questionId）。
      question: "问题一",
      engineId: "doubao",
      rawAnswer: "本轮回答提到云帆信息与星河智能。",
    });
    expect(report.monitor.samples[0].analysis?.competitorMentions).toEqual([
      "云帆信息",
      "星河智能",
    ]);
  });

  it("falls back to the dashboard matrix for question text", async () => {
    const readPort = port({
      latestBaseline: vi.fn(async () => null),
      getDashboard: vi.fn(async () =>
        dashboard({
          questionEngineMatrix: [
            {
              questionId: "question-9",
              question: "矩阵里的问题",
              engineId: "doubao",
              observations: 1,
              successful: 1,
              failed: 0,
              pending: 0,
              mentioned: 1,
              recommended: 0,
              cited: 0,
              lastObservedAt: "2026-08-19T00:00:00.000Z",
              evidence: {
                kind: "monitor-unit",
                id: "monitor-unit-1",
                parentId: "run-1",
                label: "监测复测",
                occurredAt: "2026-08-19T00:00:00.000Z",
                operationId: "op-monitor",
                sessionId: "session-1",
              },
            },
          ],
        }),
      ),
      drilldown: vi.fn(async (input: { kind: string }) =>
        input.kind === "monitor-run"
          ? monitorRunDrilldown([
              {
                id: "monitor-unit-1",
                kind: "baseline-probe",
                status: "succeeded",
                questionId: "question-9",
                engineId: "doubao",
                observedAt: "2026-08-19T00:00:01.000Z",
              },
            ])
          : monitorUnitDrilldown(probeEvidence({ questionId: "question-9" })),
      ),
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({});
    expect(report.monitor.samples[0]?.question).toBe("矩阵里的问题");
    expect(report.baseline.baselineId).toBeNull();
    expect(report.notes.some((note) => note.includes("基线"))).toBe(true);
  });

  it("reports empty rounds honestly instead of inventing samples", async () => {
    const readPort = port({
      latestBaseline: vi.fn(async () => null),
      getDashboard: vi.fn(async () => dashboard({ trend: [] })),
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({});

    expect(report.baseline).toEqual({
      baselineId: null,
      sampledAt: null,
      samples: [],
    });
    expect(report.monitor).toEqual({
      planId: null,
      runId: null,
      runOrdinal: null,
      sampledAt: null,
      samples: [],
    });
    expect(report.notes.some((note) => note.includes("基线"))).toBe(true);
    expect(report.notes.some((note) => note.includes("监测"))).toBe(true);
  });

  it("skips monitor units without readable evidence and notes the gap", async () => {
    const readPort = port({
      drilldown: vi.fn(async (input: { kind: string }) =>
        input.kind === "monitor-run"
          ? monitorRunDrilldown([
              {
                id: "monitor-unit-failed",
                kind: "baseline-probe",
                status: "failed",
                questionId: "question-1",
                engineId: "doubao",
                observedAt: null,
              },
            ])
          : monitorUnitDrilldown({ questionId: "question-1", rawAnswer: "" }),
      ),
    });
    const report = await new GeoProbeSamplesService(readPort).inspect({});
    expect(report.monitor.runId).toBe("run-1");
    expect(report.monitor.samples).toEqual([]);
    expect(report.notes.some((note) => note.includes("监测"))).toBe(true);
  });

  it("is read-only: only the three read port methods are ever invoked", async () => {
    const readPort = port({
      drilldown: vi.fn(async (input: { kind: string }) =>
        input.kind === "monitor-run"
          ? monitorRunDrilldown([])
          : monitorUnitDrilldown(probeEvidence()),
      ),
    });
    await new GeoProbeSamplesService(readPort).inspect({});

    expect(readPort.latestBaseline).toHaveBeenCalledTimes(1);
    expect(readPort.getDashboard).toHaveBeenCalledTimes(1);
    expect(readPort.getDashboard).toHaveBeenCalledWith({});
    expect(readPort.drilldown).toHaveBeenCalledTimes(1);
    // 端口契约只暴露读取方法（类型层面无 prepare/claim/finish 等写方法）。
    expect(Object.keys(readPort).sort()).toEqual([
      "drilldown",
      "getDashboard",
      "latestBaseline",
    ]);
  });

  it("propagates drilldown errors verbatim", async () => {
    const readPort = port({
      drilldown: vi.fn(async () => {
        throw new Error("geo_dashboard_drilldown_not_found");
      }),
    });
    await expect(
      new GeoProbeSamplesService(readPort).inspect({}),
    ).rejects.toThrow("geo_dashboard_drilldown_not_found");
  });

  it("propagates dashboard read errors verbatim", async () => {
    const readPort = port({
      getDashboard: vi.fn(async () => {
        throw new Error("geo_dashboard_persistence_failed");
      }),
    });
    await expect(
      new GeoProbeSamplesService(readPort).inspect({}),
    ).rejects.toThrow("geo_dashboard_persistence_failed");
  });

  it("rejects an invalid limit before any persistence read", async () => {
    const readPort = port();
    await expect(
      new GeoProbeSamplesService(readPort).inspect({ limit: 99 }),
    ).rejects.toThrow("geo_probe_sample_limit_invalid");
    expect(readPort.latestBaseline).not.toHaveBeenCalled();
    expect(readPort.getDashboard).not.toHaveBeenCalled();
    expect(readPort.drilldown).not.toHaveBeenCalled();
  });
});
