import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '../types/session';

// 回归（P0-2）：runTurn 非正常终止（error/stopped）时，partial assistant
// 输出必须带终止标记落盘。修复前只有 success 路径 persist，崩溃恢复或
// 重开 Session 后本轮已流出的回答从 transcript 凭空消失。

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ name: 'xiaojing-geo', tools: [] })),
  tool: vi.fn((name: string) => ({ name })),
}));

function assistantSdkMessage(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let originalGatewayBaseUrl: string | undefined;
let originalAccountToken: string | undefined;
let agentSession: typeof import('../agent-session');
let store: typeof import('../SessionStore');
let queryMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-terminal-turn-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-terminal-ws-'));
  originalHome = process.env.HOME;
  originalGatewayBaseUrl = process.env.XIAOJING_GATEWAY_BASE_URL;
  originalAccountToken = process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  process.env.HOME = testHome;
  // 主 Agent 只认账号 admission（网关 + access token），直连凭据已移除。
  process.env.XIAOJING_GATEWAY_BASE_URL = 'https://gw.example.test';
  process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN = 'test-access-token';
  vi.resetModules();
  agentSession = await import('../agent-session');
  store = await import('../SessionStore');
  queryMock = vi.mocked((await import('@anthropic-ai/claude-agent-sdk')).query as unknown as ReturnType<typeof vi.fn>);
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalGatewayBaseUrl === undefined) delete process.env.XIAOJING_GATEWAY_BASE_URL;
  else process.env.XIAOJING_GATEWAY_BASE_URL = originalGatewayBaseUrl;
  if (originalAccountToken === undefined) delete process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  else process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN = originalAccountToken;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

async function readTranscript(sessionId: string): Promise<SessionMessage[]> {
  return (await store.loadSessionTranscript(sessionId)).messages;
}

function parseBlocks(message: SessionMessage): Array<{ type: string; text?: string }> {
  return JSON.parse(message.content) as Array<{ type: string; text?: string }>;
}

describe('runTurn non-success terminals persist partial output', () => {
  it('persists the partial assistant message with terminal:"error" when the SDK stream fails', async () => {
    const session = await store.createSession(workspace);
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield assistantSdkMessage('sdk-err-1', 'partial answer before failure');
        throw new Error('simulated sdk failure');
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('hello');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('error');
    });

    const messages = await readTranscript(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    const partial = messages[1];
    expect(partial.role).toBe('assistant');
    expect(partial.terminal).toBe('error');
    expect(parseBlocks(partial)).toEqual([
      { type: 'text', text: 'partial answer before failure' },
    ]);
  });

  it('persists the partial assistant message with terminal:"stopped" on interruption', async () => {
    const session = await store.createSession(workspace);
    await agentSession.initializeAgent(workspace, null, session.id);
    queryMock.mockImplementationOnce(((params: {
      options: { abortController: AbortController };
    }) => {
      const controller = params.options.abortController;
      return {
        async *[Symbol.asyncIterator]() {
          yield assistantSdkMessage('sdk-stop-1', 'partial answer before stop');
          await new Promise((_, reject) => {
            if (controller.signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        close() {},
      };
    }) as never);

    const result = await agentSession.enqueueUserMessage('second question');
    expect(result.accepted).toBe(true);
    await agentSession.interruptCurrentResponse();
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('idle');
    });

    const messages = await readTranscript(session.id);
    const partial = messages[messages.length - 1];
    expect(partial.role).toBe('assistant');
    expect(partial.terminal).toBe('stopped');
    expect(parseBlocks(partial)).toEqual([
      { type: 'text', text: 'partial answer before stop' },
    ]);
  });
});
