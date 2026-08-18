import { DatabaseSync } from 'node:sqlite';

/**
 * 后端唯一的 SQL 执行抽象。
 *
 * 约束（商业化规格「迁移工具抽象，保留迁 PostgreSQL 路径」）：
 * - 业务层只许依赖本接口的 `?` 位置参数、同步语义与事务帮助函数，
 *   不许直接触碰 `node:sqlite` 类型，这样迁 PG 时只需实现一个
 *   基于 pg 的 SqlClient（$1 参数 + 事务 SQL 微调），业务零改动。
 * - 时间戳一律存 ISO-8601 UTC 字符串、布尔一律 INTEGER 0/1、主键一律
 *   应用侧生成的 TEXT uuid——三种都是 PG 可直接承载的形态。
 */
export interface SqlClient {
  exec(sql: string): void;
  run(sql: string, params: readonly unknown[]): { changes: number };
  get<T>(sql: string, params: readonly unknown[]): T | undefined;
  all<T>(sql: string, params: readonly unknown[]): T[];
  transaction<T>(fn: () => T): T;
  /** 唯一约束冲突的驱动侧判别（SQLite 看报错文案，PG 看 23505），业务层不感知方言。 */
  isUniqueViolation(error: unknown): boolean;
  close(): void;
}

export function openSqlDatabase(path: string): SqlClient {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // 可重入事务：领域函数（如改密）会组合调用各自带事务的 helper，
  // 嵌套调用加入最外层事务而不是开新事务（SQLite 不允许 BEGIN 嵌套）。
  let transactionDepth = 0;
  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    run(sql: string, params: readonly unknown[]) {
      const result = db.prepare(sql).run(...(params as never[]));
      return { changes: Number(result.changes) };
    },
    get<T>(sql: string, params: readonly unknown[]) {
      return db.prepare(sql).get(...(params as never[])) as T | undefined;
    },
    all<T>(sql: string, params: readonly unknown[]) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    transaction<T>(fn: () => T): T {
      if (transactionDepth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      transactionDepth = 1;
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        transactionDepth = 0;
      }
    },
    close(): void {
      db.close();
    },
    isUniqueViolation(error: unknown): boolean {
      return error instanceof Error && error.message.includes('UNIQUE constraint failed');
    },
  };
}
