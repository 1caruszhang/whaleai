import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { createSseConnection } from '@/api/SseConnection';
import { sessionSidecarFetch } from '@/api/tauriClient';
import type { ImageAttachment, SessionFileRef } from '@/components/SimpleChatInput';
import type { ContentBlock, Message } from '@/types/chat';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
import { imagePayloadForSend } from './userImageAttachmentProjection';
import {
  TabActiveContext,
  TabApiContext,
  TabContext,
  type SessionState,
  type TabApiContextValue,
  type TabContextValue,
} from './TabContext';

type ApiOptions = { signal?: AbortSignal };

// Tauri 模式下 start_sse_proxy 一次性失败没有浏览器路径的自动重连，也不再
// 能靠 App 重渲染"意外"重连（见 SSE effect），这里补有界重试。
const SSE_CONNECT_MAX_ATTEMPTS = 3;
const SSE_CONNECT_RETRY_DELAY_MS = 1_000;

interface TabProviderProps {
  children: ReactNode;
  tabId: string;
  workspacePath: string;
  sessionId?: string | null;
  sessionTitle?: string;
  isActive?: boolean;
  onGeneratingChange?: (isGenerating: boolean) => void;
  onTitleChange?: (title: string) => void;
  onUnreadChange?: (hasUnread: boolean) => void;
  claimSessionOpeningTransition: (sessionId: string) => (() => void) | null;
}

type SessionWireMessage = Omit<Message, 'timestamp' | 'content'> & {
  timestamp: string | Date;
  content: string | ContentBlock[];
};

type SessionDetailsResponse = {
  success: boolean;
  error?: string;
  session?: {
    messages?: SessionWireMessage[];
    liveStreamingMessage?: SessionWireMessage | null;
    liveSessionState?: SessionState;
    pendingInteractiveRequests?: Array<{
      type: 'ask-user-question:request';
      data: AskUserQuestionRequest;
    }>;
  };
};

function parseContent(role: Message['role'], content: SessionWireMessage['content']): Message['content'] {
  if (role !== 'assistant' || typeof content !== 'string' || !content.trimStart().startsWith('[')) {
    return content;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed) ? parsed as ContentBlock[] : content;
  } catch {
    return content;
  }
}

function parseMessage(message: SessionWireMessage): Message {
  return {
    ...message,
    content: parseContent(message.role, message.content),
    timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
  };
}

function upsertMessage(messages: Message[], incoming: Message): Message[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index < 0) return [...messages, incoming];
  const next = messages.slice();
  next[index] = incoming;
  return next;
}

async function handleApiResponse<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json() as T;
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
}

