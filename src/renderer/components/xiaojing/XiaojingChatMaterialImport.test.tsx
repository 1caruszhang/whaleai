import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrandMaterialProcessResult, TabApiPost } from '@/api/brandMaterialClient';
import XiaojingChatMaterialImport from './XiaojingChatMaterialImport';

const mocks = vi.hoisted(() => ({
  sessionId: 'session-07',
  apiPost: vi.fn(),
  open: vi.fn(),
  importFiles: vi.fn(),
  importText: vi.fn(),
  importWebsite: vi.fn(),
  retry: vi.fn(),
  fetchStatuses: vi.fn(),
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost as unknown as TabApiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
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
    fetchBrandMaterialStatuses: mocks.fetchStatuses,
  };
});

const workspace = {
  id: 'brand-07',
  name: '鲸跃科技',
  productLines: ['旗舰产品'],
  rootPath: 'C:\\Xiaojing\\brands\\brand-07',
  createdAt: '2026-08-15T00:00:00Z',
  updatedAt: '2026-08-15T00:00:00Z',
};

function started(id: string, kind: 'file' | 'pasted-text' | 'website-url'): BrandMaterialProcessResult {
  return {
    ok: true,
    material: {
      id,
      workspaceId: workspace.id,
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
    workspaceId: workspace.id,
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
      workspaceId: workspace.id,
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

function renderChatImport() {
  return render(<XiaojingChatMaterialImport workspaceId={workspace.id} />);
}

/** 票 27：入口折叠为输入区上方的一行，展开后才出现粘贴/URL/文件表单。 */
function openImportForm() {
  fireEvent.click(screen.getByRole('button', { name: '导入品牌材料' }));
}

describe('chat-side Xiaojing material import entry', () => {
  beforeEach(() => {
    mocks.sessionId = 'session-07';
    for (const mock of [
      mocks.apiPost,
      mocks.open,
      mocks.importFiles,
      mocks.importText,
      mocks.importWebsite,
      mocks.retry,
      mocks.fetchStatuses,
    ]) mock.mockReset();
    // 默认恢复查询返回空；个别用例按需覆盖。
    mocks.fetchStatuses.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses the form by default and expands it from the chat input area entry', () => {
    renderChatImport();

    expect(screen.getByRole('button', { name: '导入品牌材料' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(
      screen.queryByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
    ).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('https://example.com/about')).not.toBeInTheDocument();

    openImportForm();
    expect(screen.getByRole('button', { name: '导入品牌材料' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(
      screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
    ).toBeInTheDocument();
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
    renderChatImport();
    openImportForm();

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

  it('imports pasted text from the entry, collapses the form, and stops at the in-chat confirmation card', async () => {
    vi.useFakeTimers();
    mocks.importText.mockResolvedValue([started('material-paste', 'pasted-text')]);
    renderChatImport();
    openImportForm();

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
    // 提交后表单收起：流程停在聊天内的结果与确认卡，而不是停留在表单。
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

  it('imports an official-site URL from the entry through the same chat card flow', async () => {
    mocks.importWebsite.mockResolvedValue([started('material-site', 'website-url')]);
    renderChatImport();
    openImportForm();

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
    // URL 提交成功同样收起表单，停在聊天内处理结果。
    expect(screen.queryByPlaceholderText('https://example.com/about')).not.toBeInTheDocument();
  });

  it('recovers session cards and in-flight rows after remount', async () => {
    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-done', status: 'awaiting-confirmation', candidateCount: 1 }),
      statusEntry({ id: 'material-running', displayName: '在途材料.docx', status: 'processing' }),
    ]);
    renderChatImport();

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
    renderChatImport();
    openImportForm();

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
    renderChatImport();
    openImportForm();

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

  it('disables all material operations while the Tab still has a pending Session identity', () => {
    mocks.sessionId = 'pending-brand-07';
    renderChatImport();
    openImportForm();

    expect(screen.getByText(/建立真实 Session 后再导入材料/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取粘贴资料' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取官网资料' })).toBeDisabled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.importFiles).not.toHaveBeenCalled();
  });
});
