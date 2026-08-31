import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MaterialImageAsset } from '../../shared/geo/materialImages';

// 配图候选只读预览条（issue #19）的清单路由在 HTTP 边界钉住：身份门先于
// 任何服务调用、limit 校验与 Rust images/list 的 clamp 口径对齐、成功回
// 纯清单投影（不含图片字节）、port 失败收敛为固定码。全程 mock 材料
// port，不触真实网络/SQLite。

const mocks = vi.hoisted(() => ({
  sessionId: 'session-image-list-19',
  listImageAssets: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  getSessionId: () => mocks.sessionId,
}));

vi.mock('../geo/material-import', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../geo/material-import')
  >();
  return {
    ...actual,
    createBrandMaterialPort: () => ({
      listImageAssets: mocks.listImageAssets,
    }) as unknown as ReturnType<typeof actual.createBrandMaterialPort>,
  };
});

let workspace: string;
let workspaceId: string;
let handleXiaojingRoute: typeof import('../routes/xiaojing')['handleXiaojingRoute'];

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-image-list-ws-'));
  workspaceId = basename(resolve(workspace));
  ({ handleXiaojingRoute } = await import('../routes/xiaojing'));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.listImageAssets.mockReset();
});

function post(pathname: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function imageAsset(id: string): MaterialImageAsset {
  return {
    id,
    workspaceId,
    sha256: `sha-${id}`,
    fileExt: 'png',
    mediaType: 'image/png',
    byteSize: 4096,
    width: 1024,
    height: 768,
    description: `${id} 的中文描述`,
    category: 'product-photo',
    sourceMaterialId: 'material-19',
    sourceMaterialName: '品牌介绍.docx',
    relativePath: `images/${id}.png`,
    createdAt: '2026-08-31T00:00:00Z',
    updatedAt: '2026-08-31T00:00:00Z',
  };
}

describe('/api/xiaojing/material-images/list route', () => {
  it('returns the read-only candidate projection scoped to the current brand Session', async () => {
    mocks.listImageAssets.mockResolvedValue([imageAsset('image-a'), imageAsset('image-b')]);

    const response = await handleXiaojingRoute(
      '/api/xiaojing/material-images/list',
      post('/api/xiaojing/material-images/list', {
        workspaceId,
        sessionId: mocks.sessionId,
        limit: 100,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(200);
    const body = await response?.json() as {
      success: boolean;
      images?: MaterialImageAsset[];
    };
    expect(body.success).toBe(true);
    expect(body.images?.map((asset) => asset.id)).toEqual(['image-a', 'image-b']);
    expect(mocks.listImageAssets).toHaveBeenCalledWith({ limit: 100 });
  });

  it('rejects a mismatched identity with 403 before any port call', async () => {
    const response = await handleXiaojingRoute(
      '/api/xiaojing/material-images/list',
      post('/api/xiaojing/material-images/list', {
        workspaceId: 'not-this-workspace',
        sessionId: mocks.sessionId,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(403);
    const body = await response?.json() as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(mocks.listImageAssets).not.toHaveBeenCalled();
  });

  it('validates the optional limit against the storage clamp before calling the port', async () => {
    for (const limit of [0, -1, 201, 12.5, '100']) {
      const response = await handleXiaojingRoute(
        '/api/xiaojing/material-images/list',
        post('/api/xiaojing/material-images/list', {
          workspaceId,
          sessionId: mocks.sessionId,
          limit,
        }),
        { workspacePath: workspace },
      );
      expect(response?.status, `limit=${String(limit)}`).toBe(400);
      const body = await response?.json() as { success?: boolean; error?: string };
      expect(body.error, `limit=${String(limit)}`).toBe('material_image_limit_invalid');
    }
    expect(mocks.listImageAssets).not.toHaveBeenCalled();

    // 未提供 limit 时走存储缺省（不传 limit 字段），不猜默认值。
    mocks.listImageAssets.mockResolvedValue([]);
    const response = await handleXiaojingRoute(
      '/api/xiaojing/material-images/list',
      post('/api/xiaojing/material-images/list', {
        workspaceId,
        sessionId: mocks.sessionId,
      }),
      { workspacePath: workspace },
    );
    expect(response?.status).toBe(200);
    expect(mocks.listImageAssets).toHaveBeenCalledWith({});
  });

  it('maps a port failure to the stable error code', async () => {
    mocks.listImageAssets.mockRejectedValue(new Error('material_management_failed'));

    const response = await handleXiaojingRoute(
      '/api/xiaojing/material-images/list',
      post('/api/xiaojing/material-images/list', {
        workspaceId,
        sessionId: mocks.sessionId,
      }),
      { workspacePath: workspace },
    );

    expect(response?.status).toBe(400);
    const body = await response?.json() as { success?: boolean; error?: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('material_management_failed');
  });
});
