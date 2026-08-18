import { arrayMove } from '@dnd-kit/sortable';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  BrandSession,
  BrandSessionDeletionPreview,
  BrandWorkspace,
  BrandWorkspaceDeletionPreview,
} from '@/api/brandWorkspaceClient';
import { deleteBrandWorkspace } from '@/api/brandWorkspaceClient';
import { createSession, deleteSession as removeSession, updateSession } from '@/api/sessionClient';
import {
  canRestoreSession,
  ensureSessionSidecar,
  reconcileSessionTabActivation,
  releaseTabSession,
  sessionHasPersistentOwners,
  startBackgroundCompletion,
  startBackgroundCompletionForDeletion,
  stopSseProxy,
  type SessionDeleteResult,
} from '@/api/tauriClient';
import ChatBootOverlay from '@/components/ChatBootOverlay';
import CustomTitleBar from '@/components/CustomTitleBar';
import LinkContextMenuProvider from '@/components/LinkContextMenuProvider';
import TabBar from '@/components/TabBar';
import { useToast } from '@/components/Toast';
import { ChangePasswordScreen, LoginScreen } from '@/components/account/LoginGate';
import XiaojingBrandArchivePage from '@/components/xiaojing/XiaojingBrandArchivePage';
import XiaojingGeoEffectPage, { type BrandEffectSessionBinding } from '@/components/xiaojing/XiaojingGeoEffectPage';
import XiaojingGeoWorkbench from '@/components/xiaojing/XiaojingGeoWorkbench';
import XiaojingSidebar from '@/components/xiaojing/XiaojingSidebar';
import XiaojingWelcome from '@/components/xiaojing/XiaojingWelcome';
import {
  accountGateFor,
  useAccountReady,
  useAccountState,
} from '@/context/AccountContext';
import AccountProvider from '@/context/AccountProvider';
import { SessionDeletionContext } from '@/context/SessionDeletionContext';
import { CurrentWorkspaceContext } from '@/context/CurrentWorkspaceContext';
import TabProvider from '@/context/TabProvider';
import { useBrandWorkspaces } from '@/hooks/useBrandWorkspaces';
import { useWindowLifecycle } from '@/hooks/useWindowLifecycle';
import { notificationClickListenerReady, resolveGeoNotificationLocator } from '@/services/notificationService';
import { buildChatFlipPatch, createNewTab, MAX_TABS, type InitialMessage, type Tab } from '@/types/tab';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { isPendingSessionId } from '../shared/constants';
import {
  createSessionResourceTransitionState,
  deleteSessionThroughAppOwner,
  tryClaimSessionResourceTransition,
} from '@/utils/sessionDeletionCoordinator';
import { resolveNotificationClickRoute, type NotificationClickPayload } from '@/utils/notificationClickRoute';
import { buildRestoredTabs, saveOpenTabs } from '@/utils/tabPersistence';
import { tabContentKind } from '@/utils/tabContentKind';
import type {
  GeoEffectNavigationTarget,
  GeoNavigationTarget,
} from '../shared/geo/notification';
import { workspacePathsEqual } from '../shared/workspacePath';

const Chat = lazy(() => import('@/pages/Chat'));

interface TabContentProps {
  tab: Tab;
  brandWorkspace: BrandWorkspace | null;
  isActive: boolean;
  onNewSession: (tabId: string) => Promise<boolean>;
  onUpdateGenerating: (tabId: string, generating: boolean) => void;
  onUpdateTitle: (tabId: string, title: string) => void;
  onUpdateUnread: (tabId: string, unread: boolean) => void;
  onRenameSession: (tabId: string, title: string) => void;
  claimSessionOpeningTransition: (sessionId: string, ownerId: string) => (() => void) | null;
  onClearInitialMessage: (tabId: string) => void;
  geoNavigationTarget?: GeoNavigationTarget | null;
  effectNavigationTarget?: GeoEffectNavigationTarget | null;
  effectSessionBinding?: BrandEffectSessionBinding | null;
  onOpenBrandSession?: () => void;
}

