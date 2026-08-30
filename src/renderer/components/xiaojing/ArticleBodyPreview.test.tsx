import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme } from '@/test/renderWithTheme';

const mocks = vi.hoisted(() => ({
  sessionId: 'session-17',
  apiPost: vi.fn(),
  fetchImage: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock('@/api/brandMaterialClient', () => ({
  fetchMaterialImageContent: mocks.fetchImage,
}));

import ArticleBodyPreview from './ArticleBodyPreview';

const BODY_WITH_IMAGE = [
  '# 成都车载音响选购指南',
  '',
  '![产品实拍](material-image://image-1)',
  '',
  '## 选购要点',
  '',
  '- 预算先行',
].join('\n');

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
  mocks.apiPost.mockReset();
  mocks.fetchImage.mockReset();
  mocks.createObjectURL.mockReset().mockImplementation(() => `blob:preview-${Math.random()}`);
  mocks.revokeObjectURL.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ArticleBodyPreview', () => {
  it('renders the body as markdown with placeholders resolved to local blob images', async () => {
    mocks.fetchImage.mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes() });
    const { container } = renderWithTheme(
      <ArticleBodyPreview body={BODY_WITH_IMAGE} workspaceId="brand-17" />,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: '成都车载音响选购指南' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '选购要点' })).toBeInTheDocument();
    expect(screen.getByText('预算先行')).toBeInTheDocument();

    const image = await screen.findByRole('img', { name: '产品实拍' });
    expect(image).toHaveAttribute('src', expect.stringMatching(/^blob:preview-/));
    expect(image).toHaveAttribute('data-material-image', 'image-1');
    expect(mocks.fetchImage).toHaveBeenCalledTimes(1);
    expect(mocks.fetchImage).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: 'brand-17', sessionId: 'session-17' },
      'image-1',
    );
    // 占位符源文不外漏：预览态没有裸文本 scheme。
    expect(container.textContent).not.toContain('material-image:');
  });

  it('fetches each distinct image once and reuses the blob for repeated placeholders', async () => {
    const body = [
      '# 标题',
      '',
      '![第一张](material-image://image-1)',
      '',
      '中间段落。',
      '',
      '![第二处复用](material-image://image-1)',
    ].join('\n');
    mocks.fetchImage.mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes() });
    renderWithTheme(<ArticleBodyPreview body={body} workspaceId="brand-17" />);

    const images = await screen.findAllByRole('img');
    expect(images).toHaveLength(2);
    expect(mocks.fetchImage).toHaveBeenCalledTimes(1);
    expect(images[0]).toHaveAttribute('src', images[1].getAttribute('src') ?? '');
  });

  it('shows a readable failure note instead of an image when retrieval fails', async () => {
    mocks.fetchImage.mockRejectedValue(new Error('material_not_found'));
    renderWithTheme(
      <ArticleBodyPreview body={BODY_WITH_IMAGE} workspaceId="brand-17" />,
    );

    expect(
      await screen.findByText(/材料图片加载失败：material_not_found/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('releases stale blobs and refetches nothing when a revision removes the placeholder', async () => {
    mocks.fetchImage.mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes() });
    const { rerender } = renderWithTheme(
      <ArticleBodyPreview body={BODY_WITH_IMAGE} workspaceId="brand-17" />,
    );
    const firstUrl = (await screen.findByRole('img', { name: '产品实拍' })).getAttribute('src');
    expect(firstUrl).toBeTruthy();

    // 聊天修订/编辑保存后的新版本：占位符行被删 → 图片消失、blob 被回收。
    const revised = BODY_WITH_IMAGE.replace('![产品实拍](material-image://image-1)\n\n', '');
    rerender(
      <ArticleBodyPreview body={revised} workspaceId="brand-17" />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith(firstUrl);
    expect(mocks.fetchImage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 2, name: '选购要点' })).toBeInTheDocument();
  });

  it('keeps an uncontrolled placeholder visible as a failure instead of fetching it', async () => {
    // id 含非法字符（如空格/下划线）不构成受控占位符（扫描模块纪律），
    // 预览不发起取回，也不静默吞掉。
    const body = '# 标题\n\n![逃逸](material-image://bad_id)';
    renderWithTheme(<ArticleBodyPreview body={body} workspaceId="brand-17" />);

    expect(
      await screen.findByText(/材料图片加载失败/),
    ).toBeInTheDocument();
    expect(mocks.fetchImage).not.toHaveBeenCalled();
  });

  it('revokes every object URL on unmount', async () => {
    mocks.fetchImage.mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes() });
    const body = '# 标题\n\n![a](material-image://image-1)\n\n![b](material-image://image-2)';
    const { unmount } = renderWithTheme(
      <ArticleBodyPreview body={body} workspaceId="brand-17" />,
    );
    expect((await screen.findAllByRole('img')).length).toBe(2);

    unmount();

    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('marks placeholders as unavailable without a real session instead of hanging on loading', async () => {
    mocks.sessionId = 'pending-session-17';
    try {
      renderWithTheme(
        <ArticleBodyPreview body={BODY_WITH_IMAGE} workspaceId="brand-17" />,
      );

      expect(
        await screen.findByText(/材料图片加载失败/),
      ).toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(mocks.fetchImage).not.toHaveBeenCalled();
    } finally {
      mocks.sessionId = 'session-17';
    }
  });
});
