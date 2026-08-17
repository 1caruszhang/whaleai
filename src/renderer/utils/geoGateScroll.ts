/**
 * 通知深链在聊天 Tab 内定位闸门卡（票 32）。
 *
 * 聊天滚动容器由 Chat 页拥有；这里只提供「按精确 operationId 找到
 * 闸门卡元素并滚动」的确定性定位：优先交互闸门面板宿主
 * （`data-geo-gate-panels`，仅最新进度卡承载），回退到进度卡步骤列表
 * （`data-geo-operation-steps`，含「停在待确认门」步骤行）。
 * 深链可能在会话恢复完成前到达，因此按固定节奏重试，元素出现即滚动。
 */

const GATE_PANELS_SELECTOR_PREFIX = "[data-geo-gate-panels='";
const OPERATION_STEPS_SELECTOR_PREFIX = "[data-geo-operation-steps='";

export function findGeoOperationGateElement(
  container: HTMLElement,
  operationId: string,
): HTMLElement | null {
  if (!operationId) return null;
  return (
    container.querySelector<HTMLElement>(
      `${GATE_PANELS_SELECTOR_PREFIX}${operationId}']`,
    ) ??
    container.querySelector<HTMLElement>(
      `${OPERATION_STEPS_SELECTOR_PREFIX}${operationId}']`,
    )
  );
}

export interface GeoGateScrollOptions {
  /** 重试次数上限；默认 20（配合 250ms 间隔约覆盖 5 秒会话恢复窗口）。 */
  attempts?: number;
  /** 重试间隔毫秒数；默认 250。 */
  intervalMs?: number;
  /** 定位结束（命中或重试耗尽）时回调一次；取消时不回调。 */
  onSettled?: (found: boolean) => void;
}

/**
 * 把容器滚动到 operationId 对应的闸门卡。返回取消函数（组件卸载或
 * 目标变更时调用），未命中前不产生任何滚动副作用。
 */
export function scrollContainerToGeoOperationGate(
  container: HTMLElement,
  operationId: string,
  options: GeoGateScrollOptions = {},
): () => void {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;
  let cancelled = false;
  let timer = 0;
  let remaining = attempts;
  const settle = (found: boolean) => {
    if (cancelled) return;
    options.onSettled?.(found);
  };
  const locate = () => {
    if (cancelled) return;
    const element = findGeoOperationGateElement(container, operationId);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      settle(true);
      return;
    }
    if (remaining > 1) {
      remaining -= 1;
      timer = window.setTimeout(locate, intervalMs);
    } else {
      settle(false);
    }
  };
  locate();
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
