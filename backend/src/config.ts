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
  /** 每账号并发计费准入上限（open permit 数，规格决策为 2）。 */
  maxConcurrentPermitsPerAccount: number;
  /** DeepSeek Anthropic 兼容上游密钥（主 Agent 通道，票 04）。只经环境变量注入。 */
  deepseekApiKey: string;
  /** DeepSeek Anthropic 兼容上游基地址。 */
  deepseekBaseUrl: string;
  /** 对话隐藏额度（点等值；网关旁路 token 计量折点累计，用尽暂停、充值刷新）。 */
  chatHiddenQuotaPoints: number;
  /**
   * 对话旁路计量折点单价（元/百万 token，锚点 1 元 = 10 点）。默认值为
   * deepseek-chat 标价占位口径，生产以官网现价经环境变量调整（README 注明）。
   */
  chatInputCnyPerMtok: number;
  chatInputCacheHitCnyPerMtok: number;
  chatOutputCnyPerMtok: number;
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

/** 可为小数的正数（单价类配置，元/百万 token）。 */
function readPositiveNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正数，收到：${raw}`);
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
  if (!env.DEEPSEEK_API_KEY) missing.push('DEEPSEEK_API_KEY');
  if (missing.length > 0) throw new MissingConfigError(missing);

  return {
    authSecret: env.AUTH_SECRET!,
    adminPassword: env.ADMIN_PASSWORD!,
    deepseekApiKey: env.DEEPSEEK_API_KEY!,
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
    accessTokenTtlSeconds: readPositiveInt(env, 'ACCESS_TOKEN_TTL_SECONDS', 7200),
    refreshTokenTtlSeconds: readPositiveInt(env, 'REFRESH_TOKEN_TTL_SECONDS', THIRTY_DAYS_SECONDS),
    adminTokenTtlSeconds: readPositiveInt(env, 'ADMIN_TOKEN_TTL_SECONDS', 3600),
    signupGrantPoints: readPositiveInt(env, 'SIGNUP_GRANT_POINTS', 500),
    maxConcurrentPermitsPerAccount: readPositiveInt(env, 'MAX_CONCURRENT_PERMITS_PER_ACCOUNT', 2),
    chatHiddenQuotaPoints: readPositiveInt(env, 'CHAT_HIDDEN_QUOTA_POINTS', 100),
    chatInputCnyPerMtok: readPositiveNumber(env, 'CHAT_INPUT_CNY_PER_MTOK', 2),
    chatInputCacheHitCnyPerMtok: readPositiveNumber(env, 'CHAT_INPUT_CACHE_HIT_CNY_PER_MTOK', 0.2),
    chatOutputCnyPerMtok: readPositiveNumber(env, 'CHAT_OUTPUT_CNY_PER_MTOK', 3),
  };
}
