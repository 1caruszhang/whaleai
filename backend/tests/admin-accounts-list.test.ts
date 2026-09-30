import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrateDatabase } from '../src/db/migrations';
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
 * 票 47 验收：账号列表 JSON 接口 + 迁移 0014 + 建号用户名 + 停用端点。
 * 全部走 startTestBackend 的 HTTP 合约 seam（临时 SQLite + 假时钟，无真实
 * 网络）。假时钟（initialNowMs/setNow）定死建号/登录时间戳，排序与最近
 * 活跃断言因此确定。
 */

const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');

interface CreatedAccount {
  accountId: string;
  phone: string;
}

/** 用 JSON 建号（可选用户名），返回账号 id。 */
async function createAccount(
  app: TestBackend['app'],
  adminToken: string,
  phone: string,
  password: string,
  displayName?: string,
): Promise<CreatedAccount> {
  const body: Record<string, string> = { phone, initialPassword: password };
  if (displayName !== undefined) body.displayName = displayName;
  const created = await postJson(app, '/admin/accounts', body, adminToken);
  if (created.status !== 201) {
    throw new Error(`create account failed: ${JSON.stringify(created)}`);
  }
  const account = created.body.account as { id: string };
  return { accountId: account.id, phone };
}

async function opsToken(app: TestBackend['app']): Promise<string> {
  const login = await postJson(app, '/admin/login', { password: 'ops-password-123' });
  if (login.status !== 200) throw new Error(`ops login failed: ${JSON.stringify(login)}`);
  return str(login.body.adminToken);
}

/** 直插一条 open permit 造冻结（走既有冻结口径：permit 与订单两条通道）。 */
function insertFrozenPermit(tb: TestBackend, accountId: string, frozen: number): void {
  const nowIso = new Date().toISOString();
  tb.db.run(
    `INSERT INTO billing_permits (id, account_id, operation, units, unit_price, base_price, frozen_remaining, status, created_at, last_activity_at)
     VALUES (?, ?, 'article_generation', 1, 0, 0, ?, 'open', ?, ?)`,
    [`permit-frozen-${accountId}`, accountId, frozen, nowIso, nowIso],
  );
}

function topup(app: TestBackend['app'], adminToken: string, accountId: string, points: number) {
  return postJson(
    app,
    '/admin/ledger/topup',
    { accountId, points, note: '测试充值' },
    adminToken,
  );
}

describe('迁移 0014_account_profile_fields', () => {
  it('注册表 append-only、名称唯一、0014 为最新条目', () => {
    const names = MIGRATIONS.map(migration => migration.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names[names.length - 1]).toBe('0014_account_profile_fields');
  });

  it('幂等：再次 migrate 不重复应用任何迁移', async () => {
    const tb = await startTestBackend();
    try {
      expect(migrateDatabase(tb.db)).toEqual([]);
      const applied = tb.db
        .all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name', [])
        .map(row => row.name);
      expect(applied).toContain('0014_account_profile_fields');
      expect(applied.filter(name => name === '0014_account_profile_fields')).toHaveLength(1);
    } finally {
      await tb.cleanup();
    }
  });

  it('accounts.display_name 默认空串且 CHECK ≤64；account_brands 非空/≤64/复合主键', async () => {
    const tb = await startTestBackend();
    try {
      const { accountId } = await provisionAccount(tb.app);
      expect(
        tb.db.get<{ display_name: string }>('SELECT display_name FROM accounts WHERE id = ?', [
          accountId,
        ]),
      ).toMatchObject({ display_name: '' });

      // 65 字符用户名被表结构拒绝（路由 schema 之外的第二道护栏）。
      expect(() =>
        tb.db.run('UPDATE accounts SET display_name = ? WHERE id = ?', ['x'.repeat(65), accountId]),
      ).toThrow();
      tb.db.run('UPDATE accounts SET display_name = ? WHERE id = ?', ['x'.repeat(64), accountId]);

      // 品牌行：正常写入；空名/超长名被 CHECK 拒绝；同 workspace 覆盖被 PK 拒绝。
      tb.db.run('INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)', [
        accountId,
        'ws-1',
        '鲸杉示范品牌',
      ]);
      expect(() =>
        tb.db.run('INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)', [
          accountId,
          'ws-2',
          '',
        ]),
      ).toThrow();
      expect(() =>
        tb.db.run('INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)', [
          accountId,
          'ws-3',
          'x'.repeat(65),
        ]),
      ).toThrow();
      expect(() =>
        tb.db.run('INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)', [
          accountId,
          'ws-1',
          '另一个品牌',
        ]),
      ).toThrow();
      expect(
        tb.db
          .all<{ count: number }>('SELECT COUNT(*) AS count FROM account_brands', [])
          .at(0)?.count,
      ).toBe(1);
    } finally {
      await tb.cleanup();
    }
  });
});

