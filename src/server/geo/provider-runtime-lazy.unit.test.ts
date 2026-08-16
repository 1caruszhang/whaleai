import { describe, expect, it, vi } from 'vitest';

// GD-8② 回归：provider-runtime 在 bundle 顶层只捕获运行时 secret，绝不能
// 构造 GEO Provider 客户端。若 createGeoProviderCapabilities 在模块求值期被
// 调用（顶层初始化），下面的 mock 会在 import 阶段直接抛错，测试文件加载
// 失败；能力对象只能在第一次显式获取时构造（惰性），且同一进程内复用。
vi.mock('./provider-capabilities', () => ({
  captureGeoProviderRuntimeSecrets: vi.fn(() => ({ deepseekApiKey: undefined })),
  createGeoProviderCapabilities: vi.fn(() => {
    throw new Error('provider clients must be built lazily, not at module top level');
  }),
}));

const { getXiaojingGeoProviderCapabilities } = await import('./provider-runtime');

describe('GEO provider runtime stays lazy at module top level (GD-8②)', () => {
  it('imports without constructing provider clients', () => {
    // 到这里 import 已成功 —— 顶层没有触发 createGeoProviderCapabilities。
    expect(typeof getXiaojingGeoProviderCapabilities).toBe('function');
  });

  it('defers client construction to the first explicit call', () => {
    expect(() => getXiaojingGeoProviderCapabilities()).toThrow(
      'provider clients must be built lazily',
    );
  });
});
