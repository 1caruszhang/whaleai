import { AlertTriangle, Loader2, MessageSquarePlus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AskUserQuestionPrompt } from '@/components/AskUserQuestionPrompt';
import ChatStarterSuggestions from '@/components/chat/ChatStarterSuggestions';
import Message from '@/components/Message';
import SimpleChatInput, { type ImageAttachment, type SessionFileRef } from '@/components/SimpleChatInput';
import XiaojingChatMaterialImport from '@/components/xiaojing/XiaojingChatMaterialImport';
import { useCurrentWorkspace } from '@/context/CurrentWorkspaceContext';
import { useTabState } from '@/context/TabContext';
import { FileActionProvider } from '@/context/FileActionContext';
import { useWorkspaceChangeSignal } from '@/hooks/useWorkspaceChangeSignal';
import type { InitialMessage } from '@/types/tab';
import { scrollContainerToGeoOperationGate } from '@/utils/geoGateScroll';
import type { GeoNavigationTarget } from '../../shared/geo/notification';

interface ChatProps {
  initialMessage?: InitialMessage;
  onInitialMessageConsumed?: () => void;
  onNewSession?: () => Promise<boolean>;
  sessionTitle?: string;
  onRenameSession?: (newTitle: string) => void;
  /** 通知深链落点（票 32）：定位到本会话对应操作的聊天闸门卡。 */
  navigationTarget?: GeoNavigationTarget;
}

