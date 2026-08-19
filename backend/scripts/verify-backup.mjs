#!/usr/bin/env node
/**
 * 备份链路本地容器演练（票 15 验收）：全部占位密钥、上游指向不可达回环，
 * 不触公网、不触生产。可重复执行，任一步失败退出码非 0。
 *
 * 流程（与生产 backup-install 后的真实路径同构）：
 *   docker build → compose up（占位 env）→ /admin 建号 + 用户登录（真实
 *   写入卷内 SQLite，含 WAL）→ 执行 backend/scripts/backup-run.sh 本体
 *   （借演练容器镜像做 VACUUM INTO 热备）→ 宿主 node:sqlite 校验快照
 *   （integrity ok、逐表行数与卷内库一致、账号可见、权限 600）→
 *   恢复演练：down -v 删卷 → 重建空卷回放备份（runbook §5 同款命令，
 *   清 -wal/-shm 后 cp）→ 同一 env 再起 → 原账号登录数据完整可读 →
 *   保留窗口：预置 20 份旧备份再跑一次 → 只剩 14 份。
 *
 * 用法：npm run verify:backup
 * 可选环境变量：
 *   XIAOJING_NPM_REGISTRY  构建期 npm 镜像源
 *   XIAOJING_VERIFY_PORT   容器对宿主机暴露的回环端口（默认 18788）
 */

import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const run = promisify(execFile);
const backendDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const IMAGE = "xiaojing-backend:verify-backup";
const COMPOSE_PROJECT = "xiaojing-backend-verify-backup";
const CONTAINER = `${COMPOSE_PROJECT}-api-1`;
const HOST_PORT = Number.parseInt(
  process.env.XIAOJING_VERIFY_PORT ?? "18788",
  10,
);
const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
const KEEP_DEFAULT = 14;
const BACKUP_FILE_RE = /^xiaojing-\d{8}-\d{6}\.sqlite$/;

// 占位密钥（与 verify-container.mjs / tests/helpers.ts 同风格；绝不写真实值）。
// 上游基地址指向不可达回环：本演练只做账号/账本读写，不该有任何上游调用。
const VERIFY_ENV = {
  AUTH_SECRET: "verify-backup-auth-secret-0123456789abcdef",
  ADMIN_PASSWORD: "verify-backup-ops-password-123",
  DEEPSEEK_API_KEY: "sk-verify-backup-placeholder-key",
  ARK_API_KEY: "verify-backup-ark-placeholder-key",
  OSS_ACCESS_KEY_ID: "verify-backup-oss-id",
  OSS_ACCESS_KEY_SECRET: "verify-backup-oss-secret",
  OSS_BUCKET: "verify-backup-bucket",
  DISTRIBUTION_APP_ID: "verify-backup-distribution-appid",
  DISTRIBUTION_SECRET: "verify-backup-distribution-secret",
  DEEPSEEK_BASE_URL: "http://127.0.0.1:9",
};

const passed = [];
const failed = [];
function check(name, ok, detail = "") {
  (ok ? passed : failed).push(ok ? name : `${name} — ${detail}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
}

/** 隔离 DOCKER_CONFIG（与 verify-container.mjs 同款：绕开 Docker Desktop 钩子）。 */
let dockerConfigDir = "";

async function prepareDockerConfig(parentDir) {
  dockerConfigDir = join(parentDir, "docker-config");
  mkdirSync(dockerConfigDir);
  const userConfigDir = process.env.DOCKER_CONFIG || join(homedir(), ".docker");
  let currentContext = "";
  try {
    const userConfig = JSON.parse(
      await readFile(join(userConfigDir, "config.json"), "utf8"),
    );
    if (typeof userConfig.currentContext === "string")
      currentContext = userConfig.currentContext;
  } catch {
    // 用户配置不存在或不可解析：空配置即可（默认 context / DOCKER_HOST）。
  }
  await writeFile(
    join(dockerConfigDir, "config.json"),
    currentContext
      ? `{"currentContext":${JSON.stringify(currentContext)}}\n`
      : "{}\n",
  );
  for (const item of ["contexts", "cli-plugins"]) {
    const source = join(userConfigDir, item);
    if (existsSync(source))
      await symlink(source, join(dockerConfigDir, item), "dir");
  }
}

async function docker(args, options = {}) {
  const { env: optionEnv, ...rest } = options;
  return await run("docker", args, {
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
    [
      "compose",
      "-p",
      COMPOSE_PROJECT,
      "-f",
      join(backendDir, "docker-compose.yml"),
      ...args,
    ],
    {
      env: { ...process.env, ...env },
    },
  );
}

async function waitForHealthy(timeoutMs = 60_000) {
  const startedAt = Date.now();
  for (;;) {
    const { stdout } = await docker([
      "inspect",
      "--format",
      "{{index .State.Health.Status}}",
      CONTAINER,
    ]).catch(() => ({
      stdout: "",
    }));
    if (stdout.trim() === "healthy") return;
    if (Date.now() - startedAt > timeoutMs) {
      const { stdout: logs } = await compose([
        "logs",
        "--tail",
        "50",
        "api",
      ]).catch(() => ({ stdout: "" }));
      throw new Error(
        `容器未在 ${timeoutMs}ms 内变为 healthy。最近日志：\n${logs}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function jsonFetch(path, init = {}) {
  return await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** 生产同款备份入口：跑仓库里的 backup-run.sh 本体，目录与容器指向演练环境。 */
async function runBackupWrapper(apiDir) {
  const { stdout } = await run(
    "bash",
    [join(backendDir, "scripts", "backup-run.sh")],
    {
      env: {
        ...process.env,
        XIAOJING_API_DIR: apiDir,
        XIAOJING_API_CONTAINER: CONTAINER,
      },
      timeout: 120_000,
    },
  );
  process.stdout.write(
    stdout
      .split("\n")
      .map((line) => `      ${line}`)
      .join("\n") + "\n",
  );
}

/** 逐表行数（宿主 node:sqlite 只读打开）。 */
function tableCounts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c,
      ]),
    );
  } finally {
    db.close();
  }
}

