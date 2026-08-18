import { createColdHistoryMessageReplay } from '../../shared/chatMessageReplay';
import {
  getAgentState,
  getBuiltinLiveSessionSnapshot,
  getPendingInteractiveRequests,
  getSessionId,
} from '../agent-session';
import { summarizeSsePayload } from '../sse';

type SseClient = {
  send(event: string, data: unknown): void;
};

export type ChatStreamRouteDeps = {
  createSseClient(onClose: () => void): { client: SseClient; response: Response };
};

export async function handleChatStreamRoute(
  pathname: string,
  request: Request,
  deps: ChatStreamRouteDeps,
): Promise<Response | null> {
  if (pathname !== '/chat/stream' || request.method !== 'GET') return null;

  const sessionId = getSessionId();
  const snapshot = getBuiltinLiveSessionSnapshot(sessionId);
  const { client, response } = deps.createSseClient(() => {});

  client.send('chat:init', {
    ...getAgentState(),
    sessionId,
    liveStreamingMessage: snapshot?.liveStreamingMessage ?? null,
  });

  for (const message of snapshot?.inMemoryMessages ?? []) {
    const replay = createColdHistoryMessageReplay(sessionId, message);
    console.log(
      `[sse] chat:message-replay -> ${summarizeSsePayload('chat:message-replay', replay)}`,
    );
    client.send('chat:message-replay', replay);
  }

  for (const pending of getPendingInteractiveRequests()) {
    if (pending.type === 'ask-user-question:request') {
      client.send(pending.type, pending.data);
    }
  }

  return response;
}
