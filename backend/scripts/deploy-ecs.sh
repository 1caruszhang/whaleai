#!/usr/bin/env bash
# 小鲸同学后端 ECS 部署助手（票 12 生产层，自动化 runbook §2-§3 + §5-§6 的可脚本部分）。
# 人工步骤（域名 DNS、宝塔建站与 SSL、资金池预存）见 specs/guides/deploy-api-jingshanai.md §4/§7。
#
# 用法（在仓库检出目录执行）：
#   ./backend/scripts/deploy-ecs.sh check-local                 # 本机前提检查
#   ./backend/scripts/deploy-ecs.sh package [TAG]               # 构建 linux/amd64 镜像并导出 tar
#   ./backend/scripts/deploy-ecs.sh deploy <ssh目标> [TAG]      # 上传+引导+起容器+冒烟（首次会停在 .env 编辑提示）
#   ./backend/scripts/deploy-ecs.sh up <ssh目标> [TAG]          # 只起容器+冒烟（.env 已就绪时）
#   ./backend/scripts/deploy-ecs.sh env-check <ssh目标>         # 只校验服务器 .env 完整性
#   ./backend/scripts/deploy-ecs.sh smoke <base-url>            # 只冒烟（http://127.0.0.1:8787 或 https://域名）
#   ./backend/scripts/deploy-ecs.sh rollback <ssh目标> <TAG>    # 回滚到已 load 的旧 tag
#   ./backend/scripts/deploy-ecs.sh status <ssh目标>            # 容器状态+健康+尾部日志
#   ./backend/scripts/deploy-ecs.sh backup-install <ssh目标>    # 安装每日 SQLite 备份（脚本+cron，幂等可重复）
#   ./backend/scripts/deploy-ecs.sh backup-run <ssh目标>        # 立即在服务器执行一次备份
#   ./backend/scripts/deploy-ecs.sh backup-list <ssh目标>       # 查看备份文件与 cron 安装状态
#   ./backend/scripts/deploy-ecs.sh backup-uninstall <ssh目标>  # 卸载备份 cron（保留脚本与历史备份）
#
# 约定：镜像 xiaojing-backend:<TAG>；服务器目录 /opt/xiaojing-api；密钥只写服务器
# /opt/xiaojing-api/.env（600 权限），本脚本与镜像层永不接触真实密钥。
# 额外 SSH 选项经 XIAOJING_SSH_OPTS 传入（如 "-i ~/.ssh/id_ecs -p 2222"）。
# 构建期 npm 镜像源经 XIAOJING_NPM_REGISTRY 传入（默认不走镜像源）。
set -euo pipefail

SERVER_DIR=/opt/xiaojing-api
IMAGE_NAME=xiaojing-backend
HEALTH_URL_PATH=/healthz
ADMIN_URL_PATH=/admin
SSH_OPTS_EXTRA=${XIAOJING_SSH_OPTS:-}

# 必填 env（权威清单 = backend/src/config.ts 的 fail-fast 列表，
# 与 backend/tests/deploy-config-parity.test.ts 对表钉住；此处仅做服务器侧预检）。
REQUIRED_ENV_KEYS=(
  AUTH_SECRET
  ADMIN_PASSWORD
  DEEPSEEK_API_KEY
  ARK_API_KEY
  OSS_ACCESS_KEY_ID
  OSS_ACCESS_KEY_SECRET
  OSS_BUCKET
  DISTRIBUTION_APP_ID
  DISTRIBUTION_SECRET
)

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

backend_dir() {
  local dir
  dir=$(cd "$(dirname "$0")/.." && pwd) || die "无法定位 backend 目录"
  printf '%s' "$dir"
}

default_tag() {
  printf 'v%s-g%s' "$(date +%Y%m%d-%H%M)" "$(git -C "$(backend_dir)/.." rev-parse --short HEAD 2>/dev/null || echo local)"
}

deploy_dir() { printf '%s/dist/deploy' "$(backend_dir)"; }

latest_tag_file() { printf '%s/LATEST_TAG' "$(deploy_dir)"; }

