import { describe, expect, it, vi } from 'vitest';

describe('Xiaojing native secret transport capture', () => {
  it('captures and erases the OpenAI endpoint override alongside the secret', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_DEEPSEEK_API_KEY', ' deepseek-secret ');
    vi.stubEnv('XIAOJING_DEEPSEEK_OPENAI_BASE_URL', 'https://gw.example.test/openai');

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingDeepseekSecret()).toBe('deepseek-secret');
    expect(native.resolveXiaojingDeepseekOpenAiBaseUrl()).toBe(
      'https://gw.example.test/openai',
    );
    // 传输变量在模块求值期即被删除：通用子进程与环境诊断观察不到。
    expect(process.env.XIAOJING_DEEPSEEK_API_KEY).toBeUndefined();
    expect(process.env.XIAOJING_DEEPSEEK_OPENAI_BASE_URL).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('leaves overrides undefined when the transport is not injected', async () => {
    vi.resetModules();
    delete process.env.XIAOJING_DEEPSEEK_API_KEY;
    delete process.env.XIAOJING_DEEPSEEK_OPENAI_BASE_URL;

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingDeepseekSecret()).toBeUndefined();
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

  function clearMainAgentAuthEnvs() {
    delete process.env.XIAOJING_DEEPSEEK_API_KEY;
    delete process.env.XIAOJING_GATEWAY_BASE_URL;
    delete process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN;
  }

  it('resolves gateway auth when the account admission is complete (ticket 07)', async () => {
    vi.resetModules();
    clearMainAgentAuthEnvs();
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', 'https://api.jingshanai.com');
    vi.stubEnv('XIAOJING_ACCOUNT_ACCESS_TOKEN', 'jwt-access-1');
    // 旧直连凭据即使存在也不得参与主 Agent 鉴权。
    vi.stubEnv('XIAOJING_DEEPSEEK_API_KEY', 'deepseek-secret');

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingMainAgentAuth()).toEqual({
      baseUrl: 'https://api.jingshanai.com',
      token: 'jwt-access-1',
    });
    vi.unstubAllEnvs();
  });

  it('reports missing when only the legacy direct credential exists', async () => {
    vi.resetModules();
    clearMainAgentAuthEnvs();
    // 付费产品没有直连回落：旧 DeepSeek 凭据不得救活主 Agent。
    vi.stubEnv('XIAOJING_DEEPSEEK_API_KEY', 'deepseek-secret');

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingMainAgentAuth()).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('reports missing when the account token is absent (logged out)', async () => {
    vi.resetModules();
    clearMainAgentAuthEnvs();
    // 只有网关地址、没有账号 token（未登录）同样视为缺失。
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', 'https://api.jingshanai.com');

    const native = await import('./xiaojing-native-secret');

    expect(native.resolveXiaojingMainAgentAuth()).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
