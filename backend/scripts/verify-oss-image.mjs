#!/usr/bin/env node
/**
 * 真实 OSS 图片出口冒烟（票 #15 验收，gated 手动执行——不进 npm test/CI）：
 * 用仓库根 .server-deploy.env 的真实密钥，证明两路上传形态都被真实阿里云
 * OSS 接受（mock 测不出的核心风险）：
 *
 *   A. 网关重签路：本地起 backend（临时 SQLite、回环端口、OSS 内网 endpoint
 *      覆写为公网 endpoint——本机不在同地域 VPC，签名对 Host 不敏感）→
 *      真实账号 API 建号登录拿 token → PUT /gw/oss/images/<sha256>.png
 *      （Bearer + image/png + x-oss-object-acl: public-read）→ 匿名 GET
 *      公网 URL 断言 200 + Content-Type + 逐字节一致。
 *   B. 直连路：直接 import 生产实现
 *      src/server/geo/provider-capabilities.ts 的 putImage（OSS V1 签名，
 *      CanonicalizedOSSHeaders 含 x-oss-object-acl）上传另一个 sha256 键 →
 *      同样匿名 GET 验证。
 *   收尾：两键直连签名 DELETE 并复验匿名 GET 非 200。
 *
 * 纪律：绝不回显 .server-deploy.env 的任何值——输出只含状态码、对象键、
 * Content-Type 与字节长度类信息；只写 images/ 层的两个测试对象并清理；
 * 不触生产服务器、不改生产状态（本地 backend 用临时数据库）。
 *
 * 手动执行前提：
 *   1. 仓库根存在 .server-deploy.env（含 OSS_ACCESS_KEY_ID / SECRET /
 *      BUCKET / REGION / PUBLIC_BASE_URL 与 backend 全部必填项）；
 *   2. 本机可公网访问 aliyuncs.com 与 OSS_PUBLIC_BASE_URL；
 *   3. 在 backend/ 目录下执行（tsx 用于加载 TS 直连实现）：
 *        npm run verify:oss-image -- --run
 *      （等价于 npx tsx scripts/verify-oss-image.mjs --run）
 *   4. 时钟偏差需在 OSS 允许窗口内（约 15 分钟），否则签名被拒。
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(backendDir, '..');
const DEPLOY_ENV_PATH = join(repoRoot, '.server-deploy.env');

// ── gate：显式 --run 或环境变量确认，杜绝误触真实网络 ────────────────────
if (!process.argv.includes('--run') && process.env.XIAOJING_OSS_IMAGE_VERIFY !== '1') {
  console.log(
    [
      'verify-oss-image 处于 gated 模式（真实 OSS 写入，不进 npm test/CI）。',
      '确认 .server-deploy.env 就绪后手动执行：npm run verify:oss-image -- --run',
      '详见脚本头部注释（前提与清理语义）。',
    ].join('\n'),
  );
  process.exit(0);
}

// ── .server-deploy.env 解析（值只进内存，绝不打印） ─────────────────────
async function loadDeployEnv() {
  let raw;
  try {
    raw = await readFile(DEPLOY_ENV_PATH, 'utf8');
  } catch {
    console.error(`缺少 ${DEPLOY_ENV_PATH}（真实密钥文件，已被 gitignore）。`);
    process.exit(1);
  }
  const parsed = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

const deployEnv = await loadDeployEnv();
const requiredKeys = [
  'AUTH_SECRET',
  'ADMIN_PASSWORD',
  'DEEPSEEK_API_KEY',
  'ARK_API_KEY',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'OSS_BUCKET',
  'OSS_REGION',
  'OSS_PUBLIC_BASE_URL',
  'DISTRIBUTION_APP_ID',
  'DISTRIBUTION_SECRET',
];
const missingKeys = requiredKeys.filter(key => !deployEnv[key]);
if (missingKeys.length > 0) {
  console.error(`.server-deploy.env 缺少必需键：${missingKeys.join(', ')}（只报键名）。`);
  process.exit(1);
}

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
}

// ── 小工具：PNG 构造（与 verify-container.mjs 同款，8x8 纯色真 PNG） ────
function buildTinyPng(r, g, b) {
  const crcTable = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const width = Buffer.alloc(4);
  width.writeUInt32BE(8);
  const ihdr = chunk('IHDR', Buffer.concat([width, width, Buffer.from([8, 2, 0, 0, 0])]));
  const pixel = Buffer.from([r, g, b]);
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: 8 }, () => pixel))]);
  const idat = chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row))));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    idat,
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 匿名 GET 断言：200 + Content-Type + 逐字节一致（返回 false 及原因）。 */
async function anonymousGetMatches(url, expected) {
  const response = await fetch(url);
  const contentType = response.headers.get('content-type') ?? '';
  const body = Buffer.from(await response.arrayBuffer());
  const bytesEqual = body.equals(expected);
  const typeOk = contentType.split(';')[0].trim() === 'image/png';
  return {
    status: response.status,
    contentType,
    bytesEqual,
    ok: response.status === 200 && typeOk && bytesEqual,
    receivedBytes: body.length,
    expectedBytes: expected.length,
  };
}

