import type { SessionMetadata, SessionStats } from '../types/session';

export type ClientSessionStats = Omit<SessionStats, 'messageCount'> & {
  turnCount: number;
};

export type ClientSessionMetadata = Omit<SessionMetadata, 'stats'> & {
  stats?: ClientSessionStats;
};

/** Project an explicit safe wire shape and expose the persisted count as turns. */
export function toClientSessionMetadata(meta: SessionMetadata): ClientSessionMetadata {
  const result: ClientSessionMetadata = {
    id: meta.id,
    workspacePath: meta.workspacePath,
    title: meta.title,
    createdAt: meta.createdAt,
    lastActiveAt: meta.lastActiveAt,
  };
  if (meta.sdkSessionId !== undefined) result.sdkSessionId = meta.sdkSessionId;
  if (meta.unifiedSession !== undefined) result.unifiedSession = meta.unifiedSession;
  if (meta.lastMessagePreview !== undefined) result.lastMessagePreview = meta.lastMessagePreview;
  if (meta.titleSource !== undefined) result.titleSource = meta.titleSource;
  const { stats } = meta;
  if (stats) {
    result.stats = {
      turnCount: stats.messageCount,
      totalInputTokens: stats.totalInputTokens,
      totalOutputTokens: stats.totalOutputTokens,
      totalCacheReadTokens: stats.totalCacheReadTokens,
      totalCacheCreationTokens: stats.totalCacheCreationTokens,
    };
  }
  return {
    ...result,
  };
}
