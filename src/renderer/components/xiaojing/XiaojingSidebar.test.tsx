import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  BrandSession,
  BrandSessionDeletionPreview,
  BrandWorkspace,
  BrandWorkspaceDeletionPreview,
} from '@/api/brandWorkspaceClient';
import type { AccountState } from '@/api/accountClient';
import { AccountApiContext, AccountStateContext, type AccountApiContextValue } from '@/context/AccountContext';
import type { BrandWorkspaceState } from '@/hooks/useBrandWorkspaces';
import { XiaojingThemeRuntime } from '@/theme';
import { createNewTab } from '@/types/tab';
import ProductSidebar from './XiaojingSidebar';

const loggedInAccount: AccountState = {
  loggedIn: true,
  phone: '13800001234',
  points: 500,
  status: 'active',
  mustChangePassword: false,
  agreementAccepted: true,
  offlineGrace: { within: true, lastServerContactAt: 1, deadlineAt: 1 },
};

const accountApiStub: AccountApiContextValue = {
  login: vi.fn(async () => null),
  changePassword: vi.fn(async () => null),
  logout: vi.fn(async () => undefined),
  refresh: vi.fn(async () => null),
  requireBalance: vi.fn(() => true),
  dismissInsufficientBalance: vi.fn(),
};

function XiaojingSidebar(props: ComponentProps<typeof ProductSidebar>) {
  return (
    <XiaojingThemeRuntime>
      <AccountApiContext.Provider value={accountApiStub}>
        <AccountStateContext.Provider value={loggedInAccount}>
          <ProductSidebar {...props} />
        </AccountStateContext.Provider>
      </AccountApiContext.Provider>
    </XiaojingThemeRuntime>
  );
}

const workspace: BrandWorkspace = {
  id: 'brand-alpha',
  name: '海蓝品牌',
  productLines: ['净水器'],
  rootPath: 'C:\\Users\\tester\\AppData\\Local\\Xiaojing\\brands\\brand-alpha',
  createdAt: '2026-08-14T08:00:00Z',
  updatedAt: '2026-08-14T08:00:00Z',
};

const session: BrandSession = {
  id: 'session-one',
  workspaceId: workspace.id,
  title: '竞品声量分析',
  titleSource: 'auto',
  createdAt: '2026-08-14T08:01:00Z',
  lastActiveAt: '2026-08-14T08:02:00Z',
  archivedAt: null,
};

function state(overrides: Partial<BrandWorkspaceState> = {}): BrandWorkspaceState {
  return {
    workspaces: [workspace],
    currentWorkspace: workspace,
    sessions: [session],
    isLoading: false,
    error: null,
    createWorkspace: vi.fn(),
    switchWorkspace: vi.fn(),
    refreshSessions: vi.fn(),
    commitSession: vi.fn(),
    renameSession: vi.fn(),
    archiveSession: vi.fn(),
    previewDeletion: vi.fn(),
    previewWorkspaceDeletion: vi.fn(),
    refreshBootstrap: vi.fn(async () => undefined),
    removeDeletedSessionProjection: vi.fn(),
    ...overrides,
  };
}

const brandDeleteProps = {
  onDeleteBrand: vi.fn(async () => ({ deleted: true }) as const),
};

