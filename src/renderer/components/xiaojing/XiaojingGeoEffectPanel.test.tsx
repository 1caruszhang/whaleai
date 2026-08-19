import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import XiaojingGeoEffectPanel from "./XiaojingGeoEffectPanel";

const mocks = vi.hoisted(() => ({
  baselineProps: vi.fn(),
  monitorProps: vi.fn(),
  dashboardProps: vi.fn(),
}));

vi.mock("./XiaojingGeoBaselinePanel", () => ({
  default: (props: { onResultCommitted?: () => void }) => {
    mocks.baselineProps(props);
    return (
      <section aria-label="基线面板桩">
        <button
          type="button"
          onClick={props.onResultCommitted}
        >
          模拟基线提交
        </button>
      </section>
    );
  },
}));
vi.mock("./XiaojingPostPublishMonitoringPanel", () => ({
  default: (props: {
    refreshKey?: number;
    planId?: string;
    onPlanMutated?: () => void;
  }) => {
    mocks.monitorProps(props);
    return (
      <section aria-label="监测面板桩">
        <button type="button" onClick={props.onPlanMutated}>
          模拟监测变更
        </button>
      </section>
    );
  },
}));
vi.mock("./XiaojingGeoEffectDashboard", () => ({
  default: (props: { workspaceId: string; refreshKey?: number }) => {
    mocks.dashboardProps(props);
    return <section aria-label="看板面板桩" />;
  },
}));

describe("XiaojingGeoEffectPanel", () => {
  beforeEach(() => {
    mocks.baselineProps.mockReset();
    mocks.monitorProps.mockReset();
    mocks.dashboardProps.mockReset();
  });

  // 2026-08-19 拍板：看板置顶，监测与基线面板随其后。
  it("composes the dashboard first, then monitor management and on-demand baseline", () => {
    render(<XiaojingGeoEffectPanel workspaceId="brand-19" />);

    const dashboard = screen.getByRole("region", { name: "看板面板桩" });
    const monitor = screen.getByRole("region", { name: "监测面板桩" });
    const baseline = screen.getByRole("region", { name: "基线面板桩" });
    expect(dashboard).toBeInTheDocument();
    expect(monitor).toBeInTheDocument();
    expect(baseline).toBeInTheDocument();
    expect(
      dashboard.compareDocumentPosition(monitor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      monitor.compareDocumentPosition(baseline) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(mocks.baselineProps).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "brand-19" }),
    );
    expect(mocks.dashboardProps).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "brand-19", refreshKey: 0 }),
    );
  });

  it("re-reads monitor and dashboard projections after a committed baseline", () => {
    render(<XiaojingGeoEffectPanel workspaceId="brand-19" />);
    fireEvent.click(screen.getByRole("button", { name: "模拟基线提交" }));

    expect(mocks.monitorProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshKey: 1 }),
    );
    expect(mocks.dashboardProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshKey: 1 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "模拟监测变更" }));
    expect(mocks.dashboardProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshKey: 2 }),
    );
  });

  // 票 32：监测告警深链落到本面板——按精确计划 id 读取监测面板，
  // 且每次深链到达滚动定位到监测区块。没有深链时不传 planId（latest 读取）。
  it("locates the exact monitor plan and scrolls to it when a monitor deep link arrives", () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const view = render(
      <XiaojingGeoEffectPanel workspaceId="brand-19" monitorNavigationTarget={null} />,
    );
    expect(mocks.monitorProps).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ planId: expect.anything() }),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(
      <XiaojingGeoEffectPanel
        workspaceId="brand-19"
        monitorNavigationTarget={{ workspaceId: "brand-19", planId: "monitor-plan-exact", nonce: 4 }}
      />,
    );

    expect(mocks.monitorProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ planId: "monitor-plan-exact" }),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "start" }),
    );

    // 同一 nonce 的重渲染（如 refreshKey 变化）不得重复滚动定位。
    view.rerender(
      <XiaojingGeoEffectPanel
        workspaceId="brand-19"
        monitorNavigationTarget={{ workspaceId: "brand-19", planId: "monitor-plan-exact", nonce: 4 }}
      />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });
});