resolve_tag() {
  local tag=${1:-}
  if [ -z "$tag" ]; then
    [ -f "$(latest_tag_file)" ] || die "未找到 $(latest_tag_file)；先执行 package 或显式传 TAG"
    tag=$(cat "$(latest_tag_file)")
  fi
  printf '%s' "$tag"
}

image_tarball() { printf '%s/%s-%s.tar' "$(deploy_dir)" "$IMAGE_NAME" "$1"; }

# Docker Desktop 的 build/pull 后置钩子在受限网络上会挂起 CLI（构建实际已完成）。
# 用只保留 context 与 cli-plugins 链接的隔离 DOCKER_CONFIG 绕开（与 verify-container.mjs 同款）。
with_isolated_docker_config() {
  local iso_dir
  iso_dir=$(mktemp -d)
  # 保留 currentContext（如 desktop-linux），否则回落 default context 连错 socket。
  local current_context=''
  if [ -f "$HOME/.docker/config.json" ]; then
    current_context=$(sed -n 's/.*"currentContext"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME/.docker/config.json" | head -1)
  fi
  if [ -n "$current_context" ]; then
    printf '{"currentContext":"%s"}\n' "$current_context" >"$iso_dir/config.json"
  else
    printf '{}\n' >"$iso_dir/config.json"
  fi
  local item
  for item in contexts cli-plugins; do
    if [ -e "$HOME/.docker/$item" ]; then
      ln -s "$HOME/.docker/$item" "$iso_dir/$item"
    fi
  done
  DOCKER_CONFIG=$iso_dir "$@"
  local status=$?
  rm -rf "$iso_dir"
  return $status
}

ssh_cmd() {
  # shellcheck disable=SC2086
  ssh -o ServerAliveInterval=15 $SSH_OPTS_EXTRA "$@"
}

# ── check-local ──────────────────────────────────────────────────────────────
cmd_check_local() {
  command -v docker >/dev/null || die "本机没有 docker CLI"
  with_isolated_docker_config docker version >/dev/null || die "docker 守护进程不可达"
  with_isolated_docker_config docker buildx version >/dev/null || die "缺少 docker buildx 插件"
  local platforms
  platforms=$(with_isolated_docker_config docker buildx inspect 2>/dev/null | sed -n 's/^Platforms:[[:space:]]*//p' || true)
  case " $platforms " in
    *amd64*) log "默认 builder 支持 linux/amd64：$platforms" ;;
    *) warn "默认 builder 未声明 amd64（${platforms}）。package 会尝试创建专用 builder；若创建失败（需联网拉 builder 镜像），改用服务器端构建（见 runbook §2 取舍）" ;;
  esac
  command -v scp >/dev/null || die "缺少 scp"
  command -v ssh >/dev/null || die "缺少 ssh"
  log "TAG 将默认为 $(default_tag)"
  log "产物目录 $(deploy_dir)"
  log "check-local 通过"
}

