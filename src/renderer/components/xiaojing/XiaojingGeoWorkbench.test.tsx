import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import {
  __resetColumnWidthsForTest,
  getColumnWidths,
  saveColumnWidths,
} from "@/utils/columnLayout";
import XiaojingGeoWorkbench from "./XiaojingGeoWorkbench";

vi.mock("./XiaojingGeoOperationPanel", () => ({
  default: () => <section aria-label="操作面板桩" />,
}));

const workspace: BrandWorkspace = {
  id: "brand-19",
  name: "小鲸科技",
  productLines: ["GEO 工具"],
  rootPath: "/brands/brand-19",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

const LAUNCH_CARD_TITLES = [
  "完整 GEO 优化",
  "问题机会发现",
  "生成 GEO 内容",
  "GEO 效果检测",
] as const;

describe("XiaojingGeoWorkbench", () => {
  beforeEach(() => {
    localStorage.removeItem("xiaojing:geo-workbench-collapsed");
    localStorage.removeItem("xiaojing:column-widths");
    __resetColumnWidthsForTest();
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1024,
    });
  });

  // 票 31：工作台「操作/效果」双页签移除，收为单一操作视图；效果三面板
  // 由左侧栏「效果」一级入口整页呈现。
  it("renders the single operations view without any view tabs", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    expect(
      screen.getByRole("region", { name: "操作面板桩" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "操作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "效果" })).not.toBeInTheDocument();
    expect(screen.queryByText(/基线探测按需执行/)).not.toBeInTheDocument();
  });

  // 票 28：工作台只保留多操作切换器与六阶段骨架；「当前品牌」卡由
  // 左侧栏表达，当前已确认品牌知识由骨架「品牌知识」阶段展开体承载
  // （不再在切换器与骨架之间挂独立的品牌知识面板）。
  it("drops the current-brand card and no standalone brand-knowledge panel", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    expect(screen.queryByText("当前品牌")).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "操作面板桩" }),
    ).toBeInTheDocument();
    // 票 30：历史面板移出工作台，知识版本史与产物血缘由左侧栏
    // 「品牌档案」一级入口整页呈现。
    expect(
      screen.queryByRole("region", { name: "品牌历史桩" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /品牌知识与产物历史/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps capability launch cards out of the workbench", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    expect(screen.queryByText("可启动的 GEO 能力")).not.toBeInTheDocument();
    for (const title of LAUNCH_CARD_TITLES) {
      expect(
        screen.queryByRole("button", { name: new RegExp(title) }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });

  it("guides to brand selection and chat when no workspace is active", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={null} />);

    expect(
      screen.getByText(/先在左侧选择品牌，再在聊天中发起 GEO 目标/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "操作面板桩" }),
    ).not.toBeInTheDocument();
  });

  it("expands over a persisted collapsed state when a deep link arrives", () => {
    localStorage.setItem("xiaojing:geo-workbench-collapsed", "true");

    const { rerender } = render(
      <XiaojingGeoWorkbench currentWorkspace={workspace} />,
    );
    expect(
      document.querySelector('[data-xiaojing-workbench="collapsed"]'),
    ).not.toBeNull();

    rerender(
      <XiaojingGeoWorkbench
        currentWorkspace={workspace}
        navigationTarget={{
          workspaceId: workspace.id,
          sessionId: "session-19",
          operationId: "operation-19",
          card: "publish-execution",
          artifact: { kind: "publish-execution", id: "execution-19" },
          nonce: 1,
        }}
      />,
    );

    expect(
      document.querySelector('[data-xiaojing-workbench="expanded"]'),
    ).not.toBeNull();
    expect(localStorage.getItem("xiaojing:geo-workbench-collapsed")).toBe(
      "false",
    );
  });

  it("resizes through the divider (pointer left widens) and persists the width", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1600,
    });
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);
    const handle = screen.getByRole("separator", {
      name: "调整 GEO 工作台宽度",
    });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1140 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // 工作台贴右缘：指针左移 60px = 加宽 60px。
    expect(getColumnWidths().workbench).toBe(420);
    expect(
      JSON.parse(localStorage.getItem("xiaojing:column-widths") ?? "{}")
        .workbench,
    ).toBe(420);
  });

  it("clamps the workbench to its 280-560 bounds", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1600,
    });
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);
    const handle = screen.getByRole("separator", {
      name: "调整 GEO 工作台宽度",
    });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 1200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(getColumnWidths().workbench).toBe(280);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -240 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(getColumnWidths().workbench).toBe(720);
  });

  it("double-click on the divider restores the default width", () => {
    saveColumnWidths({ workbench: 520 });
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);
    fireEvent.dblClick(
      screen.getByRole("separator", { name: "调整 GEO 工作台宽度" }),
    );
    expect(getColumnWidths().workbench).toBe(360);
  });

  it("restores the last dragged width after collapse and expand", () => {
    saveColumnWidths({ workbench: 420 });
    const { rerender } = render(
      <XiaojingGeoWorkbench currentWorkspace={workspace} />,
    );
    const expanded = () =>
      document.querySelector<HTMLElement>(
        '[data-xiaojing-workbench="expanded"]',
      );

    expect(expanded()?.style.getPropertyValue("--xiaojing-workbench-width")).toBe(
      "420px",
    );

    fireEvent.click(screen.getByRole("button", { name: "折叠 GEO 工作台" }));
    expect(
      document.querySelector('[data-xiaojing-workbench="collapsed"]'),
    ).not.toBeNull();

    rerender(<XiaojingGeoWorkbench currentWorkspace={workspace} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 GEO 工作台" }));
    expect(expanded()?.style.getPropertyValue("--xiaojing-workbench-width")).toBe(
      "420px",
    );
  });

  it("hides the drag divider while collapsed", () => {
    localStorage.setItem("xiaojing:geo-workbench-collapsed", "true");
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
