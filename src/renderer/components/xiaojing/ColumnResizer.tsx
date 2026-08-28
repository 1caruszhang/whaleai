import { useCallback, useRef, useState } from "react";

/** 键盘步进：聚焦分隔线后左右箭头按 8px 调节。 */
const KEYBOARD_STEP_PX = 8;

interface ColumnResizerProps {
  ariaLabel: string;
  /** 悬停提示文案（i18n 资源）；缺省回落 ariaLabel。 */
  hintLabel?: string;
  /** 拖动/键盘调节的逐段回调（增量像素，指针向右为正）。 */
  onResizeBy: (deltaPx: number) => void;
  /** 一次调节结束（松手 / 单次键盘步进）时提交持久化。 */
  onResizeCommit: () => void;
  /** 拖动开始；宿主可在此先展开折叠列。 */
  onResizeStart?: () => void;
  /** 双击复位到默认宽度。 */
  onReset: () => void;
  className?: string;
}

/**
 * 三栏之间的列宽分隔线：指针拖动（setPointerCapture 跟手）、键盘微调、
 * 双击复位。宽度计算与持久化都归宿主；这里只发增量事件。
 */
export default function ColumnResizer({
  ariaLabel,
  hintLabel,
  onResizeBy,
  onResizeCommit,
  onResizeStart,
  onReset,
  className = "",
}: ColumnResizerProps) {
  const [dragging, setDragging] = useState(false);
  const lastXRef = useRef(0);
  const draggingRef = useRef(false);

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    onResizeCommit();
  }, [onResizeCommit]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      data-column-resizer={ariaLabel}
      title={hintLabel ?? ariaLabel}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // jsdom 无指针捕获实现；捕获只是让 pointermove 持续派发到本元素。
        event.currentTarget.setPointerCapture?.(event.pointerId);
        draggingRef.current = true;
        lastXRef.current = event.clientX;
        setDragging(true);
        onResizeStart?.();
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        const delta = event.clientX - lastXRef.current;
        lastXRef.current = event.clientX;
        if (delta !== 0) onResizeBy(delta);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onResizeBy(event.key === "ArrowLeft" ? -KEYBOARD_STEP_PX : KEYBOARD_STEP_PX);
        onResizeCommit();
      }}
      className={`group relative z-30 w-1 shrink-0 cursor-col-resize touch-none select-none outline-none ${className}`}
    >
      {/* 加宽的隐形命中区 + 悬停/拖动/聚焦时的可见高亮线。 */}
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 -left-[3px] -right-[3px] rounded transition-colors ${
          dragging
            ? "bg-[var(--accent)]"
            : "bg-transparent group-hover:bg-[var(--accent)]/45 group-focus-visible:bg-[var(--accent)]/60"
        }`}
      />
    </div>
  );
}
