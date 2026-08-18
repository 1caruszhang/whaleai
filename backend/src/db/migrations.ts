import type { SqlClient } from './client';

export interface Migration {
  name: string;
  sql: string;
}

/**
 * 迁移注册表：只追加、不改已发布条目。SQL 写成 SQLite 与 PostgreSQL
 * 都能直读的 ANSI 形态（TEXT 主键、ISO 时间戳、INTEGER 布尔），迁 PG 时
 * 由 pg 版 SqlClient 直接重放同一批文件。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    name: '0001_accounts_sessions_ledger',
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        balance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE INDEX idx_auth_sessions_account ON auth_sessions(account_id);

      CREATE TABLE refresh_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES auth_sessions(id),
        token_hash TEXT NOT NULL UNIQUE,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        replaced_by TEXT,
        revoked_at TEXT
      );
      CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);

      CREATE TABLE ledger_entries (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        delta INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        kind TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id, created_at);
    `,
  },
];

/** 建表只经本 runner：幂等、每条迁移独立事务、记录进 schema_migrations。 */
export function migrateDatabase(db: SqlClient): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db.all<{ name: string }>('SELECT name FROM schema_migrations', []).map(row => row.name),
  );
  const newlyApplied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [
        migration.name,
        new Date().toISOString(),
      ]);
    });
    newlyApplied.push(migration.name);
  }
  return newlyApplied;
}
