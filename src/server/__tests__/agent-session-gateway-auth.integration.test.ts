import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 票 07：账号 admission（XIAOJING_GATEWAY_BASE_URL + XIAOJING_ACCOUNT_ACCESS_TOKEN）
// 齐备时，主 Agent SDK 必须指向网关 Anthropic 兼容代理（后端 /v1/messages），
// 账号 access token 作为 Bearer；不得再回落 DeepSeek 直连或策略表默认端点。

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({ name: 'xiaojing-geo', tools: [] })),
  tool: vi.fn((name: string) => ({ name })),
}));

vi.mock('../sse', () => ({
  broadcast: vi.fn(),
}));

const GATEWAY_ROOT = 'https://gw.example.test/';
const ACCOUNT_TOKEN = 'jwt-access-1';

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let originalGatewayBaseUrl: string | undefined;
let originalAccountToken: string | undefined;
let originalCredential: string | undefined;
let agentSession: typeof import('../agent-session');
let store: typeof import('../SessionStore');
let queryMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-gateway-auth-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-gateway-auth-ws-'));
  originalHome = process.env.HOME;
  originalGatewayBaseUrl = process.env.XIAOJING_GATEWAY_BASE_URL;
  originalAccountToken = process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  originalCredential = process.env.XIAOJING_DEEPSEEK_API_KEY;
  process.env.HOME = testHome;
  process.env.XIAOJING_GATEWAY_BASE_URL = GATEWAY_ROOT;
  process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN = ACCOUNT_TOKEN;
  delete process.env.XIAOJING_DEEPSEEK_API_KEY;
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
  if (originalCredential === undefined) delete process.env.XIAOJING_DEEPSEEK_API_KEY;
  else process.env.XIAOJING_DEEPSEEK_API_KEY = originalCredential;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('main agent gateway auth (ticket 07)', () => {
  it('targets the gateway Anthropic proxy with the account access token', async () => {
    const session = await store.createSession(workspace);
    let capturedEnv: Record<string, string | undefined> | undefined;
    queryMock.mockImplementationOnce(((params: {
      options: { env: Record<string, string | undefined> };
    }) => {
      capturedEnv = params.options.env;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'assistant',
            uuid: 'sdk-gw-1',
            message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          };
          yield { type: 'result', subtype: 'success', result: 'ok' };
        },
        close() {},
      };
    }) as never);

    await agentSession.initializeAgent(workspace, null, session.id);
    const result = await agentSession.enqueueUserMessage('hello');
    expect(result.accepted).toBe(true);
    await vi.waitFor(() => {
      expect(agentSession.getAgentState().sessionState).toBe('idle');
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    // 尾斜杠归一化：SDK 会再拼 /v1/messages。
    expect(capturedEnv?.ANTHROPIC_BASE_URL).toBe('https://gw.example.test');
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe(ACCOUNT_TOKEN);
    expect(capturedEnv?.ANTHROPIC_API_KEY).toBe('');
  });
});
