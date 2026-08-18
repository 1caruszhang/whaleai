import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  num,
  postJson,
  provisionLoggedInAccount,
  startTestBackend,
  str,
  TEST_ADMIN_PASSWORD,
  TEST_DEEPSEEK_API_KEY,
  type TestBackend,
} from './helpers';

/**
 * 网关主 Agent 通道 HTTP 合约（票 04 验收）：
 * /v1/messages（SSE 流式、工具调用、count_tokens 全透传，禁缓冲）+ 对话
 * 隐藏额度（余额 0 拒绝、旁路 token 计量折点累计、100 点等值用尽暂停、
 * 充值刷新、额度对客户端不可见）+ 密钥/账号 token 不泄露。上游一律
 * mock fetch 注入，不触真实网络。
 */
describe('gateway main agent channel and hidden chat quota', () => {
  let tb: TestBackend;

  beforeEach(async () => {
    tb = await startTestBackend();
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  /** mock 上游：记录收到的请求，按配置应答。 */
  function mockUpstream(respond: (call: UpstreamCall, index: number) => Response | Promise<Response>) {
    const calls: UpstreamCall[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body: await request.text(),
      });
      return await respond(calls[calls.length - 1]!, calls.length - 1);
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }

  /** 直打网关（绕过 postJson 的 JSON 假设，流式响应要拿原始文本）。 */
  const postMessages = (token: string, body: unknown, path = '/v1/messages') =>
    tb.app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('guards the gateway behind account JWT and pauses chat at zero balance until topup', async () => {
    const upstream = mockUpstream(() =>
      Response.json({ id: 'msg_1', model: 'deepseek-chat', usage: { input_tokens: 10, output_tokens: 5 } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch });

    const { adminToken, accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    // 无凭证 / 运营 token（audience 不同）不能进网关。
    const anon = await tb.app.request('/v1/messages', { method: 'POST', body: '{}' });
    expect(anon.status).toBe(401);
    const adminLogin = await postJson(tb.app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
    const asAdmin = await postMessages(str(adminLogin.body.adminToken), {
      model: 'deepseek-chat', max_tokens: 16, messages: [],
    });
    expect(asAdmin.status).toBe(401);

    // 余额清零 → 对话被拒并提示充值，且不触上游。
    const zeroed = await postJson(tb.app, '/admin/ledger/adjust', {
      accountId, delta: -500, note: '测试清零',
    }, adminToken);
    expect(zeroed.status).toBe(200);
    expect(num((zeroed.body.account as Record<string, unknown>).points)).toBe(0);

    const denied = await postMessages(accessToken, {
      model: 'deepseek-chat', max_tokens: 16, messages: [{ role: 'user', content: '你好' }],
    });
    expect(denied.status).toBe(402);
    expect(await denied.json()).toMatchObject({
      error: 'chat_balance_zero',
      message: expect.stringContaining('充值'),
    });
    expect(upstream.calls).toHaveLength(0);

    // 任意档位充值 → 对话立即恢复，请求透传上游。
    const topup = await postJson(tb.app, '/admin/ledger/topup', {
      accountId, points: 2000, note: '对公转账 ¥200',
    }, adminToken);
    expect(topup.status).toBe(200);

    const ok = await postMessages(accessToken, {
      model: 'deepseek-chat', max_tokens: 16, messages: [{ role: 'user', content: '你好' }],
    });
    expect(ok.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    // 上游鉴权用 DeepSeek 密钥；客户端账号 token 不外发。
    expect(upstream.calls[0]!.headers['x-api-key']).toBe(TEST_DEEPSEEK_API_KEY);
    expect(JSON.stringify(upstream.calls[0]!.headers)).not.toContain(accessToken);
    expect(JSON.parse(upstream.calls[0]!.body)).toMatchObject({ model: 'deepseek-chat' });
    expect(await ok.json()).toMatchObject({ id: 'msg_1' });
  });
  it('meters real token usage per request and pauses chat once the hidden quota is exhausted until topup refreshes it', async () => {
    // 单价拉到整数化口径：input 100 + output 5000 token → (100×2000 + 5000×2000)/1e6 元
    // = 10.2 元 = 102 点 > 100 点隐藏额度。
    const upstream = mockUpstream(() =>
      Response.json({ id: 'msg_1', model: 'deepseek-chat', usage: { input_tokens: 100, output_tokens: 5000 } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({
      fetch: upstream.fetch,
      config: { chatInputCnyPerMtok: 2000, chatOutputCnyPerMtok: 2000 },
    });
    const { adminToken, accountId, accessToken } = await provisionLoggedInAccount(tb.app);
    const message = { model: 'deepseek-chat', max_tokens: 64, messages: [{ role: 'user', content: '你好' }] };

    // 第 1 次调用成功：真实 token 用量旁路计量折点累计。
    expect((await postMessages(accessToken, message)).status).toBe(200);

    // 第 2 次：隐藏额度用尽（102 点 ≥ 100 点）→ 暂停对话并提示充值；
    // 错误码与余额为 0（chat_balance_zero）区分，且不再触上游。
    const paused = await postMessages(accessToken, message);
    expect(paused.status).toBe(402);
    const pausedBody = (await paused.json()) as Record<string, unknown>;
    expect(pausedBody).toMatchObject({
      error: 'chat_quota_exhausted',
      message: expect.stringContaining('充值'),
    });
    expect(upstream.calls).toHaveLength(1);

    // 调点不是充值：不刷新对话额度。
    await postJson(tb.app, '/admin/ledger/adjust', { accountId, delta: 10, note: '补偿' }, adminToken);
    expect((await postMessages(accessToken, message)).status).toBe(402);

    // 隐藏额度对客户端接口不可见：账号投影与余额口径都不含任何对话额度字段。
    const me = await tb.app.request('/auth/me', { headers: { authorization: `Bearer ${accessToken}` } });
    const balance = await tb.app.request('/billing/balance', { headers: { authorization: `Bearer ${accessToken}` } });
    expect(JSON.stringify(await me.json())).not.toContain('chat');
    expect(JSON.stringify(await balance.json())).not.toContain('chat');
    expect(JSON.stringify(pausedBody)).not.toContain('quotaUsed');

    // 运营对账：每请求一行计量记录，累计与账号口径一致（102 点 = 102000 千分点）。
    const usage = await tb.app.request(`/admin/accounts/${accountId}/chat-usage`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(usage.status).toBe(200);
    const usageBody = (await usage.json()) as Record<string, unknown>;
    const records = usageBody.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: 'deepseek-chat',
      inputTokens: 100,
      outputTokens: 5000,
      pointsMilli: 102000,
    });
    expect(num(usageBody.quotaUsedMilli)).toBe(102000);

    // 计量对账端点是运营面：账号 token 不得进入。
    const asUser = await tb.app.request(`/admin/accounts/${accountId}/chat-usage`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(asUser.status).toBe(401);

    // 任意档位充值 → 额度刷新 → 对话恢复并重新累计。
    const topup = await postJson(tb.app, '/admin/ledger/topup', {
      accountId, points: 500, note: '对公转账 ¥50',
    }, adminToken);
    expect(topup.status).toBe(200);
    const resumed = await postMessages(accessToken, message);
    expect(resumed.status).toBe(200);
    const after = (await (await tb.app.request(`/admin/accounts/${accountId}/chat-usage`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })).json()) as Record<string, unknown>;
    expect(after.records).toHaveLength(2);
    expect(num(after.quotaUsedMilli)).toBe(102000);
  });

  it('streams SSE through byte-for-byte (ping and tool_use untouched) and meters usage from message_delta', async () => {
    const fixture = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_s1","model":"deepseek-chat","usage":{"input_tokens":100,"output_tokens":1}}}',
      '',
      'event: ping',
      'data: {"type":"ping"}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_weather","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"北京\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5000}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const upstream = mockUpstream(() =>
      new Response(fixture, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({
      fetch: upstream.fetch,
      config: { chatInputCnyPerMtok: 2000, chatOutputCnyPerMtok: 2000 },
    });
    const { adminToken, accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const res = await postMessages(accessToken, {
      model: 'deepseek-chat', max_tokens: 64, stream: true,
      messages: [{ role: 'user', content: '北京天气' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // 输出与直连上游等价：ping、工具调用块、事件边界一字不差。
    expect(await res.text()).toBe(fixture);

    // 旁路计量从流上取数：message_start 的 input + message_delta 的 output。
    const usage = (await (await tb.app.request(`/admin/accounts/${accountId}/chat-usage`, {
      headers: { authorization: `Bearer ${adminToken}` },
    })).json()) as Record<string, unknown>;
    const records = usage.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      model: 'deepseek-chat',
      inputTokens: 100,
      outputTokens: 5000,
      pointsMilli: 102000,
    });
    expect(num(usage.quotaUsedMilli)).toBe(102000);
  });

  it('forwards stream chunks as they arrive without waiting for the upstream to finish', async () => {
    // 上游门控流：先只发 message_start + ping，等客户端真实收到后再发余下事件。
    // 若网关缓冲全文，postMessages 在门打开前不可能返回——用 race 兜底快速失败。
    const encoder = new TextEncoder();
    const firstChunk = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s2","model":"deepseek-chat","usage":{"input_tokens":10,"output_tokens":1}}}\n\nevent: ping\ndata: {"type":"ping"}\n\n';
    const restChunk = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    let upstreamEnded = false;
    const gate = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(firstChunk));
        await gate.promise;
        controller.enqueue(encoder.encode(restChunk));
        controller.close();
        upstreamEnded = true;
      },
    });
    const upstream = mockUpstream(() =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch });
    const { accessToken } = await provisionLoggedInAccount(tb.app);

    const resOrTimeout = await Promise.race([
      postMessages(accessToken, { model: 'deepseek-chat', max_tokens: 8, stream: true, messages: [] }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 1500)),
    ]);
    if (resOrTimeout === null) {
      gate.resolve();
      throw new Error('gateway buffered the SSE response: no bytes reached the client before upstream finished');
    }
    const reader = resOrTimeout.body!.getReader();
    const first = await reader.read();
    const firstText = new TextDecoder().decode(first.value);
    expect(firstText).toContain('message_start');
    expect(firstText).toContain('ping');
    // 客户端已收到首块时上游仍未结束：真正逐块转发。
    expect(upstreamEnded).toBe(false);
    gate.resolve();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('message_stop');
    expect(firstText + rest).toBe(firstChunk + restChunk);
  });

  it('passes upstream error status through but never leaks the upstream key or account token', async () => {
    const { accessToken } = await provisionLoggedInAccount(tb.app);

    // 上游错误体回显密钥与账号 token：状态码透传，正文必须清洗。
    const leaky = mockUpstream(() =>
      Response.json(
        { type: 'error', error: { type: 'api_error', message: `auth failed for ${TEST_DEEPSEEK_API_KEY} and ${accessToken}` } },
        { status: 500 },
      ),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: leaky.fetch });
    const { accessToken: freshToken } = await provisionLoggedInAccount(tb.app, '13800000002', 'initial-pass-2');
    const errored = await postMessages(freshToken, {
      model: 'deepseek-chat', max_tokens: 8, messages: [],
    });
    expect(errored.status).toBe(500);
    const erroredText = await errored.text();
    expect(erroredText).not.toContain(TEST_DEEPSEEK_API_KEY);
    expect(erroredText).not.toContain(freshToken);
    expect(JSON.parse(erroredText)).toMatchObject({ type: 'error' });

    // 非 JSON 错误体（HTML 网关页）含密钥 → 同样清洗，返回通用错误体。
    const html = mockUpstream(() =>
      new Response(`<html>bad gateway key=${TEST_DEEPSEEK_API_KEY}</html>`, {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    await tb.cleanup();
    tb = await startTestBackend({ fetch: html.fetch });
    const { accessToken: htmlToken } = await provisionLoggedInAccount(tb.app, '13800000003', 'initial-pass-3');
    const htmlRes = await postMessages(htmlToken, { model: 'deepseek-chat', max_tokens: 8, messages: [] });
    expect(htmlRes.status).toBe(502);
    const htmlText = await htmlRes.text();
    expect(htmlText).not.toContain(TEST_DEEPSEEK_API_KEY);
    expect(htmlText).not.toContain('<html>');
    expect(JSON.parse(htmlText)).toMatchObject({ error: { type: 'upstream_error' } });

    // 上游不可达（fetch 抛错，异常文案带密钥）→ 502 且不外泄。
    const exploding = (() => {
      const fetch = (async () => {
        throw new TypeError(`connect ECONNREFUSED with key ${TEST_DEEPSEEK_API_KEY}`);
      }) as typeof globalThis.fetch;
      return fetch;
    })();
    await tb.cleanup();
    tb = await startTestBackend({ fetch: exploding });
    const { accessToken: downToken } = await provisionLoggedInAccount(tb.app, '13800000004', 'initial-pass-4');
    const down = await postMessages(downToken, { model: 'deepseek-chat', max_tokens: 8, messages: [] });
    expect(down.status).toBe(502);
    const downText = await down.text();
    expect(downText).not.toContain(TEST_DEEPSEEK_API_KEY);
    expect(JSON.parse(downText)).toMatchObject({ error: 'upstream_unavailable' });
  });

  it('proxies count_tokens as a plain passthrough under the same conversation gates', async () => {
    const upstream = mockUpstream(() => Response.json({ input_tokens: 42 }));
    await tb.cleanup();
    tb = await startTestBackend({ fetch: upstream.fetch });
    const { adminToken, accountId, accessToken } = await provisionLoggedInAccount(tb.app);

    const counted = await postMessages(accessToken, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: '你好' }],
    }, '/v1/messages/count_tokens');
    expect(counted.status).toBe(200);
    expect(await counted.json()).toEqual({ input_tokens: 42 });
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.url).toBe('https://api.deepseek.com/anthropic/v1/messages/count_tokens');
    expect(upstream.calls[0]!.headers['x-api-key']).toBe(TEST_DEEPSEEK_API_KEY);
    expect(JSON.stringify(upstream.calls[0]!.headers)).not.toContain(accessToken);

    // count_tokens 不产生 token 消耗：不落旁路计量，也不动隐藏额度。
    const usage = await tb.app.request(`/admin/accounts/${accountId}/chat-usage`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(((await usage.json()) as Record<string, unknown>).records).toHaveLength(0);

    // 与 /v1/messages 同一对话闸门：余额为 0 → 拒绝并提示充值，不触上游。
    await postJson(tb.app, '/admin/ledger/adjust', { accountId, delta: -500, note: '清零' }, adminToken);
    const gated = await postMessages(accessToken, { model: 'deepseek-chat', messages: [] }, '/v1/messages/count_tokens');
    expect(gated.status).toBe(402);
    expect(await gated.json()).toMatchObject({ error: 'chat_balance_zero' });
    expect(upstream.calls).toHaveLength(1);
  });
});

/** mock 上游收到的请求形状。 */
interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
