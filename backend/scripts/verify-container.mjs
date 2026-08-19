#!/usr/bin/env node
/**
 * 本地容器级验证（票 12 可自动化层验收）：全部占位密钥、只打容器回环地址，
 * 不触公网。可重复执行，任一步失败退出码非 0。
 *
 * 流程：docker build → 镜像卫生抽查（docker export 全量文件表无 .env /
 * 无 sqlite 数据 / 无 node_modules）→ 起宿主机 mock DeepSeek 上游 →
 * docker compose up（SSE 上游指向 mock）→ 等 HEALTHCHECK 健康 →
 * /healthz + /admin 登录页 200 + 建号/登录/余额合约冒烟 + /v1/messages
 * SSE 透传形状验证（mock 逐事件对比）→ compose down -v 收尾。
 *
 * 用法：npm run verify:container
 * 可选环境变量：
 *   XIAOJING_NPM_REGISTRY  构建期 npm 镜像源（如 https://registry.npmmirror.com）
 *   XIAOJING_VERIFY_PORT   容器对宿主机暴露的回环端口（默认 18787）
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
    if (existsSync(source)) await symlink(source, join(dockerConfigDir, item), 'dir');
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
  DISTRIBUTION_APP_ID: 'verify-distribution-appid',
  DISTRIBUTION_SECRET: 'verify-distribution-secret',
};

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

async function compose(args, env = {}) {
  return await docker(
    ['compose', '-p', COMPOSE_PROJECT, '-f', join(backendDir, 'docker-compose.yml'), ...args],
    { env: { ...process.env, ...env } },
  );
}

// ── 1. 镜像构建 ─────────────────────────────────────────────────────────
async function buildImage() {
  console.log('[1/6] docker build');
  const buildArgs = [];
  if (process.env.XIAOJING_NPM_REGISTRY) {
    buildArgs.push('--build-arg', `NPM_REGISTRY=${process.env.XIAOJING_NPM_REGISTRY}`);
  }
  const { stdout } = await docker(['build', '-t', IMAGE, ...buildArgs, backendDir], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const lastLine = stdout.trimEnd().split('\n').pop() ?? '';
  console.log(`      ${lastLine}`);
}

// ── 2. 镜像卫生：导出全量文件表，断言密钥/数据未进镜像层 ────────────────
async function verifyImageHygiene(tmpDir) {
  console.log('[2/6] 镜像卫生抽查（无 .env / 无 sqlite 数据 / 无 node_modules）');
  const { stdout: created } = await docker(['create', '--entrypoint', 'sh', IMAGE, '-c', 'true']);
  const containerId = created.trim();
  try {
    const tarPath = join(tmpDir, 'image-root.tar');
    await docker(['export', '--output', tarPath, containerId]);
    const { stdout: listing } = await run('tar', ['-tf', tarPath], { maxBuffer: 64 * 1024 * 1024 });
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
  const server = createServer((req, res) => {
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

// ── 4. compose 起容器并等健康 ──────────────────────────────────────────
async function startStack(envFile, mockPort) {
  console.log('[3/6] docker compose up（SSE 上游 → 宿主机 mock）');
  await compose(['down', '-v', '--remove-orphans']).catch(() => {});
  await writeFile(
    envFile,
    `${Object.entries({ ...VERIFY_ENV, DEEPSEEK_BASE_URL: `http://host.docker.internal:${mockPort}` })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  );
  await compose(['up', '-d'], {
    XIAOJING_IMAGE_TAG: 'verify',
    XIAOJING_ENV_FILE: envFile,
    XIAOJING_BIND: `127.0.0.1:${HOST_PORT}`,
  });
}

async function waitForHealthy(timeoutMs = 60_000) {
  console.log('[4/6] 等待容器 HEALTHCHECK 变为 healthy');
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
  console.log('[5/6] HTTP 合约冒烟');

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
}

// ── 6. 收尾 ────────────────────────────────────────────────────────────
async function main() {
  console.log(`[0/6] 前置检查（docker 守护进程、回环端口 ${HOST_PORT}）`);
  const tmpDir = await mkdtemp(join(tmpdir(), 'xiaojing-verify-'));
  await prepareDockerConfig(tmpDir);
  const envFile = join(tmpDir, 'verify.env');
  let mock;
  await docker(['version', '--format', '{{.Server.Version}}']);
  try {
    await buildImage();
    await verifyImageHygiene(tmpDir);
    mock = await startMockUpstream();
    await startStack(envFile, mock.port);
    await waitForHealthy();
    await smokeHttp(mock.upstreamRequests);
  } finally {
    console.log('[6/6] compose down -v + 清理 mock 与临时目录');
    await compose(['down', '-v', '--remove-orphans']).catch(() => {});
    await mock?.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
  console.log(`\n容器验证结果：${passed.length} 项通过，${failed.length} 项失败`);
  if (failed.length > 0) {
    for (const item of failed) console.log(`  FAIL  ${item}`);
    process.exitCode = 1;
  }
}

await main();
