import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { BackendEnv } from '../src/http/app';
import { refreshDistributionPoolSnapshot } from '../src/domain/distribution-pool-snapshot';
import {
  isSnapshotStale,
  nextDailyRefreshAt,
  startDistributionPoolScheduler,
  type PoolSchedulerTimers,
} from '../src/domain/distribution-pool-scheduler';
import {
  getJson,
  provisionLoggedInAccount,
  startTestBackend,
  TEST_ADMIN_PASSWORD,
  type TestBackend,
} from './helpers';

/**
 * 偏好召回名单运营台化验收：/admin/preference-channels SSR CRUD（表单
 * POST / PRG 303 / cookie 会话 / HTML 转义 / 非法码拒绝零写入）+
 * /config/preference-channels 按官方行业分类码下发（码过滤 / 通用兜底 /
 * 核心名去重 / 他行业不返回 / 账号 token 鉴权）。全部走 app.request 的
 * HTTP 合约边界，不触真实网络。
 */

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

async function pageLogin(app: Hono<BackendEnv>): Promise<string> {
  const response = await postForm(app, '/admin/session', { password: TEST_ADMIN_PASSWORD });
  expect(response.status).toBe(303);
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).not.toBe('');
  return setCookie.split(';')[0];
}

function channelNames(
  body: unknown,
): { name: string; domain?: string; exact: boolean; kind?: string; resourceId?: number }[] {
  if (typeof body !== 'object' || body === null) throw new Error('body is not an object');
  const channels = (body as { channels?: unknown }).channels;
  if (!Array.isArray(channels)) throw new Error('channels is not an array');
  return channels as {
    name: string;
    domain?: string;
    exact: boolean;
    kind?: string;
    resourceId?: number;
  }[];
}

describe('preference channels admin + config endpoint', () => {
  let tb: TestBackend;

  beforeEach(async () => {
    tb = await startTestBackend({ config: { adminLoginThrottleUnitMs: 1 } });
  });

  afterEach(async () => {
    await tb.cleanup();
  });

  it('seeds the ten built-in preference channels as universal rows', async () => {
    const cookie = await pageLogin(tb.app);
    const response = await getHtml(tb.app, '/admin/preference-channels', cookie);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('通用');
    expect(html).toContain('蓝色河畔（GEO排名）');
    expect(html).toContain('列举网（AI包收录）');
    // 种子行数与分组标题齐全。
    const rows = tb.db.all<{ name: string }>(
      "SELECT name FROM preference_channels WHERE category = 0 ORDER BY created_at, id",
      [],
    );
    expect(rows.length).toBe(10);
    expect(rows.map(row => row.name)).toContain('博客园（GEO 优化首选，秒发带联系方式）');
  });

  it('adds and deletes entries via admin forms with PRG redirects', async () => {
    const cookie = await pageLogin(tb.app);
    const add = await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '13',
      name: '红餐网',
      domain: 'canyinj.com',
      exact: 'on',
    }, cookie);
    expect(add.status).toBe(303);
    expect(add.headers.get('location')).toBe('/admin/preference-channels');
    const row = tb.db.get<{ id: string; category: number; name: string; domain: string; exact: number }>(
      "SELECT id, category, name, domain, exact FROM preference_channels WHERE name = '红餐网'",
      [],
    );
    expect(row).toMatchObject({ category: 13, domain: 'canyinj.com', exact: 1 });

    const remove = await postForm(
      tb.app,
      `/admin/ui/preference-channels/${encodeURIComponent(row!.id)}/delete`,
      {},
      cookie,
    );
    expect(remove.status).toBe(303);
    expect(
      tb.db.get<{ name: string }>("SELECT name FROM preference_channels WHERE name = '红餐网'", []),
    ).toBeUndefined();
  });

  it('escapes channel names on the admin page (XSS)', async () => {
    const cookie = await pageLogin(tb.app);
    const add = await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '0',
      name: '<script>alert(1)</script>',
      domain: '',
      exact: 'on',
    }, cookie);
    expect(add.status).toBe(303);
    const html = await (await getHtml(tb.app, '/admin/preference-channels', cookie)).text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
  });

  it('rejects invalid category / oversized name with zero writes', async () => {
    const cookie = await pageLogin(tb.app);
    const before = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!;
    const badCategory = await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '99',
      name: '幽灵渠道',
      domain: '',
      exact: 'on',
    }, cookie);
    expect(badCategory.status).toBe(400);
    const badName = await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '13',
      name: 'x'.repeat(201),
      domain: '',
      exact: 'on',
    }, cookie);
    expect(badName.status).toBe(400);
    const after = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!;
    expect(after.count).toBe(before.count);
    expect(
      tb.db.get<{ name: string }>("SELECT name FROM preference_channels WHERE name = '幽灵渠道'", []),
    ).toBeUndefined();
  });

  it('blocks unauthenticated page and form access with zero writes', async () => {
    const anonymousPage = await getHtml(tb.app, '/admin/preference-channels');
    expect(anonymousPage.status).toBe(303);
    expect(anonymousPage.headers.get('location')).toBe('/admin');
    const before = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!;
    const anonymousAdd = await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '13',
      name: '匿名渠道',
      domain: '',
      exact: 'on',
    });
    expect(anonymousAdd.status).toBe(303);
    const anonymousDelete = await postForm(
      tb.app,
      '/admin/ui/preference-channels/seed-preference-01/delete',
      {},
    );
    expect(anonymousDelete.status).toBe(303);
    const after = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!;
    expect(after.count).toBe(before.count);
    expect(tb.db.get<{ id: string }>("SELECT id FROM preference_channels WHERE id = 'seed-preference-01'", []))
      .toBeDefined();
  });

  it('serves codes-filtered channels to logged-in accounts with universal fallback', async () => {
    const { accessToken } = await provisionLoggedInAccount(tb.app);
    const cookie = await pageLogin(tb.app);
    await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '13',
      name: '红餐网',
      domain: 'canyinj.com',
      exact: 'on',
    }, cookie);
    await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '7',
      name: '汽车之家',
      domain: '',
      exact: 'on',
    }, cookie);
    // 26=工业贸易（媒体附录独有类目的补位码）：工业线品牌的行业隔离入口。
    await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '26',
      name: '中国工业网',
      domain: '',
      exact: 'on',
    }, cookie);

    // 美食(13) 计划：有行业行 → 只回行业行（回落语义：通用不并集）。
    const food = await getJson(tb.app, '/config/preference-channels?codes=13', accessToken);
    expect(food.status).toBe(200);
    const foodNames = channelNames(food.body).map(channel => channel.name);
    expect(foodNames).toContain('红餐网');
    expect(foodNames).not.toContain('蓝色河畔（GEO排名）');
    expect(foodNames).not.toContain('汽车之家');
    expect(foodNames).not.toContain('中国工业网');

    // 汽车(7) 计划：只回汽车行。
    const auto = await getJson(tb.app, '/config/preference-channels?codes=7', accessToken);
    const autoNames = channelNames(auto.body).map(channel => channel.name);
    expect(autoNames).toEqual(['汽车之家']);

    // 工业贸易(26) 计划：补位码生效，同样不并集通用。
    const industry = await getJson(tb.app, '/config/preference-channels?codes=26', accessToken);
    const industryNames = channelNames(industry.body).map(channel => channel.name);
    expect(industryNames).toEqual(['中国工业网']);

    // 空码集（品牌未填行业）= 回落只回通用行。
    const generic = await getJson(tb.app, '/config/preference-channels', accessToken);
    const genericNames = channelNames(generic.body).map(channel => channel.name);
    expect(genericNames).toContain('蓝色河畔（GEO排名）');
    expect(genericNames).not.toContain('红餐网');
    expect(genericNames).not.toContain('汽车之家');
  });

  it('dedupes entries sharing the same core name (seeded suffix variants)', async () => {
    const { accessToken } = await provisionLoggedInAccount(tb.app);
    const cookie = await pageLogin(tb.app);
    // 与种子「博客园（GEO 优化首选，秒发带联系方式）」同核心名的手输行。
    await postForm(tb.app, '/admin/ui/preference-channels', {
      category: '0',
      name: '博客园',
      domain: '',
      exact: 'on',
    }, cookie);
    const response = await getJson(tb.app, '/config/preference-channels', accessToken);
    const names = channelNames(response.body).map(channel => channel.name);
    const cnblogs = names.filter(name => name.includes('博客园'));
    expect(cnblogs).toEqual(['博客园（GEO 优化首选，秒发带联系方式）']);
  });

  it('rejects malformed codes and unauthenticated pulls', async () => {
    const anonymous = await getJson(tb.app, '/config/preference-channels?codes=13');
    expect(anonymous.status).toBe(401);
    const { accessToken } = await provisionLoggedInAccount(tb.app);
    const badCodes = await getJson(tb.app, '/config/preference-channels?codes=13,x', accessToken);
    expect(badCodes.status).toBe(400);
    const overflow = await getJson(
      tb.app,
      `/config/preference-channels?codes=${Array.from({ length: 33 }, () => '13').join(',')}`,
      accessToken,
    );
    expect(overflow.status).toBe(400);
  });
});

