#!/usr/bin/env node
/**
 * 本地容器级验证（票 12 可自动化层验收）：全部占位密钥、只打容器回环地址，
 * 不触公网。可重复执行，任一步失败退出码非 0。
 *
 * 流程：docker build → 镜像卫生抽查（docker export 全量文件表无 .env /
 * 无 sqlite 数据 / 无 node_modules）→ 起宿主机 mock DeepSeek 上游 +
 * mock OSS 上游（HTTPS，自签 fixture 证书）→ docker compose up（SSE 上游
 * 与 OSS 内网 endpoint 都指向 mock）→ 等 HEALTHCHECK 健康 →
 * /healthz + /admin 登录页 200 + 建号/登录/余额合约冒烟 + /v1/messages
 * SSE 透传形状验证（mock 逐事件对比）+ 图片 PUT 网关冒烟（票 #15：
 * 二进制逐字节、Content-Type/公共读 ACL 透传、ACL 计入重签串、负向 4xx
 * 零上游调用）→ compose down -v 收尾。
 *
 * 图片 PUT 冒烟的 TLS 形态：网关对 OSS 上游固定拼 https://{bucket}.{host}/
 * （ossUpstreamUrl）。本地 mock 因此必须说 TLS——用 scripts/fixtures/ 的
 * 自签 CA + 叶证书（SAN=verify-bucket.host.docker.internal）起 HTTPS mock，
 * compose 覆盖文件把 `verify-bucket.host.docker.internal` 追加进容器
 * extra_hosts（host-gateway）、把 CA 经 NODE_EXTRA_CA_CERTS 挂进容器信任
 * 库（保持 TLS 校验开启，而非全局放行）。网关签名对 Host 不敏感（票 05
 * 前提），指向 mock 不影响验证的重签语义。
 *
 * 用法：npm run verify:container
 * 可选环境变量：
 *   XIAOJING_NPM_REGISTRY  构建期 npm 镜像源（如 https://registry.npmmirror.com）
 *   XIAOJING_VERIFY_PORT   容器对宿主机暴露的回环端口（默认 18787）
 */

import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';

const run = promisify(execFile);
const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const IMAGE = 'xiaojing-backend:verify';
const COMPOSE_PROJECT = 'xiaojing-backend-verify';
const HOST_PORT = Number.parseInt(process.env.XIAOJING_VERIFY_PORT ?? '18787', 10);
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;

/**
 * 隔离的 DOCKER_CONFIG：Docker Desktop 的 build/pull 后置钩子（scout/ai）
 * 在受限网络上会无限挂起 docker CLI（构建实际已完成但命令不返回）。
 * 用一个只保留 context 与 cli-plugins 链接的干净配置绕开钩子。
 */
let dockerConfigDir = '';

async function prepareDockerConfig(parentDir) {
  dockerConfigDir = join(parentDir, 'docker-config');
  await mkdir(dockerConfigDir);
  const userConfigDir = process.env.DOCKER_CONFIG || join(homedir(), '.docker');
  let currentContext = '';
  try {
    const userConfig = JSON.parse(await readFile(join(userConfigDir, 'config.json'), 'utf8'));
    if (typeof userConfig.currentContext === 'string') currentContext = userConfig.currentContext;
  } catch {
    // 用户配置不存在或不可解析：用空配置即可（默认 context / DOCKER_HOST）。
  }
  await writeFile(
    join(dockerConfigDir, 'config.json'),
    currentContext ? `{"currentContext":${JSON.stringify(currentContext)}}\n` : '{}\n',
  );
  for (const item of ['contexts', 'cli-plugins']) {
    const source = join(userConfigDir, item);
    if (!existsSync(source)) continue;
    // Windows 上目录符号链接需要 SeCreateSymbolicLinkPrivilege（非提升 shell
    // 会 EPERM）；junction 等效且免特权。
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      await symlink(source, join(dockerConfigDir, item), linkType);
    } catch {
      // 链接仍失败（如目标卷不支持）：复制目录兜底，只读用途等价。
      await cp(source, join(dockerConfigDir, item), { recursive: true, verbatimSymlinks: false });
    }
  }
}

