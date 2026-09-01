import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// AskUserQuestion 的服务端生命周期：canUseTool 挂起提问 → 卡片出现 →
// 用户 POST respond → pending resolve 回 SDK。锁两个行为：
//  1. respond 正确把答案写回 PermissionResult（allow + updatedInput.answers）；
//  2. turn 中途出错（非用户中止）时，悬挂的提问必须被清空并广播
//     ask-user-question:expired（旧实现从不 abort，pendingQuestions 残留、
//     渲染层卡片永挂——点击提交后也没有任何 agent 续跑）。

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ name: 'xiaojing-geo', tools: [] })),
  tool: vi.fn((name: string) => ({ name })),
}));

vi.mock('../sse', () => ({ broadcast: broadcastMock }));

const QUESTION_INPUT = {
  questions: [
    {
      question: '选择哪个方案继续？',
      header: '方案确认',
      multiSelect: false,
      options: [
        { label: '方案A', description: '推荐' },
        { label: '方案B', description: '' },
      ],
    },
  ],
};

function assistantTextFrame(uuid: string, text: string) {
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
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-ask-user-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-ask-user-ws-'));
  originalHome = process.env.HOME;
  originalGatewayBaseUrl = process.env.XIAOJING_GATEWAY_BASE_URL;
  originalAccountToken = process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  process.env.HOME = testHome;
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

afterEach(() => {
  broadcastMock.mockClear();
  queryMock.mockReset();
});

function broadcastEvents(): string[] {
  return (broadcastMock.mock.calls as Array<[string, unknown]>).map(([event]) => event);
}

describe('ask-user-question pending lifecycle', () => {
  it('resolves the pending permission with allow + answers when the user responds', async () => {
    const session = await store.createSession(workspace);
    let resolvedPermission: unknown = null;
    queryMock.mockImplementationOnce((queryArgs: {
      options: {
        abortController: AbortController;
        canUseTool: (name: string, input: unknown, check: { signal: AbortSignal }) => Promise<unknown>;
      };
    }) => ({
      async *[Symbol.asyncIterator]() {
        const permissionPromise = queryArgs.options.canUseTool(
          'AskUserQuestion',
          QUESTION_INPUT,
          { signal: queryArgs.options.abortController.signal },
        );
        yield assistantTextFrame('ask-ok-1', '需要确认一个方案');
        resolvedPermission = await permissionPromise;
        yield { type: 'result', subtype: 'success', result: '已按选择继续' };
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('推进');
    expect(result.accepted).toBe(true);

    await vi.waitFor(() => {
      expect(broadcastEvents()).toContain('ask-user-question:request');
    });
    const pending = agentSession.getPendingInteractiveRequests();
    expect(pending).toHaveLength(1);
    const requestId = (pending[0].data as { requestId: string }).requestId;

    const accepted = await agentSession.handleAskUserQuestionResponse(requestId, { 0: '方案A' });
    expect(accepted).toBe(true);

    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('idle');
    });
    expect(resolvedPermission).toEqual({
      behavior: 'allow',
      updatedInput: { ...QUESTION_INPUT, answers: { 0: '方案A' } },
    });
    expect(agentSession.getPendingInteractiveRequests()).toHaveLength(0);
  });

  it('clears dangling questions and broadcasts expired when the turn errors out', async () => {
    const session = await store.createSession(workspace);
    queryMock.mockImplementationOnce((queryArgs: {
      options: {
        abortController: AbortController;
        canUseTool: (name: string, input: unknown, check: { signal: AbortSignal }) => Promise<unknown>;
      };
    }) => ({
      async *[Symbol.asyncIterator]() {
        yield assistantTextFrame('ask-err-1', '需要确认一个方案');
        // 模拟真实 SDK：模型发起 AskUserQuestion → canUseTool 挂起等待用户。
        void queryArgs.options.canUseTool(
          'AskUserQuestion',
          QUESTION_INPUT,
          { signal: queryArgs.options.abortController.signal },
        );
        // 上游在用户作答前出错（网关 500 / 流中断）。
        throw new Error('gateway exploded mid-turn');
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('推进');
    expect(result.accepted).toBe(true);

    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('error');
    });
    expect(broadcastEvents()).toContain('ask-user-question:request');
    // turn 已死：提问必须随之清空，并通知渲染层撤卡。
    expect(broadcastEvents()).toContain('ask-user-question:expired');
    expect(agentSession.getPendingInteractiveRequests()).toHaveLength(0);
  });

  it('expires the pending question exactly once when the turn is interrupted', async () => {
    const session = await store.createSession(workspace);
    queryMock.mockImplementationOnce((queryArgs: {
      options: {
        abortController: AbortController;
        canUseTool: (name: string, input: unknown, check: { signal: AbortSignal }) => Promise<unknown>;
      };
    }) => ({
      async *[Symbol.asyncIterator]() {
        yield assistantTextFrame('ask-abort-1', '需要确认一个方案');
        void queryArgs.options.canUseTool(
          'AskUserQuestion',
          QUESTION_INPUT,
          { signal: queryArgs.options.abortController.signal },
        );
        // SDK 流挂死：提问悬置，等待中断触发 abort。
        await new Promise(() => undefined);
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('推进');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(broadcastEvents()).toContain('ask-user-question:request');
    });

    await agentSession.interruptCurrentResponse();

    // abort 监听器失效提问；看门狗兜底对已空 Map 必须 no-op（不重复广播）。
    const expiredEvents = broadcastEvents().filter((event) => event === 'ask-user-question:expired');
    expect(expiredEvents).toHaveLength(1);
    expect(agentSession.getPendingInteractiveRequests()).toHaveLength(0);
  });

  it('clears dangling questions when the session is re-initialized', async () => {
    const session = await store.createSession(workspace);
    queryMock.mockImplementationOnce((queryArgs: {
      options: {
        abortController: AbortController;
        canUseTool: (name: string, input: unknown, check: { signal: AbortSignal }) => Promise<unknown>;
      };
    }) => ({
      async *[Symbol.asyncIterator]() {
        yield assistantTextFrame('ask-reinit-1', '需要确认一个方案');
        void queryArgs.options.canUseTool(
          'AskUserQuestion',
          QUESTION_INPUT,
          { signal: queryArgs.options.abortController.signal },
        );
        await new Promise(() => undefined);
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('推进');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(agentSession.getPendingInteractiveRequests()).toHaveLength(1);
    });

    // 侧车重初始化（如崩溃恢复）：悬挂提问不得跨初始化存活。
    await agentSession.initializeAgent(workspace, null, session.id);

    expect(broadcastEvents()).toContain('ask-user-question:expired');
    expect(agentSession.getPendingInteractiveRequests()).toHaveLength(0);
  });

  it('sweeps dangling questions when the stream completes without an answer', async () => {
    const session = await store.createSession(workspace);
    queryMock.mockImplementationOnce((queryArgs: {
      options: {
        abortController: AbortController;
        canUseTool: (name: string, input: unknown, check: { signal: AbortSignal }) => Promise<unknown>;
      };
    }) => ({
      async *[Symbol.asyncIterator]() {
        yield assistantTextFrame('ask-sweep-1', '需要确认一个方案');
        // 罕见但真实：流在提问未决时非异常收尾。
        void queryArgs.options.canUseTool(
          'AskUserQuestion',
          QUESTION_INPUT,
          { signal: queryArgs.options.abortController.signal },
        );
        yield { type: 'result', subtype: 'success', result: '已收尾' };
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('推进');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('idle');
    });

    expect(broadcastEvents()).toContain('ask-user-question:expired');
    expect(agentSession.getPendingInteractiveRequests()).toHaveLength(0);
  });
});
