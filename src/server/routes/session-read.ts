import {
  getAgentState,
  getBuiltinLiveSessionSnapshot,
  getSessionCompletionTerminal,
  getLastBuiltinAssistantText,
  getSessionId,
  isSessionBusy,
} from '../agent-session';
import { getSessionData } from '../SessionStore';
import {
  shrinkSessionMessageForClient,
  shrinkSessionMessagesForClient,
} from '../utils/session-message-preview';
import { toClientSessionMetadata } from '../utils/session-metadata-wire';
import type { SessionMessage, SessionMetadata } from '../types/session';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mergeActiveOverlayMessages(
  diskMessages: SessionMessage[],
  inMemoryMessages: SessionMessage[] | undefined,
): SessionMessage[] {
  if (!inMemoryMessages?.length) return diskMessages;
  const memoryById = new Map(inMemoryMessages.map(message => [message.id, message]));
  const diskIds = new Set(diskMessages.map(message => message.id));
  const merged = diskMessages.map(message => memoryById.get(message.id) ?? message);
  for (const message of inMemoryMessages) {
    if (!diskIds.has(message.id)) merged.push(message);
  }
  return merged;
}

function paginateMessages(
  messages: SessionMessage[],
  url: URL,
): { messages: SessionMessage[]; totalCount: number; hasMoreBefore: boolean } {
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '0', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 0;
  const before = url.searchParams.get('before');
  const totalCount = messages.length;
  if (limit === 0) return { messages, totalCount, hasMoreBefore: false };

  if (before) {
    const beforeIndex = messages.findIndex(message => message.id === before);
    if (beforeIndex < 0) return { messages: [], totalCount, hasMoreBefore: false };
    const start = Math.max(0, beforeIndex - limit);
    return {
      messages: messages.slice(start, beforeIndex),
      totalCount,
      hasMoreBefore: start > 0,
    };
  }

  const start = Math.max(0, totalCount - limit);
  return {
    messages: messages.slice(start),
    totalCount,
    hasMoreBefore: start > 0,
  };
}

function handleSessionDetails(sessionId: string, url: URL): Response {
  const session = getSessionData(sessionId);
  const live = getBuiltinLiveSessionSnapshot(sessionId);

  if (!session) {
    if (!live) return jsonResponse({ success: false, error: 'Session not found.' }, 404);
    const page = paginateMessages(live.inMemoryMessages, url);
    return jsonResponse({
      success: true,
      session: {
        id: sessionId,
        messages: shrinkSessionMessagesForClient(page.messages),
        snapshotRevision: live.snapshotRevision,
        liveStreamingMessage: live.liveStreamingMessage
          ? shrinkSessionMessageForClient(live.liveStreamingMessage)
          : null,
        liveSessionState: live.liveSessionState,
        pendingInteractiveRequests: live.pendingInteractiveRequests.filter(
          request => request.type === 'ask-user-question:request',
        ),
        totalCount: page.totalCount,
        hasMoreBefore: page.hasMoreBefore,
      },
    });
  }

  const merged = mergeActiveOverlayMessages(session.messages, live?.inMemoryMessages);
  const page = paginateMessages(merged, url);
  return jsonResponse({
    success: true,
    session: {
      ...toClientSessionMetadata(session as SessionMetadata),
      messages: shrinkSessionMessagesForClient(page.messages),
      snapshotRevision: live?.snapshotRevision ?? 0,
      liveStreamingMessage: live?.liveStreamingMessage
        ? shrinkSessionMessageForClient(live.liveStreamingMessage)
        : null,
      liveSessionState: live?.liveSessionState ?? 'idle',
      pendingInteractiveRequests: (live?.pendingInteractiveRequests ?? []).filter(
        request => request.type === 'ask-user-question:request',
      ),
      totalCount: page.totalCount,
      hasMoreBefore: page.hasMoreBefore,
    },
  });
}

export async function handleSessionReadRoute(
  pathname: string,
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (pathname === '/api/session-state' && request.method === 'GET') {
    return jsonResponse({
      sessionId: getSessionId(),
      sessionState: getAgentState().sessionState,
      isBusy: isSessionBusy(),
      completionTerminal: getSessionCompletionTerminal(),
    });
  }

  if (pathname === '/api/session-latest-result' && request.method === 'GET') {
    return jsonResponse({
      sessionId: getSessionId(),
      latestResult: getLastBuiltinAssistantText(),
    });
  }

  const match = pathname.match(/^\/sessions\/([^/]+)$/);
  if (match && request.method === 'GET') return handleSessionDetails(match[1], url);
  return null;
}