/** The complete Renderer route table: product welcome, fixed-Agent chat and brand pages. */
export const MemoizedTabContent = memo(function MemoizedTabContent({
  tab,
  brandWorkspace,
  isActive,
  onNewSession,
  onUpdateGenerating,
  onUpdateTitle,
  onUpdateUnread,
  onRenameSession,
  claimSessionOpeningTransition,
  onClearInitialMessage,
  geoNavigationTarget,
  effectNavigationTarget,
  effectSessionBinding,
  onOpenBrandSession,
}: TabContentProps) {
  const kind = tabContentKind(tab, false);
  const claim = useCallback(
    (sessionId: string) => claimSessionOpeningTransition(sessionId, tab.id),
    [claimSessionOpeningTransition, tab.id],
  );

  return (
    <div
      className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
      style={isActive ? undefined : { contentVisibility: 'hidden' }}
    >
      {kind === 'welcome' ? (
        <XiaojingWelcome />
      ) : kind === 'brand-archive' ? (
        /* 票 30：品牌级整页跟随当前选中品牌，不依赖任何 Session。 */
        <XiaojingBrandArchivePage workspace={brandWorkspace} />
      ) : kind === 'brand-effect' ? (
        /* 票 31：效果整页同为品牌级整页；三面板控制面借用该品牌已打开
           聊天 Tab 的 Session Sidecar owner 身份（见 brandEffectSessionBinding）。
           票 32：监测告警深链的精确监测计划落点也经此传入。 */
        <XiaojingGeoEffectPage
          workspace={brandWorkspace}
          sessionBinding={effectSessionBinding ?? null}
          monitorNavigationTarget={effectNavigationTarget ?? null}
          onOpenBrandSession={onOpenBrandSession ?? (() => undefined)}
        />
      ) : (
        <TabProvider
          tabId={tab.id}
          workspacePath={tab.workspacePath ?? ''}
          sessionId={tab.sessionId}
          sessionTitle={tab.title}
          isActive={isActive}
          onGeneratingChange={(value) => onUpdateGenerating(tab.id, value)}
          onTitleChange={(value) => onUpdateTitle(tab.id, value)}
          onUnreadChange={(value) => onUpdateUnread(tab.id, value)}
          claimSessionOpeningTransition={claim}
        >
          <div className="flex h-full min-w-0">
            <CurrentWorkspaceContext.Provider value={brandWorkspace}>
              <div className="min-w-0 flex-1 overflow-hidden">
                <Suspense fallback={<ChatBootOverlay />}>
                  <Chat
                    initialMessage={tab.initialMessage}
                    onInitialMessageConsumed={() => onClearInitialMessage(tab.id)}
                    onNewSession={() => onNewSession(tab.id)}
                    sessionTitle={tab.title}
                    onRenameSession={(title) => onRenameSession(tab.id, title)}
                    navigationTarget={geoNavigationTarget ?? undefined}
                  />
                </Suspense>
              </div>
            </CurrentWorkspaceContext.Provider>
            {/* 票 28：工作台仅挂载于聊天 Tab；欢迎页与品牌整页主区全宽。 */}
            <XiaojingGeoWorkbench
              currentWorkspace={brandWorkspace}
              navigationTarget={geoNavigationTarget}
            />
          </div>
        </TabProvider>
      )}
    </div>
  );
});

function workspaceForPath(workspaces: readonly BrandWorkspace[], path: string | null): BrandWorkspace | null {
  if (!path) return null;
  return workspaces.find((workspace) => workspacePathsEqual(workspace.rootPath, path)) ?? null;
}

/**
 * 账号登录门（票 06）：未登录/宽限超期 → 全屏登录页；首登未改密 →
 * 强制改密屏；其余才挂载工作台。工作台整树只在通过登录门后渲染，
 * 保证未登录时不会创建任何 Session Sidecar owner。
 */
