import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { ProviderUsageRecordRow } from './types';

/**
 * Provider 代理旁路计量（票 05）。网关代理的每次 Provider 请求（上游 2xx）
 * 落一行 `provider_usage_records`：LLM 流量记真实 token 用量（OpenAI 系
 * usage 口径），OSS/超级媒介等无 token 的请求记次数（一行 = 一次）。
 *
 * 与票 04 的 chat_usage_records 同一纪律：计量只作运营与火山/豆包/OSS 账单
 * 对账，不是点数余额变动，不进 ledger_entries（Σdelta == balance 不变量
 * 不被污染）；计费扣点走 permit 通道（票 03/07）。
 *
 * 表中不含任何上游密钥、请求体或账号 token——只有账号 id、provider、
 * route 标签与用量整数。
 */

export type ProviderUsageProvider = 'deepseek' | 'ark' | 'doubao-search' | 'oss' | 'distribution';

/** 一次经网关代理的 Provider 请求的旁路计量。 */
export function recordProviderUsage(
  deps: BackendDeps,
  accountId: string,
  input: {
    provider: ProviderUsageProvider;
    /** 稳定的路由标签，如 'ark.chat_completions' / 'oss.put_html'。 */
    route: string;
    inputTokens?: number;
    outputTokens?: number;
  },
): void {
  deps.db.run(
    `INSERT INTO provider_usage_records (id, account_id, provider, route, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      accountId,
      input.provider,
      input.route,
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      new Date(deps.now()).toISOString(),
    ],
  );
}

/** 运营对账视图：按请求列计量记录，最新在前。 */
export function listProviderUsageRecords(
  db: SqlClient,
  accountId: string,
  limit: number,
): ProviderUsageRecordRow[] {
  return db.all<ProviderUsageRecordRow>(
    'SELECT id, account_id, provider, route, input_tokens, output_tokens, created_at FROM provider_usage_records WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [accountId, limit],
  );
}
