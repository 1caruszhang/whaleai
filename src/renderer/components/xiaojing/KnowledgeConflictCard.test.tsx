import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme as render } from '@/test/renderWithTheme';

const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
}));

import KnowledgeConflictCard, {
  parseKnowledgeConflictCard,
  type KnowledgeConflictCardData,
} from './KnowledgeConflictCard';

const card: KnowledgeConflictCardData = {
  kind: 'knowledge-conflict-card',
  requiresUserDecision: true,
  candidate: {
    id: 'candidate-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    key: {
      subject: '鲸跃科技',
      predicate: '产品价格',
      scopeJson: '{"region":"cn"}',
    },
    normalizedValueJson: '1299',
    unit: 'cny',
    status: 'conflict',
    baseVersion: 4,
    current: {
      normalizedValueJson: '999',
      unit: 'cny',
      version: 4,
      confirmedBy: 'user-1',
      confirmedAt: '2026-08-15T00:00:00.000Z',
    },
    source: { excerpt: '官网报价 1299 元', confidence: 0.96 },
  },
};

describe('KnowledgeConflictCard', () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.apiPost.mockResolvedValue({ success: true, result: { status: 'adopted' } });
  });

  it('parses only the product-owned structured result', () => {
    expect(parseKnowledgeConflictCard(JSON.stringify(card))).toEqual(card);
    expect(parseKnowledgeConflictCard('{"kind":"other"}')).toBeNull();
  });

  it('shows all four decisions and submits a structured action without a chat message', async () => {
    render(<KnowledgeConflictCard data={card} />);

    expect(screen.getByRole('button', { name: '保留当前值' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采用新值' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /拆分范围/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /拒绝候选/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '采用新值' }));

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/api/xiaojing/knowledge/decide',
      expect.objectContaining({
        workspaceId: 'brand-1',
        sessionId: 'session-1',
        candidateId: 'candidate-1',
        decision: 'adopt-new',
        expectedCurrentVersion: 4,
      }),
    ));
    expect(screen.getByText(/裁决已提交并记录审计/)).toBeInTheDocument();
  });

  it('requires split scope to change the structured key', async () => {
    mocks.apiPost.mockRejectedValueOnce(new Error('split-scope must change scope or effective time'));
    render(<KnowledgeConflictCard data={card} />);
    fireEvent.click(screen.getByRole('button', { name: /拆分范围/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认拆分范围' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('split-scope must change scope or effective time');
  });
});
