import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { loadBackendConfig, type BackendConfig } from '../src/config';
import { openSqlDatabase, type SqlClient } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrations';
import { createBackendApp, type BackendEnv } from '../src/http/app';

export const TEST_ADMIN_PASSWORD = 'ops-password-123';
const TEST_AUTH_SECRET = 'unit-test-auth-secret-0123456789abcdef0123456789';

export interface TestBackend {
  app: Hono<BackendEnv>;
  db: SqlClient;
  config: BackendConfig;
  /** 固定后推进假时钟；未固定则走真实 Date.now()。 */
  setNow(ms: number): void;
  cleanup(): Promise<void>;
}

export async function startTestBackend(
  overrides?: { config?: Partial<BackendConfig>; initialNowMs?: number },
): Promise<TestBackend> {
  const dir = await mkdtemp(join(tmpdir(), 'xiaojing-backend-test-'));
  const db = openSqlDatabase(join(dir, 'ledger.sqlite'));
  migrateDatabase(db);
  const config: BackendConfig = {
    ...loadBackendConfig({ AUTH_SECRET: TEST_AUTH_SECRET, ADMIN_PASSWORD: TEST_ADMIN_PASSWORD }),
    ...overrides?.config,
  };
  let fakeNow: number | undefined = overrides?.initialNowMs;
  const app = createBackendApp({ db, config, now: () => fakeNow ?? Date.now() });
  return {
    app,
    db,
    config,
    setNow: (ms: number) => {
      fakeNow = ms;
    },
    cleanup: async () => {
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

type Json = Record<string, unknown>;

export interface ApiResponse {
  status: number;
  body: Json;
}

function headers(token?: string): Record<string, string> {
  const base: Record<string, string> = { 'content-type': 'application/json' };
  if (token) base.authorization = `Bearer ${token}`;
  return base;
}

export async function postJson(
  app: Hono<BackendEnv>,
  path: string,
  body: unknown,
  token?: string,
): Promise<ApiResponse> {
  const response = await app.request(path, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

export async function getJson(
  app: Hono<BackendEnv>,
  path: string,
  token?: string,
): Promise<ApiResponse> {
  const response = await app.request(path, { headers: headers(token) });
  return { status: response.status, body: (await response.json()) as Json };
}

export function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected string, got: ${JSON.stringify(value)}`);
  return value;
}

/** 运营登录 + 建号一步到位的常用前置。 */
export async function provisionAccount(
  app: Hono<BackendEnv>,
  phone = '13800000001',
  initialPassword = 'initial-pass-1',
): Promise<{ adminToken: string; accountId: string }> {
  const adminLogin = await postJson(app, '/admin/login', { password: TEST_ADMIN_PASSWORD });
  if (adminLogin.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(adminLogin)}`);
  const created = await postJson(
    app,
    '/admin/accounts',
    { phone, initialPassword },
    str(adminLogin.body.adminToken),
  );
  if (created.status !== 201) throw new Error(`create account failed: ${JSON.stringify(created)}`);
  const account = created.body.account as { id: string };
  return { adminToken: str(adminLogin.body.adminToken), accountId: account.id };
}

export async function loginAccount(
  app: Hono<BackendEnv>,
  phone: string,
  password: string,
): Promise<ApiResponse> {
  return await postJson(app, '/auth/login', { phone, password });
}
