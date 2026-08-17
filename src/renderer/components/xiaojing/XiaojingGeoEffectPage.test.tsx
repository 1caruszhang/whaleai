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
  default: (props: { workspaceId: string; readOnly?: boolean }) => {
    mocks.monitorProps(props);
    return <section aria-label="监测面板桩" />;
  },
}));
vi.mock("./XiaojingGeoEffectDashboard", () => ({
  default: (props: { workspaceId: string; refreshKey?: number }) => {
    mocks.dashboardProps(props);
    return <section aria-label="看板面板桩" />;
  },
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
      screen.getByText(/先在左侧选择品牌，即可按需执行基线探测/),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-xiaojing-geo-effect="empty"]'),
    ).not.toBeNull();
    expect(
      screen.queryByRole("region", { name: "基线面板桩" }),
    ).not.toBeInTheDocument();
  });

  // 票 31：三面板控制面借用已打开聊天 Tab 的 Session——没有可借用会话时
  // 如实引导先打开会话，不挂载面板、不伪造数据。
  it("guides to open a brand session when no chat tab of the brand is open", () => {
    const onOpenBrandSession = vi.fn();
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={null}
        onOpenBrandSession={onOpenBrandSession}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "先打开该品牌的会话" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "基线面板桩" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "看板面板桩" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开品牌会话" }));
    expect(onOpenBrandSession).toHaveBeenCalledTimes(1);
  });

  // 票 31：整页承载三面板且交互保留——基线与监测面板不得是 readOnly 挂载，
  // 看板保持只读汇总。
  it("hosts the three effect panels interactively for the current brand", () => {
    render(
      <XiaojingGeoEffectPage
        workspace={workspace}
        sessionBinding={binding}
        onOpenBrandSession={vi.fn()}
      />,
    );

    expect(screen.getByText(/看板只汇总真实证据/)).toBeInTheDocument();
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
});
