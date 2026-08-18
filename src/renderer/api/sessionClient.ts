import { invoke } from '@tauri-apps/api/core';
import {
  deleteSessionIfUnowned,
  type BrandSessionDeletionAdmission,
  type SessionDeleteResult,
} from './tauriClient';

export interface SessionMetadata {
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  titleSource?: 'default' | 'user';
}

export async function createSession(workspacePath: string, title: string): Promise<SessionMetadata> {
  return invoke<SessionMetadata>('cmd_create_session_metadata', { workspacePath, title });
}

export async function deleteSession(
  sessionId: string,
  releasableTabIds: readonly string[] = [],
  brandDeletion?: BrandSessionDeletionAdmission,
): Promise<SessionDeleteResult> {
  try {
    return brandDeletion
      ? await deleteSessionIfUnowned(sessionId, releasableTabIds, brandDeletion)
      : await deleteSessionIfUnowned(sessionId, releasableTabIds);
  } catch (error) {
    const message = typeof error === 'string' && error.trim() ? error : undefined;
    return { deleted: false, reason: 'unexpected', ...(message ? { message } : {}) };
  }
}

export async function updateSession(
  sessionId: string,
  updates: { title: string; titleSource?: 'default' | 'user' },
): Promise<SessionMetadata | null> {
  const updated = await invoke<boolean>('cmd_update_session_title', {
    sessionId,
    title: updates.title,
  });
  return updated ? ({ id: sessionId, title: updates.title } as SessionMetadata) : null;
}
