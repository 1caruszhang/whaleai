import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent-session', () => ({
  getAgentState: () => ({ workspacePath: '/brands/acme', sessionState: 'running', hasInitialPrompt: false }),
  getBuiltinLiveSessionSnapshot: () => ({
    inMemoryMessages: [
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
    ],
    liveStreamingMessage: null,
  }),
  getPendingInteractiveRequests: () => [{
    type: 'ask-user-question:request',
    data: { requestId: 'ask-1', questions: [] },
  }],
  getSessionId: () => 'session-live',
}));

import { handleChatStreamRoute } from './chat-stream';

describe('focused chat stream route', () => {
  it('replays only chat state, messages and AskUserQuestion gates', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sent: Array<{ event: string; data: unknown }> = [];
    const response = new Response('stream');
    const result = await handleChatStreamRoute(
      '/chat/stream',
      new Request('http://local/chat/stream'),
      {
        createSseClient: () => ({
          client: { send: (event, data) => sent.push({ event, data }) },
          response,
        }),
      },
    );

    expect(result).toBe(response);
    expect(sent.map((item) => item.event)).toEqual([
      'chat:init',
      'chat:message-replay',
      'ask-user-question:request',
    ]);
  });

  it('ignores unrelated paths', async () => {
    await expect(handleChatStreamRoute(
      '/chat/send',
      new Request('http://local/chat/send'),
      { createSseClient: () => ({ client: { send: vi.fn() }, response: new Response() }) },
    )).resolves.toBeNull();
  });
});
