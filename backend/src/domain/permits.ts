import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import { AppError } from '../errors';
import { findAccountById } from './accounts';
import { frozenPointsFor, settleFrozenPoints } from './ledger';
import { isBillingOperation, OPERATION_PRICES } from './pricing';
import type { BillingPermitRow, PermitStatus, UnitOutcome } from './types';

export interface PermitApplyInput {
  permitId: string;
  operation: string;
  units: number;
  /** 客户端对账口径（票 07 起可省略）：省略时按服务端价目表定价。 */
  unitPrice?: number;
  basePrice?: number;
}

export interface PermitProjection {
  permitId: string;
  operation: string;
  units: number;
  unitPrice: number;
  basePrice: number;
  /** 本次申请的预扣总额（base + unitPrice×units）。 */
  totalPoints: number;
  status: PermitStatus;
  frozenPoints: number;
  consumedPoints: number;
  refundedPoints: number;
  unitsSucceeded: number;
  unitsFailed: number;
  unitsUnreported: number;
  createdAt: string;
  settledAt: string | null;
}

export interface PermitApplyResult {
  permit: PermitProjection;
  /** false = 幂等重放（permitId 已存在且参数一致），未产生新预扣。 */
  created: boolean;
}

function permitNotFound(): AppError {
  return new AppError('permit_not_found', 'permit 不存在。', 404);
}

function loadPermit(db: SqlClient, permitId: string): BillingPermitRow | undefined {
  return db.get<BillingPermitRow>('SELECT * FROM billing_permits WHERE id = ?', [permitId]);
}

/** 跨账号访问 permit 一律 404，不泄露 permitId 是否存在于他人账号。 */
function requireOwnedPermit(db: SqlClient, accountId: string, permitId: string): BillingPermitRow {
  const permit = loadPermit(db, permitId);
  if (!permit || permit.account_id !== accountId) throw permitNotFound();
  return permit;
}

/** 结清：状态置 settled 并清零剩余冻结（未回报单位与未结转基础费全部回补）。 */
function markPermitSettled(db: SqlClient, permitId: string, nowIso: string): void {
  db.run(
    "UPDATE billing_permits SET status = 'settled', settled_at = ?, frozen_remaining = 0 WHERE id = ?",
    [nowIso, permitId],
  );
}

function openPermitCount(db: SqlClient, accountId: string): number {
  const row = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM billing_permits WHERE account_id = ? AND status = 'open'",
    [accountId],
  );
  return row?.count ?? 0;
}

function reportCounts(db: SqlClient, permitId: string): { succeeded: number; failed: number } {
  const rows = db.all<{ outcome: UnitOutcome; count: number }>(
    'SELECT outcome, COUNT(*) AS count FROM permit_unit_reports WHERE permit_id = ? GROUP BY outcome',
    [permitId],
  );
  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.outcome === 'success') succeeded = row.count;
    else failed = row.count;
  }
  return { succeeded, failed };
}

export function permitProjection(
  db: SqlClient,
  permit: BillingPermitRow,
): PermitProjection {
  const { succeeded, failed } = reportCounts(db, permit.id);
  const reported = succeeded + failed;
  const totalPoints = permit.base_price + permit.unit_price * permit.units;
  // 结转口径：每个成功单位扣 unitPrice，基础费绑定首个成功单位（整体
  // 全失败则随回补退回，即「整体失败退全款」）；已结清 permit 的未回报
  // 单位按失败回补。三口径恒等式：consumed + refunded + frozen == total。
  const consumedPoints =
    (succeeded > 0 ? permit.base_price : 0) + permit.unit_price * succeeded;
  const refundedPoints = totalPoints - consumedPoints - permit.frozen_remaining;
  return {
    permitId: permit.id,
    operation: permit.operation,
    units: permit.units,
    unitPrice: permit.unit_price,
    basePrice: permit.base_price,
    totalPoints,
    status: permit.status,
    frozenPoints: permit.frozen_remaining,
    consumedPoints,
    refundedPoints,
    unitsSucceeded: succeeded,
    unitsFailed: failed,
    unitsUnreported: permit.units - reported,
    createdAt: permit.created_at,
    settledAt: permit.settled_at,
  };
}