# ── package [TAG] ────────────────────────────────────────────────────────────
cmd_package() {
  # package 生成新 tag（显式传入或默认 时间+commit）；deploy/up 才复用 LATEST_TAG。
  local tag=${1:-$(default_tag)}
  local tarball
  tarball=$(image_tarball "$tag")
  local backend
  backend=$(backend_dir)
  mkdir -p "$(deploy_dir)"

  command -v docker >/dev/null || die "本机没有 docker CLI"

  local build_cmd=(docker buildx build --platform linux/amd64 --load -t "$IMAGE_NAME:$tag")
  if [ -n "${XIAOJING_NPM_REGISTRY:-}" ]; then
    build_cmd+=(--build-arg "NPM_REGISTRY=$XIAOJING_NPM_REGISTRY")
  fi
  build_cmd+=("$backend")

  log "构建 linux/amd64 镜像 $IMAGE_NAME:${tag}（deps 层在模拟下运行，首次可能较慢）"
  if ! with_isolated_docker_config "${build_cmd[@]}"; then
    local platforms
    platforms=$(with_isolated_docker_config docker buildx inspect default --format '{{.Platforms}}' 2>/dev/null || true)
    case " $platforms " in
      *amd64*) die "builder 声明支持 amd64 但构建失败，查看上方日志" ;;
      *)
        log "默认 builder 不支持 amd64，尝试创建专用 builder"
        with_isolated_docker_config docker buildx create --name xiaojing-amd64 --use >/dev/null 2>&1 || true
        with_isolated_docker_config "${build_cmd[@]}" || die "amd64 构建失败。备选：在服务器上构建（scp 源码后 docker build），见 runbook §2"
        ;;
    esac
  fi

  local arch
  arch=$(with_isolated_docker_config docker image inspect --format '{{.Architecture}}' "$IMAGE_NAME:$tag")
  [ "$arch" = "amd64" ] || die "镜像架构是 ${arch}，预期 amd64"

  log "导出镜像 → $tarball"
  with_isolated_docker_config docker save -o "$tarball" "$IMAGE_NAME:$tag"
  (cd "$(deploy_dir)" && shasum -a 256 "$(basename "$tarball")" >"$(basename "$tarball").sha256" 2>/dev/null ||
    sha256sum "$(basename "$tarball")" >"$(basename "$tarball").sha256")
  printf '%s' "$tag" >"$(latest_tag_file)"
  log "完成：${tarball}（$(du -h "$tarball" | cut -f1)），TAG=$tag 已写入 LATEST_TAG"
}

# ── 远程脚本片段（经 bash -s 传参执行，避免引号注入） ─────────────────────────

remote_ensure_docker() {
  ssh_cmd "$1" bash -s <<'REMOTE'
set -euo pipefail
if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then
  docker compose version >/dev/null 2>&1 || { echo "[error] docker 已安装但缺 compose v2 插件"; exit 3; }
  echo "docker 就绪：$(docker --version)"
  exit 0
fi
if command -v docker >/dev/null 2>&1; then
  echo "[error] docker CLI 存在但守护进程不可达（systemd 状态？）"; exit 4
fi
if grep -q 'ID="alinux"' /etc/os-release 2>/dev/null; then
  # Alibaba Cloud Linux 3：get.docker.com 不支持（Unsupported distribution 'alinux'），
  # 改走阿里云 docker-ce 镜像源的 CentOS 8 兼容路径（repo 文件自带 gpgkey）。
  echo "[deploy] 安装 docker（Alibaba Cloud Linux → aliyun docker-ce el8 源）"
  curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo -o /etc/yum.repos.d/docker-ce.repo
  sed -i 's/$releasever/8/g' /etc/yum.repos.d/docker-ce.repo
  dnf -q install -y docker-ce docker-compose-plugin
else
  echo "[deploy] 安装 docker（Aliyun 镜像源）"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || { echo "[error] 下载 get-docker.sh 失败，请手动安装 docker"; exit 5; }
  sh /tmp/get-docker.sh --mirror Aliyun
fi
systemctl enable --now docker
docker compose version >/dev/null 2>&1 || { echo "[error] compose v2 插件缺失"; exit 3; }
echo "docker 安装完成：$(docker --version)"
REMOTE
}

# 远程 .env 引导：首次创建（含随机 AUTH_SECRET），已存在则不动。
remote_bootstrap_env() {
  ssh_cmd "$1" bash -s -- "$SERVER_DIR" <<'REMOTE'
set -euo pipefail
dir=$1
mkdir -p "$dir"
cd "$dir"
if [ -f .env ]; then
  echo "env-exists"
  exit 0
fi
if [ ! -f .env.example ]; then
  echo "[error] .env.example 缺失（先上传）"; exit 6
fi
cp .env.example .env
chmod 600 .env
if command -v openssl >/dev/null 2>&1; then
  secret=$(openssl rand -hex 32)
  sed -i.bak "s|^AUTH_SECRET=.*|AUTH_SECRET=$secret|" .env && rm -f .env.bak
  echo "env-created-with-secret"
else
  echo "env-created"
fi
REMOTE
}

