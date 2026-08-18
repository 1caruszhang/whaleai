import { invoke } from '@tauri-apps/api/core';
import type { GeoSessionStatus } from '../../shared/geo/notification';
import type { SessionDeleteResult } from './tauriClient';

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
  return invoke('cmd_brand_workspace_bootstrap');
}

export function createBrandWorkspace(
  name: string,
  productLines: string[],
): Promise<BrandWorkspace> {
  return invoke('cmd_brand_workspace_create', { name, productLines });
}

export function switchBrandWorkspace(workspaceId: string): Promise<BrandWorkspace> {
  return invoke('cmd_brand_workspace_switch', { workspaceId });
}

export function commitBrandSession(
  workspaceId: string,
  sessionId: string,
  title: string,
  titleSource: BrandSessionTitleSource,
): Promise<BrandSession> {
  return invoke('cmd_brand_session_commit', {
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
  return invoke('cmd_brand_session_list', { workspaceId, includeArchived });
}

export function renameBrandSession(
  workspaceId: string,
  sessionId: string,
  title: string,
): Promise<BrandSession> {
  return invoke('cmd_brand_session_rename', { workspaceId, sessionId, title });
}

export function archiveBrandSession(
  workspaceId: string,
  sessionId: string,
  archived: boolean,
): Promise<BrandSession> {
  return invoke('cmd_brand_session_archive', { workspaceId, sessionId, archived });
}

export function previewBrandSessionDeletion(
  workspaceId: string,
  sessionId: string,
): Promise<BrandSessionDeletionPreview> {
  return invoke('cmd_brand_session_delete_preview', { workspaceId, sessionId });
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
  return invoke('cmd_brand_workspace_delete_preview', { workspaceId });
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
    return await invoke<SessionDeleteResult>('cmd_brand_workspace_delete', {
      workspaceId,
      confirmationToken,
      releasableTabs: [...releasableTabs],
    });
  } catch (error) {
    return { deleted: false, reason: 'unexpected', message: rejectionMessage(error) };
  }
}
