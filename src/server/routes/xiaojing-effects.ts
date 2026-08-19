import { basename, resolve } from 'node:path';

import type { GeoBaselineEngineId } from '../../shared/geo/baseline';
import type { GeoDashboardEvidenceKind, GeoDashboardFilter } from '../../shared/geo/dashboard';
import type { PublishOrderStatusEntry } from '../../shared/geo/publishScheduler';
import { createGeoDashboardPort, GeoDashboardService } from '../geo/dashboard';
import {
  checkPublishedPageAccess,
  PostPublishBaselineProbeService,
  PostPublishInsufficientBalanceError,
  type PostPublishBaselineProbeInput,
} from '../geo/post-publish-monitoring';
import {
  distributionOrderSn,
  type GeoDistributionOrderStatus,
} from '../geo/provider-capabilities';
import {
  getXiaojingGeoBillingPermitChannel,
  getXiaojingGeoProviderCapabilities,
} from '../geo/provider-runtime';
import { createPublishSchedulerPort } from '../geo/publish-scheduler';
import { jsonResponse } from '../utils/http';
import {
  getRuntimeSessionIdForRequest,
  getXiaojingGeoBaselineService,
  recordBaselineMilestones,
  type XiaojingRouteContext,
} from './xiaojing-shared';

/** 网关查单契约：单次最多 20 个 sn。 */
const ORDER_QUERY_BATCH = 20;