// ── 匹配挑选流程 P1：池快照 + id 绑定 + 名称兜底（规格
//    specs/tech_docs/preference_channel_pick_flow.md）──────────────────────

const PICK_FIXED_MS = Date.parse('2026-09-08T03:04:05.000Z');

/** 上游资源条目（wire 形态：price 元、entrance_link 入口链接、类目码按形态）。 */
interface FakePoolItem {
  id: number;
  name: string;
  entrance_link: string | null;
  price: number | string;
  status: number;
  geo_platforms: { id: number; label: string | null }[];
  /** 媒体频道类型码（channel_type，如 18=食品餐饮）。 */
  channel_type?: number;
  /** 自媒体行业分类码（industry_category，1-25）。 */
  industry_category?: number;
  /** 自媒体所属平台码（platform，如 6=今日头条）。 */
  platform?: number;
  /** 自媒体参考粉丝数档位（fans_number，1-9）。 */
  fans_number?: number;
}

/** 伪造超级媒介资源列表：按 page/size 真切片（refresh 走 size=200 串行分页）。 */
function fakePoolUpstream(pool: {
  media: FakePoolItem[];
  weMedia: FakePoolItem[];
  failNow?: () => boolean;
}): { fetch: typeof globalThis.fetch; paths: string[] } {
  const paths: string[] = [];
  const fetch = async (input: unknown): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : String((input as Request).url));
    if (pool.failNow?.()) return new Response('upstream boom', { status: 500 });
    // /resource/query 批查（校验名单）：按 id[] 过滤返回 {id,name,price,status}。
    if (url.pathname === '/api/media/resource/query' || url.pathname === '/api/we-media/resource/query') {
      paths.push(url.pathname);
      const items = url.pathname === '/api/media/resource/query' ? pool.media : pool.weMedia;
      const ids = url.searchParams.getAll('id[]').map(value => Number.parseInt(value, 10));
      const found = items
        .filter(item => ids.includes(item.id))
        .map(item => ({ id: item.id, name: item.name, price: item.price, status: item.status }));
      return Response.json({ code: 200, data: found });
    }
    paths.push(`${url.pathname}?page=${url.searchParams.get('page')}&size=${url.searchParams.get('size')}`);
    const items = url.pathname === '/api/media/resource'
      ? pool.media
      : url.pathname === '/api/we-media/resource'
        ? pool.weMedia
        : null;
    if (items === null) return new Response('not found', { status: 404 });
    const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
    const size = Number.parseInt(url.searchParams.get('size') ?? '20', 10);
    return Response.json({
      code: 200,
      data: { total: items.length, items: items.slice((page - 1) * size, page * size) },
    });
  };
  return { fetch, paths };
}

function poolItem(
  id: number,
  name: string,
  overrides: Partial<FakePoolItem> = {},
): FakePoolItem {
  return {
    id,
    name,
    entrance_link: `https://www.example-${id}.com/entrance`,
    price: 12.3,
    status: 2,
    geo_platforms: [{ id: 1, label: '豆包' }],
    ...overrides,
  };
}

