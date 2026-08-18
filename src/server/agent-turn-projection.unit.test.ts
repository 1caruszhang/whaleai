import { describe, expect, it } from 'vitest';

import { createAssistantTurnProjection } from './agent-turn-projection';

/**
 * 回归：旧实现按 assistant 段落整体替换 content，多工具轮次里
 * 早前段落的 tool_use 块（知识确认卡的工具结果）在下一段到达时被
 * 丢弃——聊天卡片"闪现即逝"。段落必须累积保留。
 */
describe('createAssistantTurnProjection', () => {
  it('累积一个多段落轮次的全部块并就地保留工具结果', () => {
    const projection = createAssistantTurnProjection();

    // 段落 1：stream_event 开始构建 read_session_file 工具块。
    projection.pendingBlocks().push({
      type: 'tool_use',
      tool: { id: 't-read', name: 'mcp__xiaojing-geo__read_session_file', inputJson: '{}', isLoading: true },
    });
    projection.recordAssistantSegment('uuid-a', [
      { type: 'tool_use', id: 't-read', name: 'mcp__xiaojing-geo__read_session_file', input: { path: 'a.md' } },
    ]);
    projection.applyToolResults([
      { type: 'tool_result', tool_use_id: 't-read', content: '{"kind":"session-file-read","ok":true}' },
    ]);
    expect(projection.flatten()).toHaveLength(1);

    // 段落 2：新段落从空开始（段内索引不回写段落 1），text + import 工具。
    const segmentTwo = projection.pendingBlocks();
    expect(segmentTwo).toHaveLength(0);
    segmentTwo.push({ type: 'text', text: '我先读取了文件' });
    segmentTwo.push({
      type: 'tool_use',
      tool: { id: 't-import', name: 'mcp__xiaojing-geo__import_pasted_material', inputJson: '{}', isLoading: true },
    });
    projection.recordAssistantSegment('uuid-b', [
      { type: 'text', text: '我先读取了文件' },
      { type: 'tool_use', id: 't-import', name: 'mcp__xiaojing-geo__import_pasted_material', input: { text: '材料' } },
    ]);
    // MCP 工具结果是非字符串 content → 投影为 content blocks 数组 JSON。
    projection.applyToolResults([
      {
        type: 'tool_result',
        tool_use_id: 't-import',
        content: [{ type: 'text', text: '{"kind":"knowledge-candidates-card"}' }],
      },
    ]);

    // 段落 3：thinking + 收尾文本——旧实现此刻会把前两段全部覆盖掉。
    projection.recordAssistantSegment('uuid-c', [
      { type: 'thinking', thinking: '整理结论' },
      { type: 'text', text: '请在上方的确认卡片里勾选并确认。' },
    ]);

    const flattened = projection.flatten();
    expect(flattened.map((block) => block.type)).toEqual([
      'tool_use', 'text', 'tool_use', 'thinking', 'text',
    ]);
    const readBlock = flattened[0];
    if (readBlock.type !== 'tool_use') throw new Error('expected tool block');
    expect(readBlock.tool.result).toBe('{"kind":"session-file-read","ok":true}');
    expect(readBlock.tool.isLoading).toBe(false);
    const importBlock = flattened[2];
    if (importBlock.type !== 'tool_use') throw new Error('expected tool block');
    expect(importBlock.tool.result).toBe(
      JSON.stringify([{ type: 'text', text: '{"kind":"knowledge-candidates-card"}' }]),
    );
    expect(importBlock.tool.isLoading).toBe(false);
  });

  it('同一 sdkUuid 重放去重且保留已应用结果；reset 清空', () => {
    const projection = createAssistantTurnProjection();
    projection.recordAssistantSegment('uuid-a', [
      { type: 'tool_use', id: 't1', name: 'tool', input: {} },
    ]);
    projection.applyToolResults([
      { type: 'tool_result', tool_use_id: 't1', content: 'result-body' },
    ]);
    // 重放同一段：不追加副本，工具状态带回。
    projection.recordAssistantSegment('uuid-a', [
      { type: 'tool_use', id: 't1', name: 'tool', input: {} },
    ]);
    const flattened = projection.flatten();
    expect(flattened).toHaveLength(1);
    const block = flattened[0];
    if (block.type !== 'tool_use') throw new Error('expected tool block');
    expect(block.tool.result).toBe('result-body');

    projection.reset();
    expect(projection.flatten()).toHaveLength(0);
    expect(projection.pendingBlocks()).toHaveLength(0);
  });
});
