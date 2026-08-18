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
 * Brand-level "效果" entry (2026-08-19 拍板：看板置顶)：the real-data effect
 * dashboard renders first so the monitoring picture is visible on open (empty
 * skeletons included), followed by post-publish monitor plan management and
 * on-demand baseline probing. Reads ride the Rust IPC data plane and render
 * without an open session; provider-side execution stays session-gated inside
 * the respective panels. The scheduling owner itself stays in BrandWorkspace.
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
    <div className="mt-5 space-y-4" data-geo-effect-entry>
      <XiaojingGeoEffectDashboard workspaceId={workspaceId} refreshKey={revision} />
      <div ref={monitorSectionRef}>
        <XiaojingPostPublishMonitoringPanel
          workspaceId={workspaceId}
          planId={monitorNavigationTarget?.planId}
          refreshKey={revision}
          onPlanMutated={bumpRevision}
        />
      </div>
      <XiaojingGeoBaselinePanel
        workspaceId={workspaceId}
        onResultCommitted={bumpRevision}
      />
    </div>
  );
});
