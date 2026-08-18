import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriEnvironment: vi.fn(() => true),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/browserMock', () => ({
  isTauriEnvironment: mocks.isTauriEnvironment,
}));

import {
  archiveBrandSession,
  bootstrapBrandWorkspaces,
  commitBrandSession,
  createBrandWorkspace,
  listBrandSessions,
  switchBrandWorkspace,
} from './brandWorkspaceClient';

describe('BrandWorkspace client', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.isTauriEnvironment.mockReturnValue(true);
  });

  it('binds every session access to the explicit workspace identity', async () => {
    mocks.invoke.mockResolvedValue({});

    await commitBrandSession('brand-a', 'session-a', '标题', 'auto');
    await listBrandSessions('brand-b');
    await archiveBrandSession('brand-a', 'session-a', true);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'cmd_brand_session_commit', {
      workspaceId: 'brand-a',
      sessionId: 'session-a',
      title: '标题',
      titleSource: 'auto',
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'cmd_brand_session_list', {
      workspaceId: 'brand-b',
      includeArchived: false,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'cmd_brand_session_archive', {
      workspaceId: 'brand-a',
      sessionId: 'session-a',
      archived: true,
    });
  });

  it('keeps brand creation and selection as BrandWorkspace operations', async () => {
    mocks.invoke.mockResolvedValue({});

    await createBrandWorkspace('鲸跃科技', ['旗舰产品', '企业服务']);
    await switchBrandWorkspace('brand-a');

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'cmd_brand_workspace_create', {
      name: '鲸跃科技',
      productLines: ['旗舰产品', '企业服务'],
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'cmd_brand_workspace_switch', {
      workspaceId: 'brand-a',
    });
  });

  it('rejects with a readable desktop-only error in dev:web instead of a raw invoke TypeError', async () => {
    // GD-10：浏览器开发模式没有 Tauri IPC，不得让
    // `Cannot read properties of undefined (reading 'invoke')` 原文进 UI。
    mocks.isTauriEnvironment.mockReturnValue(false);
    await expect(bootstrapBrandWorkspaces()).rejects.toThrow(/仅在桌面端可用/);
    await expect(createBrandWorkspace('鲸跃', [])).rejects.toThrow(
      /仅在桌面端可用/,
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
