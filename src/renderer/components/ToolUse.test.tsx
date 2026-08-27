/**
 * 回归：通用工具行此前只展示 MCP FQN 与输入 `{}`，工具结果对用户完全
 * 不可见（"套壳感"的直接来源）。现登记工具显示动作标签，展开后输入与
 * 结果分段呈现，含加载/错误态。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ToolUse from './ToolUse';
import type { ToolUseSimple } from '@/types/chat';
import type { ArticleOperationProjection } from '../../shared/geo/articleGeneration';

// 批准卡渲染需要 Tab 上下文与文章 client；通用过程行用例不触发它们。
vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: vi.fn() }),
  useTabState: () => ({ sessionId: 'session-1' }),
}));
vi.mock('@/api/articleGenerationClient', () => ({
  loadArticleBody: vi.fn(),
  loadLatestArticleOperation: vi.fn(() => Promise.resolve(null)),
  editArticle: vi.fn(),
  approveArticle: vi.fn(),
  retryArticle: vi.fn(),
}));

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

// 回归（2026-08-26 线上报障）：confirm_ranking_competitors 补足竞品后恢复
// 生成，返回与 generate_articles 相同的 article-operation 信封；此前批准卡
// 只按 generate_articles 工具名分发，该信封落入通用折叠行，用户看不到卡片。
describe('ToolUse 批准卡按信封分发', () => {
  const operation = {
    id: 'operation-19',
    workspaceId: 'brand-19',
    createdBySessionId: 'session-1',
    sourceKind: 'confirmed-topic-plan',
    topicPlanId: 'plan-1',
    topicPlanRevision: 2,
    knowledgeVersion: 13,
    policyVersion: 'xiaojing-content-prompt-v3',
    status: 'running',
    articles: [{
      id: 'article-19',
      operationId: 'operation-19',
      workspaceId: 'brand-19',
      sourcePlanItemId: 'item-1',
      knowledgeVersion: 13,
      contentType: 'ranking',
      topic: '对比主题',
      requestedTitle: '对比清单草稿',
      constraints: '',
      plannedFacts: [],
      status: 'draft_ready',
      revision: 1,
      approvedRevision: null,
      failureReason: null,
      generationAttempt: 1,
      currentVersion: null,
      approvedVersion: null,
      createdAt: '2026-08-26T07:40:23Z',
      updatedAt: '2026-08-26T07:43:58Z',
    }],
    createdAt: '2026-08-26T07:40:23Z',
    updatedAt: '2026-08-26T07:43:58Z',
  } as unknown as ArticleOperationProjection;

  it('renders the approval card from the confirm_ranking_competitors envelope', () => {
    render(
      <ToolUse
        tool={tool({
          name: 'mcp__xiaojing-geo__confirm_ranking_competitors',
          result: wrappedResultText({ kind: 'article-operation', operation }),
        })}
      />,
    );
    expect(
      screen.getByRole('region', { name: '文章审核批准' }),
    ).toBeInTheDocument();
  });

  it('renders the approval card from the get_article_operation envelope', () => {
    render(
      <ToolUse
        tool={tool({
          name: 'mcp__xiaojing-geo__get_article_operation',
          result: wrappedResultText({ kind: 'article-operation', operation }),
        })}
      />,
    );
    expect(
      screen.getByRole('region', { name: '文章审核批准' }),
    ).toBeInTheDocument();
  });

  it('keeps non-envelope competitor results as labelled process rows', () => {
    render(
      <ToolUse
        tool={tool({
          name: 'mcp__xiaojing-geo__confirm_ranking_competitors',
          result: wrappedResultText({
            kind: 'ranking-competitors-required',
            confirmedCount: 0,
            missingCount: 5,
            instruction: '还差 5 家',
          }),
        })}
      />,
    );
    expect(
      screen.queryByRole('region', { name: '文章审核批准' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('确认排行榜竞品')).toBeInTheDocument();
  });
});
