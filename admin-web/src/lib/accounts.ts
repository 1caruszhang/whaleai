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

// ── 票 49：账号详情页 API 层 ──

/** 详情页主数据源（GET /admin/accounts/:accountId/ledger）的账号投影：运营投影（含 displayName）。 */
export interface AdminLedgerAccount {
  id: string;
  phone: string;
  status: AdminAccountStatus;
  mustChangePassword: boolean;
  points: number;
  displayName: string;
}

export interface AdminLedgerEntry {
  id: string;
  delta: number;
  balanceAfter: number;
  kind: string;
  note: string;
  createdAt: string;
}

export interface AdminAccountLedger {
  account: AdminLedgerAccount;
  balance: AdminAccountBalance;
  entries: AdminLedgerEntry[];
}

/** 点数流水（复用既有端点，SSR 对账页同源）：默认取 200 条（与 SSR 同口径）。 */
export function listAdminAccountLedger(
  accountId: string,
  limit = 200,
): Promise<AdminAccountLedger> {
  return adminFetch<AdminAccountLedger>(`/admin/accounts/${accountId}/ledger?limit=${limit}`);
}

export type AdminPermitStatus = 'open' | 'settled';

/** 计费 permit 投影（详情页 permit 计费卡，与既有 permit 计费投影同源）。 */
export interface AdminPermit {
  permitId: string;
  operation: string;
  units: number;
  unitPrice: number;
  basePrice: number;
  totalPoints: number;
  status: AdminPermitStatus;
  frozenPoints: number;
  consumedPoints: number;
  refundedPoints: number;
  unitsSucceeded: number;
  unitsFailed: number;
  unitsUnreported: number;
  createdAt: string;
  settledAt: string | null;
}

/** permit 计费列表（open + settled 全量、最新在前）。 */
export function listAdminAccountPermits(
  accountId: string,
  limit = 50,
): Promise<{ permits: AdminPermit[] }> {
  return adminFetch<{ permits: AdminPermit[] }>(
    `/admin/accounts/${accountId}/permits?limit=${limit}`,
  );
}

export type AdminPublishOrderKind = 'media' | 'we-media';
export type AdminPublishOrderPlacementStatus = 'pending' | 'placed' | 'failed';
export type AdminPublishOrderLedgerStatus = 'frozen' | 'settled' | 'refunded';

/** 发布订单投影（详情页发布订单卡，与既有 publishOrderProjection 同源）。 */
export interface AdminPublishOrder {
  sn: string;
  executionId: string;
  itemId: string;
  kind: AdminPublishOrderKind;
  resourceId: number;
  title: string;
  contentUrl: string;
  mediaPriceCents: number;
  points: number;
  perArticleMaxPoints: number;
  executionMaxPoints: number;
  placementStatus: AdminPublishOrderPlacementStatus;
  ledgerStatus: AdminPublishOrderLedgerStatus;
  partnerSn: string | null;
  status: number | null;
  url: string | null;
  publishedAt: string | null;
  closedObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 发布订单列表（最新在前）。 */
export function listAdminAccountPublishOrders(
  accountId: string,
  limit = 50,
): Promise<{ orders: AdminPublishOrder[] }> {
  return adminFetch<{ orders: AdminPublishOrder[] }>(
    `/admin/accounts/${accountId}/publish-orders?limit=${limit}`,
  );
}

/** Provider 旁路计量记录（camelCase 投影，最新在前）。 */
export interface AdminProviderUsageRecord {
  id: string;
  provider: string;
  route: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

/** Provider 计量列表（对账用，最新在前）。 */
export function listAdminAccountProviderUsage(
  accountId: string,
  limit = 50,
): Promise<{ records: AdminProviderUsageRecord[] }> {
  return adminFetch<{ records: AdminProviderUsageRecord[] }>(
    `/admin/accounts/${accountId}/provider-usage?limit=${limit}`,
  );
}

/** 对话旁路计量记录（隐藏额度口径，最新在前）。 */
export interface AdminChatUsageRecord {
  id: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  pointsMilli: number;
  createdAt: string;
}

/** 对话计量列表 + 本周期隐藏额度累计（千分之一点）。 */
export function listAdminAccountChatUsage(
  accountId: string,
  limit = 50,
): Promise<{ account: AdminLedgerAccount; quotaUsedMilli: number; records: AdminChatUsageRecord[] }> {
  return adminFetch<{ account: AdminLedgerAccount; quotaUsedMilli: number; records: AdminChatUsageRecord[] }>(
    `/admin/accounts/${accountId}/chat-usage?limit=${limit}`,
  );
}

/**
 * 设置/清空用户名：displayName 传 null 清空（与空串同义，后端落空串）；
 * 非空 ≤64 由页面校验 + 后端 schema 双护栏。成功后回显运营投影。
 */
export function setAdminAccountDisplayName(
  accountId: string,
  displayName: string | null,
): Promise<{ account: AdminLedgerAccount }> {
  return adminFetch<{ account: AdminLedgerAccount }>(
    `/admin/accounts/${accountId}/display-name`,
    { method: 'POST', body: JSON.stringify({ displayName }) },
  );
}

/** 点数流水类型 → 中文标签（与 SSR 对账页同一词表）。 */
export function ledgerKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    grant: '开通赠送',
    topup: '充值',
    adjust: '调整',
    consume: '扣点',
    refund: '退款',
  };
  return labels[kind] ?? kind;
}

/** permit 状态 → 中文（与 SSR 对账页同一词表）。 */
export function permitStatusLabel(status: AdminPermitStatus): string {
  return status === 'open' ? '进行中' : '已结清';
}
