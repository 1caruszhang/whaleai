import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import XiaojingGeoWorkbench from "./XiaojingGeoWorkbench";

vi.mock("./XiaojingGeoOperationPanel", () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <section aria-label="操作面板桩">{children}</section>
  ),
}));
vi.mock("./XiaojingBrandKnowledgePanel", () => ({
  default: () => <section aria-label="品牌知识桩" />,
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

  // 票 28：工作台只保留多操作切换器、当前已确认品牌知识与六阶段骨架；
  // 「当前品牌」卡由左侧栏表达，从工作台删除。
  it("drops the current-brand card and hosts brand knowledge inside the operation panel", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    expect(screen.queryByText("当前品牌")).not.toBeInTheDocument();
    const operationPanel = screen.getByRole("region", { name: "操作面板桩" });
    expect(
      screen.getByRole("region", { name: "品牌知识桩" }),
    ).toBeInTheDocument();
    expect(operationPanel).toContainElement(
      screen.getByRole("region", { name: "品牌知识桩" }),
    );
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
    expect(
      screen.queryByRole("region", { name: "品牌知识桩" }),
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
});
