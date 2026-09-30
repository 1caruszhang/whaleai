import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getJson,
  postJson,
  provisionLoggedInAccount,
  putJson,
  startTestBackend,
  str,
  type TestBackend,
} from './helpers';

/**
 * 票 50 验收：PUT /auth/me/brands 品牌集服务端镜像（客户端全量快照上报）。
 * 全部走 startTestBackend 的 HTTP 合约 seam（临时 SQLite + 假时钟，无真实
 * 网络）。语义：账号鉴权（requireAccountAuth）；请求体 [{workspaceId, name}]
 * 全量快照，事务内整组替换该账号行（幂等：重复 PUT 结果一致）；停用账号
 * 403（品牌集冻结在最后状态）；name 非空 ≤64、workspaceId 1..64、每账号
 * ≤100 条，超限 400。运营台只读侧由 GET /admin/accounts 的 brands 字段
 * 承接（票 47 已渲染 chips）。
 */

describe('PUT /auth/me/brands（票 50 品牌集镜像上报）', () => {
  let tb: TestBackend;
  beforeEach(async () => {
    tb = await startTestBackend();
  });
  afterEach(async () => {
    await tb.cleanup();
  });

  async function loggedInAccount(phone = '13800000001', password = 'initial-pass-1') {
    return provisionLoggedInAccount(tb.app, phone, password);
  }

  /** 运营台列表里的品牌集投影（name 升序），直接吃真实镜像数据。 */
  async function adminBrands(accountId: string): Promise<{ workspaceId: string; name: string }[]> {
    const login = await postJson(tb.app, '/admin/login', { password: 'ops-password-123' });
    const list = await getJson(tb.app, '/admin/accounts', str(login.body.adminToken));
    if (list.status !== 200) throw new Error(`admin list failed: ${JSON.stringify(list)}`);
    const rows = list.body.accounts as {
      id: string;
      brands: { workspaceId: string; name: string }[];
    }[];
    const row = rows.find(candidate => candidate.id === accountId);
    if (!row) throw new Error(`account ${accountId} not in admin list`);
    return row.brands;
  }

  it('账号鉴权：无凭证 401，伪造 token 401', async () => {
    const noToken = await putJson(tb.app, '/auth/me/brands', []);
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toBe('invalid_token');

    const forged = await putJson(tb.app, '/auth/me/brands', [], 'not-a-jwt');
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe('invalid_token');
  });

  it('全量快照整组替换且幂等：重复 PUT 结果一致，后写覆盖前写', async () => {
    const { accountId, accessToken } = await loggedInAccount();

    const first = await putJson(
      tb.app,
      '/auth/me/brands',
      [
        { workspaceId: 'ws-b', name: '品牌二' },
        { workspaceId: 'ws-a', name: '品牌一' },
      ],
      accessToken,
    );
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);

    // 运营台看到镜像（name 升序，与 GET /admin/accounts 契约一致）。
    expect(await adminBrands(accountId)).toEqual([
      { workspaceId: 'ws-a', name: '品牌一' },
      { workspaceId: 'ws-b', name: '品牌二' },
    ]);

    // 重复同一快照：结果逐字节一致（幂等）。
    const repeated = await putJson(
      tb.app,
      '/auth/me/brands',
      [
        { workspaceId: 'ws-b', name: '品牌二' },
        { workspaceId: 'ws-a', name: '品牌一' },
      ],
      accessToken,
    );
    expect(repeated.status).toBe(200);
    expect(await adminBrands(accountId)).toEqual([
      { workspaceId: 'ws-a', name: '品牌一' },
      { workspaceId: 'ws-b', name: '品牌二' },
    ]);
    const count = tb.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM account_brands WHERE account_id = ?',
      [accountId],
    );
    expect(count?.count).toBe(2);

    // 后写覆盖：改名 + 删一 + 增一，旧行不残留（整组替换，非增量合并）。
    const overwrite = await putJson(
      tb.app,
      '/auth/me/brands',
      [
        { workspaceId: 'ws-a', name: '品牌一（改名）' },
        { workspaceId: 'ws-c', name: '品牌三' },
      ],
      accessToken,
    );
    expect(overwrite.status).toBe(200);
    expect(await adminBrands(accountId)).toEqual([
      { workspaceId: 'ws-a', name: '品牌一（改名）' },
      { workspaceId: 'ws-c', name: '品牌三' },
    ]);

    // 空快照清空（删除最后一个品牌）。
    const cleared = await putJson(tb.app, '/auth/me/brands', [], accessToken);
    expect(cleared.status).toBe(200);
    expect(await adminBrands(accountId)).toEqual([]);
  });

  it('快照只替换本账号行：不同账号互不串扰', async () => {
    const { accountId, accessToken } = await loggedInAccount('13800000001');
    const other = await loggedInAccount('13800000002');
    await putJson(
      tb.app,
      '/auth/me/brands',
      [{ workspaceId: 'ws-1', name: '我的品牌' }],
      accessToken,
    );
    expect(await adminBrands(accountId)).toEqual([
      { workspaceId: 'ws-1', name: '我的品牌' },
    ]);
    expect(await adminBrands(other.accountId)).toEqual([]);
  });

  it('停用账号 403：PUT 被拒，品牌集冻结在最后状态', async () => {
    const { accountId, accessToken, adminToken } = await loggedInAccount();
    await putJson(
      tb.app,
      '/auth/me/brands',
      [{ workspaceId: 'ws-1', name: '冻结前的品牌' }],
      accessToken,
    );

    const disabled = await postJson(
      tb.app,
      `/admin/accounts/${accountId}/status`,
      { status: 'disabled' },
      adminToken,
    );
    expect(disabled.status).toBe(200);

    const afterDisable = await putJson(
      tb.app,
      '/auth/me/brands',
      [{ workspaceId: 'ws-2', name: '停用后尝试覆盖' }],
      accessToken,
    );
    expect(afterDisable.status).toBe(403);
    expect(afterDisable.body.error).toBe('account_disabled');

    // 冻结在最后状态：运营台仍可读到停用前的镜像，且未被覆盖。
    expect(await adminBrands(accountId)).toEqual([
      { workspaceId: 'ws-1', name: '冻结前的品牌' },
    ]);
  });

  it('校验 400：name 非空 ≤64、workspaceId 1..64、每账号 ≤100 条、数组形状', async () => {
    const { accessToken } = await loggedInAccount();
    const tooLong = '长'.repeat(65);

    const cases: { label: string; body: unknown }[] = [
      { label: 'body 非数组', body: { workspaceId: 'ws-1', name: '品牌' } },
      { label: 'name 为空串', body: [{ workspaceId: 'ws-1', name: '' }] },
      { label: 'name 超 64 字符', body: [{ workspaceId: 'ws-1', name: tooLong }] },
      { label: 'workspaceId 为空串', body: [{ workspaceId: '', name: '品牌' }] },
      { label: 'workspaceId 超 64 字符', body: [{ workspaceId: tooLong, name: '品牌' }] },
      {
        label: '超过 100 条',
        body: Array.from({ length: 101 }, (_, index) => ({
          workspaceId: `ws-${index}`,
          name: `品牌${index}`,
        })),
      },
      {
        label: '同一快照内 workspaceId 重复',
        body: [
          { workspaceId: 'ws-1', name: '品牌一' },
          { workspaceId: 'ws-1', name: '品牌二' },
        ],
      },
    ];

    for (const testCase of cases) {
      const response = await putJson(tb.app, '/auth/me/brands', testCase.body, accessToken);
      expect(response.status, testCase.label).toBe(400);
      expect(response.body.error, testCase.label).toBe('validation_error');
    }

    // 100 条整好在上限内：通过。
    const atLimit = await putJson(
      tb.app,
      '/auth/me/brands',
      Array.from({ length: 100 }, (_, index) => ({
        workspaceId: `ws-${index}`,
        name: `品牌${index}`,
      })),
      accessToken,
    );
    expect(atLimit.status).toBe(200);

    // 校验失败不落任何行（原子性：整组替换在事务内）。
    const rows = tb.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM account_brands',
      [],
    );
    expect(rows?.count).toBe(100);
  });
});