describe('preference channel pick flow (pool snapshot + id binding)', () => {
  let tb: TestBackend;

  afterEach(async () => {
    await tb.cleanup();
  });

  /** 带伪造上游起独立后端；默认先登录并刷新一次池快照（搜索/勾选的前置）。 */
  async function startWithPool(
    pool: Parameters<typeof fakePoolUpstream>[0],
    options: { refreshFirst?: boolean } = {},
  ): Promise<{ paths: string[]; cookie: string }> {
    const { fetch, paths } = fakePoolUpstream(pool);
    tb = await startTestBackend({
      fetch,
      config: { adminLoginThrottleUnitMs: 1 },
      initialNowMs: PICK_FIXED_MS,
    });
    const cookie = await pageLogin(tb.app);
    if (options.refreshFirst !== false) {
      const refresh = await postForm(
        tb.app,
        '/admin/ui/preference-channels/snapshot/refresh',
        {},
        cookie,
      );
      expect(refresh.status).toBe(303);
    }
    return { paths, cookie };
  }

  async function snapshotCount(): Promise<number> {
    return tb.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM distribution_pool_snapshot',
      [],
    )!.count;
  }

  it('refreshes the pool snapshot across pages and shows the snapshot time', async () => {
    // 205 条媒体 = 200+5 两页（size=200 上限）；2 条自媒体一页收完。
    const media = Array.from({ length: 205 }, (_, i) => poolItem(1000 + i, `池媒体${i}`));
    const { paths } = await startWithPool(
      {
        media,
        weMedia: [poolItem(2001, '池自媒体一号'), poolItem(2002, '池自媒体二号')],
      },
      { refreshFirst: false },
    );
    const cookie = await pageLogin(tb.app);
    const refresh = await postForm(tb.app, '/admin/ui/preference-channels/snapshot/refresh', {}, cookie);
    expect(refresh.status).toBe(303);
    expect(refresh.headers.get('location')).toBe('/admin/preference-channels');
    expect(await snapshotCount()).toBe(207);
    // 全部行同一 fetched_at（刷新开始时刻，假时钟锚定）。
    const stamps = tb.db.all<{ fetched_at: string }>(
      'SELECT DISTINCT fetched_at FROM distribution_pool_snapshot',
      [],
    );
    expect(stamps).toEqual([{ fetched_at: '2026-09-08T03:04:05.000Z' }]);
    // 媒体两页串行（page=1 → page=2），页大小固定 200；自媒体一页。
    expect(paths.filter(path => path.startsWith('/api/media/resource'))).toEqual([
      '/api/media/resource?page=1&size=200',
      '/api/media/resource?page=2&size=200',
    ]);
    expect(paths.filter(path => path.startsWith('/api/we-media/resource'))).toEqual([
      '/api/we-media/resource?page=1&size=200',
    ]);
    const html = await (await getHtml(tb.app, '/admin/preference-channels', cookie)).text();
    expect(html).toContain('池快照：2026-09-08 03:04（媒体+自媒体共 207 条）');
  });

  it('keeps the old snapshot untouched when an upstream page fails mid-refresh', async () => {
    let fail = false;
    await startWithPool(
      {
        media: [poolItem(1, '媒体一号')],
        weMedia: [poolItem(2, '自媒体一号')],
        failNow: () => fail,
      },
      { refreshFirst: false },
    );
    const cookie = await pageLogin(tb.app);
    await postForm(tb.app, '/admin/ui/preference-channels/snapshot/refresh', {}, cookie);
    expect(await snapshotCount()).toBe(2);
    fail = true;
    const broken = await postForm(tb.app, '/admin/ui/preference-channels/snapshot/refresh', {}, cookie);
    expect(broken.status).toBe(502);
    expect(await snapshotCount()).toBe(2);
    expect(
      tb.db.get<{ fetched_at: string }>('SELECT fetched_at FROM distribution_pool_snapshot WHERE resource_id = 1', []),
    ).toMatchObject({ fetched_at: '2026-09-08T03:04:05.000Z' });
  });

  it('verifies bound rows via batch query: rewrite name/price/status, delist removed, PRG back', async () => {
    // 绑定 101（媒体）与 202（自媒体）；未绑定的 102 不参与校验（批查 id
    // 只含名单绑定行）。保留数组引用：校验前直接改伪造上游，模拟挂牌漂移
    // 与除名。
    const media = [
      poolItem(101, '蓝色河畔', { price: 45, channel_type: 18, geo_platforms: [] }),
      poolItem(102, '旁观者网', { price: 30, geo_platforms: [] }),
    ];
    const weMedia = [poolItem(202, '美食号', { price: '8.00', industry_category: 13, geo_platforms: [] })];
    const { paths } = await startWithPool({ media, weMedia });
    const cookie = await pageLogin(tb.app);
    const pick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      viewIndustry: '13',
      'pick:media:101': 'on',
      'pick:we-media:202': 'on',
    }, cookie);
    expect(pick.status).toBe(303);
    paths.length = 0;
    // 上游漂移：101 改名/涨价/状态 3（未上架）；202 除名（批查不返回）。
    media[0] = { ...media[0]!, name: '蓝色河畔（新挂牌）', price: 99, status: 3 };
    weMedia.splice(0, 1);

    const verify = await postForm(
      tb.app,
      '/admin/ui/preference-channels/snapshot/verify',
      { viewIndustry: '13' },
      cookie,
    );
    expect(verify.status).toBe(303);
    expect(verify.headers.get('location')).toBe('/admin/preference-channels?industry=13');
    // 批查只打名单绑定行（200/批；名称条目与未绑定快照行不回源）。
    expect(paths).toEqual(['/api/media/resource/query', '/api/we-media/resource/query']);
    // 101 回写名称/价格/状态；fetched_at 不动（行溯源仍是全量刷新时刻）。
    expect(
      tb.db.get<{ name: string; price_cents: number; status: number; fetched_at: string }>(
        "SELECT name, price_cents, status, fetched_at FROM distribution_pool_snapshot WHERE kind = 'media' AND resource_id = 101",
        [],
      ),
    ).toMatchObject({ name: '蓝色河畔（新挂牌）', price_cents: 9900, status: 3, fetched_at: '2026-09-08T03:04:05.000Z' });
    // 202 上游除名 = 下架：快照行删除；未绑定的 102 与名单行均不受影响。
    expect(
      tb.db.get<{ name: string }>(
        "SELECT name FROM distribution_pool_snapshot WHERE kind = 'we-media' AND resource_id = 202",
        [],
      ),
    ).toBeUndefined();
    expect(
      tb.db.get<{ name: string }>('SELECT name FROM distribution_pool_snapshot WHERE resource_id = 102', []),
    ).toMatchObject({ name: '旁观者网' });
    expect(
      tb.db.get<{ resource_id: number }>('SELECT resource_id FROM preference_channels WHERE resource_id = 202', []),
    ).toMatchObject({ resource_id: 202 });
    // 页面口径：101 状态 3 显示「已下架」，202 绑定行显示「快照缺失」。
    const html = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13', cookie)
    ).text();
    expect(html).toContain('已下架');
    expect(html).toContain('快照缺失');
  });

  it('keeps the snapshot untouched when the verify batch query fails', async () => {
    const media = [poolItem(101, '蓝色河畔', { channel_type: 18, geo_platforms: [] })];
    let fail = false;
    await startWithPool({ media, weMedia: [], failNow: () => fail });
    const cookie = await pageLogin(tb.app);
    const pick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:101': 'on',
    }, cookie);
    expect(pick.status).toBe(303);
    media[0] = { ...media[0]!, name: '改名后的蓝色河畔' };
    fail = true;
    const broken = await postForm(tb.app, '/admin/ui/preference-channels/snapshot/verify', {}, cookie);
    expect(broken.status).toBe(502);
    // 零写入：行仍在且保持全量刷新时的名称。
    expect(
      tb.db.get<{ name: string }>(
        "SELECT name FROM distribution_pool_snapshot WHERE kind = 'media' AND resource_id = 101",
        [],
      ),
    ).toMatchObject({ name: '蓝色河畔' });
  });

  it('searches the snapshot with contains matching, status coloring and escaped echo', async () => {
    await startWithPool({
      media: [
        poolItem(101, '蓝色河畔（GEO排名）', {
          entrance_link: 'https://www.lansehepan.com/news',
          price: 45,
          geo_platforms: [{ id: 1, label: '豆包' }, { id: 2, label: '元宝' }],
        }),
        poolItem(102, '蓝色河畔<script>', { price: '8.00' }),
      ],
      weMedia: [
        poolItem(202, '蓝色河畔美食号', { status: 4, geo_platforms: [] }),
        poolItem(203, '红安网（GEO排名）'),
      ],
    });
    const cookie = await pageLogin(tb.app);
    const html = await (      await getHtml(tb.app, '/admin/preference-channels?q=%E8%93%9D%E8%89%B2%E6%B2%B3%E7%95%94', cookie)
    ).text();
    // 包含匹配：三条「蓝色河畔」命中（媒体×2 + 自媒体×1），红安网不出现。
    expect(html).toContain('name="pick:media:101"');
    expect(html).toContain('name="pick:media:102"');
    expect(html).toContain('name="pick:we-media:202"');
    expect(html).not.toContain('pick:we-media:203');
    // 状态着色与 GEO 标记；上游名称回显转义；价格展示（元→两位小数）。
    expect(html).toContain('GEO ×2');
    expect(html).toContain('¥45.00');
    expect(html).toContain('¥8.00');
    expect(html).toContain('已下架');
    expect(html).toContain('蓝色河畔&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // 关键词回显经 esc()（value 属性内）。
    expect(html).toContain('value="蓝色河畔"');
    // 空关键词 = 不渲染结果区；无命中给出包含关键词的空态。
    const none = await (
      await getHtml(tb.app, '/admin/preference-channels?q=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E6%B8%A0%E9%81%93', cookie)
    ).text();
    expect(none).toContain('没有名称包含「不存在的渠道」');
  });

  it('caps search results at 50 rows', async () => {
    await startWithPool({
      media: Array.from({ length: 60 }, (_, i) => poolItem(3000 + i, `同词渠道${i}`)),
      weMedia: [],
    });
    const cookie = await pageLogin(tb.app);
    const html = await (await getHtml(tb.app, '/admin/preference-channels?q=%E5%90%8C%E8%AF%8D%E6%B8%A0%E9%81%93', cookie)).text();
    expect(html.match(/name="pick:media:\d+"/g)).toHaveLength(50);
  });

  it('pre-checks exact-name matches so a datalist selection can be confirmed directly', async () => {
    await startWithPool({
      media: [poolItem(101, '蓝色河畔'), poolItem(102, '蓝色河畔（GEO排名）')],
      weMedia: [poolItem(202, '蓝色河畔美食号')],
    });
    const cookie = await pageLogin(tb.app);
    // 精确名命中：同名行预勾选 + 提示；同家族其他行不动。
    const html = await (
      await getHtml(tb.app, '/admin/preference-channels?q=%E8%93%9D%E8%89%B2%E6%B2%B3%E7%95%94', cookie)
    ).text();
    expect(html).toContain('name="pick:media:101" checked');
    expect(html).toContain('名称与关键词完全一致的行已预勾选');
    expect(html).not.toContain('name="pick:media:102" checked');
    expect(html).not.toContain('name="pick:we-media:202" checked');
    // 模糊关键词（部分词）不触发预勾选（手动添加表单的 exact 复选框不受影响）。
    const partial = await (await getHtml(tb.app, '/admin/preference-channels?q=%E8%93%9D', cookie)).text();
    expect(partial).not.toMatch(/name="pick:(media|we-media):\d+" checked/);
  });

  it('filters candidates by industry with fallback-recall vertical rules', async () => {
    await startWithPool({
      media: [
        poolItem(101, '候选·蓝色河畔', { channel_type: 18, geo_platforms: [] }), // 食品餐饮 → 美食映射
        poolItem(102, '候选·汽车网', { channel_type: 6, geo_platforms: [] }), // 汽车网站 → 汽车映射
        poolItem(103, '候选·GEO未分类', { channel_type: 0, geo_platforms: [{ id: 1, label: '豆包' }] }), // 码0+GEO：GEO 不入选行业候选（仅展示），行业视图不可见
        poolItem(104, '候选·杂类', { channel_type: 0, geo_platforms: [] }), // 码0 无 GEO → 行业过滤下不可见
        poolItem(105, '候选·工业网', { channel_type: 19, geo_platforms: [] }), // 工业贸易（26 补位码的媒体映射）
      ],
      weMedia: [
        poolItem(201, '候选·美食号', { industry_category: 13, geo_platforms: [] }),
        poolItem(202, '候选·汽车号', { industry_category: 7, geo_platforms: [] }),
      ],
    });
    const cookie = await pageLogin(tb.app);
    // 13·美食：美食自媒体 + 媒体食品餐饮映射；GEO 标记仅展示不入选（103 不出现）。
    const food = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13&q=%E5%80%99%E9%80%89', cookie)
    ).text();
    expect(food).toContain('name="pick:media:101"');
    expect(food).toContain('name="pick:we-media:201"');
    expect(food).not.toContain('name="pick:media:102"');
    expect(food).not.toContain('name="pick:media:103"');
    expect(food).not.toContain('name="pick:media:104"');
    expect(food).not.toContain('name="pick:we-media:202"');
    expect(food).toContain('候选已按「13 · 美食」过滤');
    // 辨识列：媒体带频道类型名，自媒体无平台码时只显示形态。
    expect(food).toContain('媒体 · 食品餐饮');
    // 确认表单行业预选当前搜索行业。
    expect(food).toContain('<option value="13" selected');
    // 无媒体映射的行业（2 历史）：无候选（该行业自媒体也没有），给出空态而非 GEO 兜底。
    const history = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=2&q=%E5%80%99%E9%80%89', cookie)
    ).text();
    expect(history).toContain('该行业候选内没有名称包含「候选」的渠道');
    expect(history).not.toMatch(/name="pick:[a-z-]+:\d+"/);
    // 26 工业贸易（补位码）：媒体 19 映射生效，自媒体附录无此类目。
    const industry = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=26&q=%E5%80%99%E9%80%89', cookie)
    ).text();
    expect(industry).toContain('name="pick:media:105"');
    expect(industry.match(/name="pick:we-media:\d+"/g)).toBeNull();
    // 0·通用 = 不过滤全池（含 GEO 标记与全部类目）。
    const all = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=0&q=%E5%80%99%E9%80%89', cookie)
    ).text();
    expect(all.match(/name="pick:[a-z-]+:\d+"/g)).toHaveLength(7);
  });

  it('includes unclassified pool rows in the industry view when u=1 is checked', async () => {
    await startWithPool({
      media: [
        poolItem(101, '候选·蓝色河畔', { channel_type: 18, geo_platforms: [] }), // 食品餐饮 → 美食映射
        poolItem(104, '候选·杂闻网', { channel_type: 0, geo_platforms: [] }), // 码0 显式未分类
        poolItem(106, '候选·他频道', { channel_type: 100, geo_platforms: [] }), // 100=其他频道
        poolItem(107, '候选·无线', { geo_platforms: [] }), // 类目缺省 → NULL
        poolItem(108, '候选·套餐铺', { channel_type: 13, geo_platforms: [] }), // 营销专区：并入未分类也不入选
      ],
      weMedia: [
        poolItem(201, '候选·美食号', { industry_category: 13, geo_platforms: [] }),
        poolItem(204, '候选·无名号', { geo_platforms: [] }), // 行业分类缺省 → NULL
      ],
    });
    const cookie = await pageLogin(tb.app);
    // 缺省不勾 = 现状行为：只行业候选，未分类（NULL/0/100）与营销专区都不出现，
    // 复选框渲染且未选中。
    const off = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13&q=%E5%80%99%E9%80%89', cookie)
    ).text();
    expect(off).toContain('name="u" value="1"');
    expect(off).not.toContain('value="1" checked');
    expect(off).toContain('name="pick:media:101"');
    expect(off).toContain('name="pick:we-media:201"');
    for (const absent of [104, 106, 107, 108]) {
      expect(off).not.toContain(`name="pick:media:${absent}"`);
    }
    expect(off).not.toContain('name="pick:we-media:204"');
    // datalist 联动：未分类名不在候选里。
    expect(off).not.toContain('<option value="候选·杂闻网">');
    // 勾选 u=1：搜索结果并入 NULL/0/100 未分类（媒体+自媒体），营销专区
    // 13（套餐系列）仍排除——打包卖法不是渠道；复选框保持选中、提示生效。
    const on = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13&q=%E5%80%99%E9%80%89&u=1', cookie)
    ).text();
    expect(on).toContain('value="1" checked');
    expect(on).toContain('已并入未分类渠道');
    for (const present of [101, 104, 106, 107]) {
      expect(on).toContain(`name="pick:media:${present}"`);
    }
    expect(on).toContain('name="pick:we-media:201"');
    expect(on).toContain('name="pick:we-media:204"');
    expect(on).not.toContain('name="pick:media:108"');
    // datalist 联动：无搜索词的行业视图候选也含未分类名（u=1 随链接保持）。
    const onList = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13&u=1', cookie)
    ).text();
    expect(onList).toContain('<option value="候选·杂闻网">');
    expect(onList).toContain('<option value="候选·无名号">');
    expect(onList).not.toContain('<option value="候选·套餐铺">');
    // 无结果时的空态提示指向开关（不勾时；「无线」只存在于未分类行 107）。
    const hint = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13&q=%E6%97%A0%E7%BA%BF', cookie)
    ).text();
    expect(hint).toContain('或勾选「包含未分类」');
  });

  it('keeps the operator in the current industry view across pick and delete (PRG)', async () => {
    await startWithPool({
      media: [poolItem(101, '蓝色河畔', { channel_type: 18, geo_platforms: [] })],
      weMedia: [],
    });
    const cookie = await pageLogin(tb.app);
    const pick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      viewIndustry: '13',
      'pick:media:101': 'on',
    }, cookie);
    expect(pick.status).toBe(303);
    expect(pick.headers.get('location')).toBe('/admin/preference-channels?industry=13');
    const row = tb.db.get<{ id: string }>(
      'SELECT id FROM preference_channels WHERE resource_id = 101',
      [],
    )!;
    const remove = await postForm(
      tb.app,
      `/admin/ui/preference-channels/${encodeURIComponent(row.id)}/delete`,
      { viewIndustry: '13' },
      cookie,
    );
    expect(remove.headers.get('location')).toBe('/admin/preference-channels?industry=13');
    // 非法视图字段回落通用视图（不 400，不丢上下文以外的任何东西）。
    const bad = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '0',
      viewIndustry: '99',
      'pick:media:101': 'on',
    }, cookie);
    expect(bad.status).toBe(303);
    expect(bad.headers.get('location')).toBe('/admin/preference-channels');
  });

  it('shows persistent per-industry lists (details) alongside the universal list', async () => {
    await startWithPool({
      media: [poolItem(101, '蓝色河畔', { channel_type: 18, geo_platforms: [] })],
      weMedia: [],
    });
    const cookie = await pageLogin(tb.app);
    const pick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:101': 'on',
    }, cookie);
    expect(pick.status).toBe(303);
    // 行业视图 13：专属名单常驻且自动展开；通用名单恒展开；确认按钮带隐藏行业字段。
    const page13 = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13&q=%E8%93%9D%E8%89%B2%E6%B2%B3%E7%95%94', cookie)
    ).text();
    expect(page13).toContain('13 · 美食 专属名单（1 条）');
    expect(page13).toContain('<details open>');
    expect(page13).toContain('通用名单（10 条，兜底：行业无专属名单的计划使用）');
    expect(page13).toContain('确认添加到 13 · 美食');
    expect(page13).toContain('<input type="hidden" name="category" value="13">');
    expect(page13).not.toContain('手动添加');
    // 空行业视图：兜底提示移到添加卡；无搜索结果不出确认表单。
    const page7 = await (await getHtml(tb.app, '/admin/preference-channels?industry=7', cookie)).text();
    expect(page7).toContain('该行业还没有专属条目');
    expect(page7).not.toContain('<button type="submit">确认添加到');
    // 通用视图：行业名单仍常驻（折叠态，HTML 在场），但没有自动展开的行业。
    const page0 = await (await getHtml(tb.app, '/admin/preference-channels', cookie)).text();
    expect(page0).toContain('通用名单（10 条，兜底：行业无专属名单的计划使用）');
    expect(page0).toContain('13 · 美食 专属名单（1 条）');
    expect(page0).toContain('<td class="wrap">蓝色河畔</td>');
    expect(page0).not.toContain('<details open>');
    expect(page0).not.toContain('手动添加');
  });

  it('distinguishes same-name cross-platform accounts by platform and fans tier', async () => {
    await startWithPool({
      media: [],
      weMedia: [
        poolItem(301, '则言鉴闻', { industry_category: 18, platform: 6, fans_number: 4, geo_platforms: [] }),
        poolItem(302, '则言鉴闻', { industry_category: 18, platform: 5, fans_number: 2, geo_platforms: [] }),
        poolItem(303, '则言鉴闻', { industry_category: 18, platform: 4, geo_platforms: [] }),
      ],
    });
    const cookie = await pageLogin(tb.app);
    const html = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=18&q=%E5%88%99%E8%A8%80%E9%89%B4%E9%97%BB', cookie)
    ).text();
    // 三行同名：形态列带平台与粉丝档（无档位则只显示平台），可分辨可分别勾选。
    expect(html.match(/name="pick:we-media:\d+"/g)).toHaveLength(3);
    expect(html).toContain('自媒体 · 今日头条 · 1-5万粉');
    expect(html).toContain('自媒体 · 百家号 · 1-5千粉');
    expect(html).toContain('自媒体 · 搜狐网');
    // 勾选「头条号」那条落库，主列表名称旁灰显平台后缀。
    const pick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '18',
      'pick:we-media:301': 'on',
    }, cookie);
    expect(pick.status).toBe(303);
    const list = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=18', cookie)
    ).text();
    expect(list).toContain('则言鉴闻 <span class="muted">（今日头条）</span>');
  });

  it('scopes datalist suggestions to the selected industry', async () => {
    await startWithPool({
      media: [
        poolItem(101, '候选·蓝色河畔', { channel_type: 18, geo_platforms: [] }),
        poolItem(102, '候选·汽车网', { channel_type: 6, geo_platforms: [] }),
      ],
      weMedia: [poolItem(201, '候选·美食号', { industry_category: 13, geo_platforms: [] })],
    });
    const cookie = await pageLogin(tb.app);
    const food = await (
      await getHtml(tb.app, '/admin/preference-channels?industry=13', cookie)
    ).text();
    expect(food).toContain('<option value="候选·蓝色河畔"></option>');
    expect(food).toContain('<option value="候选·美食号"></option>');
    expect(food).not.toContain('<option value="候选·汽车网"></option>');
    // 行业下拉回显当前选择，且带内联 onchange 即时提交（零 JS 纪律的唯一例外）。
    expect(food).toContain('<option value="13" selected');
    expect(food).toContain('<select id="qIndustry" name="industry" onchange="this.form.submit()">');
  });

  it('pre-renders datalist name suggestions for the search input (zero-JS typeahead)', async () => {
    await startWithPool({
      media: [poolItem(101, '蓝色河畔'), poolItem(102, '蓝色河畔<script>')],
      weMedia: [],
    });
    const cookie = await pageLogin(tb.app);
    const html = await (await getHtml(tb.app, '/admin/preference-channels', cookie)).text();
    expect(html).toContain('<datalist id="poolNameSuggestions">');
    expect(html).toContain('<option value="蓝色河畔"></option>');
    // 搜索框绑定 datalist；上游名称照常转义（不产生可执行脚本）。
    expect(html).toContain('list="poolNameSuggestions"');
    expect(html).toContain('<option value="蓝色河畔&lt;script&gt;"></option>');
  });

  it('merges current search results into suggestions beyond the pre-rendered head', async () => {
    // 519 个头部名占满 500 上限，「独家候选」按（kind, resource_id）序排在头部之外。
    const media = Array.from({ length: 519 }, (_, i) => poolItem(4000 + i, `头部渠道${i}`));
    media.push(poolItem(4999, '独家候选'));
    await startWithPool({ media, weMedia: [] });
    const cookie = await pageLogin(tb.app);
    const plain = await (await getHtml(tb.app, '/admin/preference-channels', cookie)).text();
    expect(plain.match(/<option value="头部渠道\d+"><\/option>/g)).toHaveLength(500);
    expect(plain).not.toContain('<option value="独家候选"></option>');
    // 搜索命中后，头部之外的名字并入候选（提示覆盖「本次搜索」兜底）。
    const searched = await (
      await getHtml(tb.app, '/admin/preference-channels?q=%E7%8B%AC%E5%AE%B6%E5%80%99%E9%80%89', cookie)
    ).text();
    expect(searched).toContain('<option value="独家候选"></option>');
  });

  it('prompts to refresh first when the snapshot is empty', async () => {
    tb = await startTestBackend({ config: { adminLoginThrottleUnitMs: 1 } });
    const cookie = await pageLogin(tb.app);
    const html = await (await getHtml(tb.app, '/admin/preference-channels?q=%E6%B5%8B%E8%AF%95', cookie)).text();
    expect(html).toContain('尚未拉取');
    expect(html).toContain('池快照为空');
  });

  it('adds id-bound entries from checked rows with snapshot-sourced fields', async () => {
    await startWithPool({
      media: [
        poolItem(101, '蓝色河畔', { entrance_link: 'https://www.lansehepan.com/news' }),
      ],
      weMedia: [poolItem(202, '蓝色河畔美食号', { status: 4, entrance_link: null })],
    });
    const cookie = await pageLogin(tb.app);
    const pick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:101': 'on',
      'pick:we-media:202': 'on',
    }, cookie);
    expect(pick.status).toBe(303);
    expect(pick.headers.get('location')).toBe('/admin/preference-channels');
    const rows = tb.db.all<{
      kind: string;
      resource_id: number | null;
      name: string;
      domain: string;
      exact: number;
      category: number;
    }>(
      "SELECT kind, resource_id, name, domain, exact, category FROM preference_channels WHERE kind != '' ORDER BY resource_id",
      [],
    );
    expect(rows).toEqual([
      { kind: 'media', resource_id: 101, name: '蓝色河畔', domain: 'www.lansehepan.com', exact: 1, category: 13 },
      { kind: 'we-media', resource_id: 202, name: '蓝色河畔美食号', domain: '', exact: 1, category: 13 },
    ]);
    // 主列表（行业 13 视图）：绑定行的形态/匹配方式/快照状态（status=4 标红已下架）。
    const html = await (await getHtml(tb.app, '/admin/preference-channels?industry=13', cookie)).text();
    expect(html).toContain('按 id 绑定');
    expect(html).toContain('名称条目');
    // 已下架 在搜索结果区之外的主列表行也应出现（勾选了两行其中一行 status=4）。
    expect(html).toContain('已下架');
  });

  it('rejects picks missing from the snapshot or tampered, with zero writes', async () => {
    await startWithPool({ media: [poolItem(101, '蓝色河畔')], weMedia: [] });
    const cookie = await pageLogin(tb.app);
    const before = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!.count;
    // 引用不在快照内（快照漂移/伪造表单）→ 整批拒绝。
    const stale = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:999': 'on',
    }, cookie);
    expect(stale.status).toBe(400);
    // 勾选键形态被篡改 → 400。
    const tampered = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:abc': 'on',
    }, cookie);
    expect(tampered.status).toBe(400);
    // 无勾选 → 400；非法行业码 → 400。
    const empty = await postForm(tb.app, '/admin/ui/preference-channels/pick', { category: '13' }, cookie);
    expect(empty.status).toBe(400);
    const badCategory = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '99',
      'pick:media:101': 'on',
    }, cookie);
    expect(badCategory.status).toBe(400);
    const after = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!.count;
    expect(after).toBe(before);
  });

  it('skips duplicate bindings when the same pick is confirmed twice', async () => {
    await startWithPool({ media: [poolItem(101, '蓝色河畔')], weMedia: [] });
    const cookie = await pageLogin(tb.app);
    for (let round = 0; round < 2; round += 1) {
      const again = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
        category: '13',
        'pick:media:101': 'on',
      }, cookie);
      expect(again.status).toBe(303);
    }
    expect(
      tb.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM preference_channels WHERE kind = 'media' AND resource_id = 101",
        [],
      )!.count,
    ).toBe(1);
  });

  it('moves an entry across categories via the inline edit form', async () => {
    await startWithPool({ media: [poolItem(101, '蓝色河畔')], weMedia: [] });
    const cookie = await pageLogin(tb.app);
    await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:101': 'on',
    }, cookie);
    const row = tb.db.get<{ id: string; category: number; updated_at: string }>(
      "SELECT id, category, updated_at FROM preference_channels WHERE resource_id = 101",
      [],
    )!;
    tb.setNow(PICK_FIXED_MS + 60_000);
    const move = await postForm(
      tb.app,
      `/admin/ui/preference-channels/${encodeURIComponent(row.id)}/category`,
      { category: '7' },
      cookie,
    );
    expect(move.status).toBe(303);
    // 改行业后落到目标行业视图（行出现在哪里，操作者就看到哪里）。
    expect(move.headers.get('location')).toBe('/admin/preference-channels?industry=7');
    expect(
      tb.db.get<{ category: number; updated_at: string }>(
        'SELECT category, updated_at FROM preference_channels WHERE id = ?',
        [row.id],
      ),
    ).toMatchObject({ category: 7, updated_at: '2026-09-08T03:05:05.000Z' });
    // 非法码 400 且不落改动；未知 id 404。
    const badCategory = await postForm(
      tb.app,
      `/admin/ui/preference-channels/${encodeURIComponent(row.id)}/category`,
      { category: '99' },
      cookie,
    );
    expect(badCategory.status).toBe(400);
    expect(
      tb.db.get<{ category: number }>('SELECT category FROM preference_channels WHERE id = ?', [row.id])!.category,
    ).toBe(7);
    const missing = await postForm(
      tb.app,
      '/admin/ui/preference-channels/no-such-id/category',
      { category: '7' },
      cookie,
    );
    expect(missing.status).toBe(404);
  });

  it('serves id-bound entries with kind and resourceId to the config endpoint', async () => {
    await startWithPool({
      media: [poolItem(101, '蓝色河畔', { entrance_link: 'https://www.lansehepan.com/news' })],
      weMedia: [],
    });
    const cookie = await pageLogin(tb.app);
    await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:101': 'on',
    }, cookie);
    const { accessToken } = await provisionLoggedInAccount(tb.app);
    const food = await getJson(tb.app, '/config/preference-channels?codes=13', accessToken);
    expect(food.status).toBe(200);
    const channels = channelNames(food.body);
    // 回落语义：13 有行业行（绑定行）→ 只回它，通用种子不并集。
    expect(channels.map(channel => channel.name)).toEqual(['蓝色河畔']);
    const bound = channels[0]!;
    expect(bound).toMatchObject({
      domain: 'www.lansehepan.com',
      exact: true,
      kind: 'media',
      resourceId: 101,
    });
    // 其他行业（7）：无行业行 → 回落通用（种子名称条目，不带 kind/resourceId）。
    const auto = await getJson(tb.app, '/config/preference-channels?codes=7', accessToken);
    const autoChannels = channelNames(auto.body);
    expect(autoChannels.map(channel => channel.name)).toContain('蓝色河畔（GEO排名）');
    expect(autoChannels.map(channel => channel.name)).not.toContain('蓝色河畔');
    const seeded = autoChannels.find(channel => channel.name === '红安网（GEO排名）');
    expect(seeded).toMatchObject({ exact: true });
    expect(seeded!.kind).toBeUndefined();
    expect(seeded!.resourceId).toBeUndefined();
  });

  it('blocks anonymous access to pick, category and refresh forms with zero writes', async () => {
    const state = { fail: false };
    await startWithPool(
      {
        media: [poolItem(101, '蓝色河畔')],
        weMedia: [],
        failNow: () => state.fail,
      },
      { refreshFirst: false },
    );
    const before = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!.count;
    const anonymousPick = await postForm(tb.app, '/admin/ui/preference-channels/pick', {
      category: '13',
      'pick:media:101': 'on',
    });
    expect(anonymousPick.status).toBe(303);
    const anonymousRefresh = await postForm(tb.app, '/admin/ui/preference-channels/snapshot/refresh', {});
    expect(anonymousRefresh.status).toBe(303);
    expect(await snapshotCount()).toBe(0);
    const anonymousCategory = await postForm(
      tb.app,
      '/admin/ui/preference-channels/seed-preference-01/category',
      { category: '7' },
    );
    expect(anonymousCategory.status).toBe(303);
    const after = tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM preference_channels', [])!.count;
    expect(after).toBe(before);
    expect(
      tb.db.get<{ category: number }>(
        "SELECT category FROM preference_channels WHERE id = 'seed-preference-01'",
        [],
      )!.category,
    ).toBe(0);
  });
});

