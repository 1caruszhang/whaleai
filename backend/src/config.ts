/**
 * 后端配置。规格红线：运营密码、账本密钥（AUTH_SECRET）与全部上游密钥
 * （DeepSeek / ARK / 豆包搜索 / OSS AK/SK / 超级媒介 appid+secret）只存
 * 服务器环境变量——禁止写入数据库、日志、代码或构建产物。缺失时启动即
 * 失败，不允许带默认密钥运行。
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
  /**
   * 运营密码错误登录的节流基步长（毫秒）：连续失败第 n 次延时
   * min(n×步长, 20×步长)。内存计数、单进程（Docker 单容器部署口径），
   * 只延时不断锁，防在线爆破又不给运营自锁。
   */
  adminLoginThrottleUnitMs: number;
  /** 媒介池低余额提醒阈值（分，规格默认 ¥500）。 */
  adminMediaPoolLowBalanceCents: number;
  /** 开号赠送点数（内测期 500）。 */
  signupGrantPoints: number;
  /** 每账号并发计费准入上限（open permit 数，规格决策为 2）。 */
  maxConcurrentPermitsPerAccount: number;
  /** DeepSeek Anthropic 兼容上游密钥（主 Agent 通道，票 04）。只经环境变量注入。 */
  deepseekApiKey: string;
  /** DeepSeek Anthropic 兼容上游基地址。 */
  deepseekBaseUrl: string;
  /** DeepSeek OpenAI 兼容上游基地址（extraction/reflection 经网关代理，票 05）。 */
  deepseekOpenAiBaseUrl: string;
  /** 火山方舟 API Key（ARK chat/responses/embeddings 代理，票 05）。只经环境变量注入。 */
  arkApiKey: string;
  /** 火山方舟 paygo 基地址。 */
  arkBaseUrl: string;
  /** ARK embedding 专用 key；缺省回落 ARK_API_KEY（与 sidecar 口径一致）。 */
  arkEmbeddingApiKey?: string;
  /**
   * ARK embedding endpoint id（票 07）：网关模式下 sidecar 不再随 admission
   * 携带账号级 endpoint id，body 缺 model 时由网关按本配置补齐；未配置则
   * 原样透传（上游自行报错）。
   */
  arkEmbeddingEndpointId?: string;
  /** 豆包搜索专用 key；缺省回落 ARK_API_KEY（与 sidecar 口径一致）。 */
  doubaoSearchApiKey?: string;
  /** 豆包搜索 HTTP API 基地址。 */
  doubaoSearchBaseUrl: string;
  /** 阿里云 OSS AccessKey（网关 V1 重签，票 05）。私钥仅在服务器。 */
  ossAccessKeyId: string;
  ossAccessKeySecret: string;
  /** OSS bucket（重签资源路径与内网 host 都需要）。 */
  ossBucket: string;
  /** OSS 地域（如 oss-cn-chengdu；内网 endpoint 缺省由它推导）。 */
  ossRegion: string;
  /** OSS 同地域内网 endpoint host，缺省 `{ossRegion}-internal.aliyuncs.com`。 */
  ossInternalHost: string;
  /** OSS 公网访问基地址（可选；putHtml 返回 URL 优先用它拼）。 */
  ossPublicBaseUrl?: string;
  /** 超级媒介代理商 appid / 签名 secret（网关 HMAC-SHA256 重签，票 05）。 */
  distributionAppId: string;
  distributionSecret: string;
  /** 超级媒介 API 基地址。 */
  distributionBaseUrl: string;
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
  if (!env.ARK_API_KEY) missing.push('ARK_API_KEY');
  if (!env.OSS_ACCESS_KEY_ID) missing.push('OSS_ACCESS_KEY_ID');
  if (!env.OSS_ACCESS_KEY_SECRET) missing.push('OSS_ACCESS_KEY_SECRET');
  if (!env.OSS_BUCKET) missing.push('OSS_BUCKET');
  if (!env.DISTRIBUTION_APP_ID) missing.push('DISTRIBUTION_APP_ID');
  if (!env.DISTRIBUTION_SECRET) missing.push('DISTRIBUTION_SECRET');
  if (missing.length > 0) throw new MissingConfigError(missing);

  const ossRegion = env.OSS_REGION || 'oss-cn-chengdu';
  const trimRoot = (value: string | undefined, fallback: string) =>
    (value || fallback).replace(/\/+$/, '');

  return {
    authSecret: env.AUTH_SECRET!,
    adminPassword: env.ADMIN_PASSWORD!,
    deepseekApiKey: env.DEEPSEEK_API_KEY!,
    deepseekBaseUrl: trimRoot(env.DEEPSEEK_BASE_URL, 'https://api.deepseek.com/anthropic'),
    deepseekOpenAiBaseUrl: trimRoot(env.DEEPSEEK_OPENAI_BASE_URL, 'https://api.deepseek.com'),
    arkApiKey: env.ARK_API_KEY!,
    arkBaseUrl: trimRoot(env.ARK_BASE_URL, 'https://ark.cn-beijing.volces.com/api/v3'),
    ...(env.ARK_EMBEDDING_API_KEY ? { arkEmbeddingApiKey: env.ARK_EMBEDDING_API_KEY } : {}),
    ...(env.ARK_EMBEDDING_ENDPOINT_ID ? { arkEmbeddingEndpointId: env.ARK_EMBEDDING_ENDPOINT_ID } : {}),
    ...(env.DOUBAO_SEARCH_API_KEY ? { doubaoSearchApiKey: env.DOUBAO_SEARCH_API_KEY } : {}),
    doubaoSearchBaseUrl: trimRoot(env.DOUBAO_SEARCH_BASE_URL, 'https://open.feedcoopapi.com'),
    ossAccessKeyId: env.OSS_ACCESS_KEY_ID!,
    ossAccessKeySecret: env.OSS_ACCESS_KEY_SECRET!,
    ossBucket: env.OSS_BUCKET!,
    ossRegion,
    ossInternalHost: env.OSS_INTERNAL_HOST || `${ossRegion}-internal.aliyuncs.com`,
    ...(env.OSS_PUBLIC_BASE_URL ? { ossPublicBaseUrl: env.OSS_PUBLIC_BASE_URL } : {}),
    distributionAppId: env.DISTRIBUTION_APP_ID!,
    distributionSecret: env.DISTRIBUTION_SECRET!,
    distributionBaseUrl: trimRoot(
      env.DISTRIBUTION_BASE_URL,
      'https://vip.chaojimeijie.com/api',
    ),
    accessTokenTtlSeconds: readPositiveInt(env, 'ACCESS_TOKEN_TTL_SECONDS', 7200),
    refreshTokenTtlSeconds: readPositiveInt(env, 'REFRESH_TOKEN_TTL_SECONDS', THIRTY_DAYS_SECONDS),
    adminTokenTtlSeconds: readPositiveInt(env, 'ADMIN_TOKEN_TTL_SECONDS', 3600),
    adminLoginThrottleUnitMs: readPositiveInt(env, 'ADMIN_LOGIN_THROTTLE_UNIT_MS', 500),
    adminMediaPoolLowBalanceCents: Math.round(
      readPositiveNumber(env, 'ADMIN_MEDIA_POOL_LOW_BALANCE_CNY', 500) * 100,
    ),
    signupGrantPoints: readPositiveInt(env, 'SIGNUP_GRANT_POINTS', 500),
    maxConcurrentPermitsPerAccount: readPositiveInt(env, 'MAX_CONCURRENT_PERMITS_PER_ACCOUNT', 2),
    chatHiddenQuotaPoints: readPositiveInt(env, 'CHAT_HIDDEN_QUOTA_POINTS', 100),
    chatInputCnyPerMtok: readPositiveNumber(env, 'CHAT_INPUT_CNY_PER_MTOK', 2),
    chatInputCacheHitCnyPerMtok: readPositiveNumber(env, 'CHAT_INPUT_CACHE_HIT_CNY_PER_MTOK', 0.2),
    chatOutputCnyPerMtok: readPositiveNumber(env, 'CHAT_OUTPUT_CNY_PER_MTOK', 3),
  };
}
