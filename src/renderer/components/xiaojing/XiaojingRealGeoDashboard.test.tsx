import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GEO_BASELINE_POLICY_VERSION } from "../../../shared/geo/baseline";
import {
  GEO_DASHBOARD_POLICY_VERSION,
  type GeoDashboardMetric,
  type GeoDashboardMetricKey,
  type GeoDashboardProjection,
} from "../../../shared/geo/dashboard";
import XiaojingRealGeoDashboard, {
  dateInputToUtc,
} from "./XiaojingRealGeoDashboard";

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-b" }),
}));

vi.mock("@/components/ExternalLink", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const anchor = {
  kind: "baseline-unit" as const,
  id: "unit-09",
  parentId: "baseline-09",
  label: "成都汽车音响改装哪家好？",
  occurredAt: "2026-08-15T02:00:00.000Z",
  operationId: "baseline-op-09",
  sessionId: "session-a",
  engineId: "doubao",
};

function metric(
  key: GeoDashboardMetricKey,
  overrides: Partial<GeoDashboardMetric> = {},
): GeoDashboardMetric {
  return {
    key,
    numerator: 1,
    denominator: 2,
    value: 50,
    sampleTime: "2026-08-15T02:00:00.000Z",
    sampleCount: 2,
    completeness: { successful: 2, failed: 0, pending: 0, total: 2 },
    availability: "available",
    sampleSufficiency: "insufficient",
    dataNotes: ["成功样本少于 3 条，仅供参考"],
    methodology: `${key} 的真实口径`,
    engineFilterApplies: key !== "content-publish",
    evidence: [anchor],
    ...overrides,
  };
}

function dashboard(): GeoDashboardProjection {
  return {
    workspaceId: "brand-15",
    workspaceName: "真实品牌",
    policyVersion: GEO_DASHBOARD_POLICY_VERSION,
    generatedAt: "2026-08-15T03:00:00.000Z",
    filters: {},
    filterSemantics: {
      timeInterval: "[from,toExclusive)",
      timezone: "UTC",
      monitorOperationLineage: "monitor-or-source-operation",
      observationPolicy: "all-observations",
      engineApplicability: "engine-metrics-only",
    },
    dimensions: {
      sessions: [
        { id: "session-a", label: "Session A" },
        { id: "session-b", label: "Session B" },
      ],
      operations: [
        {
          id: "baseline-op-09",
          kind: "baseline",
          createdAt: "2026-08-15T00:00:00Z",
        },
        {
          id: "publish-op-13",
          kind: "publish",
          createdAt: "2026-08-15T01:00:00Z",
        },
      ],
      engines: [{ id: "doubao", label: "豆包 AI 搜索" }],
    },
    providerEngines: [
      {
        id: "doubao",
        label: "豆包 AI 搜索",
        available: true,
        snapshot: {
          engineId: "doubao",
          provider: "volcengine",
          capabilitySlot: "keyword-search",
          model: "doubao-seed-2-0-lite-260428",
          endpointFamily: "ark-responses",
          searchMode: "doubao-app-ai-search",
          configurationFingerprint: "fixture",
          policyVersion: GEO_BASELINE_POLICY_VERSION,
        },
      },
    ],
    metrics: [
      metric("brand-mention", {
        completeness: { successful: 2, failed: 1, pending: 0, total: 3 },
        availability: "partial",
        dataNotes: [
          "成功样本少于 3 条，仅供参考",
          "存在 1 条失败 observation，比例只以成功样本为分母",
        ],
      }),
      metric("recommendation"),
      metric("citation-coverage"),
      metric("question-coverage"),
      metric("content-publish", {
        numerator: 1,
        denominator: 1,
        value: 100,
        sampleCount: 1,
        sampleSufficiency: "sufficient",
        engineFilterApplies: false,
        dataNotes: ["submitted 只表示渠道已受理，不等于已发布或已收录"],
      }),
      metric("monitor-change", { delta: null }),
    ],
    trend: [
      {
        runId: "run-14",
        planId: "plan-14",
        ordinal: 1,
        sampledAt: "2026-08-15T02:00:00Z",
        mentionRate: 50,
        recommendationRate: 0,
        citationRate: 50,
        successful: 2,
        failed: 1,
        pending: 0,
        evidence: {
          ...anchor,
          kind: "monitor-run",
          id: "run-14",
          parentId: "plan-14",
        },
      },
    ],
    questionEngineMatrix: [
      {
        questionId: "q-1",
        question: "成都汽车音响改装哪家好？",
        engineId: "doubao",
        observations: 3,
        successful: 2,
        failed: 1,
        pending: 0,
        mentioned: 1,
        recommended: 0,
        cited: 1,
        lastObservedAt: anchor.occurredAt,
        evidence: anchor,
      },
    ],
    observationLog: [
      { anchor, status: "succeeded", summary: "doubao · 优化前基线 · 提及是" },
    ],
    contentPublish: {
      articles: { approved: 1 },
      articlesWithApprovedRevision: 1,
      publishExecutions: { succeeded: 1 },
      publishItems: { submitted: 1 },
      submittedItems: 1,
    },
  };
}

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.apiPost.mockImplementation(
    async (path: string, body?: { kind?: string; id?: string }) => {
      if (path.endsWith("/drilldown")) {
        if (body?.kind === "monitor-run") {
          return {
            success: true,
            drilldown: {
              kind: "monitor-run",
              planId: "plan-14",
              operationId: "monitor-op-14",
              sourceOperationId: "publish-op-13",
              sessionId: "session-a",
              run: {
                id: "run-14",
                ordinal: 1,
                unitCount: 2,
                truncated: false,
                units: [
                  {
                    id: "monitor-unit-14",
                    kind: "baseline-probe",
                    status: "failed",
                    engineId: "doubao",
                    observedAt: "2026-08-15T02:00:00.000Z",
                  },
                ],
              },
            },
          };
        }
        if (body?.kind === "monitor-unit") {
          return {
            success: true,
            drilldown: {
              kind: "monitor-unit",
              planId: "plan-14",
              runId: "run-14",
              operationId: "monitor-op-14",
              sourceOperationId: "publish-op-13",
              sessionId: "session-a",
              unit: {
                id: body.id,
                kind: "baseline-probe",
                status: "succeeded",
                engineId: "doubao",
                evidence: {
                  rawAnswer: "真实监测回答。",
                  citations: [],
                },
              },
            },
          };
        }
        return {
          success: true,
          drilldown: {
            kind: "baseline-unit",
            baselineId: "baseline-09",
            operationId: "baseline-op-09",
            sessionId: "session-a",
            unit: {
              id: "unit-09",
              rawAnswer: "真实回答提及真实品牌。",
              citations: [
                { url: "https://example.cn/evidence", title: "真实来源" },
              ],
            },
          },
        };
      }
      return { success: true, dashboard: dashboard() };
    },
  );
});

