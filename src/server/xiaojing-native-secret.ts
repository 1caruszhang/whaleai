// GEO typed ports 开发直连的 DeepSeek 密钥传输名（extraction/reflection
// 兜底；主 Agent 不走直连，凭据唯一来源是账号 admission）。生产 Sidecar
// 由 Rust 在所有生成路径无条件清洗，注入只可能来自开发环境。
const DEEPSEEK_DEV_DIRECT_KEY_ENV = 'XIAOJING_DEEPSEEK_API_KEY';

// DeepSeek extraction/reflection 的 OpenAI 兼容端点覆盖传输名（GEO 开发
// 直连模式使用；主 Agent 不走直连）。未注入时回落共享层固定默认值，
// 注入时业务层零感知。
const OPENAI_BASE_URL_ENV = 'XIAOJING_DEEPSEEK_OPENAI_BASE_URL';

// 账号 admission 传输名（票 06）：Rust 在 Sidecar 生成时注入运营网关根地址
// 与账号 access token。与凭据传输相同，模块求值期即捕获并从 process.env
// 删除；消费方（票 07 的网关 typed transport / permit 通道 / 主 Agent
// SDK）只经 resolver 取值，token 不落日志、数据库或任何 HTTP 响应。
const GATEWAY_BASE_URL_ENV = 'XIAOJING_GATEWAY_BASE_URL';
const ACCOUNT_ACCESS_TOKEN_ENV = 'XIAOJING_ACCOUNT_ACCESS_TOKEN';

// Capture once at Sidecar birth, then remove the transport variable so generic
// subprocess inheritance and environment diagnostics cannot observe it.
// deepseekSecret 仅供 GEO typed ports 的开发直连模式；主 Agent 聊天只走
// 网关（付费产品单一路径），任何时候都不得用它救活主 Agent。
const deepseekSecret = process.env[DEEPSEEK_DEV_DIRECT_KEY_ENV]?.trim() || undefined;
delete process.env[DEEPSEEK_DEV_DIRECT_KEY_ENV];
const deepseekOpenAiBaseUrl = process.env[OPENAI_BASE_URL_ENV]?.trim() || undefined;
delete process.env[OPENAI_BASE_URL_ENV];
const gatewayBaseUrl = process.env[GATEWAY_BASE_URL_ENV]?.trim() || undefined;
delete process.env[GATEWAY_BASE_URL_ENV];
const accountAccessToken = process.env[ACCOUNT_ACCESS_TOKEN_ENV]?.trim() || undefined;
delete process.env[ACCOUNT_ACCESS_TOKEN_ENV];

/** Server-internal only. Never return this value from an HTTP route.
 * 仅供 GEO typed ports 开发直连；主 Agent 不得消费。 */
export function resolveXiaojingDeepseekSecret(): string | undefined {
  return deepseekSecret;
}

/** extraction / reflection 的 OpenAI 兼容根；未覆盖时回落共享层默认值。 */
export function resolveXiaojingDeepseekOpenAiBaseUrl(): string | undefined {
  return deepseekOpenAiBaseUrl;
}

/** Rust sets this only after matching the canonical Xiaojing brand root. */
export function isXiaojingMainAgentSession(): boolean {
  return process.env.XIAOJING_MAIN_AGENT === '1';
}

/** 运营网关根地址（票 06 admission 注入）；未注入时由调用方决定缺省。 */
export function resolveXiaojingGatewayBaseUrl(): string | undefined {
  return gatewayBaseUrl;
}

/** 账号 access token（票 06 admission 注入）。Server-internal only：
 * 永不返回给 HTTP 路由、日志或数据库。 */
export function resolveXiaojingAccountAccessToken(): string | undefined {
  return accountAccessToken;
}

/**
 * 主 Agent SDK 的唯一鉴权来源（票 07 聊天流量切网关）：账号 admission
 * 齐备（网关根地址 + access token）时返回网关 Anthropic 兼容代理所需的
 * 协议根与 Bearer（backend `POST /v1/messages`）；否则 undefined，由
 * runTurn fail-fast 引导登录。付费产品没有直连回落：旧 DeepSeek 凭据
 * 存在也不得进入主 Agent。token 只经返回值进入 SDK env，不进日志与
 * HTTP 响应。
 *
 * 请求级新鲜 token（Rust 代理经 `x-xiaojing-account-token` 头附带，临期
 * 已在 Rust 侧自动 refresh）存在时优先于 admission env token——Sidecar
 * 长跑后 env token 可能已过期；未携带时回退 env，与既有路由同一语义。
 */
export function resolveXiaojingMainAgentAuth(
  requestAccountToken?: string,
): { baseUrl: string; token: string } | undefined {
  const token = requestAccountToken?.trim() || accountAccessToken;
  if (!gatewayBaseUrl || !token) return undefined;
  return { baseUrl: gatewayBaseUrl, token };
}
