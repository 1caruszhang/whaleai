import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import { AppError } from '../errors';
import { findAccountById } from './accounts';
import { frozenPointsFor, refundSettledPoints, settleFrozenPoints } from './ledger';
import type {
  PublishOrderKind,
  PublishOrderLedgerStatus,
  PublishOrderPlacementStatus,
  PublishOrderRow,
} from './types';

/**
 * 发布订单域（票 08）：订单状态机与账本的 owner。sn 是客户端生成的
 * 代理商订单号幂等键（与上游同键）：重放同参数申请不二次预扣、不重复
 * 下单；同 sn 换参数是客户端 bug，拒绝（与 permit 通道同一纪律）。
 *
 * 账本语义（状态机驱动，均幂等可重放）：
 * - 预扣：下单冻结 points（计入 frozenPointsFor 的冻结口径，不动流水）；
 * - 结转：进入「发布中(3)」（及后续 4/8/10/11/12）从冻结划走并落 consume
 *   负流水；
 * - 原路退点：已拒稿(2)/已取消(5)/已退款(7)——冻结中直接释放冻结（不动
 *   流水），已结转则落 refund 正流水回补；
 * - 保持冻结：待处理(1)/退款中(6)；
 * - 已关闭(9)：资金语义上线后核实，维持原 ledger_status 并落
 *   closed_observed_at 观察标记。
 *
 * Σdelta == balance 不变量：冻结/释放不动 balance；结转与退款各落一条
 * 等额反号流水，净额为零。
 */

/** 进入结转的上游状态：发布中(3)、已发布(4)、退款被拒(8，费用成立)、补发/收录(10/11/12)。 */
const SETTLE_STATUSES = new Set([3, 4, 8, 10, 11, 12]);
/** 原路退点的上游状态：已拒稿(2)、已取消(5)、已退款(7)。 */
const REFUND_STATUSES = new Set([2, 5, 7]);

