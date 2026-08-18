export type AccountStatus = 'active' | 'disabled';

/** accounts 表行。布尔列用 0/1。 */
export interface AccountRow {
  id: string;
  phone: string;
  password_hash: string;
  password_version: number;
  status: AccountStatus;
  must_change_password: number;
  balance: number;
  created_at: string;
  updated_at: string;
  /** 对话隐藏额度累计（千分之一点，票 04）；topup 入账时清零。 */
  chat_quota_used_milli: number;
}

export interface AuthSessionRow {
  id: string;
  account_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface RefreshTokenRow {
  id: string;
  session_id: string;
  token_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  replaced_by: string | null;
  revoked_at: string | null;
}

/** 点数流水。delta 正为入账（赠送/充值）、负为扣减（消费/调减）；balance_after 为该笔落账后余额。 */
export interface LedgerEntryRow {
  id: string;
  account_id: string;
  delta: number;
  balance_after: number;
  kind: string;
  note: string;
  created_at: string;
}

export type PermitStatus = 'open' | 'settled';

export type UnitOutcome = 'success' | 'failure';

/**
 * 计费 permit：一次计费操作的预扣凭证。id 为客户端生成的幂等键；
 * frozen_remaining 为尚未结转/回补的冻结点数（初始 = base + perUnit×units，
 * 随逐单位回报递减）；status=open 计入账号并发准入。
 */
export interface BillingPermitRow {
  id: string;
  account_id: string;
  operation: string;
  units: number;
  unit_price: number;
  base_price: number;
  frozen_remaining: number;
  status: PermitStatus;
  created_at: string;
  settled_at: string | null;
}

export interface PermitUnitReportRow {
  permit_id: string;
  unit_index: number;
  outcome: UnitOutcome;
  reported_at: string;
}

/**
 * 对话旁路计量记录（票 04）：网关每次 /v1/messages 调用的真实 token 用量
 * 与折点（千分之一点）。只作运营与 DeepSeek 账单对账，不改点数余额。
 */
export interface ChatUsageRecordRow {
  id: string;
  account_id: string;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  points_milli: number;
  created_at: string;
}
