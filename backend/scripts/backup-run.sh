#!/usr/bin/env bash
# 鲸杉geo生产备份执行器（票 15）：由 deploy-ecs.sh backup-install 安装到
# /opt/xiaojing-api/backup-run.sh，cron 与 backup-run 子命令共用同一入口。
#
# 机制：借当前 api 容器自己的镜像（node:24 基础层，已在服务器上，无需额外
# 拉取）执行 backup-sqlite.mjs——volumes-from 挂 xiaojing-data 数据卷做
# node:sqlite 在线热备（VACUUM INTO 一致性快照），导出到 backups/ 目录；
# 只额外挂载输出目录与脚本本体（ro），不挂 .env、不接触任何密钥。
# mkdir 原子目录锁防止 cron 与手工执行重叠（不用 flock：本地演练的 macOS
# 没有该命令；锁残留超 1 小时视为宿主机重启/kill -9 遗留，自动接管）。
#
# 环境变量（backup-run 子命令本地演练时覆盖）：
#   XIAOJING_API_DIR       服务器部署目录（默认 /opt/xiaojing-api）
#   XIAOJING_API_CONTAINER api 容器名（默认 xiaojing-backend-api-1）
set -euo pipefail
# cron 环境只有最小 PATH；追加而非替换，保证本地演练也能找到 docker。
PATH="${PATH}:/usr/sbin:/usr/bin:/sbin:/bin"

API_DIR=${XIAOJING_API_DIR:-/opt/xiaojing-api}
API_CONTAINER=${XIAOJING_API_CONTAINER:-xiaojing-backend-api-1}
SCRIPT="$API_DIR/backup-sqlite.mjs"
BACKUPS="$API_DIR/backups"
LOCK_DIR="$BACKUPS/.backup.lock.d"

fail() { echo "[backup][error] $*" >&2; exit 1; }

[ -f "$SCRIPT" ] || fail "缺少 ${SCRIPT}（先执行 deploy-ecs.sh backup-install）"
command -v docker >/dev/null 2>&1 || fail "本机没有 docker CLI"

# 镜像取自当前容器（升级/回滚换 tag 后自动跟随，永远与数据卷同一版本）。
if ! image=$(docker inspect --format '{{.Config.Image}}' "$API_CONTAINER" 2>/dev/null); then
  fail "找不到容器 ${API_CONTAINER}（api 未启动？先 docker compose up -d）"
fi

# DATABASE_PATH 跟随容器实际配置（默认 /app/data/xiaojing-backend.sqlite；
# 只提取该行，不回显容器其余环境变量）。
db_path=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API_CONTAINER" |
  sed -n 's/^DATABASE_PATH=//p')

mkdir -p "$BACKUPS"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if [ -n "$(find "$LOCK_DIR" -mmin -60 2>/dev/null)" ]; then
    fail "已有备份进程在运行（$LOCK_DIR 存在且未超时），本次跳过"
  fi
  echo "[backup] 接管超时残留锁：$LOCK_DIR"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "无法创建备份锁 $LOCK_DIR"
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

# shellcheck disable=SC2086
docker run --rm \
  -e TZ=Asia/Shanghai \
  -e XIAOJING_BACKUP_DB="${db_path:-/app/data/xiaojing-backend.sqlite}" \
  --volumes-from "$API_CONTAINER" \
  -v "$BACKUPS":/backup \
  -v "$SCRIPT":/backup-sqlite.mjs:ro \
  --entrypoint node \
  "$image" /backup-sqlite.mjs
