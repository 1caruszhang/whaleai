import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { AccountRow, LedgerEntryRow } from './types';
import { AppError } from '../errors';

export type LedgerKind = 'grant' | 'topup' | 'adjust' | 'consume';

/**
 * 账本唯一入账通道：改 balance 与写流水成对出现在同一事务。两条对外的
 * 入账路径都收口到这里——applyAccountLedgerDelta（充值/调点，走可用余额）
 * 与 settleFrozenPoints（permit 成功单位结转，动用冻结）。
 */
function applyBalanceChange(
  db: SqlClient,
  account: AccountRow,
  delta: number,
  kind: LedgerKind,
  note: string,
  nowIso: string,
): AccountRow {
  const balanceAfter = account.balance + delta;
  db.run('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?', [balanceAfter, nowIso, account.id]);
  db.run(
    'INSERT INTO ledger_entries (id, account_id, delta, balance_after, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [randomUUID(), account.id, delta, balanceAfter, kind, note, nowIso],
  );
  const updated = db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [account.id]);
  if (!updated) throw new AppError('internal_error', '入账后读不到账号行。', 500);
  return updated;
}

/** 账号当前被 open permit 冻结的点数总和。 */
export function frozenPointsFor(db: SqlClient, accountId: string): number {
  const row = db.get<{ frozen: number }>(
    "SELECT COALESCE(SUM(frozen_remaining), 0) AS frozen FROM billing_permits WHERE account_id = ? AND status = 'open'",
    [accountId],
  );
  return row?.frozen ?? 0;
}

/**
 * 余额三口径：total 为账面余额（含冻结），available 为可立即用于新 permit
 * 预扣的部分。不变量：total = available + frozen，任何路径都不得打破。
 */
export function balanceSnapshot(db: SqlClient, account: AccountRow) {
  const frozen = frozenPointsFor(db, account.id);
  return { total: account.balance, frozen, available: account.balance - frozen };
}

/**
 * 充值/调点/赠送入账：正负皆可，但负向只能动用未冻结余额（冻结中的点数只
 * 归 permit 结转/回补管）。note 落流水（调点必须带备注，由路由层 schema 强制）。
 */
export function applyAccountLedgerDelta(
  deps: BackendDeps,
  accountId: string,
  delta: number,
  kind: 'grant' | 'topup' | 'adjust',
  note: string,
): AccountRow {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    const account = deps.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId]);
    if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
    if (delta < 0 && balanceSnapshot(deps.db, account).available + delta < 0) {
      throw new AppError('insufficient_balance', '可用点数不足，不能动用冻结中的点数。', 409);
    }
    return applyBalanceChange(deps.db, account, delta, kind, note, nowIso);
  });
}

/** permit 成功单位结转：点数已在冻结中，直接从账面划走并落 consume 流水。 */
export function settleFrozenPoints(
  deps: BackendDeps,
  accountId: string,
  charge: number,
  note: string,
): void {
  const nowIso = new Date(deps.now()).toISOString();
  const account = deps.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  applyBalanceChange(deps.db, account, -charge, 'consume', note, nowIso);
}

export function listLedgerEntries(
  db: SqlClient,
  accountId: string,
  limit: number,
): LedgerEntryRow[] {
  // balance_after 作同毫秒平手裁决：单账号每笔 delta 非零，balance_after
  // 沿插入链严格单调，比随机 id 稳定（同毫秒多笔时仍按真实落账顺序）。
  return db.all<LedgerEntryRow>(
    'SELECT id, account_id, delta, balance_after, kind, note, created_at FROM ledger_entries WHERE account_id = ? ORDER BY created_at DESC, balance_after DESC LIMIT ?',
    [accountId, limit],
  );
}
