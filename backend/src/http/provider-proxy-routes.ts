import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import {
  readDistributionResourceCache,
  upsertDistributionResourceCache,
} from '../domain/distribution-resources';
import { recordProviderUsage, type ProviderUsageProvider } from '../domain/provider-usage';
import {
  applyPublishOrderStatus,
  beginPublishOrder,
  completePublishOrder,
  failPublishOrder,
  publishOrderProjection,
  requireOwnedPublishOrder,
} from '../domain/publish-orders';
import type { PublishOrderKind } from '../domain/types';
import { extractOpenAiUsage } from '../gateway/openai-usage';
import { DistributionUpstream } from '../gateway/distribution-upstream';
import {
  encodeOssObjectKey,
  invalidObjectKeyError,
  OSS_HTML_CONTENT_TYPE,
  OSS_IMAGE_CONTENT_TYPES,
  OSS_OBJECT_ACL_HEADER,
  OSS_PUBLIC_READ_ACL,
  ossPutStringToSign,
  ossUpstreamUrl,
  signOssPutAuthorization,
  signSupermediaQuery,
} from '../gateway/provider-signing';
import { sanitizedUpstreamErrorBody } from '../gateway/sanitize';
import { AppError } from '../errors';
import { requireAccountAuth } from './auth-routes';
import { parseJsonBody, readBearerToken } from './request';
import type { BackendEnv } from './app';

/**
 * 网关 Provider 代理（票 05）：代理主 Agent 通道（票 04）以外的全部 Provider
 * 流量——ARK Chat Completions（含 keyword-search 的 enable_search body）、
 * probeQuestion（/responses + ark-beta-doubao-app 头）、embedding、豆包搜索
 * searchSources、DeepSeek OpenAI Chat（extraction/reflection）、OSS putHtml
 * （网关 V1 HMAC-SHA1 重签 + 同地域内网 endpoint）与超级媒介资源读取（网关
 * HMAC-SHA256 展平重签，timestamp 公共参数取网关时钟保证 5 分钟时效）。
 *
 * 路径约定与 Sidecar 端点覆盖机制（票 01）对接：网关路径 = 上游路径。把
 * Sidecar 的 `XIAOJING_ARK_PAYGO_BASE_URL` 指到 `<网关>/gw/ark`、
 * `XIAOJING_DOUBAO_SEARCH_BASE_URL` 指到 `<网关>/gw/doubao-search`、
 * `XIAOJING_DISTRIBUTION_BASE_URL` 指到 `<网关>/gw/distribution`，Sidecar
 * 拼出的固定子路径（/chat/completions、/responses、/embeddings/multimodal、
 * /search_api/web_search、/media/resource、/we-media/resource、
 * /media|we-media/order 及其 /order/* 操作路径）原样落到本路由；OSS 走
 * `PUT /gw/oss/{encodedObjectKey}`（票 07 接线）。票 08 增补订单面：
 * 下单（服务器定价 + 预扣冻结 + sn 幂等）、查单（透传 + 状态机对账）、
 * 催稿/取消/申请退款/申请补发（纯代理）；事件回调在
 * distribution-callback-routes（入站端点，HMAC 验签，不走账号鉴权）。
 *
 * 红线（同票 04）：上游密钥只经环境变量进入、只出现在对上游的请求头/签名；
 * 客户端账号 token 绝不转发上游；错误正文经清洗；每请求（上游 2xx）旁路
 * 计量落 provider_usage_records（token 或次数），不动 ledger_entries。
 */

type GatewayContext = Context<BackendEnv>;

