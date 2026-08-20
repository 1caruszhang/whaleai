import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import XiaojingGeoEffectReport from "./XiaojingGeoEffectReport";

const mocks = vi.hoisted(() => ({
  latestBaseline: vi.fn(),
  latestPlan: vi.fn(),
}));

vi.mock("@/api/geoBaselineClient", () => ({
  loadLatestGeoBaseline: mocks.latestBaseline,
}));
vi.mock("@/api/postPublishMonitoringClient", () => ({
  loadLatestPostPublishMonitor: mocks.latestPlan,
}));

const workspace: BrandWorkspace = {
  id: "brand-19",
  name: "小鲸科技",
  productLines: ["GEO 工具"],
  rootPath: "/brands/brand-19",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

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

function baselineFixture() {
  return {
    id: "baseline-19",
    operationId: "operation-19",
    workspaceId: "brand-19",
    createdBySessionId: "session-19",
    questionPoolId: "pool-19",
    questionPoolRevision: 3,
    knowledgeVersion: 5,
    brandNames: ["小鲸科技"],
    competitorNames: ["声浪坊"],
    providerSnapshots: [providerSnapshot],
    policyVersion: "xiaojing-geo-baseline-v2",
    status: "succeeded" as const,
    metrics: {
      total: 1,
      completed: 1,
      succeeded: 1,
      failed: 0,
      pending: 0,
      brandMentioned: 0,
      brandRecommended: 0,
      withCitationEvidence: 0,
      mentionRate: 0,
      recommendationRate: 0,
      citationRate: 0,
      evidenceUnitIds: {
        brandMentioned: [],
        brandRecommended: [],
        withCitationEvidence: [],
        failed: [],
      },
    },
    units: [
      {
        id: "unit-q1",
        questionId: "q1",
        question: "哪家 GEO 工具值得选？",
        engineId: "doubao" as const,
        providerSnapshot,
        status: "succeeded" as const,
        attemptNumber: 1,
        rawAnswer: "可以考虑声浪坊",
        citations: [],
        analysis: {
          brandMentioned: false,
          brandRecommended: false,
          hasCitationEvidence: false,
          competitorMentions: ["声浪坊"],
        },
        attempts: [],
      },
    ],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
  };
}

describe("XiaojingGeoEffectReport", () => {
  beforeEach(() => {
    mocks.latestBaseline.mockReset().mockResolvedValue(baselineFixture());
    mocks.latestPlan.mockReset().mockResolvedValue(null);
  });

  it("renders the one-page report from real projection data without a session", async () => {
    render(<XiaojingGeoEffectReport workspace={workspace} />);

    const report = await screen.findByTestId("geo-effect-report");
    expect(report).toHaveTextContent("小鲸科技 · GEO 效果报告");
    expect(report).toHaveTextContent(/生成时间：/);
    // 基线口径结论：品牌缺席且竞品在场 → 竞品主导如实呈现。
    expect(within(report).getByTestId("geo-effect-verdict")).toHaveTextContent(
      "豆包 · 基线 1 题中品牌出现 0 题（暂无监测轮次对照） · 1 题竞品主导",
    );
    expect(
      within(report).getByTestId("geo-effect-kpi-mention"),
    ).toHaveTextContent("0%");
    const matrix = within(report).getByTestId("geo-effect-matrix");
    expect(within(matrix).getByText("竞品主导")).toBeInTheDocument();
    // 分题 before/after：无监测轮次时最新侧如实为「—」。
    expect(report).toHaveTextContent("基线 未提及");
    expect(mocks.latestPlan).toHaveBeenCalledWith({
      workspaceId: "brand-19",
      sessionId: null,
    });
  });

  it("keeps the honest no-data verdict instead of fabricating a sentence", async () => {
    mocks.latestBaseline.mockResolvedValue(null);
    render(<XiaojingGeoEffectReport workspace={workspace} />);

    const verdict = await screen.findByTestId("geo-effect-verdict");
    expect(verdict).toHaveTextContent("暂无真实数据");
    expect(verdict).not.toHaveTextContent("题中品牌出现");
  });
});
