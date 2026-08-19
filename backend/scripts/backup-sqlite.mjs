#!/usr/bin/env node
/**
 * 鲸杉geo生产 SQLite 备份（票 15）：用 node:sqlite 的 VACUUM INTO 做
 * 在线热备——对源库取一致性快照导出为独立文件，不停机、不直接拷贝
 * WAL 中间态（cp 卷文件可能截到写中间态，见 runbook §5）。
 *
 * 运行环境：node >= 24（node:sqlite）。生产上经 backup-run.sh 借当前
 * 运行容器自己的镜像执行（volume 路径 /app/data/xiaojing-backend.sqlite）；
 * 测试与本地演练直接用宿主 node 跑，路径经环境变量覆盖。
 *
 * 环境变量：
 *   XIAOJING_BACKUP_DB    源库路径（默认 /app/data/xiaojing-backend.sqlite）
 *   XIAOJING_BACKUP_DIR   输出目录（默认 /backup；生产挂 /opt/xiaojing-api/backups）
 *   XIAOJING_BACKUP_KEEP  保留最近 N 份（默认 14），窗口外的旧备份自动清理
 *
 * 输出：xiaojing-<YYYYMMDD-HHMMSS>.sqlite（本地时区，权限 600）。
 * 成功退出码 0；任一步失败非 0 且不留下半成品文件。
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB = "/app/data/xiaojing-backend.sqlite";
const DEFAULT_DIR = "/backup";
const DEFAULT_KEEP = 14;
const FILE_PREFIX = "xiaojing-";
/** 只回收本脚本口径的备份文件；运营手工放的整卷 tar.gz 等不碰。 */
const BACKUP_FILE_RE = /^xiaojing-\d{8}-\d{6}\.sqlite$/;

const log = (message) => console.log(`[backup] ${message}`);
const fail = (message) => {
  console.error(`[backup][error] ${message}`);
  process.exit(1);
};

const envInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1)
    fail(`${name} 必须是正整数（收到 ${raw}）`);
  return value;
};

const stampOf = (date) => {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

/** SQL 单引号字符串字面量转义（VACUUM INTO 的目标必须是字面量，不能绑参）。 */
const sqlLiteral = (value) => `'${value.replace(/'/g, "''")}'`;

const backupOnce = (dbPath, target) => {
  // 普通读写连接：WAL 模式下读者不阻塞写者；源库若带未合并 WAL（应用刚停），
  // 打开过程会先完成恢复，快照因此总是完整。
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    // 目标已存在时 SQLite 直接报错——同秒重复执行不会覆盖既有备份。
    db.exec(`VACUUM INTO ${sqlLiteral(target)}`);
  } finally {
    db.close();
  }
};

const verifySnapshot = (target) => {
  const db = new DatabaseSync(target, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    if (row?.integrity_check !== "ok") {
      fail(
        `备份完整性校验未通过（integrity_check=${JSON.stringify(row)}）：${target}`,
      );
    }
  } finally {
    db.close();
  }
};

/** 保留最近 keep 份（按文件名字典序 = 时间序），返回被清理的文件名。 */
const pruneOldBackups = (dir, keep) => {
  const backups = readdirSync(dir)
    .filter((name) => BACKUP_FILE_RE.test(name))
    .sort()
    .reverse();
  const removed = [];
  for (const name of backups.slice(keep)) {
    unlinkSync(join(dir, name));
    removed.push(name);
  }
  return removed;
};

const main = () => {
  const dbPath = process.env.XIAOJING_BACKUP_DB || DEFAULT_DB;
  const dir = process.env.XIAOJING_BACKUP_DIR || DEFAULT_DIR;
  const keep = envInt("XIAOJING_BACKUP_KEEP", DEFAULT_KEEP);

  if (!existsSync(dbPath)) fail(`源库不存在：${dbPath}`);
  mkdirSync(dir, { recursive: true });

  const target = join(dir, `${FILE_PREFIX}${stampOf(new Date())}.sqlite`);
  log(`快照 ${dbPath} → ${target}（VACUUM INTO 在线热备）`);
  backupOnce(dbPath, target);

  chmodSync(target, 0o600);
  const size = statSync(target).size;
  log(`已导出 ${target}（${size} 字节，权限 600）`);

  verifySnapshot(target);
  log("integrity_check ok（备份库可独立打开且完整）");

  const removed = pruneOldBackups(dir, keep);
  if (removed.length > 0) {
    log(
      `保留窗口清理：保留最近 ${keep} 份，删除 ${removed.length} 份（${removed.join("、")}）`,
    );
  }
  const kept = readdirSync(dir).filter((name) =>
    BACKUP_FILE_RE.test(name),
  ).length;
  log(`完成：目录现有备份 ${kept} 份`);
};

main();