/** Focused Xiaojing chat surface: conversation, attachments and host questions only. */
export default function Chat({
  initialMessage,
  onInitialMessageConsumed,
  onNewSession,
  sessionTitle = '新会话',
  onRenameSession,
  navigationTarget,
}: ChatProps) {
  const {
    workspacePath,
    sessionId,
    messages,
    streamingMessage,
    isLoading,
    isSessionLoading,
    sessionRestoreError,
    isConnected,
    agentError,
    setAgentError,
    systemNotice,
    setSystemNotice,
    pendingAskUserQuestion,
    respondAskUserQuestion,
    sendMessage,
    stopResponse,
    retryCurrentSessionRestore,
  } = useTabState();
  // 材料导入入口只服从本 Tab 精确匹配的品牌，不用全局 current workspace 补位。
  const currentWorkspace = useCurrentWorkspace();
  const [draftTitle, setDraftTitle] = useState(sessionTitle);
  const [renaming, setRenaming] = useState(false);
  const consumedInitialRef = useRef<InitialMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 深链定位期间抑制「跟随底部」自动滚动，避免两路滚动互相覆盖。
  const gateLocationActiveRef = useRef(false);
  const workspaceRefreshSignal = useWorkspaceChangeSignal(workspacePath);

  const visibleMessages = useMemo(() => {
    if (!streamingMessage || messages.some((message) => message.id === streamingMessage.id)) return messages;
    return [...messages, streamingMessage];
  }, [messages, streamingMessage]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (gateLocationActiveRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [visibleMessages.length, streamingMessage?.content]);

  // 票 32：通知深链落到本聊天 Tab 时滚动到对应操作的闸门卡。会话可能
  // 仍在异步恢复（滚动容器尚未挂载），滚动工具按固定节奏重试直到卡片
  // 出现；定位结束（命中或耗尽）后恢复跟随底部。依赖只取原始值
  // （react_stability_rules 2），每个 nonce 只触发一次定位。
  const navigationNonce = navigationTarget?.nonce ?? 0;
  const navigationOperationId = navigationTarget?.operationId ?? null;
  useEffect(() => {
    if (!navigationNonce || !navigationOperationId || isSessionLoading) return;
    const node = scrollRef.current;
    if (!node) return;
    gateLocationActiveRef.current = true;
    const cancel = scrollContainerToGeoOperationGate(node, navigationOperationId, {
      onSettled: () => {
        gateLocationActiveRef.current = false;
      },
    });
    return () => {
      cancel();
      gateLocationActiveRef.current = false;
    };
  }, [isSessionLoading, navigationNonce, navigationOperationId]);

  const handleSend = useCallback(async (text: string, images?: ImageAttachment[], files?: SessionFileRef[]) => {
    if (!text.trim() && (!images || images.length === 0) && (!files || files.length === 0)) return false;
    return sendMessage(text, images, files);
  }, [sendMessage]);

  useEffect(() => {
    if (!initialMessage || consumedInitialRef.current === initialMessage) return;
    if (!isConnected || isSessionLoading || isLoading) return;
    consumedInitialRef.current = initialMessage;
    void handleSend(initialMessage.text, initialMessage.images).then((accepted) => {
      if (accepted === false) {
        consumedInitialRef.current = null;
        return;
      }
      onInitialMessageConsumed?.();
    });
  }, [handleSend, initialMessage, isConnected, isLoading, isSessionLoading, onInitialMessageConsumed]);

  const commitTitle = () => {
    const title = draftTitle.trim();
    setRenaming(false);
    if (title && title !== sessionTitle) onRenameSession?.(title);
    else setDraftTitle(sessionTitle);
  };

  if (isSessionLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在恢复会话…
      </div>
    );
  }

  if (sessionRestoreError) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] px-6">
        <div className="max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 text-center">
          <AlertTriangle className="mx-auto h-6 w-6 text-[var(--error)]" />
          <p className="mt-3 text-sm text-[var(--ink)]">会话恢复失败</p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">{sessionRestoreError}</p>
          <button
            type="button"
            onClick={() => void retryCurrentSessionRestore()}
            className="mt-4 rounded-xl bg-[var(--button-primary-bg)] px-4 py-2 text-sm text-[var(--button-primary-text)]"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <FileActionProvider workspacePath={workspacePath} refreshTrigger={workspaceRefreshSignal}>
    <section className="flex h-full min-w-0 flex-col bg-[var(--paper)]" data-xiaojing-chat>
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
        {renaming ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitTitle();
              if (event.key === 'Escape') {
                setDraftTitle(sessionTitle);
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1 text-sm outline-none focus:border-[var(--focus-border)]"
          />
        ) : (
          <button type="button" onClick={() => { setDraftTitle(sessionTitle); setRenaming(true); }} className="min-w-0 truncate text-sm font-medium text-[var(--ink)]">
            {sessionTitle}
          </button>
        )}
        {onNewSession && (
          <button
            type="button"
            aria-label="新建会话"
            onClick={() => void onNewSession()}
            className="ml-3 rounded-lg p-2 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        )}
      </header>

      {agentError && (
        <div className="flex items-start gap-2 border-b border-[var(--line)] bg-[var(--paper-inset)] px-4 py-2 text-xs text-[var(--error)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{agentError}</span>
          <button type="button" aria-label="关闭错误" onClick={() => setAgentError(null)}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {systemNotice && (
        <div className="flex items-start gap-2 border-b border-[var(--line)] bg-[var(--paper-inset)] px-4 py-2 text-xs text-[var(--ink-muted)]">
          <span className="flex-1">{systemNotice.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setSystemNotice(null)}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5" data-streaming={isLoading || undefined}>
        <div className="mx-auto max-w-3xl space-y-3">
          {visibleMessages.length === 0 && (
            <ChatStarterSuggestions
              onSend={(prompt) => { void handleSend(prompt); }}
              disabled={isLoading || !isConnected || isSessionLoading}
            />
          )}
          {visibleMessages.map((message) => (
            <Message key={message.id} message={message} isLoading={isLoading && message.id === streamingMessage?.id} />
          ))}
          {pendingAskUserQuestion && (
            <AskUserQuestionPrompt
              request={pendingAskUserQuestion}
              onSubmit={(_requestId, answers) => void respondAskUserQuestion(answers)}
              onCancel={() => void respondAskUserQuestion(null)}
            />
          )}
        </div>
      </div>

      {currentWorkspace && (
        <XiaojingChatMaterialImport workspaceId={currentWorkspace.id} />
      )}

      <SimpleChatInput
        onSend={handleSend}
        onStop={() => void stopResponse()}
        isLoading={isLoading}
        sendBlocked={!isConnected || isSessionLoading}
        workspacePath={workspacePath}
        sessionId={sessionId}
      />
    </section>
    </FileActionProvider>
  );
}
