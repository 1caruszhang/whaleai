import { randomUUID } from 'node:crypto';

export interface SessionStats {
  /** Persisted user-turn count. The HTTP wire format exposes this as turnCount. */
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
}

/** Durable metadata owned by the SessionStore. */
export interface SessionMetadata {
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  /** Claude Agent SDK resume identity, learned from the SDK init event. */
  sdkSessionId?: string;
  unifiedSession?: boolean;
  stats?: SessionStats;
  lastMessagePreview?: string;
  titleSource?: 'default' | 'user';
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  path: string;
}

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface MessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  modelUsage?: Record<string, ModelUsageEntry>;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sdkUuid?: string;
  attachments?: MessageAttachment[];
  usage?: MessageUsage;
  toolCount?: number;
  durationMs?: number;
  /** 非正常终止标记：该轮 partial 输出已落盘，恢复渲染时用于标注「未完成」。 */
  terminal?: 'stopped' | 'error';
}

export interface SessionData extends SessionMetadata {
  messages: SessionMessage[];
}

export function generateSessionTitle(message: string): string {
  const title = message.replace(/\s+/g, ' ').trim();
  if (!title) return 'New Chat';
  return title.length > 40 ? `${title.slice(0, 40)}…` : title;
}

export function createSessionMetadata(
  workspacePath: string,
  snapshot: Partial<Pick<SessionMetadata, 'title' | 'lastActiveAt'>> = {},
): SessionMetadata {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    workspacePath,
    title: snapshot.title ?? 'New Chat',
    createdAt: now,
    lastActiveAt: snapshot.lastActiveAt ?? now,
    unifiedSession: true,
    titleSource: 'default',
  };
}
