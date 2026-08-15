import { describe, expect, it, vi } from 'vitest';

import {
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
});
