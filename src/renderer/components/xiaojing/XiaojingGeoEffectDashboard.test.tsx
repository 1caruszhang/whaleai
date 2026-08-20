import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GeoBaselineProjection } from "../../../shared/geo/baseline";
import type {
  PostPublishMonitorPlanProjection,
  PostPublishMonitorRunProjection,
  PostPublishMonitorUnitProjection,
} from "../../../shared/geo/postPublishMonitoring";
import XiaojingGeoEffectDashboard from "./XiaojingGeoEffectDashboard";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  engines: vi.fn(),
  latestBaseline: vi.fn(),
  latestPlan: vi.fn(),
  sessionId: "session-19" as string | null,
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));
vi.mock("@/api/geoBaselineClient", () => ({
  loadGeoBaselineEngines: mocks.engines,
  loadLatestGeoBaseline: mocks.latestBaseline,
}));
vi.mock("@/api/postPublishMonitoringClient", () => ({
  loadLatestPostPublishMonitor: mocks.latestPlan,
}));

const providerSnapshot = {
  engineId: "doubao",
  provider: "volcengine",
  capabilitySlot: "keyword-search",
  model: "doubao-pro",
  endpointFamily: "ark-responses",
  searchMode: "doubao-app-ai-search",
  configurationFingerprint: "fingerprint",
  policyVersion: "xiaojing-geo-baseline-v2",
} as const;

function baselineFixture(): GeoBaselineProjection {
  return {
    id: "baseline-19",
    operationId: "operation-19",
    workspaceId: "brand-19",
    createdBySessionId: "session-19",
    questionPoolId: "pool-19",
    questionPoolRevision: 3,
    knowledgeVersion: 5,
    brandNames: ["小鲸科技"],
    competitorNames: [],
    providerSnapshots: [providerSnapshot],
    policyVersion: "xiaojing-geo-baseline-v2",
    status: "succeeded",
    metrics: {
      total: 2,
      completed: 2,
      succeeded: 2,
      failed: 0,
      pending: 0,
      brandMentioned: 1,
      brandRecommended: 1,
      withCitationEvidence: 1,
      mentionRate: 50,
      recommendationRate: 50,
      citationRate: 50,
      evidenceUnitIds: {
        brandMentioned: ["unit-q1"],
        brandRecommended: ["unit-q1"],
        withCitationEvidence: ["unit-q1"],
        failed: [],
      },
    },
    units: [
      {
        id: "unit-q1",
        questionId: "q1",
        question: "小鲸科技靠谱吗？",
        engineId: "doubao",
        providerSnapshot,
        status: "succeeded",
        attemptNumber: 1,
        rawAnswer: "TOP 1 小鲸科技",
        citations: [],
        analysis: {
          brandMentioned: true,
          brandRecommended: true,
          hasCitationEvidence: true,
        },
        attempts: [],
      },
      {
        id: "unit-q2",
        questionId: "q2",
        question: "哪家 GEO 工具值得选？",
        engineId: "doubao",
        providerSnapshot,
        status: "succeeded",
        attemptNumber: 1,
        rawAnswer: "可以考虑多家对比",
        citations: [],
        analysis: {
          brandMentioned: false,
          brandRecommended: false,
          hasCitationEvidence: false,
        },
        attempts: [],
      },
    ],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
  };
}

/** 探测单元构造：failed 门控 / 五档诊断 / 竞品与负面线索都从这里进。 */
function probeUnit(
  id: string,
  questionId: string,
  options: {
    failed?: boolean;
    mentioned?: boolean;
    rank?: 1 | 2 | 3 | null;
    competitorMentions?: string[];
    suspectedNegative?: boolean;
    rawAnswer?: string;
  } = {},
): PostPublishMonitorUnitProjection {
  if (options.failed) {
    return {
      id,
      revision: 1,
      kind: "baseline-probe",
      status: "failed",
      attemptNumber: 1,
      questionId,
      engineId: "doubao",
      observedAt: "2026-08-15T04:02:00Z",
      errorCode: "probe-failed",
      errorMessage: "探测失败",
      attempts: [],
    };
  }
  const mentioned = options.mentioned ?? false;
  return {
    id,
    revision: 1,
    kind: "baseline-probe",
    status: "succeeded",
    attemptNumber: 1,
    questionId,
    engineId: "doubao",
    observedAt: "2026-08-15T04:02:00Z",
    attempts: [],
    evidence: {
      questionId,
      engineId: "doubao",
      rawAnswer:
        options.rawAnswer ?? (mentioned ? "提到了小鲸科技" : "未提及小鲸科技"),
      rawEvidence: {},
      sourceProviderSnapshot: providerSnapshot,
      providerSnapshot,
      citations: [],
      analysis: {
        brandMentioned: mentioned,
        brandRecommended: false,
        hasCitationEvidence: false,
        ...(options.competitorMentions
          ? { competitorMentions: options.competitorMentions }
          : {}),
        ...(options.suspectedNegative ? { suspectedNegative: true } : {}),
      },
      rankPosition: options.rank ?? null,
      citedArticleIds: [],
      citedUrls: [],
    },
  };
}

