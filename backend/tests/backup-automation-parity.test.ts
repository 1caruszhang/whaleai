import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 备份自动化对表校验（票 15 验收项）：deploy-ecs.sh 的 backup 子命令组、
 * 服务器执行器 backup-run.sh、备份脚本 backup-sqlite.mjs 与部署 runbook §5
 * 必须互相咬合——cron 文件路径、默认计划、保留窗口、恢复命令等关键口径
 * 一处漂移，`npm test` 就红。全部为本地文件读取 + 纯断言，不触网络、
 * 不跑 docker（行为本体由 tests/backup-sqlite.test.ts 与
 * `npm run verify:backup` 容器演练覆盖）。
 */

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendDir, "..");
const readBackend = (name: string): string =>
  readFileSync(join(backendDir, name), "utf8");

const deployScript = readBackend("scripts/deploy-ecs.sh");
const backupRun = readBackend("scripts/backup-run.sh");
const backupSqlite = readBackend("scripts/backup-sqlite.mjs");
const runbook = readFileSync(
  join(repoRoot, "specs", "guides", "deploy-api-jingshanai.md"),
  "utf8",
);
const packageJson = JSON.parse(readBackend("package.json")) as {
  scripts: Record<string, string>;
};

const CRON_FILE = "/etc/cron.d/xiaojing-backup";
const DEFAULT_CRON = "30 4 * * *";
const DEFAULT_KEEP = "14";

