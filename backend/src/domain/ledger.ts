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
  // 账号内单调递增的落账序号：created_at 毫秒精度会同毫秒并列，seq 才是
  // 「最新在前」的全序依据。调用方都在事务里，MAX+1 发号不会被并发穿透。
  const nextSeq =
    db.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger_entries WHERE account_id = ?',
      [account.id],
    )?.next ?? 1;
  db.run(
    'INSERT INTO ledger_entries (id, account_id, seq, delta, balance_after, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [randomUUID(), account.id, nextSeq, delta, balanceAfter, kind, note, nowIso],
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
  // 最新在前：seq 为账号内插入序号（见 applyBalanceChange），倒排即严格的
  // 逆落账顺序——created_at 同毫秒并列时也保持全序；时间戳只作展示字段。
  return db.all<LedgerEntryRow>(
    'SELECT id, account_id, delta, balance_after, kind, note, created_at FROM ledger_entries WHERE account_id = ? ORDER BY seq DESC LIMIT ?',
    [accountId, limit],
  );
}
