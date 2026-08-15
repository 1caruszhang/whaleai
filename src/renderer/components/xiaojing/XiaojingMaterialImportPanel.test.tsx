import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrandMaterialProcessResult, TabApiPost } from '@/api/brandMaterialClient';
import XiaojingGeoWorkbench from './XiaojingGeoWorkbench';

const mocks = vi.hoisted(() => ({
  sessionId: 'session-07',
  apiPost: vi.fn(),
  open: vi.fn(),
  importFiles: vi.fn(),
  importText: vi.fn(),
  importWebsite: vi.fn(),
  retry: vi.fn(),
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

function success(id: string, kind: 'file' | 'pasted-text' | 'website-url'): BrandMaterialProcessResult {
  return {
    ok: true,
    material: {
      id,
      workspaceId: workspace.id,
      inputKind: kind,
      displayName: `${id}.txt`,
      status: 'awaiting-confirmation',
      attemptCount: 1,
    },
    candidateIds: [`candidate-${id}`],
    attemptNumber: 1,
  };
}

function renderWorkbench() {
  return render(
    <XiaojingGeoWorkbench
      currentWorkspace={workspace}
      onOpenWorkspace={vi.fn(async () => true)}
      materialImportEnabled
    />,
  );
}

describe('reachable Xiaojing material import workbench', () => {
  beforeEach(() => {
    localStorage.removeItem('xiaojing:geo-workbench-collapsed');
    mocks.sessionId = 'session-07';
    for (const mock of [
      mocks.apiPost,
      mocks.open,
      mocks.importFiles,
      mocks.importText,
      mocks.importWebsite,
      mocks.retry,
    ]) mock.mockReset();
  });

  it('imports selected files, keeps per-file success/failure visible, and retries only one material', async () => {
    mocks.open.mockResolvedValue([
      'C:\\selected\\profile.pdf',
      'C:\\selected\\broken.docx',
    ]);
    mocks.importFiles.mockResolvedValue([
      success('material-ok', 'file'),
      { ok: false, materialId: 'material-failed', errorCode: 'model_failed' },
    ] satisfies BrandMaterialProcessResult[]);
    mocks.retry.mockResolvedValue(success('material-failed', 'file'));
    renderWorkbench();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));

    await waitFor(() => expect(mocks.importFiles).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      ['C:\\selected\\profile.pdf', 'C:\\selected\\broken.docx'],
    ));
    const results = await screen.findByRole('region', { name: '材料处理结果' });
    expect(within(results).getByText('profile.pdf')).toBeInTheDocument();
    expect(within(results).getByText('broken.docx')).toBeInTheDocument();
    expect(within(results).getByText('已生成 1 条待确认事实')).toBeInTheDocument();
    expect(within(results).getByText('处理失败：model_failed')).toBeInTheDocument();
    expect(within(results).getByText('materialId: material-ok')).toBeInTheDocument();
    expect(within(results).getByText('materialId: material-failed')).toBeInTheDocument();
    expect(results.textContent).not.toContain('C:\\selected');

    fireEvent.click(within(results).getByRole('button', { name: '仅重试 broken.docx' }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      'material-failed',
    ));
    expect(within(results).getByText('profile.pdf')).toBeInTheDocument();
    expect(mocks.retry).toHaveBeenCalledTimes(1);
  });

  it('submits pasted text and website URL through the current Tab structured client', async () => {
    mocks.importText.mockResolvedValue(success('material-paste', 'pasted-text'));
    mocks.importWebsite.mockResolvedValue(success('material-url', 'website-url'));
    renderWorkbench();

    fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
      target: { value: '公司全称：鲸跃科技' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));
    await waitFor(() => expect(mocks.importText).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      '公司全称：鲸跃科技',
    ));

    fireEvent.change(screen.getByPlaceholderText('https://example.com/about'), {
      target: { value: 'https://brand.example/about' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存并抽取官网资料' }));
    await waitFor(() => expect(mocks.importWebsite).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      'https://brand.example/about',
    ));
    expect(screen.getByText('materialId: material-paste')).toBeInTheDocument();
    expect(screen.getByText('materialId: material-url')).toBeInTheDocument();
  });

  it('disables all material operations while the Tab still has a pending Session identity', () => {
    mocks.sessionId = 'pending-brand-07';
    renderWorkbench();

    expect(screen.getByText(/建立真实 Session 后再导入材料/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取粘贴资料' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存并抽取官网资料' })).toBeDisabled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.importFiles).not.toHaveBeenCalled();
  });
});
