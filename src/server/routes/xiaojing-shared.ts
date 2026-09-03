import type { GeoOperationProjection } from '../../shared/geo/operation';
import {
  buildGeoOperationEventReminder,
} from '../../shared/systemReminder';
import { getSessionId } from '../agent-session';
import { recordGeoOperationMilestone, quoteGeoNextStepForAction } from '../geo/operation-progress';
import { sendXiaojingMessage } from '../xiaojing-reminder-send';

export type XiaojingRouteContext = Readonly<{ workspacePath: string }>;

/** Rust 代理/worker 附带的请求级账号 access token 头名（与
 * src-tauri/src/account_auth.rs `ACCOUNT_TOKEN_HEADER` 逐字节一致）。
 * 这是进程内 HTTP 头：Sidecar 只把它作为调网关的 Bearer，绝不转发给
 * 网关以外的上游，也绝不写入日志/数据库/响应。 */
const ACCOUNT_TOKEN_HEADER = 'x-xiaojing-account-token';

/** 提取请求级新鲜账号 token（Rust 侧已按 exp 临期自动 refresh）。 */
export function requestAccountAccessToken(request: Request): string | undefined {
  return request.headers.get(ACCOUNT_TOKEN_HEADER)?.trim() || undefined;
}

function getRuntimeSessionIdForRequest(): string {
  return getSessionId();
}

// GEO 领域服务的组装已收敛到 service-composition 组合根（spec：
// geo-service-composition）——面板/卡片路由一律经
// geoServices(identity, { accountToken: requestAccountAccessToken(request) })
// 取服务：请求级新鲜 token 优先，未携带时由组合根回退启动单例
// （票 B 闭合 env-token 过期 401 隐患族）。

async function notifyGeoOperationWorkbenchEvent(
  sessionId: string,
  operation: GeoOperationProjection,
  action: string,
  requestAccountToken?: string,
): Promise<{ success: boolean; error?: string }> {
  return sendXiaojingMessage({
    text: buildGeoOperationEventReminder({
      workspaceId: operation.workspaceId,
      sessionId,
      operationId: operation.id,
      revision: operation.revision,
      action,
      status: operation.status,
      // 操作事件信封按 action 从持久化计划引述 next-step（ADR-0011）：
      // confirm-step 锚定刚放行的门之后，resume/retry/next-round 取首个
      // 未完成步骤；pause/cancel 不引述。
      nextStep: quoteGeoNextStepForAction(operation, action),
    }),
    requestAccountToken,
  });
}

/** Baseline probes run synchronously inside start/retry: confirm the probe
 * gate when evidence is committed, and close the probe step when the run
 * produced usable evidence (succeeded or partial). */
async function recordBaselineMilestones(
  identity: { workspaceId: string; sessionId: string },
  baselineStatus: string,
): Promise<void> {
  await recordGeoOperationMilestone(identity, 'baseline-probe-started');
  if (baselineStatus === 'succeeded' || baselineStatus === 'partial') {
    await recordGeoOperationMilestone(identity, 'baseline-probe-finished');
  }
}

export {
  getRuntimeSessionIdForRequest,
  notifyGeoOperationWorkbenchEvent,
  recordBaselineMilestones,
};
