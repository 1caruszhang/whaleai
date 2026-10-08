import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getJson,
  loginAccount,
  postJson,
  provisionAccount,
  startTestBackend,
  str,
  type TestBackend,
} from './helpers';

/**
 * 账号核心 HTTP 合约（票 02 验收）：
 * 建号 → 登录 → 首登改密 → 重新登录；refresh 轮换与重用吊销；
 * 错误密码 / 停用账号 / 改密后旧 JWT 的边界；迁移建表幂等。
 * 全部走 app.request() + 临时 SQLite，不触真实网络。
 */
describe('account core HTTP contract', () => {
  let tb: TestBackend;

  beforeEach(async () => {
    tb = await startTestBackend();
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('walks 建号 → 登录 → 首登改密 → 重新登录 end to end', async () => {
    const { app, db } = tb;
    await provisionAccount(app, '13800000001', 'initial-pass-1');

    // 建号即赠 500 点并产生赠送流水。
    const grant = db.get<{ delta: number; balance_after: number; kind: string; note: string }>(
      'SELECT delta, balance_after, kind, note FROM ledger_entries',
      [],
    );
    expect(grant).toMatchObject({ delta: 500, balance_after: 500, kind: 'grant' });

    // 登录成功，返回 token 对与首登改密标记。
    const login = await loginAccount(app, '13800000001', 'initial-pass-1');
    expect(login.status).toBe(200);
    const accessToken = str(login.body.accessToken);
    const refreshToken = str(login.body.refreshToken);
    expect(login.body.tokenType).toBe('Bearer');
    expect(login.body.expiresIn).toBe(tb.config.accessTokenTtlSeconds);
    expect(login.body.account).toMatchObject({
      phone: '13800000001',
      mustChangePassword: true,
      points: 500,
      status: 'active',
    });

    const me = await getJson(app, '/auth/me', accessToken);
    expect(me.status).toBe(200);
    expect(me.body.account).toMatchObject({ phone: '13800000001', points: 500 });

    // 当前密码错误 → 401。
    const wrongCurrent = await postJson(app, '/auth/change-password', {
      currentPassword: 'not-the-password',
      newPassword: 'brand-new-pass-9',
    }, accessToken);
    expect(wrongCurrent.status).toBe(401);
    expect(wrongCurrent.body.error).toBe('invalid_credentials');

    // 新密码过短 → 400。
    const tooShort = await postJson(app, '/auth/change-password', {
      currentPassword: 'initial-pass-1',
      newPassword: 'short',
    }, accessToken);
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.error).toBe('validation_error');

    // 改密成功：返回全新 token 对，首登标记清除。
    const changed = await postJson(app, '/auth/change-password', {
      currentPassword: 'initial-pass-1',
      newPassword: 'brand-new-pass-9',
    }, accessToken);
    expect(changed.status).toBe(200);
    const newAccessToken = str(changed.body.accessToken);
    const newRefreshToken = str(changed.body.refreshToken);
    expect(newAccessToken).not.toBe(accessToken);
    expect(newRefreshToken).not.toBe(refreshToken);
    expect(changed.body.account).toMatchObject({ mustChangePassword: false, points: 500 });

    // 边界：改密后旧 JWT 立即失效（stale_token），旧 refresh 也已吊销。
    const meWithOldJwt = await getJson(app, '/auth/me', accessToken);
    expect(meWithOldJwt.status).toBe(401);
    expect(meWithOldJwt.body.error).toBe('stale_token');
    const refreshWithOld = await postJson(app, '/auth/refresh', { refreshToken });
    expect(refreshWithOld.status).toBe(401);
    expect(refreshWithOld.body.error).toBe('invalid_refresh');

    // 新 token 对可用。
    const meWithNew = await getJson(app, '/auth/me', newAccessToken);
    expect(meWithNew.status).toBe(200);

    // 重新登录：初始密码已失效，新密码可用且不再要求改密。
    const reloginOld = await loginAccount(app, '13800000001', 'initial-pass-1');
    expect(reloginOld.status).toBe(401);
    expect(reloginOld.body.error).toBe('invalid_credentials');
    const relogin = await loginAccount(app, '13800000001', 'brand-new-pass-9');
    expect(relogin.status).toBe(200);
    expect(relogin.body.account).toMatchObject({ mustChangePassword: false });
  });

  it('rotates refresh tokens and revokes the whole session on reuse', async () => {
    const { app, db } = tb;
    await provisionAccount(app, '13800000002', 'initial-pass-2');
    const login = await loginAccount(app, '13800000002', 'initial-pass-2');
    const rt1 = str(login.body.refreshToken);

    // 正常轮换：拿到新 token 对，旧 token 被替换。同一秒内重签的
    // access JWT 字节可能相同（HS256 确定性签名、iat 按秒），只断言可用性。
    const rotated = await postJson(app, '/auth/refresh', { refreshToken: rt1 });
    expect(rotated.status).toBe(200);
    const rt2 = str(rotated.body.refreshToken);
    const at2 = str(rotated.body.accessToken);
    expect(rt2).not.toBe(rt1);
    expect((await getJson(app, '/auth/me', at2)).status).toBe(200);

    // 重用检测：旧 refresh 再次出现 → 吊销整个会话。
    const reuse = await postJson(app, '/auth/refresh', { refreshToken: rt1 });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('refresh_reuse_detected');

    // 吊销后连最新一环 rt2 也失效，只能重新登录。
    const rt2AfterReuse = await postJson(app, '/auth/refresh', { refreshToken: rt2 });
    expect(rt2AfterReuse.status).toBe(401);
    expect(rt2AfterReuse.body.error).toBe('invalid_refresh');

    // 决策语义：会话吊销只杀 refresh；JWT 依赖自身过期（决策票 12）。
    const meAfterReuse = await getJson(app, '/auth/me', at2);
    expect(meAfterReuse.status).toBe(200);

    const session = db.get<{ revoked_at: string | null; revoked_reason: string | null }>(
      'SELECT revoked_at, revoked_reason FROM auth_sessions',
      [],
    );
    expect(session?.revoked_at).toBeTruthy();
    expect(session?.revoked_reason).toBe('refresh_reuse');
  });

  it('rejects wrong password and unknown phone without creating sessions', async () => {
    const { app, db } = tb;
    await provisionAccount(app, '13800000003', 'initial-pass-3');

    const wrong = await loginAccount(app, '13800000003', 'wrong-password');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_credentials');

    const unknown = await loginAccount(app, '13999999999', 'whatever-pass');
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe('invalid_credentials');

    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM auth_sessions', [])?.count).toBe(0);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM refresh_tokens', [])?.count).toBe(0);
  });

  it('treats disabled accounts as blocked at login, JWT and refresh boundaries', async () => {
    const { app, db } = tb;
    await provisionAccount(app, '13800000004', 'initial-pass-4');
    const login = await loginAccount(app, '13800000004', 'initial-pass-4');
    expect(login.status).toBe(200);
    const accessToken = str(login.body.accessToken);
    const refreshToken = str(login.body.refreshToken);

    db.run("UPDATE accounts SET status = 'disabled' WHERE phone = ?", ['13800000004']);

    const loginAgain = await loginAccount(app, '13800000004', 'initial-pass-4');
    expect(loginAgain.status).toBe(403);
    expect(loginAgain.body.error).toBe('account_disabled');

    // 停用账号上密码对错都得到同一 403，不存在密码预言机。
    const loginWrongPassword = await loginAccount(app, '13800000004', 'wrong-password-8');
    expect(loginWrongPassword.status).toBe(403);
    expect(loginWrongPassword.body.error).toBe('account_disabled');

    const me = await getJson(app, '/auth/me', accessToken);
    expect(me.status).toBe(403);
    expect(me.body.error).toBe('account_disabled');

    const refresh = await postJson(app, '/auth/refresh', { refreshToken });
    expect(refresh.status).toBe(403);
    expect(refresh.body.error).toBe('account_disabled');
  });

  it('expires refresh tokens after the sliding window elapses', async () => {
    // jose 按真实时钟校验 JWT，所以假时钟锚点取当前时刻再向未来推进。
    const t0 = Date.now();
    const tb2 = await startTestBackend({ initialNowMs: t0 });
    try {
      await provisionAccount(tb2.app, '13800000005', 'initial-pass-5');
      const login = await loginAccount(tb2.app, '13800000005', 'initial-pass-5');
      const refreshToken = str(login.body.refreshToken);

      // 窗口内轮换会滑动续期。
      tb2.setNow(t0 + 20 * 24 * 60 * 60 * 1000);
      const rotated = await postJson(tb2.app, '/auth/refresh', { refreshToken });
      expect(rotated.status).toBe(200);
      const rotatedToken = str(rotated.body.refreshToken);

      // 超过 30 天未接触 → refresh_expired。
      tb2.setNow(t0 + 20 * 24 * 60 * 60 * 1000 + 30 * 24 * 60 * 60 * 1000 + 1000);
      const expired = await postJson(tb2.app, '/auth/refresh', { refreshToken: rotatedToken });
      expect(expired.status).toBe(401);
      expect(expired.body.error).toBe('refresh_expired');
    } finally {
      await tb2.cleanup();
    }
  });

  it('lets access JWTs die naturally at their own TTL', async () => {
    const tb2 = await startTestBackend({ config: { accessTokenTtlSeconds: 1 } });
    try {
      await provisionAccount(tb2.app, '13800000006', 'initial-pass-6');
      const login = await loginAccount(tb2.app, '13800000006', 'initial-pass-6');
      const accessToken = str(login.body.accessToken);

      expect((await getJson(tb2.app, '/auth/me', accessToken)).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 1300));
      const expired = await getJson(tb2.app, '/auth/me', accessToken);
      expect(expired.status).toBe(401);
      expect(expired.body.error).toBe('token_expired');
    } finally {
      await tb2.cleanup();
    }
  });

  it('guards /admin endpoints and duplicate phone creation', async () => {
    const { app } = tb;

    const wrongOps = await postJson(app, '/admin/login', { password: 'not-the-ops-password' });
    expect(wrongOps.status).toBe(401);
    expect(wrongOps.body.error).toBe('invalid_credentials');

    const noToken = await postJson(app, '/admin/accounts', {
      phone: '13800000007',
      initialPassword: 'initial-pass-7',
    });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toBe('invalid_token');

    // 用户 access token 不能当运营凭证用（audience 隔离）。
    await provisionAccount(app, '13800000007', 'initial-pass-7');
    const userLogin = await loginAccount(app, '13800000007', 'initial-pass-7');
    const crossUse = await postJson(app, '/admin/accounts', {
      phone: '13800000008',
      initialPassword: 'initial-pass-8',
    }, str(userLogin.body.accessToken));
    expect(crossUse.status).toBe(401);
    expect(crossUse.body.error).toBe('invalid_token');

    // 重复手机号 → 409；弱初始密码 → 400。
    const adminLogin = await postJson(app, '/admin/login', { password: 'ops-password-123' });
    const adminToken = str(adminLogin.body.adminToken);
    const duplicate = await postJson(app, '/admin/accounts', {
      phone: '13800000007',
      initialPassword: 'another-pass-77',
    }, adminToken);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('phone_taken');

    const weak = await postJson(app, '/admin/accounts', {
      phone: '13800000008',
      initialPassword: 'short',
    }, adminToken);
    expect(weak.status).toBe(400);
    expect(weak.body.error).toBe('validation_error');

    const badPhone = await postJson(app, '/admin/accounts', {
      phone: 'not-a-phone',
      initialPassword: 'initial-pass-8',
    }, adminToken);
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error).toBe('validation_error');
  });

  it('revokes the session on logout while the JWT keeps its natural window', async () => {
    const { app } = tb;
    await provisionAccount(app, '13800000009', 'initial-pass-9');
    const login = await loginAccount(app, '13800000009', 'initial-pass-9');
    const refreshToken = str(login.body.refreshToken);
    const accessToken = str(login.body.accessToken);

    const logout = await postJson(app, '/auth/logout', { refreshToken }, accessToken);
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);

    const refreshAfterLogout = await postJson(app, '/auth/refresh', { refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
    expect(refreshAfterLogout.body.error).toBe('invalid_refresh');

    expect((await getJson(app, '/auth/me', accessToken)).status).toBe(200);
  });

  it('answers healthz and rejects malformed bodies', async () => {
    const { app } = tb;
    const health = await app.request('/healthz');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const root = await app.request('/');
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({
      service: 'xiaojing-api',
      admin: '/admin',
      health: '/healthz',
    });

    const badJson = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as Record<string, unknown>).error).toBe('invalid_json');

    const missing = await postJson(app, '/auth/refresh', {});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('validation_error');

    const unknownRefresh = await postJson(app, '/auth/refresh', { refreshToken: 'xr_totally-unknown-token' });
    expect(unknownRefresh.status).toBe(401);
    expect(unknownRefresh.body.error).toBe('invalid_refresh');
  });
});