export interface PublishOrderProjection {
  sn: string;
  executionId: string;
  itemId: string;
  kind: PublishOrderKind;
  resourceId: number;
  title: string;
  contentUrl: string;
  mediaPriceCents: number;
  points: number;
  perArticleMaxPoints: number;
  executionMaxPoints: number;
  placementStatus: PublishOrderPlacementStatus;
  ledgerStatus: PublishOrderLedgerStatus;
  partnerSn: string | null;
  status: number | null;
  url: string | null;
  publishedAt: string | null;
  closedObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlacePublishOrderInput {
  sn: string;
  executionId: string;
  itemId: string;
  kind: PublishOrderKind;
  resourceId: number;
  title: string;
  contentUrl: string;
  remark?: string;
  owner?: string;
  publishForm?: number;
  publishType?: number;
  accountRule?: number;
  /** 上游权威媒介价（分），由调用方经资源快照缓存解析。 */
  mediaPriceCents: number;
  /** 已确认分发计划冻结的单篇与单次点数上限。 */
  perArticleMaxPoints: number;
  executionMaxPoints: number;
}

export type PlacePublishOrderPhase =
  /** 本次新建订单行并完成冻结，调用方应立即下单上游。 */
  | 'created'
  /** 既有失败订单重试：重新冻结并复位 pending，调用方应再次下单上游。 */
  | 'retry'
  /** 幂等命中：上游已受理（partner_sn 在档），不再触上游、不二次扣。 */
  | 'replay_placed'
  /** 幂等命中：冻结中、上游结果未回（在途窗口/响应丢失），先返回现状。 */
  | 'replay_pending';

export interface PlacePublishOrderBegin {
  order: PublishOrderRow;
  phase: PlacePublishOrderPhase;
}

export function publishOrderProjection(row: PublishOrderRow): PublishOrderProjection {
  return {
    sn: row.sn,
    executionId: row.execution_id,
    itemId: row.item_id,
    kind: row.kind,
    resourceId: row.resource_id,
    title: row.title,
    contentUrl: row.content_url,
    mediaPriceCents: row.media_price_cents,
    points: row.points,
    perArticleMaxPoints: row.per_article_max_points,
    executionMaxPoints: row.execution_max_points,
    placementStatus: row.placement_status,
    ledgerStatus: row.ledger_status,
    partnerSn: row.partner_sn,
    status: row.upstream_status,
    url: row.url,
    publishedAt: row.published_at,
    closedObservedAt: row.closed_observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 订单点数：媒介费 × 1.6（含 60% 服务费）× 10（1 元 = 10 点锚点）→ 向上
 * 取整。以分为基的整数运算：ceil(分 × 1.6 × 10 / 100) = ceil(分 × 4 / 25)。
 * 例：¥88.00 → 1408 点；¥12.34 → 198 点。公式契约（参数＋用例向量）的
 * 裁判文件是 src/shared/geo/pointsContract.json，pin 测试在
 * backend/tests/points-contract-pin.test.ts（测试侧 import，运行时零耦合；
 * 票 #39，ADR-0012）。
 */
export function publishOrderPoints(mediaPriceCents: number): number {
  return Math.ceil((mediaPriceCents * 4) / 25);
}

export function findPublishOrderBySn(db: SqlClient, sn: string): PublishOrderRow | undefined {
  return db.get<PublishOrderRow>('SELECT * FROM publish_orders WHERE sn = ?', [sn]);
}

/** 运营对账视图（票 10）：账号全部发布订单，最新在前（展示用途平序）。 */
export function listPublishOrdersForAccount(
  db: SqlClient,
  accountId: string,
  limit: number,
): PublishOrderRow[] {
  return db.all<PublishOrderRow>(
    'SELECT * FROM publish_orders WHERE account_id = ? ORDER BY created_at DESC, sn DESC LIMIT ?',
    [accountId, limit],
  );
}

/** 跨账号访问订单一律 404，不泄露 sn 是否存在于他人账号。 */
export function requireOwnedPublishOrder(
  db: SqlClient,
  accountId: string,
  sn: string,
  kind: PublishOrderKind,
): PublishOrderRow {
  const order = findPublishOrderBySn(db, sn);
  if (!order || order.account_id !== accountId || order.kind !== kind) {
    throw orderNotFound();
  }
  return order;
}

export function orderNotFound(): AppError {
  return new AppError('order_not_found', '订单不存在。', 404);
}

function loadAccount(deps: BackendDeps, accountId: string) {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  return account;
}

function assertWithinSpendLimits(
  deps: BackendDeps,
  accountId: string,
  input: PlacePublishOrderInput,
  points: number,
): void {
  if (points > input.perArticleMaxPoints) {
    throw new AppError(
      'publish_order_per_article_limit_exceeded',
      `渠道最新价格需 ${points} 点，超过本篇上限 ${input.perArticleMaxPoints} 点。`,
      409,
      { required: points, limit: input.perArticleMaxPoints },
    );
  }
  const row = deps.db.get<{
    points: number;
    orders: number;
    min_per_article_limit: number | null;
    max_per_article_limit: number | null;
    min_execution_limit: number | null;
    max_execution_limit: number | null;
  }>(
    `SELECT COALESCE(SUM(CASE WHEN ledger_status IN ('frozen', 'settled') THEN points ELSE 0 END), 0) AS points,
            COUNT(*) AS orders,
            MIN(per_article_max_points) AS min_per_article_limit,
            MAX(per_article_max_points) AS max_per_article_limit,
            MIN(execution_max_points) AS min_execution_limit,
            MAX(execution_max_points) AS max_execution_limit
       FROM publish_orders
      WHERE account_id = ? AND execution_id = ? AND sn <> ?`,
    [accountId, input.executionId, input.sn],
  );
  if (
    row &&
    row.orders > 0 &&
    (row.min_per_article_limit !== input.perArticleMaxPoints ||
      row.max_per_article_limit !== input.perArticleMaxPoints ||
      row.min_execution_limit !== input.executionMaxPoints ||
      row.max_execution_limit !== input.executionMaxPoints)
  ) {
    throw new AppError(
      'publish_order_execution_limits_conflict',
      '同一次分发的冻结点数上限不一致，已拒绝下单。',
      409,
    );
  }
  const committed = row?.points ?? 0;
  if (committed + points > input.executionMaxPoints) {
    throw new AppError(
      'publish_order_execution_limit_exceeded',
      `本次分发累计需 ${committed + points} 点，超过总上限 ${input.executionMaxPoints} 点。`,
      409,
      { required: committed + points, committed, limit: input.executionMaxPoints },
    );
  }
}

/**
 * 下单第一步（事务）：幂等解析 + 预扣冻结。上游调用由路由层在其后执行；
 * 失败走 failPublishOrder 释放冻结（placement=failed，可重试），成功走
 * completePublishOrder（placement=placed）。
 */
export function beginPublishOrder(
  deps: BackendDeps,
  accountId: string,
  input: PlacePublishOrderInput,
): PlacePublishOrderBegin {
  return deps.db.transaction(() => {
    const existing = findPublishOrderBySn(deps.db, input.sn);
    if (existing) {
      if (existing.account_id !== accountId) throw orderNotFound();
      const sameParams =
        existing.execution_id === input.executionId &&
        existing.item_id === input.itemId &&
        existing.kind === input.kind &&
        existing.resource_id === input.resourceId &&
        existing.title === input.title &&
        existing.content_url === input.contentUrl &&
        (existing.remark ?? '') === (input.remark ?? '') &&
        (existing.owner ?? '') === (input.owner ?? '') &&
        existing.publish_form === (input.publishForm ?? null) &&
        existing.publish_type === (input.publishType ?? null) &&
        existing.account_rule === (input.accountRule ?? null) &&
        existing.per_article_max_points === input.perArticleMaxPoints &&
        existing.execution_max_points === input.executionMaxPoints;
      if (!sameParams) {
        throw new AppError(
          'sn_conflict',
          '该 sn 已用于不同参数的订单，请更换 sn 重试。',
          409,
        );
      }
      if (existing.placement_status === 'placed') {
        return { order: existing, phase: 'replay_placed' as const };
      }
      if (existing.placement_status === 'pending') {
        return { order: existing, phase: 'replay_pending' as const };
      }
      // failed：冻结已在失败路径释放，重新冻结后重试下单。
      const points = publishOrderPoints(input.mediaPriceCents);
      assertWithinSpendLimits(deps, accountId, input, points);
      const account = loadAccount(deps, accountId);
      const available = account.balance - frozenPointsFor(deps.db, accountId);
      if (available < points) throw insufficientBalance(points, available, account.balance);
      const nowIso = new Date(deps.now()).toISOString();
      deps.db.run(
        "UPDATE publish_orders SET media_price_cents = ?, points = ?, ledger_status = 'frozen', placement_status = 'pending', updated_at = ? WHERE sn = ?",
        [input.mediaPriceCents, points, nowIso, input.sn],
      );
      const retried = findPublishOrderBySn(deps.db, input.sn);
      if (!retried) throw new AppError('internal_error', '订单重试更新后读取失败。', 500);
      return { order: retried, phase: 'retry' as const };
    }

    const points = publishOrderPoints(input.mediaPriceCents);
    assertWithinSpendLimits(deps, accountId, input, points);
    const account = loadAccount(deps, accountId);
    const available = account.balance - frozenPointsFor(deps.db, accountId);
    if (available < points) throw insufficientBalance(points, available, account.balance);

    const nowIso = new Date(deps.now()).toISOString();
    deps.db.run(
      `INSERT INTO publish_orders
         (sn, account_id, execution_id, item_id, kind, resource_id, title, content_url, remark, owner,
          publish_form, publish_type, account_rule, media_price_cents, points,
          per_article_max_points, execution_max_points,
          placement_status, ledger_status, partner_sn, upstream_status, url,
          published_at, closed_observed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'frozen', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [
        input.sn,
        accountId,
        input.executionId,
        input.itemId,
        input.kind,
        input.resourceId,
        input.title,
        input.contentUrl,
        input.remark ?? '',
        input.owner ?? '',
        input.publishForm ?? null,
        input.publishType ?? null,
        input.accountRule ?? null,
        input.mediaPriceCents,
        points,
        input.perArticleMaxPoints,
        input.executionMaxPoints,
        nowIso,
        nowIso,
      ],
    );
    const created = findPublishOrderBySn(deps.db, input.sn);
    if (!created) throw new AppError('internal_error', '订单创建后读取失败。', 500);
    return { order: created, phase: 'created' as const };
  });
}

function insufficientBalance(required: number, available: number, total: number): AppError {
  return new AppError(
    'insufficient_balance',
    `点数不足：本次需 ${required} 点，当前可用 ${available} 点，请充值后再试。`,
    402,
    { required, available, frozen: total - available, total },
  );
}

/**
 * 下单成功落档：placement=placed + partner_sn（对账路径下上游已受理但
 * partner_sn 未知时传 null，不覆盖在档值）。
 */
export function completePublishOrder(
  deps: BackendDeps,
  sn: string,
  partnerSn: string | null,
): PublishOrderRow {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    deps.db.run(
      "UPDATE publish_orders SET placement_status = 'placed', partner_sn = COALESCE(?, partner_sn), updated_at = ? WHERE sn = ?",
      [partnerSn, nowIso, sn],
    );
    const order = findPublishOrderBySn(deps.db, sn);
    if (!order) throw new AppError('internal_error', '订单完成更新后读取失败。', 500);
    return order;
  });
}

/** 下单失败收尾：placement=failed 并释放冻结（未动过流水，余额不受影响）。 */
export function failPublishOrder(deps: BackendDeps, sn: string): PublishOrderRow {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    const order = findPublishOrderBySn(deps.db, sn);
    if (!order) throw orderNotFound();
    // 仅 pending 态可失败收尾（placed 由对账查询兜底，replay 不落这里）。
    if (order.placement_status === 'pending') {
      deps.db.run(
        "UPDATE publish_orders SET placement_status = 'failed', ledger_status = 'refunded', updated_at = ? WHERE sn = ?",
        [nowIso, sn],
      );
    }
    const updated = findPublishOrderBySn(deps.db, sn);
    if (!updated) throw new AppError('internal_error', '订单失败更新后读取失败。', 500);
    return updated;
  });
}

export interface ApplyOrderStatusInput {
  sn: string;
  status: number;
  url?: string | null;
  publishedAt?: string | null;
}

/**
 * 状态机推进（幂等）：由查单代理与事件回调共同驱动。仅对已受理
 * （placement=placed）的订单执行账本迁移；快照字段（status/url/
 * published_at/closed_observed_at）始终刷新。返回推进后的订单行，
 * 未知 sn 返回 null（查单/回调可能携带非本网关订单）。
 */
export function applyPublishOrderStatus(
  deps: BackendDeps,
  input: ApplyOrderStatusInput,
): PublishOrderRow | null {
  const nowIso = new Date(deps.now()).toISOString();
  return deps.db.transaction(() => {
    const order = findPublishOrderBySn(deps.db, input.sn);
    if (!order) return null;

    let ledgerStatus = order.ledger_status;
    if (order.placement_status === 'placed') {
      if (order.ledger_status === 'frozen') {
        if (SETTLE_STATUSES.has(input.status)) {
          settleFrozenPoints(deps, order.account_id, order.points, `publish_order ${order.sn}`);
          ledgerStatus = 'settled';
        } else if (REFUND_STATUSES.has(input.status)) {
          ledgerStatus = 'refunded';
        }
      } else if (order.ledger_status === 'settled' && REFUND_STATUSES.has(input.status)) {
        // 结转后退款（如发布中申请退款获准）：refund 正流水原路回补。
        refundSettledPoints(deps, order.account_id, order.points, `publish_order ${order.sn} refund`);
        ledgerStatus = 'refunded';
      }
    }

    // 「已关闭(9)」：资金语义上线后核实，维持冻结并落观察标记（幂等，仅首次）。
    const closedObservedAt =
      input.status === 9 ? order.closed_observed_at ?? nowIso : order.closed_observed_at;

    deps.db.run(
      `UPDATE publish_orders
         SET ledger_status = ?, upstream_status = ?, url = COALESCE(?, url),
             published_at = COALESCE(?, published_at), closed_observed_at = ?, updated_at = ?
       WHERE sn = ?`,
      [
        ledgerStatus,
        input.status,
        input.url ?? null,
        input.publishedAt ?? null,
        closedObservedAt,
        nowIso,
        input.sn,
      ],
    );
    const updated = findPublishOrderBySn(deps.db, input.sn);
    if (!updated) throw new AppError('internal_error', '订单状态更新后读取失败。', 500);
    return updated;
  });
}
