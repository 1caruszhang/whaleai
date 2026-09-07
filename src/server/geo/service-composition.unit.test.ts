import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT } from '../../shared/geo/articleGeneration';

// 组合根直测（spec：geo-service-composition Testing Decisions）——只测外部
// 可观察行为：实例复用与重建、token/计费口径、配图候选池注入；不测内部
// 构造顺序与私有结构。测试注入沿用仓库习惯：mock provider-runtime 模块
// （先例：provider-runtime-lazy.unit.test.ts），不起真 sidecar。

const articleCtorSpy = vi.hoisted(() => vi.fn());
const brandPortSpy = vi.hoisted(() => vi.fn());
const listImageAssetsSpy = vi.hoisted(() => vi.fn());
const capabilitiesForRequestSpy = vi.hoisted(() => vi.fn());
const billingForRequestSpy = vi.hoisted(() => vi.fn());

vi.mock('./provider-runtime', () => {
  const capabilities = {
    keywordSearch: { __cap: 'keywordSearch' },
    generation: { __cap: 'generation' },
    embedding: { __cap: 'embedding' },
    distribution: { __cap: 'distribution' },
    extraction: { __cap: 'extraction' },
    reflection: { __cap: 'reflection' },
  };
  const singletonChannel = { __channel: 'singleton' };
  return {
    getXiaojingGeoProviderCapabilitiesForRequest: capabilitiesForRequestSpy.mockImplementation(
      (token?: string) => ({ ...capabilities, __token: token ?? null }),
    ),
    getXiaojingGeoBillingPermitChannelForRequest: billingForRequestSpy.mockImplementation(
      (token?: string) =>
        token ? { __channel: 'request', token } : singletonChannel,
    ),
  };
});

// 配图候选池断言（2026-08-31 零配图事故回归钉的口径）：事故根因是构造点
// 漏传 imageCandidates——直接在构造边界捕获入参并驱动池加载器，断言三条
// 路径（MCP／HTTP／闸门修订）取到的 articleService 都带着接通材料图片
// 资产的池。
vi.mock('./article-generation', () => {
  class ArticleGenerationService {
    readonly received: unknown[];
    constructor(...received: unknown[]) {
      this.received = received;
      articleCtorSpy(this);
    }
  }
  return {
    ArticleGenerationService,
    createArticlePort: vi.fn(() => ({ __port: 'article' })),
  };
});

vi.mock('./material-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./material-import')>();
  return {
    ...actual,
    createBrandMaterialPort: brandPortSpy.mockImplementation(
      (identity: unknown) => ({
        listImageAssets: listImageAssetsSpy,
        __identity: identity,
      }),
    ),
  };
});

const { geoServices } = await import('./service-composition');

/** 端口构造需要 Sidecar 身份（构造时读 env，无 I/O）；组合根服务字段是
 * 惰性构造，beforeAll 设置即可覆盖全部构造时点。 */
let originalSidecarId: string | undefined;

beforeAll(() => {
  originalSidecarId = process.env.XIAOJING_SIDECAR_ID;
  process.env.XIAOJING_SIDECAR_ID = 'unit-test-sidecar';
});

afterAll(() => {
  if (originalSidecarId === undefined) delete process.env.XIAOJING_SIDECAR_ID;
  else process.env.XIAOJING_SIDECAR_ID = originalSidecarId;
});

beforeEach(() => {
  vi.clearAllMocks();
  listImageAssetsSpy.mockResolvedValue([]);
});

interface CapturedArticleService {
  received: unknown[];
}

function capturedArticle(bundle: {
  article: unknown;
}): CapturedArticleService {
  return bundle.article as CapturedArticleService;
}