# 远程 .env 完整性：必填键齐全且无 please- 占位。输出未就绪键清单。
remote_env_check() {
  ssh_cmd "$1" bash -s -- "$SERVER_DIR" "${REQUIRED_ENV_KEYS[@]}" <<'REMOTE'
set -euo pipefail
dir=$1
shift
cd "$dir"
if [ ! -f .env ]; then
  echo "ENV_NOT_READY .env 缺失（先 deploy 上传引导）"
  exit 0
fi
status=0
for key in "$@"; do
  value=$(grep -E "^${key}=" .env | tail -1 | cut -d= -f2- || true)
  if [ -z "$value" ]; then
    echo "ENV_NOT_READY $key 未设置"
    status=1
  elif printf '%s' "$value" | grep -qi '^please-'; then
    echo "ENV_NOT_READY $key 仍是占位值"
    status=1
  fi
done
[ "$status" = 0 ] && echo "ENV_READY"
exit 0
REMOTE
}

remote_upload_files() {
  local target=$1 tag=$2
  local tarball
  tarball=$(image_tarball "$tag")
  [ -f "$tarball" ] || die "镜像包不存在：${tarball}（先 package）"
  local backend
  backend=$(backend_dir)
  log "上传 → $target:${SERVER_DIR}（镜像包较大，耐心等待）"
  ssh_cmd "$target" "mkdir -p $SERVER_DIR"
  # shellcheck disable=SC2086
  scp -o ServerAliveInterval=15 $SSH_OPTS_EXTRA "$tarball" "$backend/docker-compose.yml" "$backend/.env.example" "$target:$SERVER_DIR/"
  log "校验远端 sha256"
  local want have
  want=$(cut -d' ' -f1 "$tarball.sha256")
  have=$(ssh_cmd "$target" "sha256sum $SERVER_DIR/$(basename "$tarball")" | cut -d' ' -f1)
  [ "$want" = "$have" ] || die "远端 sha256 不一致（上传损坏？重试）"
}

remote_load_and_up() {
  local target=$1 tag=$2
  log "服务器端 load 镜像并启动 $IMAGE_NAME:$tag"
  ssh_cmd "$target" bash -s -- "$SERVER_DIR" "$IMAGE_NAME" "$tag" <<'REMOTE'
set -euo pipefail
dir=$1 image=$2 tag=$3
cd "$dir"
if ! docker image inspect "$image:$tag" >/dev/null 2>&1; then
  tarball="$image-$tag.tar"
  [ -f "$tarball" ] || { echo "[error] $tarball 不存在"; exit 7; }
  docker load -i "$tarball"
fi
export XIAOJING_IMAGE_TAG=$tag
export XIAOJING_ENV_FILE=$dir/.env
docker compose up -d --remove-orphans
echo "UPLOADED_TAG=$tag"
REMOTE
}

remote_wait_health() {
  local target=$1
  log "等待容器健康（/healthz，最长 120s）"
  ssh_cmd "$target" bash -s <<'REMOTE'
set -uo pipefail
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then
    echo "HEALTHY"
    exit 0
  fi
  sleep 2
done
echo "UNHEALTHY：容器未在 120s 内通过健康检查，最近日志："
docker logs --tail 40 xiaojing-backend-api-1 2>&1 || true
exit 8
REMOTE
}

remote_local_smoke() {
  local target=$1
  log "服务器本地冒烟（只读：healthz / admin 登录页 / 无 token 401）"
  ssh_cmd "$target" bash -s <<'REMOTE'
set -uo pipefail
status=0
health=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/healthz)
[ "$health" = 200 ] && echo "PASS /healthz 200" || { echo "FAIL /healthz $health"; status=1; }
admin=$(curl -s http://127.0.0.1:8787/admin)
if printf '%s' "$admin" | grep -q '/admin/session'; then
  echo "PASS /admin 登录页"
else
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/admin)
  echo "FAIL /admin（${code}，无登录表单）"
  status=1
fi
me=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/auth/me)
[ "$me" = 401 ] && echo "PASS /auth/me 无 token 401" || { echo "FAIL /auth/me ${me}（预期 401）"; status=1; }
exit $status
REMOTE
}

