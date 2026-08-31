/**
 * 提醒投递的单出口（GD-8④ / knowledge_authority.md 提醒契约）。
 *
 * 各 xiaojing 路由在业务决策已提交 SQLite 之后调用这里投送隐藏 reminder。
 * 契约要求"提醒入队失败不会回滚已经提交的 SQLite 决策，响应会显式返回
 * notification 状态"——因此本函数绝不向调用方抛错：enqueue 抛出的异常必须
 * 降级成结构化失败结果，由路由拼进响应的 notificationError 字段。
 */

import { enqueueUserMessage } from './agent-session';
import type { ImagePayload } from './types/image';

export interface XiaojingMessageSendResult {
  success: boolean;
  status?: number;
  error?: string;
}

export interface XiaojingMessageSendOptions {
  /** 提醒正文（隐藏 reminder）。 */
  text: string;
  images?: ImagePayload[];
  sessionFiles?: string[];
  /** 请求级账号 token（admission 单飞轮换后的新鲜值）。 */
  requestAccountToken?: string;
}

export async function sendXiaojingMessage(
  options: XiaojingMessageSendOptions,
): Promise<XiaojingMessageSendResult> {
  let result: Awaited<ReturnType<typeof enqueueUserMessage>>;
  try {
    result = await enqueueUserMessage(
      options.text,
      options.images,
      options.sessionFiles,
      options.requestAccountToken,
    );
  } catch (error) {
    // 已提交的业务决策不受影响；投递失败以结构化结果返回（GD-8④）。
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: 500,
    };
  }
  return result.error
    ? { success: false, error: result.error, status: 429 }
    : { success: true };
}
