import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  BrandSession,
  BrandSessionDeletionPreview,
  BrandWorkspace,
} from '@/api/brandWorkspaceClient';
import type { BrandWorkspaceState } from '@/hooks/useBrandWorkspaces';
import XiaojingSidebar from './XiaojingSidebar';

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
    confirmDeletion: vi.fn(),
    ...overrides,
  };
}

describe('XiaojingSidebar brand session lifecycle', () => {
  it('requires the deletion preview and typed second confirmation before deleting', async () => {
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
    const confirmDeletion = vi.fn(async () => undefined);
    const onDeleteSession = vi.fn(async () => true);

    render(
      <XiaojingSidebar
        brandState={state({ previewDeletion, confirmDeletion })}
        activeTab={undefined}
        onOpenWorkspace={vi.fn(async () => true)}
        onOpenSession={vi.fn(async () => true)}
        onRenameSession={vi.fn(async () => undefined)}
        onDeleteSession={onDeleteSession}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `管理会话 ${session.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));

    await screen.findByRole('heading', { name: `永久删除“${session.title}”` });
    expect(previewDeletion).toHaveBeenCalledWith(workspace.id, session.id);
    expect(screen.getByText(/品牌知识 3 条/)).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: '永久删除' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: /输入“永久删除”/ }), {
      target: { value: '永久删除' },
    });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(onDeleteSession).toHaveBeenCalledWith(session.id);
      expect(confirmDeletion).toHaveBeenCalledWith(
        workspace.id,
        session.id,
        preview.confirmationToken,
      );
    });
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
        onDeleteSession={vi.fn(async () => true)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '创建品牌' }));
    fireEvent.change(screen.getByRole('textbox', { name: '品牌名称' }), {
      target: { value: '新品牌' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /产品线/ }), {
      target: { value: '净水器，空气净化器\n滤芯' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith('新品牌', ['净水器', '空气净化器', '滤芯']);
      expect(onOpenWorkspace).toHaveBeenCalledWith(created);
    });
  });
});
