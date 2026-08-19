/**
 * 账号态 Rust 命令客户端（票 06）。
 *
 * token 本体永远留在 Rust（OS 凭据库）；renderer 只拿登录态/余额投影。
 * 非 Tauri 浏览器开发态沿用 ensureSessionSidecar 的 dev-harness 先例：
 * 返回已登录的固定投影，让工作台在浏览器里可用。
 */
import { invoke } from '@tauri-apps/api/core';

import { isTauriEnvironment } from '@/utils/browserMock';

export interface AccountOfflineGrace {
  within: boolean;
  lastServerContactAt: number | null;
  deadlineAt: number | null;
}

export interface AccountState {
  loggedIn: boolean;
  phone: string | null;
  points: number | null;
  status: string | null;
  mustChangePassword: boolean;
  agreementAccepted: boolean;
  offlineGrace: AccountOfflineGrace;
}

const BROWSER_DEV_ACCOUNT_STATE: AccountState = {
  loggedIn: true,
  phone: '13800000000',
  points: 500,
  status: 'active',
  mustChangePassword: false,
  agreementAccepted: true,
  offlineGrace: {
    within: true,
    lastServerContactAt: Math.floor(Date.now() / 1000),
    deadlineAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  },
};

export async function fetchAccountState(): Promise<AccountState> {
  if (!isTauriEnvironment()) return BROWSER_DEV_ACCOUNT_STATE;
  return invoke<AccountState>('cmd_account_state');
}

/** 登录失败 reject 携带 Rust 侧映射好的用户可读错误文本。 */
export async function accountLogin(
  phone: string,
  password: string,
  acceptedAgreement: boolean,
): Promise<AccountState> {
  return invoke<AccountState>('cmd_account_login', { phone, password, acceptedAgreement });
}

/** 首登强制改密 / 主动改密。成功返回新的已登录投影。 */
export async function accountChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<AccountState> {
  return invoke<AccountState>('cmd_account_change_password', { currentPassword, newPassword });
}

/** 刷新余额与登录态锚点（GET /auth/me；必要时走 refresh 轮换）。 */
export async function accountRefresh(): Promise<AccountState> {
  return invoke<AccountState>('cmd_account_refresh');
}

/** 点数明细的一条流水（Rust cmd_account_ledger 投影；summary 已由后端归一为中文）。 */
export interface AccountLedgerEntry {
  id: string;
  delta: number;
  balanceAfter: number;
  kind: 'grant' | 'topup' | 'adjust' | 'consume' | 'refund';
  summary: string;
  createdAt: string;
}

const BROWSER_DEV_LEDGER_ENTRIES: AccountLedgerEntry[] = [
  {
    id: 'dev-ledger-2',
    delta: -20,
    balanceAfter: 480,
    kind: 'consume',
    summary: '材料导入',
    createdAt: '2026-08-19T02:30:00.000Z',
  },
  {
    id: 'dev-ledger-1',
    delta: 500,
    balanceAfter: 500,
    kind: 'grant',
    summary: '开通赠送',
    createdAt: '2026-08-18T09:00:00.000Z',
  },
];

/** 拉取最近 50 笔点数流水（在线命令；离线或未登录时 reject 用户可读错误）。 */
export async function fetchAccountLedger(): Promise<AccountLedgerEntry[]> {
  if (!isTauriEnvironment()) return BROWSER_DEV_LEDGER_ENTRIES;
  return invoke<AccountLedgerEntry[]>('cmd_account_ledger');
}

export async function accountLogout(): Promise<AccountState> {
  return invoke<AccountState>('cmd_account_logout');
}
