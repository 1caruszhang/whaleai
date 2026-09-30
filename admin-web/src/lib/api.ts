import { clearAdminToken, getAdminToken } from '@/lib/auth';

/**
 * SPA 全量请求的唯一出口（票 46 认证闭环）：全部请求带
 * `Authorization: Bearer <运营 JWT>`；任一 API 返回 401 即清除凭证并通知
 * 应用回登录页。唯一例外是 POST /admin/login 自身——错误密码也是 401，
 * 必须走表单错误提示而不是「会话过期」清证跳转。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 服务端错误消息统一提取：ApiError 用中文 message，其余回落通用文案。 */
export function adminApiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/** 应用启动时注册一次：401 → 清凭证 → 回登录页（router.navigate）。 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(path, { ...init, headers });

  if (response.status === 401 && !path.startsWith('/admin/login')) {
    clearAdminToken();
    unauthorizedHandler?.();
  }

  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error ?? 'unknown_error',
      body?.message ?? '请求失败，请稍后重试。',
    );
  }
  return body as T;
}

export interface AdminLoginResult {
  adminToken: string;
  tokenType: string;
  expiresIn: number;
}

export function loginAdmin(password: string): Promise<AdminLoginResult> {
  return adminFetch<AdminLoginResult>('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}
