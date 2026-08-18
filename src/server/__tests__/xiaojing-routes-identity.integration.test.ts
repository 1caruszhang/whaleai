import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 回归（P1-4 路由拆分）：全部 /api/xiaojing/* 路由从 index.ts 迁入
// routes/xiaojing*.ts 后，路径匹配与「身份不符先于任何服务调用返回 403」
// 的闸门必须原样保留。错身份请求不会构造任何 GEO 服务，因此本测试
// 不需要工作区/Provider/SQLite。

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let handleXiaojingRoute: typeof import('../routes/xiaojing')['handleXiaojingRoute'];

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-routes-identity-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-routes-ws-'));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
  vi.resetModules();
  ({ handleXiaojingRoute } = await import('../routes/xiaojing'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const XIAOJING_POST_ROUTES = [
  '/api/xiaojing/geo-operations/list',
  '/api/xiaojing/geo-operations/get',
  '/api/xiaojing/geo-operations/control',
  '/api/xiaojing/geo-operations/choose-next-round-knowledge',
  '/api/xiaojing/geo-operations/confirm-step',
  '/api/xiaojing/knowledge/decide',
  '/api/xiaojing/knowledge/decide-batch',
  '/api/xiaojing/knowledge/candidates',
  '/api/xiaojing/materials/import',
  '/api/xiaojing/materials/status',
  '/api/xiaojing/materials/retry',
  '/api/xiaojing/question-pools/latest',
  '/api/xiaojing/question-pools/generate',
  '/api/xiaojing/question-pools/cancel',
  '/api/xiaojing/question-pools/confirm',
  '/api/xiaojing/topic-plans/latest',
  '/api/xiaojing/topic-plans/generate',
  '/api/xiaojing/topic-plans/items',
  '/api/xiaojing/topic-plans/regenerate',
  '/api/xiaojing/topic-plans/confirm',
  '/api/xiaojing/articles/latest',
  '/api/xiaojing/articles/operation/get',
  '/api/xiaojing/articles/start',
  '/api/xiaojing/articles/retry',
  '/api/xiaojing/articles/body',
  '/api/xiaojing/articles/edit',
  '/api/xiaojing/articles/approve',
  '/api/xiaojing/distribution-plans/context',
  '/api/xiaojing/distribution-plans/latest',
  '/api/xiaojing/distribution-plans/start',
  '/api/xiaojing/distribution-plans/edit',
  '/api/xiaojing/distribution-plans/confirm',
  '/api/xiaojing/publish-scheduler/latest',
  '/api/xiaojing/publish-scheduler/get',
  '/api/xiaojing/publish-scheduler/preview',
  '/api/xiaojing/publish-scheduler/orders',
  '/api/xiaojing/geo-baselines/engines',
  '/api/xiaojing/geo-baselines/latest',
  '/api/xiaojing/geo-baselines/start',
  '/api/xiaojing/geo-baselines/retry',
  '/api/xiaojing/geo-dashboard/get',
  '/api/xiaojing/geo-dashboard/drilldown',
  '/api/xiaojing/post-publish-monitor/baseline-probe',
  '/api/xiaojing/post-publish-monitor/access-check',
];

function post(pathname: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('xiaojing route extraction keeps path matching and identity gates', () => {
  it('rejects every registered route with 403 before any service call when identity mismatches', async () => {
    expect(XIAOJING_POST_ROUTES.length).toBeGreaterThanOrEqual(40);
    for (const pathname of XIAOJING_POST_ROUTES) {
      const response = await handleXiaojingRoute(pathname, post(pathname, {
        workspaceId: 'not-this-workspace',
        sessionId: 'not-this-session',
      }), { workspacePath: workspace });
      expect(response, pathname).not.toBeNull();
      expect(response?.status, pathname).toBe(403);
      const body = await response?.json() as { success?: boolean; error?: string };
      expect(body.success, pathname).toBe(false);
      expect(body.error, pathname).toBeTruthy();
    }
  });

  it('returns null for unknown xiaojing paths and non-POST methods', async () => {
    expect(await handleXiaojingRoute(
      '/api/xiaojing/does-not-exist',
      post('/api/xiaojing/does-not-exist', {}),
      { workspacePath: workspace },
    )).toBeNull();

    const get = new Request('http://127.0.0.1:1/api/xiaojing/geo-operations/list');
    expect(await handleXiaojingRoute(
      '/api/xiaojing/geo-operations/list',
      get,
      { workspacePath: workspace },
    )).toBeNull();
  });
});
