import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { TabApiPost } from '@/api/brandMaterialClient';
import type { MaterialImageAsset } from '../../../shared/geo/materialImages';
import MaterialImageCandidatesBar from './MaterialImageCandidatesBar';

const mocks = vi.hoisted(() => ({
  sessionId: 'session-19',
  hasIdentity: true,
  apiPost: vi.fn(),
  fetchAssets: vi.fn(),
  fetchImage: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost as unknown as TabApiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock('@/api/brandMaterialClient', () => ({
  fetchMaterialImageAssets: mocks.fetchAssets,
  fetchMaterialImageContent: mocks.fetchImage,
}));

const IDENTITY = { workspaceId: 'brand-19', sessionId: 'session-19' };

function asset(
  id: string,
  overrides: Partial<MaterialImageAsset> = {},
): MaterialImageAsset {
  return {
    id,
    workspaceId: 'brand-19',
    sha256: `sha-${id}`,
    fileExt: 'png',
    mediaType: 'image/png',
    byteSize: 4096,
    width: 1024,
    height: 768,
    description: `${id} 的中文描述`,
    category: 'product-photo',
    sourceMaterialId: 'material-19',
    sourceMaterialName: '品牌介绍.docx',
    relativePath: `images/${id}.png`,
    createdAt: '2026-08-31T00:00:00Z',
    updatedAt: '2026-08-31T00:00:00Z',
    ...overrides,
  };
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

beforeAll(() => {
  // jsdom 未实现 Object URL；本测试只关心「换成了本地 blob 且生命周期受管」。
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: mocks.createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: mocks.revokeObjectURL,
  });
});

beforeEach(() => {
  mocks.hasIdentity = true;
  for (const mock of [
    mocks.apiPost,
    mocks.fetchAssets,
    mocks.fetchImage,
    mocks.createObjectURL,
    mocks.revokeObjectURL,
  ]) mock.mockReset();
  mocks.fetchAssets.mockResolvedValue([]);
  mocks.fetchImage.mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes() });
  mocks.createObjectURL.mockImplementation(() => `blob:candidate-${Math.random()}`);
});

afterEach(() => {
  vi.useRealTimers();
});

function renderBar(
  refreshKey = 0,
  unpooledNote: string | null | undefined = undefined,
) {
  return render(
    <MaterialImageCandidatesBar
      identity={mocks.hasIdentity ? IDENTITY : null}
      refreshKey={refreshKey}
      {...(unpooledNote !== undefined ? { unpooledNote } : {})}
    />,
  );
}

