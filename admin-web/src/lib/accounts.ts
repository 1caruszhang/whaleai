import { adminFetch } from '@/lib/api';

/**
 * 账号列表页 API 层（票 47）：只走 lib/api 的 adminFetch 出口（Bearer +
 * 401 闭环），本模块不直接碰 fetch。行字段契约与后端 GET /admin/accounts
 * 一一对应（spec 45 接口扩展）。
 */

export type AdminAccountStatus = 'active' | 'disabled';
export type AdminAccountSort = 'created' | 'balance' | 'active';

export interface AdminAccountBalance {
  total: number;
  frozen: number;
  available: number;
}

export interface AdminAccountChatQuota {
  /** 隐藏额度总量（点数，服务器配置）。 */
  totalPoints: number;
  /** 本充值周期内已用量（千分之一点）。 */
  usedMilli: number;
}

export interface AdminAccountBrand {
  workspaceId: string;
  name: string;
}

export interface AdminAccount {
  id: string;
  phone: string;
  /** 空串 = 旧账号没有用户名（列表显示「—」）。 */
  displayName: string;
  status: AdminAccountStatus;
  mustChangePassword: boolean;
  balance: AdminAccountBalance;
  chatQuota: AdminAccountChatQuota;
  brands: AdminAccountBrand[];
  /** 最近活跃（auth_sessions 聚合）；从未登录为 null。 */
  lastActiveAt: string | null;
  createdAt: string;
}

export interface AdminAccountListQuery {
  q: string;
  page: number;
  pageSize: number;
  sort: AdminAccountSort;
}

export interface AdminAccountListResult {
  accounts: AdminAccount[];
  total: number;
  page: number;
  pageSize: number;
}

/** 列表查询：q 命中手机号或用户名；page/pageSize 分页；sort 三种排序。 */
export function listAdminAccounts(
  query: AdminAccountListQuery,
): Promise<AdminAccountListResult> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
    sort: query.sort,
  });
  if (query.q !== '') params.set('q', query.q);
  return adminFetch<AdminAccountListResult>(`/admin/accounts?${params.toString()}`);
}

export interface CreateAccountInput {
  phone: string;
  initialPassword: string;
  /** 可选用户名（≤64 字符）；缺省不传。 */
  displayName?: string;
}

export interface AdminAccountCreated {
  id: string;
  phone: string;
  status: AdminAccountStatus;
  mustChangePassword: boolean;
  points: number;
  displayName: string;
}

/** 建号（开通即赠点由后端 grant 流水落账）。 */
export function createAdminAccount(
  input: CreateAccountInput,
): Promise<{ account: AdminAccountCreated }> {
  return adminFetch<{ account: AdminAccountCreated }>('/admin/accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 停用/启用：停用即时吊销账号全部会话（后端既有语义）。 */
export function setAdminAccountStatus(
  accountId: string,
  status: AdminAccountStatus,
): Promise<{ account: { id: string; status: AdminAccountStatus } }> {
  return adminFetch<{ account: { id: string; status: AdminAccountStatus } }>(
    `/admin/accounts/${accountId}/status`,
    { method: 'POST', body: JSON.stringify({ status }) },
  );
}

/** 充值入账（复用既有端点）：points 为点数（1 元 = 10 点，粒度 0.1 元）。 */
export function topupAdminAccount(
  accountId: string,
  points: number,
  note: string,
): Promise<{ account: unknown; balance: unknown }> {
  return adminFetch<{ account: unknown; balance: unknown }>('/admin/ledger/topup', {
    method: 'POST',
    body: JSON.stringify({ accountId, points, note }),
  });
}

/** 调点（复用既有端点）：delta 可正可负、必须带备注。 */
export function adjustAdminAccount(
  accountId: string,
  delta: number,
  note: string,
): Promise<{ account: unknown; balance: unknown }> {
  return adminFetch<{ account: unknown; balance: unknown }>('/admin/ledger/adjust', {
    method: 'POST',
    body: JSON.stringify({ accountId, delta, note }),
  });
}

/** 对话隐藏额度剩余（点）：≤0 即已用尽（对话被暂停，任意充值刷新）。 */
export function chatQuotaRemainingPoints(quota: AdminAccountChatQuota): number {
  return quota.totalPoints - quota.usedMilli / 1000;
}
