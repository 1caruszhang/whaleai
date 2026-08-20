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