// 占位密钥（与 tests/helpers.ts 同风格；绝不写真实值）。
const VERIFY_ENV = {
  AUTH_SECRET: 'verify-container-auth-secret-0123456789abcdef',
  ADMIN_PASSWORD: 'verify-ops-password-123',
  DEEPSEEK_API_KEY: 'sk-verify-placeholder-upstream-key',
  ARK_API_KEY: 'verify-ark-placeholder-key',
  OSS_ACCESS_KEY_ID: 'verify-oss-id',
  OSS_ACCESS_KEY_SECRET: 'verify-oss-secret',
  OSS_BUCKET: 'verify-bucket',
  OSS_PUBLIC_BASE_URL: 'https://verify-public.test',
  DISTRIBUTION_APP_ID: 'verify-distribution-appid',
  DISTRIBUTION_SECRET: 'verify-distribution-secret',
};

// mock OSS 的 TLS 身份（scripts/fixtures/，提交内的验证专用自签证书）。
const OSS_MOCK_HOST_ALIAS = 'verify-bucket.host.docker.internal';
const fixturesDir = join(backendDir, 'scripts', 'fixtures');

const passed = [];
const failed = [];
function check(name, ok, detail = '') {
  (ok ? passed : failed).push(ok ? name : `${name} — ${detail}`);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
}

async function docker(args, options = {}) {
  const { env: optionEnv, ...rest } = options;
  return await run('docker', args, {
    cwd: backendDir,
    ...rest,
    env: {
      ...process.env,
      ...(dockerConfigDir ? { DOCKER_CONFIG: dockerConfigDir } : {}),
      ...optionEnv,
    },
  });
}

/** compose 覆盖文件（mock OSS 的 extra_hosts / CA 信任注入；startStack 前写入）。 */
let composeOverrideFile = '';

async function compose(args, env = {}) {
  const files = ['-f', join(backendDir, 'docker-compose.yml')];
  if (composeOverrideFile) files.push('-f', composeOverrideFile);
  return await docker(
    ['compose', '-p', COMPOSE_PROJECT, ...files, ...args],
    { env: { ...process.env, ...env } },
  );
}

// ── 1. 镜像构建 ─────────────────────────────────────────────────────────
async function buildImage(tmpDir) {
  console.log('[1/7] docker build');
  const buildArgs = [];
  if (process.env.XIAOJING_NPM_REGISTRY) {
    buildArgs.push('--build-arg', `NPM_REGISTRY=${process.env.XIAOJING_NPM_REGISTRY}`);
  }
  // 构建机无法直连 docker.io 时，Dockerfile 首行 `# syntax=docker/dockerfile:1`
  // 的前端镜像拉不下来（本 Dockerfile 只用经典指令，内置前端构建产物等价）
  // ——验证构建改用去掉 syntax 行的临时 Dockerfile，仓库 Dockerfile 不动。
  const dockerfile = await readFile(join(backendDir, 'Dockerfile'), 'utf8');
  const verifyDockerfile = join(tmpDir, 'Dockerfile.verify');
  await writeFile(verifyDockerfile, dockerfile.replace(/^# syntax=[^\r\n]*\r?\n/, ''));
  const { stdout } = await docker(
    ['build', '-t', IMAGE, ...buildArgs, '-f', verifyDockerfile, backendDir],
    {
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const lastLine = stdout.trimEnd().split('\n').pop() ?? '';
  console.log(`      ${lastLine}`);
}

// ── 2. 镜像卫生：导出全量文件表，断言密钥/数据未进镜像层 ────────────────
async function verifyImageHygiene(tmpDir) {
  console.log('[2/7] 镜像卫生抽查（无 .env / 无 sqlite 数据 / 无 node_modules）');
  const { stdout: created } = await docker(['create', '--entrypoint', 'sh', IMAGE, '-c', 'true']);
  const containerId = created.trim();
  try {
    const tarPath = join(tmpDir, 'image-root.tar');
    await docker(['export', '--output', tarPath, containerId]);
    // --force-local：Windows 路径里的 `C:` 会被 GNU tar 当成远程主机语法。
    const { stdout: listing } = await run('tar', ['--force-local', '-tf', tarPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const entries = listing.split('\n');
    const offenders = entries.filter(entry => {
      const base = entry.replace(/\/$/, '');
      // node_modules 只查 /app 子树：node 基础镜像自带的 corepack
      // （/usr/local/lib/node_modules）与本应用无关。
      const nodeModulesInApp = base.startsWith('app/') && /(^|\/)node_modules(\/|$)/.test(base);
      return /(^|\/)\.env(\..+)?$/.test(base) || /\.sqlite(-wal|-shm)?$/.test(base) || nodeModulesInApp;
    });
    check(
      `镜像文件表中无 .env / *.sqlite* / node_modules（共 ${entries.length} 条）`,
      offenders.length === 0,
      `发现：${offenders.slice(0, 5).join(', ')}`,
    );
  } finally {
    await docker(['rm', '-f', containerId]).catch(() => {});
  }
}

// ── 3. mock DeepSeek 上游（Anthropic 兼容形状；记录收到的上游请求） ──────
const SSE_EVENTS = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_verify_1","type":"message","role":"assistant","model":"deepseek-chat","content":[],"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"容器冒烟回显"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function startMockUpstream() {
  /** @type {Array<{path: string, xApiKey: string | null, authorization: string | null}>} */
  const upstreamRequests = [];
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      upstreamRequests.push({
        path: req.url ?? '',
        xApiKey: req.headers['x-api-key'] ?? null,
        authorization: req.headers.authorization ?? null,
      });
      if (req.url === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const streaming = body.includes('"stream":true') || body.includes('"stream": true');
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of SSE_EVENTS) res.write(event);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_verify_2',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-chat',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      );
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port: address.port,
        upstreamRequests,
        close: () =>
          new Promise(done => {
            server.close(() => done());
          }),
      });
    });
  });
}

