/** Unified logging wire types shared by Renderer and Sidecar. */
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogSource = 'node' | 'rust' | 'react';

export interface LogEntry {
  source: LogSource;
  level: LogLevel;
  message: string;
  timestamp: string;
  meta?: Record<string, unknown>;
  sessionId?: string;
  tabId?: string;
  ownerId?: string;
  requestId?: string;
  turnId?: string;
}