describe('geoServices 实例缓存（同身份＋同 token 复用同一实例）', () => {
  it('五个缓存服务在重复取包时逐字段复用同一实例', () => {
    const identity = { workspaceId: 'ws-reuse', sessionId: 's-1' };
    const first = geoServices(identity, { accountToken: 'token-a' });
    const second = geoServices(identity, { accountToken: 'token-a' });

    expect(second.questionPool).toBe(first.questionPool);
    expect(second.topicPlan).toBe(first.topicPlan);
    expect(second.article).toBe(first.article);
    expect(second.distribution).toBe(first.distribution);
    expect(second.baseline).toBe(first.baseline);
    // 同一服务包内重复取字段也保持同一实例。
    expect(second.questionPool).toBe(second.questionPool);
  });

  it('身份变化（工作区或会话）返回不同实例', () => {
    const base = geoServices(
      { workspaceId: 'ws-identity', sessionId: 's-1' },
      { accountToken: 'token-a' },
    );
    const otherWorkspace = geoServices(
      { workspaceId: 'ws-other', sessionId: 's-1' },
      { accountToken: 'token-a' },
    );
    const otherSession = geoServices(
      { workspaceId: 'ws-identity', sessionId: 's-2' },
      { accountToken: 'token-a' },
    );
    expect(otherWorkspace.questionPool).not.toBe(base.questionPool);
    expect(otherSession.questionPool).not.toBe(base.questionPool);
  });

  it('材料导入与发布预览端口不缓存：跨服务包逐次现构', () => {
    const identity = { workspaceId: 'ws-uncached', sessionId: 's-1' };
    const first = geoServices(identity);
    const second = geoServices(identity);
    // 包内 memo 保持字段稳定，跨包不复用（低频调用、场景参数各异）。
    expect(first.materialImport).toBe(first.materialImport);
    expect(first.publishPreview).toBe(first.publishPreview);
    expect(second.materialImport).not.toBe(first.materialImport);
    expect(second.publishPreview).not.toBe(first.publishPreview);
  });
});

describe('geoServices token 轮换（token 变化返回重建实例）', () => {
  it('token 变化后五个缓存服务全部重建', () => {
    const identity = { workspaceId: 'ws-rotate', sessionId: 's-1' };
    const before = geoServices(identity, { accountToken: 'token-a' });
    const after = geoServices(identity, { accountToken: 'token-b' });

    expect(after.questionPool).not.toBe(before.questionPool);
    expect(after.topicPlan).not.toBe(before.topicPlan);
    expect(after.article).not.toBe(before.article);
    expect(after.distribution).not.toBe(before.distribution);
    expect(after.baseline).not.toBe(before.baseline);
  });

  it('旧 token 不留缓存闭包：切回旧 token 得到的是重建实例，不是回收', () => {
    const identity = { workspaceId: 'ws-evict', sessionId: 's-1' };
    const first = geoServices(identity, { accountToken: 'token-a' }).questionPool;
    const rotated = geoServices(identity, { accountToken: 'token-b' }).questionPool;
    expect(rotated).toBeDefined();
    const backToOld = geoServices(identity, { accountToken: 'token-a' }).questionPool;
    expect(backToOld).not.toBe(first);
  });

  it('重建后的服务按新 token 取能力与计费通道', () => {
    const identity = { workspaceId: 'ws-capability', sessionId: 's-1' };
    expect(geoServices(identity, { accountToken: 'token-a' }).questionPool).toBeDefined();
    expect(geoServices(identity, { accountToken: 'token-b' }).questionPool).toBeDefined();

    const tokens = capabilitiesForRequestSpy.mock.calls.map(
      (call) => call[0],
    );
    expect(tokens).toEqual(['token-a', 'token-b']);
    const billingTokens = billingForRequestSpy.mock.calls.map(
      (call) => call[0],
    );
    expect(billingTokens).toEqual(['token-a', 'token-b']);
  });
});

