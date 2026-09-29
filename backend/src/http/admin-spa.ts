import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMiddleware } from 'hono/factory';
import type { BackendDeps } from '../deps';

/**
 * /admin 静态托管（票 46）：admin-web 构建产物打进后端镜像后，GET /admin
 * 与任意 /admin/<深链> 由 SPA 承接——命中文件直接回文件（Vite 内容哈希
 * 资源），未命中回 index.html（react-router 接管前端路由）。
 *
 * 护栏（与本模块的注册顺序共同保证，见 http/app.ts）：
 * - JSON API（/admin/login、/admin/accounts/*）注册在前、优先匹配，绝不被吞；
 * - spec #45 枚举的 SPA 接管面只有 GET /admin 与 GET /admin/accounts/:accountId；
 *   其余 SSR 自有 GET 页面（SSR_PAGE_PASSTHROUGH_PREFIXES）在票 #51「SPA
 *   上线验证后整体退役」前必须保持可用——本中间件对它们原样透传，绝不被
 *   SPA fallback 遮蔽（2026-09-29 验收回归：GET /admin/preference-channels
 *   曾整页被吞，其全部生产表单因此不可用）；
 * - 本中间件只拦 GET，/admin/session、/admin/ui/* 等既有表单 POST 原样透传；
 * - 产物不存在（本地开发/测试未构建）时整链透传，既有 SSR 页面行为不变——
 *   测试与开发零扰动，镜像内（产物在 dist/admin-web）才启用；
 * - 路径穿越防护：解码后的相对路径必须留在产物根内，逃逸一律 404。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** 镜像内默认产物位置：bundle 输出 dist/index.js → 同目录 dist/admin-web。 */
function defaultAdminWebRoot(): string {
  return fileURLToPath(new URL('./admin-web', import.meta.url));
}

/**
 * SSR 自有 GET 页面透传清单（票 46）：spec #45 的 SPA 接管面只枚举 GET
 * /admin 与 GET /admin/accounts/:accountId，其余 SSR 页面在票 #51 整体
 * 退役前必须保持可用。当前清单：
 * - /admin/preference-channels：偏好名单管理页（校验名单、snapshot
 *   refresh/verify、pick/category/delete 等生产表单都 POST 到
 *   /admin/ui/preference-channels/*，T1 起必须可用）。
 * 新增 SSR GET 页面时在此登记；票 #51 退役时随页面一并删除。
 */
const SSR_PAGE_PASSTHROUGH_PREFIXES = ['/admin/preference-channels'];

function isSsrOwnedPage(path: string): boolean {
  return SSR_PAGE_PASSTHROUGH_PREFIXES.some(
    prefix => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** SPA 长缓存只在内容哈希资源上开；index.html 每次协商，新版本立即生效。 */
function cacheControlFor(filePath: string): string {
  return filePath.endsWith(`${sep}index.html`) || filePath.endsWith('/index.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable';
}

function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export function createAdminSpaMiddleware(deps: BackendDeps) {
  const root = deps.config.adminWebRoot ?? defaultAdminWebRoot();
  const indexFile = resolve(root, 'index.html');
  // 产物缺失（本地开发/测试未构建）：整链透传，SSR 页面与既有行为不变。
  const enabled = existsSync(indexFile);

  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    const isAdminPath = path === '/admin' || path === '/admin/' || path.startsWith('/admin/');
    if (!enabled || !isAdminPath) return await next();
    // SSR 自有 GET 页面显式透传（createAdminPageRoutes 注册在本中间件之后）。
    if (isSsrOwnedPage(path)) return await next();
    if (c.req.method !== 'GET') return await next();

    let relative = path.slice('/admin/'.length); // '/admin' 与 '/admin/' → ''
    try {
      relative = decodeURIComponent(relative);
    } catch {
      // 畸形百分号编码：不是合法静态路径，透传给后续路由（404）。
      return await next();
    }

    const filePath = resolve(root, relative === '' ? 'index.html' : relative);
    // 穿越防护：解析结果必须仍在产物根内。
    if (filePath !== root && !filePath.startsWith(root + sep)) return await next();

    try {
      const body = await readFile(filePath);
      return c.body(body, 200, {
        'content-type': contentTypeFor(filePath),
        'cache-control': cacheControlFor(filePath),
      });
    } catch {
      // 未命中文件：SPA fallback 到 index.html（react-router 承接前端路由）。
      if (filePath === indexFile) return await next();
      try {
        const body = await readFile(indexFile);
        return c.body(body, 200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
      } catch {
        return await next();
      }
    }
  });
}
