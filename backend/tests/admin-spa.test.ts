import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import type { BackendEnv } from '../src/http/app';
import {
  getJson,
  postJson,
  provisionAccount,
  startTestBackend,
  str,
  TEST_ADMIN_PASSWORD,
  type TestBackend,
} from './helpers';

/**
 * 票 46 验收 + 票 51 退役回归：/admin 静态托管（admin-web 构建产物 →
 * SPA fallback）。全部走 Hono app.request() 的 HTTP 合约边界：产物存在时
 * GET /admin 与任意 /admin/<深链> 回 index.html、静态资源按扩展名给 MIME；
 * JSON API（/admin/login、/admin/accounts/*）与非 GET 表单路由优先级更高、
 * 绝不被 SPA 吞掉；唯一保留的 SSR GET 页面（/admin/preference-channels）
 * 显式透传；账号运营台 SSR 面（票 51）已退役——/admin/session、/admin/logout
 * 等路由 404；路径穿越不逃出产物根；产物不存在时 GET /admin 404（SSR 登录
 * 页已退役，SPA 未构建即无壳），偏好名单页仍按 SSR 会话门工作。
 */

const FIXTURE_INDEX =
  '<!doctype html><html><head><title>鲸杉geo · 运营台（fixture）</title></head>' +
  '<body><div id="root"></div>' +
  '<script type="module" src="/admin/assets/index-fixture.js"></script></body></html>\n';
const FIXTURE_ASSET_JS = 'console.log("fixture asset");\n';
const FIXTURE_ASSET_CSS = 'body{color:#000}\n';

interface SpaFixture {
  /** 产物根（注入 adminWebRoot 的目录）。 */
  root: string;
  /** 产物根上一级（放置「根外秘密文件」，验证穿越防护）。 */
  outsideSecret: string;
}

async function createSpaFixture(): Promise<SpaFixture> {
  const parent = await mkdtemp(join(tmpdir(), 'xiaojing-admin-spa-'));
  const root = join(parent, 'site');
  await mkdir(join(root, 'assets', 'css'), { recursive: true });
  await writeFile(join(root, 'index.html'), FIXTURE_INDEX);
  await writeFile(join(root, 'assets', 'index-fixture.js'), FIXTURE_ASSET_JS);
  await writeFile(join(root, 'assets', 'css', 'style-fixture.css'), FIXTURE_ASSET_CSS);
  const outsideSecret = join(parent, 'outside-secret.txt');
  await writeFile(outsideSecret, 'SECRET-OUTSIDE-ROOT');
  return { root, outsideSecret };
}

async function getText(app: Hono<BackendEnv>, path: string): Promise<Response> {
  return await app.request(path, { headers: {} });
}

