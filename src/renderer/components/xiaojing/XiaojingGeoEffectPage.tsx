import { Gauge, MessageSquarePlus } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import { sessionSidecarFetch } from "@/api/tauriClient";
import {
  TabApiContext,
  TabContext,
  type TabApiContextValue,
  type TabContextValue,
} from "@/context/TabContext";
import type { GeoEffectNavigationTarget } from "../../../shared/geo/notification";
import XiaojingGeoEffectPanel from "./XiaojingGeoEffectPanel";

/** The control-plane identity the effects panels borrow: the brand's first
 *  open chat tab owns the Session Sidecar, so its (sessionId, tabId) is the
 *  only existing read/control authority the page can ride without creating
 *  new Sidecar owner tokens. Null while no chat tab of this brand is open. */
export interface BrandEffectSessionBinding {
  sessionId: string;
  ownerTabId: string;
}

interface Props {
  workspace: BrandWorkspace | null;
  sessionBinding: BrandEffectSessionBinding | null;
  /** 监测告警通知深链的落点（票 32）：精确监测计划 id + nonce。 */
  monitorNavigationTarget?: GeoEffectNavigationTarget | null;
  onOpenBrandSession: () => void;
}

async function handleApiResponse<T>(response: Response): Promise<T> {
  if (response.ok) return await response.json() as T;
  const body = await response.json().catch(() => ({})) as { error?: unknown };
  throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
}

/**
 * 品牌级「效果」整页的 Session 控制面作用域：只提供效果三面板真正消费的
 * 身份（sessionId）与 HTTP API，全部经被借用聊天 Tab 的 Sidecar owner 身份
 * 转发；聊天生命周期字段保持惰性，效果页绝不挂载聊天流。
 */
function EffectSessionScope({
  workspace,
  binding,
  children,
}: {
  workspace: BrandWorkspace;
  binding: BrandEffectSessionBinding;
  children: React.ReactNode;
}) {
  const request = useCallback(
    async <T,>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<T> => {
      const response = await sessionSidecarFetch(
        binding.sessionId,
        { type: "tab", id: binding.ownerTabId },
        path,
        {
          method,
          headers: {
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            "X-Xiaojing-Tab-Id": binding.ownerTabId,
            "X-Xiaojing-Session-Id": binding.sessionId,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: options?.signal,
        },
      );
      return handleApiResponse<T>(response);
    },
    [binding.ownerTabId, binding.sessionId],
  );

  const api = useMemo<TabApiContextValue>(
    () => ({
      tabId: binding.ownerTabId,
      workspacePath: workspace.rootPath,
      sessionId: binding.sessionId,
      apiGet: (path, options) => request("GET", path, undefined, options),
      apiPost: (path, body, options) => request("POST", path, body, options),
      apiPut: (path, body, options) => request("PUT", path, body, options),
      apiDelete: (path, options) => request("DELETE", path, undefined, options),
    }),
    [binding.ownerTabId, binding.sessionId, request, workspace.rootPath],
  );

  const state = useMemo<TabContextValue>(
    () => ({
      ...api,
      messages: [],
      streamingMessage: null,
      isLoading: false,
      isSessionLoading: false,
      sessionRestoreError: null,
      sessionState: "idle",
      isConnected: false,
      agentError: null,
      setAgentError: () => undefined,
      systemNotice: null,
      setSystemNotice: () => undefined,
      pendingAskUserQuestion: null,
      toolCompleteCount: 0,
      sendMessage: async () => false,
      stopResponse: async () => ({ success: false, alreadyStopped: true }),
      retryCurrentSessionRestore: async () => ({ restored: false }),
      respondAskUserQuestion: async () => undefined,
    }),
    [api],
  );

  return (
    <TabContext.Provider value={state}>
      <TabApiContext.Provider value={api}>{children}</TabApiContext.Provider>
    </TabContext.Provider>
  );
}

/**
 * 「效果」一级入口整页（票 31）：按需基线探测、监测计划管理与真实证据
 * 看板三面板原样搬迁，信息结构不重组。页面本身是品牌级投影，跟随当前
 * 选中品牌、不携带 Session 身份；三面板的控制面请求借用该品牌已打开
 * 聊天 Tab 的 Session Sidecar owner 身份——没有已打开会话时如实引导先
 * 打开会话，不伪造数据也不新建第二个 Agent 入口。
 * 票 32：监测告警通知深链落在本页的精确监测计划 run 视图
 * （monitorNavigationTarget），不落到聊天或工作台。
 */
export default memo(function XiaojingGeoEffectPage({
  workspace,
  sessionBinding,
  monitorNavigationTarget = null,
  onOpenBrandSession,
}: Props) {
  if (!workspace) {
    return (
      <main
        className="flex h-full items-center justify-center overflow-y-auto bg-[var(--paper)] px-8 py-12 text-[var(--ink)]"
        data-xiaojing-geo-effect="empty"
      >
        <div className="w-full max-w-xl rounded-2xl border border-dashed border-[var(--line)] p-8 text-center">
          <Gauge className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <h1 className="mt-3 text-base font-semibold">效果</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            先在左侧选择品牌，即可按需执行基线探测、管理发布后监测并查看真实效果看板。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      className="h-full overflow-y-auto bg-[var(--paper)] px-8 py-10 text-[var(--ink)]"
      data-xiaojing-geo-effect={workspace.id}
    >
      <div className="mx-auto w-full max-w-4xl">
        <header>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
              <Gauge className="h-5 w-5 text-[var(--accent)]" />
            </span>
            <div>
              <h1 className="text-xl font-semibold">效果</h1>
              <p className="mt-0.5 text-sm text-[var(--ink-muted)]">
                当前品牌：{workspace.name}
              </p>
            </div>
          </div>
        </header>

        {sessionBinding ? (
          <EffectSessionScope workspace={workspace} binding={sessionBinding}>
            <XiaojingGeoEffectPanel
              key={`${workspace.id}:geo-effect`}
              workspaceId={workspace.id}
              monitorNavigationTarget={monitorNavigationTarget}
            />
          </EffectSessionScope>
        ) : (
          <section
            aria-label="需要品牌会话"
            className="mt-6 rounded-2xl border border-dashed border-[var(--line)] p-6"
          >
            <h2 className="text-sm font-semibold">先打开该品牌的会话</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
              基线探测与监测计划在该品牌的真实会话上执行，真实证据也由会话控制面读取。
              打开会话后回到本页，即可按需执行基线探测、管理发布后监测并查看真实效果看板。
            </p>
            <button
              type="button"
              onClick={onOpenBrandSession}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
            >
              <MessageSquarePlus className="h-4 w-4" />
              打开品牌会话
            </button>
          </section>
        )}
      </div>
    </main>
  );
});
