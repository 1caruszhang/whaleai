import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

import type { GeoBaselineEngineId } from '../../shared/geo/baseline';
import type { GeoDashboardEvidenceKind, GeoDashboardFilter } from '../../shared/geo/dashboard';
import type { PublishOrderStatusEntry } from '../../shared/geo/publishScheduler';
import { createGeoDashboardPort, GeoDashboardService } from '../geo/dashboard';
import {
  checkPublishedPageAccess,
  MONITORING_PATROL_UNIT_POINTS,
  PostPublishBaselineProbeService,
  PostPublishInsufficientBalanceError,
  type PostPublishBaselineProbeInput,
} from '../geo/post-publish-monitoring';
import {
  distributionOrderSn,
  type GeoDistributionOrderStatus,
  type GeoStoredImageMediaType,
} from '../geo/provider-capabilities';
import {
  getXiaojingGeoBillingPermitChannelForRequest,
  getXiaojingGeoProviderCapabilitiesForRequest,
} from '../geo/provider-runtime';
import { PublishEgressService } from '../geo/publish-egress';
import { createPublishSchedulerPort } from '../geo/publish-scheduler';
import { jsonResponse } from '../utils/http';
import {
  getRuntimeSessionIdForRequest,
  getXiaojingGeoBaselineService,
  recordBaselineMilestones,
  requestAccountAccessToken,
  type XiaojingRouteContext,
} from './xiaojing-shared';

/** 网关查单契约：单次最多 20 个 sn。 */
const ORDER_QUERY_BATCH = 20;

/** 发布 egress HTML 上限：Rust 侧批准正文已限 256KB + 渲染开销。 */
const PUBLISH_EGRESS_MAX_HTML_BYTES = 320 * 1024;

/**
 * 发布配图 egress（票 #15）：单篇配图密度上限走共享契约（≤3 张），
 * 单张字节上限与材料图片资产一致（导入时已按同一上限校验）。
 */
const PUBLISH_EGRESS_MAX_IMAGE_COUNT = 3;
const PUBLISH_EGRESS_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 配图格式白名单（ADR-0008 D4）：emf/wmf/tiff 不进 OSS。 */
const PUBLISH_EGRESS_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * 发布配图片段载荷（票 #15）：Rust 从材料图片资产读回字节后经
 * base64 直送；声明 sha256 与实测不符或超限都是确定性 400，
 * 不触达 Provider。
 */
function parsePublishEgressImages(
  value: unknown,
):
  | {
      images: Array<{
        imageId: string;
        sha256: string;
        mediaType: GeoStoredImageMediaType;
        bytes: Uint8Array;
      }>;
    }
  | { error: string; status?: number } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "publish_egress_upload_payload_invalid" };
  }
  if (value.length > PUBLISH_EGRESS_MAX_IMAGE_COUNT) {
    return { error: "publish_egress_upload_images_too_many" };
  }
  const images = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return { error: "publish_egress_upload_payload_invalid" };
    }
    const { imageId, sha256, mediaType, bytesB64 } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof imageId !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(imageId) ||
      typeof sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(sha256) ||
      typeof mediaType !== "string" ||
      !PUBLISH_EGRESS_IMAGE_MEDIA_TYPES.has(mediaType) ||
      typeof bytesB64 !== "string" ||
      !bytesB64
    ) {
      return { error: "publish_egress_upload_payload_invalid" };
    }
    const bytes = Buffer.from(bytesB64, "base64");
    if (bytes.length === 0 || bytes.length > PUBLISH_EGRESS_MAX_IMAGE_BYTES) {
      return {
        error: "publish_egress_upload_image_too_large",
        status: 413,
      };
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256) {
      return { error: "publish_egress_upload_image_hash_mismatch" };
    }
    images.push({
      imageId,
      sha256,
      // 白名单成员已在上面的集合校验中钉死（运行时 Set 精确匹配）。
      mediaType: mediaType as GeoStoredImageMediaType,
      bytes,
    });
  }
  return { images };
}

