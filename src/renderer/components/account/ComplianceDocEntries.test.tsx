import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AccountState } from "@/api/accountClient";
import AccountPanelDialog from "./AccountPanelDialog";
import { LoginScreen } from "./LoginGate";
import {
  AccountApiContext,
  AccountStateContext,
  type AccountApiContextValue,
} from "@/context/AccountContext";
import { renderWithTheme } from "@/test/renderWithTheme";

/**
 * 票 11 验收项 1：首登勾选处的链接可打开三份合规文件全文；
 * 以及设置页（个人信息）入口同样可达全文。全文以 markdown 渲染，
 * 断言取文档首尾的内容锚点，证明整份文件（而非摘要）可达。
 */

function makeAccountApi(
  overrides: Partial<AccountApiContextValue> = {},
): AccountApiContextValue {
  return {
    login: vi.fn(async () => null),
    changePassword: vi.fn(async () => null),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => null),
    requireBalance: vi.fn(() => true),
    dismissInsufficientBalance: vi.fn(),
    ...overrides,
  };
}

function renderLogin() {
  renderWithTheme(
    <AccountApiContext.Provider value={makeAccountApi()}>
      <LoginScreen graceExpired={false} agreementAccepted={false} />
    </AccountApiContext.Provider>,
  );
}

function renderAccountPanel() {
  const state: AccountState = {
    loggedIn: true,
    phone: "13800001234",
    points: 500,
    status: "active",
    mustChangePassword: false,
    agreementAccepted: true,
    offlineGrace: { within: true, lastServerContactAt: null, deadlineAt: null },
  };
  renderWithTheme(
    <AccountStateContext.Provider value={state}>
      <AccountApiContext.Provider value={makeAccountApi()}>
        <AccountPanelDialog onClose={() => {}} />
      </AccountApiContext.Provider>
    </AccountStateContext.Provider>,
  );
}

describe("首登勾选处的合规文件链接（票 11）", () => {
  it("勾选行提供《用户协议》《隐私政策》《计费标准》三个链接", () => {
    renderLogin();
    expect(screen.getByRole("button", { name: "《用户协议》" })).toBeDefined();
    expect(screen.getByRole("button", { name: "《隐私政策》" })).toBeDefined();
    expect(screen.getByRole("button", { name: "《计费标准》" })).toBeDefined();
  });

  it("点击《用户协议》打开全文查看器（正式版定稿，全文可达）", async () => {
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "《用户协议》" }));
    const viewer = await screen.findByRole("dialog", {
      name: "用户协议（2026 年正式版）",
    });
    // 文首：服务提供方主体；文末：签署栏 → 整份文档已渲染。
    expect(viewer).toHaveTextContent("四川鲸杉人工智能科技有限公司");
    expect(viewer).toHaveTextContent("乙方（服务接受方）");
    // 正式版不携带修订记录与草稿标注。
    expect(viewer).not.toHaveTextContent("修订记录");
    expect(viewer).not.toHaveTextContent("本条为修订");
  });

  it("点击《计费标准》打开全文，价目表首末行均在（公示文件内联渲染）", async () => {
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "《计费标准》" }));
    const viewer = await screen.findByRole("dialog", { name: "计费标准" });
    expect(viewer).toHaveTextContent("1 元人民币 = 10 点");
    // 表格首行与末行操作（全文表格完整渲染）。
    expect(viewer).toHaveTextContent("material_import");
    expect(viewer).toHaveTextContent("monitoring_patrol");
    // 文末：收款账户信息。
    expect(viewer).toHaveTextContent("22836101040020857");
  });

  it("点击《隐私政策》打开全文，覆盖存储位置与注销删除要点", async () => {
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "《隐私政策》" }));
    const viewer = await screen.findByRole("dialog", { name: "隐私政策" });
    expect(viewer).toHaveTextContent("运营服务器");
    expect(viewer).toHaveTextContent("注销账号");
    expect(viewer).toHaveTextContent("删除服务器侧");
  });

  it("点链接不改变勾选状态，关闭查看器后可继续登录流程", async () => {
    renderLogin();
    fireEvent.click(screen.getByRole("button", { name: "《用户协议》" }));
    await screen.findByRole("dialog", {
      name: "用户协议（2026 年正式版）",
    });
    // 勾选框未被链接点击误触发：提交按钮仍禁用。
    expect(screen.getByRole("button", { name: "登 录" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(
      screen.queryByRole("dialog", { name: "用户协议（2026 年正式版）" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "登 录" })).toBeDisabled();
  });
});

describe("设置页（个人信息）的合规文件入口（票 11）", () => {
  it("「合规文件」区块列出三份文件", () => {
    renderAccountPanel();
    expect(screen.getByText("合规文件")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /用户协议（2026 年正式版）/ }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "隐私政策" })).toBeDefined();
    expect(screen.getByRole("button", { name: "计费标准" })).toBeDefined();
  });

  it("点击隐私政策入口打开全文查看器", async () => {
    renderAccountPanel();
    fireEvent.click(screen.getByRole("button", { name: "隐私政策" }));
    const viewer = await screen.findByRole("dialog", { name: "隐私政策" });
    expect(viewer).toHaveTextContent("数据存储位置总览");
    expect(viewer).toHaveTextContent("由您自行删除");
    // 面板自带「关闭」，查看器也有——限定在查看器内点击其关闭按钮。
    fireEvent.click(within(viewer).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "隐私政策" })).toBeNull();
  });
});