function makeRun(
  ordinal: number,
  units: PostPublishMonitorUnitProjection[],
  status: PostPublishMonitorRunProjection["status"] = "succeeded",
): PostPublishMonitorRunProjection {
  return {
    id: `run-${ordinal}`,
    ordinal,
    scheduledFor: `2026-08-15T0${ordinal + 2}:00:00Z`,
    status,
    createdAt: `2026-08-15T0${ordinal + 2}:00:00Z`,
    units,
  };
}

function planFixture(): PostPublishMonitorPlanProjection {
  const run2 = makeRun(
    2,
    [
      {
        id: "status-2",
        revision: 1,
        kind: "publish-status" as const,
        status: "succeeded" as const,
        attemptNumber: 1,
        publishItemId: "item-1",
        observedAt: "2026-08-15T04:01:00Z",
        attempts: [],
        evidence: {
          platformStatusCode: 4,
          platformStatus: "published" as const,
          externalOrderId: "order-1",
          externalRequestSn: "sn-1",
          publishedUrl: "https://publisher.test/a",
          rawEvidence: {},
        },
      },
      {
        id: "access-2",
        revision: 1,
        kind: "access-indexing" as const,
        status: "succeeded" as const,
        attemptNumber: 1,
        publishItemId: "item-1",
        observedAt: "2026-08-15T04:01:00Z",
        attempts: [],
        evidence: {
          url: "https://publisher.test/a",
          httpStatus: 200,
          accessible: true,
          indexingState: "indexed" as const,
          rawEvidence: {},
        },
      },
      {
        id: "access-2b",
        revision: 1,
        kind: "access-indexing" as const,
        status: "succeeded" as const,
        attemptNumber: 1,
        publishItemId: "item-2",
        observedAt: "2026-08-15T04:01:00Z",
        attempts: [],
        evidence: {
          url: "https://publisher.test/b",
          httpStatus: 404,
          accessible: false,
          indexingState: "not-indexed" as const,
          rawEvidence: {},
        },
      },
      probeUnit("probe-q1-2", "q1", {
        mentioned: true,
        rank: 1,
        rawAnswer: "第1名：小鲸科技，性价比高",
      }),
      (() => {
        const unit = probeUnit("probe-q2-2", "q2", {
          mentioned: true,
          rank: 2,
          rawAnswer: "TOP 2 小鲸科技",
        });
        return unit;
      })(),
    ],
    "partial",
  );
  const run1 = makeRun(1, [
    probeUnit("probe-q1-1", "q1", {
      mentioned: false,
      rawAnswer: "未提及小鲸科技",
    }),
  ]);
  return {
    id: "plan-19",
    operationId: "monitor-op-19",
    sourceOperationId: "publish-op-19",
    workspaceId: "brand-19",
    createdBySessionId: "session-19",
    publishExecutionId: "execution-19",
    publishItemIds: ["item-1", "item-2"],
    baselineId: "baseline-19",
    baselinePolicyVersion: "xiaojing-geo-baseline-v1",
    baselineQuestionPoolId: "pool-19",
    baselineQuestionPoolRevision: 3,
    engineIds: ["doubao"],
    intervalMinutes: 60,
    endConditions: { maxRuns: 12 },
    policyVersion: "xiaojing-post-publish-monitor-v1",
    revision: 2,
    status: "active",
    scheduleId: "task-19",
    runCount: 2,
    nextRunAt: "2026-08-15T05:00:00Z",
    recoveryState: "ready",
    latestRun: run2,
    recentRuns: [run2, run1],
    createdAt: "2026-08-15T02:00:00Z",
    updatedAt: "2026-08-15T04:00:00Z",
  };
}

