import { Gauge } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import type { GeoEffectNavigationTarget } from "../../../shared/geo/notification";
import XiaojingGeoBaselinePanel from "./XiaojingGeoBaselinePanel";
import XiaojingGeoEffectDashboard from "./XiaojingGeoEffectDashboard";
import XiaojingPostPublishMonitoringPanel from "./XiaojingPostPublishMonitoringPanel";

interface Props {
  workspaceId: string;
  /** 监测告警通知深链落点（票 32）：滚动定位并按精确计划 id 读取。 */
  monitorNavigationTarget?: GeoEffectNavigationTarget | null;
}

/**
 * Brand-level "效果" entry: on-demand baseline probing, post-publish monitor
 * plan management, and the real-data effect dashboard. This is where the
 * interactive baseline/monitor controls live now that the main chain no longer
 * embeds the probe steps; the scheduling owner itself stays in BrandWorkspace.
 */
export default memo(function XiaojingGeoEffectPanel({ workspaceId, monitorNavigationTarget = null }: Props) {
  const [revision, setRevision] = useState(0);
  const bumpRevision = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);
  // 票 32：监测深链到达时滚动到监测面板（页面滚动容器内定位具体计划
  // run 视图）。依赖只取 nonce 原始值，每次深链只定位一次。
  const monitorSectionRef = useRef<HTMLDivElement | null>(null);
  const monitorNonce = monitorNavigationTarget?.nonce ?? 0;
  useEffect(() => {
    if (!monitorNonce) return;
    monitorSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [monitorNonce]);

  return (
    <div className="space-y-3" data-geo-effect-entry>
      <section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]">
        <div className="h-1 bg-[var(--accent)]" />
        <div className="flex items-start gap-2 p-4">
          <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
          <div>
            <h3 className="text-sm font-semibold">品牌效果</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
              基线探测按需执行、监测计划在这里启用与管理；看板只汇总真实证据。
              基线探测需要已确认的问题池，监测启用前必须先冻结一次基线。
            </p>
          </div>
        </div>
      </section>

      <XiaojingGeoBaselinePanel
        workspaceId={workspaceId}
        onResultCommitted={bumpRevision}
      />
      <div ref={monitorSectionRef}>
        <XiaojingPostPublishMonitoringPanel
          workspaceId={workspaceId}
          planId={monitorNavigationTarget?.planId}
          refreshKey={revision}
          onPlanMutated={bumpRevision}
        />
      </div>
      <XiaojingGeoEffectDashboard workspaceId={workspaceId} refreshKey={revision} />
    </div>
  );
});
