import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Rust 代理把 >1MB 的 loopback 响应 spill 成 `<refsDir>/<32hex>` +
// `<32hex>.meta.json` 并把 `ref_url` 交回 renderer 跨源取回（issue #22）。
// 本测试在 HTTP 路由边界钉住 serve 契约：32-hex 白名单、TTL 强制、
// meta.mimetype 透传、CORS/no-store 头、env 缺失降级 404 不 crash。

import { handleProxyRefRoute } from './proxy-refs';

const REFS_ENV = 'XIAOJING_PROXY_REFS_DIR';

let refsDir: string;

beforeEach(() => {
  refsDir = mkdtempSync(join(tmpdir(), 'xiaojing-proxy-refs-'));
  process.env[REFS_ENV] = refsDir;
});

afterEach(() => {
  delete process.env[REFS_ENV];
  rmSync(refsDir, { recursive: true, force: true });
});

function get(pathname: string): Request {
  return new Request(`http://127.0.0.1:31417${pathname}`, { method: 'GET' });
}

function writeRefPair(
  id: string,
  body: string,
  meta: Record<string, unknown>,
): void {
  writeFileSync(join(refsDir, id), body);
  writeFileSync(join(refsDir, `${id}.meta.json`), JSON.stringify(meta));
}

function liveMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'ref',
    mimetype: 'image/png',
    expiresAt: Date.now() + 60 * 60 * 1000,
    ...overrides,
  };
}

describe('proxy spill ref serving route', () => {
  it('serves a live ref body with the meta mimetype and data-plane headers', async () => {
    const id = '550bad6c0d1e4f2a9b3c7d8e5f6a7b8c';
    writeRefPair(id, 'spilled-body', liveMeta({ sizeBytes: 12 }));

    const response = await handleProxyRefRoute(`/refs/${id}`, get(`/refs/${id}`));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get('Content-Type')).toBe('image/png');
    expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response!.headers.get('Cache-Control')).toBe('no-store');
    expect(await response!.text()).toBe('spilled-body');
  });

  it('rejects an expired ref with 404 and lazily deletes the pair', async () => {
    const id = '1a2b3c4d5e6f708192a3b4c5d6e7f809';
    writeRefPair(id, 'stale-body', liveMeta({ expiresAt: Date.now() - 1 }));

    const response = await handleProxyRefRoute(`/refs/${id}`, get(`/refs/${id}`));

    expect(response!.status).toBe(404);
    expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await new Promise(resolve => setImmediate(resolve));
    expect(existsSync(join(refsDir, id))).toBe(false);
    expect(existsSync(join(refsDir, `${id}.meta.json`))).toBe(false);
  });

  it.each([
    ['uppercase hex', '550BAD6C0D1E4F2A9B3C7D8E5F6A7B8C'],
    ['31 chars', '550bad6c0d1e4f2a9b3c7d8e5f6a7b8'],
    ['33 chars', '550bad6c0d1e4f2a9b3c7d8e5f6a7b8cd'],
    ['non-hex', 'g' + '0'.repeat(31)],
    ['percent-encoded traversal', '..%2F..%2Fetc%2Fpasswd'],
  ])('returns 404 for a non-32-lowercase-hex id (%s)', async (_label, id) => {
    const response = await handleProxyRefRoute(`/refs/${id}`, get(`/refs/${id}`));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
  });

  it.each([
    ['meta file missing', (id: string) => {
      writeFileSync(join(refsDir, id), 'body');
    }],
    ['meta is bad JSON', (id: string) => {
      writeFileSync(join(refsDir, id), 'body');
      writeFileSync(join(refsDir, `${id}.meta.json`), '{not-json');
    }],
    ['body file missing', (id: string) => {
      writeFileSync(join(refsDir, `${id}.meta.json`), JSON.stringify(liveMeta()));
    }],
  ])('returns 404 when the pair is incomplete (%s)', async (_label, fixture) => {
    const id = '2b3c4d5e6f708192a3b4c5d6e7f80912';
    fixture(id);
    const response = await handleProxyRefRoute(`/refs/${id}`, get(`/refs/${id}`));

    expect(response!.status).toBe(404);
  });

  it('degrades to 404 without the env-provided refs directory', async () => {
    delete process.env[REFS_ENV];
    const id = '3c4d5e6f708192a3b4c5d6e7f8091234';
    writeRefPair(id, 'body', liveMeta());

    const response = await handleProxyRefRoute(`/refs/${id}`, get(`/refs/${id}`));

    expect(response!.status).toBe(404);
  });

  it('ignores non-GET requests and unrelated paths', async () => {
    const post = new Request('http://127.0.0.1:31417/refs/4d5e6f708192a3b4c5d6e7f80912345', {
      method: 'POST',
    });
    expect(await handleProxyRefRoute('/refs/4d5e6f708192a3b4c5d6e7f80912345', post)).toBeNull();
    expect(
      await handleProxyRefRoute('/api/session-state', get('/api/session-state')),
    ).toBeNull();
  });

  it('falls back to application/octet-stream for an unsafe meta mimetype', async () => {
    const id = '5e6f708192a3b4c5d6e7f80912345678';
    writeRefPair(id, 'body', liveMeta({ mimetype: 'image/png\r\nX-Injected: 1' }));

    const response = await handleProxyRefRoute(`/refs/${id}`, get(`/refs/${id}`));

    expect(response!.status).toBe(200);
    expect(response!.headers.get('Content-Type')).toBe('application/octet-stream');
  });
});
