import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 备份脚本确定性测试（票 15）：在宿主 node（>=24，node:sqlite）上直接跑
 * scripts/backup-sqlite.mjs，断言外部行为——快照文件可独立打开、行数与
 * 源库一致（含 WAL 中尚未 checkpoint 的行，即「不直接拷贝 WAL 中间态」）、
 * 权限 600、保留窗口清理只回收本脚本口径的文件。不触网络、不跑 docker。
 */

const run = promisify(execFile);
const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(backendDir, "scripts", "backup-sqlite.mjs");
const BACKUP_FILE_RE = /^xiaojing-\d{8}-\d{6}\.sqlite$/;

/** 造一个带 WAL 未合并数据的源库，返回保持打开的写入连接（WAL 不 checkpoint）。 */
function createLiveSource(dbPath: string, walOnlyPhone: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE accounts (id TEXT PRIMARY KEY, phone TEXT, balance INTEGER)",
  );
  db.exec("CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, delta INTEGER)");
  db.exec("INSERT INTO accounts VALUES ('a1', '13800001111', 500)");
  db.exec("INSERT INTO ledger_entries VALUES ('l1', 500)");
  // 这两行只落在 -wal 里（连接保持打开、不 checkpoint），快照必须包含它们。
  db.exec(`INSERT INTO accounts VALUES ('a2', '${walOnlyPhone}', 0)`);
  db.exec("INSERT INTO ledger_entries VALUES ('l2', 0)");
  return db;
}

/** 每张业务表的行数（备份与源库逐表对齐的口径）。 */
function tableCounts(db: DatabaseSync): Record<string, number> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number })
        .c,
    ]),
  );
}

async function runBackup(env: Record<string, string>) {
  return await run(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

/** 预置 n 份旧备份文件：xiaojing-202501<01..n>-000000.sqlite（字典序 = 时间序）。 */
function seedOldBackups(outDir: string, count: number, month = "01"): string[] {
  const names: string[] = [];
  for (let day = 1; day <= count; day += 1) {
    const name = `xiaojing-2025${month}${String(day).padStart(2, "0")}-000000.sqlite`;
    writeFileSync(join(outDir, name), `old-${day}`);
    names.push(name);
  }
  return names;
}

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("备份脚本 backup-sqlite.mjs（票 15）", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "xiaojing-backup-test-"));
    tempRoots.push(root);
  });

  it("VACUUM INTO 快照可独立打开、行数与源库一致（含 WAL 未合并行），权限 600", async () => {
    const dbPath = join(root, "live", "xiaojing-backend.sqlite");
    mkdirSync(join(root, "live"), { recursive: true });
    const outDir = join(root, "backups");
    const walOnlyPhone = "13900002222";
    const writer = createLiveSource(dbPath, walOnlyPhone);
    try {
      expect(existsSync(`${dbPath}-wal`)).toBe(true);

      const { stdout } = await runBackup({
        XIAOJING_BACKUP_DB: dbPath,
        XIAOJING_BACKUP_DIR: outDir,
      });
      expect(stdout).toContain("integrity_check ok");

      const created = readdirSync(outDir).filter((name) =>
        BACKUP_FILE_RE.test(name),
      );
      expect(created).toHaveLength(1);
      const target = join(outDir, created[0]!);
      // Windows 平台门控：Node 在 win32 上 fs.chmod 只映射只读位，0o600 不落
      // POSIX 权限位，statSync 恒报 0o666，本断言必假。0o600 的真实语义只在
      // 有权限位语义的平台（Linux CI / 生产 Docker）上验证；Windows 跳过位
      // 断言，快照可用性仍由下方 readOnly 独立打开覆盖。脚本生产行为不改。
      if (process.platform !== "win32") {
        expect(statSync(target).mode & 0o777).toBe(0o600);
      }

      const snapshot = new DatabaseSync(target, { readOnly: true });
      try {
        const integrity = snapshot.prepare("PRAGMA integrity_check").get() as {
          integrity_check: string;
        };
        expect(integrity.integrity_check).toBe("ok");
        // journal_mode 非 wal：备份是独立单文件，回放不依赖 -wal/-shm。
        const journalMode = snapshot.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        };
        expect(journalMode.journal_mode).toBe("delete");
        expect(tableCounts(snapshot)).toEqual(tableCounts(writer));
        const phones = (
          snapshot
            .prepare("SELECT phone FROM accounts ORDER BY phone")
            .all() as Array<{ phone: string }>
        ).map((row) => row.phone);
        expect(phones).toEqual(["13800001111", walOnlyPhone]);
      } finally {
        snapshot.close();
      }
    } finally {
      writer.close();
    }
  });

  it("保留窗口外的旧备份自动清理，只回收本脚本口径的文件", async () => {
    const dbPath = join(root, "keep", "xiaojing-backend.sqlite");
    const outDir = join(root, "keep-backups");
    mkdirSync(join(root, "keep"), { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const writer = createLiveSource(dbPath, "13800003333");
    try {
      seedOldBackups(outDir, 20);
      // 非本脚本口径的文件（整卷打包、手工命名、日志）不得误删。
      const untouchable = [
        "xiaojing-full-20250101-000000.tar.gz",
        "xiaojing-manual.sqlite",
        "backup.log",
      ];
      for (const name of untouchable)
        writeFileSync(join(outDir, name), "keep-me");

      await runBackup({
        XIAOJING_BACKUP_DB: dbPath,
        XIAOJING_BACKUP_DIR: outDir,
        XIAOJING_BACKUP_KEEP: "5",
      });

      const remaining = readdirSync(outDir)
        .filter((name) => BACKUP_FILE_RE.test(name))
        .sort();
      // 新快照 1 份 + 最新的 4 份旧备份（day 17–20）= 5。
      expect(remaining).toHaveLength(5);
      expect(remaining.slice(0, 4)).toEqual([
        "xiaojing-20250117-000000.sqlite",
        "xiaojing-20250118-000000.sqlite",
        "xiaojing-20250119-000000.sqlite",
        "xiaojing-20250120-000000.sqlite",
      ]);
      for (const name of untouchable)
        expect(existsSync(join(outDir, name))).toBe(true);
    } finally {
      writer.close();
    }
  });

  it("默认保留最近 14 份（不传 XIAOJING_BACKUP_KEEP）", async () => {
    const dbPath = join(root, "def", "xiaojing-backend.sqlite");
    const outDir = join(root, "def-backups");
    mkdirSync(join(root, "def"), { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const writer = createLiveSource(dbPath, "13800004444");
    try {
      seedOldBackups(outDir, 20, "02");

      await runBackup({
        XIAOJING_BACKUP_DB: dbPath,
        XIAOJING_BACKUP_DIR: outDir,
      });

      const remaining = readdirSync(outDir).filter((name) =>
        BACKUP_FILE_RE.test(name),
      );
      expect(remaining).toHaveLength(14);
    } finally {
      writer.close();
    }
  });

  it("源库缺失时失败退出且不产生备份文件", async () => {
    const outDir = join(root, "missing-backups");
    mkdirSync(outDir, { recursive: true });
    await expect(
      runBackup({
        XIAOJING_BACKUP_DB: join(root, "missing", "xiaojing-backend.sqlite"),
        XIAOJING_BACKUP_DIR: outDir,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("[backup][error]"),
    });
    expect(
      readdirSync(outDir).filter((name) => BACKUP_FILE_RE.test(name)),
    ).toHaveLength(0);
  });
});
