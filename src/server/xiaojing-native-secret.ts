import { XIAOJING_MAIN_AGENT } from '../shared/xiaojing-main-agent-policy';

// Capture once at Sidecar birth, then remove the transport variable so generic
// subprocess inheritance and environment diagnostics cannot observe it.
const deepseekSecret = process.env[XIAOJING_MAIN_AGENT.credentialEnv]?.trim() || undefined;
delete process.env[XIAOJING_MAIN_AGENT.credentialEnv];

/** Server-internal only. Never return this value from an HTTP route. */
export function resolveXiaojingDeepseekSecret(): string | undefined {
  return deepseekSecret;
}

/** Rust sets this only after matching the canonical Xiaojing brand root. */
export function isXiaojingMainAgentSession(): boolean {
  return process.env.XIAOJING_MAIN_AGENT === '1';
}