// ── 本地起 backend（临时 SQLite + 回环端口 + OSS 公网 endpoint 覆写） ────
function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
    server.on('error', reject);
  });
}

const tmpDir = await mkdtemp(join(tmpdir(), 'xj-oss-verify-'));
const region = deployEnv.OSS_REGION;
const backendEnv = {
  ...process.env,
  ...deployEnv,
  HOST: '127.0.0.1',
  PORT: String(await findFreePort()),
  DATABASE_PATH: join(tmpDir, 'verify.sqlite'),
  // 本机不在同地域 VPC，内网 endpoint 不可达；V1 签名对 Host 不敏感（票 05
  // 前提），覆写为同地域公网 endpoint 不改变被验证的重签语义。
  OSS_INTERNAL_HOST: `${region}.aliyuncs.com`,
};
const BASE_URL = `http://127.0.0.1:${backendEnv.PORT}`;

const backend = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], {
  cwd: backendDir,
  env: backendEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
/** 只保留 [backend] 前缀日志行（起服/迁移信息），其余一律不透出。 */
const safeBackendLogs = [];
const collectSafeLog = chunk => {
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (line.startsWith('[backend]')) safeBackendLogs.push(line);
  }
};
backend.stdout.on('data', collectSafeLog);
backend.stderr.on('data', collectSafeLog);

