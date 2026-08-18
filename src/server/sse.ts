import { randomUUID } from 'node:crypto';

type SseClient = {
  id: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const encoder = new TextEncoder();
const clients = new Set<SseClient>();
const HEARTBEAT_INTERVAL_MS = 15_000;
const COALESCE_HIGH_WATER = 256;
const HARD_QUEUE_LIMIT = 10_000;

export type SseEventPriority = 'critical' | 'coalescible';

/** Every business event emitted by the fixed Xiaojing chat surface must be registered here. */
export const SSE_EVENT_PRIORITIES: Readonly<Record<string, SseEventPriority>> = Object.freeze({
  'chat:init': 'critical',
  'chat:message-replay': 'critical',
  'chat:message-update': 'coalescible',
  'chat:message-complete': 'critical',
  'chat:message-stopped': 'critical',
  'chat:agent-error': 'critical',
  'chat:status': 'critical',
  'ask-user-question:request': 'critical',
  'ask-user-question:expired': 'critical',
});

const unknownEventWarned = new Set<string>();

function resolvePriority(event: string): SseEventPriority {
  const priority = SSE_EVENT_PRIORITIES[event];
  if (priority) return priority;
  if (!unknownEventWarned.has(event)) {
    unknownEventWarned.add(event);
    console.warn(`[sse] unregistered event treated as critical: ${event}`);
  }
  return 'critical';
}

function summarizeText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function summarizeValue(value: unknown, fieldName?: string): unknown {
  if (typeof value === 'string') {
    const sensitiveTextFields = new Set(['content', 'text', 'message', 'answer']);
    return summarizeText(value, fieldName && sensitiveTextFields.has(fieldName) ? 30 : 120);
  }
  if (Array.isArray(value)) return value.map(item => summarizeValue(item, fieldName));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, summarizeValue(item, key)]),
  );
}

export function summarizeSsePayload(event: string, data: unknown): string {
  if (event === 'chat:message-replay' && data && typeof data === 'object') {
    const replay = data as {
      message?: { id?: string; role?: string };
      replayKind?: string;
      sessionId?: string;
    };
    if (replay.message?.id) {
      return [
        `messageId=${replay.message.id}`,
        `replayKind=${replay.replayKind ?? 'unknown'}`,
        `role=${replay.message.role ?? 'unknown'}`,
        `sessionScope=${replay.sessionId ? 'present' : 'none'}`,
      ].join(' ');
    }
  }
  if (data === null || data === undefined) return 'data=null';
  try {
    return `data=${JSON.stringify(summarizeValue(data))}`;
  } catch {
    return 'data=[unserializable]';
  }
}

function formatSse(event: string, data: unknown): Uint8Array {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    serialized = JSON.stringify({ error: 'unserializable_payload' });
  }
  return encoder.encode(`event: ${event}\ndata: ${serialized ?? 'null'}\n\n`);
}

function heartbeatChunk(): Uint8Array {
  return encoder.encode(': ping\n\n');
}

export function broadcast(event: string, data: unknown): void {
  console.log(`[sse] ${event} -> ${summarizeSsePayload(event, data)}`);
  for (const client of clients) client.send(event, data);
}

export function createSseClient(onClose: (client: SseClient) => void): {
  client: SseClient;
  response: Response;
} {
  type QueueEntry = { event: string; priority: SseEventPriority; chunk: Uint8Array };

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const queue: QueueEntry[] = [];

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    clients.delete(client);
    onClose(client);
  };

  const drainQueue = (force = false): void => {
    if (!controller || closed) return;
    while (queue.length > 0 && (force || (controller.desiredSize ?? 1) > 0)) {
      controller.enqueue(queue.shift()!.chunk);
    }
  };

  const client: SseClient = {
    id: randomUUID(),
    send(event, data) {
      if (closed) return;
      const priority = resolvePriority(event);
      const chunk = formatSse(event, data);
      if (controller && queue.length === 0 && (controller.desiredSize ?? 1) > 0) {
        controller.enqueue(chunk);
        return;
      }
      if (priority === 'coalescible' && queue.length >= COALESCE_HIGH_WATER) {
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          if (queue[index].event === event) {
            queue[index] = { event, priority, chunk };
            return;
          }
        }
      }
      if (queue.length >= HARD_QUEUE_LIMIT) {
        client.close();
        return;
      }
      queue.push({ event, priority, chunk });
      drainQueue();
    },
    close() {
      if (closed) return;
      try {
        drainQueue(true);
        controller?.close();
      } catch {
        // The consumer may already have closed its readable side.
      }
      controller = null;
      queue.length = 0;
      finish();
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      drainQueue();
    },
    pull() {
      drainQueue();
    },
    cancel() {
      finish();
    },
  });

  clients.add(client);
  heartbeatTimer = setInterval(() => {
    if (!controller || closed) return;
    try {
      controller.enqueue(heartbeatChunk());
    } catch {
      finish();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
  response.headers.set('X-SSE-Client-Id', client.id);
  return { client, response };
}