describe('XiaojingSidebar brand session lifecycle', () => {
  it('projects privacy-safe GEO status badges for the brand and exact sessions', () => {
    const sessions: BrandSession[] = [
      { ...session, id: 'session-awaiting', geoStatus: 'awaiting-confirmation' },
      { ...session, id: 'session-failed', title: '发布会话', geoStatus: 'failed' },
      { ...session, id: 'session-done', title: '监测会话', geoStatus: 'completed' },
      { ...session, id: 'session-running', title: '执行会话', geoStatus: 'running' },
      { ...session, id: 'session-queued', title: '排队会话', geoStatus: 'queued' },
    ];
    const { container } = render(
      <XiaojingSidebar
        brandState={state({ sessions })}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('[aria-label="待确认"]')).toHaveLength(2);
    expect(container.querySelectorAll('[aria-label="失败"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="完成"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="进行中"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="排队"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="待确认"]')).not.toHaveTextContent(/operation|provider|key/i);
  });

  it('requires the deletion preview and confirms deletion with a single button', async () => {
    const preview: BrandSessionDeletionPreview = {
      workspaceId: workspace.id,
      sessionId: session.id,
      title: session.title,
      scope: { sessionRecords: 1, chatTranscripts: 1 },
      retained: {
        knowledgeFacts: 3,
        operations: 2,
        artifacts: 4,
        publishOrders: 1,
        observations: 5,
      },
      confirmationToken: 'one-use-token',
    };
    const previewDeletion = vi.fn(async () => preview);
    const removeDeletedSessionProjection = vi.fn();
    const onDeleteSession = vi.fn(async () => ({ deleted: true }) as const);

    render(
      <XiaojingSidebar
        brandState={state({ previewDeletion, removeDeletedSessionProjection })}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={onDeleteSession}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `管理会话 ${session.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    await screen.findByRole('heading', { name: `永久删除“${session.title}”` });
    expect(previewDeletion).toHaveBeenCalledWith(workspace.id, session.id);
    expect(screen.getByText(/品牌知识 3 条/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /输入“永久删除”/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    await waitFor(() => {
      expect(onDeleteSession).toHaveBeenCalledWith(preview);
      expect(removeDeletedSessionProjection).toHaveBeenCalledWith(workspace.id, session.id);
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: `永久删除“${session.title}”` })).not.toBeInTheDocument();
    });
  });

  it('surfaces the refusal reason in the dialog instead of failing silently', async () => {
    const preview: BrandSessionDeletionPreview = {
      workspaceId: workspace.id,
      sessionId: session.id,
      title: session.title,
      scope: { sessionRecords: 1, chatTranscripts: 1 },
      retained: {
        knowledgeFacts: 0,
        operations: 0,
        artifacts: 0,
        publishOrders: 0,
        observations: 0,
      },
      confirmationToken: 'one-use-token',
    };
    const removeDeletedSessionProjection = vi.fn();
    const onDeleteSession = vi.fn(async () => (
      { deleted: false, reason: 'in-use' } as const
    ));

    render(
      <XiaojingSidebar
        brandState={state({ previewDeletion: vi.fn(async () => preview), removeDeletedSessionProjection })}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={onDeleteSession}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `管理会话 ${session.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    await screen.findByRole('heading', { name: `永久删除“${session.title}”` });

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/暂时无法删除/);
    expect(screen.getByRole('heading', { name: `永久删除“${session.title}”` })).toBeInTheDocument();
    expect(removeDeletedSessionProjection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(onDeleteSession).toHaveBeenCalledTimes(2));
  });

  it.each([
    {
      reason: 'busy-replying' as const,
      message: /会话正在回复，请停止回复或等待结束后再删除/,
    },
    {
      reason: 'monitor-active' as const,
      message: /发布后监测仍在进行（含已暂停）/,
    },
  ])('distinguishes the $reason refusal copy in the deletion dialog', async ({ reason, message }) => {
    const preview: BrandSessionDeletionPreview = {
      workspaceId: workspace.id,
      sessionId: session.id,
      title: session.title,
      scope: { sessionRecords: 1, chatTranscripts: 1 },
      retained: {
        knowledgeFacts: 0,
        operations: 0,
        artifacts: 0,
        publishOrders: 0,
        observations: 0,
      },
      confirmationToken: 'one-use-token',
    };
    const onDeleteSession = vi.fn(async () => (
      { deleted: false, reason } as const
    ));

    render(
      <XiaojingSidebar
        brandState={state({ previewDeletion: vi.fn(async () => preview) })}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={onDeleteSession}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `管理会话 ${session.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    await screen.findByRole('heading', { name: `永久删除“${session.title}”` });

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('creates one brand with multiple product lines and opens it', async () => {
    const created = { ...workspace, id: 'brand-created', name: '新品牌' };
    const createWorkspace = vi.fn(async () => created);
    const onOpenWorkspace = vi.fn(async () => true);

    render(
      <XiaojingSidebar
        brandState={state({ createWorkspace })}
        activeTab={undefined}
        onOpenWorkspace={onOpenWorkspace}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '创建品牌' }));
    fireEvent.change(screen.getByRole('textbox', { name: '品牌名称' }), {
      target: { value: '新品牌' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));

    await waitFor(() => {
      // 方案 D：创建只需品牌名；产品线由知识确认同步，初始为空。
      expect(createWorkspace).toHaveBeenCalledWith('新品牌', []);
      expect(onOpenWorkspace).toHaveBeenCalledWith(created);
    });
  });

  it('deletes a brand through preview + irreversible confirmation', async () => {
    const preview: BrandWorkspaceDeletionPreview = {
      workspaceId: workspace.id,
      name: workspace.name,
      sessionIds: [session.id],
      scope: {
        sessions: 1,
        chatTranscripts: 1,
        knowledgeFacts: 2,
        operations: 1,
        articles: 3,
        materials: 4,
        monitorPlans: 0,
      },
      confirmationToken: 'brand-one-use-token',
    };
    const previewWorkspaceDeletion = vi.fn(async () => preview);
    const onDeleteBrand = vi.fn(async () => ({ deleted: true }) as const);

    render(
      <XiaojingSidebar
        brandState={state({ previewWorkspaceDeletion })}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /海蓝品牌/ }));
    fireEvent.click(screen.getByRole('button', { name: '删除品牌“海蓝品牌”' }));

    await screen.findByRole('heading', { name: '删除品牌“海蓝品牌”' });
    expect(previewWorkspaceDeletion).toHaveBeenCalledWith(workspace.id);
    expect(screen.getByText(/此操作不可撤销/)).toBeInTheDocument();
    expect(screen.getByText(/文章 3 篇/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除品牌' }));

    await waitFor(() => {
      expect(onDeleteBrand).toHaveBeenCalledWith(preview);
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: '删除品牌“海蓝品牌”' })).not.toBeInTheDocument();
    });
  });

  // 票 30：品牌级一级导航——「品牌档案」跟随当前选中品牌，不依赖任何 Session。
  it('opens the brand archive primary nav entry without touching any session path', () => {
    const onOpenBrandArchive = vi.fn();
    const onOpenWorkspace = vi.fn(async () => true);
    const onOpenSession = vi.fn(async () => true);

    render(
      <XiaojingSidebar
        brandState={state()}
        activeTab={undefined}
        onOpenWorkspace={onOpenWorkspace}
        onOpenSession={onOpenSession}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={onOpenBrandArchive}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '品牌档案' }));
    expect(onOpenBrandArchive).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('marks the brand archive entry as the current page while its tab is active', () => {
    render(
      <XiaojingSidebar
        brandState={state()}
        activeTab={{ ...createNewTab(), view: 'brand-archive', title: '品牌档案' }}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '品牌档案' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // 票 31：品牌级「效果」一级入口——与「品牌档案」同一导航机制，只调品牌级
  // 回调，不经过任何 onOpenWorkspace/onOpenSession 会话打开路径。
  it('opens the brand effect primary nav entry without touching any session path', () => {
    const onOpenBrandEffect = vi.fn();
    const onOpenWorkspace = vi.fn(async () => true);
    const onOpenSession = vi.fn(async () => true);

    render(
      <XiaojingSidebar
        brandState={state()}
        activeTab={undefined}
        onOpenWorkspace={onOpenWorkspace}
        onOpenSession={onOpenSession}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={onOpenBrandEffect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '效果' }));
    expect(onOpenBrandEffect).toHaveBeenCalledTimes(1);
    expect(onOpenWorkspace).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '品牌档案' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks the brand effect entry as the current page while its tab is active', () => {
    render(
      <XiaojingSidebar
        brandState={state()}
        activeTab={{ ...createNewTab(), view: 'brand-effect', title: '效果' }}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '效果' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: '品牌档案' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('opens the personal-info panel from the footer account button', async () => {
    render(
      <XiaojingSidebar
        brandState={state()}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={vi.fn(async () => ({ deleted: true }) as const)}
        onDeleteBrand={brandDeleteProps.onDeleteBrand}
        onOpenBrandArchive={vi.fn()}
        onOpenBrandEffect={vi.fn()}
      />,
    );

    // 左下角账号按钮：手机号掩码 + 点数投影，替代已移除的凭据设置入口。
    const footerButton = screen.getByRole('button', { name: '个人信息' });
    expect(footerButton).toHaveTextContent('138****1234');
    expect(footerButton).toHaveTextContent('500');

    fireEvent.click(footerButton);
    const panel = await screen.findByRole('dialog', { name: '个人信息' });
    // 面板按验收展示完整手机号；侧栏页脚保持掩码。
    expect(within(panel).getByText('13800001234')).toBeTruthy();
    expect(within(panel).getByText('充值引导')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '退出登录' })).toBeTruthy();
  });
});
