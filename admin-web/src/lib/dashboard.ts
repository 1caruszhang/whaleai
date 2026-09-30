import { adminFetch } from '@/lib/api';

/**
 * 仪表盘 API 层（票 48）：只走 lib/api 的 adminFetch 出口（Bearer + 401
 * 闭环）。字段契约与后端 GET /admin/stats/overview、GET /admin/media-pool
 * 一一对应（spec 45 接口扩展）。
 */

export interface AdminAccountCounts {
  total: number;
  active: number;
  disabled: number;
}

export interface AdminBalanceTotals {
  total: number;
  frozen: number;
  available: number;
}

export interface AdminDailyPoint {
  /** 北京时间日界 YYYY-MM-DD。 */
  date: string;
  topup: number;
  consume: number;
}

export interface AdminStatsOverview {
  accounts: AdminAccountCounts;
  balance: AdminBalanceTotals;
  today: { topup: number; consume: number };
  /** 近 30 天按日序列（含今天），空窗日已补零。 */
  dailySeries: AdminDailyPoint[];
}

/** 媒介池余额：上游失败时 degraded=true 且无 balanceCents（降级展示，不阻断）。 */
export interface AdminMediaPool {
  degraded: boolean;
  balanceCents?: number;
  lowBalanceCents: number;
  /** 仅 degraded=false 时存在；低于阈值时 true。 */
  lowBalance?: boolean;
}

export function getAdminStatsOverview(): Promise<AdminStatsOverview> {
  return adminFetch<AdminStatsOverview>('/admin/stats/overview');
}

export function getAdminMediaPool(): Promise<AdminMediaPool> {
  return adminFetch<AdminMediaPool>('/admin/media-pool');
}

/** 分 → 元的两位小数展示（与 SSR 余额卡口径一致）。 */
export function yuanFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
