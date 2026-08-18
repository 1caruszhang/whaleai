/**
 * 一个 runTurn 的 assistant 段落投影。
 *
 * SDK 开启 includePartialMessages 后，一次用户请求会产出多个 assistant
 * 段落（每次工具循环一段）：stream_event 增量构建当前段，完整 assistant
 * 消息随后确认该段，user 消息携带 tool_result。旧实现按段落整体替换
 * content，早前段落的工具块（含知识确认卡的工具结果）在下一段到达时
 * 被丢弃——聊天卡片"闪现即逝"的根因。
 *
 * 段落按 sdkUuid 去重累积；uuid 为 null 的末尾段落是 stream_event 正在
 * 构建中的当前段。tool_result 就地写进所属段落，flatten() 始终返回全部
 * 段落的展平视图。
 */

export type WireTool = {
  id: string;
  name: string;
  inputJson?: string;
  parsedInput?: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
  isError?: boolean;
};

export type WireBlock =
  | { type: 'text'; text: string }
  | {
      type: 'thinking';
      thinking: string;
      thinkingStartedAt?: number;
      thinkingDurationMs?: number;
      isComplete?: boolean;
    }
  | { type: 'tool_use'; tool: WireTool };

type AssistantSegment = { uuid: string | null; blocks: WireBlock[] };

export interface AssistantTurnProjection {
  /** 当前流式段落的块数组；stream_event 以段内相对索引写入。 */
  pendingBlocks(): WireBlock[];
  /** 记录一个完整 assistant 段落（sdkUuid 去重，累积不替换）。 */
  recordAssistantSegment(uuid: string | undefined, content: unknown): void;
  /** 把 user 消息里的 tool_result 写进各段落的 tool_use 块。 */
  applyToolResults(content: unknown): void;
  /** 全部段落的展平视图。 */
  flatten(): WireBlock[];
  /** 轮次结束清空。 */
  reset(): void;
}

function mapAssistantBlocks(content: unknown): WireBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((raw): WireBlock[] => {
    if (!raw || typeof raw !== 'object') return [];
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: block.text }];
    }
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return [{ type: 'thinking', thinking: block.thinking, isComplete: true }];
    }
    if (
      block.type === 'tool_use'
      && typeof block.id === 'string'
      && typeof block.name === 'string'
    ) {
      return [{
        type: 'tool_use',
        tool: {
          id: block.id,
          name: block.name,
          inputJson: JSON.stringify(block.input ?? {}),
          parsedInput: (block.input ?? {}) as Record<string, unknown>,
          isLoading: true,
        },
      }];
    }
    return [];
  });
}

/** 完整段落替换半成品时，已应用的工具状态按 tool id 带回。 */
function mergeSegmentBlocks(
  previousBlocks: WireBlock[],
  finalBlocks: WireBlock[],
): WireBlock[] {
  const previous = new Map(
    previousBlocks
      .filter((block): block is Extract<WireBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => [block.tool.id, block.tool]),
  );
  return finalBlocks.map((block) => {
    if (block.type !== 'tool_use') return block;
    const prior = previous.get(block.tool.id);
    return prior ? { ...block, tool: { ...block.tool, ...prior } } : block;
  });
}

export function createAssistantTurnProjection(): AssistantTurnProjection {
  let segments: AssistantSegment[] = [];

  const pendingSegment = (): AssistantSegment => {
    const last = segments[segments.length - 1];
    if (last && last.uuid === null) return last;
    const segment: AssistantSegment = { uuid: null, blocks: [] };
    segments.push(segment);
    return segment;
  };

  return {
    pendingBlocks: () => pendingSegment().blocks,

    recordAssistantSegment(uuid, content) {
      const mapped = mapAssistantBlocks(content);
      const known = typeof uuid === 'string' ? uuid : null;
      const existing = known === null
        ? -1
        : segments.findIndex((segment) => segment.uuid === known);
      if (existing >= 0) {
        segments[existing].blocks = mergeSegmentBlocks(segments[existing].blocks, mapped);
      } else {
        const pending = pendingSegment();
        pending.uuid = known;
        pending.blocks = mergeSegmentBlocks(pending.blocks, mapped);
      }
    },

    applyToolResults(content) {
      if (!Array.isArray(content)) return;
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue;
        const block = raw as Record<string, unknown>;
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const body = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content ?? '');
        for (const segment of segments) {
          for (const toolBlock of segment.blocks) {
            if (toolBlock.type !== 'tool_use' || toolBlock.tool.id !== block.tool_use_id) continue;
            toolBlock.tool.result = body;
            toolBlock.tool.isLoading = false;
            toolBlock.tool.isError = block.is_error === true;
          }
        }
      }
    },

    flatten: () => segments.flatMap((segment) => segment.blocks),

    reset() {
      segments = [];
    },
  };
}
