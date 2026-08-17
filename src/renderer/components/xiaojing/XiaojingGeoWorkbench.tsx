import { BarChart3, ChevronLeft, ChevronRight, Gauge } from "lucide-react";
import { memo, useCallback, useState } from "react";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import type { GeoNavigationTarget } from "../../../shared/geo/notification";
import XiaojingBrandHistoryPanel from "./XiaojingBrandHistoryPanel";
import XiaojingBrandKnowledgePanel from "./XiaojingBrandKnowledgePanel";
import XiaojingGeoEffectPanel from "./XiaojingGeoEffectPanel";
import XiaojingGeoOperationPanel from "./XiaojingGeoOperationPanel";

interface XiaojingGeoWorkbenchProps {
  currentWorkspace: BrandWorkspace | null;
  navigationTarget?: GeoNavigationTarget | null;
}

export default memo(function XiaojingGeoWorkbench({
  currentWorkspace,
  navigationTarget = null,
}: XiaojingGeoWorkbenchProps) {
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem("xiaojing:geo-workbench-collapsed") === "true",
  );
  const [view, setView] = useState<"operations" | "effects">("operations");
  // A deep-link navigation target always expands the workbench, including on
  // first mount. Adjusting state during render (guarded by the seen value)
  // keeps this a single committed render instead of a cascading setState
  // inside an effect.
  const [seenNavigationTarget, setSeenNavigationTarget] =
    useState<GeoNavigationTarget | null>(null);
  if (navigationTarget !== seenNavigationTarget) {
    setSeenNavigationTarget(navigationTarget);
    if (navigationTarget) {
      setCollapsed(false);
      localStorage.setItem("xiaojing:geo-workbench-collapsed", "false");
    }
  }

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem("xiaojing:geo-workbench-collapsed", String(next));
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <aside
        className="flex w-12 shrink-0 flex-col items-center border-l border-[var(--line)] bg-[var(--xiaojing-sidebar-bg)] py-3"
        data-xiaojing-workbench="collapsed"
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="展开 GEO 工作台"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <BarChart3 className="mt-5 h-4 w-4 text-[var(--accent)]" />
        <span className="mt-3 [writing-mode:vertical-rl] text-xs font-semibold tracking-[0.18em] text-[var(--ink-muted)]">
          GEO 工作台
        </span>
      </aside>
    );
  }

  return (
    <aside
      className="flex w-[320px] shrink-0 flex-col border-l border-[var(--line)] bg-[var(--xiaojing-sidebar-bg)] text-[var(--ink)] max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-30 max-[900px]:w-[min(320px,88vw)] max-[900px]:shadow-lg"
      data-xiaojing-workbench="expanded"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--line-subtle)] px-4">
        <BarChart3 className="h-4 w-4 text-[var(--accent)]" />
        <h2 className="text-sm font-semibold">GEO 工作台</h2>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="折叠 GEO 工作台"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div
          role="tablist"
          aria-label="工作台视图"
          data-geo-workbench-view={view}
          className="grid grid-cols-2 gap-1 rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "operations"}
            onClick={() => setView("operations")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "operations"
                ? "bg-[var(--paper-elevated)] text-[var(--accent)] shadow-sm"
                : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
            }`}
          >
            操作
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "effects"}
            onClick={() => setView("effects")}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "effects"
                ? "bg-[var(--paper-elevated)] text-[var(--accent)] shadow-sm"
                : "text-[var(--ink-muted)] hover:text-[var(--ink)]"
            }`}
          >
            <Gauge className="h-3.5 w-3.5" />
            效果
          </button>
        </div>

        {view === "effects" ? (
          currentWorkspace ? (
            <XiaojingGeoEffectPanel
              key={`${currentWorkspace.id}:geo-effect`}
              workspaceId={currentWorkspace.id}
            />
          ) : (
            <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-4 text-xs leading-5 text-[var(--ink-muted)]">
              先在左侧选择品牌，即可按需执行基线探测、管理发布后监测并查看真实效果看板。
            </p>
          )
        ) : currentWorkspace ? (
          <>
            {/* 票 28：工作台只保留多操作切换器、当前已确认品牌知识与六阶段
                骨架三段结构；品牌信息卡由左侧栏表达，过程块在聊天进度卡。 */}
            <XiaojingGeoOperationPanel
              key={`${currentWorkspace.id}:geo-operation-workbench`}
              workspace={currentWorkspace}
              navigationTarget={navigationTarget}
            >
              <XiaojingBrandKnowledgePanel
                key={`${currentWorkspace.id}:brand-knowledge`}
                workspaceId={currentWorkspace.id}
              />
            </XiaojingGeoOperationPanel>

            <XiaojingBrandHistoryPanel
              key={`${currentWorkspace.id}:brand-history`}
              workspaceId={currentWorkspace.id}
            />
          </>
        ) : (
          <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-4 text-xs leading-5 text-[var(--ink-muted)]">
            {"先在左侧选择品牌，再在聊天中发起 GEO 目标。在聊天中发起 GEO 目标后，小鲸会先确认事实与目标，再创建受控的 GEO 操作。"}
          </p>
        )}
      </div>
    </aside>
  );
});
