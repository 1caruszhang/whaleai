/**
 * GeoOperationDockedStrip —— 输入框上方常驻的闸门进度条。
 *
 * 聊天卡里的进度会随消息滚动离开视野；本条在整个 GeoOperation 生命周期
 * （计划停靠认可门起、终态止）常驻在输入框上方，只读展示当前卡在哪道
 * 门。取本 Session 首个非终态操作（与右侧工作台的聚焦推导一致），
 * toolCompleteCount 变化即刷新——新操作的进度卡出现时停靠条同拍出现；
 * 在跑时按既有模式 3s 有界轮询。确认与生命周期控制仍只在聊天进度卡上，
 * 点击停靠条定位到对应闸门卡锚点（由 Chat 提供 onLocate）。
 */

import { memo, useEffect, useMemo, useState } from "react";

import { loadGeoOperations } from "@/api/geoOperationClient";
import { useCurrentWorkspace } from "@/context/CurrentWorkspaceContext";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type { GeoOperationProjection } from "../../../shared/geo/operation";
import { GEO_OPERATION_STATUS_LABEL, TERMINAL } from "./GeoOperationEventCard";
import GeoGateProgressStrip, {
  deriveGateSegments,
  formatGeoOperationProgressLine,
} from "./GeoGateProgressStrip";

function GeoOperationDockedStrip({
  onLocate,
}: {
  onLocate?: (operationId: string) => void;
}) {
  const { apiPost } = useTabApi();
  const { sessionId, toolCompleteCount = 0 } = useTabState();
  const currentWorkspace = useCurrentWorkspace();
  const identity = useMemo(
    () =>
      currentWorkspace?.id && sessionId && !isPendingSessionId(sessionId)
        ? { workspaceId: currentWorkspace.id, sessionId }
        : null,
    [currentWorkspace?.id, sessionId],
  );
  const [live, setLive] = useState<GeoOperationProjection | null>(null);

  // 首拉 + toolCompleteCount 触发：start_geo_operation 等工具完成的回合
  // 立即重读列表；错误静默保留上次投影，下一轮再试。
  useEffect(() => {
    if (!identity) {
      setLive(null);
      return undefined;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const operations = await loadGeoOperations(
          apiPost,
          identity,
          { limit: 10 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setLive(
          operations.find((operation) => !TERMINAL.has(operation.status)) ??
            null,
        );
      } catch {
        // 保留最后一次投影。
      }
    };
    void load();
    return () => controller.abort();
  }, [apiPost, identity, toolCompleteCount]);

  // 在跑操作的有界轮询：与聊天进度卡/工作台同款 3s 节奏，隐藏或在途时
  // 跳过，回到前台立即补拉；依赖只取 hasLive 布尔，避免每次投影刷新都
  // 重建 interval。
  const hasLive = live !== null;
  useEffect(() => {
    if (!identity || !hasLive) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const operations = await loadGeoOperations(
          apiPost,
          identity,
          { limit: 10 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setLive(
          operations.find((operation) => !TERMINAL.has(operation.status)) ??
            null,
        );
      } catch {
        // 保留最后一次投影。
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [apiPost, hasLive, identity]);

  if (!live) return null;
  const gateSegments = deriveGateSegments(live.steps);
  // 状态行与进度卡共用同一条派生：执行期优先报真实执行
  // （如「正在生成文章 3/5」），详见 formatGeoOperationProgressLine。
  const progressLine = formatGeoOperationProgressLine(live.steps);

  return (
    <button
      type="button"
      aria-label="定位当前闸门卡片"
      onClick={() => onLocate?.(live.id)}
      className="w-full shrink-0 border-t border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-2 text-left"
      data-geo-operation-dock={live.id}
    >
      <div className="mx-auto max-w-3xl">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-medium text-[var(--ink)]">
            {live.goal}
          </span>
          <span className="ml-auto shrink-0 text-xs text-[var(--ink-muted)]">
            {GEO_OPERATION_STATUS_LABEL[live.status]} · {progressLine}
          </span>
        </div>
        {gateSegments.length > 0 && (
          <GeoGateProgressStrip operationId={live.id} steps={live.steps} />
        )}
      </div>
    </button>
  );
}

export default memo(GeoOperationDockedStrip);
