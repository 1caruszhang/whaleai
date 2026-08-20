import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// 性能回归（用户感知「思考过程显示很卡」）：content_block_delta 每 token
// 触发一次全量 structuredClone + broadcast，消息随轮次单调变长后整体
// O(n²)。delta 路径改为标脏 + 80ms trailing-edge 合并；content_block_start/
// stop、assistant 段落、message-complete/stopped 等生命周期事件立即 flush。
// 另：interrupt 后 for-await 挂死时 stopping 永不解除（isBusy 卡死会话
// 删除），由 15s 看门狗强制落 error 兜底。

const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ name: 'xiaojing-geo', tools: [] })),
  tool: vi.fn((name: string) => ({ name })),
}));

vi.mock('../sse', () => ({ broadcast: broadcastMock }));

type WireContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  isComplete?: boolean;
};

type MessageUpdateData = { message: { content: WireContentBlock[] } };

function streamEvent(event: Record<string, unknown>) {
  return { type: 'stream_event', event };
}

function textDelta(text: string, index = 0) {
  return streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
}

function blockStart(index: number, contentBlock: Record<string, unknown>) {
  return streamEvent({ type: 'content_block_start', index, content_block: contentBlock });
}

function blockStop(index: number) {
  return streamEvent({ type: 'content_block_stop', index });
}

function messageUpdateCalls(): Array<[string, MessageUpdateData]> {
  return (broadcastMock.mock.calls as Array<[string, MessageUpdateData]>)
    .filter(([event]) => event === 'chat:message-update');
}

function messageText(data: MessageUpdateData): string {
  return data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('');
}

/** 不依赖 setTimeout 的轮询（看门狗用例会冻结 setTimeout）。 */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('condition not met in time');
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
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-streaming-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-streaming-ws-'));
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

afterEach(() => {
  vi.useRealTimers();
  broadcastMock.mockClear();
  queryMock.mockReset();
});

describe('streaming message-update throttling', () => {
  it('coalesces delta bursts and flushes the trailing snapshot on completion', async () => {
    const session = await store.createSession(workspace);
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield blockStart(0, { type: 'text' });
        for (let index = 0; index < 50; index += 1) yield textDelta(`t${index}-`);
        // 跨越一个合并窗口，让 trailing 定时器有机会发一次中间快照。
        await new Promise(resolve => setTimeout(resolve, agentSession.STREAM_FLUSH_INTERVAL_MS * 3));
        for (let index = 50; index < 100; index += 1) yield textDelta(`t${index}-`);
        yield { type: 'result', subtype: 'success', result: '' };
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('stream please');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('idle');
    });

    const updates = messageUpdateCalls();
    // 100 个 delta 合并为个位数快照：start 1 次 + 中间 flush + 收尾 flush。
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.length).toBeLessThanOrEqual(5);
    // 收尾 flush：最后一个 message-update 已携带全部 delta 文本。
    const finalText = messageText(updates[updates.length - 1][1]);
    expect(finalText.startsWith('t0-')).toBe(true);
    expect(finalText.endsWith('t99-')).toBe(true);
    expect(finalText).toContain('t50-');
    expect(broadcastMock.mock.calls.some(([event]) => event === 'chat:message-complete')).toBe(true);
  });

  it('flushes pending deltas before publishing content_block_stop immediately', async () => {
    const session = await store.createSession(workspace);
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });
    let stopConsumed = false;
    let pendingFlushedAtStop = false;
    let stoppedSnapshotAtStop = false;
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield blockStart(0, { type: 'thinking' });
        for (let index = 0; index < 5; index += 1) {
          yield streamEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: `h${index}` },
          });
        }
        yield blockStop(0);
        // for-await 拉下一个值时，handleStreamEvent(stop) 已同步返回；
        // 此刻断言快照不经过任何定时器等待，throttled 实现在这里必然露馅。
        const updates = messageUpdateCalls();
        const last = updates[updates.length - 1]?.[1];
        const previous = updates[updates.length - 2]?.[1];
        stoppedSnapshotAtStop = Boolean(
          last?.message.content.some(block => block.type === 'thinking' && block.isComplete === true),
        );
        // 积压的 delta 先发：倒数第二个快照带完整 thinking 文本且未标记完成。
        pendingFlushedAtStop = Boolean(
          previous
            && previous.message.content.some(block => (
              block.type === 'thinking' && block.thinking === 'h0h1h2h3h4' && block.isComplete !== true
            )),
        );
        stopConsumed = true;
        await gate;
        yield { type: 'result', subtype: 'success', result: '' };
      },
      close() {},
    }) as never);
    await agentSession.initializeAgent(workspace, null, session.id);

    const result = await agentSession.enqueueUserMessage('think please');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(stopConsumed).toBe(true);
    });
    expect(stoppedSnapshotAtStop).toBe(true);
    expect(pendingFlushedAtStop).toBe(true);

    releaseGate();
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('idle');
    });
  });
});