function AccountGatedShell() {
  const ready = useAccountReady();
  const state = useAccountState();
  if (!ready || !state) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--paper)]" aria-busy="true" data-account-boot-veil>
        <ChatBootOverlay />
      </div>
    );
  }
  const gate = accountGateFor(state);
  if (gate === 'login') {
    // 仍有本地 token 但超过 7 天未接触服务器：要求重新联网登录。
    return <LoginScreen graceExpired={state.loggedIn} agreementAccepted={state.agreementAccepted} />;
  }
  if (gate === 'change-password') {
    return <ChangePasswordScreen />;
  }
  return <Workbench />;
}

export default function App() {
  return (
    <AccountProvider>
      <AccountGatedShell />
    </AccountProvider>
  );
}

function Workbench() {
  const { t } = useTranslation('app');
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const brandState = useBrandWorkspaces();
  const brandStateRef = useRef(brandState);
  brandStateRef.current = brandState;
  const [tabs, setTabsState] = useState<Tab[]>(() => [createNewTab()]);
  const tabsRef = useRef(tabs);
  const [activeTabId, setActiveTabIdState] = useState(() => tabs[0].id);
  const activeTabIdRef = useRef(activeTabId);
  const [restoreCandidate, setRestoreCandidate] = useState(() => buildRestoredTabs());
  const [geoNavigationTarget, setGeoNavigationTarget] = useState<GeoNavigationTarget | null>(null);
  const geoNavigationNonce = useRef(0);
  // 票 32：监测告警深链在「效果」整页的落点（精确监测计划 id + nonce）。
  const [effectNavigationTarget, setEffectNavigationTarget] = useState<GeoEffectNavigationTarget | null>(null);
  const effectNavigationNonce = useRef(0);
  const handledNotificationIds = useRef(new Set<string>());
  const transitions = useRef(createSessionResourceTransitionState());

  const setTabs = useCallback((update: (current: Tab[]) => Tab[]) => {
    setTabsState((current) => {
      const next = update(current);
      tabsRef.current = next;
      return next;
    });
  }, []);
  const setActiveTabId = useCallback((id: string) => {
    activeTabIdRef.current = id;
    setActiveTabIdState(id);
  }, []);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [activeTabId, tabs],
  );

  useEffect(() => {
    if (!restoreCandidate) saveOpenTabs(tabs, activeTabId);
  }, [activeTabId, restoreCandidate, tabs]);

  const claimSessionOpeningTransition = useCallback((sessionId: string, ownerId: string) => (
    tryClaimSessionResourceTransition(transitions.current, sessionId, 'opening', ownerId)
  ), []);

  const selectTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    // 用户主动选中「效果」页意味着放弃旧的监测深链落点，恢复 latest 视图。
    if (tab.view === 'brand-effect') setEffectNavigationTarget(null);
    setActiveTabId(tabId);
    if (tab.sessionId) void reconcileSessionTabActivation(tab.sessionId, tab.id);
    if (tab.hasUnread) {
      setTabs((current) => current.map((candidate) => (
        candidate.id === tabId ? { ...candidate, hasUnread: false } : candidate
      )));
    }
  }, [setActiveTabId, setTabs]);

  const mountSession = useCallback(async (args: {
    sessionId: string;
    workspacePath: string;
    title: string;
    initialMessage?: InitialMessage;
    tabId?: string;
  }): Promise<boolean> => {
    const existing = tabsRef.current.find((tab) => tab.view === 'chat' && tab.sessionId === args.sessionId);
    if (existing) {
      selectTab(existing.id);
      return true;
    }
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.warning(t('tabs.maxTabsReached', { count: MAX_TABS }));
      return false;
    }

    const shell = createNewTab();
    const tabId = args.tabId ?? shell.id;
    const release = claimSessionOpeningTransition(args.sessionId, tabId);
    if (!release) return false;
    try {
      await ensureSessionSidecar(args.sessionId, args.workspacePath, 'tab', tabId);
      const tab = buildChatFlipPatch({ ...shell, id: tabId }, {
        workspacePath: args.workspacePath,
        sessionId: args.sessionId,
        title: args.title,
        initialMessage: args.initialMessage,
      });
      setTabs((current) => [...current, tab]);
      setActiveTabId(tabId);
      await reconcileSessionTabActivation(args.sessionId, tabId);
      return true;
    } catch (error) {
      console.error(`[App] Failed to open Session ${args.sessionId}:`, error);
      toastRef.current.error(t('errors.sessionOpenFailed'));
      return false;
    } finally {
      release();
    }
  }, [claimSessionOpeningTransition, selectTab, setActiveTabId, setTabs, t]);

  const openWorkspace = useCallback(async (
    workspace: BrandWorkspace,
    initialMessage?: InitialMessage,
  ): Promise<boolean> => {
    try {
      const session = await createSession(workspace.rootPath, workspace.name);
      const opened = await mountSession({
        sessionId: session.id,
        workspacePath: workspace.rootPath,
        title: workspace.name,
        initialMessage,
      });
      if (opened) await brandStateRef.current.commitSession(workspace.id, session.id, workspace.name, 'default');
      return opened;
    } catch (error) {
      console.error('[App] Failed to create Session:', error);
      toastRef.current.error(t('errors.sessionCreateFailed'));
      return false;
    }
  }, [mountSession, t]);

  const openBrandSession = useCallback((session: BrandSession, workspace: BrandWorkspace) => (
    mountSession({ sessionId: session.id, workspacePath: workspace.rootPath, title: session.title })
  ), [mountSession]);

  const updateTab = useCallback((tabId: string, patch: Partial<Tab>) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
  }, [setTabs]);

  const renameSession = useCallback((tabId: string, title: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab?.sessionId || !tab.workspacePath) return;
    updateTab(tabId, { title });
    void updateSession(tab.sessionId, { title, titleSource: 'user' });
    const workspace = workspaceForPath(brandStateRef.current.workspaces, tab.workspacePath);
    if (workspace) void brandStateRef.current.renameSession(workspace.id, tab.sessionId, title);
  }, [updateTab]);

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const index = tabsRef.current.findIndex((candidate) => candidate.id === tabId);
    const remaining = tabsRef.current.filter((candidate) => candidate.id !== tabId);
    const next = remaining.length ? remaining : [createNewTab()];
    setTabs(() => next);
    if (activeTabIdRef.current === tabId) setActiveTabId(next[Math.min(index, next.length - 1)].id);
    if (tab.view === 'chat' && tab.sessionId) {
      void (async () => {
        await startBackgroundCompletion(tab.sessionId!);
        await stopSseProxy(tab.id);
        await releaseTabSession(tab.sessionId!, tab.id);
      })();
    }
  }, [setActiveTabId, setTabs]);

  // 票 30：品牌级一级导航入口。整页跟随当前选中品牌（渲染时取
  // brandState.currentWorkspace），tab 本身不携带 workspace/session 身份。
  const openBrandArchive = useCallback(() => {
    const existing = tabsRef.current.find((tab) => tab.view === 'brand-archive');
    if (existing) return selectTab(existing.id);
    if (tabsRef.current.length >= MAX_TABS) return;
    const tab = { ...createNewTab(), view: 'brand-archive' as const, title: t('tabs.brandArchive') };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
  }, [selectTab, setActiveTabId, setTabs, t]);

  // 票 31：「效果」复用同一品牌级一级导航机制（单例整页 tab）。返回是否
  // 成功选中/创建效果 tab；用户主动进入时丢弃未消费的监测深链落点。
  const openBrandEffect = useCallback((): boolean => {
    setEffectNavigationTarget(null);
    const existing = tabsRef.current.find((tab) => tab.view === 'brand-effect');
    if (existing) {
      selectTab(existing.id);
      return true;
    }
    if (tabsRef.current.length >= MAX_TABS) return false;
    const tab = { ...createNewTab(), view: 'brand-effect' as const, title: t('tabs.brandEffect') };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    return true;
  }, [selectTab, setActiveTabId, setTabs, t]);

  // 票 31：效果整页不新建 Sidecar owner——借用该品牌第一个已打开聊天 Tab
  // 的 Session（读取/控制 authority）；该 Tab 关闭后绑定自动消失，页面回落
  // 到「先打开会话」引导。绑定对象只依赖基本类型（sessionId/ownerTabId），
  // 标题/生成状态等无关 Tab 变化不得改变其身份（react_stability_rules 5）。
  const [effectSessionId, effectOwnerTabId] = useMemo(() => {
    const workspace = brandState.currentWorkspace;
    if (!workspace) return [null, null] as const;
    const chatTab = tabs.find((tab) => (
      tab.view === 'chat'
      && tab.sessionId
      && !isPendingSessionId(tab.sessionId)
      && workspacePathsEqual(tab.workspacePath, workspace.rootPath)
    ));
    return chatTab?.sessionId
      ? [chatTab.sessionId, chatTab.id] as const
      : [null, null] as const;
  }, [brandState.currentWorkspace, tabs]);
  const brandEffectSessionBinding = useMemo<BrandEffectSessionBinding | null>(
    () => (
      effectSessionId && effectOwnerTabId
        ? { sessionId: effectSessionId, ownerTabId: effectOwnerTabId }
        : null
    ),
    [effectOwnerTabId, effectSessionId],
  );

  // 效果页引导按钮：优先复用该品牌最近的既有会话，没有才新建，避免产生
  // 幽灵会话。
  const openBrandEffectSession = useCallback(() => {
    const workspace = brandStateRef.current.currentWorkspace;
    if (!workspace) return;
    const session = brandStateRef.current.sessions[0];
    if (session) void openBrandSession(session, workspace);
    else void openWorkspace(workspace);
  }, [openBrandSession, openWorkspace]);

  useWindowLifecycle({
    onCmdWCloseTab: () => closeTab(activeTabIdRef.current),
    onExitRequested: async () => true,
  });

  const deleteSession = useCallback(async (sessionId: string, preview?: BrandSessionDeletionPreview) => {
    const release = tryClaimSessionResourceTransition(transitions.current, sessionId, 'deleting');
    if (!release) return { deleted: false, reason: 'transition-in-progress' as const };
    try {
      return await deleteSessionThroughAppOwner({
        sessionId,
        getTabs: () => tabsRef.current,
        hasPersistentOwners: sessionHasPersistentOwners,
        handoffMountedSessionActivity: startBackgroundCompletionForDeletion,
        stopSseProxy,
        terminateTabsForSession: (target) => {
          const remaining = tabsRef.current.filter((tab) => tab.sessionId !== target);
          const next = remaining.length ? remaining : [createNewTab()];
          setTabs(() => next);
          if (!next.some((tab) => tab.id === activeTabIdRef.current)) setActiveTabId(next[0].id);
        },
        deletePersistedSession: (target, releasableTabIds) => removeSession(
          target,
          releasableTabIds,
          preview ? { workspaceId: preview.workspaceId, confirmationToken: preview.confirmationToken } : undefined,
        ),
      });
    } finally {
      release();
    }
  }, [setActiveTabId, setTabs]);

  /**
   * 品牌删除是 App-owned 生命周期迁移：对品牌全部 Session 申请 deleting
   * transition，把可释放 Tab 交给 Rust 在同一 fence 内校验并释放，
   * 成功后卸载这些 Session 的挂载面并按后端权威刷新 current 品牌。
   */
  const deleteBrand = useCallback(async (preview: BrandWorkspaceDeletionPreview): Promise<SessionDeleteResult> => {
    const sessionSet = new Set(preview.sessionIds);
    const releases = preview.sessionIds
      .map((sessionId) => tryClaimSessionResourceTransition(transitions.current, sessionId, 'deleting'))
      .filter((release): release is () => void => release !== null);
    if (releases.length !== preview.sessionIds.length) {
      releases.forEach((release) => release());
      return { deleted: false, reason: 'transition-in-progress' };
    }
    try {
      const ownerTabs = tabsRef.current
        .filter((tab) => tab.view === 'chat' && tab.sessionId && sessionSet.has(tab.sessionId))
        .map((tab) => ({ sessionId: tab.sessionId!, tabId: tab.id }));
      const result = await deleteBrandWorkspace(
        preview.workspaceId,
        preview.confirmationToken,
        ownerTabs,
      );
      if (!result.deleted) return result;

      const removedTabIds = ownerTabs.map((tab) => tab.tabId);
      const remaining = tabsRef.current.filter((tab) => !tab.sessionId || !sessionSet.has(tab.sessionId));
      const next = remaining.length ? remaining : [createNewTab()];
      setTabs(() => next);
      if (!next.some((tab) => tab.id === activeTabIdRef.current)) setActiveTabId(next[0].id);
      await Promise.allSettled(removedTabIds.map(async (tabId) => {
        try {
          await stopSseProxy(tabId);
        } catch (error) {
          console.warn(`[brand-delete] Failed to stop SSE proxy for Tab ${tabId}:`, error);
        }
      }));
      await brandStateRef.current.refreshBootstrap();
      return { deleted: true };
    } finally {
      releases.forEach((release) => release());
    }
  }, [setActiveTabId, setTabs]);

  const restoreTabs = useCallback(async () => {
    if (!restoreCandidate) return;
    for (const tab of restoreCandidate.tabs) {
      if (!tab.sessionId || !tab.workspacePath || !await canRestoreSession(tab.sessionId, tab.workspacePath)) continue;
      await mountSession({ sessionId: tab.sessionId, workspacePath: tab.workspacePath, title: tab.title, tabId: tab.id });
    }
    setRestoreCandidate(null);
  }, [mountSession, restoreCandidate]);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const controller = new AbortController();
    const handleClick = async (payload: NotificationClickPayload) => {
      const route = resolveNotificationClickRoute(payload, (tabId, sessionId) => {
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        return Boolean(tab && (!sessionId || tab.sessionId === sessionId));
      });
      if (route.type === 'select-tab') return selectTab(route.tabId);
      if (route.type === 'open-session') {
        await mountSession({
          sessionId: route.sessionId,
          workspacePath: route.workspacePath,
          title: t('notifications.geoSessionTitle'),
        });
        return;
      }
      if (route.type !== 'open-geo') return;
      if (route.notificationId) {
        if (handledNotificationIds.current.has(route.notificationId)) return;
        handledNotificationIds.current.add(route.notificationId);
      }
      const resolution = await resolveGeoNotificationLocator(route.locator);
      if (resolution.status !== 'exact' || !resolution.workspace || !resolution.locator) {
        toastRef.current.info(resolution.message ?? t('notifications.geoTargetUnavailable'));
        // 失效目标不替换成相似对象；品牌仍存在时只回到该品牌的安全入口。
        if (
          resolution.workspace
          && brandStateRef.current.currentWorkspace?.id !== resolution.workspace.id
        ) {
          await brandStateRef.current.switchWorkspace(resolution.workspace.id);
        }
        return;
      }
      if (brandStateRef.current.currentWorkspace?.id !== resolution.workspace.id) {
        await brandStateRef.current.switchWorkspace(resolution.workspace.id);
      }
      const opened = await mountSession({
        sessionId: resolution.locator.sessionId,
        workspacePath: resolution.workspace.rootPath,
        title: resolution.sessionTitle ?? t('notifications.geoSessionTitle'),
      });
      if (!opened) return;
      if (route.landing === 'effect-monitor') {
        // 票 32：监测告警落到「效果」整页的具体监测计划 run 视图。会话
        // 照常恢复——效果页控制面借用该品牌已打开聊天 Tab 的 Session 身份。
        // openBrandEffect 会先清空旧落点，这里随后写入本次落点（批量更新，
        // 最终状态即本次落点）；tab 已满时如实提示，不静默改降落点。
        if (!openBrandEffect()) {
          toastRef.current.warning(t('tabs.maxTabsReached', { count: MAX_TABS }));
          return;
        }
        setEffectNavigationTarget({
          workspaceId: resolution.workspace.id,
          planId: resolution.locator.artifact.id,
          nonce: ++effectNavigationNonce.current,
        });
        return;
      }
      setGeoNavigationTarget({ ...resolution.locator, nonce: ++geoNavigationNonce.current });
    };
    void (async () => {
      await listenWithCleanup<NotificationClickPayload>(
        'notification:click',
        (event) => void handleClick(event.payload),
        controller.signal,
      );
      const pending = await notificationClickListenerReady();
      if (pending && !controller.signal.aborted) await handleClick(pending);
    })();
    return () => controller.abort();
  }, [mountSession, openBrandEffect, selectTab, t]);

  return (
    <SessionDeletionContext.Provider value={(sessionId) => deleteSession(sessionId)}>
      <LinkContextMenuProvider>
        <div className="xiaojing-product-shell flex h-screen bg-[var(--paper)]">
          <XiaojingSidebar
            brandState={brandState}
            activeTab={activeTab}
            onOpenWorkspace={openWorkspace}
            onOpenSession={openBrandSession}
            onRenameSession={async (session, workspace, title) => {
              await brandState.renameSession(workspace.id, session.id, title);
              const tab = tabsRef.current.find((candidate) => candidate.sessionId === session.id);
              if (tab) updateTab(tab.id, { title });
            }}
            onDeleteSession={async (preview) => deleteSession(preview.sessionId, preview)}
            onDeleteBrand={deleteBrand}
            onOpenBrandArchive={openBrandArchive}
            onOpenBrandEffect={openBrandEffect}
          />
          <div className="flex min-w-0 flex-1 flex-col" data-tab-workspace>
            <CustomTitleBar
              restoreCount={restoreCandidate?.tabs.length ?? 0}
              onRestoreSession={() => void restoreTabs()}
              onDismissRestore={() => setRestoreCandidate(null)}
            >
              <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onSelectTab={selectTab}
                onCloseTab={closeTab}
                onNewTab={() => {
                  if (tabsRef.current.length >= MAX_TABS) return;
                  const tab = createNewTab();
                  setTabs((current) => [...current, tab]);
                  setActiveTabId(tab.id);
                }}
                onReorderTabs={(activeId, overId) => setTabs((current) => {
                  const from = current.findIndex((tab) => tab.id === activeId);
                  const to = current.findIndex((tab) => tab.id === overId);
                  return from < 0 || to < 0 ? current : arrayMove(current, from, to);
                })}
              />
            </CustomTitleBar>
            <div className="flex min-h-0 flex-1">
              <div className="relative min-w-0 flex-1 overflow-hidden" data-tab-content-workspace>
                {tabs.map((tab) => (
                  <MemoizedTabContent
                    key={tab.id}
                    tab={tab}
                    brandWorkspace={
                      tab.view === 'chat'
                        ? workspaceForPath(brandState.workspaces, tab.workspacePath)
                        : tab.view === 'brand-archive' || tab.view === 'brand-effect'
                          ? brandState.currentWorkspace
                          : null
                    }
                    isActive={tab.id === activeTabId}
                    onNewSession={async (tabId) => {
                      const source = tabsRef.current.find((candidate) => candidate.id === tabId);
                      const workspace = workspaceForPath(brandStateRef.current.workspaces, source?.workspacePath ?? null);
                      return workspace ? openWorkspace(workspace) : false;
                    }}
                    onUpdateGenerating={(tabId, value) => updateTab(tabId, { isGenerating: value })}
                    onUpdateTitle={(tabId, title) => updateTab(tabId, { title })}
                    onUpdateUnread={(tabId, value) => updateTab(tabId, { hasUnread: value })}
                    onRenameSession={renameSession}
                    claimSessionOpeningTransition={claimSessionOpeningTransition}
                    onClearInitialMessage={(tabId) => updateTab(tabId, { initialMessage: undefined })}
                    geoNavigationTarget={tab.sessionId === geoNavigationTarget?.sessionId ? geoNavigationTarget : null}
                    effectNavigationTarget={
                      tab.view === 'brand-effect'
                      && effectNavigationTarget?.workspaceId === brandState.currentWorkspace?.id
                        ? effectNavigationTarget
                        : null
                    }
                    effectSessionBinding={tab.view === 'brand-effect' ? brandEffectSessionBinding : null}
                    onOpenBrandSession={tab.view === 'brand-effect' ? openBrandEffectSession : undefined}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </LinkContextMenuProvider>
    </SessionDeletionContext.Provider>
  );
}
