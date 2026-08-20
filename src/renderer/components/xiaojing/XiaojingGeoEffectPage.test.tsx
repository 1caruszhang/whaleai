import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import XiaojingGeoEffectPage from "./XiaojingGeoEffectPage";

const mocks = vi.hoisted(() => ({
  baselineProps: vi.fn(),
  monitorProps: vi.fn(),
  dashboardProps: vi.fn(),
  sessionSidecarFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true }),
  })),
}));

// 三个子面板用与 XiaojingGeoEffectPanel.test 相同的桩法；基线桩额外从
// TabContext 取控制面 API，用来验证整页作用域的借用身份。
vi.mock("./XiaojingGeoBaselinePanel", async () => {
  const { useTabApi, useTabState } = await import("@/context/TabContext");
  function BaselineStub(props: {
    workspaceId: string;
    readOnly?: boolean;
    onResultCommitted?: () => void;
  }) {
    mocks.baselineProps(props);
    const { apiPost } = useTabApi();
    const { sessionId } = useTabState();
    return (
      <section aria-label="基线面板桩">
        <span data-baseline-session={sessionId} />
        <button
          type="button"
          onClick={() => void apiPost("/api/xiaojing/geo-baselines/latest", {})}
        >
          触发控制面请求
        </button>
      </section>
    );
  }
  return { default: BaselineStub };
});
vi.mock("./XiaojingPostPublishMonitoringPanel", () => ({
  default: (props: {
    workspaceId: string;
    readOnly?: boolean;
    planId?: string;
  }) => {
    mocks.monitorProps(props);
    return (
      <section aria-label="监测面板桩" data-monitor-plan={props.planId ?? ""} />
    );
  },
}));
vi.mock("./XiaojingGeoEffectDashboard", () => ({
  default: (props: { workspaceId: string; refreshKey?: number }) => {
    mocks.dashboardProps(props);
    return <section aria-label="看板面板桩" />;
  },
}));
vi.mock("./XiaojingGeoEffectReport", () => ({
  default: () => <section aria-label="报告视图桩" />,
}));
vi.mock("@/api/tauriClient", () => ({
  sessionSidecarFetch: mocks.sessionSidecarFetch,
}));

const workspace: BrandWorkspace = {
  id: "brand-19",
  name: "小鲸科技",
  productLines: ["GEO 工具"],
  rootPath: "/brands/brand-19",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

const binding = { sessionId: "session-19", ownerTabId: "tab-owner-7" };

describe("XiaojingGeoEffectPage", () => {
  beforeEach(() => {
    mocks.baselineProps.mockClear();
    mocks.monitorProps.mockClear();
    mocks.dashboardProps.mockClear();
    mocks.sessionSidecarFetch.mockClear();
  });

  it("shows the brand-selection empty state without a workspace", () => {
    render(
      <XiaojingGeoEffectPage
        workspace={null}
        sessionBinding={null}
        onOpenBrandSession={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/先在左侧选择品牌，即可查看真实效果看板/),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-xiaojing-geo-effect="empty"]'),
    ).not.toBeNull();
    expect(
      screen.queryByRole("region", { name: "基线面板桩" }),
    ).not.toBeInTheDocument();
  });

  // 2026-08-19 拍板：无会话时页面照常渲染三面板（投影读取走 Rust IPC），
  // 只以顶部提示条引导打开会话——不再整页替换为引导卡。
  it("renders the effect panels with a session banner when no chat tab of the brand is open", () => {
    const onOpenBrandSession = vi.fn();
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={null}
        onOpenBrandSession={onOpenBrandSession}
      />,
    );

    expect(
      screen.getByRole("region", { name: "需要品牌会话" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/看板与监测结果已按真实数据显示/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "基线面板桩" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "看板面板桩" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开品牌会话" }));
    expect(onOpenBrandSession).toHaveBeenCalledTimes(1);
  });

  // 票 31 + 2026-08-19：整页承载三面板且交互保留——基线与监测面板不得是
  // readOnly 挂载，看板保持只读汇总并置顶。
  it("hosts the three effect panels interactively for the current brand", () => {
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={binding}
        onOpenBrandSession={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "需要品牌会话" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "基线面板桩" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "监测面板桩" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "看板面板桩" }),
    ).toBeInTheDocument();
    expect(mocks.baselineProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "brand-19" }),
    );
    expect(mocks.baselineProps).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ readOnly: true }),
    );
    expect(mocks.monitorProps).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ readOnly: true }),
    );
    expect(mocks.dashboardProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "brand-19" }),
    );
  });

  it("rides the borrowed chat-tab session for the control plane", () => {
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={binding}
        onOpenBrandSession={vi.fn()}
      />,
    );

    expect(
      document.querySelector("[data-baseline-session]"),
    ).toHaveAttribute("data-baseline-session", "session-19");
    fireEvent.click(screen.getByRole("button", { name: "触发控制面请求" }));

    expect(mocks.sessionSidecarFetch).toHaveBeenCalledWith(
      "session-19",
      { type: "tab", id: "tab-owner-7" },
      "/api/xiaojing/geo-baselines/latest",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Xiaojing-Tab-Id": "tab-owner-7",
          "X-Xiaojing-Session-Id": "session-19",
        }),
      }),
    );
  });

  it("remounts per brand so panel state never leaks across workspaces", () => {
    const { rerender } = render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={binding}
        onOpenBrandSession={vi.fn()}
      />,
    );
    expect(
      document.querySelector('[data-xiaojing-geo-effect="brand-19"]'),
    ).not.toBeNull();

    const other: BrandWorkspace = { ...workspace, id: "brand-77", name: "远洋品牌" };
    rerender(
      <XiaojingGeoEffectPage
        workspace={other}
        sessionBinding={{ sessionId: "session-77", ownerTabId: "tab-owner-8" }}
        onOpenBrandSession={vi.fn()}
      />,
    );
    expect(
      document.querySelector('[data-xiaojing-geo-effect="brand-77"]'),
    ).not.toBeNull();
    expect(mocks.baselineProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "brand-77" }),
    );
  });

  // 报告视图：页头切换整页替换为一页纸排版（打印友好），可切回看板。
  it("switches between the dashboard and the printable report view", () => {
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={binding}
        onOpenBrandSession={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "报告视图" }));
    expect(
      screen.getByRole("region", { name: "报告视图桩" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "看板面板桩" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "返回看板" }));
    expect(
      screen.getByRole("region", { name: "看板面板桩" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "报告视图桩" }),
    ).not.toBeInTheDocument();
  });

  // 票 32：监测告警深链的落点经整页传入三面板挂载区——精确计划 id 到达
  // 监测面板，页面对落点本身不做任何改写或猜测。
  it("forwards the monitor deep-link target to the monitoring panel", () => {    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={binding}
        monitorNavigationTarget={{
          workspaceId: "brand-19",
          planId: "monitor-plan-exact",
          nonce: 3,
        }}
        onOpenBrandSession={vi.fn()}
      />,
    );

    expect(mocks.monitorProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ planId: "monitor-plan-exact" }),
    );
    expect(
      document.querySelector("[data-monitor-plan]"),
    ).toHaveAttribute("data-monitor-plan", "monitor-plan-exact");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });
});
