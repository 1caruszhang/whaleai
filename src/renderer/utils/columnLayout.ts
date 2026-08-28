/**
 * 三栏列宽的唯一事实源：侧栏与工作台的拖拽调宽共用这一份全局宽度 +
 * localStorage 持久化（`xiaojing:column-widths`）。宽度是全局一份而不是
 * 按品牌/Tab 记忆——侧栏全页共用，工作台虽然逐聊天 Tab 挂载，但多个实例
 * 必须显示同一宽度，提交（松手/键盘步进/双击复位）经 subscribe 同步。
 *
 * 拖拽过程不写 store：宿主组件用本地 state 逐帧渲染，只在提交时落这里，
 * 避免 60fps 的 localStorage 写入与全 Tab 树重渲染。
 */

export const COLUMN_WIDTHS_STORAGE_KEY = "xiaojing:column-widths";

/** 折叠标记与列宽同域持久化；键名保持既有存储兼容。 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "xiaojing:sidebar-collapsed";
export const WORKBENCH_COLLAPSED_STORAGE_KEY = "xiaojing:geo-workbench-collapsed";

/** 折叠标记读取：存储不可用（隐私模式/配额）时按未折叠处理。 */
export function readCollapsedFlag(storageKey: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

/** 折叠标记写入：持久化失败不阻断交互，本次会话内仍使用内存状态。 */
export function writeCollapsedFlag(storageKey: string, collapsed: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(storageKey, String(collapsed));
  } catch {
    // 持久化失败不阻断交互。
  }
}

export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 400;

export const WORKBENCH_WIDTH_DEFAULT = 360;
export const WORKBENCH_WIDTH_MIN = 280;
// 上限 720：工作台面板（渠道候选、四路召回证据、双列产物栅格）信息密度
// 高，560 以下截断明显；实际可用上限仍由 effectiveWorkbenchMax 按视口
// 与聊天保底动态收紧（窄屏不会真的拖到 720）。
export const WORKBENCH_WIDTH_MAX = 720;

/** 聊天中栏保底宽：窗口不足时两栏先压到各自下限，聊天最后让位。 */
export const CHAT_WIDTH_MIN = 480;

/** 工作台浮层断点（与 XiaojingGeoWorkbench 的 max-[900px] 类保持一致）：
 * 断点以下工作台 absolute 覆盖聊天，不占文档流宽度。 */
export const WORKBENCH_OVERLAY_BREAKPOINT = 900;

export interface ColumnWidths {
  sidebar: number;
  workbench: number;
}

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.round(Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px)));
}

export function clampWorkbenchWidth(px: number): number {
  if (!Number.isFinite(px)) return WORKBENCH_WIDTH_DEFAULT;
  return Math.round(Math.min(WORKBENCH_WIDTH_MAX, Math.max(WORKBENCH_WIDTH_MIN, px)));
}

function readStorage(): ColumnWidths {
  if (typeof localStorage === "undefined") {
    return { sidebar: SIDEBAR_WIDTH_DEFAULT, workbench: WORKBENCH_WIDTH_DEFAULT };
  }
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_STORAGE_KEY);
    if (!raw) {
      return { sidebar: SIDEBAR_WIDTH_DEFAULT, workbench: WORKBENCH_WIDTH_DEFAULT };
    }
    const parsed = JSON.parse(raw) as Partial<Record<keyof ColumnWidths, unknown>>;
    return {
      sidebar: clampSidebarWidth(Number(parsed.sidebar)),
      workbench: clampWorkbenchWidth(Number(parsed.workbench)),
    };
  } catch {
    return { sidebar: SIDEBAR_WIDTH_DEFAULT, workbench: WORKBENCH_WIDTH_DEFAULT };
  }
}

let cache: ColumnWidths | null = null;
const listeners = new Set<(widths: ColumnWidths) => void>();

export function getColumnWidths(): ColumnWidths {
  if (!cache) cache = readStorage();
  return cache;
}

export function saveColumnWidths(patch: Partial<ColumnWidths>): ColumnWidths {
  const current = getColumnWidths();
  const next: ColumnWidths = {
    sidebar: clampSidebarWidth(patch.sidebar ?? current.sidebar),
    workbench: clampWorkbenchWidth(patch.workbench ?? current.workbench),
  };
  cache = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 持久化失败不阻断交互：本次会话内仍使用内存宽度。
    }
  }
  for (const listener of listeners) listener(next);
  return next;
}

export function resetColumnWidths(patch: Partial<ColumnWidths>): ColumnWidths {
  return saveColumnWidths({
    sidebar: patch.sidebar !== undefined ? SIDEBAR_WIDTH_DEFAULT : undefined,
    workbench: patch.workbench !== undefined ? WORKBENCH_WIDTH_DEFAULT : undefined,
  });
}

export function subscribeColumnWidths(
  listener: (widths: ColumnWidths) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试隔离用：清空缓存与监听者，恢复默认宽度。 */
export function __resetColumnWidthsForTest(): void {
  cache = null;
  listeners.clear();
}

/**
 * 拖动侧栏时的有效上限：在硬上限内尽量给聊天中栏保住 CHAT_WIDTH_MIN；
 * 窗口不足时两栏各自下限优先（聊天允许被压破）。视口低于浮层断点时
 * 工作台不占文档流，不再从侧栏上限里扣除它。
 */
export function effectiveSidebarMax(
  workbenchWidth: number,
  viewportWidth: number,
): number {
  const reserved = viewportWidth >= WORKBENCH_OVERLAY_BREAKPOINT ? workbenchWidth : 0;
  const available = viewportWidth - reserved - CHAT_WIDTH_MIN;
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, available));
}

/** 拖动工作台时的有效上限：同上，侧栏始终占文档流。 */
export function effectiveWorkbenchMax(
  sidebarWidth: number,
  viewportWidth: number,
): number {
  const available = viewportWidth - sidebarWidth - CHAT_WIDTH_MIN;
  return Math.max(WORKBENCH_WIDTH_MIN, Math.min(WORKBENCH_WIDTH_MAX, available));
}
