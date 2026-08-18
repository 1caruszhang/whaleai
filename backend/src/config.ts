/**
 * 后端配置。规格红线：运营密码与账本密钥（AUTH_SECRET）只存服务器环境
 * 变量——禁止写入数据库、日志、代码或构建产物。缺失时启动即失败，
 * 不允许带默认密钥运行。
 */
export interface BackendConfig {
  /** JWT HS256 签名密钥 + refresh token 哈希胡椒，>= 32 字符。 */
  authSecret: string;
  /** /admin 运营登录密码。 */
  adminPassword: string;
  /** 账号 access JWT 有效期（规格 1–2h，默认上限 2h）。 */
  accessTokenTtlSeconds: number;
  /** refresh token 有效期；会话过期同步滑动到 now + 该值（30 天）。 */
  refreshTokenTtlSeconds: number;
  /** /admin 运营 JWT 有效期。 */
  adminTokenTtlSeconds: number;
  /** 开号赠送点数（内测期 500）。 */
  signupGrantPoints: number;
}

export class MissingConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`缺少必需的环境变量：${missing.join(', ')}。密钥只经环境变量注入，不提供默认值。`);
    this.name = 'MissingConfigError';
  }
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function readPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，收到：${raw}`);
  }
  return value;
}

export function loadBackendConfig(env: Record<string, string | undefined>): BackendConfig {
  const missing: string[] = [];
  if (!env.AUTH_SECRET) missing.push('AUTH_SECRET');
  else if (env.AUTH_SECRET.length < 32) {
    throw new Error('AUTH_SECRET 至少需要 32 字符（同时用作 JWT 签名与 refresh 哈希胡椒）。');
  }
  if (!env.ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD');
  if (missing.length > 0) throw new MissingConfigError(missing);

  return {
    authSecret: env.AUTH_SECRET!,
    adminPassword: env.ADMIN_PASSWORD!,
    accessTokenTtlSeconds: readPositiveInt(env, 'ACCESS_TOKEN_TTL_SECONDS', 7200),
    refreshTokenTtlSeconds: readPositiveInt(env, 'REFRESH_TOKEN_TTL_SECONDS', THIRTY_DAYS_SECONDS),
    adminTokenTtlSeconds: readPositiveInt(env, 'ADMIN_TOKEN_TTL_SECONDS', 3600),
    signupGrantPoints: readPositiveInt(env, 'SIGNUP_GRANT_POINTS', 500),
  };
}
