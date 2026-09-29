import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminFetch, ApiError, setUnauthorizedHandler } from '@/lib/api';

/**
 * 认证闭环契约（票 46）：任一 API 401 → 清凭证并触发回登录页；唯一例外是
 * POST /admin/login 自身（错误密码也是 401，走表单提示）。请求必须带
 * Authorization: Bearer。
 */
const TOKEN_KEY = 'xiaojing-admin-token';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setUnauthorizedHandler(null);
});

describe('API 客户端认证闭环', () => {
  it('任一 API 401 → 清凭证 + 触发回登录回调，且请求带 Bearer', async () => {
    window.localStorage.setItem(TOKEN_KEY, 'expired-token');
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'token_expired', message: '运营凭证已过期。' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adminFetch('/admin/accounts')).rejects.toMatchObject({
      name: 'ApiError',
      status: 401,
    });

    expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/admin/accounts');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer expired-token',
    );
  });

  it('登录接口自身的 401（错误密码）不清凭证、不触发跳转，只抛 ApiError', async () => {
    window.localStorage.setItem(TOKEN_KEY, 'existing-token');
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: 'invalid_credentials', message: '运营密码不正确。' }, 401),
        ),
    );

    await expect(
      adminFetch('/admin/login', { method: 'POST', body: JSON.stringify({ password: 'x' }) }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 401, code: 'invalid_credentials' });

    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('existing-token');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('成功请求返回 JSON，非 401 错误不清凭证', async () => {
    window.localStorage.setItem(TOKEN_KEY, 'valid-token');
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200))
      .mockResolvedValueOnce(jsonResponse({ error: 'account_not_found', message: '账号不存在。' }, 404));
    vi.stubGlobal('fetch', fetchMock);

    await expect(adminFetch('/admin/anything')).resolves.toEqual({ ok: true });
    await expect(adminFetch('/admin/anything')).rejects.toMatchObject({ status: 404 });

    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('valid-token');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('未登录时请求不带 Authorization 头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    await adminFetch('/admin/anything');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('ApiError 暴露语义 code 与中文 message', () => {
    const error = new ApiError(400, 'validation_error', '参数无效。');
    expect(error.status).toBe(400);
    expect(error.code).toBe('validation_error');
    expect(error.message).toBe('参数无效。');
  });
});