describe('admin SPA 静态托管（票 46）', () => {
  let tb: TestBackend;
  let fixture: SpaFixture;

  beforeEach(async () => {
    fixture = await createSpaFixture();
    tb = await startTestBackend({ config: { adminWebRoot: fixture.root } });
  });

  afterEach(async () => {
    await tb.cleanup();
    await rm(join(fixture.root, '..'), { recursive: true, force: true });
  });

  it('构建产物存在时 GET /admin 与任意 /admin/<深链> 均 fallback 到 index.html', async () => {
    // 注意：GET /admin/accounts 自票 47 起是 JSON 列表接口（spec 45 接口
    // 扩展，注册在 SPA 中间件之前优先匹配），不再走 SPA fallback——其 JSON
    // 契约在下一条用例单独断言。
    for (const path of ['/admin', '/admin/', '/admin/accounts/abc123', '/admin/x/y/z']) {
      const response = await getText(tb.app, path);
      expect(response.status, `GET ${path} 应 200`).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toBe(FIXTURE_INDEX);
    }
  });

  it('深链 GET /admin/accounts/:accountId 直达 SPA 详情页壳（票 51 验收）', async () => {
    // 账号详情深链（票 46 承接 + 票 49 详情页就绪）：SSR 详情页退役后，
    // 该路径由 SPA fallback 回 index.html，react-router 前端接管渲染详情。
    const response = await getText(tb.app, '/admin/accounts/acc-deep-link-42');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(FIXTURE_INDEX);
  });

  it('静态资源按路径命中文件并按扩展名给 MIME', async () => {
    const js = await getText(tb.app, '/admin/assets/index-fixture.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toBe(FIXTURE_ASSET_JS);

    const css = await getText(tb.app, '/admin/assets/css/style-fixture.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toBe(FIXTURE_ASSET_CSS);
  });

  it('JSON API 路径优先于 SPA fallback，绝不被吞（登录/建号/流水照常）', async () => {
    // POST /admin/login → JSON，不是 index.html。
    const login = await postJson(tb.app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(str(login.body.adminToken)).toBeTruthy();

    // 无凭证打受保护 JSON API → 401 JSON，不是 index.html。
    const noToken = await postJson(tb.app, '/admin/accounts', {
      phone: '13800000001',
      initialPassword: 'initial-pass-1',
    });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toBe('invalid_token');

    // 带凭证打 GET JSON API（路径形状与 SPA 深链同形）→ JSON 契约不变。
    const { adminToken, accountId } = await provisionAccount(tb.app);
    const ledger = await getJson(tb.app, `/admin/accounts/${accountId}/ledger`, adminToken);
    expect(ledger.status).toBe(200);
    expect(ledger.body.account).toBeTruthy();
    const usage = await getJson(tb.app, `/admin/accounts/${accountId}/chat-usage`, adminToken);
    expect(usage.status).toBe(200);
    expect(usage.body.account).toBeTruthy();

    // GET /admin/accounts（无尾段）是票 47 的 JSON 列表接口：无凭证 401
    // JSON、带凭证 200 JSON——都不是 index.html。
    const listNoToken = await getJson(tb.app, '/admin/accounts');
    expect(listNoToken.status).toBe(401);
    expect(listNoToken.body.error).toBe('invalid_token');
    const list = await getJson(tb.app, '/admin/accounts', adminToken);
    expect(list.status).toBe(200);
    expect(list.body.accounts).toBeInstanceOf(Array);
    expect(list.body.total).toBeTypeOf('number');
  });

  it('非 GET 方法不被 SPA 吞：保留的偏好名单表单透传，退役路由 404', async () => {
    // 保留的偏好名单表单 POST（未登录）：303 直达 SPA 登录页 /admin/login——
    // 表单路由透传，不是 index.html（若被 SPA 遮蔽则会是 200）。
    const pick = await tb.app.request('/admin/ui/preference-channels/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ category: '0' }).toString(),
    });
    expect(pick.status).toBe(303);
    expect(pick.headers.get('location')).toBe('/admin/login');

    // 账号运营台 SSR 面（票 51）退役：/admin/session、/admin/logout 与
    // /admin/ui/accounts* 表单均已删除——POST 一律 404，不再有 SSR 会话。
    for (const path of ['/admin/session', '/admin/logout', '/admin/ui/accounts']) {
      const retired = await tb.app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({}).toString(),
      });
      expect(retired.status, `POST ${path} 应 404`).toBe(404);
    }
  });

  it('路径穿越不逃出产物根：编码 ../ 不得读到根外文件', async () => {
    const sneaky = await getText(tb.app, '/admin/%2e%2e/outside-secret.txt');
    expect(sneaky.status).toBe(404);
    expect(await sneaky.text()).not.toContain('SECRET-OUTSIDE-ROOT');
  });

  it('SSR 自有页面透传：GET /admin/preference-channels 不被 SPA 遮蔽（票 46 回归）', async () => {
    // spec #45 的 SPA 接管面只枚举 GET /admin 与 GET /admin/accounts/:accountId；
    // 偏好名单管理页（及其全部生产表单）是票 51 后唯一保留的 SSR 面，必须
    // 保持 SSR 可用。

    // 未登录：SSR 会话门 303 直达 SPA 登录页 /admin/login（若被 SPA fallback
    // 遮蔽则会是 200 index.html）。
    const anonymous = await getText(tb.app, '/admin/preference-channels');
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get('location')).toBe('/admin/login');

    // 登录（票 51 桥接：POST /admin/login JSON 成功即下发 SSR 会话 cookie）：
    // /admin/session 已退役，这是会话 cookie 的唯一入口。
    const login = await tb.app.request('/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('xiaojing_admin=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const cookie = setCookie.split(';')[0]!;
    expect(cookie).not.toBe('');
    const page = await tb.app.request('/admin/preference-channels', { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const body = await page.text();
    expect(body).toContain('<title>偏好名单</title>');
    expect(body).toContain('偏好名单');
    expect(body).not.toContain('id="root"');

    // 带查询参数的页面 GET 同样透传（行业切换视图）。
    const industryView = await tb.app.request('/admin/preference-channels?industry=1', {
      headers: { cookie },
    });
    expect(industryView.status).toBe(200);
    expect(industryView.headers.get('content-type')).toContain('text/html');
    expect(await industryView.text()).toContain('<title>偏好名单</title>');
  });

  it('未注入构建产物（adminWebRoot 缺省且目录不存在）时：SSR 登录页已退役、偏好名单页不受影响', async () => {
    const plain = await startTestBackend({});
    try {
      // 票 51：GET /admin 的 SSR 登录页已退役；无 SPA 产物时不再有 HTML
      // 登录表单（action="/admin/session" 不复存在）——404 即整链透传证明。
      const loginPage = await getText(plain.app, '/admin');
      expect(loginPage.status).toBe(404);

      // 保留的偏好名单页照常按 SSR 会话门工作（未登录 303 直达 SPA 登录页）。
      const preferencePage = await getText(plain.app, '/admin/preference-channels');
      expect(preferencePage.status).toBe(303);
      expect(preferencePage.headers.get('location')).toBe('/admin/login');
    } finally {
      await plain.cleanup();
    }
  });
});
