/**
 * Product policy for the focused Xiaojing desktop Agent.
 *
 * Keep this module free of renderer/server dependencies: both sides must make
 * the same launch and capability decisions from one auditable table.
 */
export const XIAOJING_MAIN_AGENT = {
  providerId: 'deepseek',
  model: 'deepseek-v4-pro',
  // low 是止血降档（geo-plan-normalization 票 01）：指令冲突消灭前压思考
  // 长度，决策质量由真实场景回归验证（票 10），不合格再回调。
  reasoningEffort: 'low',
  // 'default' 保证每个工具调用都咨询 canUseTool 终审闸门；'auto' 把部分
  // 裁决交给 CLI 自动裁量，可能绕过闸门，不得用于本产品。
  permissionMode: 'default',
  // 主 Agent 没有客户端凭据：鉴权唯一来源是账号 admission（网关地址 +
  // access token，见 xiaojing-native-secret.ts）。DeepSeek 上游密钥只住
  // 网关服务端；XIAOJING_DEEPSEEK_API_KEY 只是 GEO typed ports 的开发
  // 直连来源，与主 Agent 无关。
  inferenceOrigin: 'https://api.deepseek.com',
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
