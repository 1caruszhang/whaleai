import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeCompetitorEvidence } from '../../../shared/geo/competitorDetails';
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
    expect(await screen.findByText('鲸跃科技 / 品牌全称')).toBeInTheDocument();
    expect(screen.getByText('鲸跃科技有限公司')).toBeInTheDocument();
    expect(screen.getByText('技术领先、交付快')).toBeInTheDocument();
    expect(screen.getByText(/知识版本 v6/)).toBeInTheDocument();
    // 旧版本 v3 的事实不出现在当前权威面板。
    expect(screen.queryByText('旧名称')).not.toBeInTheDocument();
    expect(screen.getByText(/2 条事实/)).toBeInTheDocument();
    expect(screen.getByText(/1 份依据/)).toBeInTheDocument();
  });

  // 回归：入库 predicate 被小写化（servicearea），面板必须经规范字段映射
  // 显示中文标签，而不是裸露 `enterprise-profile.servicearea`。
  it('maps profile predicates (any case) onto readable field labels', async () => {
    mocks.load.mockResolvedValue({
      workspaceId: 'brand-17',
      knowledgeVersions: [
        {
          version: 2,
          actorSessionId: 'session-b',
          createdAt: '2026-08-16T00:00:00Z',
          facts: [
            {
              factKey: factKey('鲸跃科技', 'enterprise-profile.servicearea'),
              factVersion: 1,
              normalizedValueJson: '"新都区"',
              sources: [],
            },
            {
              factKey: factKey('鲸跃科技', 'crm.seatCount'),
              factVersion: 1,
              normalizedValueJson: '120',
              sources: [],
            },
          ],
          usedBy: [],
        },
      ],
      artifacts: [],
    });

    render(<XiaojingBrandKnowledgePanel workspaceId="brand-17" />);
    fireEvent.click(screen.getByRole('button', { name: /品牌知识/ }));
    expect(await screen.findByText('鲸跃科技 / 服务区域')).toBeInTheDocument();
    // 非 Profile 字段保持 predicate 原文。
    expect(screen.getByText('鲸跃科技 / crm.seatCount')).toBeInTheDocument();
    expect(screen.queryByText(/enterprise-profile\./)).not.toBeInTheDocument();
  });

  it('已确认竞品在当前权威投影中仍显示名称、地域与同类业务', async () => {
    mocks.load.mockResolvedValue({
      workspaceId: 'brand-17',
      knowledgeVersions: [{
        version: 7,
        actorSessionId: 'session-b',
        createdAt: '2026-08-16T00:00:00Z',
        facts: [{
          factKey: factKey('鲸跃科技', 'enterprise-profile.competitors'),
          factVersion: 1,
          normalizedValueJson: '["成实外教育","为明教育"]',
          sources: [{
            materialId: 'material-1',
            excerpt: encodeCompetitorEvidence([
              { name: '成实外教育', region: '成都', similarBusiness: '民办中学教育' },
              { name: '为明教育', region: '成都', similarBusiness: '民办中学教育' },
            ], '联网竞品证据', 4_000),
            origin: 'user-approved-material',
            createdAt: '2026-08-16T00:00:00Z',
          }],
        }],
        usedBy: [],
      }],
      artifacts: [],
    });

    render(<XiaojingBrandKnowledgePanel workspaceId="brand-17" />);
    fireEvent.click(screen.getByRole('button', { name: /品牌知识/ }));

    expect(await screen.findByText('成实外教育｜成都｜民办中学教育、为明教育｜成都｜民办中学教育')).toBeInTheDocument();
    expect(screen.queryByText(/xiaojing-competitor-details/)).not.toBeInTheDocument();
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