async function waitForHealthy(timeoutMs = 60_000) {
  const startedAt = Date.now();
  for (;;) {
    if (backend.exitCode !== null) {
      throw new Error(`backend 进程提前退出（code=${backend.exitCode}）。起服日志：\n${safeBackendLogs.join('\n')}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.status === 200) return;
    } catch {
      // 尚未起服，继续等。
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`backend ${timeoutMs}ms 内未健康。起服日志：\n${safeBackendLogs.join('\n')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function jsonFetch(path, init = {}) {
  return await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** 直连签名 DELETE（V1：无 Content-Type / 无 CanonicalizedOSSHeaders）。 */
async function signedDeleteObject(objectKey) {
  const bucket = deployEnv.OSS_BUCKET;
  const date = new Date().toUTCString();
  const stringToSign = ['DELETE', '', '', date, `/${bucket}/${objectKey}`].join('\n');
  const signature = createHmac('sha1', deployEnv.OSS_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest('base64');
  const encodedKey = encodeKey(objectKey);
  const response = await fetch(`https://${bucket}.${region}.aliyuncs.com/${encodedKey}`, {
    method: 'DELETE',
    headers: { Authorization: `OSS ${deployEnv.OSS_ACCESS_KEY_ID}:${signature}`, Date: date },
  });
  return response.status;
}

/** 直连签名 HEAD：清理后以 origin 视角确认对象确实不存在。 */
async function signedHeadStatus(objectKey) {
  const bucket = deployEnv.OSS_BUCKET;
  const date = new Date().toUTCString();
  const stringToSign = ['HEAD', '', '', date, `/${bucket}/${objectKey}`].join('\n');
  const signature = createHmac('sha1', deployEnv.OSS_ACCESS_KEY_SECRET)
    .update(stringToSign)
    .digest('base64');
  const response = await fetch(`https://${bucket}.${region}.aliyuncs.com/${encodeKey(objectKey)}`, {
    method: 'HEAD',
    headers: { Authorization: `OSS ${deployEnv.OSS_ACCESS_KEY_ID}:${signature}`, Date: date },
  });
  return response.status;
}

function encodeKey(objectKey) {
  return objectKey
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

try {
  console.log('[1/5] 本地起 backend（真实 env、临时 SQLite、公网 endpoint 覆写）');
  await waitForHealthy();
  console.log(`      healthy @ ${BASE_URL.replace(/:\d+$/, ':<port>')}`);

  console.log('[2/5] 真实账号 API：运营登录 → 建号 → 用户登录');
  const adminLogin = await jsonFetch('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password: deployEnv.ADMIN_PASSWORD }),
  });
  if (adminLogin.status !== 200) {
    const failure = await adminLogin.json().catch(() => null);
    throw new Error(
      `运营登录失败（HTTP ${adminLogin.status}，error=${failure?.error ?? 'unknown'}）——检查 ADMIN_PASSWORD。`,
    );
  }
  const adminToken = (await adminLogin.json()).adminToken;
  const phone = `139${String(Date.now()).slice(-8)}`;
  const created = await jsonFetch('/admin/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ phone, initialPassword: 'oss-verify-pass-1' }),
  });
  if (created.status !== 201) {
    throw new Error(`建号失败（HTTP ${created.status}）。`);
  }
  const login = await jsonFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone, password: 'oss-verify-pass-1' }),
  });
  if (login.status !== 200) {
    throw new Error(`用户登录失败（HTTP ${login.status}）。`);
  }
  const accessToken = (await login.json()).accessToken;

  // ── A. 网关重签路 ────────────────────────────────────────────────────
  console.log('[3/5] 网关重签路：PUT /gw/oss/images/<sha256>.png → 匿名 GET 复核');
  const gatewayBytes = buildTinyPng(0x1f, 0x6f, 0xb6);
  const gatewaySha = createHash('sha256').update(gatewayBytes).digest('hex');
  const gatewayKey = `images/${gatewaySha}.png`;
  const gatewayPut = await fetch(`${BASE_URL}/gw/oss/${gatewayKey}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'image/png',
      'x-oss-object-acl': 'public-read',
    },
    body: gatewayBytes,
  });
  const gatewayPutBody = await gatewayPut.json().catch(() => null);
  record(
    'A1 网关 PUT',
    gatewayPut.status === 200 && typeof gatewayPutBody?.url === 'string',
    `HTTP ${gatewayPut.status}，键 ${gatewayKey}`,
  );
  if (gatewayPut.status !== 200) {
    throw new Error(`网关 PUT 失败：HTTP ${gatewayPut.status}（详见上方 body 键）。`);
  }
  const gatewayGet = await anonymousGetMatches(gatewayPutBody.url, gatewayBytes);
  record(
    'A2 匿名 GET 公网 URL',
    gatewayGet.ok,
    `HTTP ${gatewayGet.status}，Content-Type=${gatewayGet.contentType}，字节 ${gatewayGet.receivedBytes}/${gatewayGet.expectedBytes} 一致=${gatewayGet.bytesEqual}`,
  );

  // ── B. 直连路（import 生产实现，杜绝复刻漂移） ────────────────────────
  console.log('[4/5] 直连路：putImage（src/server/geo/provider-capabilities.ts）→ 匿名 GET 复核');
  const { createGeoProviderCapabilities } = await import(
    '../../src/server/geo/provider-capabilities.ts'
  );
  const directBytes = buildTinyPng(0xe8, 0x4c, 0x3a);
  const capabilities = createGeoProviderCapabilities({
    ossAccessKeyId: deployEnv.OSS_ACCESS_KEY_ID,
    ossAccessKeySecret: deployEnv.OSS_ACCESS_KEY_SECRET,
    ossBucket: deployEnv.OSS_BUCKET,
    ossRegion: region,
    ossPublicBaseUrl: deployEnv.OSS_PUBLIC_BASE_URL,
  });
  const directReceipt = await capabilities.objectStorage.putImage({
    bytes: directBytes,
    mediaType: 'image/png',
  });
  const directSha = createHash('sha256').update(directBytes).digest('hex');
  const directKeyExpected = `images/${directSha}.png`;
  record(
    'B1 直连 putImage',
    directReceipt.objectKey === directKeyExpected && directReceipt.url.includes(directReceipt.objectKey),
    `objectKey=${directReceipt.objectKey}（url 形状校验通过=${directReceipt.url.includes(directReceipt.objectKey)}）`,
  );
  const directGet = await anonymousGetMatches(directReceipt.url, directBytes);
  record(
    'B2 匿名 GET 公网 URL',
    directGet.ok,
    `HTTP ${directGet.status}，Content-Type=${directGet.contentType}，字节 ${directGet.receivedBytes}/${directGet.expectedBytes} 一致=${directGet.bytesEqual}`,
  );

  // ── 清理：签名 DELETE 两键，origin HEAD 复核 ──────────────────────────
  // 注意：OSS_PUBLIC_BASE_URL 若为 CDN 域名，删除后公网 URL 可能仍被边缘
  // 缓存命中一段时间——删除的权威判定以 origin 签名 HEAD 404 为准（公网
  // 状态只作信息输出，不计入成败）。
  console.log('[5/5] 清理：直连签名 DELETE 两个测试对象（origin HEAD 复核）');
  for (const [label, key] of [['A', gatewayKey], ['B', directReceipt.objectKey]]) {
    const deleteStatus = await signedDeleteObject(key);
    const originStatus = await signedHeadStatus(key);
    let publicStatus = 'n/a';
    try {
      publicStatus = String(
        (await fetch(`${deployEnv.OSS_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`)).status,
      );
    } catch {
      publicStatus = '网络错误';
    }
    record(
      `清理${label} DELETE ${key}`,
      (deleteStatus === 204 || deleteStatus === 200) && originStatus === 404,
      `DELETE HTTP ${deleteStatus}，origin HEAD ${originStatus}，公网 URL HTTP ${publicStatus}（CDN 缓存可滞后）`,
    );
  }
} finally {
  // 先等子进程真正退出再删临时目录（Windows 上 sqlite 句柄未释放会 EBUSY）；
  // 清理失败只告警，绝不让它盖掉主流程的真实错误。
  try {
    backend.kill();
    await new Promise(resolveExit => {
      if (backend.exitCode !== null) return resolveExit();
      const timer = setTimeout(resolveExit, 5_000);
      backend.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    // 显式关掉 stdio 管道句柄：Windows 上残留管道会在进程退出时触发
    // libuv 断言（async.c UV_HANDLE_CLOSING）。
    backend.stdout?.destroy();
    backend.stderr?.destroy();
  } catch {
    // kill/等待失败不阻塞清理。
  }
  try {
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.warn(`临时目录清理失败（${error.code ?? 'unknown'}）：${tmpDir}（含临时 sqlite，可手动删除）`);
  }
}

const failed = results.filter(item => !item.ok);
console.log(`\n真实 OSS 冒烟结果：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  FAIL  ${item.step} — ${item.detail}`);
  process.exitCode = 1;
}
