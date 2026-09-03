import { beforeEach, describe, expect, it, vi } from 'vitest';

// 票 B 回归钉（spec：geo-service-composition Implementation Decision 7）：
// 闸门修订路径经 GateRevisionContext.requestAccountToken 携带请求级新鲜
// token 进组合根——sidecar 长跑后 env 单例过期，聊天里的修订不再依赖启动
// 单例。断言在能力层（mock provider-runtime，仓库既有模块 mock 习惯，
// 先例 service-composition.unit.test.ts）：真实注册的 article handler 经
// revisionGeoServices 构造服务时，能力 getter 收到的是请求 token 而非
// env 单例；且 revision-unbilled 裁决不因接入 token 顺手打开计费通道。

const capabilitiesForRequestSpy = vi.hoisted(() => vi.fn());
const billingForRequestSpy = vi.hoisted(() => vi.fn());
const articleCtorSpy = vi.hoisted(() => vi.fn());

vi.mock('./provider-runtime', () => {
  const capabilities = (token?: string) => ({
    keywordSearch: { __token: token ?? 'ENV_SINGLETON' },
    generation: { __token: token ?? 'ENV_SINGLETON' },
    reflection: { __token: token ?? 'ENV_SINGLETON' },
  });
  return {
    getXiaojingGeoProviderCapabilitiesForRequest:
      capabilitiesForRequestSpy.mockImplementation(capabilities),
    getXiaojingGeoBillingPermitChannelForRequest:
      billingForRequestSpy.mockImplementation((token?: string) =>
        token
          ? { __channel: 'request', token }
          : { __channel: 'singleton' }),
  };
});

vi.mock('./article-generation', () => {
  class ArticleGenerationService {
    readonly received: unknown[];
    constructor(...received: unknown[]) {
      this.received = received;
      articleCtorSpy(this);
    }
    async latest() {
      return null;
    }
  }
  return {
    ArticleGenerationService,
    createArticlePort: vi.fn(() => ({ __port: 'article' })),
  };
});

const { dispatchGateRevision } = await import('./gate-revision');

interface CapturedArticleService {
  received: unknown[];
}

function lastArticleService(): CapturedArticleService {
  const instance = articleCtorSpy.mock.calls.at(-1)?.[0] as
    | CapturedArticleService
    | undefined;
  expect(instance, '修订分发必须经组合根构造 articleService').toBeDefined();
  return instance!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('闸门修订路径的请求级 token（票 B）', () => {
  it('context.requestAccountToken 经组合根传入能力层：服务持有请求 token 而非 env 单例', async () => {
    const receipt = await dispatchGateRevision(
      'article',
      [
        {
          action: 'modify',
          targetId: 'article-1',
          value: { body: '新正文' },
          userInstruction: '把开头改得委婉一点',
        },
      ],
      {
        workspaceId: 'ws-revision-token',
        sessionId: 's-1',
        requestAccountToken: 'rev-request-token-1',
      },
    );
    // 分发确实穿过真实注册的 article handler 与组合根：latest 返回 null
    // → 结构化 target_not_found 回执，而不是分发层错误。
    expect(receipt.results[0]).toMatchObject({
      ok: false,
      code: 'target_not_found',
    });

    expect(capabilitiesForRequestSpy).toHaveBeenCalledWith(
      'rev-request-token-1',
    );
    // ArticleGenerationService ctor 参数序：identity, port, generation,
    // reflection, permits, imageCandidates。
    const service = lastArticleService();
    expect(
      (service.received[2] as { __token: string }).__token,
    ).toBe('rev-request-token-1');
    // 闸门修订不计费是显式裁决（revision-unbilled）：接入请求级 token
    // 不得顺手打开计费通道。
    expect(billingForRequestSpy).not.toHaveBeenCalled();
    expect(service.received[4]).toBeUndefined();
  });

  it('未携带请求 token 时回退启动单例口径（能力 getter 收到 undefined）', async () => {
    await dispatchGateRevision(
      'article',
      [
        {
          action: 'modify',
          targetId: 'article-1',
          value: { body: '新正文' },
          userInstruction: '改一下',
        },
      ],
      {
        workspaceId: 'ws-revision-fallback',
        sessionId: 's-1',
      },
    );
    expect(capabilitiesForRequestSpy).toHaveBeenCalledWith(undefined);
    const service = lastArticleService();
    expect(
      (service.received[2] as { __token: string }).__token,
    ).toBe('ENV_SINGLETON');
    expect(service.received[4]).toBeUndefined();
  });
});