// ── 3b. mock OSS 上游（HTTPS + 自签 fixture 证书；按字节记录 PUT） ──────
// 网关固定把 OSS 上游拼成 https://{bucket}.{ossInternalHost}/{key}，所以 mock
// 必须说 TLS：叶证书 SAN 与容器 extra_hosts 别名同为
// verify-bucket.host.docker.internal，根 CA 经 NODE_EXTRA_CA_CERTS 注入容器
// （TLS 校验保持开启）。请求按字节捕获（base64 落内存），不经文本解码。
/**
 * @typedef {{method: string, path: string, headers: Record<string, string>, bodyB64: string}} OssMockCall
 */
function startMockOssUpstream() {
  /** @type {OssMockCall[]} */
  const calls = [];
  const serverPromise = (async () => {
    const [key, cert] = await Promise.all([
      readFile(join(fixturesDir, 'oss-mock-server.key')),
      readFile(join(fixturesDir, 'oss-mock-server.crt')),
    ]);
    const server = createHttpsServer({ key, cert }, (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        calls.push({
          method: req.method ?? '',
          path: req.url ?? '',
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([name, value]) => [
              name.toLowerCase(),
              Array.isArray(value) ? value.join(', ') : String(value ?? ''),
            ]),
          ),
          bodyB64: Buffer.concat(chunks).toString('base64'),
        });
        // OSS PUT 成功形状：200 空体。
        res.writeHead(200, { 'content-length': '0' });
        res.end();
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    return { server, port: address.port };
  })();
  return {
    calls,
    done: serverPromise,
    close: async () => {
      const { server } = await serverPromise;
      await new Promise(done => server.close(() => done()));
    },
  };
}

/** 构造 8x8 纯色 PNG（真实 PNG 二进制：签名 + IHDR + IDAT + IEND，CRC 现算）。 */
function buildTinyPng(/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) {
  const crcTable = new Uint32Array(256).map((_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  const crc32 = (bytes) => {
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
  const ihdr = chunk(
    'IHDR',
    Buffer.concat([width, width, Buffer.from([8, 2, 0, 0, 0])]), // 8bit truecolor
  );
  const pixel = Buffer.from([r, g, b]);
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: 8 }, () => pixel))]);
  const scanline = Buffer.concat(Array.from({ length: 8 }, () => row));
  const idat = chunk('IDAT', deflateSync(scanline));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, idat, iend]);
}

