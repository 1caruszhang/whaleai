import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getJson,
  loginAccount,
  postJson,
  provisionAccount,
  provisionLoggedInAccount,
  startTestBackend,
  str,
  type TestBackend,
} from './helpers';

/**
 * 票 49 验收：账号详情页四接口 HTTP 合约（permits / publish-orders /
 * provider-usage 三个列表 + display-name 设置/清空），以及详情页余额三
 * 口径数据源（GET /admin/accounts/:accountId/ledger 的 balance 快照 =
 * open permit 预扣 + 冻结中发布订单，冻结口径复用 frozenPointsFor）。
 * 全部走 startTestBackend 的 HTTP 合约 seam（临时 SQLite + 假时钟，
 * 无真实网络）。三个新列表接口形状沿用既有 domain 投影（permitProjection /
 * publishOrderProjection / provider-usage 记录的 camelCase 口径），不另造。
 */

const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');

const LIST_PATHS = ['permits', 'publish-orders', 'provider-usage'] as const;

async function opsToken(app: TestBackend['app']): Promise<string> {
  const login = await postJson(app, '/admin/login', { password: 'ops-password-123' });
  if (login.status !== 200) throw new Error(`ops login failed: ${JSON.stringify(login)}`);
  return str(login.body.adminToken);
}

/** 直插一条 open permit 造冻结（与 admin-accounts-list.test.ts 同口径）。 */
function insertOpenPermit(
  tb: TestBackend,
  accountId: string,
  id: string,
  frozen: number,
  createdAtIso: string,
): void {
  tb.db.run(
    `INSERT INTO billing_permits (id, account_id, operation, units, unit_price, base_price, frozen_remaining, status, created_at, last_activity_at)
     VALUES (?, ?, 'material_import', 3, 20, 0, ?, 'open', ?, ?)`,
    [id, accountId, frozen, createdAtIso, createdAtIso],
  );
}

/** 直插发布订单行（全部 NOT NULL 列显式给值，其余列走迁移默认）。 */
function insertPublishOrder(
  tb: TestBackend,
  accountId: string,
  row: {
    sn: string;
    kind: 'media' | 'we-media';
    points: number;
    placementStatus: 'pending' | 'placed' | 'failed';
    ledgerStatus: 'frozen' | 'settled' | 'refunded';
    createdAt: string;
    partnerSn?: string;
    upstreamStatus?: number;
    url?: string;
    publishedAt?: string;
  },
): void {
  tb.db.run(
    `INSERT INTO publish_orders
       (sn, account_id, kind, resource_id, title, content_url, media_price_cents, points,
        placement_status, ledger_status, partner_sn, upstream_status, url, published_at,
        created_at, updated_at)
     VALUES (?, ?, ?, 101, ?, ?, 8800, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.sn,
      accountId,
      row.kind,
      `稿件 ${row.sn}`,
      `https://example.com/${row.sn}.html`,
      row.points,
      row.placementStatus,
      row.ledgerStatus,
      row.partnerSn ?? null,
      row.upstreamStatus ?? null,
      row.url ?? null,
      row.publishedAt ?? null,
      row.createdAt,
      row.createdAt,
    ],
  );
}

