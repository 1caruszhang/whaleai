import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import {
  getColumnWidths,
  resetColumnWidths,
  saveColumnWidths,
  subscribeColumnWidths,
  type ColumnWidths,
} from '../utils/columnLayout';

interface UseColumnDragOptions {
  /** 拖拽目标列；提交/复位写进全局 columnLayout store 的对应字段。 */
  side: keyof ColumnWidths;
  minPx: number;
  defaultPx: number;
  /** 指针向右 deltaPx 为正；右缘列（工作台）取反后按分隔线位移计宽。 */
  invertDelta?: boolean;
  /** 拖拽期间的有效上限（按视口与对侧列宽动态收紧）。 */
  effectiveMax: () => number;
}

/**
 * 三栏列宽拖拽的宿主侧公共逻辑（侧栏/工作台共用，差异只剩 clamp 方向与
 * 上限函数）：拖拽期间只写本地 state + ref 逐帧渲染，松手/键盘步进/双击
 * 复位才提交 columnLayout store，避免 60fps 的 localStorage 写入与全 Tab
 * 树重渲染。shownWidth 优先用拖拽中的本地值，回落 store 权威值。
 */
export function useColumnDrag(options: UseColumnDragOptions) {
  const { side, minPx, defaultPx, invertDelta = false } = options;
  const storedWidths = useSyncExternalStore(subscribeColumnWidths, getColumnWidths);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragWidthRef = useRef<number | null>(null);
  // effectiveMax 每次渲染取最新闭包（读视口/对侧宽度），但不 destabilize 回调。
  const effectiveMaxRef = useRef(options.effectiveMax);
  effectiveMaxRef.current = options.effectiveMax;

  const applyDelta = useCallback(
    (deltaPx: number) => {
      const base = dragWidthRef.current ?? getColumnWidths()[side];
      const delta = invertDelta ? -deltaPx : deltaPx;
      const next = Math.round(
        Math.min(effectiveMaxRef.current(), Math.max(minPx, base + delta)),
      );
      dragWidthRef.current = next;
      setDragWidth(next);
    },
    [side, minPx, invertDelta],
  );

  const commit = useCallback(() => {
    const pending = dragWidthRef.current;
    if (pending === null) return;
    dragWidthRef.current = null;
    setDragWidth(null);
    saveColumnWidths({ [side]: pending } as Partial<ColumnWidths>);
  }, [side]);

  const reset = useCallback(() => {
    dragWidthRef.current = null;
    setDragWidth(null);
    resetColumnWidths({ [side]: defaultPx } as Partial<ColumnWidths>);
  }, [side, defaultPx]);

  /** 拖拽前直接定位（折叠态拖分隔线 = 展开到默认宽并继续拖宽）。 */
  const beginDragAt = useCallback((px: number) => {
    const next = Math.round(px);
    dragWidthRef.current = next;
    setDragWidth(next);
  }, []);

  return {
    shownWidth: dragWidth ?? storedWidths[side],
    applyDelta,
    commit,
    reset,
    beginDragAt,
  };
}
