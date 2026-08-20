import { unwrapToolResultText } from '../../../shared/toolResult';

/**
 * 过程性工具行的展示 helper：把 MCP FQN 映射为产品动作标签（chat:process
 * 命名空间），并把 SSE 投影的 tool_result 壳规整为可读的截断预览。
 * 未登记的工具名原样回退，不臆造标签。
 */
const XIAOJING_GEO_TOOL_LABEL_KEYS: Record<string, string> = {
  'mcp__xiaojing-geo__inspect_brand_context': 'process.tools.inspectBrandContext',
  'mcp__xiaojing-geo__start_geo_operation': 'process.tools.startGeoOperation',
  'mcp__xiaojing-geo__inspect_geo_operations': 'process.tools.inspectGeoOperations',
  'mcp__xiaojing-geo__choose_next_round_knowledge': 'process.tools.chooseNextRoundKnowledge',
  'mcp__xiaojing-geo__control_geo_operation': 'process.tools.controlGeoOperation',
  'mcp__xiaojing-geo__propose_brand_fact': 'process.tools.proposeBrandFact',
  'mcp__xiaojing-geo__inspect_brand_fact': 'process.tools.inspectBrandFact',
  'mcp__xiaojing-geo__revise_gate_content': 'process.tools.reviseGateContent',
  'mcp__xiaojing-geo__request_brand_material': 'process.tools.requestBrandMaterial',
  'mcp__xiaojing-geo__import_pasted_material': 'process.tools.importPastedMaterial',
  'mcp__xiaojing-geo__read_session_file': 'process.tools.readSessionFile',
  'mcp__xiaojing-geo__import_website_material': 'process.tools.importWebsiteMaterial',
  'mcp__xiaojing-geo__retry_brand_material': 'process.tools.retryBrandMaterial',
  'mcp__xiaojing-geo__inspect_geo_probe_samples': 'process.tools.inspectGeoProbeSamples',
};

/** 返回 chat 命名空间下的标签 key；未登记工具返回 null，调用方回退原始名称。 */
export function xiaojingToolLabelKey(name: string): string | null {
  return XIAOJING_GEO_TOOL_LABEL_KEYS[name] ?? null;
}

export const TOOL_RESULT_PREVIEW_MAX_CHARS = 2_000;

export interface ToolResultPreview {
  text: string;
  totalChars: number;
  truncated: boolean;
}

function prettyJson(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/** 无参调用投影为 `{}`；这类输入对用户没有信息量，展示层直接省略输入段。 */
export function hasMeaningfulInput(inputJson?: string): boolean {
  if (!inputJson) return false;
  return inputJson.trim() !== '{}';
}

export function formatToolResultPreview(
  result: string,
  maxChars: number = TOOL_RESULT_PREVIEW_MAX_CHARS,
): ToolResultPreview {
  const pretty = prettyJson(unwrapToolResultText(result));
  return {
    text: pretty.length > maxChars ? pretty.slice(0, maxChars) : pretty,
    totalChars: pretty.length,
    truncated: pretty.length > maxChars,
  };
}
