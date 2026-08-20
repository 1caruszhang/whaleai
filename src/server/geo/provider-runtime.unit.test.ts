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

// 请求级新鲜 token（Rust 代理/worker 经 x-xiaojing-account-token 头附带）：
// 头优先于 admission env token，无头回退 env——Sidecar 长跑后 env token
// 过期不得再杀死发布/监测的网关调用。
describe('provider-runtime request-level account token', () => {
  function captureBearerTokens(): string[] {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ code: 200, data: [] }), {
        status: 200,
      });
    }));
    return seen;
  }

  it('capabilities use the request-level token as gateway Bearer when present', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', 'https://gw.example.test');
    vi.stubEnv('XIAOJING_ACCOUNT_ACCESS_TOKEN', 'stale-env-token');
    const seen = captureBearerTokens();

    const runtime = await import('./provider-runtime');
    const capabilities =
      runtime.getXiaojingGeoProviderCapabilitiesForRequest('fresh-request-token');
    await capabilities.distribution.queryOrders('media', ['xj-test']);
    expect(seen).toEqual(['Bearer fresh-request-token']);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('falls back to the admission env token when no request token rides along', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', 'https://gw.example.test');
    vi.stubEnv('XIAOJING_ACCOUNT_ACCESS_TOKEN', 'env-token-1');
    const seen = captureBearerTokens();

    const runtime = await import('./provider-runtime');
    await runtime
      .getXiaojingGeoProviderCapabilitiesForRequest(undefined)
      .distribution.queryOrders('media', ['xj-test']);
    // 空白 token 与缺省同义。
    await runtime
      .getXiaojingGeoProviderCapabilitiesForRequest('   ')
      .distribution.queryOrders('media', ['xj-test']);
    expect(seen).toEqual(['Bearer env-token-1', 'Bearer env-token-1']);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('billing permit channel follows the same request-token-first rule', async () => {
    vi.resetModules();
    vi.stubEnv('XIAOJING_GATEWAY_BASE_URL', 'https://gw.example.test');
    vi.stubEnv('XIAOJING_ACCOUNT_ACCESS_TOKEN', 'env-token-1');
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return new Response(
        JSON.stringify({ balance: { total: 7, frozen: 0, available: 7 } }),
        { status: 200 },
      );
    }));

    const runtime = await import('./provider-runtime');
    await runtime
      .getXiaojingGeoBillingPermitChannelForRequest('fresh-request-token')
      ?.balance();
    await runtime.getXiaojingGeoBillingPermitChannelForRequest()?.balance();
    expect(seen).toEqual(['Bearer fresh-request-token', 'Bearer env-token-1']);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});
