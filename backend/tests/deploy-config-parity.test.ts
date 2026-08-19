import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBackendConfig, MissingConfigError } from '../src/config';

/**
 * 部署配置对表校验（票 12 验收项）：环境变量的唯一权威是 src/config.ts 的
 * fail-fast 清单；README 环境变量表、.env.example 与部署 runbook
 * （specs/guides/deploy-api-jingshanai.md）的 env 注入清单必须与它逐项对齐，
 * 防止「代码新增必填项、部署文档漏一行」导致容器在生产起不来。
 * 同时钉住密钥红线：Dockerfile / compose / .dockerignore 不得携带或放行
 * 任何密钥值。全部为本地文件读取 + 纯断言，不触网络、不跑 docker。
 */

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(backendDir, '..');
const readBackend = (name: string): string => readFileSync(join(backendDir, name), 'utf8');

const readme = readBackend('README.md');
const envExample = readBackend('.env.example');
const dockerfile = readBackend('Dockerfile');
const compose = readBackend('docker-compose.yml');
const dockerignore = readBackend('.dockerignore');
const runbook = readFileSync(join(repoRoot, 'specs', 'guides', 'deploy-api-jingshanai.md'), 'utf8');
const packageJson = JSON.parse(readBackend('package.json')) as { scripts: Record<string, string> };

/** config fail-fast 的必填清单（运行时真相，不是手抄快照）。 */
const requiredEnv: string[] = (() => {
  try {
    loadBackendConfig({});
  } catch (error) {
    if (error instanceof MissingConfigError) return error.missing;
    throw error;
  }
  throw new Error('loadBackendConfig({}) 应当因缺少必填环境变量而 fail-fast');
})();

/** 运维必须在 runbook 里看到操作说明的关键可选项（容器/反代/内网相关）。 */
const runbookOptionalEnv = ['DATABASE_PATH', 'PORT', 'OSS_INTERNAL_HOST', 'OSS_PUBLIC_BASE_URL'];

describe('部署配置对表（票 12）', () => {
  it('config fail-fast 必填清单快照（新增必填项必须同步三处文档）', () => {
    expect(requiredEnv).toEqual([
      'AUTH_SECRET',
      'ADMIN_PASSWORD',
      'DEEPSEEK_API_KEY',
      'ARK_API_KEY',
      'OSS_ACCESS_KEY_ID',
      'OSS_ACCESS_KEY_SECRET',
      'OSS_BUCKET',
      'DISTRIBUTION_APP_ID',
      'DISTRIBUTION_SECRET',
    ]);
  });

  it('README 环境变量表覆盖全部必填项', () => {
    for (const name of requiredEnv) {
      expect(readme, `README 环境变量表缺少 ${name}`).toMatch(new RegExp(`\\| \`${name}\` \\|`));
    }
  });

  it('.env.example 为全部必填项提供占位行（非注释）', () => {
    for (const name of requiredEnv) {
      expect(envExample, `.env.example 缺少 ${name}= 占位行`).toMatch(new RegExp(`^${name}=`, 'm'));
    }
  });

  it('部署 runbook 的 env 注入清单覆盖全部必填项与关键可选项', () => {
    for (const name of [...requiredEnv, ...runbookOptionalEnv]) {
      expect(runbook, `runbook env 清单缺少 ${name}`).toMatch(new RegExp(`\`${name}\``));
    }
  });

  it('runbook 写明密钥红线与 docker history / docker export 抽查命令', () => {
    expect(runbook).toContain('docker history');
    expect(runbook).toContain('docker export');
    expect(runbook).toContain('不入镜像');
    expect(runbook).toContain('不入仓库');
  });

  it('Dockerfile 与 compose 不携带任何必填密钥赋值（只许运行时 env 注入）', () => {
    for (const name of requiredEnv) {
      const assignment = new RegExp(`${name}\\s*=\\s*\\S`);
      expect(dockerfile, `Dockerfile 出现 ${name}= 赋值`).not.toMatch(assignment);
      expect(compose, `docker-compose.yml 出现 ${name}= 赋值`).not.toMatch(assignment);
    }
  });

  it('compose 经 env_file 注入环境（占位默认值，服务器上覆盖）', () => {
    expect(compose).toContain('env_file');
    expect(compose).toContain('${XIAOJING_ENV_FILE:-.env}');
    expect(compose).toContain('xiaojing-data:/app/data');
    expect(compose).toMatch(/restart:\s*unless-stopped/);
  });

  it('.dockerignore 挡住 .env / data / node_modules / dist（不进镜像层）', () => {
    for (const pattern of ['.env', 'data/', 'node_modules/', 'dist/']) {
      expect(dockerignore.split('\n'), `.dockerignore 缺少 ${pattern}`).toContain(pattern);
    }
  });

  it('package.json 挂接 bundle 与容器验证脚本', () => {
    expect(packageJson.scripts.build).toBe('node scripts/bundle.mjs');
    expect(packageJson.scripts['verify:container']).toBe('node scripts/verify-container.mjs');
  });
});
