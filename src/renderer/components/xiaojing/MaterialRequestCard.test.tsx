import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrandMaterialProcessResult, TabApiPost } from '@/api/brandMaterialClient';
import MaterialRequestCard from './MaterialRequestCard';

const mocks = vi.hoisted(() => ({
  sessionId: 'session-07',
  hasWorkspace: true,
  apiPost: vi.fn(),
  open: vi.fn(),
  importFiles: vi.fn(),
  importText: vi.fn(),
  importWebsite: vi.fn(),
  retry: vi.fn(),
  deleteMaterial: vi.fn(),
  fetchStatuses: vi.fn(),
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost as unknown as TabApiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock('@/context/CurrentWorkspaceContext', () => ({
  useCurrentWorkspace: () =>
    mocks.hasWorkspace
      ? {
        id: 'brand-07',
        name: '鲸跃科技',
        productLines: ['旗舰产品'],
        rootPath: 'C:\\Xiaojing\\brands\\brand-07',
        createdAt: '2026-08-15T00:00:00Z',
        updatedAt: '2026-08-15T00:00:00Z',
      }
      : null,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));

vi.mock('@/api/brandMaterialClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/brandMaterialClient')>();
  return {
    ...actual,
    importBrandMaterialFiles: mocks.importFiles,
    importBrandMaterialText: mocks.importText,
    importBrandMaterialWebsite: mocks.importWebsite,
    retryBrandMaterial: mocks.retry,
    deleteBrandMaterial: mocks.deleteMaterial,
    fetchBrandMaterialStatuses: mocks.fetchStatuses,
  };
});

function started(id: string, kind: 'file' | 'pasted-text' | 'website-url'): BrandMaterialProcessResult {
  return {
    ok: true,
    material: {
      id,
      workspaceId: 'brand-07',
      inputKind: kind,
      displayName: `${id}.txt`,
      status: 'stored',
      attemptCount: 0,
    },
  };
}

function statusEntry(input: {
  id: string;
  displayName?: string;
  status: 'processing' | 'awaiting-confirmation' | 'processed' | 'failed';
  lastErrorCode?: string;
  candidateCount?: number;
}) {
  const candidates = Array.from({ length: input.candidateCount ?? 0 }, (_unused, index) => ({
    id: `candidate-${input.id}-${index}`,
    workspaceId: 'brand-07',
    sessionId: mocks.sessionId,
    key: {
      subject: '鲸跃科技',
      predicate: `enterprise-profile.field${index}`,
      scopeJson: '{}',
      effectiveFrom: null,
      effectiveTo: null,
    },
    valueJson: '"值"',
    normalizedValueJson: '"值"',
    unit: null,
    status: 'awaiting-confirmation',
    baseVersion: 0,
    origin: 'model-inferred',
    source: {
      materialId: input.id,
      excerpt: '材料原文依据',
      confidence: 0.9,
      profileProvenance: 'extracted',
    },
    current: null,
  }));
  return {
    material: {
      id: input.id,
      workspaceId: 'brand-07',
      inputKind: 'file' as const,
      displayName: input.displayName ?? `${input.id}.txt`,
      status: input.status,
      attemptCount: 1,
      ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
    },
    card: input.status === 'awaiting-confirmation' && candidates.length > 0
      ? {
        kind: 'knowledge-candidates-card' as const,
        requiresUserDecision: true as const,
        material: { id: input.id, displayName: input.displayName ?? `${input.id}.txt` },
        candidates,
      }
      : null,
  };
}

function renderRequestCard(reason = '还没有已确认的品牌知识，先补充材料再推进计划。') {
  return render(
    <MaterialRequestCard
      data={{ kind: 'material-request-card', requiresUserDecision: true, reason }}
    />,
  );
}

describe('MaterialRequestCard', () => {
  beforeEach(() => {
    mocks.sessionId = 'session-07';
    mocks.hasWorkspace = true;
    for (const mock of [
      mocks.apiPost,
      mocks.open,
      mocks.importFiles,
      mocks.importText,
      mocks.importWebsite,
      mocks.retry,
      mocks.deleteMaterial,
      mocks.fetchStatuses,
    ]) mock.mockReset();
    // 默认恢复查询返回空；个别用例按需覆盖。
    mocks.fetchStatuses.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders expanded with the agent reason and all three upload paths', () => {
    renderRequestCard('计划需要行业与产品线事实，但品牌还没有已确认知识。');

    expect(screen.getByText('补充品牌材料')).toBeInTheDocument();
    expect(
      screen.getByText('计划需要行业与产品线事实，但品牌还没有已确认知识。'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://example.com/about')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeInTheDocument();
  });

  it('imports selected files, keeps per-file storage success/failure visible, and retries only one material', async () => {
    mocks.open.mockResolvedValue([
      'C:\\selected\\profile.pdf',
      'C:\\selected\\broken.docx',
    ]);
    mocks.importFiles.mockResolvedValue([
      started('material-ok', 'file'),
      { ok: false, errorCode: 'material_import_failed' },
    ] satisfies BrandMaterialProcessResult[]);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    await waitFor(() => expect(mocks.importFiles).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      ['C:\\selected\\profile.pdf', 'C:\\selected\\broken.docx'],
    ));
    const results = await screen.findByRole('region', { name: '材料处理结果' });
    expect(within(results).getByText('profile.pdf')).toBeInTheDocument();
    expect(within(results).getByText('broken.docx')).toBeInTheDocument();
    // 存储成功 → 后台处理中；存储失败 → 立即失败行。
    expect(within(results).getByText(/正在保存并抽取/)).toBeInTheDocument();
    expect(within(results).getByText('处理失败：material_import_failed')).toBeInTheDocument();
    expect(within(results).getByText('materialId: material-ok')).toBeInTheDocument();
    expect(results.textContent).not.toContain('C:\\selected');

    // 只有拿到 materialId 的失败行才能单材料重试。
    expect(within(results).queryByRole('button', { name: '仅重试 broken.docx' })).not.toBeInTheDocument();
  });

  it('imports pasted text, collapses the form, and stops at the in-chat confirmation card', async () => {
    vi.useFakeTimers();
    mocks.importText.mockResolvedValue([started('material-paste', 'pasted-text')]);
    renderRequestCard();

    fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
      target: { value: '公司全称：鲸跃科技' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.importText).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      '公司全称：鲸跃科技',
    );
    expect(screen.getByText(/正在保存并抽取/)).toBeInTheDocument();
    // 提交后表单收起：流程停在卡内的结果与确认卡，而不是停留在表单。
    expect(
      screen.queryByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
    ).not.toBeInTheDocument();

    // 抽取期间轮询返回 processing：行保持处理中，不出卡。
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-paste', status: 'processing' }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.fetchStatuses).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      ['material-paste'],
    );
    expect(screen.getByText(/正在保存并抽取/)).toBeInTheDocument();

    // 终态返回候选：行成功 + 确认卡弹出。
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-paste', status: 'awaiting-confirmation', candidateCount: 2 }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByText('已生成 2 条待确认事实')).toBeInTheDocument();
    expect(screen.getByText('materialId: material-paste')).toBeInTheDocument();
    const cards = screen.getByRole('region', { name: '待确认知识候选' });
    expect(within(cards).getByText('品牌知识待确认')).toBeInTheDocument();
  });

  it('imports an official-site URL through the same in-card flow', async () => {
    mocks.importWebsite.mockResolvedValue([started('material-site', 'website-url')]);
    renderRequestCard();

    fireEvent.change(screen.getByPlaceholderText('https://example.com/about'), {
      target: { value: 'https://example.com/about' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取官网资料' }));

    await waitFor(() => expect(mocks.importWebsite).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      'https://example.com/about',
    ));
    expect(await screen.findByText(/正在保存并抽取/)).toBeInTheDocument();
    // URL 提交成功同样收起表单，停在卡内处理结果。
    expect(screen.queryByPlaceholderText('https://example.com/about')).not.toBeInTheDocument();
  });

  it('recovers session cards and in-flight rows after remount', async () => {
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-done', status: 'awaiting-confirmation', candidateCount: 1 }),
      statusEntry({ id: 'material-running', displayName: '在途材料.docx', status: 'processing' }),
    ]);
    renderRequestCard();

    const cards = await screen.findByRole('region', { name: '待确认知识候选' });
    expect(within(cards).getByText('品牌知识待确认')).toBeInTheDocument();
    const results = await screen.findByRole('region', { name: '材料处理结果' });
    expect(within(results).getByText('在途材料.docx')).toBeInTheDocument();
    expect(within(results).getByText(/正在保存并抽取/)).toBeInTheDocument();
    // 恢复接管的在途行允许直接重试：原后台队列可能已随 Sidecar 进程消失。
    expect(within(results).getByRole('button', { name: '仅重试 在途材料.docx' })).toBeInTheDocument();
  });

  it('marks transport failures as material_request_failed instead of import failure', async () => {
    mocks.importText.mockRejectedValue(new Error('proxy timeout'));
    renderRequestCard();

    fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
      target: { value: '公司全称：鲸跃科技' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));

    expect(await screen.findByText('处理失败：material_request_failed')).toBeInTheDocument();
  });

  it('retries one material through the background queue', async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue(['C:\\selected\\profile.pdf']);
    mocks.importFiles.mockResolvedValue([started('material-x', 'file')]);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/正在保存并抽取/)).toBeInTheDocument();

    // 轮询落败后出现重试按钮；重试重新进入后台处理。
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-x', status: 'failed', lastErrorCode: 'model_failed' }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    const results = screen.getByRole('region', { name: '材料处理结果' });
    expect(within(results).getByText('处理失败：model_failed')).toBeInTheDocument();
    mocks.retry.mockResolvedValue([started('material-x', 'file')]);
    fireEvent.click(within(results).getByRole('button', { name: '仅重试 profile.pdf' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.retry).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      'material-x',
    );
    expect(within(results).getByText(/正在保存并抽取/)).toBeInTheDocument();
  });

  it('disables all upload paths when the Tab has no exact-match brand', () => {
    mocks.hasWorkspace = false;
    renderRequestCard();

    expect(screen.getByText(/当前聊天没有精确匹配的品牌/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取粘贴资料' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取官网资料' })).toBeDisabled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.importFiles).not.toHaveBeenCalled();
  });

  it('silently blocks uploads while the Tab still has a pending Session identity', () => {
    // 卡片只出现在真实 Session 的转录里；守卫只兜恢复窗口，不给提示 UI。
    mocks.sessionId = 'pending-brand-07';
    renderRequestCard();

    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取粘贴资料' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取官网资料' })).toBeDisabled();
    expect(mocks.fetchStatuses).not.toHaveBeenCalled();
  });

  it('removes one material with its pending candidates from the card', async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue(['C:\\selected\\wrong.pdf']);
    mocks.importFiles.mockResolvedValue([started('material-wrong', 'file')]);
    mocks.deleteMaterial.mockResolvedValue(undefined);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // 抽取成功出确认卡后出现「移除」；点击删除本体并摘掉行与确认卡。
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-wrong', displayName: 'wrong.pdf', status: 'awaiting-confirmation', candidateCount: 1 }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    const results = screen.getByRole('region', { name: '材料处理结果' });
    const removeButton = within(results).getByRole('button', { name: '移除 wrong.pdf' });
    fireEvent.click(removeButton);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(mocks.deleteMaterial).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      'material-wrong',
    );
    expect(screen.queryByRole('region', { name: '材料处理结果' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '待确认知识候选' })).not.toBeInTheDocument();
  });

  it('surfaces a delete failure without dropping the row', async () => {
    vi.useFakeTimers();
    mocks.importText.mockResolvedValue([started('material-stuck', 'pasted-text')]);
    mocks.deleteMaterial.mockRejectedValue(new Error('material_processing_active'));
    renderRequestCard();

    fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
      target: { value: '公司全称：鲸跃科技' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-stuck', status: 'failed', lastErrorCode: 'model_failed' }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    const results = screen.getByRole('region', { name: '材料处理结果' });
    fireEvent.click(within(results).getByRole('button', { name: '移除 粘贴资料' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // 删除失败：行保留并透传服务端固定码（处理中稍后再删），材料本体仍在。
    expect(within(results).getByText('处理失败：material_processing_active')).toBeInTheDocument();
    expect(within(results).getByRole('button', { name: '移除 粘贴资料' })).toBeInTheDocument();
  });

  it('reopens the form from the header toggle after a successful submit collapses it', async () => {
    mocks.importText.mockResolvedValue([started('material-reopen', 'pasted-text')]);
    renderRequestCard();

    fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
      target: { value: '公司全称：鲸跃科技' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));
    expect(await screen.findByText(/正在保存并抽取/)).toBeInTheDocument();
    // 提交成功后表单收起，但三条上传路径必须能从卡头重新展开（ADR 0005）。
    expect(
      screen.queryByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '继续添加品牌材料' }));

    expect(
      screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://example.com/about')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeInTheDocument();
  });
});
