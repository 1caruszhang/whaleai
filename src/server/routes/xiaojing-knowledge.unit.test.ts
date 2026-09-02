import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 面板材料腿的计费 401 回归：后台抽取队列与存量重扫必须用「入队请求」的
// 账号 token 构造 provider 能力与计费 permit 通道。sidecar 启动时注入的
// env token 约 15 分钟过期，长会话里面板导入/重试曾全部落 401
// token_expired → material_billing_failed（2026-09-01 实测复现）。

const sentinels = vi.hoisted(() => {
  const capabilitiesForRequest = { extraction: 'extraction@request' };
  const permitForRequest = { apply: () => Promise.resolve() };
  const capabilitiesForImport = vi.fn();
  const permitForImport = vi.fn();
  const serviceConstructions: Array<{
    extraction: unknown;
    keywordSearch?: unknown;
    permits?: unknown;
  }> = [];
  const processCalls: string[] = [];
  const rescanCalls: number[] = [];
  return {
    capabilitiesForRequest,
    permitForRequest,
    capabilitiesForImport,
    permitForImport,
    serviceConstructions,
    processCalls,
    rescanCalls,
  };
});

vi.mock('../geo/provider-runtime', () => ({
  getXiaojingGeoProviderCapabilitiesForRequest: (token?: string) => {
    sentinels.capabilitiesForImport(token);
    return sentinels.capabilitiesForRequest;
  },
  getXiaojingGeoBillingPermitChannelForRequest: (token?: string) => {
    sentinels.permitForImport(token);
    return sentinels.permitForRequest;
  },
}));

vi.mock('../geo/material-import', () => ({
  MaterialImportService: class {
    constructor(
      _identity: unknown,
      _port: unknown,
      extraction: unknown,
      _authority: unknown,
      _websiteDeps: unknown,
      keywordSearch: unknown,
      _extractionTimeoutMs: unknown,
      permits?: unknown,
    ) {
      sentinels.serviceConstructions.push({ extraction, keywordSearch, permits });
    }

    process = vi.fn(async (materialId: string) => {
      sentinels.processCalls.push(materialId);
      return { ok: true, candidateIds: [] };
    });

    rescanWorkspaceDocumentImages = vi.fn(async (input: { totalBudgetMs: number }) => {
      sentinels.rescanCalls.push(input.totalBudgetMs);
      return { scanned: 0 };
    });
  },
  createBrandMaterialPort: () => ({
    get: async () => ({ id: 'mat-retry', displayName: 'retry.txt' }),
    importFile: async (sourcePath: string) => ({ id: `mat-${sourcePath}` }),
    importText: async () => ({ id: 'mat-text' }),
  }),
  materialLogProjection: (input: unknown) => input,
  fetchWebsiteMaterial: vi.fn(),
}));

vi.mock('./xiaojing-shared', () => ({
  getRuntimeSessionIdForRequest: () => 'session-test',
  // 与真实实现同口径：Rust 代理附带的进程内头，trim 后空值归 undefined。
  requestAccountAccessToken: (request: Request) =>
    request.headers.get('x-xiaojing-account-token')?.trim() || undefined,
}));

vi.mock('../geo/knowledge-authority', () => ({
  createKnowledgeAuthority: () => ({}),
}));

vi.mock('../geo/operation-progress', () => ({
  recordGeoOperationMilestone: vi.fn(async () => {}),
  quoteGeoNextStepForGateKind: vi.fn(async () => '下一步'),
}));

vi.mock('../xiaojing-reminder-send', () => ({
  sendXiaojingMessage: vi.fn(async () => ({ success: true })),
}));

const { handleXiaojingKnowledgeRoute } = await import('./xiaojing-knowledge');

// 绝对路径让 basename(resolve(...)) 的 workspaceId 判定与平台无关。
const workspacePath = join(tmpdir(), 'brand-knowledge-token-test');
const identityBody = { workspaceId: 'brand-knowledge-token-test', sessionId: 'session-test' };

function post(pathname: string, body: unknown, token?: string): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-xiaojing-account-token': token } : {}),
    },
  });
}

beforeEach(() => {
  sentinels.capabilitiesForImport.mockClear();
  sentinels.permitForImport.mockClear();
  sentinels.serviceConstructions.length = 0;
  sentinels.processCalls.length = 0;
  sentinels.rescanCalls.length = 0;
});

describe('面板材料路由的请求级账号 token 透传', () => {
  it('retry 入队的后台抽取用请求级 token 构造能力与计费通道', async () => {
    const response = await handleXiaojingKnowledgeRoute(
      '/api/xiaojing/materials/retry',
      post('/api/xiaojing/materials/retry', { ...identityBody, materialId: 'mat-retry' }, 'token-fresh-1'),
      { workspacePath },
    );
    expect(response?.status).toBe(200);

    await vi.waitFor(() => {
      expect(sentinels.processCalls).toEqual(['mat-retry']);
    });
    expect(sentinels.capabilitiesForImport).toHaveBeenCalledWith('token-fresh-1');
    expect(sentinels.permitForImport).toHaveBeenCalledWith('token-fresh-1');
    expect(sentinels.serviceConstructions.at(-1)).toMatchObject({
      extraction: sentinels.capabilitiesForRequest.extraction,
      permits: sentinels.permitForRequest,
    });
  });

  it('import 入队的批量抽取同样携带入队请求的 token', async () => {
    const response = await handleXiaojingKnowledgeRoute(
      '/api/xiaojing/materials/import',
      post('/api/xiaojing/materials/import', {
        ...identityBody,
        input: { kind: 'files', sourcePaths: ['a.pdf', 'b.docx'] },
      }, 'token-fresh-2'),
      { workspacePath },
    );
    expect(response?.status).toBe(200);

    await vi.waitFor(() => {
      expect(sentinels.processCalls.length).toBe(2);
    });
    expect(sentinels.capabilitiesForImport).toHaveBeenCalledWith('token-fresh-2');
    expect(sentinels.permitForImport).toHaveBeenCalledWith('token-fresh-2');
    expect(sentinels.serviceConstructions.at(-1)?.permits).toBe(sentinels.permitForRequest);
  });

  it('rescan-images 用请求级 token 构造 extraction 能力', async () => {
    const response = await handleXiaojingKnowledgeRoute(
      '/api/xiaojing/materials/rescan-images',
      post('/api/xiaojing/materials/rescan-images', identityBody, 'token-fresh-3'),
      { workspacePath },
    );
    expect(response?.status).toBe(200);
    expect(sentinels.rescanCalls.length).toBe(1);
    expect(sentinels.capabilitiesForImport).toHaveBeenCalledWith('token-fresh-3');
    expect(sentinels.serviceConstructions.at(-1)?.extraction)
      .toBe(sentinels.capabilitiesForRequest.extraction);
  });
});