describe("XiaojingRealGeoDashboard", () => {
  it("interprets datetime-local values as explicit UTC instants", () => {
    expect(dateInputToUtc("2026-08-15T00:00")).toBe("2026-08-15T00:00:00.000Z");
    expect(dateInputToUtc("2026-08-15T00:00:01.250")).toBe(
      "2026-08-15T00:00:01.250Z",
    );
    expect(dateInputToUtc("")).toBeUndefined();
  });

  it("renders six real KPI cards, trend, matrix and observation log", async () => {
    render(<XiaojingRealGeoDashboard workspaceId="brand-15" />);
    await screen.findByText("真实品牌");
    expect(screen.getByTestId("geo-dashboard-kpi-strip").children).toHaveLength(
      6,
    );
    expect(screen.getByTestId("geo-dashboard-trend")).toBeTruthy();
    expect(screen.getByTestId("geo-dashboard-matrix")).toBeTruthy();
    expect(screen.getByTestId("geo-dashboard-log")).toBeTruthy();
    expect(screen.getByText(/文章：approved 1/)).toBeTruthy();
    expect(screen.getByText(/Execution：succeeded 1/)).toBeTruthy();
    expect(screen.getByText(/发布项：submitted 1/)).toBeTruthy();
    expect(screen.getByText(/submitted 1（不等于已发布/)).toBeTruthy();
  });

  it("shows insufficient sample and partial failure as independent signals", async () => {
    render(<XiaojingRealGeoDashboard workspaceId="brand-15" />);
    await screen.findByText("数据部分可用 · 成功 2/3");
    expect(
      screen.getByTestId("geo-dashboard-sufficiency-brand-mention").textContent,
    ).toContain("样本：不足");
    expect(
      screen.getAllByText("成功样本少于 3 条，仅供参考").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("存在 1 条失败 observation，比例只以成功样本为分母"),
    ).toBeTruthy();
  });

  it("submits only actual dimension values in a combined filter", async () => {
    render(<XiaojingRealGeoDashboard workspaceId="brand-15" />);
    await screen.findByText("真实品牌");
    fireEvent.click(screen.getByLabelText("按 Session 筛选"));
    fireEvent.click(screen.getByText("Session A"));
    fireEvent.click(screen.getByLabelText("按 GEO Operation 筛选"));
    fireEvent.click(screen.getByText(/publish · publish-op-13/));
    fireEvent.click(screen.getByLabelText("按真实引擎筛选"));
    fireEvent.click(screen.getByText("豆包 AI 搜索"));
    fireEvent.change(screen.getByLabelText("UTC 起点（含）"), {
      target: { value: "2026-08-15T00:00" },
    });
    fireEvent.change(screen.getByLabelText("UTC 终点（不含）"), {
      target: { value: "2026-08-16T00:00" },
    });
    fireEvent.click(screen.getByText("应用组合筛选"));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
    const request = mocks.apiPost.mock.calls[1]?.[1] as {
      workspaceId: string;
      sessionId: string;
      filters: Record<string, string>;
    };
    expect(request).toMatchObject({
      workspaceId: "brand-15",
      sessionId: "session-b",
      filters: {
        sessionId: "session-a",
        operationId: "publish-op-13",
        engineId: "doubao",
      },
    });
    expect(request.filters.from).toBe("2026-08-15T00:00:00.000Z");
    expect(request.filters.toExclusive).toBe("2026-08-16T00:00:00.000Z");
  });

  it("does not render a zero-width trend fill when a run has no successful sample", async () => {
    const noSample = dashboard();
    noSample.trend[0] = {
      ...noSample.trend[0],
      mentionRate: null,
      recommendationRate: null,
      citationRate: null,
      successful: 0,
      failed: 1,
    };
    mocks.apiPost.mockResolvedValue({ success: true, dashboard: noSample });
    render(<XiaojingRealGeoDashboard workspaceId="brand-15" />);
    expect(
      await screen.findByTestId("geo-dashboard-trend-no-sample-run-14"),
    ).toHaveTextContent("无真实成功样本");
    expect(screen.queryByTestId("geo-dashboard-trend-fill-run-14")).toBeNull();
  });

  it("drills one bounded anchor into its real answer and citation", async () => {
    render(<XiaojingRealGeoDashboard workspaceId="brand-15" />);
    const buttons = await screen.findAllByText(/下钻 成都汽车音响改/);
    fireEvent.click(buttons[0]);
    expect(await screen.findByText("真实回答提及真实品牌。")).toBeTruthy();
    expect(screen.getByText("真实来源")).toBeTruthy();
    expect(mocks.apiPost).toHaveBeenLastCalledWith(
      "/api/xiaojing/geo-dashboard/drilldown",
      {
        workspaceId: "brand-15",
        sessionId: "session-b",
        kind: "baseline-unit",
        id: "unit-09",
      },
    );
  });

  it("shows a bounded monitor run summary and drills one exact unit", async () => {
    render(<XiaojingRealGeoDashboard workspaceId="brand-15" />);
    const runLabel = await screen.findByText("Run 1");
    fireEvent.click(runLabel.closest("button")!);
    expect(await screen.findByText("Run 1 · 单元 2")).toBeTruthy();
    fireEvent.click(screen.getByText("baseline-probe · failed"));
    expect(await screen.findByText("真实监测回答。")).toBeTruthy();
    expect(mocks.apiPost).toHaveBeenLastCalledWith(
      "/api/xiaojing/geo-dashboard/drilldown",
      {
        workspaceId: "brand-15",
        sessionId: "session-b",
        kind: "monitor-unit",
        id: "monitor-unit-14",
      },
    );
  });
});
