import { XIAOJING_MAIN_AGENT } from '../shared/xiaojing-main-agent-policy';

// DeepSeek 主连接的端点覆盖传输名（镜像 xiaojing-native-secret 拥有的
// XIAOJING_DEEPSEEK_* 命名空间）：未注入时回落策略表固定默认值，
// 注入时业务层与 SDK env 零感知。名字镜像 Node 侧字段名
// （deepseekAnthropicBaseUrl / deepseekOpenAiBaseUrl）。
const ANTHROPIC_BASE_URL_ENV = 'XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL';
const OPENAI_BASE_URL_ENV = 'XIAOJING_DEEPSEEK_OPENAI_BASE_URL';

// Capture once at Sidecar birth, then remove the transport variable so generic
// subprocess inheritance and environment diagnostics cannot observe it.
const deepseekSecret = process.env[XIAOJING_MAIN_AGENT.credentialEnv]?.trim() || undefined;
delete process.env[XIAOJING_MAIN_AGENT.credentialEnv];
const deepseekAnthropicBaseUrl = process.env[ANTHROPIC_BASE_URL_ENV]?.trim() || undefined;
delete process.env[ANTHROPIC_BASE_URL_ENV];
const deepseekOpenAiBaseUrl = process.env[OPENAI_BASE_URL_ENV]?.trim() || undefined;
delete process.env[OPENAI_BASE_URL_ENV];

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
