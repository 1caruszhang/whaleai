import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { AccountRow, LedgerEntryRow } from './types';
import { AppError } from '../errors';

export type LedgerKind = 'grant' | 'topup' | 'adjust' | 'consume' | 'refund';

/**
 * 账本唯一入账通道：改 balance 与写流水成对出现在同一事务。对外的入账
 * 路径都收口到这里——applyAccountLedgerDelta（充值/调点，走可用余额）、
 * settleFrozenPoints（permit 成功单位 / 发布订单结转，动用冻结）与
 * refundSettledPoints（发布订单结转后退款，refund 正流水）。
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

/**
 * 账号当前被 open permit 冻结的点数总和（票 08 起含发布订单冻结：ledger_status
 * = 'frozen' 的订单预扣与 permit 预扣同属冻结口径，total = available + frozen
 * 不变量同时覆盖两条冻结通道）。
 */
export function frozenPointsFor(db: SqlClient, accountId: string): number {
  const permitFrozen =
    db.get<{ frozen: number }>(
      "SELECT COALESCE(SUM(frozen_remaining), 0) AS frozen FROM billing_permits WHERE account_id = ? AND status = 'open'",
      [accountId],
    )?.frozen ?? 0;
  const orderFrozen =
    db.get<{ frozen: number }>(
      "SELECT COALESCE(SUM(points), 0) AS frozen FROM publish_orders WHERE account_id = ? AND ledger_status = 'frozen'",
      [accountId],
    )?.frozen ?? 0;
  return permitFrozen + orderFrozen;
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
 * 任意档位充值（topup）同时刷新对话隐藏额度（票 04：旁路计量累计清零，
 * 被暂停的对话立即恢复）；grant/adjust 不刷新——只有真充值刷新。
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
    const updated = applyBalanceChange(deps.db, account, delta, kind, note, nowIso);
    if (kind === 'topup') {
      deps.db.run('UPDATE accounts SET chat_quota_used_milli = 0 WHERE id = ?', [accountId]);
    }
    return updated;
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

/**
 * 已结转发布订单退款（票 08）：订单先结转（发布中/已发布）后上游转
 * 已退款/已取消/已拒稿时，以 refund 正流水原路回补，Σdelta == balance
 * 不变量保持（consume 负流水与 refund 正流水成对，净额为零）。
 * 冻结中订单的回补不走这里——冻结释放不动账面余额，也无流水。
 */
export function refundSettledPoints(
  deps: BackendDeps,
  accountId: string,
  points: number,
  note: string,
): void {
  const nowIso = new Date(deps.now()).toISOString();
  const account = deps.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  applyBalanceChange(deps.db, account, points, 'refund', note, nowIso);
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
