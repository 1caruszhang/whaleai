/**
 * 决策卡不得被 BlockGroup 折叠卸载（回归：知识确认卡/计划卡随工具行增多
 * 被"1 头 + N 折叠 + 1 尾"布局吞掉，agent 让用户确认但页面上无卡片）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({}),
}));

import Message from './Message';
import type { ContentBlock, Message as MessageType, ToolUseSimple } from '@/types/chat';
import {
  buildKnowledgeCandidatesCardData,
  toKnowledgeCardCandidate,
} from '../../shared/geo/knowledgeCard';
import { renderWithTheme } from '@/test/renderWithTheme';

afterEach(() => cleanup());

function toolUse(id: string, name: string, result?: string): ContentBlock {
  const tool: ToolUseSimple = {
    id,
    name,
    inputJson: '{}',
    isLoading: false,
    ...(result !== undefined ? { result } : {}),
  };
  return { type: 'tool_use', tool };
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

function assistantMessage(content: ContentBlock[]): MessageType {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content,
    timestamp: new Date('2026-08-16T14:27:00Z'),
  };
}

function batchCardSource() {
  return toKnowledgeCardCandidate({
    id: 'candidate-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    key: {
      subject: '行乐音改',
      predicate: 'enterprise-profile.fullName',
      scopeJson: '{"entityScope":"brand"}',
      effectiveFrom: null,
      effectiveTo: null,
    },
    valueJson: '"成都行乐音改"',
    normalizedValueJson: '"成都行乐音改"',
    unit: null,
    status: 'awaiting-confirmation',
    baseVersion: 0,
    origin: 'model-inferred',
    source: { materialId: 'material-1', excerpt: '成都本土连锁', confidence: 0.9 },
    current: null,
  });
}

function wrappedBatchCardResult(): string {
  const card = buildKnowledgeCandidatesCardData(
    { id: 'material-1', displayName: '行乐音改信息.txt' },
    [batchCardSource()],
  );
  // 生产投影形态：MCP content blocks 数组壳（agent-session applyToolResults）。
  return JSON.stringify([{ type: 'text', text: JSON.stringify(card) }]);
}

const geoOperationResult = JSON.stringify([{
  type: 'text',
  text: JSON.stringify({
    kind: 'geo-operation',
    operation: {
      id: 'op-1',
      workspaceId: 'brand-1',
      sessionId: 'session-1',
      goal: '完整 GEO 优化',
      status: 'awaiting-confirmation',
      revision: 1,
      steps: [{ id: 'step-1', title: '品牌理解', status: 'succeeded' }],
    },
  }),
}]);

describe('Message 决策卡渲染', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.apiPost.mockResolvedValue({ success: true, candidates: [null] });
  });

  it('知识批量确认卡被折叠组包围时仍然可见', () => {
    renderWithTheme(
      <Message message={assistantMessage([
        textBlock('我先读取并导入了资料。'),
        toolUse('t1', 'mcp__xiaojing-geo__read_session_file', '{"kind":"session-file-read","ok":true}'),
        toolUse('t2', 'mcp__xiaojing-geo__inspect_brand_context', '{"ok":true}'),
        toolUse('t3', 'mcp__xiaojing-geo__import_pasted_material', wrappedBatchCardResult()),
        toolUse('t4', 'mcp__xiaojing-geo__inspect_geo_operations', '{"ok":true}'),
        textBlock('请在上方的确认卡片里勾选并确认。'),
      ])} />,
    );

    const card = screen.getByText('品牌知识待确认');
    expect(card).toBeInTheDocument();
    // 卡片在折叠组之外：周围工具行被折叠也不影响操作按钮；复核卡默认展开，
    // 字段行与整卡确认按钮直接可操作（GD-35 字段行复核卡）。
    expect(screen.getByRole('button', { name: '确认（采纳全部 1 条）' })).toBeInTheDocument();
    expect(screen.getByText('品牌全称')).toBeInTheDocument();
  });

  it('决策卡统一渲染在全部正文之后（先读结论再操作）', () => {
    renderWithTheme(
      <Message message={assistantMessage([
        textBlock('我先读取并导入了资料。'),
        toolUse('t3', 'mcp__xiaojing-geo__import_pasted_material', wrappedBatchCardResult()),
        textBlock('请在上方的确认卡片里勾选并确认。'),
      ])} />,
    );

    const conclusion = screen.getByText('请在上方的确认卡片里勾选并确认。');
    const cardSection = screen.getByText('品牌知识待确认').closest('section');
    expect(cardSection).not.toBeNull();
    expect(conclusion.compareDocumentPosition(cardSection as Node) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('GeoOperation 计划卡同样免于折叠（回归：随工具行增多消失）', () => {
    renderWithTheme(
      <Message message={assistantMessage([
        textBlock('开始执行。'),
        toolUse('t1', 'mcp__xiaojing-geo__read_session_file', '{"kind":"session-file-read","ok":true}'),
        toolUse('t2', 'mcp__xiaojing-geo__inspect_brand_context', '{"ok":true}'),
        toolUse('t3', 'mcp__xiaojing-geo__start_geo_operation', geoOperationResult),
        toolUse('t4', 'mcp__xiaojing-geo__inspect_geo_operations', '{"ok":true}'),
        toolUse('t5', 'mcp__xiaojing-geo__choose_next_round_knowledge', '{"ok":true}'),
        textBlock('已创建操作。'),
      ])} />,
    );

    expect(screen.getByText('GEO 操作已更新')).toBeInTheDocument();
    expect(screen.getByText('完整 GEO 优化')).toBeInTheDocument();
    expect(screen.getByText(/1\/1 步/)).toBeInTheDocument();
  });

  // GD-13 后续回归：思考/流式未结束时决策卡不出现，
  // 等本回合收尾、用户读完结论后再出现。
  it('思考未结束时不出决策卡，回合收尾后才出现', () => {
    const content: ContentBlock[] = [
      textBlock('开始执行。'),
      toolUse('t3', 'mcp__xiaojing-geo__start_geo_operation', geoOperationResult),
    ];
    const streaming = renderWithTheme(
      <Message message={assistantMessage(content)} isLoading />,
    );
    expect(screen.queryByText('GEO 操作已更新')).not.toBeInTheDocument();
    streaming.unmount();
    cleanup();

    renderWithTheme(<Message message={assistantMessage(content)} />);
    expect(screen.getByText('GEO 操作已更新')).toBeInTheDocument();
  });

  it('空 GEO 操作列表渲染显式空态卡，而不是裸工具行', () => {
    const emptyProjection = JSON.stringify([{
      type: 'text',
      text: JSON.stringify({ kind: 'geo-operation-projection', result: [] }),
    }]);
    renderWithTheme(
      <Message message={assistantMessage([
        textBlock('我查看了当前会话的操作记录。'),
        toolUse('t1', 'mcp__xiaojing-geo__inspect_geo_operations', emptyProjection),
        textBlock('当前还没有 GEO 操作，需要的话可以从一个明确目标开始。'),
      ])} />,
    );

    expect(screen.getByText('当前会话还没有 GEO 操作记录。')).toBeInTheDocument();
  });

  it('普通工具结果仍走折叠组，不因卡片豁免而全部展开', () => {
    render(
      <Message message={assistantMessage([
        textBlock('读取文件。'),
        toolUse('t1', 'mcp__xiaojing-geo__read_session_file', '{"kind":"session-file-read","ok":true}'),
        toolUse('t2', 'mcp__xiaojing-geo__inspect_brand_context', '{"ok":true}'),
        toolUse('t3', 'mcp__xiaojing-geo__inspect_geo_operations', '{"ok":true}'),
        toolUse('t4', 'mcp__xiaojing-geo__control_geo_operation', '{"ok":true}'),
        textBlock('完成。'),
      ])} />,
    );

    // ≥4 个普通工具行触发折叠条；没有卡片被豁免。
    expect(screen.getByRole('button', { name: /展开全部/ })).toBeInTheDocument();
    expect(screen.queryByText('品牌知识待确认')).not.toBeInTheDocument();
  });
});
