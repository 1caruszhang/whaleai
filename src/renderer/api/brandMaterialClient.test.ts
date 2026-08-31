import { describe, expect, it, vi } from 'vitest';

import {
  fetchMaterialImageAssets,
  fetchMaterialImageContent,
  importBrandMaterialFiles,
  importBrandMaterialText,
  importBrandMaterialWebsite,
  retryBrandMaterial,
  type TabApiPost,
} from './brandMaterialClient';

describe('Brand material structured client', () => {
  it('keeps all three inputs and retry scoped to the current brand Session', async () => {
    const apiPostMock = vi.fn(async (_path: string, _body?: unknown) => (
      { success: true, result: { ok: false, errorCode: 'material_empty' } }
    ));
    const apiPost = apiPostMock as unknown as TabApiPost;
    const identity = { workspaceId: 'brand-07', sessionId: 'session-07' };

    await importBrandMaterialFiles(apiPost, identity, ['C:\\selected\\profile.pdf']);
    await importBrandMaterialText(apiPost, identity, '公司资料', '资料.txt');
    await importBrandMaterialWebsite(apiPost, identity, 'https://brand.example/about');
    await retryBrandMaterial(apiPost, identity, 'material-07');

    expect(apiPostMock.mock.calls.map(([path, body]) => [path, body])).toEqual([
      ['/api/xiaojing/materials/import', { ...identity, input: { kind: 'files', sourcePaths: ['C:\\selected\\profile.pdf'] } }],
      ['/api/xiaojing/materials/import', { ...identity, input: { kind: 'pasted-text', text: '公司资料', displayName: '资料.txt' } }],
      ['/api/xiaojing/materials/import', { ...identity, input: { kind: 'website-url', url: 'https://brand.example/about' } }],
      ['/api/xiaojing/materials/retry', { ...identity, materialId: 'material-07' }],
    ]);
  });

  it('fetches material image bytes for the approval preview over the session control plane', async () => {
    const bytes = new Uint8Array([1, 2, 250, 0]);
    const apiPostMock = vi.fn(async () => ({
      success: true,
      image: {
        imageId: 'image-07',
        mediaType: 'image/png',
        bytesB64: Buffer.from(bytes).toString('base64'),
      },
    }));
    const identity = { workspaceId: 'brand-07', sessionId: 'session-07' };

    const content = await fetchMaterialImageContent(
      apiPostMock as unknown as TabApiPost,
      identity,
      'image-07',
    );

    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/xiaojing/material-images/content',
      { ...identity, imageId: 'image-07' },
    );
    expect(content.mediaType).toBe('image/png');
    expect(Array.from(content.bytes)).toEqual([1, 2, 250, 0]);
  });

  it('surfaces the stable error code when image content retrieval fails', async () => {
    const apiPostMock = vi.fn(async () => ({
      success: false,
      error: 'material_not_found',
    }));
    await expect(
      fetchMaterialImageContent(
        apiPostMock as unknown as TabApiPost,
        { workspaceId: 'brand-07', sessionId: 'session-07' },
        'image-gone',
      ),
    ).rejects.toThrow('material_not_found');
  });

  it('fetches the read-only illustration candidate list over the session control plane', async () => {
    const image = {
      id: 'image-19',
      workspaceId: 'brand-07',
      sha256: 'sha-19',
      fileExt: 'png',
      mediaType: 'image/png',
      byteSize: 2048,
      width: 1024,
      height: 768,
      description: '门店前台的产品陈列',
      category: 'product-photo' as const,
      sourceMaterialId: 'material-19',
      sourceMaterialName: '品牌介绍.docx',
      relativePath: 'images/image-19.png',
      createdAt: '2026-08-31T00:00:00Z',
      updatedAt: '2026-08-31T00:00:00Z',
    };
    const apiPostMock = vi.fn(async () => ({
      success: true,
      images: [image],
    }));
    const identity = { workspaceId: 'brand-07', sessionId: 'session-07' };

    const images = await fetchMaterialImageAssets(
      apiPostMock as unknown as TabApiPost,
      identity,
    );

    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith(
      '/api/xiaojing/material-images/list',
      { ...identity, limit: 100 },
    );
    expect(images).toEqual([image]);
  });

  it('surfaces the stable error code when the candidate list retrieval fails', async () => {
    const apiPostMock = vi.fn(async () => ({
      success: false,
      error: 'material_image_limit_invalid',
    }));
    await expect(
      fetchMaterialImageAssets(
        apiPostMock as unknown as TabApiPost,
        { workspaceId: 'brand-07', sessionId: 'session-07' },
      ),
    ).rejects.toThrow('material_image_limit_invalid');
  });
});