describe("XiaojingGeoEffectDashboard", () => {
  beforeEach(() => {
    mocks.sessionId = "session-19";
    mocks.apiPost.mockReset();
    mocks.engines.mockReset().mockResolvedValue([
      {
        id: "doubao",
        label: "豆包",
        available: true,
        snapshot: providerSnapshot,
      },
    ]);
    mocks.latestBaseline.mockReset().mockResolvedValue(baselineFixture());
    mocks.latestPlan.mockReset().mockResolvedValue(planFixture());
  });

  it("renders KPI values only from the latest real monitor run", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const mention = await screen.findByTestId("geo-effect-kpi-mention");
    expect(within(mention).getByText("100%")).toBeInTheDocument();
    expect(mention).toHaveTextContent("品牌出现 2/2 题");
    expect(within(screen.getByTestId("geo-effect-kpi-top3")).getByText("2 题")).toBeInTheDocument();
    expect(within(screen.getByTestId("geo-effect-kpi-indexing")).getByText("100%")).toBeInTheDocument();
    const access = screen.getByTestId("geo-effect-kpi-access");
    expect(within(access).getByText("50%")).toBeInTheDocument();
    expect(access).toHaveTextContent("可访问 1/2 项");
  });

  it("builds the one-line verdict deterministically from real data", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const verdict = await screen.findByTestId("geo-effect-verdict");
    expect(verdict).toHaveTextContent(
      "豆包 · 2 题中品牌出现 2 题（较基线 +50pp）",
    );
  });

  it("draws the baseline reference line and per-run curve from real evidence", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const curve = await screen.findByTestId("geo-effect-curve");
    expect(
      within(curve).getByTestId("geo-effect-curve-baseline"),
    ).toBeInTheDocument();
    const runsPath = within(curve).getByTestId("geo-effect-curve-runs");
    expect(runsPath.getAttribute("d")).toContain("M ");
    expect(screen.getByText(/基线：50%/)).toBeInTheDocument();
  });

  it("maps per-question diagnosis badges, before/after values and hit rates", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const matrix = await screen.findByTestId("geo-effect-matrix");
    expect(within(matrix).getByText("小鲸科技靠谱吗？")).toBeInTheDocument();
    expect(within(matrix).getByText("哪家 GEO 工具值得选？")).toBeInTheDocument();
    // q1/q2 最新一轮（第 2 轮）均进入前三且品牌被提及 → 诊断「正常」。
    expect(within(matrix).getByText("TOP1")).toBeInTheDocument();
    expect(within(matrix).getByText("TOP2")).toBeInTheDocument();
    expect(within(matrix).getAllByText("正常").length).toBe(2);
    // q2 只有第 2 轮一条记录且命中 → 命中率 100%。
    expect(within(matrix).getByText("100%")).toBeInTheDocument();
  });

  it("shows per-question evidence rounds with bounded raw evidence", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    // 轮次条目挂在每题证据下，同一轮次按题各出现一次。
    const run2Entries = await screen.findAllByTestId("geo-effect-log-run-2");
    expect(run2Entries.length).toBe(2);
    expect(run2Entries[0]).toHaveTextContent(/第2轮/);
    expect(run2Entries[0]).toHaveTextContent("部分成功");
    const q1Entry = run2Entries.find((entry) =>
      within(entry).queryByText(/第1名：小鲸科技/),
    );
    expect(q1Entry).toBeDefined();
    expect(
      screen.getByText(/数字来源：真实基线探测与监测轮次/),
    ).toBeInTheDocument();
  });

  it("renders all five diagnosis tiers with text badges and competitor names", async () => {
    mocks.latestBaseline.mockResolvedValue(null);
    const run = makeRun(1, [
      probeUnit("p-neg", "q-neg", {
        mentioned: true,
        rank: 1,
        suspectedNegative: true,
      }),
      probeUnit("p-comp", "q-comp", {
        mentioned: false,
        competitorMentions: ["声浪坊"],
      }),
      probeUnit("p-absent", "q-absent", { mentioned: false }),
      probeUnit("p-low", "q-low", { mentioned: true, rank: null }),
      probeUnit("p-ok", "q-ok", { mentioned: true, rank: 2 }),
    ]);
    mocks.latestPlan.mockResolvedValue({
      ...planFixture(),
      latestRun: run,
      recentRuns: [run],
    });
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const matrix = await screen.findByTestId("geo-effect-matrix");
    expect(within(matrix).getByText("疑似负面")).toBeInTheDocument();
    expect(within(matrix).getByText("竞品主导")).toBeInTheDocument();
    expect(within(matrix).getByText("缺席")).toBeInTheDocument();
    expect(within(matrix).getByText("排名低")).toBeInTheDocument();
    expect(within(matrix).getByText("正常")).toBeInTheDocument();
    // 竞品命中行显示竞品名小字。
    expect(within(matrix).getByText(/声浪坊/)).toBeInTheDocument();

    const verdict = screen.getByTestId("geo-effect-verdict");
    expect(verdict).toHaveTextContent("豆包 · 5 题中品牌出现 3 题");
    expect(verdict).toHaveTextContent("1 题竞品主导 · 1 题疑似负面");
    // 疑似负面是复核线索而非判决（geolook 纪律），界面如实标注。
    const matrixSection = screen.getByRole("region", { name: "问题诊断矩阵" });
    expect(
      within(matrixSection).getByText(/疑似负面为复核线索/),
    ).toBeInTheDocument();
  });

  it("labels failed probes as 失败, never as 缺席", async () => {
    mocks.latestBaseline.mockResolvedValue(null);
    const run = makeRun(1, [probeUnit("p-fail", "q-fail", { failed: true })]);
    mocks.latestPlan.mockResolvedValue({
      ...planFixture(),
      latestRun: run,
      recentRuns: [run],
    });
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const matrix = await screen.findByTestId("geo-effect-matrix");
    // 诊断徽章为「失败」（before/after 的 latest 侧也会出现同样的文字，
    // 这里锚定徽章本身），绝不落入 classify 对无 analysis 单元的「缺席」缺省。
    expect(matrix.querySelector('[data-diagnosis="failed"]')).not.toBeNull();
    expect(matrix.querySelector('[data-diagnosis="absent"]')).toBeNull();
    expect(within(matrix).queryByText("缺席")).not.toBeInTheDocument();
  });

  it("marks single-round KPI changes as observation noise without trend color", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    // 默认夹具只有 0% → 100% 一轮变化：标「观测波动」中性色，不给趋势色。
    const mention = await screen.findByTestId("geo-effect-kpi-mention");
    const badge = within(mention).getByTestId("geo-effect-kpi-delta");
    expect(badge).toHaveTextContent("+100pp");
    expect(badge).toHaveTextContent("观测波动");
    expect(badge.getAttribute("style")).toContain("var(--geo-dash-text-mute)");
  });

  it("confirms trend color only after two consecutive same-direction moves", async () => {
    // 0% → 50% → 100%：连续两轮同向上升才确认趋势色。
    const run1 = makeRun(1, [
      probeUnit("p1-a", "q1", { mentioned: false }),
      probeUnit("p1-b", "q2", { mentioned: false }),
    ]);
    const run2 = makeRun(2, [
      probeUnit("p2-a", "q1", { mentioned: true, rank: 3 }),
      probeUnit("p2-b", "q2", { mentioned: false }),
    ]);
    const run3 = makeRun(3, [
      probeUnit("p3-a", "q1", { mentioned: true, rank: 1 }),
      probeUnit("p3-b", "q2", { mentioned: true, rank: 2 }),
    ]);
    mocks.latestPlan.mockResolvedValue({
      ...planFixture(),
      latestRun: run3,
      recentRuns: [run3, run2, run1],
    });
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const mention = await screen.findByTestId("geo-effect-kpi-mention");
    const badge = within(mention).getByTestId("geo-effect-kpi-delta");
    expect(badge).toHaveTextContent("+50pp");
    expect(badge).not.toHaveTextContent("观测波动");
    expect(badge.getAttribute("style")).toContain("var(--geo-dash-success)");
  });

  it("jumps from a KPI card to the evidence library anchor", async () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

      const mention = await screen.findByTestId("geo-effect-kpi-mention");
      fireEvent.click(mention);
      expect(document.getElementById("geo-effect-evidence")).not.toBeNull();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("keeps honest empty states instead of fabricated numbers", async () => {
    mocks.latestBaseline.mockResolvedValue(null);
    mocks.latestPlan.mockResolvedValue(null);
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const mention = await screen.findByTestId("geo-effect-kpi-mention");
    expect(within(mention).getByText("—")).toBeInTheDocument();
    // 结论条无数据不造句。
    const verdict = screen.getByTestId("geo-effect-verdict");
    expect(verdict).toHaveTextContent("暂无真实数据");
    expect(verdict).not.toHaveTextContent("题中品牌出现");
    expect(
      screen.getByTestId("geo-effect-curve-empty"),
    ).toBeInTheDocument();
    expect(screen.getByText(/暂无真实曲线数据/)).toBeInTheDocument();
    expect(screen.getByText(/暂无该引擎的真实复测记录/)).toBeInTheDocument();
    expect(screen.getByText(/尚未产生真实监测轮次/)).toBeInTheDocument();
  });

  it("surfaces load failures and reloads when the effects entry bumps refreshKey", async () => {
    mocks.latestBaseline.mockRejectedValueOnce(new Error("brand store offline"));
    const view = render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "brand store offline",
    );

    view.rerender(
      <XiaojingGeoEffectDashboard workspaceId="brand-19" refreshKey={1} />,
    );
    await screen.findByTestId("geo-effect-kpi-mention");
    expect(mocks.latestBaseline).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // 2026-08-19 拍板：无会话时投影读取照常——看板渲染真实基线回退值，
  // 只有引擎可用性探测被跳过，不出现错误横幅。
  it("renders projection reads without an open session", async () => {
    mocks.sessionId = null;
    mocks.latestPlan.mockResolvedValue(null);
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const mention = await screen.findByTestId("geo-effect-kpi-mention");
    expect(within(mention).getByText("50%")).toBeInTheDocument();
    expect(within(mention).getByText(/基线探测 2 题/)).toBeInTheDocument();
    expect(mocks.engines).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
