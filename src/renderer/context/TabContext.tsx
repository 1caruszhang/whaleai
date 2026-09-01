import { createContext, useContext } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { ImageAttachment, SessionFileRef } from '@/components/SimpleChatInput';
import type { Message } from '@/types/chat';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';

export type SessionState = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export interface SystemNotice {
  level: 'success' | 'error';
  message: string;
}

type ApiOptions = { signal?: AbortSignal };

export interface TabApiContextValue {
  tabId: string;
  workspacePath: string;
  sessionId: string | null;
  apiGet: <T>(path: string, options?: ApiOptions) => Promise<T>;
  apiPost: <T>(path: string, body?: unknown, options?: ApiOptions) => Promise<T>;
  apiPut: <T>(path: string, body?: unknown, options?: ApiOptions) => Promise<T>;
  apiDelete: <T>(path: string, options?: ApiOptions) => Promise<T>;
}

export interface TabContextValue extends TabApiContextValue {
  messages: Message[];
  streamingMessage: Message | null;
  isLoading: boolean;
  isSessionLoading: boolean;
  sessionRestoreError: string | null;
  sessionState: SessionState;
  isConnected: boolean;
  agentError: string | null;
  setAgentError: Dispatch<SetStateAction<string | null>>;
  systemNotice: SystemNotice | null;
  setSystemNotice: Dispatch<SetStateAction<SystemNotice | null>>;
  pendingAskUserQuestion: AskUserQuestionRequest | null;
  toolCompleteCount: number;
  sendMessage: (text: string, images?: ImageAttachment[], files?: SessionFileRef[]) => Promise<boolean>;
  stopResponse: () => Promise<{ success: boolean; alreadyStopped: boolean }>;
  retryCurrentSessionRestore: () => Promise<{ restored: boolean }>;
  respondAskUserQuestion: (answers: Record<string, string> | null) => Promise<boolean>;
}

export const TabContext = createContext<TabContextValue | null>(null);
export const TabApiContext = createContext<TabApiContextValue | null>(null);
export const TabActiveContext = createContext(true);

export function useTabState(): TabContextValue {
  const context = useContext(TabContext);
  if (!context) throw new Error('useTabState must be used within a TabProvider');
  return context;
}

export function useTabStateOptional(): TabContextValue | null {
  return useContext(TabContext);
}

export function useTabApi(): TabApiContextValue {
  const context = useContext(TabApiContext);
  if (!context) throw new Error('useTabApi must be used within a TabProvider');
  return context;
}

export function useTabApiOptional(): TabApiContextValue | null {
  return useContext(TabApiContext);
}

export function useTabActive(): boolean {
  return useContext(TabActiveContext);
}
