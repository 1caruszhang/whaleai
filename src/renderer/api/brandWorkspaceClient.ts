import { invoke } from '@tauri-apps/api/core';

import { isTauriEnvironment } from '@/utils/browserMock';
import type { GeoSessionStatus } from '../../shared/geo/notification';
import type { SessionDeleteResult } from './tauriClient';

/**
 * dev:web 浏览器模式没有 Tauri IPC（GD-10）：裸 invoke 会抛
 * `Cannot read properties of undefined (reading 'invoke')` 并被当成
 * 原文渲染进 UI。这里统一拒绝为可读错误，指明该面仅在桌面端可用。
 */
function workspaceInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnvironment()) {
    return Promise.reject(
      new Error('品牌工作区仅在桌面端可用；当前是浏览器开发模式（dev:web），没有 Tauri IPC。'),
    );
  }
  return invoke<T>(command, args);
}

export type BrandSessionTitleSource = 'default' | 'auto' | 'user';

export interface BrandWorkspace {
  id: string;
  name: string;
  productLines: string[];
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrandSession {
  id: string;
  workspaceId: string;
  title: string;
  titleSource: BrandSessionTitleSource;
  createdAt: string;
  lastActiveAt: string;
  archivedAt?: string | null;
  geoStatus?: GeoSessionStatus | null;
}

export interface BrandWorkspaceBootstrap {
  dataRoot: string;
  workspaces: BrandWorkspace[];
  currentWorkspace?: BrandWorkspace | null;
}

export interface BrandSessionDeletionPreview {
  workspaceId: string;
  sessionId: string;
  title: string;
  scope: {
    sessionRecords: number;
    chatTranscripts: number;
  };
  retained: {
    knowledgeFacts: number;
    operations: number;
    artifacts: number;
    publishOrders: number;
    observations: number;
  };
  confirmationToken: string;
}

export function bootstrapBrandWorkspaces(): Promise<BrandWorkspaceBootstrap> {
  return workspaceInvoke('cmd_brand_workspace_bootstrap');
}

export function createBrandWorkspace(
  name: string,
  productLines: string[],
): Promise<BrandWorkspace> {
  return workspaceInvoke('cmd_brand_workspace_create', { name, productLines });
}

export function switchBrandWorkspace(workspaceId: string): Promise<BrandWorkspace> {
  return workspaceInvoke('cmd_brand_workspace_switch', { workspaceId });
}

export function commitBrandSession(
  workspaceId: string,
  sessionId: string,
  title: string,
  titleSource: BrandSessionTitleSource,
): Promise<BrandSession> {
  return workspaceInvoke('cmd_brand_session_commit', {
    workspaceId,
    sessionId,
    title,
    titleSource,
  });
}

export function listBrandSessions(
  workspaceId: string,
  includeArchived = false,
): Promise<BrandSession[]> {
  return workspaceInvoke('cmd_brand_session_list', { workspaceId, includeArchived });
}

export function renameBrandSession(
  workspaceId: string,
  sessionId: string,
  title: string,
): Promise<BrandSession> {
  return workspaceInvoke('cmd_brand_session_rename', { workspaceId, sessionId, title });
}

export function archiveBrandSession(
  workspaceId: string,
  sessionId: string,
  archived: boolean,
): Promise<BrandSession> {
  return workspaceInvoke('cmd_brand_session_archive', { workspaceId, sessionId, archived });
}

export function previewBrandSessionDeletion(
  workspaceId: string,
  sessionId: string,
): Promise<BrandSessionDeletionPreview> {
  return workspaceInvoke('cmd_brand_session_delete_preview', { workspaceId, sessionId });
}

export interface BrandWorkspaceDeletionScope {
  sessions: number;
  chatTranscripts: number;
  knowledgeFacts: number;
  operations: number;
  articles: number;
  materials: number;
  monitorPlans: number;
}

/** 品牌删除预览：sessionIds 供 App 计算可释放 Tab 与卸载范围。 */
export interface BrandWorkspaceDeletionPreview {
  workspaceId: string;
  name: string;
  sessionIds: string[];
  scope: BrandWorkspaceDeletionScope;
  confirmationToken: string;
}

export interface BrandReleasableTab {
  sessionId: string;
  tabId: string;
}

export function previewBrandWorkspaceDeletion(
  workspaceId: string,
): Promise<BrandWorkspaceDeletionPreview> {
  return workspaceInvoke('cmd_brand_workspace_delete_preview', { workspaceId });
}

function rejectionMessage(error: unknown): string | undefined {
  return typeof error === 'string' && error.trim() ? error : undefined;
}

export async function deleteBrandWorkspace(
  workspaceId: string,
  confirmationToken: string,
  releasableTabs: readonly BrandReleasableTab[],
): Promise<SessionDeleteResult> {
  try {
    return await workspaceInvoke<SessionDeleteResult>('cmd_brand_workspace_delete', {
      workspaceId,
      confirmationToken,
      releasableTabs: [...releasableTabs],
    });
  } catch (error) {
    return { deleted: false, reason: 'unexpected', message: rejectionMessage(error) };
  }
}