// ── 快照刷新护栏（runaway 上游）——直接打 domain 层（HTTP 路由的页间
//    sleep 是真实 120ms，翻满 1000 页护栏等不起；maxPages 注入压到 3 页）。

describe('pool snapshot refresh guard (runaway upstream)', () => {
  let tb: TestBackend;

  afterEach(async () => {
    await tb.cleanup();
  });

  it('fails with zero writes when pagination never completes within the page guard', async () => {
    tb = await startTestBackend({ config: { adminLoginThrottleUnitMs: 1 } });
    // runaway 上游：每页都吐同一批 200 条、total 虚报 60000——去重后永远
    // 收不满 total 也等不到空页。翻满页护栏必须整次失败零写入，绝不把
    // 残缺快照静默替换成「最近一次成功刷新的样子」的对立面。
    const page = Array.from({ length: 200 }, (_, i) => poolItem(7000 + i, `幽灵渠道${i}`));
    const calls: string[] = [];
    const fetchPage = async (kind: 'media' | 'we-media', pageNo: number) => {
      calls.push(`${kind}:${pageNo}`);
      return {
        total: 60_000,
        items: page.map(item => ({
          resourceId: item.id,
          name: item.name,
          domain: '',
          priceCents: 0,
          status: item.status,
          geoCount: 0,
          categoryCode: null,
          platform: null,
          fansNumber: null,
        })),
      };
    };
    await expect(
      refreshDistributionPoolSnapshot(
        { db: tb.db, config: tb.config, now: () => PICK_FIXED_MS },
        fetchPage,
        async () => undefined,
        0,
        3,
      ),
    ).rejects.toMatchObject({ code: 'upstream_unavailable', status: 502 });
    expect(calls).toEqual(['media:1', 'media:2', 'media:3']);
    expect(
      tb.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM distribution_pool_snapshot', [])!.count,
    ).toBe(0);
  });
});