function insertProviderUsage(
  tb: TestBackend,
  accountId: string,
  id: string,
  provider: string,
  route: string,
  inputTokens: number,
  outputTokens: number,
  createdAtIso: string,
): void {
  tb.db.run(
    `INSERT INTO provider_usage_records (id, account_id, provider, route, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, accountId, provider, route, inputTokens, outputTokens, createdAtIso],
  );
}

function topup(app: TestBackend['app'], adminToken: string, accountId: string, points: number) {
  return postJson(app, '/admin/ledger/topup', { accountId, points, note: '测试充值' }, adminToken);
}

describe('票 49 详情页列表接口：鉴权与 limit 校验', () => {
  let tb: TestBackend;
  let token: string;
  let accountId: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
    ({ accountId } = await provisionAccount(tb.app));
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('三个 GET 接口未登录与用户 token 一律 401', async () => {
    for (const path of LIST_PATHS) {
      const noToken = await getJson(tb.app, `/admin/accounts/${accountId}/${path}`);
      expect(noToken.status, `GET ${path} 无凭证应 401`).toBe(401);
      expect(noToken.body.error).toBe('invalid_token');
    }
    // 用户 access token（客户端 audience）不能当运营凭证用。
    const userLogin = await loginAccount(tb.app, '13800000001', 'initial-pass-1');
    expect(userLogin.status).toBe(200);
    for (const path of LIST_PATHS) {
      const crossUse = await getJson(tb.app, `/admin/accounts/${accountId}/${path}`, str(userLogin.body.accessToken));
      expect(crossUse.status, `GET ${path} 用户 token 应 401`).toBe(401);
      expect(crossUse.body.error).toBe('invalid_token');
    }
  });

  it('limit 越界或异形一律 400；1 与 200 合法', async () => {
    for (const path of LIST_PATHS) {
      for (const query of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5']) {
        const res = await getJson(tb.app, `/admin/accounts/${accountId}/${path}?${query}`, token);
        expect(res.status, `GET ${path}?${query} 应 400`).toBe(400);
        expect(res.body.error).toBe('validation_error');
      }
      const min = await getJson(tb.app, `/admin/accounts/${accountId}/${path}?limit=1`, token);
      expect(min.status).toBe(200);
      const max = await getJson(tb.app, `/admin/accounts/${accountId}/${path}?limit=200`, token);
      expect(max.status).toBe(200);
    }
  });

  it('未知账号 404（三列表 + display-name 一致）', async () => {
    for (const path of LIST_PATHS) {
      const res = await getJson(tb.app, `/admin/accounts/no-such-account/${path}`, token);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('account_not_found');
    }
    const res = await postJson(
      tb.app,
      '/admin/accounts/no-such-account/display-name',
      { displayName: '张三' },
      token,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account_not_found');
  });

  it('limit 默认 50：51 条记录默认回 50，limit=200 回 51，limit=1 回 1', async () => {
    for (let i = 1; i <= 51; i += 1) {
      insertProviderUsage(
        tb,
        accountId,
        `pu-${String(i).padStart(2, '0')}`,
        'ark',
        'ark.chat_completions',
        100 + i,
        10 + i,
        new Date(BASE_MS + i * 1000).toISOString(),
      );
    }
    const def = await getJson(tb.app, `/admin/accounts/${accountId}/provider-usage`, token);
    expect(def.status).toBe(200);
    expect(def.body.records).toHaveLength(50);
    const all = await getJson(tb.app, `/admin/accounts/${accountId}/provider-usage?limit=200`, token);
    expect(all.body.records).toHaveLength(51);
    const one = await getJson(tb.app, `/admin/accounts/${accountId}/provider-usage?limit=1`, token);
    expect(one.body.records).toHaveLength(1);
  });
});

describe('GET /admin/accounts/:accountId/permits 数据形状（票 49）', () => {
  let tb: TestBackend;
  let token: string;
  let accountId: string;
  let accessToken: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    const logged = await provisionLoggedInAccount(tb.app);
    token = logged.adminToken;
    accountId = logged.accountId;
    accessToken = logged.accessToken;
    expect((await topup(tb.app, token, accountId, 1000)).status).toBe(200);
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('沿用 permitProjection 口径（open+settled 全量、最新在前）', async () => {
    const first = await postJson(
      tb.app,
      '/billing/permits',
      { permitId: 'pm-a-001', operation: 'material_import', units: 3, unitPrice: 20 },
      accessToken,
    );
    expect(first.status).toBe(201);
    tb.setNow(BASE_MS + 1000);
    const second = await postJson(
      tb.app,
      '/billing/permits',
      { permitId: 'pm-b-002', operation: 'material_import', units: 2, unitPrice: 20 },
      accessToken,
    );
    expect(second.status).toBe(201);
    // pm-a：unit0 成功（结转 20）、unit1 失败（回补 20）。
    expect(
      (await postJson(tb.app, '/billing/permits/pm-a-001/report', { unit: 0, outcome: 'success' }, accessToken)).status,
    ).toBe(200);
    expect(
      (await postJson(tb.app, '/billing/permits/pm-a-001/report', { unit: 1, outcome: 'failure' }, accessToken)).status,
    ).toBe(200);

    const res = await getJson(tb.app, `/admin/accounts/${accountId}/permits`, token);
    expect(res.status).toBe(200);
    const permits = res.body.permits as Array<Record<string, unknown>>;
    expect(permits).toHaveLength(2);
    // 最新在前：pm-b-002（T+1000）先于 pm-a-001（T）。
    expect(permits[0]).toMatchObject({
      permitId: 'pm-b-002',
      operation: 'material_import',
      units: 2,
      unitPrice: 20,
      basePrice: 0,
      totalPoints: 40,
      status: 'open',
      frozenPoints: 40,
      consumedPoints: 0,
      refundedPoints: 0,
      unitsSucceeded: 0,
      unitsFailed: 0,
      unitsUnreported: 2,
      createdAt: new Date(BASE_MS + 1000).toISOString(),
      settledAt: null,
    });
    expect(permits[1]).toMatchObject({
      permitId: 'pm-a-001',
      status: 'open',
      units: 3,
      totalPoints: 60,
      frozenPoints: 20,
      consumedPoints: 20,
      refundedPoints: 20,
      unitsSucceeded: 1,
      unitsFailed: 1,
      unitsUnreported: 1,
    });
  });

  it('limit 参数生效', async () => {
    // 并发准入上限 2：pm-000001 回报成功后自动结清，再开 pm-000002/000003。
    tb.setNow(BASE_MS + 1000);
    expect(
      (
        await postJson(
          tb.app,
          '/billing/permits',
          { permitId: 'pm-000001', operation: 'material_import', units: 1, unitPrice: 20 },
          accessToken,
        )
      ).status,
    ).toBe(201);
    expect(
      (await postJson(tb.app, '/billing/permits/pm-000001/report', { unit: 0, outcome: 'success' }, accessToken))
        .status,
    ).toBe(200);
    for (const [index, id] of [
      [2, 'pm-000002'],
      [3, 'pm-000003'],
    ] as const) {
      tb.setNow(BASE_MS + index * 1000);
      expect(
        (
          await postJson(
            tb.app,
            '/billing/permits',
            { permitId: id, operation: 'material_import', units: 1, unitPrice: 20 },
            accessToken,
          )
        ).status,
      ).toBe(201);
    }
    const one = await getJson(tb.app, `/admin/accounts/${accountId}/permits?limit=1`, token);
    expect(one.body.permits).toHaveLength(1);
    expect((one.body.permits as Array<{ permitId: string }>)[0]?.permitId).toBe('pm-000003');
  });
});

describe('GET /admin/accounts/:accountId/publish-orders 数据形状（票 49）', () => {
  let tb: TestBackend;
  let token: string;
  let accountId: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
    ({ accountId } = await provisionAccount(tb.app));
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('沿用 publishOrderProjection 口径（最新在前）', async () => {
    insertPublishOrder(tb, accountId, {
      sn: 'sn-frozen',
      kind: 'media',
      points: 1408,
      placementStatus: 'pending',
      ledgerStatus: 'frozen',
      createdAt: new Date(BASE_MS + 1000).toISOString(),
      upstreamStatus: 1,
    });
    insertPublishOrder(tb, accountId, {
      sn: 'sn-settled',
      kind: 'we-media',
      points: 800,
      placementStatus: 'placed',
      ledgerStatus: 'settled',
      createdAt: new Date(BASE_MS + 2000).toISOString(),
      partnerSn: '99999999999999999999999926',
      upstreamStatus: 4,
      url: 'https://published.example.com/sn-settled',
      publishedAt: new Date(BASE_MS + 3000).toISOString(),
    });

    const res = await getJson(tb.app, `/admin/accounts/${accountId}/publish-orders`, token);
    expect(res.status).toBe(200);
    const orders = res.body.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(2);
    // 最新在前：sn-settled（T+2000）先于 sn-frozen（T+1000）。
    expect(orders[0]).toMatchObject({
      sn: 'sn-settled',
      kind: 'we-media',
      points: 800,
      mediaPriceCents: 8800,
      placementStatus: 'placed',
      ledgerStatus: 'settled',
      partnerSn: '99999999999999999999999926',
      status: 4,
      url: 'https://published.example.com/sn-settled',
      publishedAt: new Date(BASE_MS + 3000).toISOString(),
      closedObservedAt: null,
      createdAt: new Date(BASE_MS + 2000).toISOString(),
      updatedAt: new Date(BASE_MS + 2000).toISOString(),
    });
    expect(orders[1]).toMatchObject({
      sn: 'sn-frozen',
      kind: 'media',
      points: 1408,
      placementStatus: 'pending',
      ledgerStatus: 'frozen',
      partnerSn: null,
      status: 1,
      url: null,
    });
  });
});

describe('GET /admin/accounts/:accountId/provider-usage 数据形状（票 49）', () => {
  let tb: TestBackend;
  let token: string;
  let accountId: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
    ({ accountId } = await provisionAccount(tb.app));
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('camelCase 记录投影、最新在前', async () => {
    insertProviderUsage(tb, accountId, 'pu-1', 'ark', 'ark.chat_completions', 1200, 300, new Date(BASE_MS + 1000).toISOString());
    insertProviderUsage(tb, accountId, 'pu-2', 'oss', 'oss.put_html', 0, 0, new Date(BASE_MS + 2000).toISOString());

    const res = await getJson(tb.app, `/admin/accounts/${accountId}/provider-usage`, token);
    expect(res.status).toBe(200);
    const records = res.body.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: 'pu-2',
      provider: 'oss',
      route: 'oss.put_html',
      inputTokens: 0,
      outputTokens: 0,
      createdAt: new Date(BASE_MS + 2000).toISOString(),
    });
    expect(records[1]).toMatchObject({
      id: 'pu-1',
      provider: 'ark',
      route: 'ark.chat_completions',
      inputTokens: 1200,
      outputTokens: 300,
      createdAt: new Date(BASE_MS + 1000).toISOString(),
    });
  });
});

describe('POST /admin/accounts/:accountId/display-name 设置/清空（票 49）', () => {
  let tb: TestBackend;
  let token: string;
  let accountId: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
    ({ accountId } = await provisionAccount(tb.app));
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  const displayNameOf = () =>
    tb.db.get<{ display_name: string }>('SELECT display_name FROM accounts WHERE id = ?', [
      accountId,
    ]);

  it('未登录与用户 token 都是 401', async () => {
    const noToken = await postJson(tb.app, `/admin/accounts/${accountId}/display-name`, { displayName: '张三' });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toBe('invalid_token');

    const userLogin = await loginAccount(tb.app, '13800000001', 'initial-pass-1');
    const crossUse = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/display-name`,
      { displayName: '张三' },
      str(userLogin.body.accessToken),
    );
    expect(crossUse.status).toBe(401);
    expect(crossUse.body.error).toBe('invalid_token');
  });

  it('设置落库并回显：trim 后落库、64 字符合法', async () => {
    const padded = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/display-name`,
      { displayName: '  李四科技  ' },
      token,
    );
    expect(padded.status).toBe(200);
    expect(padded.body.account).toMatchObject({
      id: accountId,
      phone: '13800000001',
      displayName: '李四科技',
    });
    expect(displayNameOf()).toMatchObject({ display_name: '李四科技' });

    const max = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/display-name`,
      { displayName: 'x'.repeat(64) },
      token,
    );
    expect(max.status).toBe(200);
    expect((max.body.account as { displayName: string }).displayName).toBe('x'.repeat(64));
  });

  it('清空语义：null 与空串都落空串（契约：两者同义，均清除）', async () => {
    expect(
      (await postJson(tb.app, `/admin/accounts/${accountId}/display-name`, { displayName: '张三文化' }, token)).status,
    ).toBe(200);

    const clearedByNull = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/display-name`,
      { displayName: null },
      token,
    );
    expect(clearedByNull.status).toBe(200);
    expect((clearedByNull.body.account as { displayName: string }).displayName).toBe('');
    expect(displayNameOf()).toMatchObject({ display_name: '' });

    expect(
      (await postJson(tb.app, `/admin/accounts/${accountId}/display-name`, { displayName: '张三文化' }, token)).status,
    ).toBe(200);
    const clearedByEmpty = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/display-name`,
      { displayName: '' },
      token,
    );
    expect(clearedByEmpty.status).toBe(200);
    expect((clearedByEmpty.body.account as { displayName: string }).displayName).toBe('');
    expect(displayNameOf()).toMatchObject({ display_name: '' });
  });

  it('65 字符 400 且零写入；displayName 字段缺失 400', async () => {
    const tooLong = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/display-name`,
      { displayName: 'x'.repeat(65) },
      token,
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('validation_error');
    expect(displayNameOf()).toMatchObject({ display_name: '' });

    const missing = await postJson(tb.app, `/admin/accounts/${accountId}/display-name`, {}, token);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('validation_error');
    expect(displayNameOf()).toMatchObject({ display_name: '' });
  });

  it('异形 accountId 400', async () => {
    const res = await postJson(
      tb.app,
      `/admin/accounts/${'x'.repeat(65)}/display-name`,
      { displayName: '张三' },
      token,
    );
    expect(res.status).toBe(400);
  });
});

describe('详情页余额三口径数据源（票 49）', () => {
  let tb: TestBackend;
  let token: string;
  let accountId: string;

  beforeEach(async () => {
    tb = await startTestBackend({ initialNowMs: BASE_MS, config: { adminLoginThrottleUnitMs: 1 } });
    token = await opsToken(tb.app);
    ({ accountId } = await provisionAccount(tb.app));
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('ledger 端点 balance：冻结 = open permit 预扣 + 冻结中订单；account 带 displayName', async () => {
    // 建号赠送 500 + 充值 1000 → total 1500。
    expect((await topup(tb.app, token, accountId, 1000)).status).toBe(200);
    insertOpenPermit(tb, accountId, 'pm-frozen', 200, new Date(BASE_MS + 1000).toISOString());
    insertPublishOrder(tb, accountId, {
      sn: 'sn-frozen',
      kind: 'media',
      points: 300,
      placementStatus: 'pending',
      ledgerStatus: 'frozen',
      createdAt: new Date(BASE_MS + 2000).toISOString(),
      upstreamStatus: 1,
    });
    expect(
      (
        await postJson(
          tb.app,
          `/admin/accounts/${accountId}/display-name`,
          { displayName: '张三文化' },
          token,
        )
      ).status,
    ).toBe(200);

    const ledger = await getJson(tb.app, `/admin/accounts/${accountId}/ledger`, token);
    expect(ledger.status).toBe(200);
    expect(ledger.body.account).toMatchObject({
      id: accountId,
      phone: '13800000001',
      points: 1500,
      displayName: '张三文化',
    });
    expect(ledger.body.balance).toEqual({ total: 1500, frozen: 500, available: 1000 });
    const entries = ledger.body.entries as Array<{ kind: string; delta: number }>;
    expect(entries.map(entry => entry.kind)).toEqual(['topup', 'grant']);
    expect(entries[0]).toMatchObject({ delta: 1000 });

    // 列表端点同源：用户名在列表中可见。
    const list = await getJson(tb.app, '/admin/accounts', token);
    const row = (list.body.accounts as Array<{ id: string; displayName: string; balance: { frozen: number } }>).find(
      item => item.id === accountId,
    );
    expect(row).toMatchObject({ displayName: '张三文化', balance: { frozen: 500 } });
  });
});