export async function handleXiaojingEffectsRoute(
  pathname: string,
  request: Request,
  ctx: XiaojingRouteContext,
): Promise<Response | null> {
  const { workspacePath } = ctx;

  // Publish execution is a Rust-owned deterministic scheduler. This
  // Session route only authenticates the current Tab and forwards
  // latest/get status reads plus non-egress preview preparation. Paid
  // confirmation/start/retry authority is available only through the
  // WebView's explicit-user-action Tauri IPC.
  if (
    pathname === "/api/xiaojing/publish-scheduler/latest" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "publish_scheduler_identity_mismatch" },
          403,
        );
      }
      const execution = await createPublishSchedulerPort({
        workspaceId,
        sessionId: runtimeSessionId,
      }).latest();
      return jsonResponse({ success: true, execution });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/publish-scheduler/get" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        executionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "publish_scheduler_identity_mismatch" },
          403,
        );
      }
      const execution = await createPublishSchedulerPort({
        workspaceId,
        sessionId: runtimeSessionId,
      }).get(payload.executionId);
      return jsonResponse({ success: true, execution });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/publish-scheduler/preview" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        planId?: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "publish_scheduler_identity_mismatch" },
          403,
        );
      }
      const execution = await createPublishSchedulerPort({
        workspaceId,
        sessionId: runtimeSessionId,
      }).preview(payload.planId);
      return jsonResponse({ success: true, execution });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("conflict") ? 409 : 400,
      );
    }
  }

  // 订单状态投影（票 09）：renderer 只持展示投影，计费权威在网关——查单
  // 本身即对账，网关据返回状态驱动结转/退点。sn 为票 08 的确定性幂等键
  // （distributionOrderSn(executionId, itemId)），重试/重放观察同一订单。
  if (
    pathname === "/api/xiaojing/publish-scheduler/orders" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        executionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "publish_scheduler_identity_mismatch" },
          403,
        );
      }
      if (typeof payload.executionId !== "string" || !payload.executionId) {
        return jsonResponse(
          { success: false, error: "publish_execution_id_invalid" },
          400,
        );
      }
      const execution = await createPublishSchedulerPort({
        workspaceId,
        sessionId: runtimeSessionId,
      }).get(payload.executionId);
      const distribution = getXiaojingGeoProviderCapabilities().distribution;
      // 网关查单上限 20 个 sn：按渠道类别分组后分批查询。
      const snsByKind = new Map<'media' | 'we-media', string[]>();
      for (const item of execution.items) {
        const group = snsByKind.get(item.channel.kind) ?? [];
        group.push(distributionOrderSn(execution.id, item.id));
        snsByKind.set(item.channel.kind, group);
      }
      const bySn = new Map<string, GeoDistributionOrderStatus>();
      for (const [kind, sns] of snsByKind) {
        for (let index = 0; index < sns.length; index += ORDER_QUERY_BATCH) {
          const statuses = await distribution.queryOrders(
            kind,
            sns.slice(index, index + ORDER_QUERY_BATCH),
          );
          for (const status of statuses) {
            if (status.sn) bySn.set(status.sn, status);
          }
        }
      }
      const orders: PublishOrderStatusEntry[] = execution.items.map((item) => {
        const sn = distributionOrderSn(execution.id, item.id);
        const matched = bySn.get(sn);
        return {
          itemId: item.id,
          sn,
          kind: item.channel.kind,
          status: matched ? matched.status : null,
          url: matched?.url ?? null,
          screenshot: matched?.screenshot ?? null,
          publishedAt: matched?.publishedAt ?? null,
        };
      });
      return jsonResponse({ success: true, orders });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  // Pre-optimization GEO baselines are real question-by-engine probes.
  // Renderer stays on the Session control plane; Node owns provider
  // execution and Rust owns immutable snapshots plus evidence-unit CAS.
  if (
    pathname === "/api/xiaojing/geo-baselines/engines" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "geo_baseline_identity_mismatch" },
          403,
        );
      }
      const engines = getXiaojingGeoBaselineService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).engines();
      return jsonResponse({ success: true, engines });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/geo-baselines/latest" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "geo_baseline_identity_mismatch" },
          403,
        );
      }
      const baseline = await getXiaojingGeoBaselineService({
        workspaceId,
        sessionId: runtimeSessionId,
      }).latest({ workspaceId, sessionId: runtimeSessionId });
      return jsonResponse({ success: true, baseline });
    } catch (error) {
      return jsonResponse(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/geo-baselines/start" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        questionPoolId: string;
        engineIds: GeoBaselineEngineId[];
        idempotencyKey: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "geo_baseline_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const baseline = await getXiaojingGeoBaselineService(identity).start({
        ...payload,
        ...identity,
      });
      await recordBaselineMilestones(identity, baseline.status);
      return jsonResponse({ success: true, baseline });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/geo-baselines/retry" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        baselineId: string;
        unitIds: string[];
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "geo_baseline_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const baseline = await getXiaojingGeoBaselineService(identity).retry({
        ...payload,
        ...identity,
      });
      await recordBaselineMilestones(identity, baseline.status);
      return jsonResponse({ success: true, baseline });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  // Brand dashboard is a read-only projection over Rust-owned GEO facts.
  // It cannot start probes, monitoring, uploads, orders, or publishing.
  if (
    pathname === "/api/xiaojing/geo-dashboard/get" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        filters?: GeoDashboardFilter;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "geo_dashboard_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const dashboard = await new GeoDashboardService(
        createGeoDashboardPort(identity),
        getXiaojingGeoProviderCapabilities().keywordSearch,
      ).get(payload.filters ?? {});
      return jsonResponse({ success: true, dashboard });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/geo-dashboard/drilldown" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        kind: GeoDashboardEvidenceKind;
        id: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "geo_dashboard_identity_mismatch" },
          403,
        );
      }
      const identity = { workspaceId, sessionId: runtimeSessionId };
      const drilldown = await new GeoDashboardService(
        createGeoDashboardPort(identity),
        getXiaojingGeoProviderCapabilities().keywordSearch,
      ).drilldown({ kind: payload.kind, id: payload.id });
      return jsonResponse({ success: true, drilldown });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        { success: false, error: message },
        message.includes("identity_mismatch") ? 403 : 400,
      );
    }
  }

  // Deterministic Ticket 14 worker route. Only Rust's wake executor calls
  // this localhost control-plane endpoint; it reuses the Ticket 09 typed
  // probe and never receives publish credentials or order request bodies.
  if (
    pathname === "/api/xiaojing/post-publish-monitor/baseline-probe" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        input: PostPublishBaselineProbeInput;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "post_publish_monitor_identity_mismatch" },
          403,
        );
      }
      const result = await new PostPublishBaselineProbeService(
        getXiaojingGeoProviderCapabilities().keywordSearch,
        getXiaojingGeoBillingPermitChannel(),
      ).probe(payload.input);
      return jsonResponse({ success: true, result });
    } catch (error) {
      // 余额预检拦截（票 07 监测欠费暂停）：402 + insufficient_balance 固定
      // 码——Rust wake executor 按非重试失败收尾本轮，充值后下一轮自动恢复。
      if (error instanceof PostPublishInsufficientBalanceError) {
        return jsonResponse(
          {
            success: false,
            error: "insufficient_balance",
            required: error.required,
            available: error.available,
          },
          402,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse(
        {
          success: false,
          error: message,
        },
        message.includes("identity_mismatch") ? 403 : 503,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/post-publish-monitor/access-check" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        url: string;
      };
      const runtimeSessionId = getRuntimeSessionIdForRequest();
      const workspaceId = basename(resolve(workspacePath));
      if (
        payload.workspaceId !== workspaceId ||
        payload.sessionId !== runtimeSessionId
      ) {
        return jsonResponse(
          { success: false, error: "post_publish_monitor_identity_mismatch" },
          403,
        );
      }
      const result = await checkPublishedPageAccess(payload.url);
      return jsonResponse({ success: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejected =
        message === "published_page_url_rejected" ||
        message === "published_page_redirect_rejected";
      return jsonResponse(
        {
          success: false,
          error: message,
        },
        message.includes("identity_mismatch") ? 403 : rejected ? 400 : 502,
      );
    }
  }
  return null;
}
