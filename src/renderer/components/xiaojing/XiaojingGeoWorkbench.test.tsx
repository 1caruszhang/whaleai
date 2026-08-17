import { fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("./XiaojingBrandHistoryPanel", () => ({
  default: () => <section aria-label="品牌历史桩" />,
}));
vi.mock("./XiaojingGeoEffectPanel", () => ({
  default: (props: { workspaceId: string }) => (
    <section aria-label="效果入口桩" data-workspace={props.workspaceId} />
  ),
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

  it("defaults to the operations view and hides the effects entry", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    expect(
      screen.getByRole("region", { name: "操作面板桩" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "效果入口桩" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "操作" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "效果" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
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
    // 品牌历史面板留在工作台（票 30 迁往品牌档案整页）。
    expect(
      screen.getByRole("region", { name: "品牌历史桩" }),
    ).toBeInTheDocument();
  });

  it("keeps capability launch cards out of the workbench in both views", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    expect(screen.queryByText("可启动的 GEO 能力")).not.toBeInTheDocument();
    for (const title of LAUNCH_CARD_TITLES) {
      expect(
        screen.queryByRole("button", { name: new RegExp(title) }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("tab", { name: "效果" }));
    for (const title of LAUNCH_CARD_TITLES) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });

  it("switches to the brand-level effects entry and back", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={workspace} />);

    fireEvent.click(screen.getByRole("tab", { name: "效果" }));
    const entry = screen.getByRole("region", { name: "效果入口桩" });
    expect(entry).toHaveAttribute("data-workspace", "brand-19");
    expect(
      screen.queryByRole("region", { name: "操作面板桩" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "操作" }));
    expect(
      screen.getByRole("region", { name: "操作面板桩" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "效果入口桩" }),
    ).not.toBeInTheDocument();
  });

  it("explains the effects entry needs a selected brand", () => {
    render(<XiaojingGeoWorkbench currentWorkspace={null} />);

    fireEvent.click(screen.getByRole("tab", { name: "效果" }));
    expect(
      screen.getByText(/先在左侧选择品牌，即可按需执行基线探测/),
    ).toBeInTheDocument();
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
