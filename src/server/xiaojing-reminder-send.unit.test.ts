import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sendXiaojingMessage,
  type XiaojingMessageSendResult,
} from './xiaojing-reminder-send';

// GD-8④ 回归：提醒投递绝不能把异常抛回调用方。知识/问题池/主题计划等
// 路由在业务 SQLite 决策提交成功后才投送 reminder —— knowledge_authority.md
// 规定"提醒入队失败不会回滚已经提交的 SQLite 决策，响应显式返回
// notification 状态"。若 enqueue 抛错穿透到路由 catch，响应会变成 400/500
// 的"失败"，与已提交的事实相矛盾。
vi.mock('./agent-session', () => ({
  enqueueUserMessage: vi.fn(),
}));

const enqueueUserMessage = vi.mocked(
  await import('./agent-session'),
).enqueueUserMessage;

describe('sendXiaojingMessage — reminder delivery never throws (GD-8④)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('maps an enqueue throw to a structured failure result', async () => {
    enqueueUserMessage.mockRejectedValueOnce(new Error('transient enqueue crash'));
    const result: XiaojingMessageSendResult = await sendXiaojingMessage(
      'XIAOJING_KNOWLEDGE_DECISION …',
      undefined,
      '/tmp/workspace',
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('transient enqueue crash');
    expect(result.status).toBe(500);
  });

  it('maps a structured enqueue error to success=false with 429', async () => {
    enqueueUserMessage.mockResolvedValueOnce({
      error: 'agent busy',
    } as Awaited<ReturnType<typeof enqueueUserMessage>>);
    const result = await sendXiaojingMessage('reminder', undefined, '/tmp/workspace');
    expect(result.success).toBe(false);
    expect(result.error).toBe('agent busy');
    expect(result.status).toBe(429);
  });

  it('passes through a successful enqueue', async () => {
    enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-1',
    } as Awaited<ReturnType<typeof enqueueUserMessage>>);
    const result = await sendXiaojingMessage('reminder', undefined, '/tmp/workspace', [
      'xiaojing_files/s/a.md',
    ]);
    expect(result).toEqual({ success: true, queued: true, queueId: 'q-1' });
    expect(enqueueUserMessage).toHaveBeenCalledWith('reminder', undefined, [
      'xiaojing_files/s/a.md',
    ]);
  });
});
