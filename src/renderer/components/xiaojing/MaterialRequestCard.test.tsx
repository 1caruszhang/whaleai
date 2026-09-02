import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrandMaterialProcessResult, TabApiPost } from '@/api/brandMaterialClient';
import type { MaterialRescanResult } from '../../../shared/geo/materials';
import MaterialRequestCard from './MaterialRequestCard';
import { formatCardCompletionTime } from './CardStatusTime';

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
  rescanImages: vi.fn(),
  fetchStatuses: vi.fn(),
  fetchImageAssets: vi.fn(),
  skipMaterialCollection: vi.fn(),
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
    rescanBrandMaterialImages: mocks.rescanImages,
    fetchBrandMaterialStatuses: mocks.fetchStatuses,
    fetchMaterialImageAssets: mocks.fetchImageAssets,
  };
});

vi.mock('@/api/geoOperationClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/geoOperationClient')>();
  return {
    ...actual,
    skipMaterialCollection: mocks.skipMaterialCollection,
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
      fileExt: 'txt',
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
  fileExt?: string;
  /** 材料投影的 updated_at：终态行的「完成时刻」权威源（票 08）。 */
  updatedAt?: string;
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
      fileExt: input.fileExt ?? 'txt',
      status: input.status,
      attemptCount: 1,
      ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
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

function renderRequestCard(
  reason = '还没有已确认的品牌知识，先补充材料再推进计划。',
  skipTarget?: { operationId: string; expectedRevision: number } | null,
) {
  return render(
    <MaterialRequestCard
      data={{
        kind: 'material-request-card',
        requiresUserDecision: true,
        reason,
        ...(skipTarget === undefined ? {} : { skipTarget }),
      }}
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
      mocks.rescanImages,
      mocks.fetchStatuses,
      mocks.fetchImageAssets,
      mocks.skipMaterialCollection,
    ]) mock.mockReset();
    // 默认恢复查询返回空；个别用例按需覆盖。
    mocks.fetchStatuses.mockResolvedValue([]);
    // 默认候选池为空（预览条不渲染）；个别用例按需覆盖。
    mocks.fetchImageAssets.mockResolvedValue([]);
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

  it('offers image files in the picker and tells the user images join the illustration pool', async () => {
    mocks.open.mockResolvedValue([]);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());

    const options = mocks.open.mock.calls[0]?.[0] as { filters?: Array<{ extensions: string[] }> };
    const extensions = options.filters?.[0]?.extensions ?? [];
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      expect(extensions).toContain(extension);
    }
    expect(
      screen.getByText(/直接上传的图片与文档里的内嵌图片会自动进入配图候选池/),
    ).toBeInTheDocument();
  });

  it('shows image-specific row copy for standalone image materials', async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue(['C:\\selected\\展拍.png']);
    mocks.importFiles.mockResolvedValue([
      {
        ok: true,
        material: {
          id: 'material-image',
          workspaceId: 'brand-07',
          inputKind: 'file',
          displayName: '展拍.png',
          fileExt: 'png',
          status: 'stored',
          attemptCount: 0,
        },
      },
    ] satisfies BrandMaterialProcessResult[]);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/正在保存并识别图片/)).toBeInTheDocument();

    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({
        id: 'material-image',
        displayName: '展拍.png',
        status: 'processed',
        fileExt: 'png',
      }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(
      screen.getByText(/图片已保存；符合配图要求的图片自动进入配图候选池/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/条待确认事实/)).not.toBeInTheDocument();
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
    // 提交中的行状态在点击的 act 冲刷后同步可见；不 await 这个瞬时态——
    // 它依赖提交回诺微任务与断言的执行顺序，负载下会偶发翻转。
    expect(screen.getByText(/正在保存并抽取/)).toBeInTheDocument();
    // 提交成功后表单收起，但三条上传路径必须能从卡头重新展开（ADR 0005）。
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: '继续添加品牌材料' }));

    expect(
      screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('https://example.com/about')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeInTheDocument();
  });

  it('triggers a legacy image rescan from the card header and reports the pooled summary', async () => {
    let releaseRescan: ((value: MaterialRescanResult) => void) | undefined;
    mocks.rescanImages.mockImplementation(
      () => new Promise<MaterialRescanResult>((resolve) => { releaseRescan = resolve; }),
    );
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '重扫存量材料图片' }));
    expect(mocks.rescanImages).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
    );
    // 进行中：按钮禁用防重复触发，结果行提示幂等口径。
    expect(screen.getByRole('button', { name: '重扫存量材料图片' })).toBeDisabled();
    expect(screen.getByText(/重复触发不会产生重复图片/)).toBeInTheDocument();

    await act(async () => {
      releaseRescan?.({
        documents: [
          {
            materialId: 'material-legacy-doc',
            displayName: '旧品牌介绍.docx',
            pooled: 2,
            deduplicated: 1,
            degraded: 0,
            budgetExhausted: false,
          },
        ],
        budgetExhausted: false,
      });
    });

    // 摘要行：新入池/已入池（幂等去重）计数聚合呈现。
    expect(screen.getByText(/存量重扫完成：入池 2 张；已入池 1 张；0 张未入池/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重扫存量材料图片' })).toBeEnabled();
  });

  it('tells the user to rescan again when the pass hits its time budget', async () => {
    mocks.rescanImages.mockResolvedValue({
      documents: [{
        materialId: 'material-legacy-deck',
        displayName: '旧路演.pptx',
        pooled: 3,
        deduplicated: 0,
        degraded: 1,
        budgetExhausted: true,
      }],
      budgetExhausted: true,
    } satisfies MaterialRescanResult);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '重扫存量材料图片' }));
    await waitFor(() =>
      expect(screen.getByText(/时间预算用完，再次点击可继续/)).toBeInTheDocument());
    expect(screen.getByText(/入池 3 张/)).toBeInTheDocument();
    expect(screen.getByText(/1 张未入池/)).toBeInTheDocument();
  });

  it('marks rescan transport failures as material_request_failed', async () => {
    mocks.rescanImages.mockRejectedValue(new Error('proxy timeout'));
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '重扫存量材料图片' }));
    await waitFor(() =>
      expect(screen.getByText('重扫失败：material_request_failed')).toBeInTheDocument());
  });

  it('disables the rescan entry when the Tab has no exact-match brand', () => {
    mocks.hasWorkspace = false;
    renderRequestCard();

    expect(screen.getByRole('button', { name: '重扫存量材料图片' })).toBeDisabled();
    expect(mocks.rescanImages).not.toHaveBeenCalled();
  });

  it('renders the read-only illustration candidates strip when the pool is non-empty', async () => {
    mocks.fetchImageAssets.mockResolvedValue([{
      id: 'image-19',
      workspaceId: 'brand-07',
      sha256: 'sha-19',
      fileExt: 'png',
      mediaType: 'image/png',
      byteSize: 4096,
      width: 1024,
      height: 768,
      description: '门店前台的产品陈列',
      category: 'product-photo' as const,
      sourceMaterialId: 'material-legacy-doc',
      sourceMaterialName: '品牌介绍.docx',
      relativePath: 'images/image-19.png',
      createdAt: '2026-08-31T00:00:00Z',
      updatedAt: '2026-08-31T00:00:00Z',
    }]);
    renderRequestCard();

    // 品牌级折叠条默认收起；纯只读——除展开/收起外没有任何操作按钮。
    expect(await screen.findByRole('button', { name: '展开配图候选' })).toBeInTheDocument();
    expect(screen.getByText('配图候选 1 张')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /移除|勾选|刷新/ }),
    ).not.toBeInTheDocument();
  });

  it('refreshes the illustration pool snapshot through the existing status poll', async () => {
    vi.useFakeTimers();
    mocks.open.mockResolvedValue(['C:\\selected\\展拍.png']);
    mocks.importFiles.mockResolvedValue([
      {
        ok: true,
        material: {
          id: 'material-image',
          workspaceId: 'brand-07',
          inputKind: 'file',
          displayName: '展拍.png',
          fileExt: 'png',
          status: 'stored',
          attemptCount: 0,
        },
      },
    ] satisfies BrandMaterialProcessResult[]);
    renderRequestCard();

    fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // 挂载取过一次基线；处理中行驱动的轮询 tick 会再刷新候选池快照。
    expect(mocks.fetchImageAssets).toHaveBeenCalledTimes(1);

    mocks.fetchStatuses.mockResolvedValue([
      statusEntry({ id: 'material-image', displayName: '展拍.png', status: 'processed', fileExt: 'png' }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    // 会话恢复查过一次（无 materialIds）+ 轮询 tick 查过一次（带 materialIds）。
    expect(mocks.fetchStatuses).toHaveBeenCalledTimes(2);
    expect(mocks.fetchStatuses).toHaveBeenLastCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-07', sessionId: 'session-07' },
      ['material-image'],
    );
    expect(mocks.fetchImageAssets).toHaveBeenCalledTimes(2);

    // 行已终态：轮询停止，不再产生新的池快照请求。
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(mocks.fetchImageAssets).toHaveBeenCalledTimes(2);
  });

  it('refreshes the illustration pool snapshot right after a legacy rescan completes', async () => {
    mocks.rescanImages.mockResolvedValue({
      documents: [{
        materialId: 'material-legacy-doc',
        displayName: '旧品牌介绍.docx',
        pooled: 2,
        deduplicated: 0,
        degraded: 1,
        budgetExhausted: false,
      }],
      budgetExhausted: false,
    } satisfies MaterialRescanResult);
    renderRequestCard();

    expect(mocks.fetchImageAssets).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重扫存量材料图片' }));
    await waitFor(() =>
      expect(screen.getByText(/存量重扫完成：入池 2 张/)).toBeInTheDocument());
    // 重扫同步一次通过后池已变化：无处理中行可挂靠轮询，这里直接补一次刷新。
    await waitFor(() => expect(mocks.fetchImageAssets).toHaveBeenCalledTimes(2));
  });

  describe('skip-material-collection exit (ticket 07)', () => {
    const skipTarget = { operationId: 'op-skip-07', expectedRevision: 7 };

    it('hides the skip action entirely for out-of-plan cards without an operation anchor', () => {
      renderRequestCard('用户主动要求补充品牌材料。', null);

      expect(screen.queryByRole('button', { name: '跳过材料收集' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('material-skip-exit')).not.toBeInTheDocument();
      // 计划外补材料入口不受影响：三条上传路径照常。
      expect(screen.getByRole('button', { name: '选择文件' })).toBeInTheDocument();
    });

    it('keeps the skip action in the initial state: one click only arms the confirmation', () => {
      renderRequestCard('按计划停在材料收集步骤。', skipTarget);

      const skipButton = screen.getByRole('button', { name: '跳过材料收集' });
      fireEvent.click(skipButton);

      // 二次确认防误触：单次点击不发起任何请求，进入确认态。
      expect(mocks.skipMaterialCollection).not.toHaveBeenCalled();
      const confirm = screen.getByRole('alertdialog', { name: '确认跳过材料收集' });
      expect(
        within(confirm).getByText(/跳过后本轮不再等待新材料，将以现有品牌知识从下一步继续推进/),
      ).toBeInTheDocument();
      expect(
        within(confirm).getByRole('button', { name: '确认跳过材料收集' }),
      ).toBeInTheDocument();
      expect(within(confirm).getByRole('button', { name: '暂不跳过' })).toBeInTheDocument();
    });

    it('returns to the initial state when the user cancels the confirmation', () => {
      renderRequestCard('按计划停在材料收集步骤。', skipTarget);

      fireEvent.click(screen.getByRole('button', { name: '跳过材料收集' }));
      fireEvent.click(screen.getByRole('button', { name: '暂不跳过' }));

      expect(screen.queryByRole('alertdialog', { name: '确认跳过材料收集' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '跳过材料收集' })).toBeInTheDocument();
      expect(mocks.skipMaterialCollection).not.toHaveBeenCalled();
    });

    it('submits the skip with the card-anchored operation identity after the second click', async () => {
      mocks.skipMaterialCollection.mockResolvedValueOnce({ id: 'op-skip-07' });
      renderRequestCard('按计划停在材料收集步骤。', skipTarget);

      fireEvent.click(screen.getByRole('button', { name: '跳过材料收集' }));
      fireEvent.click(screen.getByRole('button', { name: '确认跳过材料收集' }));

      // 卡片锚定的操作身份（workspaceId/sessionId 来自 Tab 上下文，
      // operationId/expectedRevision 来自卡数据）随跳过动作贯通。
      await waitFor(() => expect(mocks.skipMaterialCollection).toHaveBeenCalledWith(
        mocks.apiPost,
        { workspaceId: 'brand-07', sessionId: 'session-07' },
        { operationId: 'op-skip-07', expectedRevision: 7 },
      ));
      // 成功后收口：跳过是一次 CAS 计划替换，完成态不再回退。
      await waitFor(() =>
        expect(
          screen.getByText(/已跳过材料收集：本轮按现有品牌知识继续推进/),
        ).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: '跳过材料收集' })).not.toBeInTheDocument();
      // 计划外补材料入口不受影响：上传表单仍然可用。
      expect(screen.getByRole('button', { name: '选择文件' })).toBeInTheDocument();
    });

    it('surfaces a skip failure with the server error code and keeps the card usable', async () => {
      mocks.skipMaterialCollection.mockRejectedValueOnce(
        new Error('revision_conflict: stale expectedRevision'),
      );
      renderRequestCard('按计划停在材料收集步骤。', skipTarget);

      fireEvent.click(screen.getByRole('button', { name: '跳过材料收集' }));
      fireEvent.click(screen.getByRole('button', { name: '确认跳过材料收集' }));

      await waitFor(() =>
        expect(screen.getByText(/跳过失败：revision_conflict/)).toBeInTheDocument());
      expect(screen.queryByRole('alertdialog', { name: '确认跳过材料收集' })).not.toBeInTheDocument();
      // 失败后可以重新发起（再次走二次确认）。
      fireEvent.click(screen.getByRole('button', { name: '再次尝试跳过' }));
      expect(screen.getByRole('alertdialog', { name: '确认跳过材料收集' })).toBeInTheDocument();
    });

    it('disables the skip entry when the Tab has no exact-match brand', () => {
      mocks.hasWorkspace = false;
      renderRequestCard('按计划停在材料收集步骤。', skipTarget);

      expect(screen.getByRole('button', { name: '跳过材料收集' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: '跳过材料收集' }));
      expect(screen.queryByRole('alertdialog', { name: '确认跳过材料收集' })).not.toBeInTheDocument();
      expect(mocks.skipMaterialCollection).not.toHaveBeenCalled();
    });
  });

  // 卡片时间戳两态（geo-plan-normalization 票 08）：进行中（抽取在后台
  // 生成待确认事实）显示「生成中」状态词、绝不出钟点；行落定（成功或
  // 失败都是终态）显示完成时刻，时刻唯一来源是材料投影的 updated_at——
  // Rust 在写终态的同一条 UPDATE 里更新它，不造第二时间源。
  describe('card timestamp semantics (ticket 08)', () => {
    it('shows the generating state without any clock time while extracting, then the completion moment on success', async () => {
      vi.useFakeTimers();
      mocks.importText.mockResolvedValue([started('material-ts', 'pasted-text')]);
      renderRequestCard();

      fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
        target: { value: '公司全称：鲸跃科技' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      let results = screen.getByRole('region', { name: '材料处理结果' });
      // 进行中：状态词「生成中」，没有任何钟点时间。
      expect(within(results).getByText('生成中')).toBeInTheDocument();
      expect(results.querySelector('[data-card-timestamp="settled"]')).toBeNull();

      mocks.fetchStatuses.mockResolvedValue([
        statusEntry({
          id: 'material-ts',
          status: 'awaiting-confirmation',
          candidateCount: 2,
          updatedAt: '2026-09-02T05:04:03Z',
        }),
      ]);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

      results = screen.getByRole('region', { name: '材料处理结果' });
      // 落定：状态词消失，完成时刻出现（原样 ISO 可追溯 + 同口径格式化）。
      expect(within(results).queryByText('生成中')).not.toBeInTheDocument();
      const stamp = results.querySelector('[data-card-timestamp="settled"]');
      expect(stamp).not.toBeNull();
      expect(stamp).toHaveAttribute('data-completed-at', '2026-09-02T05:04:03Z');
      expect(stamp).toHaveTextContent(`完成于 ${formatCardCompletionTime('2026-09-02T05:04:03Z')}`);
    });

    it('marks a settled failure with its completion moment, and retry returns the row to the generating state', async () => {
      vi.useFakeTimers();
      mocks.open.mockResolvedValue(['C:\\selected\\价格.docx']);
      mocks.importFiles.mockResolvedValue([started('material-cycle', 'file')]);
      renderRequestCard();

      fireEvent.click(screen.getByRole('button', { name: '选择文件' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      // 失败同样是落定：完成时刻来自材料投影的 updated_at。
      mocks.fetchStatuses.mockResolvedValue([
        statusEntry({
          id: 'material-cycle',
          status: 'failed',
          lastErrorCode: 'model_failed',
          updatedAt: '2026-09-02T06:00:00Z',
        }),
      ]);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      let results = screen.getByRole('region', { name: '材料处理结果' });
      expect(
        results.querySelector('[data-card-timestamp="settled"]'),
      ).toHaveAttribute('data-completed-at', '2026-09-02T06:00:00Z');

      // 仅重试此项：行回到生成中，旧完成时刻必须消失（不再误导）。
      mocks.retry.mockResolvedValue([started('material-cycle', 'file')]);
      fireEvent.click(within(results).getByRole('button', { name: '仅重试 价格.docx' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      results = screen.getByRole('region', { name: '材料处理结果' });
      expect(within(results).getByText('生成中')).toBeInTheDocument();
      expect(results.querySelector('[data-card-timestamp="settled"]')).toBeNull();

      // 重试后再次落定：显示新的完成时刻，而不是重试前的旧时刻。
      mocks.fetchStatuses.mockResolvedValue([
        statusEntry({
          id: 'material-cycle',
          status: 'processed',
          updatedAt: '2026-09-02T07:30:00Z',
        }),
      ]);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(
        screen.getByRole('region', { name: '材料处理结果' }).querySelector('[data-card-timestamp="settled"]'),
      ).toHaveAttribute('data-completed-at', '2026-09-02T07:30:00Z');
    });

    it('renders no timestamp slot for transport failures that never reached a material projection', async () => {
      mocks.importText.mockRejectedValue(new Error('proxy timeout'));
      renderRequestCard();

      fireEvent.change(screen.getByPlaceholderText('粘贴企业介绍、产品资料或品牌事实'), {
        target: { value: '公司全称：鲸跃科技' },
      });
      fireEvent.click(screen.getByRole('button', { name: '保存并抽取粘贴资料' }));

      // 传输层失败没有到达服务端，不存在权威完成时刻：时间槽整体缺席，
      // 不用客户端钟点伪造。
      const results = await screen.findByRole('region', { name: '材料处理结果' });
      expect(within(results).getByText('处理失败：material_request_failed')).toBeInTheDocument();
      expect(results.querySelector('[data-card-timestamp]')).toBeNull();
    });
  });
});
