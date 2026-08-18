import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import {
  invalidateDistributionResourceCache,
  upsertDistributionResourceCache,
} from '../domain/distribution-resources';
import { applyPublishOrderStatus } from '../domain/publish-orders';
import type { PublishOrderKind } from '../domain/types';
import { DistributionUpstream } from '../gateway/distribution-upstream';
import { verifySupermediaSignature } from '../gateway/provider-signing';
import { AppError } from '../errors';
import type { BackendEnv } from './app';

/**
 * 超级媒介事件回调（票 08）：入站端点 `/callbacks/distribution`，鉴权是
 * 同款展平 HMAC-SHA256 签名 + timestamp 时效（上游声明 5 分钟）——签名
 * 身份来自服务器 secret，不走账号 token。事件体（POST JSON）：
 *
 * - event=1 资源变更：payload {type: 1|2, id} → 回源资源查询刷新快照缓存
 *   （下单定价的权威数据源）；回源失败则失效缓存，下次下单重取。
 * - event=2 订单变更：payload {type: 1|2, sn} → 回源查单并驱动订单状态机
 *   （结转/退点/保持冻结），优于轮询。
 *
 * 回调只携带「什么变了」，不携带新状态——真实状态一律回源查询取，回调
 * 本身不可伪造状态（验签通过也不信任其负载内容）。上游查不到的 sn
 * （非本网关订单）确认收到但不动作。验签失败 401（不泄露具体差异），
 * 处理期上游故障 502（邀请上游重投）。
 */

/** 上游声明的 timestamp 时效（5 分钟）。 */
const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300;

const callbackBodySchema = z.object({
  appid: z.string(),
  timestamp: z.union([z.number(), z.string()]),
  algorithm: z.string().optional(),
  signature: z.string(),
  event: z.number().int().min(1).max(2),
  payload: z.record(z.string(), z.union([z.string(), z.number()])),
});

function callbackRejected(code: string, status: ContentfulStatusCode): AppError {
  return new AppError(code, '回调验签失败。', status);
}

export function createDistributionCallbackRoutes(deps: BackendDeps) {
  const routes = new Hono<BackendEnv>();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstream = new DistributionUpstream(deps, fetchImpl);
  const config = deps.config;

  routes.post('/callbacks/distribution', async c => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    if (raw === null || typeof raw !== 'object') {
      throw new AppError('invalid_json', '回调正文必须是合法 JSON。', 400);
    }
    const params = raw as Record<string, unknown>;
    // 结构先于验签只校验到「可签名的形状」（标量 + 标量字典），业务字段
    // 的语义校验在验签通过后进行——未验签的正文不参与任何业务动作。
    const shape = callbackBodySchema.safeParse(params);
    if (!shape.success) {
      throw new AppError('validation_error', '回调参数形态无效。', 400);
    }
    const failure = verifySupermediaSignature({
      secret: config.distributionSecret,
      expectedAppId: config.distributionAppId,
      nowSeconds: Math.floor(deps.now() / 1000),
      toleranceSeconds: CALLBACK_TIMESTAMP_TOLERANCE_SECONDS,
      params,
    });
    if (failure) {
      throw callbackRejected(`callback_${failure}`, 401);
    }

    const payload = shape.data.payload;
    if (shape.data.event === 1) {
      const kind: PublishOrderKind = payload.type === 2 ? 'we-media' : 'media';
      const resourceId = Number(payload.id);
      if (!Number.isInteger(resourceId) || resourceId <= 0) {
        throw new AppError('validation_error', '资源变更回调缺少有效资源 id。', 400);
      }
      const fetched = await upstream.queryResource(kind, resourceId);
      if (fetched.ok) {
        if (fetched.data) {
          upsertDistributionResourceCache(
            deps.db,
            {
              kind,
              resource_id: fetched.data.id,
              name: fetched.data.name,
              price_cents: fetched.data.priceCents,
              status: fetched.data.status,
            },
            new Date(deps.now()).toISOString(),
          );
        }
        // 上游查无此资源（下架）：失效本地快照，下次下单回源兜底。
        else invalidateDistributionResourceCache(deps.db, kind, resourceId);
        return c.json({ ok: true, event: 'resource', refreshed: Boolean(fetched.data) });
      }
      // 回源失败：失效缓存并回 502，上游重投时再试。
      invalidateDistributionResourceCache(deps.db, kind, resourceId);
      throw new AppError('upstream_unavailable', '上游服务暂不可用，请稍后重试。', 502);
    }

    // event = 2 订单变更
    const kind: PublishOrderKind = payload.type === 2 ? 'we-media' : 'media';
    const sn = typeof payload.sn === 'string' ? payload.sn : '';
    if (sn.length === 0) {
      throw new AppError('validation_error', '订单变更回调缺少 sn。', 400);
    }
    const queried = await upstream.queryOrders(kind, [sn]);
    if (!queried.ok) {
      throw new AppError('upstream_unavailable', '上游服务暂不可用，请稍后重试。', 502);
    }
    let applied = false;
    for (const snapshot of queried.data) {
      const updated = applyPublishOrderStatus(deps, {
        sn: snapshot.sn,
        status: snapshot.status,
        url: snapshot.url,
        publishedAt: snapshot.publishedAt,
      });
      applied = applied || updated !== null;
    }
    return c.json({ ok: true, event: 'order', applied });
  });

  return routes;
}
