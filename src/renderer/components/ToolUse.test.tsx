/**
 * 回归：通用工具行此前只展示 MCP FQN 与输入 `{}`，工具结果对用户完全
 * 不可见（"套壳感"的直接来源）。现登记工具显示动作标签，展开后输入与
 * 结果分段呈现，含加载/错误态。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ToolUse from './ToolUse';
import type { ToolUseSimple } from '@/types/chat';

afterEach(() => cleanup());

function tool(overrides: Partial<ToolUseSimple>): ToolUseSimple {
  return {
    id: 't1',
    name: 'mcp__xiaojing-geo__inspect_geo_operations',
    inputJson: '{}',
    isLoading: false,
    ...overrides,
  };
}

/** 生产投影形态：MCP content blocks 数组壳（agent-session applyToolResults）。 */
function wrappedResultText(payload: unknown): string {
  return JSON.stringify([{ type: 'text', text: JSON.stringify(payload) }]);
}

describe('ToolUse 通用过程行', () => {
  it('shows the registered action label and hides the empty `{}` input', () => {
    render(
      <ToolUse
        tool={tool({ result: wrappedResultText({ kind: 'session-file-read', ok: true }) })}
      />,
    );

    const row = screen.getByRole('button', { name: /查看 GEO 操作/ });
    expect(row).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText('结果')).toBeInTheDocument();
    expect(screen.queryByText('{}')).not.toBeInTheDocument();
  });

  it('reveals the tool result with input arguments when expanded', () => {
    render(
      <ToolUse
        tool={tool({
          name: 'mcp__xiaojing-geo__read_session_file',
          inputJson: '{"path":"xiaojing_files/s1/notes.md"}',
          result: wrappedResultText({ kind: 'session-file-read', ok: true }),
        })}
      />,
    );

    expect(screen.getByText('读取会话文件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /读取会话文件/ }));
    expect(screen.getByText('输入')).toBeInTheDocument();
    expect(screen.getByText(/xiaojing_files\/s1\/notes\.md/)).toBeInTheDocument();
  });

  it('falls back to the raw name for unregistered tools', () => {
    render(<ToolUse tool={tool({ name: 'AskUserQuestion', inputJson: '{"q":1}' })} />);

    expect(screen.getByText('AskUserQuestion')).toBeInTheDocument();
  });

  it('surfaces running and failed states with text, not color alone', () => {
    const { unmount } = render(<ToolUse tool={tool({ isLoading: true })} />);
    fireEvent.click(screen.getByRole('button', { name: /查看 GEO 操作/ }));
    expect(screen.getByText('执行中')).toBeInTheDocument();
    unmount();

    render(
      <ToolUse
        tool={tool({ result: wrappedResultText({ ok: false }), isError: true })}
      />,
    );
    expect(screen.getByText('调用失败')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /查看 GEO 操作/ }));
    expect(screen.getByText('调用失败')).toBeInTheDocument();
  });

  it('notes when a long result is truncated', () => {
    const long = 'x'.repeat(3000);
    render(<ToolUse tool={tool({ result: wrappedResultText({ text: long }) })} />);
    fireEvent.click(screen.getByRole('button', { name: /查看 GEO 操作/ }));
    expect(screen.getByText(/已截断显示/)).toBeInTheDocument();
  });
});
