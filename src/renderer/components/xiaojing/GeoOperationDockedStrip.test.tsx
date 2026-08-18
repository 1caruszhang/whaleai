import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CurrentWorkspaceContext } from "@/context/CurrentWorkspaceContext";
import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import { planGeoOperation } from "../../../shared/geo/operation";
import type { GeoOperationProjection } from "../../../shared/geo/operation";
import GeoOperationDockedStrip from "./GeoOperationDockedStrip";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  loadGeoOperations: vi.fn(),
  sessionId: "session-17" as string | null,
  toolCompleteCount: 0,
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({
    sessionId: mocks.sessionId,
    toolCompleteCount: mocks.toolCompleteCount,
  }),
}));

vi.mock("@/api/geoOperationClient", () => ({
  loadGeoOperations: mocks.loadGeoOperations,
}));

const runningOperation = (() => {
  const plan = planGeoOperation({
    intent: "full-optimization",
    goal: "完整 GEO 优化",
  });
  return {
    id: "operation-17",
    workspaceId: "brand-17",
    sessionId: "session-17",
    goal: "完整 GEO 优化",
    status: "running",
    revision: 5,
    steps: plan.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "succeeded" : index === 1 ? "running" : step.status,
    })),
  } as unknown as GeoOperationProjection;
})();

const terminalOperation = {
  ...runningOperation,
  id: "operation-done",
  status: "succeeded",
} as unknown as GeoOperationProjection;

const workspace = {
  id: "brand-17",
  name: "品牌十七",
  rootPath: "/brands/brand-17",
} as unknown as BrandWorkspace;

function renderDocked(onLocate?: (operationId: string) => void) {
  return render(
    <CurrentWorkspaceContext.Provider value={workspace}>
      <GeoOperationDockedStrip onLocate={onLocate} />
    </CurrentWorkspaceContext.Provider>,
  );
}

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.loadGeoOperations.mockReset();
  mocks.loadGeoOperations.mockResolvedValue([]);
  mocks.sessionId = "session-17";
  mocks.toolCompleteCount = 0;
});

describe("GeoOperationDockedStrip", () => {
  // 常驻语义：只要本 Session 还有非终态操作，输入框上方就有一条闸门进度，
  // 不随消息滚动离开视野；与工作台聚焦推导一致地取首个非终态操作。
  it("docks the gate progress of the first non-terminal operation", async () => {
    mocks.loadGeoOperations.mockResolvedValue([
      terminalOperation,
      runningOperation,
    ]);
    const onLocate = vi.fn();
    const { container } = renderDocked(onLocate);

    const dock = await waitFor(() =>
      screen.getByRole("button", { name: "定位当前闸门卡片" }),
    );
    expect(dock.getAttribute("data-geo-operation-dock")).toBe("operation-17");
    expect(screen.getByText("完整 GEO 优化")).toBeInTheDocument();
    expect(
      screen.getByText(/进行中 · 1\/8 道闸门 · 当前：确认品牌知识变更/),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-geo-gate-progress]")).not.toBeNull();
    // 点击定位携带首个非终态操作的 id。
    fireEvent.click(dock);
    expect(onLocate).toHaveBeenCalledWith("operation-17");
  });

  it("renders nothing when every operation is terminal or the list is empty", async () => {
    mocks.loadGeoOperations.mockResolvedValue([terminalOperation]);
    const { container } = renderDocked();
    await waitFor(() =>
      expect(mocks.loadGeoOperations).toHaveBeenCalledTimes(1),
    );
    expect(container.querySelector("[data-geo-operation-dock]")).toBeNull();

    mocks.loadGeoOperations.mockResolvedValue([]);
    mocks.toolCompleteCount = 1;
    renderDocked();
    await waitFor(() =>
      expect(mocks.loadGeoOperations).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByRole("button", { name: "定位当前闸门卡片" })).toBeNull();
  });

  it("does not fetch before the session is real", () => {
    mocks.sessionId = null;
    const { container } = renderDocked();
    expect(mocks.loadGeoOperations).not.toHaveBeenCalled();
    expect(container.querySelector("[data-geo-operation-dock]")).toBeNull();
  });

  // 新操作的进度卡出现的回合（工具完成）停靠条同拍刷新，不等 3s 轮询。
  it("refetches when a tool completes in the turn", async () => {
    mocks.loadGeoOperations.mockResolvedValue([runningOperation]);
    const view = renderDocked();
    await waitFor(() =>
      expect(mocks.loadGeoOperations).toHaveBeenCalledTimes(1),
    );

    mocks.toolCompleteCount = 1;
    view.rerender(
      <CurrentWorkspaceContext.Provider value={workspace}>
        <GeoOperationDockedStrip />
      </CurrentWorkspaceContext.Provider>,
    );
    await waitFor(() =>
      expect(mocks.loadGeoOperations).toHaveBeenCalledTimes(2),
    );
  });

  // 在跑操作的有界轮询：回到前台立即补拉（与工作台/进度卡同款节奏）。
  it("polls while a live operation exists", async () => {
    mocks.loadGeoOperations.mockResolvedValue([runningOperation]);
    renderDocked();
    // 等停靠条渲染完成（live 已落地、轮询监听已挂载）再派发事件。
    await screen.findByRole("button", { name: "定位当前闸门卡片" });
    expect(mocks.loadGeoOperations).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(mocks.loadGeoOperations).toHaveBeenCalledTimes(2),
    );
    expect(mocks.loadGeoOperations).toHaveBeenLastCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      { limit: 10 },
      expect.any(AbortSignal),
    );
  });
});