describe('GET /admin/accounts 列表接口（票 47）', () => {
  let tb: TestBackend;
  let token: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('未登录与用户 token 都是 401', async () => {
    const noToken = await getJson(tb.app, '/admin/accounts');
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toBe('invalid_token');

    // 用户 access token（客户端 audience）不能当运营凭证用。
    await provisionAccount(tb.app);
    const userLogin = await loginAccount(tb.app, '13800000001', 'initial-pass-1');
    expect(userLogin.status).toBe(200);
    const crossUse = await getJson(tb.app, '/admin/accounts', str(userLogin.body.accessToken));
    expect(crossUse.status).toBe(401);
    expect(crossUse.body.error).toBe('invalid_token');
  });

  it('分页与总数正确（默认 25，页间不重不漏）', async () => {
    for (let i = 1; i <= 30; i += 1) {
      await createAccount(tb.app, token, `138000000${String(i).padStart(2, '0')}`, 'initial-pass-1');
    }

    const page1 = await getJson(tb.app, '/admin/accounts', token);
    expect(page1.status).toBe(200);
    const rows1 = page1.body.accounts as { id: string }[];
    expect(rows1).toHaveLength(25);
    expect(page1.body.total).toBe(30);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(25);

    const page2 = await getJson(tb.app, '/admin/accounts?page=2', token);
    const rows2 = page2.body.accounts as { id: string }[];
    expect(rows2).toHaveLength(5);
    expect(page2.body.total).toBe(30);

    const ids1 = new Set(rows1.map(row => row.id));
    const ids2 = new Set(rows2.map(row => row.id));
    expect([...ids1, ...ids2]).toHaveLength(30);
    for (const id of ids2) expect(ids1.has(id)).toBe(false);

    const page3 = await getJson(tb.app, '/admin/accounts?page=3', token);
    expect(page3.body.accounts).toHaveLength(0);
    expect(page3.body.total).toBe(30);

    const paged15 = await getJson(tb.app, '/admin/accounts?page=2&pageSize=15', token);
    expect(paged15.body.accounts).toHaveLength(15);
  });

  it('参数校验：page/pageSize/sort/q 越界或异形一律 400', async () => {
    const token2 = token;
    for (const query of [
      'page=0',
      'page=abc',
      'page=-1',
      'pageSize=0',
      'pageSize=101',
      'pageSize=abc',
      'sort=foo',
      'sort=created%2Cbalance',
      `q=${'长'.repeat(101)}`,
    ]) {
      const res = await getJson(tb.app, `/admin/accounts?${query}`, token2);
      expect(res.status, `GET /admin/accounts?${query} 应 400`).toBe(400);
      expect(res.body.error).toBe('validation_error');
    }
    // 上限恰好 100 合法。
    const ok = await getJson(tb.app, '/admin/accounts?pageSize=100', token2);
    expect(ok.status).toBe(200);
  });

  it('搜索命中手机号或用户名，通配符按字面处理', async () => {
    await createAccount(tb.app, token, '13811112222', 'initial-pass-1', '张三文化传播');
    await createAccount(tb.app, token, '13833334444', 'initial-pass-1', '李四科技');
    await createAccount(tb.app, token, '13855556666', 'initial-pass-1');
    await createAccount(tb.app, token, '13877778888', 'initial-pass-1', '100%增长工坊');
    await createAccount(tb.app, token, '13899990000', 'initial-pass-1', 'a_b公司');

    const byPhone = await getJson(tb.app, '/admin/accounts?q=2222', token);
    expect(byPhone.body.total).toBe(1);
    expect((byPhone.body.accounts as { phone: string }[])[0]?.phone).toBe('13811112222');

    const byName = await getJson(tb.app, `/admin/accounts?q=${encodeURIComponent('张三')}`, token);
    expect(byName.body.total).toBe(1);
    expect((byName.body.accounts as { displayName: string }[])[0]?.displayName).toBe('张三文化传播');

    const byName2 = await getJson(tb.app, `/admin/accounts?q=${encodeURIComponent('科技')}`, token);
    expect(byName2.body.total).toBe(1);

    const miss = await getJson(tb.app, `/admin/accounts?q=${encodeURIComponent('不存在')}`, token);
    expect(miss.body.total).toBe(0);

    // % 与 _ 是字面不是通配符：只命中真的含这些字符的用户名。
    const percent = await getJson(tb.app, `/admin/accounts?q=${encodeURIComponent('0%')}`, token);
    expect(percent.body.total).toBe(1);
    expect((percent.body.accounts as { displayName: string }[])[0]?.displayName).toBe('100%增长工坊');
    const underscore = await getJson(tb.app, `/admin/accounts?q=${encodeURIComponent('a_b')}`, token);
    expect(underscore.body.total).toBe(1);
    expect((underscore.body.accounts as { displayName: string }[])[0]?.displayName).toBe('a_b公司');
  });

  it('行字段：余额三口径、对话额度、品牌集、待改密、最近活跃、建号时间', async () => {
    tb.setNow(BASE_MS + 1000);
    const { accountId } = await createAccount(tb.app, token, '13812341234', 'initial-pass-1', '张三文化');
    // 建号即 500 点赠送；再充值 1000 → total 1500；插 permit 冻结 200 → available 1300。
    await topup(tb.app, token, accountId, 1000);
    insertFrozenPermit(tb, accountId, 200);
    tb.db.run('INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)', [
      accountId,
      'ws-1',
      '鲸杉示范品牌',
    ]);
    tb.db.run('INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)', [
      accountId,
      'ws-2',
      '第二品牌',
    ]);
    // 登录一次 → 有会话行 → 最近活跃 = 登录时刻。
    tb.setNow(BASE_MS + 5000);
    expect((await loginAccount(tb.app, '13812341234', 'initial-pass-1')).status).toBe(200);

    // 从未登录的对照账号：最近活跃为 null。
    await createAccount(tb.app, token, '13856785678', 'initial-pass-1');

    const list = await getJson(tb.app, '/admin/accounts', token);
    expect(list.status).toBe(200);
    const rows = list.body.accounts as Array<Record<string, unknown>>;
    const row = rows.find(item => item.id === accountId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      phone: '13812341234',
      displayName: '张三文化',
      status: 'active',
      mustChangePassword: true,
      balance: { total: 1500, frozen: 200, available: 1300 },
      chatQuota: { totalPoints: 100, usedMilli: 0 },
      // brands 按实现约定排序：品牌名 name 升序（SQLite BINARY 按 UTF-8 字节序），
      // 与 workspace 插入顺序无关——第二品牌(0xE7…) < 鲸杉示范品牌(0xE9…)。
      brands: [
        { workspaceId: 'ws-2', name: '第二品牌' },
        { workspaceId: 'ws-1', name: '鲸杉示范品牌' },
      ],
      lastActiveAt: new Date(BASE_MS + 5000).toISOString(),
      createdAt: new Date(BASE_MS + 1000).toISOString(),
    });
    const neverLogged = rows.find(item => item.phone === '13856785678');
    expect(neverLogged?.lastActiveAt).toBeNull();
    expect(neverLogged?.brands).toEqual([]);
  });

  it('sort=created（默认）：建号时间倒序', async () => {
    tb.setNow(BASE_MS + 1000);
    const a = await createAccount(tb.app, token, '13811110001', 'initial-pass-1');
    tb.setNow(BASE_MS + 2000);
    const b = await createAccount(tb.app, token, '13811110002', 'initial-pass-1');
    tb.setNow(BASE_MS + 3000);
    const c = await createAccount(tb.app, token, '13811110003', 'initial-pass-1');

    const res = await getJson(tb.app, '/admin/accounts', token);
    const ids = (res.body.accounts as { id: string }[]).map(row => row.id);
    expect(ids).toEqual([c.accountId, b.accountId, a.accountId]);
  });

  it('sort=balance：余额降序', async () => {
    const a = await createAccount(tb.app, token, '13822220001', 'initial-pass-1');
    const b = await createAccount(tb.app, token, '13822220002', 'initial-pass-1');
    const c = await createAccount(tb.app, token, '13822220003', 'initial-pass-1');
    await topup(tb.app, token, a.accountId, 300);
    await topup(tb.app, token, b.accountId, 1000);
    await topup(tb.app, token, c.accountId, 500);

    const res = await getJson(tb.app, '/admin/accounts?sort=balance', token);
    const ids = (res.body.accounts as { id: string }[]).map(row => row.id);
    // 余额（含 500 赠送）：b 1500 > c 1000 > a 800。
    expect(ids).toEqual([b.accountId, c.accountId, a.accountId]);
  });

  it('sort=active：最近活跃降序，从未登录排最后', async () => {
    const never = await createAccount(tb.app, token, '13833330001', 'initial-pass-1');
    tb.setNow(BASE_MS + 1000);
    await createAccount(tb.app, token, '13833330002', 'initial-pass-1');
    tb.setNow(BASE_MS + 2000);
    await createAccount(tb.app, token, '13833330003', 'initial-pass-1');

    // 13833330002 登录于 T+3000；13833330003 登录于 T+6000（更新）。
    tb.setNow(BASE_MS + 3000);
    expect((await loginAccount(tb.app, '13833330002', 'initial-pass-1')).status).toBe(200);
    tb.setNow(BASE_MS + 6000);
    expect((await loginAccount(tb.app, '13833330003', 'initial-pass-1')).status).toBe(200);

    const res = await getJson(tb.app, '/admin/accounts?sort=active', token);
    const rows = res.body.accounts as Array<{ id: string; lastActiveAt: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.lastActiveAt).toBe(new Date(BASE_MS + 6000).toISOString());
    expect(rows[1]?.lastActiveAt).toBe(new Date(BASE_MS + 3000).toISOString());
    expect(rows[2]?.id).toBe(never.accountId);
    expect(rows[2]?.lastActiveAt).toBeNull();
  });
});

