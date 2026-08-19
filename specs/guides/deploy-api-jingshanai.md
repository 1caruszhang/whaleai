# api.jingshanai.com 部署上线 Runbook（票 12）

小鲸同学付费内测后端（`backend/`，Hono + SQLite 单 monolith）的生产部署手册：
成都 ECS 上 Docker 单容器 + 宝塔 nginx 反代 `api.jingshanai.com` + SSL。本文可照抄执行，
命令默认在**服务器**上运行（另有标注的除外）；回滚 = 换镜像 tag。

边界说明：本文的「可自动化层」（镜像、compose、本地容器冒烟）已在仓库内交付并验证；
「用户人工层」（ECS 上线、SSL 申请、生产冒烟、资金池预存）汇总在文末
[移交执行清单](#移交执行清单用户人工层)。

## 架构与部署形态

```
客户端（Windows 桌面）
  │ HTTPS（账号 JWT Bearer；SSE 流式）
  ▼
宝塔 nginx（独立站点 api.jingshanai.com，443 SSL）
  │ HTTP proxy_pass（本机回环）
  ▼
Docker 容器 xiaojing-backend:<tag>（绑定 127.0.0.1:8787，非 root，HEALTHCHECK）
  │ 环境变量注入全部密钥（唯一入口）
  ▼
SQLite 账本（named volume xiaojing-data → /app/data）+ 上游（DeepSeek/ARK/OSS 内网/超级媒介）
```

- 服务器：成都 ECS 2核4G（8.137.194.137，规格既有事实），与 OSS bucket 同地域
  （`oss-cn-chengdu`）——网关 putHtml 走内网 endpoint 的部署前提。
- 既有站点零影响：`api.jingshanai.com` 在宝塔里是**独立新建站点**，不复用、不改动
  鲸杉AI官网（官网站点）的任何配置；conf 文件也是独立的一份。
- 公网只暴露 80/443；容器端口只绑 `127.0.0.1:8787`，不直接对公网。

## 0. 前置条件（人工核对）

1. ECS 可登录，装有 Docker ≥ 24 与 docker compose v2（宝塔「Docker」或官方脚本安装均可）：
   ```bash
   docker version --format '{{.Server.Version}}' && docker compose version
   ```
2. 宝塔面板已安装 nginx（任意版本 ≥ 1.20 均可）。
3. DNS：`api.jingshanai.com` 的 A 记录指向 8.137.194.137（在域名解析商处添加，人工）。
4. 阿里云安全组放行 80/443（入方向）；**不要**放行 8787。
5. OSS bucket 在成都地域，AK/SK 已备好（子账号只授该 bucket 权限为宜）。
6. 超级媒介代理商账户已**预存资金池**（上线真实下单前置；余额 0 时 /admin 余额卡会显示
   获取到的 0 元并触发 ≤¥500 预存提醒）。

## 1. 服务器准备（目录与 env 文件）

```bash
sudo mkdir -p /opt/xiaojing-api && cd /opt/xiaojing-api
# 从仓库取三个部署文件（任选 git / scp；文件不入密钥，可进版本库）
#   backend/Dockerfile  backend/docker-compose.yml
#   `<仓库检出目录>` 指开发机上本仓库的 clone 目录名（按实际路径替换）
scp dev-machine:<仓库检出目录>/backend/Dockerfile .
scp dev-machine:<仓库检出目录>/backend/docker-compose.yml .
chmod 600 /opt/xiaojing-api/docker-compose.yml   # 防误改；env 才是敏感文件
```

创建 `/opt/xiaojing-api/.env`（权限 600，属主 root；**此文件永不入仓库、永不入镜像**）：

```bash
sudo chmod 600 /opt/xiaojing-api/.env
```

env 注入清单（逐项 = `backend/src/config.ts` fail-fast 权威清单；缺任一必填项容器启动即失败）：

### 必填（全部为密钥或身份值，`__SET_ON_SERVER__` 处填真实值）

| 变量 | 用途 | 是否密钥 |
|---|---|---|
| `AUTH_SECRET` | JWT HS256 签名 + refresh token 哈希胡椒（账本密钥），≥32 字符随机串 | 是 |
| `ADMIN_PASSWORD` | /admin 运营登录密码 | 是 |
| `DEEPSEEK_API_KEY` | DeepSeek 上游密钥（主 Agent 通道 + extraction/reflection 代理） | 是 |
| `ARK_API_KEY` | 火山方舟 API Key（chat/responses/embeddings 代理） | 是 |
| `OSS_ACCESS_KEY_ID` | 阿里云 OSS AccessKey ID（网关 V1 重签） | 是 |
| `OSS_ACCESS_KEY_SECRET` | 阿里云 OSS AccessKey Secret | 是 |
| `OSS_BUCKET` | OSS bucket 名 | 身份值 |
| `DISTRIBUTION_APP_ID` | 超级媒介代理商 appid | 身份值 |
| `DISTRIBUTION_SECRET` | 超级媒介签名 secret | 是 |

### 生产建议显式设置（有默认值，但生产口径应写明）

| 变量 | 建议值 | 说明 |
|---|---|---|
| `OSS_PUBLIC_BASE_URL` | `https://<bucket>.oss-cn-chengdu.aliyuncs.com` | putHtml 返回给客户端的文章预览 URL 基地址（公网可访问）；不配则返回内网 URL，客户端打不开 |
| `OSS_INTERNAL_HOST` | 默认 `oss-cn-chengdu-internal.aliyuncs.com` | OSS 内网 endpoint；ECS 与 bucket 同地域时用默认即可 |
| `CHAT_INPUT_CNY_PER_MTOK` / `CHAT_INPUT_CACHE_HIT_CNY_PER_MTOK` / `CHAT_OUTPUT_CNY_PER_MTOK` | 按 DeepSeek 官网现价 | 对话隐藏额度折点单价（默认 2/0.2/3 是占位口径） |

### 可选（容器/运维相关，一般不用改）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_PATH` | `/app/data/xiaojing-backend.sqlite` | 镜像已预设为卷内路径；改了会绕开数据卷，勿动 |
| `PORT` | `8787` | 容器内监听端口；compose 端口映射须同步改 |
| `HOST` | `0.0.0.0` | 容器内监听地址（容器网络内暴露，公网面由 compose 绑定 127.0.0.1 决定） |
| `ACCESS_TOKEN_TTL_SECONDS` 等 TTL/价目/阈值 | 见 `backend/README.md` 环境变量表 | 全量可选项以 README 表为准（对表测试钉住两处不漂移） |

`.env` 模板（照抄后替换 `__SET_ON_SERVER__`）：

```bash
sudo tee /opt/xiaojing-api/.env >/dev/null <<'EOF'
# 密钥红线：只存本文件（600 权限），不入镜像层、不入仓库、不入日志。
AUTH_SECRET=__SET_ON_SERVER__
ADMIN_PASSWORD=__SET_ON_SERVER__
DEEPSEEK_API_KEY=__SET_ON_SERVER__
ARK_API_KEY=__SET_ON_SERVER__
OSS_ACCESS_KEY_ID=__SET_ON_SERVER__
OSS_ACCESS_KEY_SECRET=__SET_ON_SERVER__
OSS_BUCKET=__SET_ON_SERVER__
DISTRIBUTION_APP_ID=__SET_ON_SERVER__
DISTRIBUTION_SECRET=__SET_ON_SERVER__
OSS_PUBLIC_BASE_URL=__SET_ON_SERVER__
EOF
sudo chmod 600 /opt/xiaojing-api/.env
# AUTH_SECRET 生成示例：openssl rand -hex 32
```

## 2. 镜像分发（二选一）

| 方式 | 命令 | 取舍 |
|---|---|---|
| A. registry（推荐长期） | 开发机 `docker build -t <registry>/xiaojing-backend:<tag> backend/ && docker push ...`；服务器 `docker pull` | 可追溯、可回滚到任意历史 tag；需要自建/购买 registry（国内网络下公网 registry 可能慢） |
| B. docker save/load（无 registry 时） | 开发机 `docker save xiaojing-backend:<tag> | gzip > xiaojing-backend-<tag>.tar.gz`，scp 到服务器后 `docker load` | 零外部依赖、内网传输稳；镜像 ~90MB（单文件 bundle，无 node_modules），传输可接受；tag 纪律靠人 |

tag 约定：`日期-序号`（如 `20260819-1`），与 git commit 对应记录在发布台账（人工）。
首次部署用方式 B 的完整命令：

```bash
# 开发机（macOS）
cd <仓库检出目录>/backend
docker build -t xiaojing-backend:20260819-1 .
docker save xiaojing-backend:20260819-1 | gzip > /tmp/xiaojing-backend-20260819-1.tar.gz
scp /tmp/xiaojing-backend-20260819-1.tar.gz root@8.137.194.137:/opt/xiaojing-api/

# 服务器
cd /opt/xiaojing-api && gunzip -c xiaojing-backend-20260819-1.tar.gz | docker load
docker images xiaojing-backend   # 确认 tag 在列
rm xiaojing-backend-20260819-1.tar.gz
```

构建机 npm 网络慢时加镜像源：
`docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t xiaojing-backend:<tag> backend/`。

> macOS 开发机注意：Docker Desktop 的 build/pull 后置钩子（scout/ai）在受限网络上会
> 让 `docker build` 明明构建完成却永不返回。本地容器验证脚本
> （`npm run verify:container`）已用隔离 DOCKER_CONFIG 自动绕开；手工构建遇到
> 「构建完成但命令挂住」时，把 `~/.docker/config.json` 里 `features.hooks` 关掉
> （或设置 `DOCKER_CONFIG` 指向仅含 `{}` config 的目录）再试。

## 3. 启动与验证（服务器）

```bash
cd /opt/xiaojing-api
XIAOJING_IMAGE_TAG=20260819-1 docker compose up -d

# 状态与健康检查（镜像自带 HEALTHCHECK：node fetch /healthz）
docker compose ps                       # State 应为 Up (healthy)
docker compose logs --tail 50 api       # 应看到 applied migrations 与 listening

# 本机回环冒烟（公网入口要等第 4 步宝塔反代 + SSL）
curl -s http://127.0.0.1:8787/healthz   # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/admin   # 200
```

常用运维命令：

```bash
docker compose logs -f api              # 跟日志
docker compose restart api              # 重启（数据在卷里，不受影响）
XIAOJING_IMAGE_TAG=<tag> docker compose up -d   # 升级/回滚统一入口（见第 6 节）
```

> `XIAOJING_IMAGE_TAG` 建议固化写进 `/opt/xiaojing-api/.env`（该文件同时被 compose 用作
> 变量插值来源与容器 env 注入来源；`XIAOJING_IMAGE_TAG` 不是密钥，写在那里没问题）。

## 4. 宝塔建站 + nginx 反代 + SSL（用户人工层，照抄执行）

### 4.1 宝塔面板操作形态

1. 宝塔面板 → 网站 → 添加站点：
   - 域名：`api.jingshanai.com`；PHP 版本：纯静态（不建数据库、不建 FTP）。
   - 该操作只会新建 `www/wwwroot/api.jingshanai.com` 目录与**独立的**
     `/www/server/panel/vhost/nginx/api.jingshanai.com.conf`——与官网既有站点互不相干。
2. 先做 DNS 验证：`ping api.jingshanai.com` 应解析到 8.137.194.137。
3. SSL：站点设置 → SSL → Let's Encrypt → 勾选该域名 → 申请（文件验证）→ 开启「强制 HTTPS」。
   宝塔默认自动续期（计划任务 `letsencrypt` 续期）；也可在面板「计划任务」里确认。
4. 反代：站点设置 → 反向代理 → 添加反向代理：
   - 代理名称：`xiaojing-api`；目标 URL：`http://127.0.0.1:8787`；发送域名：`$host`。
5. 手动配置：回到反向代理页点「配置文件」，把 conf 改成 4.2 的全文样例
   （面板生成的缺省配置不含 SSE 必需的 `proxy_buffering off` 等指令，**必须替换**）。
   保存后宝塔自动 `nginx -t && reload`，失败会回滚提示。

### 4.2 生成的 nginx conf 全文样例（独立站点文件）

文件：`/www/server/panel/vhost/nginx/api.jingshanai.com.conf`（宝塔反代「配置文件」里贴入；
SSL 证书路径以宝塔申请成功后自动填写的为准，下方 `ssl_certificate` 两行用面板生成的路径）：

```nginx
# api.jingshanai.com → 小鲸同学后端容器（票 12）。独立站点文件，不影响其他站点。
server {
    listen 80;
    listen 443 ssl http2;
    server_name api.jingshanai.com;

    # 宝塔 Let's Encrypt 申请成功后的证书路径（以面板自动填写为准）
    ssl_certificate    /www/server/panel/vhost/cert/api.jingshanai.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/api.jingshanai.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 仅本站生效的访问日志
    access_log /www/wwwlogs/api.jingshanai.com.log;
    error_log  /www/wwwlogs/api.jingshanai.com.error.log;

    location / {
        proxy_pass http://127.0.0.1:8787;

        # ── SSE / 流式透传要点（/v1/messages 与全部 /gw/* 可能是长连接流）──
        proxy_http_version 1.1;
        proxy_set_header Connection "";        # 合并长连接，禁逐请求 close
        proxy_buffering off;                   # 关键：禁响应缓冲，SSE 事件逐块下发
        proxy_cache off;
        proxy_read_timeout 3600s;              # 长流式对话窗口（1h；含工具调用的轮次足够）
        proxy_send_timeout 3600s;
        chunked_transfer_encoding on;

        # ── WebSocket 兼容（当前后端只有 SSE，但透传头一并配齐，未来零改动）──
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Host $host;

        # ── 常规反代头 ──
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 材料导入可能携带较大请求体
        client_max_body_size 64m;
    }
}
```

要点核对（改前先备份 `cp conf conf.bak`；`nginx -t` 通过再 reload）：

- `proxy_buffering off` 是 SSE 必需——否则 nginx 攒满缓冲才下发，客户端对话看起来「卡住再整段弹出」。
- `proxy_read_timeout` 拉长，避免长对话流被 nginx 60s 默认值掐断。
- 该文件是**独立** server 块：不 include 官网站点配置、不改 `nginx.conf` 主文件；
  官网站点 conf（另一文件）零改动即可复核「零影响」验收项：`nginx -T | grep -c server_name` 前后一致。
- 验证透传形状（服务器上）：
  ```bash
  # 80 应 301/302 到 https（强制 HTTPS 开启后）
  curl -sI http://api.jingshanai.com/healthz | head -3
  # 443 冒烟
  curl -s https://api.jingshanai.com/healthz     # {"ok":true}
  curl -s -o /dev/null -w '%{http_code}\n' https://api.jingshanai.com/admin   # 200
  ```

## 5. 备份（SQLite 卷）

数据全部在 named volume `xiaojing-data`（`/app/data/xiaojing-backend.sqlite` + WAL/SHM）。
**一致性口径**：SQLite 开着 WAL，直接 cp 卷文件可能截到写中间态；用 sqlite3 在线备份
（容器里没有 sqlite3 CLI，借一次性 alpine 容器 + 服务器 sqlite3，推荐前者）：

```bash
# 方式一（推荐，不停机）：借一次性容器跑 sqlite3 .backup
mkdir -p /opt/xiaojing-api/backups
docker run --rm -v xiaojing-data:/data -v /opt/xiaojing-api/backups:/backup alpine:3.20 \
  sh -c 'apk add --no-cache sqlite >/dev/null 2>&1 || apk add --no-cache sqlite-tools; \
         sqlite3 /data/xiaojing-backend.sqlite ".backup /backup/xiaojing-$(date +%Y%m%d-%H%M%S).sqlite"'

# 方式二（升级窗口内，最稳妥）：停容器后整卷打包
cd /opt/xiaojing-api && docker compose stop api
docker run --rm -v xiaojing-data:/data -v /opt/xiaojing-api/backups:/backup alpine:3.20 \
  tar -czf /backup/xiaojing-full-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
docker compose start api

# 定期：把 backups/ 目录纳入现有服务器备份任务（宝塔「计划任务」或 crontab 拉到异地）
ls -lh /opt/xiaojing-api/backups/
```

恢复（整卷回放）：

```bash
cd /opt/xiaojing-api && docker compose stop api
docker run --rm -v xiaojing-data:/data -v /opt/xiaojing-api/backups:/backup alpine:3.20 \
  sh -c 'rm -f /data/* && tar -xzf /backup/xiaojing-full-<时间戳>.tar.gz -C /data'
docker compose start api
```

## 6. 升级与回滚（换镜像 tag 即可）

```bash
cd /opt/xiaojing-api

# 升级到新 tag
docker load <(gunzip -c xiaojing-backend-<新tag>.tar.gz)   # 或 docker pull
XIAOJING_IMAGE_TAG=<新tag> docker compose up -d             # 自动重建容器，数据卷不动
docker compose ps && curl -s http://127.0.0.1:8787/healthz   # 健康后按第 7 节冒烟

# 回滚 = 换回旧 tag（镜像还在本机，秒级）
XIAOJING_IMAGE_TAG=<旧tag> docker compose up -d
```

注意事项：

- 升级前先做一次第 5 节备份；启动日志里的 `applied migrations` 只会向前追加，
  回滚到**旧代码 + 已迁移的新库**时若旧代码不认识新表/新列，先恢复备份再回滚
  （发布台账里记录每次 tag 是否带迁移）。
- 容器重建即断开存量 SSE 连接；桌面客户端对断流有恢复路径，选择低峰操作即可。

## 7. 生产冒烟（移交执行清单：用户人工层）

本地容器级冒烟（占位密钥、mock 上游、不触公网）已在开发机跑通
（`cd backend && npm run verify:container`）；以下为**上线后真实环境**动作，由运营/用户执行：

1. **公网登录冒烟**：`curl -s https://api.jingshanai.com/healthz` → `{"ok":true}`；
   浏览器打开 `https://api.jingshanai.com/admin` → 运营密码登录成功。
2. **真实账号冒烟**：/admin 建号（真实手机号 + 初始密码）→ 客户端登录 → 首登改密 →
   「设置 → 个人信息」看到 500 赠点。
3. **真实计费入账**：对公转账 ¥200 → /admin 充值确认 → 客户端余额 +2000 点；
   /admin 账号页流水出现 `grant` 与 `topup`，Σdelta == balance。
4. **（可选）真实 probe 记账**：客户端跑一次基线探测（5 点/问），核对流水 `consume`
   与 permit 回报口径，供与火山/DeepSeek 账单周度对账。
5. **媒介池余额卡**：/admin 首页显示超级媒介 `GET /profile` 实测余额（前置：资金池已预存）；
   低于 ¥500 会出现预存提醒。
6. **OSS 内网实测**（票 12 验收项「OSS 访问实测走内网 endpoint」）：
   ```bash
   # ECS 上应能解析内网域名（同地域证明）
   getent hosts oss-cn-chengdu-internal.aliyuncs.com
   # 客户端跑一次文章发布预览（putHtml），观察返回 URL 与 /admin Provider 计量出现 oss 记录；
   # 或服务器抓容器出网：内网域名解析为 100.64.x.x 段私网地址即走内网
   docker compose logs api | grep -i internal || true
   ```
7. **官网零影响复核**：浏览器确认鲸杉AI官网正常；`nginx -T` 确认官网站点 conf 未变。

## 8. 密钥红线与抽查（票 12 验收：密钥仅存服务器 env）

- 密钥只经 `/opt/xiaojing-api/.env`（600 权限）→ docker compose `env_file` → 容器进程环境变量。
  **不入镜像层**（`.dockerignore` 挡住 `.env`/`data/`，构建上下文就进不去）、
  **不入仓库**（根 `.gitignore` 的 `.env`/`.env.*` 全局忽略）。
- 上线后抽查（应全部无输出/不含任何密钥）：
  ```bash
  # 1) 镜像层历史里不应出现密钥值（逐层指令检查）
  docker history --no-trunc xiaojing-backend:<tag> | grep -E 'AUTH_SECRET|API_KEY|SECRET|PASSWORD' \
    && echo '!!! 镜像层出现密钥' || echo 'ok: 镜像层无密钥'

  # 2) 镜像文件系统里不应有 .env / sqlite 数据
  docker run --rm --entrypoint sh xiaojing-backend:<tag> \
    -c 'ls -la /app /app/data && find / -name ".env*" -not -path "/proc/*" -not -path "/sys/*" 2>/dev/null'

  # 3) 导出全量文件表抽查（本地验证脚本 verify-container.mjs 的同款口径）
  docker create --name xj-audit --entrypoint sh xiaojing-backend:<tag> -c true
  docker export --output /tmp/xj-audit.tar xj-audit && docker rm xj-audit
  tar -tf /tmp/xj-audit.tar | grep -E '\.env|\.sqlite|node_modules' && echo '!!! 有泄露物' || echo 'ok: 干净'
  rm /tmp/xj-audit.tar

  # 4) 仓库侧（开发机）：git 里不应有 .env
  git -C <仓库检出目录> log --all --diff-filter=A --name-only -- '*.env' 'backend/.env*'
  ```

## 9. 故障速查

| 症状 | 排查 |
|---|---|
| 容器反复重启 / 起不来 | `docker compose logs api`：缺必填 env 会打印 `缺少必需的环境变量：...`（config fail-fast） |
| `curl 127.0.0.1:8787` 通、域名不通 | 宝塔站点/证书/安全组 443；`nginx -T | grep -A3 api.jingshanai` |
| 对话流「整段卡住后一起出」 | 反代 conf 漏了 `proxy_buffering off`（4.2 样例） |
| 502 | 容器健康状态 `docker compose ps`；端口绑定是否被改出 `XIAOJING_BIND` |
| /admin 媒介池「获取失败」 | 超级媒介上游不可达或签名身份未配；账号管理不受影响（降级设计） |
| putHtml 报上游不可达 | ECS 与 bucket 是否同为成都地域；内网域名 `getent hosts` 是否解析 |

---

**本文维护**：env 清单与 `backend/src/config.ts` 的对齐由 `backend/tests/deploy-config-parity.test.ts`
钉住（新增必填 env 而不更新本文，`npm test` 会红）；本地容器冒烟入口
`cd backend && npm run verify:container`（构建镜像→起容器→健康→合约冒烟→SSE 透传→清理）。
