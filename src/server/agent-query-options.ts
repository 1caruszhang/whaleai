import type {
  CanUseTool,
  McpSdkServerConfigWithInstance,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

import { XIAOJING_MAIN_AGENT } from '../shared/xiaojing-main-agent-policy';
import { claudeExecutableOption } from './utils/claude-sdk-runtime';

/**
 * 主 Agent query options 的唯一构造点：model、effort、permissionMode、
 * 工具白名单与 GEO MCP server 全部取自 XIAOJING_MAIN_AGENT 策略表，
 * 防止表与调用点再次漂移（由 agent-query-options.unit.test.ts 锁定）。
 */
export function buildAgentQueryOptions(input: {
  abortController: AbortController;
  cwd: string;
  sessionId: string;
  resume: boolean;
  geoServer: McpSdkServerConfigWithInstance;
  env: Record<string, string | undefined>;
  systemPrompt: string;
  canUseTool: CanUseTool;
}): Options {
  return {
    abortController: input.abortController,
    cwd: input.cwd,
    ...claudeExecutableOption(input.env),
    ...(input.resume
      ? { resume: input.sessionId }
      : { sessionId: input.sessionId }),
    model: XIAOJING_MAIN_AGENT.model,
    effort: XIAOJING_MAIN_AGENT.reasoningEffort,
    // DeepSeek 的 Anthropic 兼容端点不产出 Claude thinking 块，显式关闭；
    // effort 仍照常传递，由端点映射为 DeepSeek 自身的推理强度。
    thinking: { type: 'disabled' },
    includePartialMessages: true,
    persistSession: true,
    settingSources: [],
    tools: [...XIAOJING_MAIN_AGENT.builtinTools],
    mcpServers: { [XIAOJING_MAIN_AGENT.geoMcpServerId]: input.geoServer },
    permissionMode: XIAOJING_MAIN_AGENT.permissionMode,
    systemPrompt: input.systemPrompt,
    toolConfig: { askUserQuestion: { previewFormat: 'html' } },
    env: input.env,
    canUseTool: input.canUseTool,
  };
}
