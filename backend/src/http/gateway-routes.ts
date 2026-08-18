import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { BackendDeps } from '../deps';
import { assertConversationAllowed, recordChatUsage } from '../domain/chat-usage';
import type { AccountRow } from '../domain/types';
import { extractUsageFromMessageJson, SseUsageTap } from '../gateway/anthropic-usage';
import { sanitizedUpstreamErrorBody } from '../gateway/sanitize';
import { AppError } from '../errors';
import { requireAccountAuth } from './auth-routes';
import { readBearerToken } from './request';
import type { BackendEnv } from './app';

/**
 * 网关主 Agent 通道（票 04）：Anthropic /v1/messages 兼容代理，SSE 流式、
 * 工具调用块与 count_tokens 全透传至 DeepSeek 上游，禁缓冲、不吞事件。
 * 鉴权复用账号 JWT（requireAccountAuth）；对话准入走隐藏额度闸门。
 *
 * 红线：上游密钥只经环境变量进入、只出现在对上游的请求头；客户端的账号
 * token 绝不转发上游；任何日志与错误响应都不含密钥/token。
 */

/** 转发上游的客户端请求头白名单；Authorization/x-api-key 一律剥掉重写。 */
const FORWARDED_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta'];

type GatewayContext = Context<BackendEnv>;

export function createGatewayRoutes(deps: BackendDeps) {
  const routes = new Hono<BackendEnv>();
  const requireAccount = requireAccountAuth(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = deps.config.deepseekBaseUrl.replace(/\/+$/, '');

  /** 转发上游：注入 DeepSeek 密钥（x-api-key），剥除客户端凭证头。 */
  const forward = async (path: string, clientHeaders: Headers, body: string) => {
    const headers: Record<string, string> = {
      'content-type': clientHeaders.get('content-type') ?? 'application/json',
      'x-api-key': deps.config.deepseekApiKey,
    };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = clientHeaders.get(name);
      if (value !== null) headers[name] = value;
    }
    try {
      return await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers, body });
    } catch {
      // 不把底层异常文案透出：可能携带上游地址等内部信息。
      throw new AppError('upstream_unavailable', '上游模型服务暂不可用，请稍后重试。', 502);
    }
  };

  /** 上游错误：状态码透传，正文清洗（上游密钥/账号 token 不得回显给客户端）。 */
  const errorResponse = async (c: GatewayContext, response: Response) =>
    c.body(
      sanitizedUpstreamErrorBody(await response.text(), [
        deps.config.deepseekApiKey,
        // 用裸 token 而非整段 Authorization 头：裸 token 是其子串，
        // 能同时命中「Bearer <token>」与裸回显两种形态。
        readBearerToken(c.req.header('Authorization')),
      ]),
      response.status as ContentfulStatusCode,
      { 'content-type': 'application/json' },
    );

  routes.post('/v1/messages', requireAccount, async c => {
    const account = c.get('account');
    assertConversationAllowed(deps, account);
    const response = await forward('/v1/messages', c.req.raw.headers, await c.req.raw.text());
    if (!response.ok) return await errorResponse(c, response);
    const contentType = response.headers.get('content-type') ?? 'application/json';

    // SSE 分支：真正逐块透传（禁缓冲、不吞事件），旁路计量挂 TransformStream
    // 侧信道抽取 usage——字节不改动，等价直连上游。流关闭（flush）时同步落账。
    if (contentType.includes('text/event-stream') && response.body !== null) {
      return streamSseWithMetering(deps, account.id, response);
    }

    const text = await response.text();
    // 旁路计量：从上游响应读真实 token 用量折点落账（对话本身不扣点数余额）。
    try {
      const metered = extractUsageFromMessageJson(JSON.parse(text));
      if (metered) recordChatUsage(deps, account.id, metered);
    } catch {
      // 上游非 JSON 响应（异常页面等）不计量。
    }
    return c.body(text, response.status as ContentfulStatusCode, {
      'content-type': contentType,
    });
  });

  // count_tokens 兜底（Anthropic SDK 计数端点）：非流式纯透传，不产生 token
  // 消耗故不计量；与 /v1/messages 共用对话闸门。
  routes.post('/v1/messages/count_tokens', requireAccount, async c => {
    assertConversationAllowed(deps, c.get('account'));
    const response = await forward('/v1/messages/count_tokens', c.req.raw.headers, await c.req.raw.text());
    if (!response.ok) return await errorResponse(c, response);
    return c.body(await response.text(), response.status as ContentfulStatusCode, {
      'content-type': response.headers.get('content-type') ?? 'application/json',
    });
  });

  return routes;
}

/**
 * SSE 透传：上游 ReadableStream 逐块 pipe 给客户端（字节不动），同一条流
 * 上挂 usage 抽取器做旁路计量。flush 在上游关流后、客户端读到 EOF 前同步
 * 落账；客户端中途断连走 cancel（不 flush），该次已收 usage 不落账。
 */
function streamSseWithMetering(deps: BackendDeps, accountId: string, response: Response) {
  const tap = new SseUsageTap();
  const tapped = (response.body as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        tap.feed(chunk);
      },
      flush() {
        const metered = tap.finalize();
        if (metered) recordChatUsage(deps, accountId, metered);
      },
    }),
  );
  return new Response(tapped, {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
}
