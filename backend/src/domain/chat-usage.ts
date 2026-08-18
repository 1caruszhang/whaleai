import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { AccountRow, ChatUsageRecordRow } from './types';
import { AppError } from '../errors';

/**
 * 对话旁路计量与隐藏额度（票 04）。规格：主 Agent 对话对用户免费且不显示
 * 任何额度；但运营侧有 100 点等值的隐藏额度——每次调用的真实 token 用量由
 * 网关旁路计量折点累计，用尽暂停对话，任意档位充值（topup）刷新额度。
 *
 * 计量落 `chat_usage_records`（每请求一行，tokens + 折点），不动
 * `ledger_entries`：账本流水只记点数余额变动（Σdelta == balance 不变量），
 * 免费对话没有余额变动，混入 delta=0 流水会污染对账口径。累计值放
 * `accounts.chat_quota_used_milli`（千分之一点，避免小额调用取整归零），
 * 由 topup 入账事务清零。
 */

/** 一次上游调用的真实 token 用量（Anthropic /v1/messages usage 口径）。 */
export interface ChatTokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export interface ChatUsageRecord {
  id: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** 折点（千分之一点整数），1 元 = 10 点。 */
  pointsMilli: number;
  createdAt: string;
}

/** token 用量 → 千分点。单价为元/百万 token；锚点 1 元 = 10 点 → 1 元 = 10000 千分点。 */
export function chatUsagePointsMilli(
  prices: { inputCnyPerMtok: number; inputCacheHitCnyPerMtok: number; outputCnyPerMtok: number },
  usage: ChatTokenUsage,
): number {
  // 缓存写按未命中价计（与 DeepSeek 计费口径一致：写不折扣、读打 1 折由 env 定价体现）。
  const missInput = usage.inputTokens + usage.cacheCreationTokens;
  const cny =
    (missInput / 1e6) * prices.inputCnyPerMtok +
    (usage.cacheReadTokens / 1e6) * prices.inputCacheHitCnyPerMtok +
    (usage.outputTokens / 1e6) * prices.outputCnyPerMtok;
  return Math.round(cny * 10 * 1000);
}

/** 当前隐藏额度累计（千分点）。 */
export function chatQuotaUsedMilli(db: SqlClient, accountId: string): number {
  const row = db.get<{ used: number }>('SELECT chat_quota_used_milli AS used FROM accounts WHERE id = ?', [
    accountId,
  ]);
  return row?.used ?? 0;
}

/**
 * 对话准入闸门（/v1/messages 与 count_tokens 共用）：
 * 1. 余额为 0 → 拒绝对话并提示充值（chat_balance_zero）；
 * 2. 隐藏额度用尽 → 暂停对话并提示充值（chat_quota_exhausted，与余额 0 区分）。
 * 错误体不携带任何剩余额度数字：隐藏额度对客户端接口不可见。
 */
export function assertConversationAllowed(deps: BackendDeps, account: AccountRow): void {
  if (account.balance <= 0) {
    throw new AppError('chat_balance_zero', '对话需要账号点数余额大于 0，请充值后再试。', 402);
  }
  const quotaMilli = deps.config.chatHiddenQuotaPoints * 1000;
  if (chatQuotaUsedMilli(deps.db, account.id) >= quotaMilli) {
    throw new AppError(
      'chat_quota_exhausted',
      '当前充值周期内的对话额度已用完，充值任意档位后立即恢复。',
      402,
    );
  }
}

/** 一次对话调用的旁路计量落账：插 usage 记录并累计隐藏额度（同一事务）。 */
export function recordChatUsage(
  deps: BackendDeps,
  accountId: string,
  input: { model: string; usage: ChatTokenUsage },
): ChatUsageRecord {
  const pointsMilli = chatUsagePointsMilli(
    {
      inputCnyPerMtok: deps.config.chatInputCnyPerMtok,
      inputCacheHitCnyPerMtok: deps.config.chatInputCacheHitCnyPerMtok,
      outputCnyPerMtok: deps.config.chatOutputCnyPerMtok,
    },
    input.usage,
  );
  const nowIso = new Date(deps.now()).toISOString();
  const id = randomUUID();
  deps.db.transaction(() => {
    deps.db.run(
      `INSERT INTO chat_usage_records (id, account_id, model, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, points_milli, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        accountId,
        input.model,
        input.usage.inputTokens,
        input.usage.cacheReadTokens,
        input.usage.cacheCreationTokens,
        input.usage.outputTokens,
        pointsMilli,
        nowIso,
      ],
    );
    deps.db.run(
      'UPDATE accounts SET chat_quota_used_milli = chat_quota_used_milli + ?, updated_at = ? WHERE id = ?',
      [pointsMilli, nowIso, accountId],
    );
  });
  return {
    id,
    model: input.model,
    ...input.usage,
    pointsMilli,
    createdAt: nowIso,
  };
}

/** 运营对账视图：按请求列计量记录，最新在前；总额与账号累计口径一致。 */
export function listChatUsageRecords(
  db: SqlClient,
  accountId: string,
  limit: number,
): ChatUsageRecord[] {
  return db
    .all<ChatUsageRecordRow>(
      'SELECT id, model, input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, points_milli, created_at FROM chat_usage_records WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      [accountId, limit],
    )
    .map(row => ({
      id: row.id,
      model: row.model,
      inputTokens: row.input_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      outputTokens: row.output_tokens,
      pointsMilli: row.points_milli,
      createdAt: row.created_at,
    }));
}
