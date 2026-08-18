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
  {
    name: '0002_billing_permits',
    sql: `
      CREATE TABLE billing_permits (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        operation TEXT NOT NULL,
        units INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        base_price INTEGER NOT NULL DEFAULT 0,
        frozen_remaining INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX idx_billing_permits_account_status ON billing_permits(account_id, status);

      CREATE TABLE permit_unit_reports (
        permit_id TEXT NOT NULL REFERENCES billing_permits(id),
        unit_index INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        reported_at TEXT NOT NULL,
        PRIMARY KEY (permit_id, unit_index)
      );
    `,
  },
  {
    // 账本流水序号：created_at 同毫秒并列时它才是全序的落账顺序依据
    // （毫秒精度的 ISO 时间戳 + 随机 uuid 都给不出插入顺序）。取值由
    // applyBalanceChange 在写流水的同一事务里按账号 MAX(seq)+1 发号，
    // 不用 SQLite 自增/rowid——本列是普通 INTEGER，PG 直读。存量行按
    // (created_at, id) 定序回填：同毫秒旧行的真实插入顺序已不可考，
    // id 只作确定性决胜，回填后新发号不再受影响。
    name: '0003_ledger_entry_seq',
    sql: `
      ALTER TABLE ledger_entries ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
      UPDATE ledger_entries AS entry
      SET seq = numbered.rn
      FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS rn FROM ledger_entries
      ) AS numbered
      WHERE entry.id = numbered.id;
      CREATE UNIQUE INDEX idx_ledger_entries_account_seq ON ledger_entries(account_id, seq);
      DROP INDEX idx_ledger_entries_account;
    `,
  },
  {
    // 票 04：对话隐藏额度。accounts.chat_quota_used_milli 为本充值周期内的
    // 旁路计量累计（千分之一点），由 topup 入账事务清零（任意档位充值刷新）；
    // chat_usage_records 按请求落 token 用量与折点，供运营与 DeepSeek 账单
    // 对账。免费对话无余额变动，故不进 ledger_entries（Σdelta == balance
    // 的账本口径不被污染）。
    name: '0004_chat_usage_metering',
    sql: `
      ALTER TABLE accounts ADD COLUMN chat_quota_used_milli INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE chat_usage_records (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        model TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        points_milli INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_chat_usage_records_account ON chat_usage_records(account_id, created_at);
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