// 一次性容器读卷内库行数（生产镜像自带 node；execFile 直传 argv，无 shell 转义）。
const COUNTS_PROGRAM = [
  'const {DatabaseSync}=require("node:sqlite");',
  'const db=new DatabaseSync("/app/data/xiaojing-backend.sqlite",{readOnly:true});',
  "const t=db.prepare(\"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'\").all();",
  'console.log(JSON.stringify(Object.fromEntries(t.map(({name})=>[name,db.prepare("SELECT COUNT(*) AS c FROM "+name).get().c]))));',
  "db.close();",
].join(" ");

async function volumeTableCounts() {
  const { stdout } = await docker([
    "run",
    "--rm",
    "--volumes-from",
    CONTAINER,
    "--entrypoint",
    "node",
    IMAGE,
    "-e",
    COUNTS_PROGRAM,
  ]);
  return JSON.parse(stdout.trim());
}

async function main() {
  console.log(`[0/7] 前置检查（docker 守护进程、回环端口 ${HOST_PORT}）`);
  const tmpDir = await mkdtemp(join(tmpdir(), "xiaojing-backup-verify-"));
  await prepareDockerConfig(tmpDir);
  const envFile = join(tmpDir, "verify-backup.env");
  // 服务器布局复刻：<apiDir>/backup-sqlite.mjs + <apiDir>/backups/。
  const apiDir = join(tmpDir, "api");
  const backupsDir = join(apiDir, "backups");
  mkdirSync(backupsDir, { recursive: true });
  copyFileSync(
    join(backendDir, "scripts", "backup-sqlite.mjs"),
    join(apiDir, "backup-sqlite.mjs"),
  );
  const volumeName = `${COMPOSE_PROJECT}_xiaojing-data`;

  const startStack = async () => {
    await writeFile(
      envFile,
      `${Object.entries(VERIFY_ENV)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    await compose(["up", "-d"], {
      XIAOJING_IMAGE_TAG: "verify-backup",
      XIAOJING_ENV_FILE: envFile,
      XIAOJING_BIND: `127.0.0.1:${HOST_PORT}`,
    });
    await waitForHealthy();
  };

  try {
    console.log("[1/7] docker build");
    const buildArgs = [];
    if (process.env.XIAOJING_NPM_REGISTRY)
      buildArgs.push(
        "--build-arg",
        `NPM_REGISTRY=${process.env.XIAOJING_NPM_REGISTRY}`,
      );
    const { stdout: buildOut } = await docker(
      ["build", "-t", IMAGE, ...buildArgs, backendDir],
      {
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    console.log(`      ${buildOut.trimEnd().split("\n").pop() ?? ""}`);

    console.log("[2/7] compose up（占位 env，上游不可达回环）");
    await startStack();

    console.log(
      "[3/7] 造数据：/admin 建号 → 用户登录（真实写入卷内 SQLite + WAL）",
    );
    const phone = `139${String(Date.now()).slice(-8)}`;
    const initialPassword = "verify-backup-initial-1";
    const adminLogin = await jsonFetch("/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: VERIFY_ENV.ADMIN_PASSWORD }),
    });
    const adminToken = (await adminLogin.json()).adminToken;
    const created = await jsonFetch("/admin/accounts", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ phone, initialPassword }),
    });
    const createdBody = await created.json();
    const accountId = createdBody.account?.id;
    check(
      "建号 → 201（赠 500 点）",
      created.status === 201 && createdBody.account?.points === 500,
      JSON.stringify(createdBody),
    );
    const login = await jsonFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone, password: initialPassword }),
    });
    check(
      "用户登录 → accessToken",
      login.status === 200 &&
        typeof (await login.json()).accessToken === "string",
    );

    console.log(
      "[4/7] 生产同款备份：执行 backup-run.sh（借演练容器镜像 VACUUM INTO）",
    );
    await runBackupWrapper(apiDir);
    const backups = readdirSync(backupsDir).filter((name) =>
      BACKUP_FILE_RE.test(name),
    );
    check("产生 1 份新备份文件", backups.length === 1, JSON.stringify(backups));
    const snapshotPath = join(backupsDir, backups[0]);
    check("备份文件权限 600", (statSync(snapshotPath).mode & 0o777) === 0o600);

    console.log("[5/7] 校验备份：integrity、逐表行数与卷内库一致、账号可见");
    const snapshotDb = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      check(
        "integrity_check ok",
        snapshotDb.prepare("PRAGMA integrity_check").get().integrity_check ===
          "ok",
      );
      const accountRow = snapshotDb
        .prepare("SELECT phone FROM accounts WHERE phone = ?")
        .get(phone);
      check("备份内可查到新建账号", accountRow?.phone === phone);
    } finally {
      snapshotDb.close();
    }
    const volumeCounts = await volumeTableCounts();
    const snapshotCounts = tableCounts(snapshotPath);
    check(
      "逐表行数与卷内库一致",
      JSON.stringify(volumeCounts) === JSON.stringify(snapshotCounts),
      `卷内 ${JSON.stringify(volumeCounts)} vs 快照 ${JSON.stringify(snapshotCounts)}`,
    );

    console.log(
      "[6/7] 恢复演练：down -v 删卷 → 回放备份 → 同 env 再起 → 数据完整可读",
    );
    await compose(["down", "-v", "--remove-orphans"]);
    await docker(["volume", "create", volumeName]);
    // runbook §5 恢复命令同款：清 -wal/-shm 后 cp 回放（root 写入，属主改回 node）。
    await docker([
      "run",
      "--rm",
      "--user",
      "0:0",
      "-v",
      `${volumeName}:/data`,
      "-v",
      `${backupsDir}:/backup:ro`,
      "--entrypoint",
      "sh",
      IMAGE,
      "-c",
      // chown -R 覆盖目录本体：新建空卷挂到非镜像路径时目录属主是 root，
      // node 用户在卷里建不了 -wal 文件（readonly database 报错即此因）。
      `rm -f /data/xiaojing-backend.sqlite-wal /data/xiaojing-backend.sqlite-shm; cp /backup/${backups[0]} /data/xiaojing-backend.sqlite; chown -R 1000:1000 /data; chmod 600 /data/xiaojing-backend.sqlite`,
    ]);
    await startStack();
    const relaunch = await jsonFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone, password: initialPassword }),
    });
    const relaunchBody = await relaunch.json();
    check(
      "恢复后原账号可登录（密码哈希完好）",
      relaunch.status === 200 && relaunchBody.account?.phone === phone,
      JSON.stringify(relaunchBody),
    );
    const me = await jsonFetch("/auth/me", {
      headers: { authorization: `Bearer ${relaunchBody.accessToken}` },
    });
    const meBody = await me.json();
    check(
      "恢复后余额完整可读（points=500）",
      me.status === 200 && meBody.account?.points === 500,
      JSON.stringify(meBody),
    );
    const adminRelogin = await jsonFetch("/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: VERIFY_ENV.ADMIN_PASSWORD }),
    });
    const ledger = await jsonFetch(
      `/admin/accounts/${accountId}/ledger?limit=10`,
      {
        headers: {
          authorization: `Bearer ${(await adminRelogin.json()).adminToken}`,
        },
      },
    );
    const ledgerBody = await ledger.json();
    const entries = ledgerBody.entries ?? [];
    check(
      "恢复后建号 grant 流水在账",
      typeof accountId === "string" &&
        ledger.status === 200 &&
        entries.some((e) => e.kind === "grant" && e.delta === 500),
      JSON.stringify(ledgerBody).slice(0, 200),
    );

    console.log(
      "[7/7] 保留窗口（容器内生产路径）：预置 20 份旧备份再跑一次 → 只剩 14 份",
    );
    for (let day = 1; day <= 20; day += 1) {
      writeFileSync(
        join(
          backupsDir,
          `xiaojing-202501${String(day).padStart(2, "0")}-000000.sqlite`,
        ),
        `old-${day}`,
      );
    }
    await runBackupWrapper(apiDir);
    const remaining = readdirSync(backupsDir).filter((name) =>
      BACKUP_FILE_RE.test(name),
    );
    check(
      `保留窗口清理后只剩 ${KEEP_DEFAULT} 份`,
      remaining.length === KEEP_DEFAULT,
      `实际 ${remaining.length} 份：${remaining.slice(0, 3).join("、")}…`,
    );
  } finally {
    console.log("[清理] compose down -v + 删除临时目录");
    await compose(["down", "-v", "--remove-orphans"]).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true });
  }
  console.log(
    `\n备份演练结果：${passed.length} 项通过，${failed.length} 项失败`,
  );
  if (failed.length > 0) {
    for (const item of failed) console.log(`  FAIL  ${item}`);
    process.exitCode = 1;
  }
}

await main();
