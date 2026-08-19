import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  flattenSupermediaParams,
  supermediaHmacSha256,
} from '../src/gateway/provider-signing';
import type { BackendEnv } from '../src/http/app';
import {
  getJson,
  loginAccount,
  postJson,
  startTestBackend,
  str,
  TEST_ADMIN_PASSWORD,
  TEST_DISTRIBUTION_APP_ID,
  TEST_DISTRIBUTION_SECRET,
  type TestBackend,
} from './helpers';

/**
 * 票 10 验收：/admin 运营台 SSR 页面。全部走 Hono app.request 的 HTTP
 * 合约边界（表单 POST / PRG 303 / cookie 会话 / HTML 转义），超级媒介
 * /profile 用 mock 上游（签名参数逐字段断言），不触真实网络与真实密钥。
 * 真实媒介冒烟属票 12 生产部署环节，不在本票。
 */

/** mock 超级媒介 /profile：记录请求形态，返回可配置的 envelope。 */
function profileUpstream(
  data: unknown,
  options?: { envelopeCode?: number; httpStatus?: number; throwNetwork?: boolean },
) {
  const calls: { method: string; path: string; params: URLSearchParams }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      path: url.pathname.replace(/^\/api/, ''),
      params: url.searchParams,
    });
    if (options?.throwNetwork) throw new TypeError('mock network unreachable');
    return Response.json(
      { code: options?.envelopeCode ?? 200, message: 'ok', data },
      { status: options?.httpStatus ?? 200 },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function postForm(
  app: Hono<BackendEnv>,
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  return await app.request(path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

async function getHtml(app: Hono<BackendEnv>, path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return await app.request(path, { headers });
}

/** 运营密码登录（页面流）：成功返回可直接用的 Cookie 键值对。 */
async function pageLogin(app: Hono<BackendEnv>): Promise<{ cookie: string; setCookie: string }> {
  const response = await postForm(app, '/admin/session', { password: TEST_ADMIN_PASSWORD });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/admin');
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).not.toBe('');
  return { cookie: setCookie.split(';')[0], setCookie };
}

describe('admin console SSR pages', () => {
  let tb: TestBackend;

  beforeEach(async () => {
    tb = await startTestBackend({
      // 仪表盘渲染会代理 /profile：一律注入 mock 上游，测试不触真实网络。
      fetch: profileUpstream({ money: '1280.00' }).fetch,
      config: { adminLoginThrottleUnitMs: 1 },
    });
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('walks 建号 → 充值确认 → 调点 → 查流水 entirely through page operations', async () => {
    const { app, db } = tb;

    // 未登录：/admin 渲染登录页（HTML、无面板内容）。
    const loginPage = await getHtml(app, '/admin');
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers.get('content-type')).toContain('text/html');
    const loginBody = await loginPage.text();
    expect(loginBody).toContain('action="/admin/session"');
    expect(loginBody).toContain('运营密码');
    expect(loginBody).not.toContain('建号');

    // 登录成功：303 PRG + HttpOnly;SameSite=Lax 会话 cookie。
    const { cookie, setCookie } = await pageLogin(app);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain(`Max-Age=${tb.config.adminTokenTtlSeconds}`);

    // 仪表盘：媒介池余额实测值 + 账号列表 + 建号表单。
    const dash = await getHtml(app, '/admin', cookie);
    expect(dash.status).toBe(200);
    const dashBody = await dash.text();
    expect(dashBody).toContain('超级媒介资金池');
    expect(dashBody).toContain('¥1280.00');
    expect(dashBody).toContain('建号（开通即赠 500 点）');
    expect(dashBody).toContain('还没有账号');

    // 建号（页面表单）：303 回仪表盘，落账号 + 500 点赠送流水。
    const created = await postForm(app, '/admin/ui/accounts', {
      phone: '13800000123',
      initialPassword: 'initial-pass-1',
    }, cookie);
    expect(created.status).toBe(303);
    expect(created.headers.get('location')).toBe('/admin');
    const account = db.get<{ id: string; balance: number }>(
      'SELECT id, balance FROM accounts WHERE phone = ?',
      ['13800000123'],
    );
    expect(account).toMatchObject({ balance: 500 });
    expect(
      db.get<{ delta: number; kind: string; note: string }>(
        'SELECT delta, kind, note FROM ledger_entries WHERE account_id = ?',
        [account!.id],
      ),
    ).toMatchObject({ delta: 500, kind: 'grant', note: '开通赠送' });

    // 仪表盘出现新账号行与详情入口。
    const dashAfterCreate = await (await getHtml(app, '/admin', cookie)).text();
    expect(dashAfterCreate).toContain('13800000123');
    expect(dashAfterCreate).toContain(`/admin/accounts/${account!.id}`);

    // 充值确认（金额元 + 来源备注）：1 元 = 10 点，金额与备注同落流水。
    const topup = await postForm(
      app,
      `/admin/ui/accounts/${account!.id}/topup`,
      { amountYuan: '200', note: '对公转账 8/19 截图 #A-1024' },
      cookie,
    );
    expect(topup.status).toBe(303);
    expect(topup.headers.get('location')).toBe(`/admin/accounts/${account!.id}`);
    expect(
      db.get<{ delta: number; kind: string; note: string; balance_after: number }>(
        'SELECT delta, kind, note, balance_after FROM ledger_entries WHERE account_id = ? AND kind = ?',
        [account!.id, 'topup'],
      ),
    ).toMatchObject({
      delta: 2000,
      note: '充值 ¥200.00：对公转账 8/19 截图 #A-1024',
      balance_after: 2500,
    });

    // 调点（带备注）：负向调整只动可用余额。
    const adjust = await postForm(
      app,
      `/admin/ui/accounts/${account!.id}/adjust`,
      { delta: '-150', note: '内测活动补偿' },
      cookie,
    );
    expect(adjust.status).toBe(303);
    expect(
      db.get<{ delta: number; kind: string; note: string }>(
        'SELECT delta, kind, note FROM ledger_entries WHERE account_id = ? AND kind = ?',
        [account!.id, 'adjust'],
      ),
    ).toMatchObject({ delta: -150, note: '内测活动补偿' });
    expect(
      db.get<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?', [account!.id]),
    ).toMatchObject({ balance: 2350 });

    // 查流水：账号详情页服务端渲染全部流水与对账面。
    const detail = await getHtml(app, `/admin/accounts/${account!.id}`, cookie);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('content-type')).toContain('text/html');
    const detailBody = await detail.text();
    expect(detailBody).toContain('点数流水');
    expect(detailBody).toContain('充值 ¥200.00：对公转账 8/19 截图 #A-1024');
    expect(detailBody).toContain('内测活动补偿');
    expect(detailBody).toContain('+2000');
    expect(detailBody).toContain('-150');
    expect(detailBody).toContain('总余额 <strong>2350</strong>');
    expect(detailBody).toContain('计费操作（permit）');
    expect(detailBody).toContain('发布订单');
    expect(detailBody).toContain('Provider 计量');
    expect(detailBody).toContain('对话计量');
  });

  it('disables and re-enables accounts from the page and revokes sessions immediately', async () => {
    const { app, db } = tb;
    const { cookie } = await pageLogin(app);
    await postForm(app, '/admin/ui/accounts', {
      phone: '13800000234',
      initialPassword: 'initial-pass-2',
    }, cookie);
    const account = db.get<{ id: string }>('SELECT id FROM accounts WHERE phone = ?', [
      '13800000234',
    ])!;
    expect((await loginAccount(app, '13800000234', 'initial-pass-2')).status).toBe(200);

    // 停用：303 回仪表盘，状态与全部会话立即失效。
    const disabled = await postForm(
      app,
      `/admin/ui/accounts/${account.id}/status`,
      { status: 'disabled' },
      cookie,
    );
    expect(disabled.status).toBe(303);
    expect(disabled.headers.get('location')).toBe('/admin');
    expect(
      db.get<{ status: string }>('SELECT status FROM accounts WHERE id = ?', [account.id]),
    ).toMatchObject({ status: 'disabled' });
    const session = db.get<{ revoked_at: string | null; revoked_reason: string | null }>(
      'SELECT revoked_at, revoked_reason FROM auth_sessions WHERE account_id = ?',
      [account.id],
    );
    expect(session?.revoked_at).toBeTruthy();
    expect(session?.revoked_reason).toBe('admin_disabled');
    expect((await loginAccount(app, '13800000234', 'initial-pass-2')).status).toBe(403);

    // 仪表盘标记已停用；重新启用后登录恢复。
    const dash = await (await getHtml(app, '/admin', cookie)).text();
    expect(dash).toContain('已停用');
    const enabled = await postForm(
      app,
      `/admin/ui/accounts/${account.id}/status`,
      { status: 'active' },
      cookie,
    );
    expect(enabled.status).toBe(303);
    expect((await loginAccount(app, '13800000234', 'initial-pass-2')).status).toBe(200);
  });

  it('shows the measured media pool balance via a signed /profile proxy and warns below the threshold', async () => {
    const mock = profileUpstream({ money: '320.50' });
    const tbLow = await startTestBackend({ fetch: mock.fetch, config: { adminLoginThrottleUnitMs: 1 } });
    try {
      const { cookie } = await pageLogin(tbLow.app);
      const dash = await (await getHtml(tbLow.app, '/admin', cookie)).text();
      expect(dash).toContain('¥320.50');
      expect(dash).toContain('媒介池余额低于 ¥500.00，请及时预存资金池。');

      // 合约：GET /profile 公共参数齐全，签名 = 展平串 HMAC-SHA256(secret)。
      expect(mock.calls).toHaveLength(1);
      const call = mock.calls[0]!;
      expect(call.method).toBe('GET');
      expect(call.path).toBe('/profile');
      expect(call.params.get('appid')).toBe(TEST_DISTRIBUTION_APP_ID);
      expect(call.params.get('algorithm')).toBe('sha256');
      expect(call.params.get('timestamp')).toMatch(/^\d{10}$/);
      const keys = [...call.params.keys()].sort();
      expect(keys).toEqual(['algorithm', 'appid', 'signature', 'timestamp']);
      const params = Object.fromEntries(call.params.entries());
      const { signature, ...signed } = params;
      expect(signature).toBe(supermediaHmacSha256(TEST_DISTRIBUTION_SECRET, flattenSupermediaParams(signed)));
    } finally {
      await tbLow.cleanup();
    }
  });

  it('stays quiet above the threshold, honors the env threshold, and degrades when /profile fails', async () => {
    // 高于默认阈值：无提醒。
    const tbOk = await startTestBackend({
      fetch: profileUpstream({ money: '1280.00' }).fetch,
      config: { adminLoginThrottleUnitMs: 1 },
    });
    try {
      const { cookie } = await pageLogin(tbOk.app);
      const dash = await (await getHtml(tbOk.app, '/admin', cookie)).text();
      expect(dash).toContain('¥1280.00');
      expect(dash).not.toContain('低于');
    } finally {
      await tbOk.cleanup();
    }

    // 阈值经配置可调（ADMIN_MEDIA_POOL_LOW_BALANCE_CNY → ¥2000）。
    const tbThreshold = await startTestBackend({
      fetch: profileUpstream({ money: '1280.00' }).fetch,
      config: { adminLoginThrottleUnitMs: 1, adminMediaPoolLowBalanceCents: 200_000 },
    });
    try {
      const { cookie } = await pageLogin(tbThreshold.app);
      const dash = await (await getHtml(tbThreshold.app, '/admin', cookie)).text();
      expect(dash).toContain('媒介池余额低于 ¥2000.00，请及时预存资金池。');
    } finally {
      await tbThreshold.cleanup();
    }

    // 上游业务失败 / 网络不可达：余额卡降级，页面其余部分照常渲染。
    for (const degraded of [
      profileUpstream({}, { envelopeCode: 500 }),
      profileUpstream({}, { throwNetwork: true }),
    ]) {
      const tbDown = await startTestBackend({
        fetch: degraded.fetch,
        config: { adminLoginThrottleUnitMs: 1 },
      });
      try {
        const { cookie } = await pageLogin(tbDown.app);
        const dash = await getHtml(tbDown.app, '/admin', cookie);
        expect(dash.status).toBe(200);
        const body = await dash.text();
        expect(body).toContain('余额获取失败');
        expect(body).toContain('建号（开通即赠 500 点）');
      } finally {
        await tbDown.cleanup();
      }
    }
  });

  it('blocks every /admin page and action without the ops-password session', async () => {
    const { app, db } = tb;
    const { cookie } = await pageLogin(app);
    await postForm(app, '/admin/ui/accounts', {
      phone: '13800000999',
      initialPassword: 'initial-pass-9',
    }, cookie);
    const account = db.get<{ id: string }>('SELECT id FROM accounts WHERE phone = ?', [
      '13800000999',
    ])!;
    const accountsBefore = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts', [])!
      .count;
    const ledgerBefore = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_entries', [])!
      .count;

    // 登录页不泄露任何账号数据。
    const anonymous = await (await getHtml(app, '/admin')).text();
    expect(anonymous).toContain('运营密码');
    expect(anonymous).not.toContain('13800000999');

    // 详情页与全部表单动作未登录一律 303 回登录页，且不产生任何写。
    const detail = await getHtml(app, `/admin/accounts/${account.id}`);
    expect(detail.status).toBe(303);
    expect(detail.headers.get('location')).toBe('/admin');
    for (const [path, fields] of [
      ['/admin/ui/accounts', { phone: '13800000888', initialPassword: 'initial-pass-8' }],
      [`/admin/ui/accounts/${account.id}/status`, { status: 'disabled' }],
      [`/admin/ui/accounts/${account.id}/topup`, { amountYuan: '500', note: 'x' }],
      [`/admin/ui/accounts/${account.id}/adjust`, { delta: '10', note: 'x' }],
    ] as const) {
      const blocked = await postForm(app, path, { ...fields });
      expect(blocked.status).toBe(303);
      expect(blocked.headers.get('location')).toBe('/admin');
    }
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts', [])!.count).toBe(
      accountsBefore,
    );
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_entries', [])!.count).toBe(
      ledgerBefore,
    );

    // 用户 access token（客户端 audience）塞进运营 cookie 不构成会话。
    const userLogin = await loginAccount(app, '13800000999', 'initial-pass-9');
    const crossUse = await getHtml(app, '/admin', `xiaojing_admin=${str(userLogin.body.accessToken)}`);
    const crossUseBody = await crossUse.text();
    expect(crossUseBody).toContain('运营密码');
    expect(crossUseBody).not.toContain('13800000999');

    // 错误密码：401、无会话 cookie、错误提示、不进面板。
    const wrong = await postForm(app, '/admin/session', { password: 'not-the-ops-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    const wrongBody = await wrong.text();
    expect(wrongBody).toContain('运营密码不正确');
    expect(wrongBody).not.toContain('建号');

    // 登出清 cookie（Max-Age=0）；既有 JSON 运营 API 的 Bearer 门不变。
    const logout = await postForm(app, '/admin/logout', {}, cookie);
    expect(logout.status).toBe(303);
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    const jsonNoToken = await postJson(app, '/admin/accounts', {
      phone: '13800000777',
      initialPassword: 'initial-pass-7',
    });
    expect(jsonNoToken.status).toBe(401);
    expect(jsonNoToken.body.error).toBe('invalid_token');
    const jsonLogin = await postJson(app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
    expect(jsonLogin.status).toBe(200);
    expect((await getJson(app, `/admin/accounts/${account.id}/ledger`, str(jsonLogin.body.adminToken))).status).toBe(200);
  });

  it('throttles wrong ops-password attempts without ever locking the right one out', async () => {
    const { app } = tb;
    // beforeEach 注入 adminLoginThrottleUnitMs=1：连续失败递增延时（1ms 步长）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await postForm(app, '/admin/session', { password: `wrong-${attempt}` });
      expect(wrong.status).toBe(401);
      const wrongJson = await postJson(app, '/admin/login', { password: `wrong-${attempt}` });
      expect(wrongJson.status).toBe(401);
    }
    // 节流只延时不断锁：页面与 JSON 登录随后仍可用正确密码成功。
    const { cookie } = await pageLogin(app);
    expect(cookie).toContain('xiaojing_admin=');
    const jsonOk = await postJson(app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
    expect(jsonOk.status).toBe(200);
  });

  it('renders server-side HTML only: doctype shell, no client-side script, no frontend build', async () => {
    const { app, db } = tb;
    const { cookie } = await pageLogin(app);
    await postForm(app, '/admin/ui/accounts', {
      phone: '13800000345',
      initialPassword: 'initial-pass-3',
    }, cookie);
    const account = db.get<{ id: string }>('SELECT id FROM accounts WHERE phone = ?', [
      '13800000345',
    ])!;
    const errorPage = await getHtml(app, '/admin/accounts/not-a-real-id', cookie);
    // 表单动作带非法 accountId：HTML 404 错误页（不是全局 onError 的 JSON 500）。
    const badIdTopup = await postForm(
      app,
      '/admin/ui/accounts/not-a-real-id/topup',
      { amountYuan: '100', note: 'x' },
      cookie,
    );
    expect(badIdTopup.status).toBe(404);
    expect(badIdTopup.headers.get('content-type')).toContain('text/html');

    for (const response of [
      await getHtml(app, '/admin'),
      await getHtml(app, '/admin', cookie),
      await getHtml(app, `/admin/accounts/${account.id}`, cookie),
      errorPage,
    ]) {
      expect(response.status).toBeLessThan(500);
      expect(response.headers.get('content-type')).toContain('text/html');
      const body = await response.text();
      expect(body.startsWith('<!doctype html>')).toBe(true);
      expect(body).not.toMatch(/<script/i);
    }
  });

  it('escapes operator-supplied free text everywhere it is echoed back', async () => {
    const { app, db } = tb;
    const { cookie } = await pageLogin(app);
    await postForm(app, '/admin/ui/accounts', {
      phone: '13800000456',
      initialPassword: 'initial-pass-4',
    }, cookie);
    const account = db.get<{ id: string }>('SELECT id FROM accounts WHERE phone = ?', [
      '13800000456',
    ])!;

    // 备注里的 HTML 全部落库原文、回显全转义。
    const topup = await postForm(
      app,
      `/admin/ui/accounts/${account.id}/topup`,
      { amountYuan: '100', note: `<script>alert('x')</script> & "转账"` },
      cookie,
    );
    expect(topup.status).toBe(303);
    expect(
      db.get<{ note: string }>('SELECT note FROM ledger_entries WHERE account_id = ? AND kind = ?', [
        account.id,
        'topup',
      ]),
    ).toMatchObject({ note: `充值 ¥100.00：<script>alert('x')</script> & "转账"` });
    await postForm(
      app,
      `/admin/ui/accounts/${account.id}/adjust`,
      { delta: '-5', note: '<img src=x onerror=alert(1)>' },
      cookie,
    );
    const detail = await (await getHtml(app, `/admin/accounts/${account.id}`, cookie)).text();
    expect(detail).toContain('&lt;script&gt;');
    expect(detail).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(detail).not.toContain('<script');
    expect(detail).not.toContain('<img');

    // 非法手机号（含注入载荷）不建号，返回 400 错误页（正文转义）。
    const before = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts', [])!.count;
    const badPhone = await postForm(app, '/admin/ui/accounts', {
      phone: '<svg onload=alert(1)>',
      initialPassword: 'initial-pass-4',
    }, cookie);
    expect(badPhone.status).toBe(400);
    expect(await badPhone.text()).toContain('手机号格式不正确');
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts', [])!.count).toBe(
      before,
    );

    // 充值金额粒度/形态校验：拒绝后不落任何流水。
    const ledgerBefore = db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id = ?',
      [account.id],
    )!.count;
    for (const amountYuan of ['10.55', '0', '-5', 'abc']) {
      const rejected = await postForm(
        app,
        `/admin/ui/accounts/${account.id}/topup`,
        { amountYuan, note: '形态校验' },
        cookie,
      );
      expect(rejected.status).toBe(400);
    }
    const zeroDelta = await postForm(
      app,
      `/admin/ui/accounts/${account.id}/adjust`,
      { delta: '0', note: '零调整' },
      cookie,
    );
    expect(zeroDelta.status).toBe(400);
    expect(
      db.get<{ count: number }>('SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id = ?', [
        account.id,
      ])!.count,
    ).toBe(ledgerBefore);
  });
});
