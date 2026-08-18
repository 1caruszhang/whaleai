import { XIAOJING_MAIN_AGENT } from '../shared/xiaojing-main-agent-policy';

// DeepSeek 主连接的端点覆盖传输名（镜像 xiaojing-native-secret 拥有的
// XIAOJING_DEEPSEEK_* 命名空间）：未注入时回落策略表固定默认值，
// 注入时业务层与 SDK env 零感知。名字镜像 Node 侧字段名
// （deepseekAnthropicBaseUrl / deepseekOpenAiBaseUrl）。
const ANTHROPIC_BASE_URL_ENV = 'XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL';
const OPENAI_BASE_URL_ENV = 'XIAOJING_DEEPSEEK_OPENAI_BASE_URL';

// 账号 admission 传输名（票 06）：Rust 在 Sidecar 生成时注入运营网关根地址
// 与账号 access token。与凭据传输相同，模块求值期即捕获并从 process.env
// 删除；消费方（票 07 的网关 typed transport / permit 通道）只经 resolver
// 取值，token 不落日志、数据库或任何 HTTP 响应。
const GATEWAY_BASE_URL_ENV = 'XIAOJING_GATEWAY_BASE_URL';
const ACCOUNT_ACCESS_TOKEN_ENV = 'XIAOJING_ACCOUNT_ACCESS_TOKEN';

// Capture once at Sidecar birth, then remove the transport variable so generic
// subprocess inheritance and environment diagnostics cannot observe it.
const deepseekSecret = process.env[XIAOJING_MAIN_AGENT.credentialEnv]?.trim() || undefined;
delete process.env[XIAOJING_MAIN_AGENT.credentialEnv];
const deepseekAnthropicBaseUrl = process.env[ANTHROPIC_BASE_URL_ENV]?.trim() || undefined;
delete process.env[ANTHROPIC_BASE_URL_ENV];
const deepseekOpenAiBaseUrl = process.env[OPENAI_BASE_URL_ENV]?.trim() || undefined;
delete process.env[OPENAI_BASE_URL_ENV];
const gatewayBaseUrl = process.env[GATEWAY_BASE_URL_ENV]?.trim() || undefined;
delete process.env[GATEWAY_BASE_URL_ENV];
const accountAccessToken = process.env[ACCOUNT_ACCESS_TOKEN_ENV]?.trim() || undefined;
delete process.env[ACCOUNT_ACCESS_TOKEN_ENV];

/** Server-internal only. Never return this value from an HTTP route. */
export function resolveXiaojingDeepseekSecret(): string | undefined {
  return deepseekSecret;
}

/** Main Agent SDK 的 anthropic 协议根；未覆盖时由调用方回落策略表默认值。 */
export function resolveXiaojingDeepseekAnthropicBaseUrl(): string | undefined {
  return deepseekAnthropicBaseUrl;
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
