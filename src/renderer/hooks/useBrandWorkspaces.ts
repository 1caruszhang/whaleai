import { useCallback, useEffect, useRef, useState } from 'react';

import {
  archiveBrandSession,
  bootstrapBrandWorkspaces,
  commitBrandSession,
  confirmBrandSessionDeletion,
  createBrandWorkspace,
  listBrandSessions,
  previewBrandSessionDeletion,
  renameBrandSession,
  switchBrandWorkspace,
  type BrandSession,
  type BrandSessionDeletionPreview,
  type BrandSessionTitleSource,
  type BrandWorkspace,
} from '@/api/brandWorkspaceClient';

export interface BrandWorkspaceState {
  workspaces: BrandWorkspace[];
  currentWorkspace: BrandWorkspace | null;
  sessions: BrandSession[];
  isLoading: boolean;
  error: string | null;
  createWorkspace: (name: string, productLines: string[]) => Promise<BrandWorkspace>;
  switchWorkspace: (workspaceId: string) => Promise<BrandWorkspace>;
  refreshSessions: (workspaceId?: string) => Promise<void>;
  commitSession: (
    workspaceId: string,
    sessionId: string,
    title: string,
    titleSource: BrandSessionTitleSource,
  ) => Promise<void>;
  renameSession: (workspaceId: string, sessionId: string, title: string) => Promise<void>;
  archiveSession: (workspaceId: string, sessionId: string, archived: boolean) => Promise<void>;
  previewDeletion: (workspaceId: string, sessionId: string) => Promise<BrandSessionDeletionPreview>;
  confirmDeletion: (
    workspaceId: string,
    sessionId: string,
    confirmationToken: string,
  ) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useBrandWorkspaces(): BrandWorkspaceState {
  const [workspaces, setWorkspaces] = useState<BrandWorkspace[]>([]);
  const [currentWorkspace, setCurrentWorkspace] = useState<BrandWorkspace | null>(null);
  const currentWorkspaceRef = useRef<BrandWorkspace | null>(null);
  const [sessions, setSessions] = useState<BrandSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sessionLoadGeneration = useRef(0);

  const refreshSessions = useCallback(async (workspaceId?: string) => {
    const id = workspaceId ?? currentWorkspaceRef.current?.id;
    const generation = ++sessionLoadGeneration.current;
    if (!id) {
      setSessions([]);
      return;
    }
    try {
      const next = await listBrandSessions(id);
      if (generation === sessionLoadGeneration.current) setSessions(next);
    } catch (cause) {
      if (generation === sessionLoadGeneration.current) setError(errorMessage(cause));
      throw cause;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void bootstrapBrandWorkspaces()
      .then(async (bootstrap) => {
        if (cancelled) return;
        setWorkspaces(bootstrap.workspaces);
        setCurrentWorkspace(bootstrap.currentWorkspace ?? null);
        currentWorkspaceRef.current = bootstrap.currentWorkspace ?? null;
        if (bootstrap.currentWorkspace) {
          await refreshSessions(bootstrap.currentWorkspace.id);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
      sessionLoadGeneration.current += 1;
    };
  }, [refreshSessions]);

  const createWorkspace = useCallback(async (name: string, productLines: string[]) => {
    const workspace = await createBrandWorkspace(name, productLines);
    setWorkspaces((current) => [...current, workspace]);
    setCurrentWorkspace(workspace);
    currentWorkspaceRef.current = workspace;
    setSessions([]);
    setError(null);
    return workspace;
  }, []);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = await switchBrandWorkspace(workspaceId);
    setCurrentWorkspace(workspace);
    currentWorkspaceRef.current = workspace;
    setSessions([]);
    setError(null);
    await refreshSessions(workspace.id);
    return workspace;
  }, [refreshSessions]);

  const commitSession = useCallback(async (
    workspaceId: string,
    sessionId: string,
    title: string,
    titleSource: BrandSessionTitleSource,
  ) => {
    const session = await commitBrandSession(workspaceId, sessionId, title, titleSource);
    if (currentWorkspaceRef.current?.id === workspaceId) {
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
    }
  }, []);

  const renameSession = useCallback(async (
    workspaceId: string,
    sessionId: string,
    title: string,
  ) => {
    const session = await renameBrandSession(workspaceId, sessionId, title);
    if (currentWorkspaceRef.current?.id === workspaceId) {
      setSessions((current) => current.map((item) => item.id === session.id ? session : item));
    }
  }, []);

  const archiveSession = useCallback(async (
    workspaceId: string,
    sessionId: string,
    archived: boolean,
  ) => {
    await archiveBrandSession(workspaceId, sessionId, archived);
    if (currentWorkspaceRef.current?.id === workspaceId) {
      setSessions((current) => archived
        ? current.filter((item) => item.id !== sessionId)
        : current);
    }
  }, []);

  const previewDeletion = useCallback((workspaceId: string, sessionId: string) => (
    previewBrandSessionDeletion(workspaceId, sessionId)
  ), []);

  const confirmDeletion = useCallback(async (
    workspaceId: string,
    sessionId: string,
    confirmationToken: string,
  ) => {
    await confirmBrandSessionDeletion(workspaceId, sessionId, confirmationToken);
    if (currentWorkspaceRef.current?.id === workspaceId) {
      setSessions((current) => current.filter((item) => item.id !== sessionId));
    }
  }, []);

  return {
    workspaces,
    currentWorkspace,
    sessions,
    isLoading,
    error,
    createWorkspace,
    switchWorkspace,
    refreshSessions,
    commitSession,
    renameSession,
    archiveSession,
    previewDeletion,
    confirmDeletion,
  };
}
