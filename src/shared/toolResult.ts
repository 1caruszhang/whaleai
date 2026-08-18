/**
 * MCP 工具结果经 SSE 投影后的实际形态是 content blocks 数组的 JSON 字符串：
 * `[{"type":"text","text":"<payload>"}]`（见 agent-session.ts applyToolResults，
 * content 非字符串时整体 stringify）。SDK 内置工具的结果则是纯字符串。
 * 卡片解析前先统一剥壳，取第一个 text block 的原文；非包装形态原样返回。
 */
export function unwrapToolResultText(result: string): string {
  const trimmed = result.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return result;
  }
  let content: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    content = parsed;
  } else if (parsed && typeof parsed === 'object') {
    const inner = (parsed as { content?: unknown }).content;
    if (Array.isArray(inner)) content = inner;
  }
  if (!content) return result;
  for (const item of content) {
    if (
      item
      && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ) {
      return (item as { text: string }).text;
    }
  }
  return result;
}
