import { FileText, Gauge, MessageSquarePlus } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

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
import XiaojingGeoEffectReport from "./XiaojingGeoEffectReport";

/** The control-plane identity the effects panels borrow: the brand's first
 *  open chat tab owns the Session Sidecar, so its (sessionId, tabId) is the
 *  only existing read/control authority the page can ride without creating
 *  new Sidecar owner tokens. Null while no chat tab of this brand is open —
 *  projection reads then stay available via Rust IPC; only provider-side
 *  execution (baseline probes, monitor prepare/activate) waits for a session. */
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

/**
 * 品牌级「效果」整页的 Session 控制面作用域。有绑定时提供借用聊天 Tab
 * 的真实 HTTP API；无绑定时提供 sessionId=null 的分离作用域——面板的
 * 投影读取走 Rust IPC 不经这里，仍需会话的执行类调用会得到明确错误，
 * 聊天生命周期字段保持惰性，效果页绝不挂载聊天流。
 */
function EffectSessionScope({
  workspace,
  binding,
  children,
}: {
  workspace: BrandWorkspace;
  binding: BrandEffectSessionBinding | null;
  children: React.ReactNode;
}) {
  const request = useCallback(
    async <T,>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<T> => {
      if (!binding) {
        throw new Error("geo_effect_session_required");
      }
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
      if (response.ok) return await response.json() as T;
      const payload = await response.json().catch(() => ({})) as { error?: unknown };
      throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
    },
    [binding],
  );

  const api = useMemo<TabApiContextValue>(
    () => ({
      tabId: binding?.ownerTabId ?? "geo-effect-detached",
      workspacePath: workspace.rootPath,
      sessionId: binding?.sessionId ?? null,
      apiGet: (path, options) => request("GET", path, undefined, options),
      apiPost: (path, body, options) => request("POST", path, body, options),
      apiPut: (path, body, options) => request("PUT", path, body, options),
      apiDelete: (path, options) => request("DELETE", path, undefined, options),
    }),
    [binding?.ownerTabId, binding?.sessionId, request, workspace.rootPath],
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
 * 「效果」一级入口整页（票 31 + 2026-08-19 拍板）：效果看板置顶，发布后
 * 监测与基线面板随其后；整页采用 js_ai 风格的 scoped 深色主题（变量见
 * index.css 的 .geo-dash-scope）。页面是品牌级投影，真实数据读取走 Rust
 * IPC，无需先打开会话即可看到完整监测画面（含空态骨架）；基线探测与监测
 * 启用等执行类操作仍借用该品牌已打开聊天 Tab 的 Session Sidecar owner
 * 身份，未打开时以顶部提示条引导，不伪造数据也不新建第二个 Agent 入口。
 * 票 32：监测告警通知深链落在本页的精确监测计划 run 视图
 * （monitorNavigationTarget），不落到聊天或工作台。
 */
export default memo(function XiaojingGeoEffectPage({
  workspace,
  sessionBinding,
  monitorNavigationTarget = null,
  onOpenBrandSession,
}: Props) {
  // 「报告视图」：一页纸排版 + @media print 浅色化，给客户/老板直接打印。
  const [reportMode, setReportMode] = useState(false);
  if (!workspace) {
    return (
      <main
        className="geo-dash-scope flex h-full items-center justify-center overflow-y-auto bg-[var(--geo-dash-bg)] px-8 py-12"
        data-xiaojing-geo-effect="empty"
      >
        <div className="w-full max-w-xl rounded-2xl border border-dashed border-[var(--geo-dash-border-strong)] p-8 text-center">
          <Gauge className="mx-auto h-6 w-6 text-[var(--geo-dash-secondary)]" />
          <h1 className="mt-3 text-base font-semibold text-[var(--geo-dash-text)]">效果</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--geo-dash-text-mute)]">
            先在左侧选择品牌，即可查看真实效果看板、按需执行基线探测并管理发布后监测。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      className="geo-dash-scope h-full overflow-y-auto bg-[var(--geo-dash-bg)] px-8 py-10"
      data-xiaojing-geo-effect={workspace.id}
    >
      <div className="mx-auto w-full max-w-6xl">
        <header>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card)]">
                <Gauge className="h-5 w-5 text-[var(--geo-dash-secondary)]" />
              </span>
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-[var(--geo-dash-text)]">效果</h1>
                <p className="mt-0.5 text-sm text-[var(--geo-dash-text-mute)]">
                  当前品牌：{workspace.name}
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-pressed={reportMode}
              onClick={() => setReportMode((value) => !value)}
              className="geo-effect-no-print inline-flex items-center gap-2 rounded-lg border border-[var(--geo-dash-border-strong)] bg-[var(--geo-dash-card-2)] px-3 py-1.5 text-xs font-medium text-[var(--geo-dash-text-dim)] transition-colors hover:border-[var(--geo-dash-secondary)] hover:text-[var(--geo-dash-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--geo-dash-secondary)]"
            >
              <FileText className="h-3.5 w-3.5" />
              {reportMode ? "返回看板" : "报告视图"}
            </button>
          </div>
        </header>

        {reportMode ? (
          <XiaojingGeoEffectReport workspace={workspace} />
        ) : (
          <>
            {!sessionBinding && (
              <section
                aria-label="需要品牌会话"
                data-geo-effect-session-banner
                className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--geo-dash-border)] bg-[var(--geo-dash-card)] px-4 py-3"
              >
                <p className="text-xs leading-5 text-[var(--geo-dash-text-dim)]">
                  看板与监测结果已按真实数据显示。基线探测与监测计划的执行需要该品牌的真实会话。
                </p>
                <button
                  type="button"
                  onClick={onOpenBrandSession}
                  className="inline-flex items-center gap-2 rounded-lg border border-[var(--geo-dash-border-strong)] bg-[var(--geo-dash-card-2)] px-3 py-1.5 text-xs font-medium text-[var(--geo-dash-text-dim)] transition-colors hover:border-[var(--geo-dash-secondary)] hover:text-[var(--geo-dash-secondary)]"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  打开品牌会话
                </button>
              </section>
            )}

            <EffectSessionScope workspace={workspace} binding={sessionBinding}>
              <XiaojingGeoEffectPanel
                key={`${workspace.id}:geo-effect`}
                workspaceId={workspace.id}
                monitorNavigationTarget={monitorNavigationTarget}
              />
            </EffectSessionScope>
          </>
        )}
      </div>
    </main>
  );
});