export function createProviderProxyRoutes(deps: BackendDeps) {
  const routes = new Hono<BackendEnv>();
  const requireAccount = requireAccountAuth(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const config = deps.config;

  /** 上游错误：状态码透传，正文清洗（上游密钥/签名/账号 token 不得回显）。 */
  const errorResponse = async (c: GatewayContext, response: Response, secrets: readonly string[]) =>
    c.body(
      sanitizedUpstreamErrorBody(await response.text(), [
        ...secrets,
        readBearerToken(c.req.header('Authorization')),
      ]),
      response.status as ContentfulStatusCode,
      { 'content-type': 'application/json' },
    );

  const fetchOrUnavailable = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, init);
    } catch {
      // 不把底层异常文案透出：可能携带上游地址、密钥等内部信息。
      throw new AppError('upstream_unavailable', '上游服务暂不可用，请稍后重试。', 502);
    }
  };

  /**
   * Bearer 直代理（JSON POST 全透传）：客户端凭证头一律剥掉重写为上游密钥，
   * 响应字节透传；2xx 时旁路计量（JSON 带 usage 记 token，SSE 记次数）。
   * bodyTransform 仅用于票 07 网关模式的服务端参数兜底（如 embedding
   * endpoint id），未命中时必须原样返回。
   */
  const bearerProxy = (options: {
    provider: ProviderUsageProvider;
    route: string;
    upstreamUrl: string;
    apiKey: string;
    extraHeaders?: Record<string, string>;
    bodyTransform?: (body: string) => string;
  }) => {
    return async (c: GatewayContext) => {
      const account = c.get('account');
      const rawBody = await c.req.raw.text();
      const body = options.bodyTransform ? options.bodyTransform(rawBody) : rawBody;
      const response = await fetchOrUnavailable(options.upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': c.req.raw.headers.get('content-type') ?? 'application/json',
          authorization: `Bearer ${options.apiKey}`,
          ...(options.extraHeaders ?? {}),
        },
        body,
      });
      if (!response.ok) return await errorResponse(c, response, [options.apiKey]);

      const contentType = response.headers.get('content-type') ?? 'application/json';
      // SSE 分支（Sidecar 现行调用全为 stream:false，此处兜底）：逐块透传，
      // 流关闭时按次数计量；字节不改动。
      if (contentType.includes('text/event-stream') && response.body !== null) {
        return streamSseWithMetering(deps, account.id, options.provider, options.route, response);
      }

      const text = await response.text();
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      try {
        usage = extractOpenAiUsage(JSON.parse(text));
      } catch {
        // 上游非 JSON 响应（异常页面等）：只记次数。
      }
      recordProviderUsage(deps, account.id, {
        provider: options.provider,
        route: options.route,
        ...(usage ?? {}),
      });
      return c.body(text, response.status as ContentfulStatusCode, {
        'content-type': contentType,
      });
    };
  };

  // ── DeepSeek OpenAI Chat（extraction / reflection）───────────────────
  routes.post(
    '/gw/deepseek/chat/completions',
    requireAccount,
    bearerProxy({
      provider: 'deepseek',
      route: 'deepseek.chat_completions',
      upstreamUrl: `${config.deepseekOpenAiBaseUrl}/chat/completions`,
      apiKey: config.deepseekApiKey,
    }),
  );

  // ── ARK Chat Completions（generation / keyword-search 的 enable_search）──
  routes.post(
    '/gw/ark/chat/completions',
    requireAccount,
    bearerProxy({
      provider: 'ark',
      route: 'ark.chat_completions',
      upstreamUrl: `${config.arkBaseUrl}/chat/completions`,
      apiKey: config.arkApiKey,
    }),
  );

  // ── ARK Responses（probeQuestion：ark-beta-doubao-app 头由网关注入）──
  routes.post(
    '/gw/ark/responses',
    requireAccount,
    bearerProxy({
      provider: 'ark',
      route: 'ark.responses',
      upstreamUrl: `${config.arkBaseUrl}/responses`,
      apiKey: config.arkApiKey,
      extraHeaders: { 'ark-beta-doubao-app': 'true' },
    }),
  );

  // ── ARK multimodal embeddings（embedding key 缺省回落 ARK key，与 sidecar 同）──
  // 请求体缺 model 且服务器未配置兜底 endpoint id 时，透传注定被火山方舟 400
  // 拒绝且原因不可见（bodyTransform 不注册、无 model 原样上行）——此处直接 503
  // 配置错误并点名缺失的环境变量，不触上游。显式带 model 或非 JSON body 不受影响。
  const requireEmbeddingModel = async (c: GatewayContext, next: () => Promise<void>) => {
    if (config.arkEmbeddingEndpointId) return await next();
    let parsed: { model?: unknown };
    try {
      parsed = JSON.parse(await c.req.raw.clone().text()) as { model?: unknown };
    } catch {
      // 非 JSON body 不在此判定，按原透传口径交上游报错。
      return await next();
    }
    if (parsed.model === undefined || parsed.model === '') {
      throw new AppError(
        'embedding_endpoint_not_configured',
        'embedding 服务暂不可用：服务器缺少 ARK_EMBEDDING_ENDPOINT_ID 配置（doubao-embedding-vision 在线推理接入点，形如 ep-xxx），请联系运维配置后重试。',
        503,
      );
    }
    return await next();
  };
  routes.post(
    '/gw/ark/embeddings/multimodal',
    requireAccount,
    requireEmbeddingModel,
    bearerProxy({
      provider: 'ark',
      route: 'ark.embeddings',
      upstreamUrl: `${config.arkBaseUrl}/embeddings/multimodal`,
      apiKey: config.arkEmbeddingApiKey ?? config.arkApiKey,
      // 票 07：网关模式 sidecar 不携带账号级 endpoint id（账号 admission 清洗），
      // body 缺 model 时按服务器配置补齐；显式携带或未配置则原样透传。
      bodyTransform: config.arkEmbeddingEndpointId
        ? body => {
            let parsed: { model?: unknown };
            try {
              parsed = JSON.parse(body) as { model?: unknown };
            } catch {
              return body;
            }
            if (parsed.model !== undefined && parsed.model !== '') return body;
            return JSON.stringify({ ...parsed, model: config.arkEmbeddingEndpointId });
          }
        : undefined,
    }),
  );

  // ── 豆包搜索 searchSources（专用 key 缺省回落 ARK key，与 sidecar 同）──
  routes.post(
    '/gw/doubao-search/search_api/web_search',
    requireAccount,
    bearerProxy({
      provider: 'doubao-search',
      route: 'doubao_search.web_search',
      upstreamUrl: `${config.doubaoSearchBaseUrl}/search_api/web_search`,
      apiKey: config.doubaoSearchApiKey ?? config.arkApiKey,
    }),
  );

  // ── OSS putHtml / putImage：网关 V1 HMAC-SHA1 重签，改投同地域内网 endpoint ─────
  // 契约：客户端 PUT 网关路径携带 URL 编码的 objectKey（与 sidecar 的
  // encodeObjectKey 口径一致）；网关用服务器 AK/SK 重签后投 OSS，私钥不
  // 出服务器。票 #15 扩展：`images/` 层的图片对象走二进制 PUT——客户端
  // Content-Type 必须落在图片白名单内、携带公共读 ACL 头；重签时 ACL 进
  // CanonicalizedOSSHeaders 并透传给 OSS（文章页匿名加载）。
  routes.put('/gw/oss/*', requireAccount, async c => {
    const account = c.get('account');
    const encodedPath = c.req.path.slice('/gw/oss/'.length);
    let objectKey: string;
    try {
      objectKey = decodeURIComponent(encodedPath);
    } catch {
      throw invalidObjectKeyError();
    }
    const encodedKey = encodeOssObjectKey(objectKey);
    if (encodedKey === null) throw invalidObjectKeyError();

    const date = new Date(deps.now()).toUTCString();
    // HTML 对象维持票 05 契约（服务端固定 Content-Type）；图片对象按
    // 客户端声明校验后透传，公共读 ACL 进签名。
    const isImageObject = objectKey.replace(/^\/+/, '').startsWith('images/');
    let contentType: string;
    let canonicalizedHeaders: ReadonlyArray<string> | undefined;
    let upstreamHeaders: Record<string, string>;
    if (isImageObject) {
      contentType = c.req.header('content-type')?.trim() ?? '';
      if (!OSS_IMAGE_CONTENT_TYPES.has(contentType)) {
        throw new AppError(
          'oss_image_content_type_invalid',
          `图片对象 Content-Type 仅支持 ${[...OSS_IMAGE_CONTENT_TYPES].join(' / ')}。`,
          400,
        );
      }
      const acl = c.req.header(OSS_OBJECT_ACL_HEADER)?.trim();
      if (acl !== OSS_PUBLIC_READ_ACL) {
        throw new AppError(
          'oss_image_acl_required',
          '图片对象必须携带 x-oss-object-acl: public-read（文章页匿名加载）。',
          400,
        );
      }
      canonicalizedHeaders = [`${OSS_OBJECT_ACL_HEADER}:${OSS_PUBLIC_READ_ACL}`];
      upstreamHeaders = {
        'Content-Type': contentType,
        [OSS_OBJECT_ACL_HEADER]: OSS_PUBLIC_READ_ACL,
      };
    } else {
      contentType = OSS_HTML_CONTENT_TYPE;
      upstreamHeaders = { 'Content-Type': OSS_HTML_CONTENT_TYPE };
    }
    const authorization = signOssPutAuthorization(
      config.ossAccessKeyId,
      config.ossAccessKeySecret,
      ossPutStringToSign({
        bucket: config.ossBucket,
        objectKey,
        contentType,
        date,
        canonicalizedHeaders,
      }),
    );
    const upstreamUrl = ossUpstreamUrl(config.ossBucket, config.ossInternalHost, encodedKey);
    const response = await fetchOrUnavailable(upstreamUrl, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        Date: date,
        ...upstreamHeaders,
      },
      // 二进制安全：HTML 逐字节不变（UTF-8 文本往返同值），图片字节绝不经
      // 文本解码往返（text() 会把任意二进制洗成替换字符）。
      body: await c.req.raw.arrayBuffer(),
    });
    if (!response.ok) {
      return await errorResponse(c, response, [
        config.ossAccessKeySecret,
        config.ossAccessKeyId,
        authorization,
      ]);
    }
    recordProviderUsage(deps, account.id, {
      provider: 'oss',
      route: isImageObject ? 'oss.put_image' : 'oss.put_html',
    });
    // 返回 URL 口径与 sidecar putHtml/putImage 一致：配置了公网基地址则用
    // 公网，否则返回上游 URL（内网形态——生产必须配置 OSS_PUBLIC_BASE_URL）。
    const publicBase = config.ossPublicBaseUrl?.replace(/\/+$/, '');
    return c.json({ url: publicBase ? `${publicBase}/${encodedKey}` : upstreamUrl });
  });

  // ── 超级媒介资源读取：HMAC-SHA256 展平重签 ──────────────────────────
  // 公共参数（appid/timestamp/algorithm/signature）全部由网关生成：客户端
  // 只传业务参数 page/size，传入的签名参数一律忽略——签名身份只能来自服务器。
  // timestamp 取网关时钟（10 位 unix 秒），上游 5 分钟时效恒新鲜。
  const distributionResource = (kind: 'media' | 'we-media') => {
    return async (c: GatewayContext) => {
      const account = c.get('account');
      const parsed = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          size: z.coerce.number().int().min(1).max(200).default(20),
        })
        .safeParse({ page: c.req.query('page') ?? undefined, size: c.req.query('size') ?? undefined });
      if (!parsed.success) {
        throw new AppError('validation_error', 'page 必须是正整数，size 必须是 1–200 的整数。', 400);
      }
      const query = signSupermediaQuery(
        config.distributionAppId,
        config.distributionSecret,
        Math.floor(deps.now() / 1000),
        parsed.data,
      );
      const path = kind === 'media' ? '/media/resource' : '/we-media/resource';
      const response = await fetchOrUnavailable(`${config.distributionBaseUrl}${path}?${query}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        return await errorResponse(c, response, [config.distributionSecret, config.distributionAppId]);
      }
      recordProviderUsage(deps, account.id, {
        provider: 'distribution',
        route: `distribution.${kind}_resource`,
      });
      return c.body(await response.text(), response.status as ContentfulStatusCode, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
    };
  };
  routes.get('/gw/distribution/media/resource', requireAccount, distributionResource('media'));
  routes.get('/gw/distribution/we-media/resource', requireAccount, distributionResource('we-media'));

  // ── 超级媒介订单（票 08）：下单/查单/催稿/取消/申请退款/申请补发 ─────
  // 网关是发布订单的计费权威：下单前按服务器侧资源快照定价（媒介费×1.6
  // → 点数向上取整）预扣冻结；查单与回调驱动订单状态机（结转/退点/保持
  // 冻结）。业务参数经网关重签后投上游，客户端只带账号 token + 业务字段。
  const upstream = new DistributionUpstream(deps, fetchImpl);
  const distributionSecrets = () => [config.distributionSecret, config.distributionAppId];

  const orderSnSchema = z
    .string()
    .min(8, 'sn 至少 8 字符')
    .max(64, 'sn 最长 64 字符')
    .regex(/^[A-Za-z0-9:_-]+$/, 'sn 只能包含字母数字与 : _ -');

  const placeOrderSchema = z.object({
    sn: orderSnSchema,
    executionId: z.string().min(1).max(160),
    itemId: z.string().min(1).max(160),
    resourceId: z.number().int().min(1),
    title: z.string().min(1).max(200),
    contentUrl: z.string().url().max(2000),
    remark: z.string().max(500).optional(),
    owner: z.string().max(100).optional(),
    publishForm: z.number().int().min(1).max(2).optional(),
    publishType: z.number().int().min(1).max(3).optional(),
    accountRule: z.number().int().min(2).max(3).optional(),
    perArticleMaxPoints: z.number().int().min(1).max(160_000_000),
    executionMaxPoints: z.number().int().min(1).max(160_000_000),
  });

  const snOnlySchema = z.object({ sn: orderSnSchema });
  const snWithReasonSchema = z.object({ sn: orderSnSchema, reason: z.string().min(1).max(500) });

  /** 账号 + kind 维度的订单所有权（不泄露他人 sn）。 */
  const ownedOrder = (accountId: string, sn: string, kind: PublishOrderKind) =>
    requireOwnedPublishOrder(deps.db, accountId, sn, kind);

  const distributionOrderRoutes = (kind: PublishOrderKind) => {
    const kindPath = kind === 'media' ? '/media' : '/we-media';

    routes.post(`/gw/distribution${kindPath}/order`, requireAccount, async c => {
      const account = c.get('account');
      const body = await parseJsonBody(c, placeOrderSchema);
      if (kind === 'we-media') {
        if (body.publishForm === undefined || body.publishType === undefined || body.accountRule === undefined) {
          throw new AppError(
            'validation_error',
            '自媒体订单必须携带 publishForm、publishType、accountRule。',
            400,
          );
        }
      }

      // 定价权威在服务器：媒介价只取资源快照缓存（miss 回源上游并回填），
      // 客户端不传价、传了也不看（与 permit 价目红线同一规则）。
      let cached = readDistributionResourceCache(deps.db, kind, body.resourceId);
      if (!cached) {
        const fetched = await upstream.queryResource(kind, body.resourceId);
        if (!fetched.ok) return await errorResponse(c, fetched.response, distributionSecrets());
        if (!fetched.data) {
          throw new AppError('resource_not_found', `渠道资源 ${body.resourceId} 不存在。`, 404);
        }
        const nowIso = new Date(deps.now()).toISOString();
        upsertDistributionResourceCache(
          deps.db,
          {
            kind,
            resource_id: fetched.data.id,
            name: fetched.data.name,
            price_cents: fetched.data.priceCents,
            status: fetched.data.status,
          },
          nowIso,
        );
        cached = readDistributionResourceCache(deps.db, kind, body.resourceId);
        if (!cached) throw new AppError('internal_error', '资源快照回填后读取失败。', 500);
      }

      const begin = beginPublishOrder(deps, account.id, {
        sn: body.sn,
        executionId: body.executionId,
        itemId: body.itemId,
        kind,
        resourceId: body.resourceId,
        title: body.title,
        contentUrl: body.contentUrl,
        remark: body.remark,
        owner: body.owner,
        publishForm: body.publishForm,
        publishType: body.publishType,
        accountRule: body.accountRule,
        mediaPriceCents: cached.price_cents,
        perArticleMaxPoints: body.perArticleMaxPoints,
        executionMaxPoints: body.executionMaxPoints,
      });
      // 幂等命中：上游已受理或在途，不触上游、不二次预扣。
      if (begin.phase === 'replay_placed' || begin.phase === 'replay_pending') {
        return c.json({ order: publishOrderProjection(begin.order), created: false });
      }

      const placement = await upstream.placeOrder(kind, {
        sn: body.sn,
        resourceId: body.resourceId,
        title: body.title,
        contentUrl: body.contentUrl,
        remark: body.remark,
        owner: body.owner,
        publishForm: body.publishForm,
        publishType: body.publishType,
        accountRule: body.accountRule,
      });
      if (placement.ok) {
        const completed = completePublishOrder(deps, body.sn, placement.data.partnerSn);
        recordProviderUsage(deps, account.id, {
          provider: 'distribution',
          route: `distribution.${kind}_order`,
        });
        return c.json(
          { order: publishOrderProjection(completed), created: begin.phase === 'created' },
          begin.phase === 'created' ? 201 : 200,
        );
      }

      // 下单失败：先对账查单——响应丢失但上游实际已受理的订单不得释放冻结
      // 也不得重复提交；确认上游无此单才释放（placement=failed，可重试）。
      const reconcile = await upstream.queryOrders(kind, [body.sn]);
      if (!reconcile.ok) return await errorResponse(c, reconcile.response, distributionSecrets());
      const found = reconcile.data.find(snapshot => snapshot.sn === body.sn);
      if (found) {
        completePublishOrder(deps, body.sn, null);
        const applied = applyPublishOrderStatus(deps, {
          sn: found.sn,
          status: found.status,
          url: found.url,
          publishedAt: found.publishedAt,
        });
        recordProviderUsage(deps, account.id, {
          provider: 'distribution',
          route: `distribution.${kind}_order`,
        });
        const projection = applied ? publishOrderProjection(applied) : null;
        return c.json({ order: projection, created: begin.phase === 'created' }, begin.phase === 'created' ? 201 : 200);
      }
      failPublishOrder(deps, body.sn);
      return await errorResponse(c, placement.response, distributionSecrets());
    });

    routes.get(`/gw/distribution${kindPath}/order/query`, requireAccount, async c => {
      const account = c.get('account');
      const sns = c.req.queries('sn') ?? [];
      if (sns.length === 0 || sns.length > 20) {
        throw new AppError('validation_error', 'sn 必须是 1–20 个代理商订单号。', 400);
      }
      // 请求的 sn 必须全部归属本账号（防探询他人订单）。
      for (const sn of sns) ownedOrder(account.id, sn, kind);

      const result = await upstream.queryOrders(kind, sns);
      if (!result.ok) return await errorResponse(c, result.response, distributionSecrets());
      // 查单即对账：返回的订单状态直接驱动状态机（结转/退点/保持冻结）。
      for (const snapshot of result.data) {
        applyPublishOrderStatus(deps, {
          sn: snapshot.sn,
          status: snapshot.status,
          url: snapshot.url,
          publishedAt: snapshot.publishedAt,
        });
      }
      recordProviderUsage(deps, account.id, {
        provider: 'distribution',
        route: `distribution.${kind}_order_query`,
      });
      // 透传上游 envelope（screenshot 为用户 HTML，仅过客户端展示栈，不入库）。
      return c.body(result.text, 200, {
        'content-type': 'application/json',
      });
    });

    const orderAction = (
      action: 'urge' | 'cancel' | 'apply-refund' | 'apply-republish',
      schema: z.ZodType<{ sn: string; reason?: string }>,
      extraGuard?: (c: GatewayContext) => void,
    ) => {
      return async (c: GatewayContext) => {
        const account = c.get('account');
        extraGuard?.(c);
        const body = await parseJsonBody(c, schema);
        ownedOrder(account.id, body.sn, kind);
        const result = await upstream.orderAction(
          kind,
          action,
          body.reason === undefined ? { sn: body.sn } : { sn: body.sn, reason: body.reason },
        );
        if (!result.ok) return await errorResponse(c, result.response, distributionSecrets());
        recordProviderUsage(deps, account.id, {
          provider: 'distribution',
          route: `distribution.${kind}_order_${action.replace(/-/g, '_')}`,
        });
        return c.body(result.text, 200, { 'content-type': 'application/json' });
      };
    };

    routes.post(`/gw/distribution${kindPath}/order/urge`, requireAccount, orderAction('urge', snOnlySchema));
    routes.post(
      `/gw/distribution${kindPath}/order/cancel`,
      requireAccount,
      orderAction('cancel', snWithReasonSchema),
    );
    routes.post(
      `/gw/distribution${kindPath}/order/apply-refund`,
      requireAccount,
      orderAction('apply-refund', snWithReasonSchema),
    );
    // 申请补发仅新闻媒体订单支持（上游附录：补发为新闻媒体独有）。
    routes.post(
      `/gw/distribution${kindPath}/order/apply-republish`,
      requireAccount,
      orderAction('apply-republish', snOnlySchema, () => {
        if (kind !== 'media') {
          throw new AppError('action_not_supported', '申请补发仅支持新闻媒体订单。', 400);
        }
      }),
    );
  };
  distributionOrderRoutes('media');
  distributionOrderRoutes('we-media');

  return routes;
}

/** SSE 透传（兜底分支）：字节不动，上游关流后按次数旁路计量。 */
function streamSseWithMetering(
  deps: BackendDeps,
  accountId: string,
  provider: ProviderUsageProvider,
  route: string,
  response: Response,
) {
  const tapped = (response.body as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        recordProviderUsage(deps, accountId, { provider, route });
      },
    }),
  );
  return new Response(tapped, {
    status: response.status,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}
