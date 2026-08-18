import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAgentState: vi.fn<() => {
    sessionState: 'idle' | 'starting' | 'running' | 'stopping' | 'error';
  }>(() => ({ sessionState: 'idle' })),
  getLiveSnapshot: vi.fn<() => Record<string, unknown> | null>(() => null),
  getCompletionTerminal: vi.fn<() => Record<string, unknown> | null>(() => null),
  getLastAssistantText: vi.fn(() => 'latest answer'),
  getSessionId: vi.fn(() => 'sid'),
  isSessionBusy: vi.fn(() => false),
  getSessionData: vi.fn<() => Record<string, unknown> | null>(() => null),
}));

vi.mock('../agent-session', () => ({
  getAgentState: mocks.getAgentState,
  getBuiltinLiveSessionSnapshot: mocks.getLiveSnapshot,
  getSessionCompletionTerminal: mocks.getCompletionTerminal,
  getLastBuiltinAssistantText: mocks.getLastAssistantText,
  getSessionId: mocks.getSessionId,
  isSessionBusy: mocks.isSessionBusy,
}));

vi.mock('../SessionStore', () => ({
  getSessionData: mocks.getSessionData,
}));

vi.mock('../utils/session-message-preview', () => ({
  shrinkSessionMessageForClient: (message: unknown) => message,
  shrinkSessionMessagesForClient: (messages: unknown) => messages,
}));

import { handleSessionReadRoute } from './session-read';

async function json(response: Response | null): Promise<Record<string, unknown>> {
  return await response!.json() as Record<string, unknown>;
}

describe('focused Session read routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAgentState.mockReturnValue({ sessionState: 'idle' });
    mocks.getLiveSnapshot.mockReturnValue(null);
    mocks.getCompletionTerminal.mockReturnValue(null);
    mocks.getLastAssistantText.mockReturnValue('latest answer');
    mocks.getSessionId.mockReturnValue('sid');
    mocks.isSessionBusy.mockReturnValue(false);
    mocks.getSessionData.mockReturnValue(null);
  });

  it('reads current state and the latest assistant result', async () => {
    mocks.getAgentState.mockReturnValue({ sessionState: 'running' });
    mocks.isSessionBusy.mockReturnValue(true);
    mocks.getCompletionTerminal.mockReturnValue({
      sessionId: 'sid',
      workspacePath: '/tmp/brand',
      turnId: 'turn-1',
      status: 'complete',
    });

    expect(await json(await handleSessionReadRoute(
      '/api/session-state',
      new Request('http://local/api/session-state'),
      new URL('http://local/api/session-state'),
    ))).toEqual({
      sessionId: 'sid',
      sessionState: 'running',
      isBusy: true,
      completionTerminal: expect.objectContaining({ turnId: 'turn-1' }),
    });
    expect(await json(await handleSessionReadRoute(
      '/api/session-latest-result',
      new Request('http://local/api/session-latest-result'),
      new URL('http://local/api/session-latest-result'),
    ))).toEqual({ sessionId: 'sid', latestResult: 'latest answer' });
  });

  it('merges a live overlay onto durable history and exposes only Ask requests', async () => {
    mocks.getSessionData.mockReturnValue({
      id: 'sid',
      workspacePath: '/tmp/brand',
      title: 'Brand session',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      messages: [
        { id: 'm1', role: 'user', content: 'durable', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
    });
    mocks.getLiveSnapshot.mockReturnValue({
      snapshotRevision: 3,
      liveSessionState: 'running',
      liveStreamingMessage: { id: 'live', role: 'assistant', content: 'typing' },
      inMemoryMessages: [
        { id: 'm1', role: 'user', content: 'newer memory', timestamp: '2026-01-01T00:00:00.000Z' },
        { id: 'm2', role: 'assistant', content: 'answer', timestamp: '2026-01-01T00:00:01.000Z' },
      ],
      pendingInteractiveRequests: [
        { type: 'ask-user-question:request', data: { requestId: 'ask-1' } },
        { type: 'unknown', data: { requestId: 'hidden' } },
      ],
    });

    const body = await json(await handleSessionReadRoute(
      '/sessions/sid',
      new Request('http://local/sessions/sid?limit=10'),
      new URL('http://local/sessions/sid?limit=10'),
    ));
    const session = body.session as {
      messages: Array<{ id: string; content: string }>;
      pendingInteractiveRequests: Array<{ type: string }>;
      liveStreamingMessage: { id: string };
    };
    expect(session.messages).toEqual([
      expect.objectContaining({ id: 'm1', content: 'newer memory' }),
      expect.objectContaining({ id: 'm2', content: 'answer' }),
    ]);
    expect(session.pendingInteractiveRequests).toEqual([
      expect.objectContaining({ type: 'ask-user-question:request' }),
    ]);
    expect(session.liveStreamingMessage.id).toBe('live');
  });

  it('returns a memory-only active Session and rejects an unknown identity', async () => {
    mocks.getLiveSnapshot.mockReturnValue({
      snapshotRevision: 1,
      liveSessionState: 'starting',
      liveStreamingMessage: null,
      inMemoryMessages: [{ id: 'u1', role: 'user', content: 'accepted' }],
      pendingInteractiveRequests: [],
    });
    const active = await handleSessionReadRoute(
      '/sessions/sid',
      new Request('http://local/sessions/sid'),
      new URL('http://local/sessions/sid'),
    );
    expect(active?.status).toBe(200);
    expect(await json(active)).toMatchObject({
      success: true,
      session: { id: 'sid', totalCount: 1, messages: [{ id: 'u1' }] },
    });

    mocks.getLiveSnapshot.mockReturnValue(null);
    const missing = await handleSessionReadRoute(
      '/sessions/missing',
      new Request('http://local/sessions/missing'),
      new URL('http://local/sessions/missing'),
    );
    expect(missing?.status).toBe(404);
  });

  it('does not catch more specific Session subroutes', async () => {
    await expect(handleSessionReadRoute(
      '/sessions/sid/stats',
      new Request('http://local/sessions/sid/stats'),
      new URL('http://local/sessions/sid/stats'),
    )).resolves.toBeNull();
  });
});
