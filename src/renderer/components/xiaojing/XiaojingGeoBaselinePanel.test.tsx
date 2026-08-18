import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GEO_BASELINE_POLICY_VERSION,
  type GeoBaselineProjection,
  type GeoBaselineProviderSnapshot,
} from "../../../shared/geo/baseline";
import type { QuestionPoolProjection } from "../../../shared/geo/questionPool";
import XiaojingGeoBaselinePanel from "./XiaojingGeoBaselinePanel";

const mocks = vi.hoisted(() => ({
  sessionId: "session-09" as string | null,
  apiPost: vi.fn(),
  engines: vi.fn(),
  latestPool: vi.fn(),
  latestBaseline: vi.fn(),
  start: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/brandQuestionPoolClient", () => ({
  loadLatestQuestionPool: mocks.latestPool,
}));

vi.mock("@/api/geoBaselineClient", () => ({
  loadGeoBaselineEngines: mocks.engines,
  loadLatestGeoBaseline: mocks.latestBaseline,
  startGeoBaseline: mocks.start,
  retryGeoBaselineUnits: mocks.retry,
}));

vi.mock("@/components/ExternalLink", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const snapshot: GeoBaselineProviderSnapshot = {
  engineId: "doubao" as const,
  provider: "volcengine" as const,
  capabilitySlot: "keyword-search" as const,
  model: "doubao-seed-2-0-lite-260428",
  endpointFamily: "ark-responses" as const,
  searchMode: "doubao-app-ai-search" as const,
  configurationFingerprint: "test-config-fingerprint",
  policyVersion: GEO_BASELINE_POLICY_VERSION,
};

const confirmedPool = {
  id: "pool-08",
  status: "confirmed",
  revision: 1,
} as QuestionPoolProjection;

function baseline(status: GeoBaselineProjection["status"] = "partial"): GeoBaselineProjection {
  return {
    id: "baseline-09",
    operationId: "operation-09",
    workspaceId: "brand-09",
    createdBySessionId: "session-09",
    questionPoolId: "pool-08",
    questionPoolRevision: 1,
    knowledgeVersion: 7,
    brandNames: ["鲸跃汽车"],
    providerSnapshots: [snapshot],
    policyVersion: GEO_BASELINE_POLICY_VERSION,
    status,
    metrics: {
      total: 2,
      completed: 2,
      succeeded: 1,
      failed: 1,
      pending: 0,
      brandMentioned: 1,
      brandRecommended: 1,
      withCitationEvidence: 1,
      mentionRate: 100,
      recommendationRate: 100,
      citationRate: 100,
      evidenceUnitIds: {
        brandMentioned: ["unit-success"],
        brandRecommended: ["unit-success"],
        withCitationEvidence: ["unit-success"],
        failed: ["unit-failed"],
      },
    },
    units: [
      {
        id: "unit-success",
        questionId: "q-1",
        question: "成都汽车音响哪家好？",
        engineId: "doubao",
        providerSnapshot: snapshot,
        status: "succeeded",
        attemptNumber: 1,
        rawAnswer: "推荐鲸跃汽车。",
        rawEvidence: { output_text: "推荐鲸跃汽车。" },
        citations: [
          {
            url: "https://example.cn/review",
            title: "真实报道",
            provenance: "structured-provider",
          },
        ],
        analysis: {
          brandMentioned: true,
          brandRecommended: true,
          hasCitationEvidence: true,
        },
        attempts: [],
      },
      {
        id: "unit-failed",
        questionId: "q-2",
        question: "成都汽车隔音怎么选？",
        engineId: "doubao",
        providerSnapshot: snapshot,
        status: "failed",
        attemptNumber: 1,
        citations: [],
        errorCode: "geo_baseline_rate_limited",
        errorMessage: "服务限流（HTTP 429）",
        attempts: [
          {
            attemptNumber: 1,
            status: "failed",
            startedAt: "2026-08-15T00:00:00Z",
            errorCode: "geo_baseline_rate_limited",
            errorMessage: "服务限流（HTTP 429）",
          },
        ],
      },
    ],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
  };
}

describe("XiaojingGeoBaselinePanel", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((value) => {
      if (typeof value === "function") value.mockReset();
    });
    mocks.sessionId = "session-09";
    mocks.engines.mockResolvedValue([
      { id: "doubao", label: "豆包 AI 搜索", available: true, snapshot },
    ]);
    mocks.latestPool.mockResolvedValue(confirmedPool);
    mocks.latestBaseline.mockResolvedValue(null);
  });

  it("starts only from a confirmed pool and renders evidence-backed drilldown", async () => {
    mocks.start.mockResolvedValue(baseline());
    render(<XiaojingGeoBaselinePanel workspaceId="brand-09" />);
    expect(await screen.findByText("暂无真实检测数据")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始优化前检测" }));

    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.start.mock.calls[0][2]).toMatchObject({
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
    });
    const results = await screen.findByRole("region", { name: "真实 GEO 基线结果" });
    expect(within(results).getByText("被提及")).toBeInTheDocument();
    expect(within(results).getAllByText("100%")).toHaveLength(3);
    fireEvent.click(within(results).getByText("成都汽车音响哪家好？"));
    expect(within(results).getByText("推荐鲸跃汽车。")).toBeInTheDocument();
    expect(within(results).getByText(/真实报道/)).toBeInTheDocument();
  });

  it("shows unavailable instead of synthetic data when no real Provider is configured", async () => {
    mocks.engines.mockResolvedValue([
      {
        id: "doubao",
        label: "豆包 AI 搜索",
        available: false,
        unavailableReason: "豆包 / ARK Provider 尚未配置",
        snapshot,
      },
    ]);
    render(<XiaojingGeoBaselinePanel workspaceId="brand-09" />);
    expect(await screen.findByText("当前不可检测")).toBeInTheDocument();
    expect(screen.getByText("豆包 / ARK Provider 尚未配置")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始优化前检测" })).not.toBeInTheDocument();
  });

  it("retries only the selected failed question-engine unit", async () => {
    mocks.latestBaseline.mockResolvedValue(baseline());
    mocks.retry.mockResolvedValue(baseline("succeeded"));
    render(<XiaojingGeoBaselinePanel workspaceId="brand-09" />);
    const retryButton = await screen.findByRole("button", { name: "只重试此问题" });
    fireEvent.click(retryButton);
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledTimes(1));
    expect(mocks.retry.mock.calls[0][2]).toEqual({
      baselineId: "baseline-09",
      unitIds: ["unit-failed"],
    });
  });

  // 2026-08-19 拍板：无会话时基线结果照常渲染（Rust IPC 投影读取），
  // 执行类交互（引擎选择/启动/重试）隐藏并提示先打开会话。
  it("renders committed baseline results without an open session", async () => {
    mocks.sessionId = null;
    mocks.latestBaseline.mockResolvedValue(baseline());
    render(<XiaojingGeoBaselinePanel workspaceId="brand-09" />);

    const results = await screen.findByRole("region", { name: "真实 GEO 基线结果" });
    expect(within(results).getByText("成都汽车音响哪家好？")).toBeInTheDocument();
    expect(
      screen.getByText(/打开该品牌的会话后，才能选择引擎并执行检测与重试/),
    ).toBeInTheDocument();
    expect(mocks.engines).not.toHaveBeenCalled();
    expect(mocks.latestPool).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "开始优化前检测" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "只重试此问题" }),
    ).not.toBeInTheDocument();
  });
});
