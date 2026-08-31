import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { fileResponse } from '../utils/file-response';

/**
 * Rust 代理 spill 数据面的 serve 端（issue #22）。
 *
 * Rust `ProxySpillManager` 把 >1MB 的 loopback 响应落盘为
 * `<refsDir>/<32hex>` + `<32hex>.meta.json`（TTL 1 小时），并把
 * `ref_url = http://127.0.0.1:<sidecar端口>/refs/<id>` 交回 renderer，
 * 由 WebView 原生跨源 fetch 取回。refs 目录由 Rust spawn 时通过
 * `XIAOJING_PROXY_REFS_DIR` 注入；env 未传（旧 Rust / 纯 Node 开发
 * 模式）时路由降级 404，不影响其余路由。
 */

export const PROXY_REFS_DIR_ENV = 'XIAOJING_PROXY_REFS_DIR';

/** 与 Rust spill 提交口径一致：小写 32-hex，天然无路径穿越。 */
const REF_ID_PATTERN = /^[0-9a-f]{32}$/;

/** 可安全放入 Content-Type 头的 mimetype：可打印 ASCII，无控制字符。 */
const SAFE_MIMETYPE_PATTERN = /^[\x20-\x7e]{1,255}$/;

interface ProxyRefMetaWire {
  mimetype?: unknown;
  expiresAt?: unknown;
}

/**
 * 404 也必须带 CORS 头：跨源 fetch 对无 `Access-Control-Allow-Origin`
 * 的响应抛 TypeError，renderer 会把 TTL 过期误读成网络失败而不是
 * 可观察的 404。
 */
function refNotFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Access-Control-Allow-Origin': '*' },
  });
}

function metaMimetype(meta: ProxyRefMetaWire): string {
  return typeof meta.mimetype === 'string'
    && SAFE_MIMETYPE_PATTERN.test(meta.mimetype)
    ? meta.mimetype
    : 'application/octet-stream';
}

async function removeRefPair(refsDir: string, id: string): Promise<void> {
  await Promise.all([
    rm(join(refsDir, id), { force: true }).catch(() => {}),
    rm(join(refsDir, `${id}.meta.json`), { force: true }).catch(() => {}),
  ]);
}

/** Serve `GET /refs/:id`（TTL 由 serve 端强制，过期即惰性删除 pair）。 */
export async function handleProxyRefRoute(
  pathname: string,
  request: Request,
): Promise<Response | null> {
  if (request.method !== 'GET' || !pathname.startsWith('/refs/')) return null;

  const id = pathname.slice('/refs/'.length);
  if (!REF_ID_PATTERN.test(id)) return refNotFound();

  const refsDir = process.env[PROXY_REFS_DIR_ENV]?.trim();
  if (!refsDir) return refNotFound();

  let meta: ProxyRefMetaWire;
  try {
    meta = JSON.parse(await readFile(join(refsDir, `${id}.meta.json`), 'utf8')) as ProxyRefMetaWire;
  } catch {
    return refNotFound();
  }
  const expiresAt = meta.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return refNotFound();
  }
  if (Date.now() >= expiresAt) {
    await removeRefPair(refsDir, id);
    return refNotFound();
  }

  const response = await fileResponse(join(refsDir, id), {
    contentType: metaMimetype(meta),
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
  return response ?? refNotFound();
}
