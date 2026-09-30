import type { SqlClient } from '../db/client';

/**
 * 运营台仪表盘聚合（票 48）：账号口径、余额口径与「今日」/近 30 天充值
 * 扣点序列。「今日」与按日序列一律按北京时间（UTC+8）日界切分——created_at
 * 存毫秒精度 UTC ISO（applyBalanceChange 统一 toISOString），日界换算在 JS
 * 侧完成，不依赖 SQLite date() 对 ISO 字符串的解析口径；序列聚合同样在
 * JS 侧按北京时间归日，30 天空窗日补零。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SERIES_DAYS = 30;

export interface AdminOverviewStats {
  accounts: { total: number; active: number; disabled: number };
  balance: { total: number; frozen: number; available: number };
  today: { topup: number; consume: number };
  /** 近 30 天按日序列（含今天），北京时间 YYYY-MM-DD，空窗日补零。 */
  dailySeries: { date: string; topup: number; consume: number }[];
}

/** epoch 毫秒 → 该时刻所在北京时间日 00:00 对应的 epoch 毫秒（UTC 表示）。 */
export function beijingDayStartMs(nowMs: number): number {
  return Math.floor((nowMs + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;
}

/** 北京时间日界 epoch 毫秒 → YYYY-MM-DD（加回偏移再按 UTC 取日期）。 */
function beijingDateString(dayStartMs: number): string {
  return new Date(dayStartMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function adminOverviewStats(db: SqlClient, nowMs: number): AdminOverviewStats {
  const accountCounts = db.get<{ total: number; active: number; disabled: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
            COALESCE(SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END), 0) AS disabled
     FROM accounts`,
    [],
  );
  const balanceTotal =
    db.get<{ total: number }>('SELECT COALESCE(SUM(balance), 0) AS total FROM accounts', [])
      ?.total ?? 0;
  // 冻结口径与 balanceSnapshot 一致：open permit 冻结 + frozen 发布订单冻结。
  const permitFrozen =
    db.get<{ frozen: number }>(
      "SELECT COALESCE(SUM(frozen_remaining), 0) AS frozen FROM billing_permits WHERE status = 'open'",
      [],
    )?.frozen ?? 0;
  const orderFrozen =
    db.get<{ frozen: number }>(
      "SELECT COALESCE(SUM(points), 0) AS frozen FROM publish_orders WHERE ledger_status = 'frozen'",
      [],
    )?.frozen ?? 0;
  const frozen = permitFrozen + orderFrozen;

  const todayStartMs = beijingDayStartMs(nowMs);
  const todayStartIso = new Date(todayStartMs).toISOString();
  const tomorrowStartIso = new Date(todayStartMs + DAY_MS).toISOString();
  // 「今日」充值 = 今天日界内 topup 入账；扣点 = consume 负流水绝对值。
  // grant/adjust/refund 都不进这两个口径（与 SSR 流水中文标签语义一致）。
  const today = db.get<{ topup: number; consume: number }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'topup' THEN delta ELSE 0 END), 0) AS topup,
            COALESCE(SUM(CASE WHEN kind = 'consume' THEN -delta ELSE 0 END), 0) AS consume
     FROM ledger_entries WHERE created_at >= ? AND created_at < ?`,
    [todayStartIso, tomorrowStartIso],
  );

  // 30 天窗口 = [今天-29 的北京日界, 明天日界)；只取 topup/consume 两列种类。
  const windowStartMs = todayStartMs - (SERIES_DAYS - 1) * DAY_MS;
  const rows = db.all<{ kind: string; delta: number; created_at: string }>(
    `SELECT kind, delta, created_at FROM ledger_entries
     WHERE kind IN ('topup', 'consume') AND created_at >= ? AND created_at < ?`,
    [new Date(windowStartMs).toISOString(), tomorrowStartIso],
  );
  const byDay = new Map<string, { topup: number; consume: number }>();
  for (const row of rows) {
    const day = beijingDateString(beijingDayStartMs(Date.parse(row.created_at)));
    const bucket = byDay.get(day) ?? { topup: 0, consume: 0 };
    if (row.kind === 'topup') bucket.topup += row.delta;
    else bucket.consume += -row.delta;
    byDay.set(day, bucket);
  }
  const dailySeries = Array.from({ length: SERIES_DAYS }, (_, i) => {
    const day = beijingDateString(windowStartMs + i * DAY_MS);
    const bucket = byDay.get(day);
    return { date: day, topup: bucket?.topup ?? 0, consume: bucket?.consume ?? 0 };
  });

  return {
    accounts: {
      total: accountCounts?.total ?? 0,
      active: accountCounts?.active ?? 0,
      disabled: accountCounts?.disabled ?? 0,
    },
    balance: { total: balanceTotal, frozen, available: balanceTotal - frozen },
    today: { topup: today?.topup ?? 0, consume: today?.consume ?? 0 },
    dailySeries,
  };
}
