import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import XiaojingBrandKnowledgePanel from './XiaojingBrandKnowledgePanel';
import { KNOWLEDGE_DECIDED_EVENT } from './KnowledgeBatchCard';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock('@/api/brandHistoryClient', () => ({
  loadBrandHistory: mocks.load,
}));

function factKey(subject: string, predicate: string): string {
  return JSON.stringify({ subject, predicate, scope: {}, effectiveFrom: null, effectiveTo: null });
}

describe('XiaojingBrandKnowledgePanel', () => {
  beforeEach(() => mocks.load.mockReset());

  it('expands lazily and shows only the latest authoritative knowledge version', async () => {
    mocks.load.mockResolvedValue({
      workspaceId: 'brand-17',
      knowledgeVersions: [
        {
          version: 3,
          actorSessionId: 'session-a',
          createdAt: '2026-08-14T00:00:00Z',
          facts: [{
            factKey: factKey('鲸跃科技', 'enterprise-profile.fullName'),
            factVersion: 1,
            normalizedValueJson: '"旧名称"',
            sources: [],
          }],
          usedBy: [],
        },
        {
          version: 6,
          actorSessionId: 'session-b',
          createdAt: '2026-08-16T00:00:00Z',
          facts: [
            {
              factKey: factKey('鲸跃科技', 'enterprise-profile.fullName'),
              factVersion: 2,
              normalizedValueJson: '"鲸跃科技有限公司"',
              sources: [
                { materialId: 'material-1', excerpt: '公司全称', origin: 'user-approved-material', createdAt: '2026-08-16T00:00:00Z' },
              ],
            },
            {
              factKey: factKey('鲸跃科技/旗舰产品', 'enterprise-profile.coreAdvantages'),
              factVersion: 1,
              normalizedValueJson: '["技术领先","交付快"]',
              sources: [],
            },
          ],
          usedBy: [],
        },
      ],
      artifacts: [],
    });

    render(<XiaojingBrandKnowledgePanel workspaceId="brand-17" />);
    expect(mocks.load).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /品牌知识/ }));
    expect(await screen.findByText('鲸跃科技 / enterprise-profile.fullName')).toBeInTheDocument();
    expect(screen.getByText('鲸跃科技有限公司')).toBeInTheDocument();
    expect(screen.getByText('技术领先、交付快')).toBeInTheDocument();
    expect(screen.getByText(/知识版本 v6/)).toBeInTheDocument();
    // 旧版本 v3 的事实不出现在当前权威面板。
    expect(screen.queryByText('旧名称')).not.toBeInTheDocument();
    expect(screen.getByText(/2 条事实/)).toBeInTheDocument();
    expect(screen.getByText(/1 份依据/)).toBeInTheDocument();
  });

  it('refreshes when a confirmation card commits decisions', async () => {
    mocks.load.mockResolvedValue({
      workspaceId: 'brand-17',
      knowledgeVersions: [],
      artifacts: [],
    });
    render(<XiaojingBrandKnowledgePanel workspaceId="brand-17" />);
    fireEvent.click(screen.getByRole('button', { name: /品牌知识/ }));
    await screen.findByText(/暂无已确认知识/);

    window.dispatchEvent(new CustomEvent(KNOWLEDGE_DECIDED_EVENT, {
      detail: { workspaceId: 'brand-17' },
    }));
    await waitFor(() => expect(mocks.load.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('keeps load failures recoverable', async () => {
    mocks.load.mockRejectedValueOnce(new Error('knowledge unavailable'));
    render(<XiaojingBrandKnowledgePanel workspaceId="brand-17" />);
    fireEvent.click(screen.getByRole('button', { name: /品牌知识/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('knowledge unavailable');
  });
});