print_next_steps() {
  local tag=$1
  cat <<EOF

$(printf '\033[1;32m[deploy] 服务器侧完成（TAG=%s）\033[0m' "$tag")
剩余人工步骤（runbook specs/guides/deploy-api-jingshanai.md）：
  1. DNS：api.jingshanai.com A 记录 → ECS 公网 IP（域名商控制台）
  2. 宝塔：按 §4.1 建独立站点 + 申请 SSL；§4.2 nginx conf 必须含 proxy_buffering off
  3. 超级媒介资金池预存（/admin 余额卡依赖，阈值 ¥500 提醒）
  4. 公网冒烟：./backend/scripts/deploy-ecs.sh smoke https://api.jingshanai.com
  5. 每日备份（推荐）：./backend/scripts/deploy-ecs.sh backup-install <ssh目标>
  6. 生产验收（真实建号/充值/计费冒烟）：runbook §7
回滚：./backend/scripts/deploy-ecs.sh rollback <ssh目标> <旧TAG>
EOF
}

# ── deploy / up ──────────────────────────────────────────────────────────────
cmd_deploy() {
  [ $# -ge 1 ] || die "用法：deploy <ssh目标> [TAG]"
  local target=$1 tag
  tag=$(resolve_tag "${2:-}")
  local tarball
  tarball=$(image_tarball "$tag")
  [ -f "$tarball" ] || die "镜像包不存在：${tarball}（先执行 package ${tag}）"

  remote_ensure_docker "$target"
  remote_upload_files "$target" "$tag"
  local env_line
  env_line=$(remote_bootstrap_env "$target")
  case "$env_line" in
    env-created-with-secret)
      warn "已在服务器生成 .env（AUTH_SECRET 已随机填充）"
      ;;
    env-created)
      warn "已在服务器生成 .env（AUTH_SECRET 仍为占位，编辑时自行生成）"
      ;;
    env-exists) log "服务器 .env 已存在，沿用" ;;
    *) die "env 引导异常：$env_line" ;;
  esac

  local check
  check=$(remote_env_check "$target" | tail -n +1)
  printf '%s\n' "$check" | sed 's/^/[env] /'
  if printf '%s' "$check" | grep -q '^ENV_NOT_READY'; then
    cat <<EOF

$(printf '\033[1;33m[下一步]\033[0m 服务器 .env 还有占位值，请编辑后重跑同一命令：')
  ssh $target
  vi $SERVER_DIR/.env     # 填齐上面列出的键；OSS_REGION 须与 ECS 同地域（内网直连）
  ./backend/scripts/deploy-ecs.sh deploy $target $tag
EOF
    exit 0
  fi

  cmd_up "$target" "$tag"
}

