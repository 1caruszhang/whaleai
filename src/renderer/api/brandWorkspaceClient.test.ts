import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
  archiveBrandSession,
  commitBrandSession,
  createBrandWorkspace,
  listBrandSessions,
  switchBrandWorkspace,
} from './brandWorkspaceClient';

describe('BrandWorkspace client', () => {
  beforeEach(() => invoke.mockReset());

  it('binds every session access to the explicit workspace identity', async () => {
    invoke.mockResolvedValue({});

    await commitBrandSession('brand-a', 'session-a', '标题', 'auto');
    await listBrandSessions('brand-b');
    await archiveBrandSession('brand-a', 'session-a', true);

    expect(invoke).toHaveBeenNthCalledWith(1, 'cmd_brand_session_commit', {
      workspaceId: 'brand-a',
      sessionId: 'session-a',
      title: '标题',
      titleSource: 'auto',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'cmd_brand_session_list', {
      workspaceId: 'brand-b',
      includeArchived: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'cmd_brand_session_archive', {
      workspaceId: 'brand-a',
      sessionId: 'session-a',
      archived: true,
    });
  });

  it('keeps brand creation and selection as BrandWorkspace operations', async () => {
    invoke.mockResolvedValue({});

    await createBrandWorkspace('鲸跃科技', ['旗舰产品', '企业服务']);
    await switchBrandWorkspace('brand-a');

    expect(invoke).toHaveBeenNthCalledWith(1, 'cmd_brand_workspace_create', {
      name: '鲸跃科技',
      productLines: ['旗舰产品', '企业服务'],
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'cmd_brand_workspace_switch', {
      workspaceId: 'brand-a',
    });
  });
});
