import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getJson,
  loginAccount,
  num,
  postJson,
  provisionAccount,
  provisionLoggedInAccount,
  startTestBackend,
  str,
  TEST_ADMIN_PASSWORD,
  type TestBackend,
} from './helpers';

/**
 * 点数账本与 permit 计费核心 HTTP 合约（票 03 验收）：
 * 预扣冻结 → 逐单位回报（成功结转/失败回补）；permitId 幂等；每账号 2 并发
 * 准入；余额不足拒绝（返回所需点数与可用余额）；充值/调点/赠送全落流水，
 * 余额 = 可用 + 冻结 口径一致。全部走 app.request() + 临时 SQLite。
 */
describe('ledger and permit billing core HTTP contract', () => {
  let tb: TestBackend;

  beforeEach(async () => {
    tb = await startTestBackend();
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  const applyPermit = (token: string, body: Record<string, unknown>) =>
    postJson(tb.app, '/billing/permits', body, token);

  const reportUnit = (token: string, permitId: string, unit: number, outcome: 'success' | 'failure') =>
    postJson(tb.app, `/billing/permits/${permitId}/report`, { unit, outcome }, token);

  const closePermit = (token: string, permitId: string) =>
    postJson(tb.app, `/billing/permits/${permitId}/close`, {}, token);

  function ledgerRows() {
    return tb.db.all<{ delta: number; balance_after: number; kind: string; note: string }>(
      'SELECT delta, balance_after, kind, note FROM ledger_entries',
      [],
    );
  }

  function permitOf(body: Record<string, unknown>): Record<string, unknown> {
    return body.permit as Record<string, unknown>;
  }

  it('freezes on apply, settles only successful units and refunds failed ones', async () => {
    const { accessToken: token } = await provisionLoggedInAccount(tb.app);

    // 申请：材料导入 3 份 × 20 点 → 预扣冻结 60，可用 440。
    const applied = await applyPermit(token, {
      permitId: 'pm-material-001',
      operation: 'material_import',
      units: 3,
      unitPrice: 20,
    });
    expect(applied.status).toBe(201);
    expect(permitOf(applied.body)).toMatchObject({
      permitId: 'pm-material-001',
      operation: 'material_import',
      status: 'open',
      totalPoints: 60,
      frozenPoints: 60,
      consumedPoints: 0,
      refundedPoints: 0,
      unitsUnreported: 3,
    });

    const frozen = await getJson(tb.app, '/billing/balance', token);
    expect(frozen.body.balance).toEqual({ total: 500, frozen: 60, available: 440 });
    expect(frozen.body.openPermits).toHaveLength(1);

    // 逐最小成败单位回报：unit0 成功、unit1 失败、unit2 成功。
    const s0 = await reportUnit(token, 'pm-material-001', 0, 'success');
    expect(s0.status).toBe(200);
    expect(permitOf(s0.body)).toMatchObject({
      unitsSucceeded: 1,
      unitsFailed: 0,
      unitsUnreported: 2,
      consumedPoints: 20,
      refundedPoints: 0,
      frozenPoints: 40,
    });

    const f1 = await reportUnit(token, 'pm-material-001', 1, 'failure');
    expect(permitOf(f1.body)).toMatchObject({
      unitsSucceeded: 1,
      unitsFailed: 1,
      refundedPoints: 20,
      frozenPoints: 20,
    });

    // 最后一个单位回报完毕 → permit 自动结清。
    const s2 = await reportUnit(token, 'pm-material-001', 2, 'success');
    expect(permitOf(s2.body)).toMatchObject({
      status: 'settled',
      unitsSucceeded: 2,
      unitsFailed: 1,
      consumedPoints: 40,
      refundedPoints: 20,
      frozenPoints: 0,
      unitsUnreported: 0,
      settledAt: expect.any(String),
    });

    // 余额口径：仅成功单位结转 → 总余额 460，冻结清零。
    const settled = await getJson(tb.app, '/billing/balance', token);
    expect(settled.body.balance).toEqual({ total: 460, frozen: 0, available: 460 });
    expect(settled.body.openPermits).toHaveLength(0);

    // 账本为唯一权威：grant +500、两笔 consume -20，流水与余额对账。
    const rows = ledgerRows();
    const consumes = rows.filter(row => row.kind === 'consume');
    expect(consumes).toHaveLength(2);
    for (const consume of consumes) expect(consume.delta).toBe(-20);
    expect(rows.find(row => row.kind === 'grant')).toMatchObject({ delta: 500, balance_after: 500 });
    expect(rows.reduce((sum, row) => sum + row.delta, 0)).toBe(460);
  });

  it('replays the same permitId and unit reports without double charging', async () => {
    const { accessToken: token } = await provisionLoggedInAccount(tb.app);

    const first = await applyPermit(token, {
      permitId: 'pm-article-042',
      operation: 'article_generation',
      units: 2,
      unitPrice: 20,
    });
    expect(first.status).toBe(201);

    // 同参数重放申请：200、不二次预扣。
    const replay = await applyPermit(token, {
      permitId: 'pm-article-042',
      operation: 'article_generation',
      units: 2,
      unitPrice: 20,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.permit).toEqual(first.body.permit);

    const balance = await getJson(tb.app, '/billing/balance', token);
    expect(balance.body.balance).toEqual({ total: 500, frozen: 40, available: 460 });

    // 同 permitId 换参数 → 拒绝，而不是静默复用。
    const mutated = await applyPermit(token, {
      permitId: 'pm-article-042',
      operation: 'article_generation',
      units: 3,
      unitPrice: 20,
    });
    expect(mutated.status).toBe(409);
    expect(mutated.body.error).toBe('permit_id_conflict');

    // 单位回报重放：最后一单位落库后 permit 已自动结清，重放仍须成功。
    expect((await reportUnit(token, 'pm-article-042', 0, 'success')).status).toBe(200);
    expect((await reportUnit(token, 'pm-article-042', 1, 'success')).status).toBe(200);
    const replayLast = await reportUnit(token, 'pm-article-042', 1, 'success');
    expect(replayLast.status).toBe(200);
    expect(permitOf(replayLast.body)).toMatchObject({ status: 'settled', consumedPoints: 40 });

    // 只有恰好两笔 -20 的 consume 流水。
    const consumes = ledgerRows().filter(row => row.kind === 'consume');
    expect(consumes).toHaveLength(2);

    // close 已结清的 permit 幂等。
    const closeReplay = await closePermit(token, 'pm-article-042');
    expect(closeReplay.status).toBe(200);
    expect(permitOf(closeReplay.body)).toMatchObject({ status: 'settled', frozenPoints: 0 });
  });

  it('admits at most 2 concurrent permits per account without disturbing the first two', async () => {
    const { accessToken: token } = await provisionLoggedInAccount(tb.app);

    const a = await applyPermit(token, { permitId: 'pm-probe-a', operation: 'baseline_probe', units: 1, unitPrice: 5 });
    const b = await applyPermit(token, { permitId: 'pm-probe-b', operation: 'monitoring_patrol', units: 1, unitPrice: 5 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const c = await applyPermit(token, { permitId: 'pm-probe-c', operation: 'baseline_probe', units: 1, unitPrice: 5 });
    expect(c.status).toBe(429);
    expect(c.body.error).toBe('concurrency_limit');
    expect(num(c.body.limit)).toBe(2);
    expect(num(c.body.active)).toBe(2);

    // 前两个不受影响：A 照常回报结清，B 仍 open。
    expect((await reportUnit(token, 'pm-probe-a', 0, 'success')).status).toBe(200);
    const balanceMid = await getJson(tb.app, '/billing/balance', token);
    expect(balanceMid.body.balance).toEqual({ total: 495, frozen: 5, available: 490 });
    expect(balanceMid.body.openPermits).toHaveLength(1);

    // 释放一个并发槽后第三个申请即可通过。
    const cAgain = await applyPermit(token, { permitId: 'pm-probe-c', operation: 'baseline_probe', units: 1, unitPrice: 5 });
    expect(cAgain.status).toBe(201);

    // 幂等重放不计入并发：已占满槽位时重放 B 不应被拒。
    const bReplay = await applyPermit(token, { permitId: 'pm-probe-b', operation: 'monitoring_patrol', units: 1, unitPrice: 5 });
    expect(bReplay.status).toBe(200);
  });

  it('rejects permits when available points are insufficient and reports both numbers', async () => {
    const { accessToken: token } = await provisionLoggedInAccount(tb.app);

    const tooBig = await applyPermit(token, {
      permitId: 'pm-material-big',
      operation: 'material_import',
      units: 30,
      unitPrice: 20,
    });
    expect(tooBig.status).toBe(402);
    expect(tooBig.body.error).toBe('insufficient_balance');
    expect(num(tooBig.body.required)).toBe(600);
    expect(num(tooBig.body.available)).toBe(500);

    // 恰好等额可用余额 → 允许（边界包含等于）。
    const exact = await applyPermit(token, {
      permitId: 'pm-material-exact',
      operation: 'material_import',
      units: 25,
      unitPrice: 20,
    });
    expect(exact.status).toBe(201);
    expect(permitOf(exact.body).frozenPoints).toBe(500);

    // 冻结占用后可用为 0：小额申请也被拒，且数字口径正确。
    const blocked = await applyPermit(token, {
      permitId: 'pm-material-more',
      operation: 'material_import',
      units: 1,
      unitPrice: 20,
    });
    expect(blocked.status).toBe(402);
    expect(num(blocked.body.required)).toBe(20);
    expect(num(blocked.body.available)).toBe(0);
    expect(num(blocked.body.frozen)).toBe(500);

    // 原有 permit 不受拒绝影响。
    const fetched = await getJson(tb.app, '/billing/permits/pm-material-exact', token);
    expect(fetched.status).toBe(200);
    expect(permitOf(fetched.body).status).toBe('open');
  });

  it('records topup, adjustment and grant entries with a consistent balance identity', async () => {
    const { adminToken, accountId, accessToken: token } = await provisionLoggedInAccount(tb.app);

    const topup = await postJson(tb.app, '/admin/ledger/topup', {
      accountId,
      points: 2000,
      note: '对公转账 ¥200（2026-08-19）',
    }, adminToken);
    expect(topup.status).toBe(200);
    expect(topup.body.balance).toEqual({ total: 2500, frozen: 0, available: 2500 });

    expect((await postJson(tb.app, '/admin/ledger/adjust', {
      accountId, delta: 50, note: '活动补偿',
    }, adminToken)).status).toBe(200);
    expect((await postJson(tb.app, '/admin/ledger/adjust', {
      accountId, delta: -100, note: '误充冲正',
    }, adminToken)).status).toBe(200);

    // 冻结一部分后：total = available + frozen 恒成立。
    await applyPermit(token, { permitId: 'pm-frozen-check', operation: 'material_import', units: 3, unitPrice: 20 });
    const ledger = await getJson(tb.app, `/admin/accounts/${accountId}/ledger`, adminToken);
    expect(ledger.status).toBe(200);
    const balance = ledger.body.balance as Record<string, number>;
    expect(balance.total).toBe(balance.available + balance.frozen);
    expect(balance).toEqual({ total: 2450, frozen: 60, available: 2390 });

    // 流水最新在前：adjust -100 → adjust +50 → topup +2000 → grant +500。
    const entries = ledger.body.entries as Array<{ delta: number; balanceAfter: number; kind: string; note: string }>;
    expect(entries.map(entry => [entry.kind, entry.delta])).toEqual([
      ['adjust', -100],
      ['adjust', 50],
      ['topup', 2000],
      ['grant', 500],
    ]);
    expect(entries[0].balanceAfter).toBe(2450);
    expect(entries.every(entry => typeof entry.note === 'string')).toBe(true);

    // 调减不能动用冻结中的点数。
    const intoFrozen = await postJson(tb.app, '/admin/ledger/adjust', {
      accountId, delta: -2400, note: '试图动用冻结',
    }, adminToken);
    expect(intoFrozen.status).toBe(409);
    expect(intoFrozen.body.error).toBe('insufficient_balance');

    // 账本守恒：Σdelta == 账面余额。
    expect(ledgerRows().reduce((sum, row) => sum + row.delta, 0)).toBe(2450);

    // 非运营 token、未知账号与非法参数的边界。
    const asUser = await postJson(tb.app, '/admin/ledger/topup', { accountId, points: 100 }, token);
    expect(asUser.status).toBe(401);
    const unknown = await postJson(tb.app, '/admin/ledger/topup', { accountId: 'acc-none', points: 100 }, adminToken);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('account_not_found');
    const zeroAdjust = await postJson(tb.app, '/admin/ledger/adjust', { accountId, delta: 0, note: 'x' }, adminToken);
    expect(zeroAdjust.status).toBe(400);
    const noNote = await postJson(tb.app, '/admin/ledger/adjust', { accountId, delta: 5 }, adminToken);
    expect(noNote.status).toBe(400);
  });

  it('orders entries by insertion order even when they share the same created_at', async () => {
    // 快机器上同一毫秒会落多笔流水；created_at 并列时排序必须是全序且
    // 与落账顺序一致。固定假时钟让 topup/两笔 adjust 共享同一时间戳，
    // 确定性复现同毫秒平手场景（票 03 遗留缺陷的回归）。
    const { adminToken, accountId } = await provisionLoggedInAccount(tb.app);
    tb.setNow(Date.now());

    expect((await postJson(tb.app, '/admin/ledger/topup', {
      accountId, points: 2000, note: '对公转账',
    }, adminToken)).status).toBe(200);
    expect((await postJson(tb.app, '/admin/ledger/adjust', {
      accountId, delta: 50, note: '活动补偿',
    }, adminToken)).status).toBe(200);
    expect((await postJson(tb.app, '/admin/ledger/adjust', {
      accountId, delta: -100, note: '误充冲正',
    }, adminToken)).status).toBe(200);

    const ledger = await getJson(tb.app, `/admin/accounts/${accountId}/ledger`, adminToken);
    expect(ledger.status).toBe(200);
    const entries = ledger.body.entries as Array<{ delta: number; balanceAfter: number; kind: string; createdAt: string }>;

    // 三笔确实共享同一 created_at：平手场景被真实触发，而非碰运气。
    expect(new Set(entries.slice(0, 3).map(entry => entry.createdAt)).size).toBe(1);

    // 最新在前且与插入顺序一致：adjust -100 → adjust +50 → topup +2000 → grant +500。
    expect(entries.map(entry => [entry.kind, entry.delta])).toEqual([
      ['adjust', -100],
      ['adjust', 50],
      ['topup', 2000],
      ['grant', 500],
    ]);
    expect(entries[0].balanceAfter).toBe(2450);
  });

  it('validates prices against the server-side price table', async () => {
    const { accessToken: token } = await provisionLoggedInAccount(tb.app);

    // 客户端单价与服务端价目漂移 → 拒绝。
    const wrongUnitPrice = await applyPermit(token, {
      permitId: 'pm-price-wrong',
      operation: 'material_import',
      units: 1,
      unitPrice: 19,
    });
    expect(wrongUnitPrice.status).toBe(400);
    expect(wrongUnitPrice.body.error).toBe('price_mismatch');

    // 分发计划漏报基础费 → 同样拒绝（claimed base 0 ≠ 30）。
    const missingBase = await applyPermit(token, {
      permitId: 'pm-dist-nobase',
      operation: 'distribution_planning',
      units: 4,
      unitPrice: 5,
    });
    expect(missingBase.status).toBe(400);
    expect(missingBase.body.error).toBe('price_mismatch');

    const unknown = await applyPermit(token, {
      permitId: 'pm-op-unknown',
      operation: 'channel_browse',
      units: 1,
      unitPrice: 0,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('unknown_operation');

    // 正确的分发计划：基础 30 + 4 问 × 5 = 冻结 50。
    const dist = await applyPermit(token, {
      permitId: 'pm-dist-ok',
      operation: 'distribution_planning',
      units: 4,
      unitPrice: 5,
      basePrice: 30,
    });
    expect(dist.status).toBe(201);
    expect(permitOf(dist.body)).toMatchObject({ totalPoints: 50, frozenPoints: 50, basePrice: 30 });

    // 基础费绑定首个成功单位：unit0 成功结转 35（30 基础 + 5）。
    const first = await reportUnit(token, 'pm-dist-ok', 0, 'success');
    expect(permitOf(first.body)).toMatchObject({ consumedPoints: 35, frozenPoints: 15 });
    const consume = ledgerRows().find(row => row.kind === 'consume');
    expect(consume).toMatchObject({ delta: -35, note: 'distribution_planning unit 0' });

    // 整体失败退全款：含基础费的 permit 全部单位失败 → 基础费也随回补退回，
    // consumed + refunded + frozen == total 恒等式仍成立。
    await applyPermit(token, {
      permitId: 'pm-dist-allfail',
      operation: 'distribution_planning',
      units: 2,
      unitPrice: 5,
      basePrice: 30,
    });
    await reportUnit(token, 'pm-dist-allfail', 0, 'failure');
    const lastFail = await reportUnit(token, 'pm-dist-allfail', 1, 'failure');
    expect(permitOf(lastFail.body)).toMatchObject({
      status: 'settled',
      consumedPoints: 0,
      refundedPoints: 40,
      frozenPoints: 0,
    });
  });

  it('releases all remaining frozen points on close (unreported units refund)', async () => {
    const { accessToken: token } = await provisionLoggedInAccount(tb.app);

    await applyPermit(token, { permitId: 'pm-article-crash', operation: 'article_generation', units: 5, unitPrice: 20 });
    await reportUnit(token, 'pm-article-crash', 0, 'success');
    await reportUnit(token, 'pm-article-crash', 1, 'failure');

    // 中止收尾：3 个未回报单位全部回补。
    const closed = await closePermit(token, 'pm-article-crash');
    expect(closed.status).toBe(200);
    expect(permitOf(closed.body)).toMatchObject({
      status: 'settled',
      consumedPoints: 20,
      refundedPoints: 80,
      frozenPoints: 0,
      unitsUnreported: 3,
    });

    const balance = await getJson(tb.app, '/billing/balance', token);
    expect(balance.body.balance).toEqual({ total: 480, frozen: 0, available: 480 });

    // 结清后不能再回报新单位。
    const late = await reportUnit(token, 'pm-article-crash', 2, 'failure');
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('permit_settled');
  });

  it('scopes permits to their owner and guards the billing endpoints', async () => {
    await provisionAccount(tb.app, '13800000001', 'initial-pass-1');
    await provisionAccount(tb.app, '13800000002', 'initial-pass-2');
    const owner = await loginAccount(tb.app, '13800000001', 'initial-pass-1');
    const other = await loginAccount(tb.app, '13800000002', 'initial-pass-2');
    const ownerToken = str(owner.body.accessToken);
    const otherToken = str(other.body.accessToken);

    await applyPermit(ownerToken, { permitId: 'pm-owned-1', operation: 'material_import', units: 1, unitPrice: 20 });

    // 无凭证 / 运营 token（audience 不同）都不能进 /billing/*。
    expect((await getJson(tb.app, '/billing/balance')).status).toBe(401);
    const adminLogin = await postJson(tb.app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
    const asAdmin = await getJson(tb.app, '/billing/balance', str(adminLogin.body.adminToken));
    expect(asAdmin.status).toBe(401);

    // 他人 permitId 一律 404，不泄露存在性；回报/结清同理。
    expect((await getJson(tb.app, '/billing/permits/pm-owned-1', otherToken)).status).toBe(404);
    const crossReport = await reportUnit(otherToken, 'pm-owned-1', 0, 'success');
    expect(crossReport.status).toBe(404);
    expect((await closePermit(otherToken, 'pm-owned-1')).status).toBe(404);
    expect((await getJson(tb.app, '/billing/permits/pm-owned-1', ownerToken)).status).toBe(200);

    // 未知 permit、越界单位、改报结果。
    expect((await getJson(tb.app, '/billing/permits/pm-no-such', ownerToken)).status).toBe(404);
    await applyPermit(ownerToken, { permitId: 'pm-owned-2', operation: 'question_pool', units: 1, unitPrice: 15 });
    const badUnit = await reportUnit(ownerToken, 'pm-owned-2', 7, 'success');
    expect(badUnit.status).toBe(400);
    expect(badUnit.body.error).toBe('invalid_unit');
    await reportUnit(ownerToken, 'pm-owned-2', 0, 'failure');
    const flip = await reportUnit(ownerToken, 'pm-owned-2', 0, 'success');
    expect(flip.status).toBe(409);
    expect(flip.body.error).toBe('unit_outcome_conflict');

    // permitId 形状与请求体校验。
    const badId = await applyPermit(ownerToken, {
      permitId: 'bad id with spaces',
      operation: 'question_pool',
      units: 1,
      unitPrice: 15,
    });
    expect(badId.status).toBe(400);
    expect(badId.body.error).toBe('validation_error');
    const missingFields = await applyPermit(ownerToken, { operation: 'question_pool' });
    expect(missingFields.status).toBe(400);
  });
});
