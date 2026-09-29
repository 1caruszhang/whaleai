/**
 * 运营凭证本地存储（票 46）：运营 JWT 只放 localStorage（SPA 与后端同域
 * 静态托管下的会话凭证；凭据过期/失效由 401 闭环清除，见 lib/api.ts）。
 */
const TOKEN_KEY = 'xiaojing-admin-token';

export function getAdminToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
