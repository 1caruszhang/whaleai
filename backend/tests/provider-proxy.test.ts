import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissingConfigError, loadBackendConfig } from '../src/config';
import { listProviderUsageRecords } from '../src/domain/provider-usage';
import { provisionLoggedInAccount, startTestBackend, type TestBackend } from './helpers';
import {
  TEST_ARK_API_KEY,
  TEST_DEEPSEEK_API_KEY,
  TEST_DOUBAO_SEARCH_API_KEY,
  TEST_DISTRIBUTION_APP_ID,
  TEST_DISTRIBUTION_SECRET,
  TEST_OSS_ACCESS_KEY_ID,
  TEST_OSS_ACCESS_KEY_SECRET,
  TEST_OSS_BUCKET,
} from './helpers';

/**
 * 网关 Provider 代理 HTTP 合约（票 05 验收）：各端点经网关调用 mock 上游的
 * 请求形状正确（含 ark-beta-doubao-app 头、鉴权头替换、账号 token 不外发）；
 * OSS 走同地域内网 endpoint 且 Authorization 与 sidecar 黄金向量一致；
 * 超级媒介重签 query 与 sidecar 黄金向量一致、timestamp 公共参数取网关时钟；
 * 每请求旁路计量落 provider_usage_records；上游密钥不进响应/数据库/日志。
 * 上游一律 mock fetch 注入，不触真实网络与真实密钥。
 */

interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** mock 上游：记录收到的请求，按配置应答。 */
function mockUpstream(respond: (call: UpstreamCall) => Response | Promise<Response>) {
  const calls: UpstreamCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
      body: await request.text(),
    });
    return await respond(calls[calls.length - 1]!);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

// 黄金向量输入（与 tests/provider-signing-parity.test.ts 同源，来自 sidecar 真跑捕获）。
const FIXED_MS = 1_787_117_340_000; // 2026-08-19T05:29:00Z
const SIDECAR_OSS_AUTHORIZATION = 'OSS test-oss-ak-vector:8pWPElZjBVmXTLcCevjHg+n4cO0=';
const SIDECAR_OSS_DATE = 'Wed, 19 Aug 2026 05:29:00 GMT';
const VECTOR_OBJECT_KEY_ENCODED = 'articles/2026/%E6%A0%87%E9%A2%98%20demo%2Bplus.html';
const SIDECAR_DISTRIBUTION_QUERY =
  'appid=test-appid-vector&timestamp=1787117340&algorithm=sha256&page=2&size=15' +
  '&signature=14d7f4907e5cb8b469f97bc7857919b1610237dd3aa78c8d5a39e317789bc775';

const vectorConfig = {
  ossAccessKeyId: 'test-oss-ak-vector',
  ossAccessKeySecret: 'test-oss-sk-vector',
  ossBucket: 'test-bucket-vector',
  distributionAppId: 'test-appid-vector',
  distributionSecret: 'test-distribution-secret-vector',
};

const ALL_UPSTREAM_SECRETS = [
  TEST_DEEPSEEK_API_KEY,
  TEST_ARK_API_KEY,
  TEST_DOUBAO_SEARCH_API_KEY,
  TEST_OSS_ACCESS_KEY_ID,
  TEST_OSS_ACCESS_KEY_SECRET,
  TEST_DISTRIBUTION_APP_ID,
  TEST_DISTRIBUTION_SECRET,
];

