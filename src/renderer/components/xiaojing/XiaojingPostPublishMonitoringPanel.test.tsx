import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PostPublishMonitorPlanProjection } from "../../../shared/geo/postPublishMonitoring";
import XiaojingPostPublishMonitoringPanel from "./XiaojingPostPublishMonitoringPanel";

const mocks = vi.hoisted(() => ({
  sessionId: "session-14" as string | null,
  apiPost: vi.fn(), latest: vi.fn(), get: vi.fn(), prepare: vi.fn(), activate: vi.fn(), retry: vi.fn(),
  latestPublish: vi.fn(), latestBaseline: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));
vi.mock("@/api/postPublishMonitoringClient", () => ({
  loadLatestPostPublishMonitor: mocks.latest,
  loadPostPublishMonitor: mocks.get,
  preparePostPublishMonitor: mocks.prepare,
  activatePostPublishMonitor: mocks.activate,
  retryPostPublishMonitorUnit: mocks.retry,
}));
vi.mock("@/api/publishSchedulerClient", () => ({ loadLatestPublishExecution: mocks.latestPublish }));
vi.mock("@/api/geoBaselineClient", () => ({ loadLatestGeoBaseline: mocks.latestBaseline }));

function activePlan(): PostPublishMonitorPlanProjection {
  const plan: PostPublishMonitorPlanProjection = {
    id: "monitor-plan-14", operationId: "monitor-op-14", sourceOperationId: "publish-op-13",
    workspaceId: "brand-14", createdBySessionId: "session-14", publishExecutionId: "publish-exec-13",
    publishItemIds: ["publish-item-13"], baselineId: "baseline-09", baselinePolicyVersion: "xiaojing-geo-baseline-v1",
    baselineQuestionPoolId: "pool-08", baselineQuestionPoolRevision: 4, engineIds: ["doubao"], intervalMinutes: 60,
    endConditions: { maxRuns: 12 }, policyVersion: "xiaojing-post-publish-monitor-v1", revision: 5,
    status: "active", scheduleId: "hidden-task-14", runCount: 2, nextRunAt: "2026-08-15T08:00:00Z",
    recoveryState: "overdue", createdAt: "2026-08-15T00:00:00Z", updatedAt: "2026-08-15T01:00:00Z",
    latestRun: {
      id: "run-2", ordinal: 2, scheduledFor: "2026-08-15T02:00:00Z", status: "partial",
      createdAt: "2026-08-15T01:00:00Z", units: [
        {
          id: "unit-status", revision: 2, kind: "publish-status", status: "succeeded", attemptNumber: 1,
          publishItemId: "publish-item-13", observedAt: "2026-08-15T01:01:00Z", attempts: [],
          evidence: { platformStatusCode: 4, platformStatus: "published", externalOrderId: "order-13", externalRequestSn: "sn-13", publishedUrl: "https://publisher.test/a", rawEvidence: { status: 4 } },
        },
        {
          id: "unit-access", revision: 7, kind: "access-indexing", status: "failed", attemptNumber: 2,
          publishItemId: "publish-item-13", errorCode: "published-page-url-unavailable", errorMessage: "平台尚未返回真实发布页 URL", attempts: [],
        },
      ],
    },
    recentRuns: [],
  };
  plan.recentRuns = [
    plan.latestRun!,
    {
      id: "run-1",
      ordinal: 1,
      scheduledFor: "2026-08-15T01:00:00Z",
      status: "succeeded",
      createdAt: "2026-08-15T01:00:00Z",
      finishedAt: "2026-08-15T01:02:00Z",
      units: [],
    },
  ];
  return plan;
}

describe("XiaojingPostPublishMonitoringPanel", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((value) => {
      if (typeof value === "function") value.mockReset();
    });
    mocks.sessionId = "session-14";
    mocks.latest.mockResolvedValue(activePlan());
    mocks.get.mockResolvedValue({ ...activePlan(), id: "monitor-plan-exact" });
    mocks.latestPublish.mockResolvedValue({ id: "publish-exec-13" });
    mocks.latestBaseline.mockResolvedValue({ id: "baseline-09" });
    mocks.retry.mockResolvedValue(activePlan());
  });

  it("loads a notification-targeted monitor plan by exact id instead of latest", async () => {
    render(<XiaojingPostPublishMonitoringPanel workspaceId="brand-14" planId="monitor-plan-exact" />);
    await screen.findByRole("region", { name: "发布后 GEO 监测" });
    expect(mocks.get).toHaveBeenCalledWith(
      { workspaceId: "brand-14", sessionId: "session-14" },
      "monitor-plan-exact",
    );
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  // 票 32：深链按精确计划 id 读取——最新 run 视图（告警对应的监测结果）
  // 带定位标记；计划不存在时显示可理解错误，绝不回落到 latest 相似对象。
  it("marks the located plan's latest run and never falls back to latest on a missing plan", async () => {
    mocks.get.mockRejectedValue(new Error("monitor plan not found"));
    const view = render(
      <XiaojingPostPublishMonitoringPanel
        workspaceId="brand-14"
        planId="monitor-plan-deleted"
      />,
    );
    const panel = await screen.findByRole("region", { name: "发布后 GEO 监测" });
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(within(panel).getByText(/monitor plan not found/)).toBeInTheDocument();
    expect(panel).not.toHaveAttribute("data-geo-monitor-located");

    mocks.get.mockResolvedValue({ ...activePlan(), id: "monitor-plan-exact" });
    view.rerender(
      <XiaojingPostPublishMonitoringPanel
        workspaceId="brand-14"
        planId="monitor-plan-exact"
      />,
    );
    const located = await screen.findByRole("region", { name: "发布后 GEO 监测" });
    await waitFor(() => {
      expect(located).toHaveAttribute("data-geo-monitor-located");
    });
    const runBlock = located.querySelector("[data-geo-monitor-run-located]");
    expect(runBlock).not.toBeNull();
    expect(runBlock).toHaveTextContent("时间序列 Run #2");
    expect(within(runBlock as HTMLElement).getByText("通知定位")).toBeInTheDocument();
  });

  it("shows local-app recovery semantics, concrete unit failure, and exact single-unit retry", async () => {
    render(<XiaojingPostPublishMonitoringPanel workspaceId="brand-14" />);
    const panel = await screen.findByRole("region", { name: "发布后 GEO 监测" });
    expect(within(panel).getByText(/应用退出时本地监测暂停/)).toBeInTheDocument();
    expect(within(panel).getByText(/published-page-url-unavailable/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "仅重试此单元" }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith(
      { workspaceId: "brand-14", sessionId: "session-14" },
      { planId: "monitor-plan-14", unitId: "unit-access", expectedUnitRevision: 7 },
    ));
  });

  it("keeps active history immutable and requires an explicit new plan for config changes", async () => {
    render(<XiaojingPostPublishMonitoringPanel workspaceId="brand-14" />);
    const panel = await screen.findByRole("region", { name: "发布后 GEO 监测" });
    expect(within(panel).queryByLabelText("监测频率")).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "以明确新计划变更配置" }));
    expect(within(panel).getByLabelText("监测频率")).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", { name: "豆包" })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: "其他引擎（当前不可用）" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "创建新监测计划" })).toBeInTheDocument();
  });

  it("requires an available target engine, freezes it in prepare, and shows bounded run history", async () => {
    mocks.prepare.mockResolvedValue(activePlan());
    render(<XiaojingPostPublishMonitoringPanel workspaceId="brand-14" />);
    const panel = await screen.findByRole("region", { name: "发布后 GEO 监测" });
    expect(within(panel).getByLabelText("最近监测历史")).toHaveTextContent("Run #2");
    expect(within(panel).getByLabelText("最近监测历史")).toHaveTextContent("Run #1");
    fireEvent.click(within(panel).getByRole("button", { name: "以明确新计划变更配置" }));
    const doubao = within(panel).getByRole("checkbox", { name: "豆包" });
    fireEvent.click(doubao);
    expect(within(panel).getByText("至少选择一个可用目标引擎")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "创建新监测计划" })).toBeDisabled();
    fireEvent.click(doubao);
    fireEvent.click(within(panel).getByRole("button", { name: "创建新监测计划" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledWith(
      { workspaceId: "brand-14", sessionId: "session-14" },
      expect.objectContaining({ engineIds: ["doubao"] }),
    ));
  });

  // 2026-08-19 拍板：无会话时监测计划与 run 照常渲染（Rust IPC 投影读取，
  // sessionId 传 null），配置/启用/重试隐藏并提示先打开会话。
  it("renders committed monitor results without an open session", async () => {
    mocks.sessionId = null;
    render(<XiaojingPostPublishMonitoringPanel workspaceId="brand-14" />);

    const panel = await screen.findByRole("region", { name: "发布后 GEO 监测" });
    expect(mocks.latest).toHaveBeenCalledWith(
      { workspaceId: "brand-14", sessionId: null },
    );
    expect(within(panel).getByText(/时间序列 Run #2/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/打开该品牌的会话后，才能配置、启用监测/),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "仅重试此单元" }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "以明确新计划变更配置" }),
    ).not.toBeInTheDocument();
  });
});
