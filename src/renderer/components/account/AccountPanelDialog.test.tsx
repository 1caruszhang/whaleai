import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountLedgerEntry, AccountState } from "@/api/accountClient";
import { fetchAccountLedger } from "@/api/accountClient";
import AccountPanelDialog from "./AccountPanelDialog";
import {
  AccountApiContext,
  AccountStateContext,
  type AccountApiContextValue,
} from "@/context/AccountContext";
import { renderWithTheme } from "@/test/renderWithTheme";

/**
 * 个人信息弹窗的点数明细入口：点数行旁「明细」按钮展开最近 50 笔流水；
 * 字段 = 类型标签 + 摘要 + 时间 + 变动（+/-）+ 变动后余额；加载失败给
 * 用户可读错误并可重试。fetchAccountLedger 走模块 mock，不进 Tauri。
 */

vi.mock("@/api/accountClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/accountClient")>();
  return { ...actual, fetchAccountLedger: vi.fn() };
});

const fetchAccountLedgerMock = vi.mocked(fetchAccountLedger);

const SAMPLE_ENTRIES: AccountLedgerEntry[] = [
  {
    id: "entry-3",
    delta: -20,
    balanceAfter: 2480,
    kind: "consume",
    summary: "材料导入",
    createdAt: "2026-08-19T02:30:00.000Z",
  },
  {
    id: "entry-2",
    delta: 2000,
    balanceAfter: 2500,
    kind: "topup",
    summary: "对公转账 ¥200（2026-08-19）",
    createdAt: "2026-08-19T01:00:00.000Z",
  },
  {
    id: "entry-1",
    delta: 500,
    balanceAfter: 500,
    kind: "grant",
    summary: "开通赠送",
    createdAt: "2026-08-18T09:00:00.000Z",
  },
];

function makeAccountApi(): AccountApiContextValue {
  return {
    login: vi.fn(async () => null),
    changePassword: vi.fn(async () => null),
    logout: vi.fn(async () => undefined),
    refresh: vi.fn(async () => null),
    requireBalance: vi.fn(() => true),
    dismissInsufficientBalance: vi.fn(),
  };
}

function renderPanel() {
  const state: AccountState = {
    loggedIn: true,
    phone: "13800001234",
    points: 2480,
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

describe("个人信息弹窗的点数明细", () => {
  beforeEach(() => {
    fetchAccountLedgerMock.mockReset();
  });

  it("点击「明细」展开流水：类型、摘要、变动与变动后余额齐全", async () => {
    fetchAccountLedgerMock.mockResolvedValue(SAMPLE_ENTRIES);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "明细" }));
    expect(fetchAccountLedgerMock).toHaveBeenCalledTimes(1);

    expect(await screen.findByText("点数明细（最近 50 笔）")).toBeDefined();
    // 类型标签与摘要。
    expect(screen.getByText("消耗")).toBeDefined();
    expect(screen.getByText("材料导入")).toBeDefined();
    expect(screen.getByText("充值")).toBeDefined();
    expect(screen.getByText("对公转账 ¥200（2026-08-19）")).toBeDefined();
    expect(screen.getByText("赠送")).toBeDefined();
    // 变动（带符号）与变动后余额。
    expect(screen.getByText("-20")).toBeDefined();
    expect(screen.getByText("+2000")).toBeDefined();
    expect(screen.getByText("余 2480")).toBeDefined();
  });

  it("收起后重开不重复拉取（沿用已载结果）", async () => {
    fetchAccountLedgerMock.mockResolvedValue(SAMPLE_ENTRIES);
    renderPanel();

    const toggle = screen.getByRole("button", { name: "明细" });
    fireEvent.click(toggle);
    await screen.findByText("材料导入");
    fireEvent.click(toggle);
    expect(screen.queryByText("材料导入")).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText("材料导入")).toBeDefined();
    expect(fetchAccountLedgerMock).toHaveBeenCalledTimes(1);
  });

  it("加载失败显示可读错误，重试后恢复", async () => {
    fetchAccountLedgerMock.mockRejectedValueOnce("无法连接服务器，请检查网络后重试");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "明细" }));
    expect(
      await screen.findByText("无法连接服务器，请检查网络后重试"),
    ).toBeDefined();

    fetchAccountLedgerMock.mockResolvedValueOnce(SAMPLE_ENTRIES);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("材料导入")).toBeDefined();
    expect(fetchAccountLedgerMock).toHaveBeenCalledTimes(2);
  });

  it("空流水显示占位文案", async () => {
    fetchAccountLedgerMock.mockResolvedValue([]);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "明细" }));
    expect(await screen.findByText("暂无流水记录")).toBeDefined();
  });
});
