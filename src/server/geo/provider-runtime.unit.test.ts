import { describe, expect, it, vi } from 'vitest';

// 回归：账号 admission（XIAOJING_GATEWAY_BASE_URL + XIAOJING_ACCOUNT_ACCESS_TOKEN）
// 的捕获 owner 是 xiaojing-native-secret（主 Agent 同用一份）；provider-runtime
// 必须经其 resolver 合并，而不是自己再捕获一次。此前双捕获存在模块加载顺序
// 竞争：先求值者擦掉 env，后到者丢网关模式，GEO 抽取报「extraction 能力尚未配置」。

describe('provider-runtime account admission merge', () => {
  it('enters gateway mode even when xiaojing-native-secret captured the env first', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', 'https://gw.example.test');
    vi.stubEnv('XIAOJING_ACCOUNT_ACCESS_TOKEN', 'jwt-access-1');

    // 模拟真实加载顺序：native-secret 先求值，env 即被擦除。
    await import('../xiaojing-native-secret');
    expect(process.env.XIAOJING_GATEWAY_BASE_URL).toBeUndefined();
    expect(process.env.XIAOJING_ACCOUNT_ACCESS_TOKEN).toBeUndefined();

    const runtime = await import('./provider-runtime');
    // 网关模式成立 ⇔ permit 通道可用（需要 gatewayBaseUrl + accountAccessToken）。
    expect(runtime.getXiaojingGeoBillingPermitChannel()).toBeDefined();
    vi.unstubAllEnvs();
  });
});
