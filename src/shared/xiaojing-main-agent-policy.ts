/**
 * Product policy for the focused Xiaojing desktop Agent.
 *
 * Keep this module free of renderer/server dependencies: both sides must make
 * the same launch and capability decisions from one auditable table.
 */
export const XIAOJING_MAIN_AGENT = {
  providerId: 'deepseek',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'high',
  permissionMode: 'auto',
  credentialEnv: 'XIAOJING_DEEPSEEK_API_KEY',
  inferenceOrigin: 'https://api.deepseek.com',
  anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
  authType: 'auth_token',
  geoMcpServerId: 'xiaojing-geo',
  builtinTools: ['AskUserQuestion'] as const,
} as const;

/** Only the registered GEO server may enter the SDK process. */
export function isXiaojingMainAgentMcpServer(serverId: string): boolean {
  return serverId === XIAOJING_MAIN_AGENT.geoMcpServerId;
}

/**
 * Final tool-call gate. AskUserQuestion is a host interaction primitive, not
 * a data/system capability; every executable capability must come from GEO.
 */
export function isXiaojingMainAgentTool(toolName: string): boolean {
  return (XIAOJING_MAIN_AGENT.builtinTools as readonly string[]).includes(toolName)
    || toolName.startsWith(`mcp__${XIAOJING_MAIN_AGENT.geoMcpServerId}__`);
}
