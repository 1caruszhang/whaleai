import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GeoBaselineProjection } from "../../../shared/geo/baseline";
import type { PostPublishMonitorPlanProjection } from "../../../shared/geo/postPublishMonitoring";
import XiaojingGeoEffectDashboard from "./XiaojingGeoEffectDashboard";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  engines: vi.fn(),
  latestBaseline: vi.fn(),
  latestPlan: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-19" }),
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
  policyVersion: "xiaojing-geo-baseline-v1",
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
    providerSnapshots: [providerSnapshot],
    policyVersion: "xiaojing-geo-baseline-v1",
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

function planFixture(): PostPublishMonitorPlanProjection {
  const run2 = {
    id: "run-2",
    ordinal: 2,
    scheduledFor: "2026-08-15T04:00:00Z",
    status: "partial" as const,
    createdAt: "2026-08-15T04:00:00Z",
    units: [
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
      {
        id: "probe-q1-2",
        revision: 1,
        kind: "baseline-probe" as const,
        status: "succeeded" as const,
        attemptNumber: 1,
        questionId: "q1",
        engineId: "doubao" as const,
        observedAt: "2026-08-15T04:02:00Z",
        attempts: [],
        evidence: {
          questionId: "q1",
          engineId: "doubao" as const,
          rawAnswer: "第1名：小鲸科技，性价比高",
          rawEvidence: {},
          sourceProviderSnapshot: providerSnapshot,
          providerSnapshot,
          citations: [],
          analysis: {
            brandMentioned: true,
            brandRecommended: true,
            hasCitationEvidence: false,
          },
          rankPosition: 1 as const,
          citedArticleIds: ["article-11", "article-12"],
          citedUrls: ["https://publisher.test/a"],
        },
      },
      {
        id: "probe-q2-2",
        revision: 1,
        kind: "baseline-probe" as const,
        status: "succeeded" as const,
        attemptNumber: 1,
        questionId: "q2",
        engineId: "doubao" as const,
        observedAt: "2026-08-15T04:02:00Z",
        attempts: [],
        evidence: {
          questionId: "q2",
          engineId: "doubao" as const,
          rawAnswer: "TOP 2 小鲸科技",
          rawEvidence: {},
          sourceProviderSnapshot: providerSnapshot,
          providerSnapshot,
          citations: [],
          analysis: {
            brandMentioned: true,
            brandRecommended: false,
            hasCitationEvidence: false,
          },
          rankPosition: 2 as const,
          citedArticleIds: [],
          citedUrls: [],
        },
      },
    ],
  };
  const run1 = {
    id: "run-1",
    ordinal: 1,
    scheduledFor: "2026-08-15T03:00:00Z",
    status: "succeeded" as const,
    createdAt: "2026-08-15T03:00:00Z",
    finishedAt: "2026-08-15T03:10:00Z",
    units: [
      {
        id: "probe-q1-1",
        revision: 1,
        kind: "baseline-probe" as const,
        status: "succeeded" as const,
        attemptNumber: 1,
        questionId: "q1",
        engineId: "doubao" as const,
        observedAt: "2026-08-15T03:02:00Z",
        attempts: [],
        evidence: {
          questionId: "q1",
          engineId: "doubao" as const,
          rawAnswer: "未提及小鲸科技",
          rawEvidence: {},
          sourceProviderSnapshot: providerSnapshot,
          providerSnapshot,
          citations: [],
          analysis: {
            brandMentioned: false,
            brandRecommended: false,
            hasCitationEvidence: false,
          },
          rankPosition: null,
          citedArticleIds: [],
          citedUrls: [],
        },
      },
    ],
  };
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

  it("maps per-question ranks and citations across runs in the matrix", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const matrix = await screen.findByTestId("geo-effect-matrix");
    expect(within(matrix).getAllByRole("row")).toHaveLength(3);
    expect(within(matrix).getByText("小鲸科技靠谱吗？")).toBeInTheDocument();
    expect(within(matrix).getAllByText("TOP1").length).toBeGreaterThan(0);
    expect(within(matrix).getAllByText("TOP2").length).toBeGreaterThan(0);
    expect(within(matrix).getAllByText("未进前三").length).toBeGreaterThan(0);
    expect(within(matrix).getAllByText(/引用2/).length).toBeGreaterThan(0);
  });

  it("shows the newest-first observation log with bounded raw evidence", async () => {
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const log = await screen.findByTestId("geo-effect-log-run-2");
    expect(within(log).getByText(/第2轮 · 部分成功/)).toBeInTheDocument();
    expect(log).toHaveTextContent("进入前三 2");
    expect(within(log).getByText(/第1名：小鲸科技/)).toBeInTheDocument();
  });

  it("keeps honest empty states instead of fabricated numbers", async () => {
    mocks.latestBaseline.mockResolvedValue(null);
    mocks.latestPlan.mockResolvedValue(null);
    render(<XiaojingGeoEffectDashboard workspaceId="brand-19" />);

    const mention = await screen.findByTestId("geo-effect-kpi-mention");
    expect(within(mention).getByText("暂无真实数据")).toBeInTheDocument();
    expect(
      screen.getByText(/暂无真实曲线数据/),
    ).toBeInTheDocument();
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
});