export default function TabProvider({
  children,
  tabId,
  workspacePath,
  sessionId = null,
  sessionTitle,
  isActive = false,
  onGeneratingChange,
  onTitleChange,
  onUnreadChange,
  claimSessionOpeningTransition,
}: TabProviderProps) {
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const sessionTitleRef = useRef(sessionTitle);
  sessionTitleRef.current = sessionTitle;
  // App 每次渲染都传入新的内联回调；effect 只能依赖值迁移（isLoading/
  // isActive），回调一律经 ref 调用，否则每轮渲染都会回写 App 的 tabs
  // state 形成自激重渲染循环，SSE 连接会在建立完成前被反复拆掉。
  const onGeneratingChangeRef = useRef(onGeneratingChange);
  onGeneratingChangeRef.current = onGeneratingChange;
  const onUnreadChangeRef = useRef(onUnreadChange);
  onUnreadChangeRef.current = onUnreadChange;

  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<Message | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSessionLoading, setIsSessionLoading] = useState(Boolean(sessionId));
  const [sessionRestoreError, setSessionRestoreError] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState>('idle');
  const [isConnected, setIsConnected] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [systemNotice, setSystemNotice] = useState<TabContextValue['systemNotice']>(null);
  const [pendingAskUserQuestion, setPendingAskUserQuestion] = useState<AskUserQuestionRequest | null>(null);
  const [toolCompleteCount, setToolCompleteCount] = useState(0);
  const restoreCounterRef = useRef(0);

  useEffect(() => {
    onGeneratingChangeRef.current?.(isLoading);
  }, [isLoading]);
  useEffect(() => {
    if (isActive) onUnreadChangeRef.current?.(false);
  }, [isActive]);

  const request = useCallback(async <T,>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    options?: ApiOptions,
  ): Promise<T> => {
    const response = await sessionSidecarFetch(sessionIdRef.current ?? '', { type: 'tab', id: tabId }, path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Xiaojing-Tab-Id': tabId,
        ...(sessionIdRef.current ? { 'X-Xiaojing-Session-Id': sessionIdRef.current } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options?.signal,
    });
    return handleApiResponse<T>(response);
  }, [tabId]);

  const apiGet = useCallback(<T,>(path: string, options?: ApiOptions) => (
    request<T>('GET', path, undefined, options)
  ), [request]);
  const apiPost = useCallback(<T,>(path: string, body?: unknown, options?: ApiOptions) => (
    request<T>('POST', path, body, options)
  ), [request]);
  const apiPut = useCallback(<T,>(path: string, body?: unknown, options?: ApiOptions) => (
    request<T>('PUT', path, body, options)
  ), [request]);
  const apiDelete = useCallback(<T,>(path: string, options?: ApiOptions) => (
    request<T>('DELETE', path, undefined, options)
  ), [request]);

  const restoreSession = useCallback(async (): Promise<{ restored: boolean }> => {
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId) {
      setMessages([]);
      setStreamingMessage(null);
      setIsSessionLoading(false);
      setSessionRestoreError(null);
      return { restored: true };
    }
    const release = claimSessionOpeningTransition(targetSessionId);
    if (!release) return { restored: false };
    const restoreToken = ++restoreCounterRef.current;
    setIsSessionLoading(true);
    setSessionRestoreError(null);
    try {
      const response = await apiGet<SessionDetailsResponse>(`/sessions/${encodeURIComponent(targetSessionId)}?limit=80`);
      if (restoreToken !== restoreCounterRef.current || targetSessionId !== sessionIdRef.current) {
        return { restored: false };
      }
      if (!response.success || !response.session) throw new Error(response.error ?? 'Session restore failed.');
      setMessages((response.session.messages ?? []).map(parseMessage));
      setStreamingMessage(response.session.liveStreamingMessage
        ? parseMessage(response.session.liveStreamingMessage)
        : null);
      const nextState = response.session.liveSessionState ?? 'idle';
      setSessionState(nextState);
      setIsLoading(nextState === 'starting' || nextState === 'running' || nextState === 'stopping');
      const pending = response.session.pendingInteractiveRequests?.find(
        (request) => request.type === 'ask-user-question:request',
      );
      setPendingAskUserQuestion(pending?.data ?? null);
      setIsSessionLoading(false);
      return { restored: true };
    } catch (error) {
      if (restoreToken === restoreCounterRef.current) {
        setSessionRestoreError(error instanceof Error ? error.message : String(error));
        setIsSessionLoading(false);
      }
      return { restored: false };
    } finally {
      release();
    }
  }, [apiGet, claimSessionOpeningTransition]);

  useEffect(() => {
    restoreCounterRef.current += 1;
    setMessages([]);
    setStreamingMessage(null);
    setPendingAskUserQuestion(null);
    setAgentError(null);
    setSystemNotice(null);
    void restoreSession();
  }, [restoreSession, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setIsConnected(false);
      return;
    }
    const connection = createSseConnection(tabId, sessionIdRef, { type: 'tab', id: tabId });
    connection.setStatusHandler((status) => setIsConnected(status === 'connected'));
    connection.setEventHandler((eventName, data) => {
      if (eventName === 'chat:init') {
        const payload = data as { sessionState?: SessionState; liveStreamingMessage?: SessionWireMessage | null };
        if (payload.sessionState) {
          setSessionState(payload.sessionState);
          setIsLoading(payload.sessionState !== 'idle' && payload.sessionState !== 'error');
        }
        if (payload.liveStreamingMessage) setStreamingMessage(parseMessage(payload.liveStreamingMessage));
        return;
      }
      if (eventName === 'chat:message-replay') {
        const payload = data as { message?: SessionWireMessage };
        if (payload.message) setMessages((current) => upsertMessage(current, parseMessage(payload.message!)));
        return;
      }
      if (eventName === 'chat:message-update') {
        const payload = data as { message?: SessionWireMessage };
        if (payload.message) setStreamingMessage(parseMessage(payload.message));
        return;
      }
      if (eventName === 'chat:message-complete') {
        const payload = data as { message?: SessionWireMessage };
        if (payload.message) {
          const completed = parseMessage(payload.message);
          setMessages((current) => upsertMessage(current, completed));
          if (Array.isArray(completed.content) && completed.content.some((block) => block.type === 'tool_use')) {
            setToolCompleteCount((count) => count + 1);
          }
          if (!isActiveRef.current) onUnreadChangeRef.current?.(true);
        }
        setStreamingMessage(null);
        setIsLoading(false);
        setSessionState('idle');
        return;
      }
      if (eventName === 'chat:message-stopped') {
        const payload = data as { message?: SessionWireMessage } | null;
        if (payload?.message) setMessages((current) => upsertMessage(current, parseMessage(payload.message!)));
        setStreamingMessage(null);
        setIsLoading(false);
        setSessionState('idle');
        return;
      }
      if (eventName === 'chat:status') {
        const next = (data as { sessionState?: SessionState }).sessionState;
        if (next) {
          setSessionState(next);
          setIsLoading(next !== 'idle' && next !== 'error');
        }
        return;
      }
      if (eventName === 'chat:agent-error') {
        setAgentError((data as { message?: string }).message ?? 'Agent request failed.');
        setIsLoading(false);
        setSessionState('error');
        return;
      }
      if (eventName === 'ask-user-question:request') {
        setPendingAskUserQuestion(data as AskUserQuestionRequest);
        return;
      }
      if (eventName === 'ask-user-question:expired') {
        const requestId = (data as { requestId?: string }).requestId;
        setPendingAskUserQuestion((current) => !requestId || current?.requestId === requestId ? null : current);
      }
    });
    let disposed = false;
    const connectWithRetry = async (attempt: number): Promise<void> => {
      try {
        await connection.connect();
      } catch (error) {
        if (disposed || attempt >= SSE_CONNECT_MAX_ATTEMPTS) throw error;
        await new Promise((resolve) => {
          setTimeout(resolve, SSE_CONNECT_RETRY_DELAY_MS * (attempt + 1));
        });
        if (disposed) return;
        await connectWithRetry(attempt + 1);
      }
    };
    void connectWithRetry(0).catch((error) => {
      if (disposed) return;
      setAgentError(error instanceof Error ? error.message : String(error));
      setIsConnected(false);
    });
    return () => {
      disposed = true;
      void connection.disconnect();
    };
  }, [sessionId, tabId]);

  const sendMessage = useCallback(async (text: string, images?: ImageAttachment[], files?: SessionFileRef[]): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed && (!images || images.length === 0) && (!files || files.length === 0)) return false;
    const targetSessionId = sessionIdRef.current;
    if (!targetSessionId || isSessionLoading || isLoading) return false;
    const release = claimSessionOpeningTransition(targetSessionId);
    if (!release) return false;
    setAgentError(null);
    setSystemNotice(null);
    setIsLoading(true);
    setSessionState('starting');
    try {
      const response = await apiPost<{ success: boolean; error?: string }>('/chat/send', {
        text: trimmed,
        images: images?.map(imagePayloadForSend),
        files: files?.map((file) => file.referencePath),
        sessionId: targetSessionId,
      });
      if (!response.success) throw new Error(response.error ?? 'Message was rejected.');
      if ((!sessionTitleRef.current || sessionTitleRef.current === '新会话') && trimmed) {
        onTitleChange?.(trimmed.slice(0, 50));
      }
      return true;
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
      setIsLoading(false);
      setSessionState('error');
      return false;
    } finally {
      release();
    }
  }, [apiPost, claimSessionOpeningTransition, isLoading, isSessionLoading, onTitleChange]);

  const stopResponse = useCallback(async () => {
    try {
      return await apiPost<{ success: boolean; alreadyStopped: boolean }>('/chat/stop', {});
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : String(error));
      return { success: false, alreadyStopped: false };
    }
  }, [apiPost]);

  // 返回 true = 卡片可撤（已送达或服务端确认提问已失效）；
  // 返回 false = 未知状态（网络失败），保留卡片供用户重试。
  const respondAskUserQuestion = useCallback(async (answers: Record<string, string> | null): Promise<boolean> => {
    const requestId = pendingAskUserQuestion?.requestId;
    if (!requestId) return true;
    try {
      const response = await apiPost<{ success: boolean }>('/api/ask-user-question/respond', { requestId, answers });
      if (response.success) {
        setPendingAskUserQuestion(null);
        return true;
      }
      // 服务端已不认识这个提问（turn 已终止 / 侧车重启 / 他处已答）：
      // 撤卡并告知，否则死卡冻在聊天流里，点击永远没有效果。
      setAgentError(answers === null
        ? '该问题已失效，取消未能送达；请直接用自然语言继续。'
        : '该问题已失效，你的选择未能送达；请用自然语言重新说明。');
      setPendingAskUserQuestion(null);
      return true;
    } catch (error) {
      // 网络类失败：提问在服务端可能仍活着，撤卡反而把结构化作答入口
      // 丢掉（turn 仍 running 时新消息也会被拒）。保留卡片允许重试。
      const reason = error instanceof Error ? error.message : String(error);
      setAgentError(`提交未送达（${reason}）；请在卡片上重试，或停止本轮后用自然语言继续。`);
      return false;
    }
  }, [apiPost, pendingAskUserQuestion]);

  const apiValue = useMemo<TabApiContextValue>(() => ({
    tabId, workspacePath, sessionId, apiGet, apiPost, apiPut, apiDelete,
  }), [workspacePath, apiDelete, apiGet, apiPost, apiPut, sessionId, tabId]);

  const contextValue = useMemo<TabContextValue>(() => ({
    ...apiValue,
    messages,
    streamingMessage,
    isLoading,
    isSessionLoading,
    sessionRestoreError,
    sessionState,
    isConnected,
    agentError,
    setAgentError,
    systemNotice,
    setSystemNotice,
    pendingAskUserQuestion,
    toolCompleteCount,
    sendMessage,
    stopResponse,
    retryCurrentSessionRestore: restoreSession,
    respondAskUserQuestion,
  }), [agentError, apiValue, isConnected, isLoading, isSessionLoading, messages,
    pendingAskUserQuestion, respondAskUserQuestion, restoreSession, sendMessage, toolCompleteCount,
    sessionRestoreError, sessionState, stopResponse, streamingMessage, systemNotice]);

  return (
    <TabActiveContext.Provider value={isActive}>
      <TabApiContext.Provider value={apiValue}>
        <TabContext.Provider value={contextValue}>{children}</TabContext.Provider>
      </TabApiContext.Provider>
    </TabActiveContext.Provider>
  );
}
