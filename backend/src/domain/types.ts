export type AccountStatus = 'active' | 'disabled';

/** accounts 表行。布尔列用 0/1。 */
export interface AccountRow {
  id: string;
  phone: string;
  password_hash: string;
  password_version: number;
  status: AccountStatus;
  must_change_password: number;
  balance: number;
  created_at: string;
  updated_at: string;
  /** 对话隐藏额度累计（千分之一点，票 04）；topup 入账时清零。 */
  chat_quota_used_milli: number;
}

export interface AuthSessionRow {
  id: string;
  account_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
}

export interface RefreshTokenRow {
  id: string;
  session_id: string;
  token_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
  replaced_by: string | null;
  revoked_at: string | null;
}

/** 点数流水。delta 正为入账（赠送/充值）、负为扣减（消费/调减）；balance_after 为该笔落账后余额。 */
export interface LedgerEntryRow {
  id: string;
  account_id: string;
  delta: number;
  balance_after: number;
  kind: string;
  note: string;
  created_at: string;
}

export type PermitStatus = 'open' | 'settled';

export type UnitOutcome = 'success' | 'failure';

/**
 * 计费 permit：一次计费操作的预扣凭证。id 为客户端生成的幂等键；
 * frozen_remaining 为尚未结转/回补的冻结点数（初始 = base + perUnit×units，
 * 随逐单位回报递减）；status=open 计入账号并发准入。
 */
export interface BillingPermitRow {
  id: string;
  account_id: string;
  operation: string;
  units: number;
  unit_price: number;
  base_price: number;
  frozen_remaining: number;
  status: PermitStatus;
  created_at: string;
  settled_at: string | null;
}

export interface PermitUnitReportRow {
  permit_id: string;
  unit_index: number;
  outcome: UnitOutcome;
  reported_at: string;
}

export type PublishOrderKind = 'media' | 'we-media';

/** 下单三态：pending = 冻结中、上游结果未回；placed = 上游受理（partner_sn 已回）；failed = 未受理且冻结已释放（可重试）。 */
export type PublishOrderPlacementStatus = 'pending' | 'placed' | 'failed';

/**
 * 订单账本三态（票 08 状态机）：frozen = 预扣冻结（计入账号冻结口径）；
 * settled = 已结转（consume 流水已落）；refunded = 原路回补（frozen 释放
 * 或 settled 后退款落 refund 正流水）。
 */
export type PublishOrderLedgerStatus = 'frozen' | 'settled' | 'refunded';

/**
 * 发布订单（票 08）：sn 为客户端生成的代理商订单号（幂等键，与上游同键）。
 * points 为预扣点数（媒介费×1.6 → 点数向上取整）；media_price_cents 为
 * 下单时上游权威媒介价（分），与 points 一同留档供对账。closed_observed_at
 * 为「已关闭(9)」观察标记——资金语义上线后核实，期间维持原 ledger_status。
 */
export interface PublishOrderRow {
  sn: string;
  account_id: string;
  execution_id: string;
  item_id: string;
  kind: PublishOrderKind;
  resource_id: number;
  title: string;
  content_url: string;
  remark: string;
  owner: string;
  publish_form: number | null;
  publish_type: number | null;
  account_rule: number | null;
  media_price_cents: number;
  points: number;
  per_article_max_points: number;
  execution_max_points: number;
  placement_status: PublishOrderPlacementStatus;
  ledger_status: PublishOrderLedgerStatus;
  partner_sn: string | null;
  upstream_status: number | null;
  url: string | null;
  published_at: string | null;
  closed_observed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 渠道资源快照缓存（票 08）：下单定价的权威价格缓存。下单时读缓存，
 * miss/失效回源 /media|we-media/resource/query 后回填；资源变更回调
 * （event=1）刷新。只存定价与展示所需的最小字段，不存整页资源。
 */
export interface DistributionResourceCacheRow {
  kind: PublishOrderKind;
  resource_id: number;
  name: string;
  price_cents: number;
  status: number | null;
  fetched_at: string;
}

/**
 * 对话旁路计量记录（票 04）：网关每次 /v1/messages 调用的真实 token 用量
 * 与折点（千分之一点）。只作运营与 DeepSeek 账单对账，不改点数余额。
 */
export interface ChatUsageRecordRow {
  id: string;
  account_id: string;
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  points_milli: number;
  created_at: string;
}

/**
 * Provider 代理旁路计量记录（票 05）：网关代理的每次 Provider 请求（2xx）
 * 一行。LLM 流量记真实 token；OSS/超级媒介等记次数（一行 = 一次）。
 * 只作运营与上游账单对账，不是余额变动。
 */
export interface ProviderUsageRecordRow {
  id: string;
  account_id: string;
  /** 'deepseek' | 'ark' | 'doubao-search' | 'oss' | 'distribution'。 */
  provider: string;
  /** 稳定路由标签，如 'ark.chat_completions' / 'oss.put_html'。 */
  route: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}
