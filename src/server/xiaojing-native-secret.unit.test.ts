import { describe, expect, it, vi } from 'vitest';

describe('Xiaojing native DeepSeek transport capture', () => {
  it('captures and erases endpoint overrides alongside the secret', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_DEEPSEEK_API_KEY', ' deepseek-secret ');
    vi.stubEnv('XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL', 'https://gw.example.test');
    vi.stubEnv('XIAOJING_DEEPSEEK_OPENAI_BASE_URL', 'https://gw.example.test/openai');

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingDeepseekSecret()).toBe('deepseek-secret');
    expect(native.resolveXiaojingDeepseekAnthropicBaseUrl()).toBe(
      'https://gw.example.test',
    );
    expect(native.resolveXiaojingDeepseekOpenAiBaseUrl()).toBe(
      'https://gw.example.test/openai',
    );
    // 传输变量在模块求值期即被删除：通用子进程与环境诊断观察不到。
    expect(process.env.XIAOJING_DEEPSEEK_API_KEY).toBeUndefined();
    expect(process.env.XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.XIAOJING_DEEPSEEK_OPENAI_BASE_URL).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('leaves overrides undefined when the transport is not injected', async () => {
    vi.resetModules();
    delete process.env.XIAOJING_DEEPSEEK_API_KEY;
    delete process.env.XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL;
    delete process.env.XIAOJING_DEEPSEEK_OPENAI_BASE_URL;

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingDeepseekSecret()).toBeUndefined();
    expect(native.resolveXiaojingDeepseekAnthropicBaseUrl()).toBeUndefined();
    expect(native.resolveXiaojingDeepseekOpenAiBaseUrl()).toBeUndefined();
  });

  it('captures and erases the account admission transport (ticket 06)', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', ' https://api.jingshanai.com ');
    vi.stubEnv('XIAOJING_ACCOUNT_ACCESS_TOKEN', 'jwt-access-1');

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingGatewayBaseUrl()).toBe('https://api.jingshanai.com');
    expect(native.resolveXiaojingAccountAccessToken()).toBe('jwt-access-1');
    // 账号 token 在模块求值期即从环境删除：子进程继承与环境诊断观察不到。
    expect(process.env.XIAOJING_GATEWAY_BASE_URL).toBeUndefined();
    expect(process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('leaves account transport undefined without admission injection', async () => {
    vi.resetModules();
    delete process.env.XIAOJING_GATEWAY_BASE_URL;
    delete process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingGatewayBaseUrl()).toBeUndefined();
    expect(native.resolveXiaojingAccountAccessToken()).toBeUndefined();
  });
});
