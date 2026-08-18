import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { loadBackendConfig } from './config';
import { openSqlDatabase } from './db/client';
import { migrateDatabase } from './db/migrations';
import { createBackendApp } from './http/app';

/**
 * 组合根：环境变量 → failfast 配置 → 打开/迁移 SQLite → 起服。
 * 密钥只从 process.env 进入，不落日志。
 */
function main(): void {
  const config = loadBackendConfig(process.env);

  const dbPath = resolve(process.env.DATABASE_PATH ?? 'data/xiaojing-backend.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openSqlDatabase(dbPath);
  const applied = migrateDatabase(db);
  if (applied.length > 0) console.log(`[backend] applied migrations: ${applied.join(', ')}`);

  const app = createBackendApp({ db, config, now: () => Date.now() });
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const hostname = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`[backend] PORT 必须是正整数，收到：${process.env.PORT}`);
    process.exit(1);
  }

  const server = serve({ fetch: app.fetch, port, hostname }, info => {
    console.log(`[backend] listening on http://${info.address}:${info.port}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