describe('pool snapshot scheduler (P3.3, in-process daily refresh)', () => {
  let tb: TestBackend | undefined;

  afterEach(async () => {
    await tb?.cleanup();
  });

  async function snapshotCount(): Promise<number> {
    return tb!.db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM distribution_pool_snapshot',
      [],
    )!.count;
  }

  /** 轮询等待异步补刷落库（启动补刷不经请求返回值，只能观测库）。 */
  async function waitUntil(
    probe: () => Promise<boolean>,
    timeoutMs = 2_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() > deadline) throw new Error('waitUntil timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /** 手动可控定时器：记录排班延迟、由测试显式触发。 */
  function manualTimers(): {
    timers: PoolSchedulerTimers;
    fire: () => void;
    scheduledDelay: () => number;
  } {
    let callback: (() => void) | undefined;
    let delay = Number.NaN;
    return {
      timers: {
        schedule: (cb: () => void, ms: number) => {
          callback = cb;
          delay = ms;
          return {
            clear: () => {
              callback = undefined;
            },
          };
        },
      },
      fire: () => callback?.(),
      scheduledDelay: () => delay,
    };
  }

  it('anchors the daily run at 04:00 local time and rolls over once passed', () => {
    const localAt = (hour: number): Date => {
      const date = new Date();
      date.setHours(hour, 0, 0, 0);
      return date;
    };
    const day = 24 * 3_600_000;
    // 03:00 → 今日 04:00；恰 04:00 与 05:00 → 明日 04:00（任何时区皆成立）。
    expect(nextDailyRefreshAt(localAt(3))).toBe(localAt(4).getTime());
    expect(nextDailyRefreshAt(localAt(4))).toBe(localAt(4).getTime() + day);
    expect(nextDailyRefreshAt(localAt(5))).toBe(localAt(4).getTime() + day);
  });

  it('treats an empty or over-24h snapshot as stale', () => {
    const now = Date.parse('2026-09-08T12:00:00.000Z');
    expect(isSnapshotStale({ rows: 0, fetchedAt: null }, now)).toBe(true);
    expect(isSnapshotStale({ rows: 24_612, fetchedAt: null }, now)).toBe(true);
    expect(
      isSnapshotStale({ rows: 10, fetchedAt: '2026-09-08T11:00:00.000Z' }, now),
    ).toBe(false);
    expect(
      isSnapshotStale({ rows: 10, fetchedAt: '2026-09-07T11:59:00.000Z' }, now),
    ).toBe(true);
  });

  it('catches up a stale snapshot at startup, schedules the daily timer and skips a fresh one', async () => {
    const { fetch, paths } = fakePoolUpstream({
      media: [poolItem(1, '媒体一号')],
      weMedia: [poolItem(2, '自媒体一号')],
    });
    tb = await startTestBackend({
      fetch,
      config: { adminLoginThrottleUnitMs: 1 },
      initialNowMs: PICK_FIXED_MS,
    });
    let now = PICK_FIXED_MS;
    const { timers, fire, scheduledDelay } = manualTimers();
    // 空快照 = 过期：启动即补刷（异步，失败只打日志——这里成功落库）。
    const scheduler = startDistributionPoolScheduler(
      { db: tb.db, config: tb.config, now: () => now, fetchImpl: fetch },
      timers,
    );
    await waitUntil(async () => (await snapshotCount()) === 2);
    expect(paths.filter(path => path.includes('/resource?'))).toHaveLength(2);
    // 每日排班：延迟 = 下一个本地 04:00 与当前时刻之差；触发后重排下一班。
    expect(scheduledDelay()).toBe(nextDailyRefreshAt(new Date(now)) - now);
    paths.length = 0;
    fire();
    await waitUntil(async () =>
      paths.filter(path => path.includes('/resource?')).length >= 2,
    );
    expect(scheduledDelay()).toBe(nextDailyRefreshAt(new Date(now)) - now);
    // 快照新鲜（刚补刷过）：重启调度器不再触发立即补刷。
    paths.length = 0;
    scheduler.stop();
    now += 3_600_000;
    const again = startDistributionPoolScheduler(
      { db: tb.db, config: tb.config, now: () => now, fetchImpl: fetch },
      manualTimers().timers,
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(paths).toHaveLength(0);
    again.stop();
  });

  it('answers a concurrent manual refresh with a busy 409 instead of re-entering', async () => {
    // 第一笔手动刷新卡在上游（可控闸门）；第二笔立即收到 409 忙信号，
    // 释放后第一笔正常 303 落库——定时/手动共享同一互斥。
    const base = fakePoolUpstream({
      media: [poolItem(1, '媒体一号')],
      weMedia: [poolItem(2, '自媒体一号')],
    });
    let gateFirst = true;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const fetch = (async (input: unknown) => {
      if (gateFirst) {
        gateFirst = false;
        await gate;
      }
      return await base.fetch(input as Parameters<typeof base.fetch>[0]);
    }) as typeof globalThis.fetch;
    tb = await startTestBackend({
      fetch,
      config: { adminLoginThrottleUnitMs: 1 },
      initialNowMs: PICK_FIXED_MS,
    });
    const cookie = await pageLogin(tb.app);
    const slow = postForm(tb.app, '/admin/ui/preference-channels/snapshot/refresh', {}, cookie);
    await new Promise(resolve => setTimeout(resolve, 30));
    const busy = await postForm(tb.app, '/admin/ui/preference-channels/snapshot/refresh', {}, cookie);
    expect(busy.status).toBe(409);
    expect((await busy.text()).includes('池快照刷新正在进行中')).toBe(true);
    release();
    const done = await slow;
    expect(done.status).toBe(303);
    expect(await snapshotCount()).toBe(2);
  });
});