describe('MaterialImageCandidatesBar', () => {
  it('renders nothing at all when the illustration pool is empty', async () => {
    mocks.fetchAssets.mockResolvedValue([]);
    const { container } = renderBar();

    await waitFor(() => expect(mocks.fetchAssets).toHaveBeenCalled());
    expect(
      container.querySelector('[data-material-image-candidates-bar]'),
    ).not.toBeInTheDocument();
    expect(mocks.fetchImage).not.toHaveBeenCalled();
  });

  it('renders nothing without a real Session identity and never fetches', () => {
    mocks.hasIdentity = false;
    renderBar();

    expect(mocks.fetchAssets).not.toHaveBeenCalled();
    expect(mocks.fetchImage).not.toHaveBeenCalled();
  });

  it('stays collapsed by default with the pool total and no increment suffix', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a'), asset('image-b')]);
    renderBar();

    const toggle = await screen.findByRole('button', { name: '展开配图候选' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('配图候选 2 张')).toBeInTheDocument();
    // 收起态不取缩略图字节：清单是纯投影，字节只在展开时按需取回。
    expect(mocks.fetchImage).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('region', { name: '配图候选缩略图' }),
    ).not.toBeInTheDocument();
  });

  it('expands into a scroll-capped thumbnail grid with blob images, descriptions, and category labels', async () => {
    mocks.fetchAssets.mockResolvedValue([
      asset('image-newest', { description: '最新入池的门店实拍', category: 'scene' }),
      asset('image-oldest', { description: '最早入池的产品图', category: 'product-photo' }),
    ]);
    renderBar();

    fireEvent.click(await screen.findByRole('button', { name: '展开配图候选' }));

    const grid = await screen.findByRole('region', { name: '配图候选缩略图' });
    // 卡内限高内滚：超出的候选靠网格自身滚轴浏览，不撑开宿主卡片。
    expect(grid.className).toContain('overflow-y-auto');
    expect(grid.className).toContain('max-h-');

    // 服务端已按入池时间倒序返回；网格按返回顺序渲染（最新在前）。
    const figures = grid.querySelectorAll('[data-material-image-candidate]');
    expect(figures[0]).toHaveAttribute('data-material-image-candidate', 'image-newest');
    expect(figures[1]).toHaveAttribute('data-material-image-candidate', 'image-oldest');

    // 每张 = 真实图片 blob（经材料图片内容取回换 object URL）+ 一句描述 + 类型标签。
    const newest = within(grid).getByRole('img', { name: '最新入池的门店实拍' });
    expect(newest).toHaveAttribute('src', expect.stringMatching(/^blob:candidate-/));
    expect(within(grid).getByText('最新入池的门店实拍')).toBeInTheDocument();
    expect(within(grid).getByText('环境')).toBeInTheDocument();
    expect(within(grid).getByText('产品实拍')).toBeInTheDocument();
    expect(mocks.fetchImage).toHaveBeenCalledTimes(2);
    expect(mocks.fetchImage).toHaveBeenCalledWith(
      mocks.apiPost,
      IDENTITY,
      'image-newest',
    );
  });

  it('counts newly pooled ids against the first snapshot when the card bumps the refresh signal', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a'), asset('image-b')]);
    const { rerender } = renderBar();
    await screen.findByText('配图候选 2 张');
    // 基线取数后的刷新没有新 id：不带增量后缀。
    expect(screen.queryByText(/本次新增/)).not.toBeInTheDocument();

    // 入池变化经刷新信号自动反映（卡片 3s 轮询/重扫完成时递增）。
    mocks.fetchAssets.mockResolvedValue([
      asset('image-c', { description: '重扫新入池的图' }),
      asset('image-a'),
      asset('image-b'),
    ]);
    rerender(
      <MaterialImageCandidatesBar
        identity={IDENTITY}
        refreshKey={1}
        unpooledNote={undefined}
      />,
    );

    expect(await screen.findByText('配图候选 3 张 · 本次新增 1')).toBeInTheDocument();
    // 已入池图片的 id 稳定：重扫/去重不产生重复候选，也不重复计新增。
    expect(mocks.fetchAssets).toHaveBeenCalledTimes(2);
  });

  it('re-baselines on remount so replayed cards never claim legacy pool entries as new', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a'), asset('image-b')]);
    const first = renderBar();
    await first.findByText('配图候选 2 张');
    first.unmount();

    const second = renderBar(0);
    // 转录重放重新挂载：既有池是基线，不是「本次新增」。
    await second.findByText('配图候选 2 张');
    expect(second.queryByText(/本次新增/)).not.toBeInTheDocument();
  });

  it('shows one unpooled summary line instead of per-image rows', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a')]);
    renderBar(0, '最近一次存量重扫另有 2 张图片未入池（打标降级/过滤/格式跳过），不逐张展示。');

    fireEvent.click(await screen.findByRole('button', { name: '展开配图候选' }));
    expect(
      await screen.findByText(/最近一次存量重扫另有 2 张图片未入池/),
    ).toBeInTheDocument();
  });

  it('falls back to the standing unpooled note when no outcome tally is available', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a')]);
    renderBar();

    fireEvent.click(await screen.findByRole('button', { name: '展开配图候选' }));
    expect(
      await screen.findByText(/打标降级、尺寸过小或格式不支持的图片不会进入候选池/),
    ).toBeInTheDocument();
  });

  it('degrades a failed thumbnail to a readable note without blocking the rest', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-ok'), asset('image-bad')]);
    mocks.fetchImage.mockImplementation((_api, _identity, imageId) =>
      imageId === 'image-bad'
        ? Promise.reject(new Error('material_not_found'))
        : Promise.resolve({ mediaType: 'image/png', bytes: pngBytes() }));
    renderBar();

    fireEvent.click(await screen.findByRole('button', { name: '展开配图候选' }));

    const grid = await screen.findByRole('region', { name: '配图候选缩略图' });
    expect(await within(grid).findByRole('img', { name: 'image-ok 的中文描述' }))
      .toBeInTheDocument();
    expect(
      grid.querySelector('[data-material-image-candidate-failed="image-bad"]'),
    ).toBeInTheDocument();
  });

  it('revokes thumbnail blobs when collapsed and on unmount', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a'), asset('image-b')]);
    const { unmount } = renderBar();

    fireEvent.click(await screen.findByRole('button', { name: '展开配图候选' }));
    const images = await screen.findAllByRole('img');
    expect(images).toHaveLength(2);
    const urls = images.map((image) => image.getAttribute('src')) as string[];
    expect(mocks.revokeObjectURL).not.toHaveBeenCalled();

    // 收起：网格卸载，blob 即刻回收。
    fireEvent.click(screen.getByRole('button', { name: '收起配图候选' }));
    await waitFor(() => expect(screen.queryByRole('img')).not.toBeInTheDocument());
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(2);
    for (const url of urls) expect(mocks.revokeObjectURL).toHaveBeenCalledWith(url);

    // 再展开重新取回；卸载时再次统一回收。
    fireEvent.click(screen.getByRole('button', { name: '展开配图候选' }));
    expect((await screen.findAllByRole('img')).length).toBe(2);
    unmount();
    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(4);
  });

  it('keeps the last pool projection when a refresh signal fails', async () => {
    mocks.fetchAssets.mockResolvedValue([asset('image-a')]);
    const { rerender } = renderBar();
    await screen.findByText('配图候选 1 张');

    mocks.fetchAssets.mockRejectedValue(new Error('proxy timeout'));
    rerender(
      <MaterialImageCandidatesBar identity={IDENTITY} refreshKey={1} unpooledNote={null} />,
    );

    // 传输层失败静默：上一份投影保留，等下个刷新信号，不闪断入口。
    await waitFor(() => expect(mocks.fetchAssets).toHaveBeenCalledTimes(2));
    expect(screen.getByText('配图候选 1 张')).toBeInTheDocument();
    expect(screen.queryByText(/本次新增/)).not.toBeInTheDocument();
  });
});
