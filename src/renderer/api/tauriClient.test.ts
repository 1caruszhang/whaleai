import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Rust 代理把 >1MB 的 sidecar 响应 spill 成 ref，renderer 收到 ref_url 后
// 跨源 fetch 取回（issue #22）。本测试钉住公开 seam `sessionSidecarFetch`
// 的 ref 分支：最终 Response 必须透传 ref 自身的 status（ref 404 不能被
// 原始响应的 200 静默包装），且原始 headers 与 ref headers 合并保留。

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refFetch: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { sessionSidecarFetch } from './tauriClient';

const REF_ID = '550bad6c0d1e4f2a9b3c7d8e5f6a7b8c';
const REF_URL = `http://127.0.0.1:31417/refs/${REF_ID}`;

function spilledResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 200,
    body: '',
    headers: { 'X-Spill-Correlation': 'spill-1' },
    is_base64: false,
    ref_url: REF_URL,
    ...overrides,
  };
}

async function fetchViaProxy(): Promise<Response> {
  return sessionSidecarFetch('session-1', { type: 'tab', id: 'tab-1' }, '/api/material-images/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

describe('session sidecar proxy fetch ref branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { __TAURI__: true });
    vi.stubGlobal('fetch', mocks.refFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the spilled request through the Rust proxy dispatch', async () => {
    mocks.invoke.mockResolvedValue({
      status: 200,
      body: 'ok',
      headers: {},
      is_base64: false,
    });
    mocks.refFetch.mockResolvedValue(new Response('unused'));

    const response = await fetchViaProxy();

    expect(mocks.invoke).toHaveBeenCalledWith('session_sidecar_http_request', {
      sessionIdHint: 'session-1',
      sidecarOwnerType: 'tab',
      sidecarOwnerId: 'tab-1',
      request: expect.objectContaining({
        path: '/api/material-images/content',
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'X-Xiaojing-Tab-Id': 'tab-1',
          'X-Xiaojing-Session-Id': 'session-1',
        }),
      }),
    });
    expect(mocks.refFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('passes the ref response status through instead of the original 200', async () => {
    mocks.invoke.mockResolvedValue(spilledResult());
    mocks.refFetch.mockResolvedValue(new Response('gone', { status: 404 }));

    const response = await fetchViaProxy();

    expect(mocks.refFetch).toHaveBeenCalledWith(REF_URL);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('gone');
  });

  it('serves a live ref with merged headers from both responses', async () => {
    mocks.invoke.mockResolvedValue(spilledResult());
    mocks.refFetch.mockResolvedValue(
      new Response('spilled-body', {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );

    const response = await fetchViaProxy();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('spilled-body');
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Spill-Correlation')).toBe('spill-1');
  });
});
