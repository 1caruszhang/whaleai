import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { AccountRow, LedgerEntryRow } from './types';
import { AppError } from '../errors';

export type LedgerKind = 'grant' | 'topup' | 'adjust' | 'consume';

export function insertLedgerEntry(
  db: SqlClient,
  input: { id: string; accountId: string; delta: number; balanceAfter: number; kind: LedgerKind; note: string; createdAt: string },
): void {
  db.run(
    'INSERT INTO ledger_entries (id, account_id, delta, balance_after, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [input.id, input.accountId, input.delta, input.balanceAfter, input.kind, input.note, input.createdAt],
  );
}

function loadAccount(db: SqlClient, accountId: string): AccountRow {
  const account = db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  return account;
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
 * 账本唯一入账通道：改 balance 与写流水必须成对出现在同一事务。负向变动
 * 只能动用未冻结余额（available），冻结中的点数只归 permit 结转/回补管。
 */
export function applyAccountLedgerDelta(
  deps: BackendDeps,
  accountId: string,
  delta: number,
  kind: LedgerKind,
  note: string,
): AccountRow {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    const account = loadAccount(deps.db, accountId);
    if (delta < 0) {
      const snapshot = balanceSnapshot(deps.db, account);
      if (snapshot.available + delta < 0) {
        throw new AppError('insufficient_balance', '可用点数不足，不能动用冻结中的点数。', 409);
      }
    }
    const balanceAfter = account.balance + delta;
    deps.db.run('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?', [balanceAfter, nowIso, accountId]);
    insertLedgerEntry(deps.db, {
      id: randomUUID(),
      accountId,
      delta,
      balanceAfter,
      kind,
      note,
      createdAt: nowIso,
    });
    const updated = loadAccount(deps.db, accountId);
    return updated;
  });
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