// ── 4. compose 起容器并等健康 ──────────────────────────────────────────
async function startStack(envFile, tmpDir, mockPort, ossMock) {
  console.log('[3/7] docker compose up（SSE 上游与 OSS 内网 endpoint → 宿主机 mock）');
  await compose(['down', '-v', '--remove-orphans']).catch(() => {});
  const { port: ossMockPort } = await ossMock.done;
  await writeFile(
    envFile,
    `${Object.entries({
      ...VERIFY_ENV,
      DEEPSEEK_BASE_URL: `http://host.docker.internal:${mockPort}`,
      // 网关把 OSS 上游拼成 https://{bucket}.{ossInternalHost}/，指向 mock 的
      // TLS 端口；容器内 DNS 由覆盖文件的 extra_hosts 别名解析。
      OSS_INTERNAL_HOST: `host.docker.internal:${ossMockPort}`,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
  // 覆盖文件：追加 mock OSS 主机别名 + 注入 CA 信任（保持 TLS 校验开启）。
  const caPem = await readFile(join(fixturesDir, 'oss-mock-ca.crt'));
  const caPath = join(tmpDir, 'oss-mock-ca.crt');
  await writeFile(caPath, caPem);
  composeOverrideFile = join(tmpDir, 'oss-mock-compose.override.yml');
  await writeFile(
    composeOverrideFile,
    [
      'services:',
      '  api:',
      '    extra_hosts:',
      '      - "host.docker.internal:host-gateway"',
      `      - "${OSS_MOCK_HOST_ALIAS}:host-gateway"`,
      '    environment:',
      '      NODE_EXTRA_CA_CERTS: /certs/oss-mock-ca.crt',
      '    volumes:',
      `      - ${caPath.replaceAll('\\', '/')}:/certs/oss-mock-ca.crt:ro`,
      '',
    ].join('\n'),
  );
  await compose(['up', '-d'], {
    XIAOJING_IMAGE_TAG: 'verify',
    XIAOJING_ENV_FILE: envFile,
    XIAOJING_BIND: `127.0.0.1:${HOST_PORT}`,
  });
}

async function waitForHealthy(timeoutMs = 60_000) {
  console.log('[4/7] 等待容器 HEALTHCHECK 变为 healthy');
  const startedAt = Date.now();
  for (;;) {
    const { stdout } = await docker([
      'inspect',
      '--format',
      '{{index .State.Health.Status}}',
      `${COMPOSE_PROJECT}-api-1`,
    ]).catch(() => ({ stdout: '' }));
    if (stdout.trim() === 'healthy') return;
    if (Date.now() - startedAt > timeoutMs) {
      const { stdout: logs } = await compose(['logs', '--tail', '50', 'api']).catch(() => ({
        stdout: '',
      }));
      throw new Error(`容器未在 ${timeoutMs}ms 内变为 healthy。最近日志：\n${logs}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// ── 5. HTTP 合约冒烟 ───────────────────────────────────────────────────
async function jsonFetch(path, init = {}) {
  return await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

async function smokeHttp(upstreamRequests) {
  console.log('[5/7] HTTP 合约冒烟');

  const healthz = await fetch(`${BASE_URL}/healthz`);
  check(
    '/healthz → 200 {"ok":true}',
    healthz.status === 200 && (await healthz.json()).ok === true,
  );

  const adminPage = await fetch(`${BASE_URL}/admin`);
  const adminHtml = await adminPage.text();
  check(
    '/admin 登录页 → 200 且渲染运营登录表单',
    adminPage.status === 200 &&
      (adminPage.headers.get('content-type') ?? '').includes('text/html') &&
      adminHtml.includes('运营登录') &&
      adminHtml.includes('action="/admin/session"'),
  );

  const anonymous = await jsonFetch('/auth/me');
  check('无 token 访问 /auth/me → 401', anonymous.status === 401);

  const adminLogin = await jsonFetch('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password: VERIFY_ENV.ADMIN_PASSWORD }),
  });
  const adminToken = (await adminLogin.json()).adminToken;
  check('运营登录 → adminToken', adminLogin.status === 200 && typeof adminToken === 'string');

  const phone = `138${String(Date.now()).slice(-8)}`;
  const created = await jsonFetch('/admin/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ phone, initialPassword: 'verify-initial-pass-1' }),
  });
  const createdBody = await created.json();
  check(
    '建号 → 201（开通即赠 500 点）',
    created.status === 201 && createdBody.account?.points === 500,
    JSON.stringify(createdBody),
  );

  const login = await jsonFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ phone, password: 'verify-initial-pass-1' }),
  });
  const loginBody = await login.json();
  const accessToken = loginBody.accessToken;
  check(
    '用户登录 → accessToken（首登待改密）',
    login.status === 200 &&
      typeof accessToken === 'string' &&
      loginBody.account?.mustChangePassword === true,
  );

  const me = await jsonFetch('/auth/me', { headers: { authorization: `Bearer ${accessToken}` } });
  check(
    '/auth/me → 200 points=500',
    me.status === 200 && (await me.json()).account?.points === 500,
  );

  const balance = await jsonFetch('/billing/balance', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const balanceBody = await balance.json();
  check(
    '/billing/balance → 三口径 total=500 available=500 frozen=0',
    balance.status === 200 &&
      balanceBody.balance?.total === 500 &&
      balanceBody.balance?.available === 500 &&
      balanceBody.balance?.frozen === 0,
    JSON.stringify(balanceBody),
  );

  // SSE 透传：mock 逐事件发送，容器侧必须逐字节等价、按序收到（禁缓冲/不吞事件）。
  const sse = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: '容器冒烟' }],
    }),
  });
  const sseText = await sse.text();
  const positions = SSE_EVENTS.map(event => sseText.indexOf(event.trim()));
  const sseIntact =
    positions.every(position => position >= 0) &&
    positions.every((position, index) => index === 0 || positions[index - 1] < position);
  check(
    '/v1/messages SSE 透传 → text/event-stream 且 5 个事件逐字节按序到达',
    (sse.headers.get('content-type') ?? '').includes('text/event-stream') && sseIntact,
    `content-type=${sse.headers.get('content-type')}；收到 ${sseText.length} 字节，事件位置 ${JSON.stringify(positions)}`,
  );

  const countTokens = await jsonFetch('/v1/messages/count_tokens', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: '冒烟' }] }),
  });
  check(
    '/v1/messages/count_tokens 透传 → 200 input_tokens=10',
    countTokens.status === 200 && (await countTokens.json()).input_tokens === 10,
  );

  const messagesUpstream = upstreamRequests.find(request => request.path === '/v1/messages');
  check(
    '上游请求由网关重写鉴权（x-api-key=占位密钥，且不携带账号 Bearer token）',
    messagesUpstream !== undefined &&
      messagesUpstream.xApiKey === VERIFY_ENV.DEEPSEEK_API_KEY &&
      messagesUpstream.authorization === null,
    JSON.stringify(messagesUpstream ?? null),
  );

  return { accessToken };
}

// ── 5b. 图片 PUT 网关冒烟（票 #15：二进制安全 + ACL 进重签串） ──────────
async function smokeOssImagePut(accessToken, ossMock) {
  console.log('[6/7] 图片 PUT 网关冒烟（/gw/oss/images/<sha256>.png）');
  await ossMock.done;

  // 真实 PNG 二进制（含非文本字节）：经容器 HTTP 栈 → 网关 arrayBuffer →
  // mock OSS，必须逐字节一致（text() 往返会洗掉替换字符）。
  const imageBytes = buildTinyPng(0x2f, 0x81, 0xc4);
  const sha256 = createHash('sha256').update(imageBytes).digest('hex');
  const encodedKey = `images/${sha256}.png`;
  const put = await fetch(`${BASE_URL}/gw/oss/${encodedKey}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'image/png',
      'x-oss-object-acl': 'public-read',
    },
    body: imageBytes,
  });
  const putBody = await put.json().catch(() => null);
  check(
    `PUT /gw/oss/${encodedKey} → 200 且返回公网 URL`,
    put.status === 200 && putBody?.url === `https://verify-public.test/${encodedKey}`,
    `status=${put.status} body=${JSON.stringify(putBody)}`,
  );

  const callsAfterPut = ossMock.calls.length;
  check('mock OSS 恰好收到 1 次 PUT', callsAfterPut === 1, `收到 ${callsAfterPut} 次`);
  const call = ossMock.calls[0];
  if (call) {
    check(
      '上游 PUT 路径与逐字节二进制一致',
      call.method === 'PUT' && call.path === `/${encodedKey}` && Buffer.from(call.bodyB64, 'base64').equals(imageBytes),
      `method=${call.method} path=${call.path} bytes=${Buffer.from(call.bodyB64, 'base64').length}/${imageBytes.length}`,
    );
    check(
      '上游收到白名单 Content-Type 与公共读 ACL 头（不含账号 token）',
      call.headers['content-type'] === 'image/png' &&
        call.headers['x-oss-object-acl'] === 'public-read' &&
        !(call.headers.authorization ?? '').includes(accessToken),
      `content-type=${call.headers['content-type']} acl=${call.headers['x-oss-object-acl']}`,
    );
    // 重签契约（票 #15 核心）：Authorization 用服务器占位 AK/SK 对
    // `PUT\n\n{contentType}\n{date}\nx-oss-object-acl:public-read\n/{bucket}/{key}`
    // 做 HMAC-SHA1——ACL 必须在 CanonicalizedOSSHeaders 里，否则对不上。
    const date = call.headers.date ?? '';
    const stringToSign = [
      'PUT',
      '',
      'image/png',
      date,
      'x-oss-object-acl:public-read',
      `/${VERIFY_ENV.OSS_BUCKET}/${encodedKey}`,
    ].join('\n');
    const expectedAuthorization = `OSS ${VERIFY_ENV.OSS_ACCESS_KEY_ID}:${createHmac('sha1', VERIFY_ENV.OSS_ACCESS_KEY_SECRET)
      .update(stringToSign)
      .digest('base64')}`;
    check(
      '上游 Authorization 为 ACL 计入重签串的 OSS V1 签名（Date 存在且签名可复算）',
      Boolean(date) && call.headers.authorization === expectedAuthorization,
      `date=${JSON.stringify(date)} authorization=${JSON.stringify(call.headers.authorization)}`,
    );
  }

  // 负向：白名单外 Content-Type / 缺公共读 ACL —— 确定性 4xx 且零上游调用。
  const badType = await fetch(`${BASE_URL}/gw/oss/${encodedKey}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'image/tiff',
      'x-oss-object-acl': 'public-read',
    },
    body: imageBytes,
  });
  const badTypeBody = await badType.json().catch(() => null);
  check(
    '白名单外 Content-Type → 400 oss_image_content_type_invalid',
    badType.status === 400 && badTypeBody?.error === 'oss_image_content_type_invalid',
    `status=${badType.status} body=${JSON.stringify(badTypeBody)}`,
  );
  const missingAcl = await fetch(`${BASE_URL}/gw/oss/${encodedKey}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'image/png',
    },
    body: imageBytes,
  });
  const missingAclBody = await missingAcl.json().catch(() => null);
  check(
    '缺公共读 ACL → 400 oss_image_acl_required',
    missingAcl.status === 400 && missingAclBody?.error === 'oss_image_acl_required',
    `status=${missingAcl.status} body=${JSON.stringify(missingAclBody)}`,
  );
  check(
    '两个负向用例均零上游调用',
    ossMock.calls.length === callsAfterPut,
    `上游调用数 ${ossMock.calls.length}（期望保持 ${callsAfterPut}）`,
  );
}

// ── 6. 收尾 ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[0/7] 前置检查（docker 守护进程、回环端口 ${HOST_PORT}）`);
  const tmpDir = await mkdtemp(join(tmpdir(), 'xiaojing-verify-'));
  await prepareDockerConfig(tmpDir);
  const envFile = join(tmpDir, 'verify.env');
  let mock;
  const ossMock = startMockOssUpstream();
  await docker(['version', '--format', '{{.Server.Version}}']);
  try {
    await buildImage(tmpDir);
    await verifyImageHygiene(tmpDir);
    mock = await startMockUpstream();
    await startStack(envFile, tmpDir, mock.port, ossMock);
    await waitForHealthy();
    const { accessToken } = await smokeHttp(mock.upstreamRequests);
    await smokeOssImagePut(accessToken, ossMock);
  } finally {
    console.log('[7/7] compose down -v + 清理 mock 与临时目录');
    await compose(['down', '-v', '--remove-orphans']).catch(() => {});
    await mock?.close();
    await ossMock.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n容器验证结果：${passed.length} 项通过，${failed.length} 项失败`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  FAIL  ${item}`);
    process.exitCode = 1;
  }
}

await main();