describe('geoServices 计费口径（闸门修订不计费为显式裁决）', () => {
  it("revision-unbilled 构造不接计费通道，且不污染 default 变体缓存", () => {
    const identity = { workspaceId: 'ws-unbilled', sessionId: 's-1' };
    billingForRequestSpy.mockClear();
    const unbilled = geoServices(identity, { billing: 'revision-unbilled' });
    expect(unbilled.article).toBeDefined();
    expect(unbilled.questionPool).toBeDefined();
    expect(billingForRequestSpy).not.toHaveBeenCalled();
    // 修订变体不进缓存：default 取包拿到的是自己的实例与计费通道。
    const defaulted = geoServices(identity);
    expect(defaulted.questionPool).not.toBe(unbilled.questionPool);
    expect(defaulted.article).not.toBe(unbilled.article);
    billingForRequestSpy.mockClear();
    const freshDefault = geoServices(
      { workspaceId: 'ws-unbilled-default', sessionId: 's-1' },
    );
    expect(freshDefault.questionPool).toBeDefined();
    expect(billingForRequestSpy).toHaveBeenCalledTimes(1);
  });
});

describe('geoServices 配图候选池（2026-08-31 零配图事故回归钉）', () => {
  const PATHS = [
    {
      label: 'MCP（请求级 token）',
      identity: { workspaceId: 'ws-img-mcp', sessionId: 's-1' },
      options: { accountToken: 'token-a' } as const,
      expectedPermits: { __channel: 'request', token: 'token-a' },
    },
    {
      label: 'HTTP 面板路由（未携带请求 token 头时回退单例）',
      identity: { workspaceId: 'ws-img-http', sessionId: 's-1' },
      options: undefined,
      expectedPermits: { __channel: 'singleton' },
    },
    {
      label: '闸门修订（revision-unbilled）',
      identity: { workspaceId: 'ws-img-rev', sessionId: 's-1' },
      options: { billing: 'revision-unbilled' } as const,
      expectedPermits: undefined,
    },
  ] as const;

  it.each(PATHS.map((path) => [path.label, path] as const))(
    '%s 的 articleService 接通配图候选池',
    async (_label, path) => {
      const bundle = geoServices(path.identity, path.options);
      const captured = capturedArticle(bundle);
      // 构造参数：identity, persistence, generation, reflection, permits, imageCandidates
      expect(captured.received[0]).toEqual(path.identity);
      expect(captured.received[4]).toEqual(path.expectedPermits);

      const pool = captured.received[5] as () => Promise<unknown[]>;
      expect(typeof pool).toBe('function');
      brandPortSpy.mockClear();
      listImageAssetsSpy.mockClear();
      await expect(pool()).resolves.toEqual([]);
      expect(brandPortSpy).toHaveBeenCalledWith(path.identity);
      expect(listImageAssetsSpy).toHaveBeenCalledTimes(1);
      expect(listImageAssetsSpy).toHaveBeenCalledWith({
        limit: ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT,
      });
    },
  );

  it('材料导入的请求级 token 传入能力与计费通道（后台导入入队捕获语义）', () => {
    const identity = { workspaceId: 'ws-import', sessionId: 's-1' };
    const bundle = geoServices(identity, { accountToken: 'token-import' });
    expect(bundle.materialImport).toBeDefined();
    expect(capabilitiesForRequestSpy).toHaveBeenCalledWith('token-import');
    expect(billingForRequestSpy).toHaveBeenCalledWith('token-import');
  });

  it('图片重扫预算透传：rescanBudgetMs 在场时不接计费通道', () => {
    const identity = { workspaceId: 'ws-rescan', sessionId: 's-1' };
    billingForRequestSpy.mockClear();
    const bundle = geoServices(identity, {
      accountToken: 'token-rescan',
      rescanBudgetMs: 25_000,
    });
    expect(bundle.materialImport).toBeDefined();
    expect(capabilitiesForRequestSpy).toHaveBeenCalledWith('token-rescan');
    expect(billingForRequestSpy).not.toHaveBeenCalled();
  });
});