describe('stopping watchdog', () => {
  it('forces state to error when the stream never settles after interrupt', async () => {
    // 只冻结 setTimeout：看门狗与流式合并都走它，文件 IO 与 setImmediate 保持真实。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await store.createSession(workspace);
    await agentSession.initializeAgent(workspace, null, session.id);
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          uuid: 'sdk-hang-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'partial before hang' }] },
        };
        // SDK 流挂死：abort 后也永不 settle。
        await new Promise(() => undefined);
      },
      close() {},
    }) as never);

    const result = await agentSession.enqueueUserMessage('hang please');
    expect(result.accepted).toBe(true);
    await waitUntil(() => agentSession.getAgentState().sessionState === 'running');

    await agentSession.interruptCurrentResponse();
    expect(agentSession.getAgentState().sessionState).toBe('stopping');

    await vi.advanceTimersByTimeAsync(agentSession.STOPPING_WATCHDOG_MS - 100);
    expect(agentSession.getAgentState().sessionState).toBe('stopping');

    await vi.advanceTimersByTimeAsync(100);
    expect(agentSession.getAgentState().sessionState).toBe('error');
    const errorEvent = broadcastMock.mock.calls.find(([event]) => event === 'chat:agent-error');
    expect(errorEvent).toBeDefined();
    // isBusy 解锁：会话删除与新消息不再被挂死的 stopping 阻塞。
    expect(agentSession.isSessionBusy()).toBe(false);
  });

  it('旧 turn 晚 settle 不清新一轮 turn 的 flush 定时器与看门狗', async () => {
    // 回归：看门狗强终止后悬挂的旧 runTurn 若之后 settle，其 finally/catch
    // 曾无条件 cancelStreamFlush/clearStoppingWatchdog 并覆写共享状态，
    // 误伤新一轮 turn。定时器与终止处理按 turnId 归属后，旧 turn 晚 settle
    // 必须对新 turn 完全无影响。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const session = await store.createSession(workspace);
    await agentSession.initializeAgent(workspace, null, session.id);

    // Turn A：流挂死，gateA 释放后才抛错 settle。
    let releaseA: () => void = () => undefined;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    let aFinished = false;
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        try {
          yield {
            type: 'assistant',
            uuid: 'sdk-stale-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'stale partial' }] },
          };
          await gateA;
          throw new Error('stream aborted after watchdog');
        } finally {
          aFinished = true;
        }
      },
      close() {},
    }) as never);

    const first = await agentSession.enqueueUserMessage('turn A');
    expect(first.accepted).toBe(true);
    await waitUntil(() => agentSession.getAgentState().sessionState === 'running');
    await agentSession.interruptCurrentResponse();
    await vi.advanceTimersByTimeAsync(agentSession.STOPPING_WATCHDOG_MS);
    expect(agentSession.getAgentState().sessionState).toBe('error');

    // Turn B：先留下一笔未 flush 的 delta（80ms 合并定时器 pending），再
    // interrupt 武装 B 的看门狗——两样都是旧 turn settle 时曾误清的对象。
    queryMock.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield blockStart(0, { type: 'text' });
        yield textDelta('hello-b');
        await new Promise(() => undefined);
      },
      close() {},
    }) as never);
    const second = await agentSession.enqueueUserMessage('turn B');
    expect(second.accepted).toBe(true);
    await waitUntil(() => agentSession.getAgentState().sessionState === 'running');
    await agentSession.interruptCurrentResponse();
    expect(agentSession.getAgentState().sessionState).toBe('stopping');
    broadcastMock.mockClear();

    // 旧 turn A 此刻晚 settle：不得动 B 的状态、flush 定时器与看门狗。
    releaseA();
    await waitUntil(() => aFinished);
    for (let index = 0; index < 10; index += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(agentSession.getAgentState().sessionState).toBe('stopping');
    expect(broadcastMock.mock.calls.some(([event]) => event === 'chat:message-stopped')).toBe(false);
    // B 的 delta 尚未 flush（A 的 settle 不得提前冲掉/取消 B 的合并定时器）。
    expect(messageUpdateCalls().some(([, data]) => messageText(data).includes('hello-b'))).toBe(false);

    // B 的 flush 定时器仍在：合并窗口到点后正常发出积压快照。
    await vi.advanceTimersByTimeAsync(agentSession.STREAM_FLUSH_INTERVAL_MS);
    expect(messageUpdateCalls().some(([, data]) => messageText(data).includes('hello-b'))).toBe(true);

    // B 的看门狗仍在：15s 后照常强终止 B，而不是被 A 的 settle 清掉。
    await vi.advanceTimersByTimeAsync(agentSession.STOPPING_WATCHDOG_MS);
    expect(agentSession.getAgentState().sessionState).toBe('error');
    const errorEvent = broadcastMock.mock.calls.find(([event]) => event === 'chat:agent-error');
    expect(errorEvent).toBeDefined();
  });
});