/** 发布执行器 egress 公共载荷校验（身份门之后的第一道防线）。 */
function parsePublishEgressIdentity(
  payload: Record<string, unknown>,
): { executionId: string; itemId: string } | { error: string } {
  const executionId = payload.executionId;
  const itemId = payload.itemId;
  if (typeof executionId !== "string" || !executionId) {
    return { error: "publish_execution_id_invalid" };
  }
  if (typeof itemId !== "string" || !itemId) {
    return { error: "publish_item_id_invalid" };
  }
  return { executionId, itemId };
}

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
      const distribution = getXiaojingGeoProviderCapabilitiesForRequest(
        requestAccountAccessToken(request),
      ).distribution;
      // 网关查单上限 20 个 sn：按渠道类别分组后分批查询。只查网关侧已存在
      // 订单的 item——pending 排期项的 sn 尚不在网关 publish_orders 表，
      // 查询会整批 404（order_not_found）。主判定为 externalOrderId 非 null
      // （下单成功后由执行器写回）；status 已过提交节点（submitted /
      // failed-nonretryable / reconciliation-required）为辅。failed-retryable
      // 可能是上传阶段失败、订单未建，故不作为查单依据——宁可漏查一轮
      // （投影 status=null），不可把不存在订单的 sn 发给网关炸掉整批。
      const QUERYABLE_ITEM_STATUSES: ReadonlySet<string> = new Set([
        "submitted",
        "failed-nonretryable",
        "reconciliation-required",
      ]);
      const snsByKind = new Map<'media' | 'we-media', string[]>();
      for (const item of execution.items) {
        if (item.externalOrderId == null && !QUERYABLE_ITEM_STATUSES.has(item.status)) {
          continue;
        }
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

  // 发布执行器 Provider egress（票 08 闭环）：只有 Rust 的确定性调度器会
  // 调这两个 localhost 控制面端点（同 post-publish-monitor 的 worker 路由
  // 模式）。上传/下单经 typed port 走网关（重签与计费在服务器侧）；下单
  // 幂等 sn 由本路由按 distributionOrderSn(executionId, itemId) 派生，
  // Rust 不传 sn。egress 结果是分类值（success/safe-retryable/
  // non-retryable/unknown），控制面本身始终 200。
  // 票 #15：上传路由同时承载文章 HTML 与配图对象（载荷二选一）——Rust
  // 先传图片字节拿回公网 URL、完成占位符替换后再传最终 HTML；占位符
  // 替换权威在 Rust 渲染侧，本路由不解析正文。
  if (
    pathname === "/api/xiaojing/publish-scheduler/egress/upload" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        executionId: string;
        itemId: string;
        objectKey?: string;
        html?: string;
        images?: unknown;
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
      const identity = parsePublishEgressIdentity(payload);
      if ("error" in identity) {
        return jsonResponse({ success: false, error: identity.error }, 400);
      }
      const capabilities = () =>
        getXiaojingGeoProviderCapabilitiesForRequest(
          requestAccountAccessToken(request),
        );
      // 配图对象上传（票 #15）：与 HTML 二选一，载荷形状互斥。
      if (payload.images !== undefined) {
        if (payload.html !== undefined) {
          return jsonResponse(
            { success: false, error: "publish_egress_upload_payload_invalid" },
            400,
          );
        }
        const parsed = parsePublishEgressImages(payload.images);
        if ("error" in parsed) {
          return jsonResponse(
            { success: false, error: parsed.error },
            parsed.status ?? 400,
          );
        }
        const result = await new PublishEgressService(
          capabilities(),
        ).uploadImages({
          executionId: identity.executionId,
          itemId: identity.itemId,
          images: parsed.images,
        });
        return jsonResponse({ success: true, result });
      }
      if (
        typeof payload.objectKey !== "string" ||
        !payload.objectKey ||
        typeof payload.html !== "string"
      ) {
        return jsonResponse(
          { success: false, error: "publish_egress_upload_payload_invalid" },
          400,
        );
      }
      if (payload.html.length > PUBLISH_EGRESS_MAX_HTML_BYTES) {
        return jsonResponse(
          { success: false, error: "publish_egress_upload_body_too_large" },
          413,
        );
      }
      const result = await new PublishEgressService(capabilities()).upload({
        executionId: identity.executionId,
        itemId: identity.itemId,
        objectKey: payload.objectKey,
        html: payload.html,
      });
      return jsonResponse({ success: true, result });
    } catch {
      return jsonResponse(
        { success: false, error: "publish_egress_upload_payload_invalid" },
        400,
      );
    }
  }

  if (
    pathname === "/api/xiaojing/publish-scheduler/egress/order" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        executionId: string;
        itemId: string;
        perArticleMaxPoints: number;
        executionMaxPoints: number;
        kind: string;
        resourceId: number;
        title: string;
        contentUrl: string;
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
      const identity = parsePublishEgressIdentity(payload);
      if ("error" in identity) {
        return jsonResponse({ success: false, error: identity.error }, 400);
      }
      if (
        (payload.kind !== "media" && payload.kind !== "we-media") ||
        !Number.isInteger(payload.resourceId) ||
        payload.resourceId < 1 ||
        !Number.isInteger(payload.perArticleMaxPoints) ||
        payload.perArticleMaxPoints < 1 ||
        payload.perArticleMaxPoints > 160_000_000 ||
        !Number.isInteger(payload.executionMaxPoints) ||
        payload.executionMaxPoints < 1 ||
        payload.executionMaxPoints > 160_000_000 ||
        typeof payload.title !== "string" ||
        !payload.title ||
        typeof payload.contentUrl !== "string" ||
        !payload.contentUrl
      ) {
        return jsonResponse(
          { success: false, error: "publish_egress_order_payload_invalid" },
          400,
        );
      }
      const result = await new PublishEgressService(
        getXiaojingGeoProviderCapabilitiesForRequest(
          requestAccountAccessToken(request),
        ),
      ).placeOrder({
        executionId: identity.executionId,
        itemId: identity.itemId,
        perArticleMaxPoints: payload.perArticleMaxPoints,
        executionMaxPoints: payload.executionMaxPoints,
        kind: payload.kind,
        resourceId: payload.resourceId,
        title: payload.title,
        contentUrl: payload.contentUrl,
      });
      return jsonResponse({ success: true, result });
    } catch {
      return jsonResponse(
        { success: false, error: "publish_egress_order_payload_invalid" },
        400,
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
        getXiaojingGeoProviderCapabilitiesForRequest(
          requestAccountAccessToken(request),
        ).keywordSearch,
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
        getXiaojingGeoProviderCapabilitiesForRequest(
          requestAccountAccessToken(request),
        ).keywordSearch,
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
      const requestToken = requestAccountAccessToken(request);
      const result = await new PostPublishBaselineProbeService(
        getXiaojingGeoProviderCapabilitiesForRequest(requestToken).keywordSearch,
        getXiaojingGeoBillingPermitChannelForRequest(requestToken),
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

  // 监测查单切网关（票 14）：Rust 监测 executor 的 publish-status /
  // access-indexing 单元经本路由查订单状态——网关用服务器侧超级媒介
  // 凭据 HMAC-SHA256 重签并按查单对账（结转/退点），sn 由本路由按
  // `distributionOrderSn(executionId, itemId)` 派生（与票 08 下单同一
  // 口径），请求体不接受 sn。结果回 typed 查单条目；查不到该 sn 时
  // record 为 null（Rust 侧按可重试“尚未返回”处理）。
  if (
    pathname === "/api/xiaojing/post-publish-monitor/order-query" &&
    request.method === "POST"
  ) {
    try {
      const payload = (await request.json()) as {
        workspaceId: string;
        sessionId: string;
        executionId: string;
        itemId: string;
        kind: string;
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
      if (
        typeof payload.executionId !== "string" ||
        !payload.executionId ||
        typeof payload.itemId !== "string" ||
        !payload.itemId ||
        (payload.kind !== "media" && payload.kind !== "we-media")
      ) {
        return jsonResponse(
          { success: false, error: "post_publish_monitor_order_query_payload_invalid" },
          400,
        );
      }
      const kind = payload.kind;
      const sn = distributionOrderSn(payload.executionId, payload.itemId);
      const [record] = await getXiaojingGeoProviderCapabilitiesForRequest(
        requestAccountAccessToken(request),
      )
        .distribution.queryOrders(kind, [sn]);
      return jsonResponse({
        success: true,
        result: { sn, kind, record: record ?? null },
      });
    } catch (error) {
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

  // 监测计划恢复探测（票 14）：paused 计划在每个到期锚点先做只读余额
  // 预检——可用余额 ≥ 单问巡检价即恢复巡检，否则保持暂停。绝不申请
  // permit、不发起探测，零扣点。开发直连模式（无计费通道）返回
  // configured=false，Rust 侧维持暂停。
  if (
    pathname === "/api/xiaojing/post-publish-monitor/balance" &&
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
          { success: false, error: "post_publish_monitor_identity_mismatch" },
          403,
        );
      }
      const channel = getXiaojingGeoBillingPermitChannelForRequest(
        requestAccountAccessToken(request),
      );
      if (!channel) {
        return jsonResponse({
          success: true,
          result: { configured: false, sufficient: false },
        });
      }
      const balance = await channel.balance();
      return jsonResponse({
        success: true,
        result: {
          configured: true,
          available: balance.available,
          required: MONITORING_PATROL_UNIT_POINTS,
          sufficient: balance.available >= MONITORING_PATROL_UNIT_POINTS,
        },
      });
    } catch (error) {
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
  return null;
}