describe("备份自动化对表（票 15）", () => {
  it("deploy-ecs.sh 挂接四个 backup 子命令（用法与分发都不缺）", () => {
    for (const cmd of [
      "backup-install",
      "backup-run",
      "backup-list",
      "backup-uninstall",
    ]) {
      expect(deployScript, `用法说明缺少 ${cmd}`).toMatch(
        new RegExp(`deploy-ecs\\.sh ${cmd} <ssh目标>`),
      );
      expect(deployScript, `main 分发缺少 ${cmd}`).toMatch(
        new RegExp(
          `^\\s*${cmd}\\) cmd_${cmd.replace(/-/g, "_")} "\\$@" ;;$`,
          "m",
        ),
      );
    }
  });

  it("backup-install 上传两个脚本文件并幂等安装 cron（默认每日 04:30）", () => {
    expect(deployScript).toContain("scripts/backup-sqlite.mjs");
    expect(deployScript).toContain("scripts/backup-run.sh");
    expect(deployScript).toContain(`BACKUP_CRON_FILE=${CRON_FILE}`);
    expect(deployScript).toContain(`XIAOJING_BACKUP_CRON:-"${DEFAULT_CRON}"`);
    // 5 字段形状 + 字符集校验（挡注入；不得用 `wc -w` 计数——BSD wc 输出带
    // 前导空格，macOS 开发机上恒不等于 5）。
    expect(deployScript).toMatch(
      /grep -Eq '\^\[0-9A-Za-z\/\*,-\]\+\( \[0-9A-Za-z\/\*,-\]\+\)\{4\}\$'/,
    );
    // cron 表达式含 `*`，ssh argv 直传会被远端 shell glob 展开（实测 `$2` 只剩
    // 首字段）——必须 base64 后经环境变量进远端脚本解码。
    expect(deployScript).toContain("XIAOJING_CRON_B64=");
    // 幂等口径：同名 cron 文件整覆写 + 属主/权限固定。
    expect(deployScript).toMatch(
      /printf '%s root %s\/backup-run\.sh >> %s\/backups\/backup\.log 2>&1\\n'/,
    );
    expect(deployScript).toContain('chown root:root "$cron_file"');
    expect(deployScript).toContain("systemctl enable --now crond");
    // backups 目录属主对齐容器内 node 用户（uid 1000）：root 属主的 700 目录
    // 在 Linux 上会让按镜像默认 USER node 运行的备份容器写不进。
    expect(deployScript).toContain("chown 1000:1000 $SERVER_DIR/backups");
  });

  it("backup-uninstall 幂等卸载 cron，保留脚本与历史备份", () => {
    expect(deployScript).toMatch(/rm -f "\$cron_file"/);
    expect(deployScript).toContain("CRON_ABSENT（本就未安装，幂等通过）");
  });

  it("backup-run.sh 是生产备份唯一入口：借运行容器镜像、不挂密钥、带重叠锁", () => {
    expect(backupRun).toContain('--volumes-from "$API_CONTAINER"');
    expect(backupRun).toContain('-v "$SCRIPT":/backup-sqlite.mjs:ro');
    expect(backupRun).toContain("--entrypoint node");
    expect(backupRun).toContain("XIAOJING_API_DIR:-/opt/xiaojing-api");
    expect(backupRun).toContain(
      "XIAOJING_API_CONTAINER:-xiaojing-backend-api-1",
    );
    // 红线：备份容器只挂数据卷、输出目录与脚本本体，绝不出现 .env 挂载。
    expect(backupRun).not.toMatch(/-v\s+\S*\.env/);
    // mkdir 目录锁（跨 Linux/macOS，flock 在 macOS 不存在）+ 超时接管。
    expect(backupRun).toContain('LOCK_DIR="$BACKUPS/.backup.lock.d"');
    expect(backupRun).toMatch(/find "\$LOCK_DIR" -mmin -60/);
  });

  it("backup-sqlite.mjs 关键口径：VACUUM INTO、600 权限、默认保留 14 份、自校验", () => {
    expect(backupSqlite).toContain("VACUUM INTO");
    expect(backupSqlite).toContain("0o600");
    expect(backupSqlite).toContain(`DEFAULT_KEEP = ${DEFAULT_KEEP}`);
    expect(backupSqlite).toContain("integrity_check");
    // 保留窗口只回收本脚本口径的文件名。
    expect(backupSqlite).toContain("/^xiaojing-\\d{8}-\\d{6}\\.sqlite$/");
  });

  it("runbook §5 写明四个子命令、默认计划与保留窗口、恢复要点", () => {
    for (const cmd of [
      "backup-install",
      "backup-run",
      "backup-list",
      "backup-uninstall",
    ]) {
      expect(runbook, `runbook §5 缺少 ${cmd}`).toContain(cmd);
    }
    expect(runbook).toContain(CRON_FILE);
    expect(runbook).toContain(DEFAULT_CRON);
    expect(runbook).toContain("保留最近 14 份");
    expect(runbook).toContain("XIAOJING_BACKUP_KEEP");
    expect(runbook).toContain("XIAOJING_BACKUP_CRON");
    // 恢复命令的两个坑必须留在文档里（本地演练实测踩过）。
    expect(runbook).toContain(
      "rm -f /data/xiaojing-backend.sqlite-wal /data/xiaojing-backend.sqlite-shm",
    );
    expect(runbook).toContain("chown -R 1000:1000 /data");
    expect(runbook).toContain("verify:backup");
  });

  it("package.json 挂接容器演练脚本", () => {
    expect(packageJson.scripts["verify:backup"]).toBe(
      "node scripts/verify-backup.mjs",
    );
  });

  it("shell 脚本里 $var 不与全角字符相邻（macOS bash 3.2 运行时吞字节成未定义变量）", () => {
    // bash 3.2（macOS 自带）在双引号内把 `$VAR）` 的多字节首字节吞进变量名，
    // `set -u` 下报 unbound variable；`bash -n` 语法检查查不出。全量 ${VAR}。
    for (const [name, source] of [
      ["deploy-ecs.sh", deployScript],
      ["backup-run.sh", backupRun],
    ] as const) {
      expect(
        // 「非可打印 ASCII 且非空白」= 多字节首字节等危险相邻（不用 \x00 控制区
        // 转义，eslint no-control-regex 会拦）。
        source.match(/\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7E\s]/g) ?? [],
        `${name} 存在 $var 后紧跟全角字符的写法，改用 \${var}`,
      ).toEqual([]);
    }
  });
});
