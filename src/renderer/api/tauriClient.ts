import { invoke } from '@tauri-apps/api/core';

import { isTauriEnvironment } from '@/utils/browserMock';

export interface EnsureSidecarResult {
  port: number;
  isNew: boolean;
}

interface ProxyHttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
  is_base64: boolean;
  ref_url?: string;
}

type ProxyWireRequest = {
  path: string;
  method: string;
  body?: string;
  headers: Record<string, string> | null;
};

export function isTauri(): boolean {
  return isTauriEnvironment();
}

function assertSidecarPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`Sidecar request path must start with one '/': ${path}`);
  }
}

function requestHeaders(input: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(input).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function invokeProxyFetch(
  path: string,
  options: RequestInit | undefined,
  dispatch: (request: ProxyWireRequest) => Promise<ProxyHttpResponse>,
  correlation?: { tabId: string; sessionId: string },
): Promise<Response> {
  if (options?.signal?.aborted) throw new DOMException('Request aborted before dispatch', 'AbortError');
  if (!isTauri()) return fetch(path, options);

  const headers = requestHeaders(options?.headers);
  if (correlation) {
    if (!headers['x-xiaojing-tab-id']) headers['X-Xiaojing-Tab-Id'] = correlation.tabId;
    if (!headers['x-xiaojing-session-id']) headers['X-Xiaojing-Session-Id'] = correlation.sessionId;
  }

  try {
    const result = await dispatch({
      path,
      method: options?.method ?? 'GET',
      body: options?.body === undefined || options.body === null ? undefined : String(options.body),
      headers: Object.keys(headers).length ? headers : null,
    });
    if (result.ref_url) {
      const ref = await fetch(result.ref_url);
      const merged = new Headers(ref.headers);
      for (const [name, value] of Object.entries(result.headers)) {
        if (!merged.has(name)) merged.set(name, value);
      }
      // 透传 ref 自身的状态码：ref 404（如 TTL 过期）不能被原始响应的
      // 200 静默包装成成功。
      return new Response(ref.body, { status: ref.status, headers: merged });
    }
    const body = result.is_base64
      ? Uint8Array.from(atob(result.body), character => character.charCodeAt(0))
      : result.body;
    return new Response(body, { status: result.status, headers: result.headers });
  } catch (error) {
    if (options?.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    throw error;
  }
}

export async function sessionSidecarFetch(
  sessionId: string,
  owner: { type: 'tab'; id: string },
  path: string,
  options?: RequestInit,
): Promise<Response> {
  assertSidecarPath(path);
  return invokeProxyFetch(
    path,
    options,
    request => invoke<ProxyHttpResponse>('session_sidecar_http_request', {
      sessionIdHint: sessionId,
      sidecarOwnerType: owner.type,
      sidecarOwnerId: owner.id,
      request,
    }),
    { tabId: owner.id, sessionId },
  );
}

export async function stopSseProxy(tabId: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('stop_sse_proxy', { connectionKey: tabId });
  } catch {
    // Closing a tab is best-effort; Rust owns final connection cleanup.
  }
}

export async function reconcileSessionTabActivation(sessionId: string, tabId: string): Promise<boolean> {
  if (!isTauri()) return true;
  return invoke<boolean>('cmd_reconcile_session_tab_activation', { sessionId, tabId });
}

export async function ensureSessionSidecar(
  sessionId: string,
  workspacePath: string,
  ownerType: 'tab',
  ownerId: string,
): Promise<EnsureSidecarResult> {
  if (!isTauri()) return { port: 3000, isNew: false };
  return invoke<EnsureSidecarResult>('cmd_ensure_session_sidecar', {
    sessionId,
    workspacePath,
    ownerType,
    ownerId,
  });
}

export async function releaseTabSession(sessionId: string, tabId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('cmd_release_tab_session', { sessionId, tabId });
}

export type SessionDeleteFailureReason =
  | 'in-use'
  | 'busy-replying'
  | 'monitor-active'
  | 'not-found'
  | 'protected-session'
  | 'invalid-session-id'
  | 'authority-unavailable'
  | 'transition-in-progress'
  | 'activity-unavailable'
  | 'unexpected';

export type SessionPersistentOwnerReason =
  | 'in-use'
  | 'busy-replying'
  | 'monitor-active'
  | 'activity-unavailable';

export interface SessionPersistentOwnersResult {
  hasPersistentOwners: boolean;
  reason?: SessionPersistentOwnerReason;
}

/** Preserve a Session identity while any non-Tab lifecycle owner exists. */
export async function sessionHasPersistentOwners(sessionId: string): Promise<SessionPersistentOwnersResult> {
  if (!isTauri()) return { hasPersistentOwners: false };
  try {
    return await invoke<SessionPersistentOwnersResult>('cmd_session_has_persistent_owners', { sessionId });
  } catch {
    // 无法确认 owner 状态时保持拒绝语义，并让用户文案区分「状态未知」。
    return { hasPersistentOwners: true, reason: 'activity-unavailable' };
  }
}

export type SessionDeleteResult =
  | { deleted: true }
  | { deleted: false; reason: SessionDeleteFailureReason; message?: string };

/** Tauri command errors reject with the Rust-facing message string. */
function rejectionMessage(error: unknown): string | undefined {
  return typeof error === 'string' && error.trim() ? error : undefined;
}

export interface BrandSessionDeletionAdmission {
  workspaceId: string;
  confirmationToken: string;
}

export async function deleteSessionIfUnowned(
  sessionId: string,
  releasableTabIds: readonly string[] = [],
  brandDeletion?: BrandSessionDeletionAdmission,
): Promise<SessionDeleteResult> {
  if (!isTauri()) return { deleted: false, reason: 'authority-unavailable' };
  try {
    return await invoke<SessionDeleteResult>('cmd_delete_session_if_unowned', {
      sessionId,
      releasableTabIds: [...releasableTabIds],
      brandWorkspaceId: brandDeletion?.workspaceId,
      brandDeletionConfirmationToken: brandDeletion?.confirmationToken,
    });
  } catch (error) {
    return { deleted: false, reason: 'unexpected', message: rejectionMessage(error) };
  }
}

export async function canRestoreSession(sessionId: string, workspacePath: string): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    return await invoke<boolean>('cmd_can_restore_session', { sessionId, workspacePath });
  } catch {
    return false;
  }
}

export interface BackgroundCompletionResult {
  started: boolean;
  sessionId: string;
}

export async function startBackgroundCompletion(sessionId: string): Promise<BackgroundCompletionResult> {
  if (!isTauri()) return { started: false, sessionId };
  try {
    return await invoke<BackgroundCompletionResult>('cmd_start_background_completion', { sessionId });
  } catch {
    return { started: false, sessionId };
  }
}

export async function startBackgroundCompletionForDeletion(
  sessionId: string,
): Promise<BackgroundCompletionResult> {
  if (!isTauri()) throw new Error('Session activity authority is unavailable outside Tauri');
  return invoke<BackgroundCompletionResult>('cmd_start_background_completion', { sessionId });
}