cmd_up() {
  [ $# -ge 1 ] || die "用法：up <ssh目标> [TAG]"
  local target=$1 tag
  tag=$(resolve_tag "${2:-}")
  remote_ensure_docker "$target"
  local check
  check=$(remote_env_check "$target")
  printf '%s\n' "$check" | sed 's/^/[env] /'
  printf '%s' "$check" | grep -q '^ENV_READY' || die "服务器 .env 未就绪（见上），先 deploy 完成引导"
  remote_load_and_up "$target" "$tag"
  remote_wait_health "$target"
  remote_local_smoke "$target"
  print_next_steps "$tag"
}

# ── smoke <base-url> ─────────────────────────────────────────────────────────
cmd_smoke() {
  [ $# -ge 1 ] || die "用法：smoke <base-url>（如 https://api.jingshanai.com）"
  local base=${1%/}
  local status=0 health admin_code me
  health=$(curl -s -o /dev/null -w '%{http_code}' "$base$HEALTH_URL_PATH" || true)
  [ "$health" = 200 ] && echo "PASS $base$HEALTH_URL_PATH → 200" || { echo "FAIL $base$HEALTH_URL_PATH → $health"; status=1; }
  admin_code=$(curl -s -o /dev/null -w '%{http_code}' "$base$ADMIN_URL_PATH" || true)
  local admin_body
  admin_body=$(curl -s "$base$ADMIN_URL_PATH" || true)
  if [ "$admin_code" = 200 ] && printf '%s' "$admin_body" | grep -q '/admin/session'; then
    echo "PASS $base$ADMIN_URL_PATH → 200 登录表单"
  else
    echo "FAIL $base$ADMIN_URL_PATH → ${admin_code}（无登录表单）"
    status=1
  fi
  me=$(curl -s -o /dev/null -w '%{http_code}' "$base/auth/me" || true)
  [ "$me" = 401 ] && echo "PASS $base/auth/me 无 token → 401" || { echo "FAIL $base/auth/me → ${me}（预期 401）"; status=1; }
  [ "$status" = 0 ] && echo "smoke 全过"
  exit $status
}

# ── rollback / status / env-check ───────────────────────────────────────────
cmd_rollback() {
  [ $# -ge 2 ] || die "用法：rollback <ssh目标> <旧TAG>"
  local target=$1 tag=$2
  remote_ensure_docker "$target"
  ssh_cmd "$target" "docker image inspect $IMAGE_NAME:$tag >/dev/null" || die "服务器上没有 $IMAGE_NAME:${tag}（旧镜像已被清理则需重新 package+upload）"
  remote_load_and_up "$target" "$tag"
  remote_wait_health "$target"
  log "已回滚到 $tag"
}

cmd_status() {
  [ $# -ge 1 ] || die "用法：status <ssh目标>"
  local target=$1
  ssh_cmd "$target" bash -s -- "$SERVER_DIR" <<'REMOTE'
set -uo pipefail
cd "$1" || exit 9
docker compose ps || true
echo "--- 最近 20 行日志 ---"
docker logs --tail 20 xiaojing-backend-api-1 2>&1 || true
curl -fsS http://127.0.0.1:8787/healthz && echo " <- healthz" || echo "healthz 不可达"
REMOTE
}

cmd_env_check() {
  [ $# -ge 1 ] || die "用法：env-check <ssh目标>"
  remote_env_check "$1"
}

# ── backup-install / backup-run / backup-list / backup-uninstall（票 15）─────
# 机制：backup-sqlite.mjs 经 backup-run.sh 借当前 api 容器自己的镜像执行
# （node:sqlite VACUUM INTO 在线热备，详见 runbook §5）；本组子命令只做
# 脚本上传与 /etc/cron.d/xiaojing-backup 的安装/卸载，幂等可重复。
BACKUP_CRON_FILE=/etc/cron.d/xiaojing-backup

cmd_backup_install() {
  [ $# -ge 1 ] || die "用法：backup-install <ssh目标>"
  local target=$1
  local cron_spec=${XIAOJING_BACKUP_CRON:-"30 4 * * *"}
  # cron 5 字段形状 + 字符集预检（顺带挡掉换行/引号注入；远端再整文件覆写，天然幂等）。
  if ! printf '%s' "$cron_spec" | grep -Eq '^[0-9A-Za-z/*,-]+( [0-9A-Za-z/*,-]+){4}$'; then
    die "XIAOJING_BACKUP_CRON 必须是 5 字段 cron 表达式（收到：$cron_spec）"
  fi

  local backend
  backend=$(backend_dir)
  local script="$backend/scripts/backup-sqlite.mjs" wrapper="$backend/scripts/backup-run.sh"
  [ -f "$script" ] || die "缺少 $script"
  [ -f "$wrapper" ] || die "缺少 $wrapper"

  log "上传备份脚本 → $target:$SERVER_DIR"
  # backups 目录属主对齐容器内 node 用户（uid 1000）：备份容器以镜像默认
  # USER node 运行，root 属主的 700 目录在 Linux 上会写不进（VACUUM INTO 失败）。
  ssh_cmd "$target" "mkdir -p $SERVER_DIR/backups && chown 1000:1000 $SERVER_DIR/backups && chmod 700 $SERVER_DIR/backups"
  # shellcheck disable=SC2086
  scp -o ServerAliveInterval=15 $SSH_OPTS_EXTRA "$script" "$wrapper" "$target:$SERVER_DIR/"

  log "安装 cron（$cron_spec → $BACKUP_CRON_FILE）"
  ssh_cmd "$target" bash -s -- "$SERVER_DIR" "$cron_spec" "$BACKUP_CRON_FILE" <<'REMOTE'
set -euo pipefail
dir=$1 cron=$2 cron_file=$3
chmod 700 "$dir/backup-run.sh"
printf '%s root %s/backup-run.sh >> %s/backups/backup.log 2>&1\n' "$cron" "$dir" "$dir" >"$cron_file"
chown root:root "$cron_file"
chmod 644 "$cron_file"
# alinux/centos 系服务名是 crond，debian 系是 cron；都起不来只警告不失败
# （脚本与 cron 文件已就位，人工 systemctl start 后即生效）。
systemctl enable --now crond 2>/dev/null || systemctl enable --now cron 2>/dev/null \
  || echo "[warn] 未能自动启用 crond/cron，请确认定时服务在运行"
echo "CRON_INSTALLED: $(cat "$cron_file")"
REMOTE

  log "backup-install 完成：每日「${cron_spec}」备份 → $SERVER_DIR/backups（默认保留最近 14 份，XIAOJING_BACKUP_KEEP 可调）"
  log "立即试跑一次：./backend/scripts/deploy-ecs.sh backup-run $target"
}

cmd_backup_run() {
  [ $# -ge 1 ] || die "用法：backup-run <ssh目标>"
  local target=$1
  ssh_cmd "$target" bash -s -- "$SERVER_DIR" <<'REMOTE'
set -euo pipefail
dir=$1
[ -f "$dir/backup-run.sh" ] || { echo "[error] 未安装备份脚本（先 backup-install）"; exit 10; }
exec "$dir/backup-run.sh"
REMOTE
}

cmd_backup_list() {
  [ $# -ge 1 ] || die "用法：backup-list <ssh目标>"
  local target=$1
  ssh_cmd "$target" bash -s -- "$SERVER_DIR" "$BACKUP_CRON_FILE" <<'REMOTE'
set -uo pipefail
dir=$1 cron_file=$2
echo "== cron（$cron_file）=="
if [ -f "$cron_file" ]; then cat "$cron_file"; else echo "（未安装：deploy-ecs.sh backup-install）"; fi
echo "== 备份文件（$dir/backups）=="
count=$(ls "$dir/backups"/xiaojing-*.sqlite 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" = 0 ]; then
  echo "（暂无备份文件：deploy-ecs.sh backup-run 立即执行一次）"
else
  ls -lh "$dir/backups"/xiaojing-*.sqlite
  echo "共 ${count} 份"
fi
echo "== backup.log 尾部 =="
tail -n 5 "$dir/backups/backup.log" 2>/dev/null || echo "（暂无日志）"
REMOTE
}

cmd_backup_uninstall() {
  [ $# -ge 1 ] || die "用法：backup-uninstall <ssh目标>"
  local target=$1
  log "卸载备份 cron（$BACKUP_CRON_FILE）"
  ssh_cmd "$target" bash -s -- "$BACKUP_CRON_FILE" <<'REMOTE'
set -uo pipefail
cron_file=$1
if [ -f "$cron_file" ]; then
  rm -f "$cron_file"
  echo "CRON_REMOVED"
else
  echo "CRON_ABSENT（本就未安装，幂等通过）"
fi
REMOTE
  log "cron 已卸载；备份脚本与历史备份保留在 $SERVER_DIR（确认不再需要时手动清理）"
}

usage() {
  sed -n '5,17p' "$0"
  exit 1
}

main() {
  [ $# -ge 1 ] || usage
  local cmd=$1
  shift
  case "$cmd" in
    check-local) cmd_check_local "$@" ;;
    package) cmd_package "$@" ;;
    deploy) cmd_deploy "$@" ;;
    up) cmd_up "$@" ;;
    env-check) cmd_env_check "$@" ;;
    smoke) cmd_smoke "$@" ;;
    rollback) cmd_rollback "$@" ;;
    status) cmd_status "$@" ;;
    backup-install) cmd_backup_install "$@" ;;
    backup-run) cmd_backup_run "$@" ;;
    backup-list) cmd_backup_list "$@" ;;
    backup-uninstall) cmd_backup_uninstall "$@" ;;
    *) usage ;;
  esac
}

main "$@"
