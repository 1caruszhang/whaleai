import { invoke } from '@tauri-apps/api/core';

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
}

export interface BrandSessionDraft {
  id: string;
  workspaceId: string;
  workspacePath: string;
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

export function createBrandSessionDraft(workspaceId: string): Promise<BrandSessionDraft> {
  return invoke('cmd_brand_session_draft', { workspaceId });
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

export function confirmBrandSessionDeletion(
  workspaceId: string,
  sessionId: string,
  confirmationToken: string,
): Promise<void> {
  return invoke('cmd_brand_session_delete_confirm', {
    workspaceId,
    sessionId,
    confirmationToken,
  });
}