/**
 * permit 申请：服务端价目校验 → 并发准入 → 余额预扣冻结。permitId 是客户端
 * 生成的幂等键——网络重试/恢复重跑重放同一申请不二次预扣；同 id 换参数是
 * 客户端 bug，拒绝而不是静默复用。
 */
export function applyForPermit(
  deps: BackendDeps,
  accountId: string,
  rawInput: PermitApplyInput,
): PermitApplyResult {
  // 定价权威在后端：省略的价目按服务端价目表补齐后再进幂等/对账比较，
  // 「省略申请」与「携带服务端价目重放」参数等价。
  const knownPrice = isBillingOperation(rawInput.operation)
    ? OPERATION_PRICES[rawInput.operation]
    : undefined;
  const input = {
    ...rawInput,
    unitPrice: rawInput.unitPrice ?? knownPrice?.perUnit,
    basePrice: rawInput.basePrice ?? knownPrice?.base,
  };
  return deps.db.transaction(() => {
    const existing = loadPermit(deps.db, input.permitId);
    if (existing) {
      if (existing.account_id !== accountId) throw permitNotFound();
      const sameParams =
        existing.operation === input.operation &&
        existing.units === input.units &&
        existing.unit_price === input.unitPrice &&
        existing.base_price === input.basePrice;
      if (!sameParams) {
        throw new AppError(
          'permit_id_conflict',
          '该 permitId 已用于不同参数的申请，请更换 permitId 重试。',
          409,
        );
      }
      return { permit: permitProjection(deps.db, existing), created: false };
    }

    if (!isBillingOperation(input.operation)) {
      throw new AppError('unknown_operation', `未知计费操作类型：${input.operation}。`, 400);
    }
    const price = OPERATION_PRICES[input.operation];
    if (input.unitPrice !== price.perUnit || input.basePrice !== price.base) {
      throw new AppError(
        'price_mismatch',
        `单价与服务端价目不符：${input.operation} 应为 ${price.base} 基础 + ${price.perUnit}/单位。`,
        400,
      );
    }

    const active = openPermitCount(deps.db, accountId);
    const limit = deps.config.maxConcurrentPermitsPerAccount;
    if (active >= limit) {
      throw new AppError(
        'concurrency_limit',
        `并发计费操作已达上限（${limit}），请等待进行中的操作完成。`,
        429,
        { limit, active },
      );
    }

    const required = price.base + price.perUnit * input.units;
    const account = findAccountById(deps.db, accountId);
    if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
    const available = account.balance - frozenPointsFor(deps.db, accountId);
    if (available < required) {
      throw new AppError(
        'insufficient_balance',
        `点数不足：本次需 ${required} 点，当前可用 ${available} 点，请充值后再试。`,
        402,
        { required, available, frozen: account.balance - available, total: account.balance },
      );
    }

    const nowIso = new Date(deps.now()).toISOString();
    deps.db.run(
      `INSERT INTO billing_permits (id, account_id, operation, units, unit_price, base_price, frozen_remaining, status, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)`,
      [input.permitId, accountId, input.operation, input.units, input.unitPrice, input.basePrice, required, nowIso],
    );
    const created = loadPermit(deps.db, input.permitId);
    if (!created) throw new AppError('internal_error', 'permit 创建后读取失败。', 500);
    return { permit: permitProjection(deps.db, created), created: true };
  });
}

/**
 * 逐最小成败单位回报：成功单位立即结转（余额扣减 + consume 流水，基础费随
 * 首个成功单位结转），失败单位立即回补冻结。同一单位重复回报幂等（结果
 * 相同视为重放，不同则拒绝）；全部单位回报完毕后 permit 自动结清。
 */
