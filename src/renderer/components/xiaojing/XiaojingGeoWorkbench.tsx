import { BarChart3, ChevronLeft, ChevronRight } from "lucide-react";
import type { CSSProperties } from "react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import { useColumnDrag } from "@/hooks/useColumnDrag";
import {
  effectiveWorkbenchMax,
  getColumnWidths,
  readCollapsedFlag,
  WORKBENCH_COLLAPSED_STORAGE_KEY,
  WORKBENCH_WIDTH_DEFAULT,
  WORKBENCH_WIDTH_MIN,
  writeCollapsedFlag,
} from "@/utils/columnLayout";
import type { GeoNavigationTarget } from "../../../shared/geo/notification";
import ColumnResizer from "./ColumnResizer";
import XiaojingGeoOperationPanel from "./XiaojingGeoOperationPanel";

interface XiaojingGeoWorkbenchProps {
  currentWorkspace: BrandWorkspace | null;
  navigationTarget?: GeoNavigationTarget | null;
}

export default memo(function XiaojingGeoWorkbench({
  currentWorkspace,
  navigationTarget = null,
}: XiaojingGeoWorkbenchProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(
    () => readCollapsedFlag(WORKBENCH_COLLAPSED_STORAGE_KEY),
  );
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
      writeCollapsedFlag(WORKBENCH_COLLAPSED_STORAGE_KEY, false);
    }
  }

  // 拖宽：宽度是全局一份（columnLayout store）；工作台逐聊天 Tab 挂载，
  // 提交后经 store 广播到所有实例，拖拽期间只有当前实例逐帧更新。
  // 展开折叠时宽度不重置——恢复 store 里上次拖定的宽度。
  const {
    shownWidth: shownWorkbenchWidth,
    applyDelta: applyWorkbenchDelta,
    commit: commitWorkbenchWidth,
    reset: resetWorkbenchWidth,
  } = useColumnDrag({
    side: "workbench",
    minPx: WORKBENCH_WIDTH_MIN,
    defaultPx: WORKBENCH_WIDTH_DEFAULT,
    // 工作台贴右缘：指针向左（负 delta）才是加宽，取反后按分隔线位移计宽。
    invertDelta: true,
    effectiveMax: () => effectiveWorkbenchMax(getColumnWidths().sidebar, window.innerWidth),
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      writeCollapsedFlag(WORKBENCH_COLLAPSED_STORAGE_KEY, next);
      return next;
    });
  }, []);

  // 面板子树按元素记忆：拖拽逐帧更新宽度时，六阶段面板的元素引用
  // 不变，React 直接跳过其重渲染。注意保持在折叠早退分支之前，
  // 钩子顺序不可随折叠状态变化。
  const panelContent = useMemo(() => (
    currentWorkspace ? (
      /* 票 28/票 31：工作台收为单一操作视图，只保留多操作切换器与六阶段
          骨架；当前已确认品牌知识在骨架「品牌知识」阶段展开体中呈现，
          品牌信息卡由左侧栏表达，过程块在聊天进度卡；历史面板与效果三
          面板分别由左侧栏「品牌档案」（票 30）与「效果」（票 31）一级
          入口整页呈现。 */
      <XiaojingGeoOperationPanel
        key={`${currentWorkspace.id}:geo-operation-workbench`}
        workspace={currentWorkspace}
        navigationTarget={navigationTarget}
      />
    ) : (
      <p className="mt-4 rounded-xl border border-dashed border-[var(--line)] p-4 text-xs leading-5 text-[var(--ink-muted)]">
        {"先在左侧选择品牌，再在聊天中发起 GEO 目标。在聊天中发起 GEO 目标后，小鲸会先确认事实与目标，再创建受控的 GEO 操作。"}
      </p>
    )
  ), [currentWorkspace, navigationTarget]);

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
    <>
      {/* <900px 工作台转浮层覆盖聊天，分隔线随之隐藏（浮层模式拖宽无意义）。 */}
      <ColumnResizer
        ariaLabel={t("xiaojingWorkbench.resizeHandle")}
        hintLabel={t("xiaojingWorkbench.resizeHint")}
        className="max-[900px]:hidden"
        onResizeBy={applyWorkbenchDelta}
        onResizeCommit={commitWorkbenchWidth}
        onReset={resetWorkbenchWidth}
      />
      <aside
        style={{ "--xiaojing-workbench-width": `${shownWorkbenchWidth}px` } as CSSProperties}
        className="flex w-(--xiaojing-workbench-width) shrink-0 flex-col border-l border-[var(--line)] bg-[var(--xiaojing-sidebar-bg)] text-[var(--ink)] max-[900px]:absolute max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-30 max-[900px]:w-[min(360px,88vw)] max-[900px]:shadow-lg"
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
          {panelContent}
        </div>
      </aside>
    </>
  );
});
