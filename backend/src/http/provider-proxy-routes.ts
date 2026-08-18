import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import { recordProviderUsage, type ProviderUsageProvider } from '../domain/provider-usage';
import { extractOpenAiUsage } from '../gateway/openai-usage';
import {
  encodeOssObjectKey,
  invalidObjectKeyError,
  OSS_HTML_CONTENT_TYPE,
  ossPutStringToSign,
  ossUpstreamUrl,
  signOssPutAuthorization,
  signSupermediaQuery,
} from '../gateway/provider-signing';
import { sanitizedUpstreamErrorBody } from '../gateway/sanitize';
import { AppError } from '../errors';
import { requireAccountAuth } from './auth-routes';
import { readBearerToken } from './request';
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
 * /search_api/web_search、/media/resource、/we-media/resource）原样落到本
 * 路由；OSS 走 `PUT /gw/oss/{encodedObjectKey}`（票 07 接线）。
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
  routes.post(
    '/gw/ark/embeddings/multimodal',
    requireAccount,
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

  // ── OSS putHtml：网关 V1 HMAC-SHA1 重签，改投同地域内网 endpoint ─────
  // 契约：客户端 PUT 网关路径携带 URL 编码的 objectKey（与 sidecar 的
  // encodeObjectKey 口径一致），body 为 HTML；网关用服务器 AK/SK 重签后投
  // OSS，私钥不出服务器。
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
    const authorization = signOssPutAuthorization(
      config.ossAccessKeyId,
      config.ossAccessKeySecret,
      ossPutStringToSign({
        bucket: config.ossBucket,
        objectKey,
        contentType: OSS_HTML_CONTENT_TYPE,
        date,
      }),
    );
    const upstreamUrl = ossUpstreamUrl(config.ossBucket, config.ossInternalHost, encodedKey);
    const response = await fetchOrUnavailable(upstreamUrl, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': OSS_HTML_CONTENT_TYPE,
        Date: date,
      },
      body: await c.req.raw.text(),
    });
    if (!response.ok) {
      return await errorResponse(c, response, [
        config.ossAccessKeySecret,
        config.ossAccessKeyId,
        authorization,
      ]);
    }
    recordProviderUsage(deps, account.id, { provider: 'oss', route: 'oss.put_html' });
    // 返回 URL 口径与 sidecar putHtml 一致：配置了公网基地址则用公网，
    // 否则返回上游 URL（内网形态——生产必须配置 OSS_PUBLIC_BASE_URL）。
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
