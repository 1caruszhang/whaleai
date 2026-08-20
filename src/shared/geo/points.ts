/**
 * 媒介价（元）→ 点数，与 Rust `publish_channel_price_points`
 * （src-tauri/src/brand_workspace/publish_scheduler.rs）、网关
 * `publishOrderPoints`（backend/src/domain/publish-orders.ts）同式：
 * 媒介价 ×1.6（含服务费）、1 元 = 10 点，以分为基向上取整
 * ceil(分 × 4 / 25)。例：¥88.00 → 1408 点，¥1000 → 16000 点。
 *
 * 仅用于展示换算；点数计费权威仍是 Rust 执行投影与网关，本函数不改变
 * 任何定价/计费/下单语义。
 */
export function cnyToPoints(cny: number): number {
  if (!Number.isFinite(cny) || cny <= 0) return 0;
  const cents = Math.round(cny * 100);
  return Math.ceil((cents * 4) / 25);
}

/**
 * 点数 → 元（`cnyToPoints` 的逆换算，到分）：取不超过 points/16 的最大
 * 分值（floor(点数 × 25 / 4) / 100），保证 `cnyToPoints(pointsToCny(p))
 * === p` 对任意点数精确往返——卡片把点数预算折算回 CNY 后再按
 * cnyToPoints 显示时不会漂移。仅用于聊天边界回算：预算/价格是上限
 * 语义、偏保守（至多低 1 分），计费与下单语义不经由本函数。
 */
export function pointsToCny(points: number): number {
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.floor((points * 25) / 4) / 100;
}
