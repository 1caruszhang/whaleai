import {
  ChevronDown,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import type { SessionMetadata } from "@/api/sessionClient";
import xiaojingLogo from "@/assets/brand/xiaojing-logo.png";
import { useConfig } from "@/hooks/useConfig";
import { useGlobalSidebarTaskCenterData } from "@/hooks/useTaskCenterData";
import type { Project } from "@/config/types";
import { isProjectActiveForUser, isProjectVisibleToUser } from "@/config/types";
import type { InitialMessage, Tab } from "@/types/tab";
import { getSessionDisplayText } from "@/utils/sessionDisplay";
import {
  normalizeWorkspacePathIdentity,
  workspacePathsEqual,
} from "../../../shared/workspacePath";
import { isAutomationHistoryOrigin } from "../../../shared/session-origin";
import { XIAOJING_PRODUCT } from "../../../shared/product";

interface XiaojingSidebarProps {
  tabs: readonly Tab[];
  activeTab: Tab | undefined;
  activeWorkspacePath: string | null;
  onNewTab: () => void;
  onOpenWorkspace: (
    project: Project,
    initialMessage?: InitialMessage,
    entryIntent?: "open_workspace" | "workspace_init",
  ) => Promise<boolean>;
  onOpenSession: (
    session: SessionMetadata,
    project: Project,
  ) => Promise<boolean>;
}

function brandName(project: Project): string {
  return project.displayName?.trim() || project.name;
}

export default memo(function XiaojingSidebar({
  tabs,
  activeTab,
  activeWorkspacePath,
  onNewTab,
  onOpenWorkspace,
  onOpenSession,
}: XiaojingSidebarProps) {
  const { config, projects, isLoading } = useConfig();
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  const brands = useMemo(
    () =>
      projects.filter(isProjectVisibleToUser).filter(isProjectActiveForUser),
    [projects],
  );
  const currentBrand = useMemo(
    () =>
      brands.find(
        (project) =>
          activeWorkspacePath &&
          workspacePathsEqual(project.path, activeWorkspacePath),
      ) ??
      brands.find(
        (project) =>
          config.defaultWorkspacePath &&
          workspacePathsEqual(project.path, config.defaultWorkspacePath),
      ) ??
      brands[0] ??
      null,
    [activeWorkspacePath, brands, config.defaultWorkspacePath],
  );

  const sessionWorkspacePaths = useMemo(
    () => (currentBrand ? [currentBrand.path] : []),
    [currentBrand],
  );
  const taskData = useGlobalSidebarTaskCenterData(sessionWorkspacePaths, false);
  const sessions = useMemo(() => {
    if (!currentBrand) return [];
    const brandKey = normalizeWorkspacePathIdentity(currentBrand.path);
    return taskData.sessions
      .filter(
        (session) =>
          normalizeWorkspacePathIdentity(session.agentDir) === brandKey,
      )
      .filter(
        (session) =>
          !isAutomationHistoryOrigin(session.origin, {
            cronTaskId: session.cronTaskId,
            source: session.source,
          }),
      )
      .slice(0, 12);
  }, [currentBrand, taskData.sessions]);
  const tabBySession = useMemo(
    () =>
      new Map(
        tabs.filter((tab) => tab.sessionId).map((tab) => [tab.sessionId!, tab]),
      ),
    [tabs],
  );

  const openBrand = useCallback(
    async (brand: Project) => {
      if (opening) return;
      setBrandMenuOpen(false);
      setOpening(true);
      try {
        await onOpenWorkspace(brand);
      } finally {
        setOpening(false);
      }
    },
    [onOpenWorkspace, opening],
  );

  const startSession = useCallback(() => {
    if (currentBrand) void openBrand(currentBrand);
    else onNewTab();
  }, [currentBrand, onNewTab, openBrand]);

  return (
    <aside
      aria-label="小鲸同学品牌与会话"
      className="relative z-40 flex h-screen w-[248px] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--global-sidebar-bg)] text-[var(--ink)]"
      data-xiaojing-sidebar
    >
      <div className="custom-titlebar h-11 shrink-0" data-tauri-drag-region />

      <div className="flex items-center gap-3 px-4 pb-5 pt-2">
        <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-white shadow-sm">
          <img src={xiaojingLogo} alt="" className="h-9 w-9 object-contain" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-wide">
            {XIAOJING_PRODUCT.displayName}
          </p>
          <p className="mt-0.5 text-xs font-medium uppercase tracking-[0.18em] text-[var(--accent)]">
            GEO 营销
          </p>
        </div>
      </div>

      <div className="px-3">
        <p className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
          当前品牌
        </p>
        <div className="relative">
          <button
            type="button"
            onClick={() => setBrandMenuOpen((value) => !value)}
            aria-expanded={brandMenuOpen}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-3 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-sm font-semibold text-[var(--accent)]">
              {currentBrand ? brandName(currentBrand).slice(0, 1) : "鲸"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {currentBrand ? brandName(currentBrand) : "尚未创建品牌"}
              </span>
              <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                {currentBrand ? "品牌工作区" : "从品牌入口开始"}
              </span>
            </span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-[var(--ink-muted)] transition-transform ${brandMenuOpen ? "rotate-180" : ""}`}
            />
          </button>
          {brandMenuOpen && brands.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-56 overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
              {brands.map((brand) => (
                <button
                  key={brand.id}
                  type="button"
                  onClick={() => {
                    void openBrand(brand);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--accent-warm-subtle)] text-xs text-[var(--accent)]">
                    {brandName(brand).slice(0, 1)}
                  </span>
                  <span className="truncate">{brandName(brand)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => currentBrand && void openBrand(currentBrand)}
          disabled={!currentBrand || opening}
          className="mt-3 flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
        >
          <LayoutDashboard className="h-4 w-4" />
          <span>品牌概览</span>
        </button>
        <button
          type="button"
          onClick={startSession}
          disabled={opening}
          className="mt-1 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-60"
        >
          {opening ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MessageSquarePlus className="h-4 w-4" />
          )}
          新建会话
        </button>
      </div>

      <section
        className="mt-6 flex min-h-0 flex-1 flex-col"
        aria-label="Session 列表"
      >
        <div className="flex items-center justify-between px-4 pb-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ink-muted)]">
            会话
          </h2>
          <span className="text-xs tabular-nums text-[var(--ink-subtle)]">
            {sessions.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {isLoading ||
          (taskData.isSessionsLoading && sessions.length === 0) ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--ink-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在加载会话
            </div>
          ) : sessions.length === 0 ? (
            <div className="mx-2 rounded-xl border border-dashed border-[var(--line)] px-3 py-5 text-center">
              <MessagesSquare className="mx-auto h-5 w-5 text-[var(--ink-subtle)]" />
              <p className="mt-2 text-xs text-[var(--ink-muted)]">
                这个品牌还没有会话
              </p>
            </div>
          ) : (
            sessions.map((session) => {
              const tab = tabBySession.get(session.id);
              const active =
                activeTab?.view === "chat" &&
                activeTab.sessionId === session.id;
              return (
                <button
                  key={session.id}
                  type="button"
                  onClick={() =>
                    currentBrand && void onOpenSession(session, currentBrand)
                  }
                  aria-current={active ? "page" : undefined}
                  className={`group mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                    active
                      ? "bg-[var(--accent-warm-subtle)] text-[var(--ink)]"
                      : "text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${tab?.isGenerating ? "animate-pulse bg-[var(--accent)]" : active ? "bg-[var(--accent)]" : "bg-[var(--ink-faint)]"}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {getSessionDisplayText(session)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>

      <div className="border-t border-[var(--line-subtle)] px-4 py-3 text-xs tracking-wide text-[var(--ink-subtle)]">
        小鲸同学 · 本地品牌工作台
      </div>
    </aside>
  );
});