describe('POST /admin/accounts 建号用户名（票 47）', () => {
  let tb: TestBackend;
  let token: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('带用户名建号落库并回显；可选字段缺省为空串', async () => {
    const withName = await postJson(
      tb.app,
      '/admin/accounts',
      { phone: '13844440001', initialPassword: 'initial-pass-1', displayName: '张三文化' },
      token,
    );
    expect(withName.status).toBe(201);
    expect(withName.body.account).toMatchObject({
      phone: '13844440001',
      displayName: '张三文化',
      status: 'active',
      mustChangePassword: true,
      points: 500,
    });
    const accountId = str((withName.body.account as { id: string }).id);
    expect(
      tb.db.get<{ display_name: string }>('SELECT display_name FROM accounts WHERE id = ?', [
        accountId,
      ]),
    ).toMatchObject({ display_name: '张三文化' });

    const withoutName = await postJson(
      tb.app,
      '/admin/accounts',
      { phone: '13844440002', initialPassword: 'initial-pass-1' },
      token,
    );
    expect(withoutName.status).toBe(201);
    expect(withoutName.body.account).toMatchObject({ displayName: '' });
  });

  it('用户名 trim 后落库；65 字符拒绝 400 且零写入', async () => {
    const padded = await postJson(
      tb.app,
      '/admin/accounts',
      { phone: '13844440003', initialPassword: 'initial-pass-1', displayName: '  李四科技  ' },
      token,
    );
    expect(padded.status).toBe(201);
    expect(padded.body.account).toMatchObject({ displayName: '李四科技' });

    const before = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts', [])!
      .count;
    const tooLong = await postJson(
      tb.app,
      '/admin/accounts',
      { phone: '13844440004', initialPassword: 'initial-pass-1', displayName: 'x'.repeat(65) },
      token,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('validation_error');
    expect(tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM accounts', [])!.count).toBe(
      before,
    );
  });
});

describe('POST /admin/accounts/:accountId/status 停用/启用（票 47）', () => {
  let tb: TestBackend;
  let token: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('未登录 401', async () => {
    const { accountId } = await provisionAccount(tb.app);
    const res = await postJson(tb.app, `/admin/accounts/${accountId}/status`, { status: 'disabled' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('停用即时吊销全部会话、余额流水不动；启用恢复登录', async () => {
    const { accountId } = await provisionAccount(tb.app, '13866660001', 'initial-pass-1');
    expect((await loginAccount(tb.app, '13866660001', 'initial-pass-1')).status).toBe(200);
    const ledgerBefore = tb.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id = ?",
      [accountId],
    )!.count;

    const disabled = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/status`,
      { status: 'disabled' },
      token,
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body.account).toMatchObject({ id: accountId, status: 'disabled' });
    expect(
      tb.db.get<{ status: string }>('SELECT status FROM accounts WHERE id = ?', [accountId]),
    ).toMatchObject({ status: 'disabled' });
    const session = tb.db.get<{ revoked_at: string | null; revoked_reason: string | null }>(
      'SELECT revoked_at, revoked_reason FROM auth_sessions WHERE account_id = ?',
      [accountId],
    );
    expect(session?.revoked_at).toBeTruthy();
    expect(session?.revoked_reason).toBe('admin_disabled');
    // 停用后登录被拦（既有语义不变）。
    expect((await loginAccount(tb.app, '13866660001', 'initial-pass-1')).status).toBe(403);
    // 余额与流水不动。
    expect(
      tb.db.get<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?', [accountId]),
    ).toMatchObject({ balance: 500 });
    expect(
      tb.db.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM ledger_entries WHERE account_id = ?',
        [accountId],
      )!.count,
    ).toBe(ledgerBefore);

    const enabled = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/status`,
      { status: 'active' },
      token,
    );
    expect(enabled.status).toBe(200);
    expect(enabled.body.account).toMatchObject({ status: 'active' });
    expect((await loginAccount(tb.app, '13866660001', 'initial-pass-1')).status).toBe(200);
  });

  it('参数校验：非法 status 400、未知账号 404、异形 accountId 400', async () => {
    const { accountId } = await provisionAccount(tb.app, '13866660002', 'initial-pass-1');
    const badStatus = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/status`,
      { status: 'banned' },
      token,
    );
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error).toBe('validation_error');

    const missing = await postJson(
      tb.app,
      '/admin/accounts/no-such-account/status',
      { status: 'disabled' },
      token,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('account_not_found');

    const malformed = await postJson(
      tb.app,
      `/admin/accounts/${'x'.repeat(65)}/status`,
      { status: 'disabled' },
      token,
    );
    expect(malformed.status).toBe(400);
  });
});
