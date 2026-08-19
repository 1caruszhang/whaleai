import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// GEO 开发直连密钥的旧传输名：主 Agent 不得消费它（付费产品只有网关
// 一条路），本测试显式注入它来证明这一点。
const LEGACY_DEEPSEEK_KEY_ENV = 'XIAOJING_DEEPSEEK_API_KEY';

// 回归（P1-1）：主 Agent 凭据缺失时 runTurn 必须 fail-fast——广播明确
// 原因、进入 error 状态、不启动 SDK query。修复前缺失被推迟成 SDK 的
// 隐晦 401。凭据在 Sidecar 出生时一次性捕获，本测试在无账号 admission
// 的环境导入。付费产品只有网关一条路：旧 DeepSeek 直连凭据即使存在
// （本测试显式注入）也不得救活主 Agent。

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ name: 'xiaojing-geo', tools: [] })),
  tool: vi.fn((name: string) => ({ name })),
}));

vi.mock('../sse', () => ({
  broadcast: vi.fn(),
}));

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let originalCredential: string | undefined;
let originalGatewayBaseUrl: string | undefined;
let originalAccountToken: string | undefined;
let agentSession: typeof import('../agent-session');
let store: typeof import('../SessionStore');
let queryMock: ReturnType<typeof vi.fn>;
let broadcastMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-credential-missing-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-credential-ws-'));
  originalHome = process.env.HOME;
  originalCredential = process.env[LEGACY_DEEPSEEK_KEY_ENV];
  originalGatewayBaseUrl = process.env.XIAOJING_GATEWAY_BASE_URL;
  originalAccountToken = process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  process.env.HOME = testHome;
  // 旧直连凭据在场但不得生效：只有账号 admission 能解锁主 Agent。
  process.env[LEGACY_DEEPSEEK_KEY_ENV] = 'test-credential';
  delete process.env.XIAOJING_GATEWAY_BASE_URL;
  delete process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  vi.resetModules();
  agentSession = await import('../agent-session');
  store = await import('../SessionStore');
  queryMock = vi.mocked((await import('@anthropic-ai/claude-agent-sdk')).query as unknown as ReturnType<typeof vi.fn>);
  broadcastMock = vi.mocked((await import('../sse')).broadcast as unknown as ReturnType<typeof vi.fn>);
});

afterAll(() => {
  process.env.HOME = originalHome;
  if (originalCredential === undefined) delete process.env[LEGACY_DEEPSEEK_KEY_ENV];
  else process.env[LEGACY_DEEPSEEK_KEY_ENV] = originalCredential;
  if (originalGatewayBaseUrl === undefined) delete process.env.XIAOJING_GATEWAY_BASE_URL;
  else process.env.XIAOJING_GATEWAY_BASE_URL = originalGatewayBaseUrl;
  if (originalAccountToken === undefined) delete process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  else process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN = originalAccountToken;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('runTurn fails fast without the main agent credential', () => {
  it('refuses the turn with a clear agent error and never starts the SDK query', async () => {
    const session = await store.createSession(workspace);
    await agentSession.initializeAgent(workspace, null, session.id);
    queryMock.mockClear();
    broadcastMock.mockClear();

    const result = await agentSession.enqueueUserMessage('hello');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('error');
    });

    expect(queryMock).not.toHaveBeenCalled();
    const errorCall = broadcastMock.mock.calls.find(([event]) => event === 'chat:agent-error');
    expect(errorCall).toBeDefined();
    expect(String((errorCall?.[1] as { message?: string })?.message)).toContain('凭据缺失');

    // 用户消息已落盘（提问被记录），但没有 assistant 消息被生成。
    const messages = (await store.loadSessionTranscript(session.id)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });
});
