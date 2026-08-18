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

/** 点数流水。delta 正为入账（赠送/充值/回补）、负为扣减；balance_after 为该笔落账后余额。 */
export interface LedgerEntryRow {
  id: string;
  account_id: string;
  delta: number;
  balance_after: number;
  kind: string;
  note: string;
  created_at: string;
}