describe('gateway provider proxy (ticket 05)', () => {
  let tb: TestBackend;

  beforeEach(async () => {
    tb = await startTestBackend();
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('fails fast at startup when provider upstream env keys are missing', () => {
    const baseEnv = {
      AUTH_SECRET: 'unit-test-auth-secret-0123456789abcdef0123456789',
      ADMIN_PASSWORD: 'ops-password-123',
      DEEPSEEK_API_KEY: TEST_DEEPSEEK_API_KEY,
    };
    // 全部新增上游密钥缺失 → MissingConfigError 一次点名。
    expect(() => loadBackendConfig(baseEnv)).toThrow(MissingConfigError);
    try {
      loadBackendConfig(baseEnv);
    } catch (error) {
      const missing = (error as MissingConfigError).missing;
      expect(missing).toEqual(
        expect.arrayContaining([
          'ARK_API_KEY',
          'OSS_ACCESS_KEY_ID',
          'OSS_ACCESS_KEY_SECRET',
          'OSS_BUCKET',
          'DISTRIBUTION_APP_ID',
          'DISTRIBUTION_SECRET',
        ]),
      );
    }
    // 补齐后可加载；可选 key（豆包搜索/embedding 专用 key）缺失不阻塞。
    const config = loadBackendConfig({
      ...baseEnv,
      ARK_API_KEY: TEST_ARK_API_KEY,
      OSS_ACCESS_KEY_ID: TEST_OSS_ACCESS_KEY_ID,
      OSS_ACCESS_KEY_SECRET: TEST_OSS_ACCESS_KEY_SECRET,
      OSS_BUCKET: TEST_OSS_BUCKET,
      DISTRIBUTION_APP_ID: TEST_DISTRIBUTION_APP_ID,
      DISTRIBUTION_SECRET: TEST_DISTRIBUTION_SECRET,
    });
    expect(config.ossInternalHost).toBe('oss-cn-chengdu-internal.aliyuncs.com');
    expect(config.arkEmbeddingApiKey).toBeUndefined();
    expect(config.doubaoSearchApiKey).toBeUndefined();
  });

  it('guards every provider route behind account JWT', async () => {
    const anon = await tb.app.request('/gw/ark/chat/completions', {
      method: 'POST',
      body: '{}',
    });
    expect(anon.status).toBe(401);
    const anonOss = await tb.app.request('/gw/oss/a.html', { method: 'PUT', body: '<html/>' });
    expect(anonOss.status).toBe(401);
    const anonDist = await tb.app.request('/gw/distribution/media/resource');
    expect(anonDist.status).toBe(401);
  });

  it('proxies ARK chat/completions with replaced bearer auth and meters real token usage', async () => {
    const upstream = mockUpstream(() =>
      Response.json({
        choices: [{ message: { content: '关键词结果' } }],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
      }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const body = {
      model: 'doubao-seed-2-0-lite-260428',
      messages: [{ role: 'user', content: '关键词+问题池' }],
      stream: false,
      enable_search: true,
      max_tokens: 1024,
    };
    const res = await tb.app.request('/gw/ark/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-api-key': 'client-should-not-forward',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: '关键词结果' } }] });

    // 请求形状：默认 ARK paygo 端点；鉴权头重写为服务器 ARK key；
    // 客户端账号 token 与其他凭证头不外发；body 逐字节透传（enable_search 原样）。
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe('https://ark.cn-beijing.volces.com/api/v3/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe(`Bearer ${TEST_ARK_API_KEY}`);
    expect(JSON.stringify(call.headers)).not.toContain(accessToken);
    expect(call.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(call.body)).toEqual(body);

    // 旁路计量：真实 token 用量（OpenAI chat 口径）按请求落账。
    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'ark',
      route: 'ark.chat_completions',
      input_tokens: 120,
      output_tokens: 45,
    });
  });

  it('proxies probeQuestion /responses with the ark-beta-doubao-app header injected', async () => {
    const upstream = mockUpstream(() =>
      Response.json({ id: 'resp_1', usage: { input_tokens: 30, output_tokens: 12 } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const body = {
      model: 'doubao-seed-2-0-lite-260428',
      input: [{ role: 'user', content: '品牌在豆包的基线表现如何？' }],
      stream: false,
      tools: [{ type: 'doubao_app', feature: { ai_search: { type: 'enabled' } } }],
    };
    const res = await tb.app.request('/gw/ark/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'resp_1' });

    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe('https://ark.cn-beijing.volces.com/api/v3/responses');
    expect(call.headers['authorization']).toBe(`Bearer ${TEST_ARK_API_KEY}`);
    // Responses 端点的非标 beta 头由网关注入，值与 sidecar 一致。
    expect(call.headers['ark-beta-doubao-app']).toBe('true');
    expect(JSON.parse(call.body)).toEqual(body);

    // responses 口径的 usage（input_tokens/output_tokens）也能计量。
    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([
      { provider: 'ark', route: 'ark.responses', input_tokens: 30, output_tokens: 12 },
    ]);
  });

  it('proxies embeddings with dedicated key fallback to the ARK key', async () => {
    const upstream = mockUpstream(() =>
      Response.json({ data: { embedding: [0.1, 0.2] }, usage: { prompt_tokens: 7, total_tokens: 7 } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);
    const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
    const body = JSON.stringify({ model: 'ep-20260819', input: [{ type: 'text', text: '知识片段' }] });

    // 未配置专用 embedding key → 回落 ARK key（sidecar 同口径）。
    const fallback = await tb.app.request('/gw/ark/embeddings/multimodal', {
      method: 'POST',
      headers,
      body,
    });
    expect(fallback.status).toBe(200);
    expect(upstream.calls[0]!.url).toBe('https://ark.cn-beijing.volces.com/api/v3/embeddings/multimodal');
    expect(upstream.calls[0]!.headers['authorization']).toBe(`Bearer ${TEST_ARK_API_KEY}`);
    expect(JSON.parse(upstream.calls[0]!.body)).toEqual(JSON.parse(body));

    // embeddings 计量（prompt_tokens → input），在本后端上断言。
    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([
      { provider: 'ark', route: 'ark.embeddings', input_tokens: 7, output_tokens: 0 },
    ]);

    // 配置专用 key → 用专用 key。
    const dedicated = mockUpstream(() =>
      Response.json({ data: { embedding: [0.1] }, usage: { prompt_tokens: 1 } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({
      fetch: dedicated.fetch,
      config: { arkEmbeddingApiKey: 'test-ark-embedding-key' },
    });
    const second = await provisionLoggedInAccount(tb.app, '13800000002', 'initial-pass-2');
    const dedicatedRes = await tb.app.request('/gw/ark/embeddings/multimodal', {
      method: 'POST',
      headers: { authorization: `Bearer ${second.accessToken}`, 'content-type': 'application/json' },
      body,
    });
    expect(dedicatedRes.status).toBe(200);
    expect(dedicated.calls[0]!.headers['authorization']).toBe('Bearer test-ark-embedding-key');
  });

  it('proxies doubao search searchSources with the dedicated search key', async () => {
    const upstream = mockUpstream(() =>
      Response.json({
        Result: { WebResults: [{ Title: '竞品页', Url: 'https://example.com/a', Summary: '摘要' }] },
      }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const body = { Query: '竞品 品牌', Count: 20, SearchType: 'web', NeedSummary: true };
    const res = await tb.app.request('/gw/doubao-search/search_api/web_search', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ Result: { WebResults: [{ Title: '竞品页' }] } });

    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.url).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(call.headers['authorization']).toBe(`Bearer ${TEST_DOUBAO_SEARCH_API_KEY}`);
    expect(JSON.stringify(call.headers)).not.toContain(accessToken);
    expect(JSON.parse(call.body)).toEqual(body);

    // 搜索无 token 计量面：按次数落账（一行 = 一次）。
    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([
      { provider: 'doubao-search', route: 'doubao_search.web_search', input_tokens: 0, output_tokens: 0 },
    ]);
  });

  it('proxies deepseek openai chat (extraction/reflection) with the server deepseek key', async () => {
    const upstream = mockUpstream(() =>
      Response.json({
        choices: [{ message: { content: '品牌事实' } }],
        usage: { prompt_tokens: 500, completion_tokens: 80 },
      }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const body = { model: 'deepseek-chat', messages: [{ role: 'user', content: '材料' }], stream: false };
    const res = await tb.app.request('/gw/deepseek/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(upstream.calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(upstream.calls[0]!.headers['authorization']).toBe(`Bearer ${TEST_DEEPSEEK_API_KEY}`);
    expect(JSON.stringify(upstream.calls[0]!.headers)).not.toContain(accessToken);
    expect(JSON.parse(upstream.calls[0]!.body)).toEqual(body);

    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([
      { provider: 'deepseek', route: 'deepseek.chat_completions', input_tokens: 500, output_tokens: 80 },
    ]);
  });

  it('streams SSE provider responses through byte-for-byte and meters the call', async () => {
    const fixture = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const upstream = mockUpstream(() =>
      new Response(fixture, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const res = await tb.app.request('/gw/ark/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'doubao-seed-2-0-pro-260215', messages: [], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toBe(fixture);
    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([
      { provider: 'ark', route: 'ark.chat_completions', input_tokens: 0, output_tokens: 0 },
    ]);
  });

  it('resigns OSS puts to the same-region internal endpoint with the exact sidecar signature', async () => {
    const upstream = mockUpstream(() => new Response('', { status: 200 }));
    await tb.cleanup();
    tb = await startTestBackend({
      fetch: upstream.fetch,
      initialNowMs: FIXED_MS,
      config: { ...vectorConfig, ossPublicBaseUrl: 'https://cdn-public.test' },
    });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const html = '<html><body>hello</body></html>';
    const res = await tb.app.request(`/gw/oss/${VECTOR_OBJECT_KEY_ENCODED}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/html; charset=utf-8' },
      body: html,
    });
    expect(res.status).toBe(200);
    // 返回 URL 口径与 sidecar putHtml 一致：配置公网基地址则拼公网 URL。
    expect(await res.json()).toEqual({
      url: `https://cdn-public.test/${VECTOR_OBJECT_KEY_ENCODED}`,
    });

    // 上游形状：同地域内网 endpoint（成都）；Authorization 与 Date 与 sidecar
    // 真跑黄金向量逐字节一致（同一 AK/SK/bucket/key/时钟）；body 原样。
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(
      `https://test-bucket-vector.oss-cn-chengdu-internal.aliyuncs.com/${VECTOR_OBJECT_KEY_ENCODED}`,
    );
    expect(call.headers['authorization']).toBe(SIDECAR_OSS_AUTHORIZATION);
    expect(call.headers['date']).toBe(SIDECAR_OSS_DATE);
    expect(call.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(call.body).toBe(html);
    expect(JSON.stringify(call.headers)).not.toContain(accessToken);

    // 每次成功 PUT 旁路计量一次。
    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([{ provider: 'oss', route: 'oss.put_html' }]);

    // 未配置公网基地址时返回上游 URL（内网形态；生产必须配置 OSS_PUBLIC_BASE_URL）。
    const noPublic = mockUpstream(() => new Response('', { status: 200 }));
    await tb.cleanup();
    tb = await startTestBackend({ fetch: noPublic.fetch, initialNowMs: FIXED_MS, config: vectorConfig });
    const second = await provisionLoggedInAccount(tb.app, '13800000003', 'initial-pass-3');
    const rawRes = await tb.app.request(`/gw/oss/${VECTOR_OBJECT_KEY_ENCODED}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${second.accessToken}` },
      body: html,
    });
    expect(await rawRes.json()).toEqual({
      url: `https://test-bucket-vector.oss-cn-chengdu-internal.aliyuncs.com/${VECTOR_OBJECT_KEY_ENCODED}`,
    });
  });

  it('rejects invalid OSS object keys without touching upstream', async () => {
    const upstream = mockUpstream(() => new Response('', { status: 200 }));
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, config: vectorConfig });
    const { accessToken } = await provisionLoggedInAccount(tb.app);

    // 空键与坏 percent 编码进到处理器 → 400 invalid_object_key；
    // `..` 逃逸在 URL 规范化层就被拆掉（路由不匹配 → 404），两种都触不到上游。
    for (const key of ['', '%E4%FF']) {
      const res = await tb.app.request(`/gw/oss/${key}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${accessToken}` },
        body: 'x',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_object_key' });
    }
    const traversal = await tb.app.request('/gw/oss/a/../../b.html', {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}` },
      body: 'x',
    });
    expect([400, 404]).toContain(traversal.status);
    expect(upstream.calls).toHaveLength(0);
  });

  it('resigns supermedia resource reads with the exact sidecar query and a fresh server timestamp', async () => {
    const envelope = { code: 200, message: 'ok', data: { total: 1, items: [{ id: 9, name: '网易网' }] } };
    const upstream = mockUpstream(() => Response.json(envelope));
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, initialNowMs: FIXED_MS, config: vectorConfig });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    // 客户端只传业务参数；混入的 appid/timestamp/signature 必须被忽略，
    // 签名身份只能来自服务器（query 与 sidecar 真跑黄金向量逐字节一致）。
    const res = await tb.app.request(
      '/gw/distribution/media/resource?page=2&size=15&appid=evil-appid&timestamp=1&signature=deadbeef',
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(envelope);
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`https://vip.chaojimeijie.com/api/media/resource?${SIDECAR_DISTRIBUTION_QUERY}`);
    expect(call.headers['accept']).toBe('application/json');
    expect(JSON.stringify(call.headers)).not.toContain(accessToken);

    const records = listProviderUsageRecords(tb.db, accountId, 10);
    expect(records).toMatchObject([{ provider: 'distribution', route: 'distribution.media_resource' }]);

    // 公共参数 timestamp 取网关时钟（10 位 unix 秒，上游 5 分钟时效恒新鲜）：
    // 时钟推进 37 秒 → 签名 timestamp 同步 +37，而不是复用旧值。
    tb.setNow(FIXED_MS + 37_000);
    const again = await tb.app.request('/gw/distribution/media/resource?page=2&size=15', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(again.status).toBe(200);
    expect(upstream.calls).toHaveLength(2);
    const secondUrl = new URL(upstream.calls[1]!.url);
    expect(secondUrl.searchParams.get('timestamp')).toBe('1787117377');
    expect(upstream.calls[1]!.url).not.toBe(upstream.calls[0]!.url);

    // we-media 资源路径与缺省 page/size。
    const weMedia = await tb.app.request('/gw/distribution/we-media/resource', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(weMedia.status).toBe(200);
    expect(new URL(upstream.calls[2]!.url).pathname).toBe('/api/we-media/resource');
    expect(new URL(upstream.calls[2]!.url).searchParams.get('page')).toBe('1');
    expect(new URL(upstream.calls[2]!.url).searchParams.get('size')).toBe('20');

    // 超出上游限制的 size → 400，不触上游。
    const bad = await tb.app.request('/gw/distribution/media/resource?size=500', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(bad.status).toBe(400);
    expect(upstream.calls).toHaveLength(3);
  });

  it('never leaks upstream keys or account tokens through error bodies, status codes pass through', async () => {
    let victimToken = '';
    // ARK：错误体回显 Bearer key 与账号 token。
    const ark = mockUpstream(() =>
      Response.json(
        { error: { message: `auth failed: Bearer ${TEST_ARK_API_KEY} token ${victimToken}` } },
        { status: 401 },
      ),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: ark.fetch, config: vectorConfig });
    const { accessToken } = await provisionLoggedInAccount(tb.app);
    victimToken = accessToken;
    const arkRes = await tb.app.request('/gw/ark/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(arkRes.status).toBe(401);
    const arkText = await arkRes.text();
    expect(arkText).not.toContain(TEST_ARK_API_KEY);
    expect(arkText).not.toContain(accessToken);
    expect(JSON.parse(arkText)).toMatchObject({ error: { message: expect.stringContaining('[REDACTED]') } });

    // OSS：错误体（XML）回显 Authorization 与 SK → 非 JSON 兜底通用体。
    const ossAuthEcho = `${SIDECAR_OSS_AUTHORIZATION}`;
    const oss = mockUpstream(() =>
      new Response(
        `<?xml version="1.0"?><Error><Code>SignatureDoesNotMatch</Code><Message>bad ${ossAuthEcho} sk=vector</Message></Error>`,
        { status: 403, headers: { 'content-type': 'application/xml' } },
      ),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: oss.fetch, initialNowMs: FIXED_MS, config: vectorConfig });
    const ossAccount = await provisionLoggedInAccount(tb.app, '13800000004', 'initial-pass-4');
    const ossRes = await tb.app.request(`/gw/oss/${VECTOR_OBJECT_KEY_ENCODED}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ossAccount.accessToken}` },
      body: 'x',
    });
    expect(ossRes.status).toBe(403);
    const ossText = await ossRes.text();
    expect(ossText).not.toContain(SIDECAR_OSS_AUTHORIZATION);
    expect(ossText).not.toContain('test-oss-sk-vector');
    expect(JSON.parse(ossText)).toMatchObject({ error: { type: 'upstream_error' } });

    // 超级媒介：错误体回显 secret 与 appid → 清洗后回传。
    const dist = mockUpstream(() =>
      Response.json({ code: 401, message: `signature invalid ${'test-distribution-secret-vector'}` }, { status: 401 }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: dist.fetch, initialNowMs: FIXED_MS, config: vectorConfig });
    const distAccount = await provisionLoggedInAccount(tb.app, '13800000005', 'initial-pass-5');
    const distRes = await tb.app.request('/gw/distribution/media/resource', {
      headers: { authorization: `Bearer ${distAccount.accessToken}` },
    });
    expect(distRes.status).toBe(401);
    const distText = await distRes.text();
    expect(distText).not.toContain('test-distribution-secret-vector');
    expect(distText).not.toContain(distAccount.accessToken);

    // 上游不可达（fetch 抛错，异常文案带密钥）→ 502 通用错误，不外泄。
    const exploding = (async () => {
      throw new TypeError(`connect ECONNREFUSED with key ${TEST_ARK_API_KEY}`);
    }) as typeof globalThis.fetch;
    await tb.cleanup();
    tb = await startTestBackend({ fetch: exploding, config: vectorConfig });
    const downAccount = await provisionLoggedInAccount(tb.app, '13800000006', 'initial-pass-6');
    const down = await tb.app.request('/gw/ark/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${downAccount.accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(down.status).toBe(502);
    const downText = await down.text();
    expect(downText).not.toContain(TEST_ARK_API_KEY);
    expect(JSON.parse(downText)).toMatchObject({ error: 'upstream_unavailable' });
  });

  it('keeps upstream keys out of the metering database rows', async () => {
    const upstream = mockUpstream(() =>
      Response.json({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch, config: vectorConfig });
    const { accountId, accessToken } = await provisionLoggedInAccount(tb.app);
    await tb.app.request('/gw/ark/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const rows = listProviderUsageRecords(tb.db, accountId, 10);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    for (const secret of ALL_UPSTREAM_SECRETS) {
      expect(serialized).not.toContain(secret);
    }
    // 计量行不含请求体与账号 token（token 确实发过请求，保证断言非空转）。
    expect(upstream.calls[0]!.headers['authorization']).toBe(`Bearer ${TEST_ARK_API_KEY}`);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain('body');
  });
});
