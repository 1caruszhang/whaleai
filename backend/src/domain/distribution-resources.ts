import type { SqlClient } from '../db/client';
import type { DistributionResourceCacheRow, PublishOrderKind } from './types';

/**
 * 渠道资源快照缓存（票 08）：发布下单的定价权威数据源。订单点数按
 * 「媒介费 × 1.6（含 60% 服务费）× 10（1 元 = 10 点锚点）→ 向上取整」
 * 预扣，媒介价必须来自服务器侧快照——客户端传入的价格只作展示，绝不
 * 参与扣点（与 permit 通道「定价权威在后端」同一条红线）。
 *
 * 取舍（票 08 注明）：后端此前没有资源缓存（Sidecar 的 30 分钟 TTL 缓存
 * 只服务分发计划发现页），本模块建立最小快照——只存下单定价与对账所需
 * 字段（name/price_cents/status/fetched_at），不缓存整页资源列表。读取
 * 方（路由层）miss 时回源 /media|we-media/resource/query 回填；资源变更
 * 回调（event=1）刷新；回源失败时失效删除，下次下单重取。不设 TTL 过期
 * （价格变更经回调主动刷新，未接回调的漂移由下单回源兜底）。
 */

/** decimal(10,2) 价格字符串/数值 → 分（整数）；异形返回 null。 */
export function priceToCents(price: string | number | null | undefined): number | null {
  if (price === null || price === undefined) return null;
  const value = typeof price === 'number' ? price : Number.parseFloat(price);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

export function readDistributionResourceCache(
  db: SqlClient,
  kind: PublishOrderKind,
  resourceId: number,
): DistributionResourceCacheRow | null {
  return (
    db.get<DistributionResourceCacheRow>(
      'SELECT kind, resource_id, name, price_cents, status, fetched_at FROM distribution_resource_cache WHERE kind = ? AND resource_id = ?',
      [kind, resourceId],
    ) ?? null
  );
}

export function upsertDistributionResourceCache(
  db: SqlClient,
  row: Omit<DistributionResourceCacheRow, 'fetched_at'>,
  fetchedAtIso: string,
): void {
  db.run(
    `INSERT INTO distribution_resource_cache (kind, resource_id, name, price_cents, status, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, resource_id) DO UPDATE SET
       name = excluded.name, price_cents = excluded.price_cents, status = excluded.status, fetched_at = excluded.fetched_at`,
    [row.kind, row.resource_id, row.name, row.price_cents, row.status, fetchedAtIso],
  );
}

/** 失效（资源变更回源失败等）：返回是否确有行被删除。 */
export function invalidateDistributionResourceCache(
  db: SqlClient,
  kind: PublishOrderKind,
  resourceId: number,
): boolean {
  return db.run('DELETE FROM distribution_resource_cache WHERE kind = ? AND resource_id = ?', [
    kind,
    resourceId,
  ]).changes > 0;
}
