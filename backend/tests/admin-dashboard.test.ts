import { describe, expect, it } from 'vitest';
import {
  getJson,
  postJson,
  startTestBackend,
  str,
  type TestBackend,
} from './helpers';

/**
 * 票 48 验收：仪表盘聚合接口。GET /admin/stats/overview 走 startTestBackend
 * 的 HTTP 合约 seam（临时 SQLite + 假时钟，无真实网络）——「今日」按北京
 * 时间（UTC+8）日界切分，30 天序列空窗日补零；GET /admin/media-pool 复用
 * 既有媒介池 /profile 上游（注入 mock fetch），上游失败返回降级标记而非
 * 500。401 口径与票 47 JSON 接口一致（Bearer 缺省/无效 401）。
 */

/** 2026-09-30 10:00 UTC = 北京时间 2026-09-30 18:00。 */
const BASE_MS = Date.parse('2026-09-30T10:00:00.000Z');

/** mock 超级媒介 /profile：记录请求形态，返回可配置的 envelope。 */
function profileUpstream(
  data: unknown,
  options?: { envelopeCode?: number; httpStatus?: number; throwNetwork?: boolean },
) {
  const calls: { method: string; path: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname.replace(/^\/api/, '') });
    if (options?.throwNetwork) throw new TypeError('mock network unreachable');
    return Response.json(
      { code: options?.envelopeCode ?? 200, message: 'ok', data },
      { status: options?.httpStatus ?? 200 },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** 直插流水（consume/refund 等无公开 HTTP 入账路径的种类，只造聚合数据）。 */
function insertLedgerEntry(
  tb: TestBackend,
  accountId: string,
  kind: string,
  delta: number,
  createdAtIso: string,
): void {
  const seq =
    tb.db.get<{ next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ledger_entries WHERE account_id = ?',
      [accountId],
    )?.next ?? 1;
  tb.db.run(
    'INSERT INTO ledger_entries (id, account_id, seq, delta, balance_after, kind, note, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
    [`test-ledger-${accountId}-${seq}`, accountId, seq, delta, kind, '聚合测试流水', createdAtIso],
  );
}

async function opsToken(tb: TestBackend): Promise<string> {
  const login = await postJson(tb.app, '/admin/login', { password: 'ops-password-123' });
  if (login.status !== 200) throw new Error(`ops login failed: ${JSON.stringify(login)}`);
  return str(login.body.adminToken);
}

async function createAccount(tb: TestBackend, token: string, phone: string): Promise<string> {
  const created = await postJson(
    tb.app,
    '/admin/accounts',
    { phone, initialPassword: 'initial-pass-1' },
    token,
  );
  if (created.status !== 201) throw new Error(`create account failed: ${JSON.stringify(created)}`);
  return str((created.body.account as { id: string }).id);
}

describe('admin dashboard JSON endpoints', () => {
  it('rejects both endpoints without a valid admin token', async () => {
    const tb = await startTestBackend();
    try {
      for (const path of ['/admin/stats/overview', '/admin/media-pool']) {
        const noToken = await getJson(tb.app, path);
        expect(noToken.status).toBe(401);
        expect(noToken.body).toMatchObject({ error: 'invalid_token', message: '缺少运营凭证。' });
        const badToken = await getJson(tb.app, path, 'not-a-token');
        expect(badToken.status).toBe(401);
        expect(badToken.body).toMatchObject({ error: 'invalid_token' });
      }
    } finally {
      await tb.cleanup();
    }
  });

  it('aggregates account counts, balances and Beijing-day topup/consume with zero-filled 30-day series', async () => {
    const tb = await startTestBackend({ initialNowMs: BASE_MS });
    const token = await opsToken(tb);
    const acc1 = await createAccount(tb, token, '13800000001');
    const acc2 = await createAccount(tb, token, '13800000002');
    const acc3 = await createAccount(tb, token, '13800000003');
    // 停用 acc3：总数/活跃/停用 = 3/2/1。停用端点走既有票 47 语义。
    const disabled = await postJson(
      tb.app,
      `/admin/accounts/${acc3}/status`,
      { status: 'disabled' },
      token,
    );
    expect(disabled.status).toBe(200);

    // 北京时间日界用例（今天 = 2026-09-30）：
    // - 昨天 23:59:59（UTC 09-29T15:59:59Z）：归 09-29；
    // - 今天 00:00:00（UTC 09-29T16:00:00Z）：归 09-30（今日边界精确命中）。
    tb.setNow(Date.parse('2026-09-30T02:00:00.000Z'));
    await postJson(tb.app, '/admin/ledger/topup', { accountId: acc1, points: 1000, note: 't1' }, token);
    tb.setNow(Date.parse('2026-09-29T15:59:59.000Z'));
    await postJson(tb.app, '/admin/ledger/topup', { accountId: acc1, points: 300, note: 't2' }, token);
    tb.setNow(Date.parse('2026-09-29T16:00:00.000Z'));
    await postJson(tb.app, '/admin/ledger/topup', { accountId: acc1, points: 400, note: 't3' }, token);
    // 调整不进充值口径；今天的扣点直插 consume。
    tb.setNow(Date.parse('2026-09-30T03:00:00.000Z'));
    await postJson(tb.app, '/admin/ledger/adjust', { accountId: acc1, delta: 50, note: '调点' }, token);
    insertLedgerEntry(tb, acc2, 'consume', -150, '2026-09-30T02:30:00.000Z');
    // 30 天窗口外（08-05）与窗口内非充值/扣点种类（refund）都不进序列。
    insertLedgerEntry(tb, acc1, 'consume', -100, '2026-08-05T10:00:00.000Z');
    insertLedgerEntry(tb, acc1, 'refund', 100, '2026-09-25T10:00:00.000Z');

    // 账面与冻结口径：总额 1200 + 800 + 0 = 2000；acc2 冻结 200（open permit）。
    tb.db.run('UPDATE accounts SET balance = ? WHERE id = ?', [1200, acc1]);
    tb.db.run('UPDATE accounts SET balance = ? WHERE id = ?', [800, acc2]);
    tb.db.run('UPDATE accounts SET balance = 0 WHERE id = ?', [acc3]);
    const frozenAt = '2026-09-30T04:00:00.000Z';
    tb.db.run(
      `INSERT INTO billing_permits (id, account_id, operation, units, unit_price, base_price, frozen_remaining, status, created_at, last_activity_at)
       VALUES (?, ?, 'article_generation', 1, 0, 0, 200, 'open', ?, ?)`,
      [`permit-frozen-${acc2}`, acc2, frozenAt, frozenAt],
    );

    tb.setNow(BASE_MS);
    const res = await getJson(tb.app, '/admin/stats/overview', token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accounts: { total: 3, active: 2, disabled: 1 },
      balance: { total: 2000, frozen: 200, available: 1800 },
      today: { topup: 1400, consume: 150 },
      dailySeries: [
        // 前 28 天空窗补零；下面按日期断言关键点。
        ...Array.from({ length: 30 }, (_, i) => {
          const day = new Date(Date.parse('2026-08-31T16:00:00.000Z') + i * 86400000 + 8 * 3600000)
            .toISOString()
            .slice(0, 10);
          const topup = day === '2026-09-29' ? 300 : day === '2026-09-30' ? 1400 : 0;
          const consume = day === '2026-09-30' ? 150 : 0;
          return { date: day, topup, consume };
        }),
      ],
    });
    await tb.cleanup();
  });

  it('returns the media pool balance with threshold comparison via signed /profile', async () => {
    const mock = profileUpstream({ money: '320.50' });
    const tb = await startTestBackend({ fetch: mock.fetch, config: { adminLoginThrottleUnitMs: 1 } });
    try {
      const token = await opsToken(tb);
      const res = await getJson(tb.app, '/admin/media-pool', token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        degraded: false,
        balanceCents: 32050,
        lowBalanceCents: 50000,
        lowBalance: true,
      });
      // 走既有签名代理：GET /profile 公共参数齐全。
      expect(mock.calls).toEqual([{ method: 'GET', path: '/profile' }]);
    } finally {
      await tb.cleanup();
    }
  });

  it('honors the configured threshold and reports healthy above it', async () => {
    const tb = await startTestBackend({
      fetch: profileUpstream({ money: '1280.00' }).fetch,
      config: { adminLoginThrottleUnitMs: 1, adminMediaPoolLowBalanceCents: 200_000 },
    });
    try {
      const token = await opsToken(tb);
      const res = await getJson(tb.app, '/admin/media-pool', token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        degraded: false,
        balanceCents: 128000,
        lowBalanceCents: 200000,
        lowBalance: true,
      });
    } finally {
      await tb.cleanup();
    }

    const tbOk = await startTestBackend({
      fetch: profileUpstream({ money: '1280.00' }).fetch,
      config: { adminLoginThrottleUnitMs: 1 },
    });
    try {
      const tokenOk = await opsToken(tbOk);
      const ok = await getJson(tbOk.app, '/admin/media-pool', tokenOk);
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({
        degraded: false,
        balanceCents: 128000,
        lowBalanceCents: 50000,
        lowBalance: false,
      });
    } finally {
      await tbOk.cleanup();
    }
  });

  it('degrades with a marker instead of 500 when the upstream fails', async () => {
    for (const degraded of [
      profileUpstream({}, { envelopeCode: 500 }),
      profileUpstream({}, { throwNetwork: true }),
    ]) {
      const tbDown = await startTestBackend({
        fetch: degraded.fetch,
        config: { adminLoginThrottleUnitMs: 1 },
      });
      try {
        const token = await opsToken(tbDown);
        const res = await getJson(tbDown.app, '/admin/media-pool', token);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ degraded: true, lowBalanceCents: 50000 });
      } finally {
        await tbDown.cleanup();
      }
    }
  });
});