export function reportPermitUnit(
  deps: BackendDeps,
  accountId: string,
  permitId: string,
  unit: number,
  outcome: UnitOutcome,
): PermitProjection {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    const permit = requireOwnedPermit(deps.db, accountId, permitId);
    if (!Number.isInteger(unit) || unit < 0 || unit >= permit.units) {
      throw new AppError('invalid_unit', `unit 必须是 0–${permit.units - 1} 的整数。`, 400);
    }

    // 幂等优先于状态检查：最后一单位回报落库后 permit 即自动结清，
    // 若响应在网络中丢失，客户端重放同一回报必须成功而不是撞 409。
    const prior = deps.db.get<{ outcome: UnitOutcome }>(
      'SELECT outcome FROM permit_unit_reports WHERE permit_id = ? AND unit_index = ?',
      [permitId, unit],
    );
    if (prior) {
      if (prior.outcome === outcome) return permitProjection(deps.db, permit);
      throw new AppError(
        'unit_outcome_conflict',
        `单位 ${unit} 已回报为 ${prior.outcome}，不能改报 ${outcome}。`,
        409,
      );
    }
    if (permit.status !== 'open') {
      throw new AppError('permit_settled', 'permit 已结清，不能再回报单位结果。', 409);
    }

    if (outcome === 'success') {
      const { succeeded } = reportCounts(deps.db, permitId);
      const charge = permit.unit_price + (succeeded === 0 ? permit.base_price : 0);
      settleFrozenPoints(deps, accountId, charge, `${permit.operation} unit ${unit}`);
      deps.db.run('UPDATE billing_permits SET frozen_remaining = frozen_remaining - ? WHERE id = ?', [
        charge,
        permitId,
      ]);
    } else {
      deps.db.run('UPDATE billing_permits SET frozen_remaining = frozen_remaining - ? WHERE id = ?', [
        permit.unit_price,
        permitId,
      ]);
    }

    deps.db.run(
      'INSERT INTO permit_unit_reports (permit_id, unit_index, outcome, reported_at) VALUES (?, ?, ?, ?)',
      [permitId, unit, outcome, nowIso],
    );

    const reported = deps.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM permit_unit_reports WHERE permit_id = ?',
      [permitId],
    )?.count ?? 0;
    if (reported >= permit.units) markPermitSettled(deps.db, permitId, nowIso);

    const updated = loadPermit(deps.db, permitId);
    if (!updated) throw new AppError('internal_error', '回报后读取 permit 失败。', 500);
    return permitProjection(deps.db, updated);
  });
}

/**
 * 结清 permit（操作中止/收尾）：全部未回报单位视为失败，剩余冻结点数（含
 * 未结转基础费）立即回补。已结清的 permit 重放 close 幂等。余额不受影响
 * （结转已在逐单位回报时完成）。
 */
export function closePermit(
  deps: BackendDeps,
  accountId: string,
  permitId: string,
): PermitProjection {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    const permit = requireOwnedPermit(deps.db, accountId, permitId);
    if (permit.status === 'open') markPermitSettled(deps.db, permitId, nowIso);
    const updated = loadPermit(deps.db, permitId);
    if (!updated) throw new AppError('internal_error', '结清后读取 permit 失败。', 500);
    return permitProjection(deps.db, updated);
  });
}

export function getPermit(
  deps: BackendDeps,
  accountId: string,
  permitId: string,
): PermitProjection {
  const permit = requireOwnedPermit(deps.db, accountId, permitId);
  return permitProjection(deps.db, permit);
}

/** 账号当前 open 的 permit（余额端点的冻结明细）。 */
export function listOpenPermits(deps: BackendDeps, accountId: string): PermitProjection[] {
  return deps.db
    .all<BillingPermitRow>(
      "SELECT * FROM billing_permits WHERE account_id = ? AND status = 'open' ORDER BY created_at",
      [accountId],
    )
    .map(permit => permitProjection(deps.db, permit));
}
