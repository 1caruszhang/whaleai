# 小鲸同学后端单体（付费内测）

Hono / TypeScript 单 monolith + SQLite：账号 API、计费网关（票 03 起）、
超级媒介回调端点与 /admin 运营台共用一个进程与一个数据库文件。
部署形态为 Docker 单容器 + 宝塔 nginx 反代（票 12）。

- 桌面应用（`src/`）与该服务完全隔离：独立 package.json、独立测试与
  typecheck，互不进入对方的构建产物。
- Node >= 24（`node:sqlite`、`node:crypto`），无原生编译依赖。

## 快速开始

```bash
cd backend
npm install
cp .env.example .env    # 按需修改；.env 已被仓库 gitignore
npm run dev             # tsx watch，默认监听 0.0.0.0:8787
```

首次启动自动执行迁移（`schema_migrations` 记录进度，幂等）。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `AUTH_SECRET` | ✔ | — | JWT HS256 签名 + refresh token 哈希胡椒（账本密钥），≥32 字符 |
| `ADMIN_PASSWORD` | ✔ | — | /admin 运营登录密码 |
| `DATABASE_PATH` | | `data/xiaojing-backend.sqlite` | SQLite 文件路径 |
| `PORT` / `HOST` | | `8787` / `0.0.0.0` | 监听地址 |
| `ACCESS_TOKEN_TTL_SECONDS` | | `7200` | 账号 JWT 有效期（规格 1–2h，取上限） |
| `REFRESH_TOKEN_TTL_SECONDS` | | `2592000` | refresh 30 天滑动窗口 |
| `ADMIN_TOKEN_TTL_SECONDS` | | `3600` | 运营 JWT 有效期 |
| `SIGNUP_GRANT_POINTS` | | `500` | 开号赠送点数 |

密钥红线：`AUTH_SECRET` 与 `ADMIN_PASSWORD` 只从服务器环境变量进入，
不写日志、不落库、不进构建产物；缺失时启动即失败（`src/config.ts`）。

## API（票 02 账号核心）

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /auth/login` | — | 手机号+密码 → `{accessToken, refreshToken, account}` |
| `POST /auth/refresh` | — | refresh 轮换；旧 token 复用 → 吊销整个会话（401 `refresh_reuse_detected`） |
| `GET /auth/me` | Bearer | 账号投影（手机号、点数、首登改密标记） |
| `POST /auth/change-password` | Bearer | 校验当前密码；成功后旧 JWT（`stale_token`）与旧 refresh 全部失效，返回新 token 对 |
| `POST /auth/logout` | Bearer | 吊销 refreshToken 所属会话 |
| `POST /admin/login` | — | 运营密码 → 短时运营 JWT |
| `POST /admin/accounts` | 运营 JWT | 建号（手机号+初始密码），开通即赠 500 点并落 `grant` 流水 |
| `GET /healthz` | — | 存活探针 |

错误体统一为 `{"error": "<code>", "message": "..."}`。

安全模型要点：

- **JWT**：HS256，claims 含 `sid`（会话）与 `pv`（密码版本）。改密后 `pv`
  失配 → 旧 JWT 立即 401；其余情况 JWT 依自身 TTL 自然失效（决策票 12
  允许 ≤2h 窗口）。停用账号在任何入口立即 403。
- **refresh**：不透明随机串，库里只存 `HMAC-SHA256(AUTH_SECRET, raw)`；
  每次轮换滑动续期 30 天；已消费 token 再次出现视为泄露，吊销整个会话
  （该会话此后一切 refresh 失效，只能重新登录）。
- **密码**：Node 内置 scrypt（N=16384, r=8, p=1），登录对未知手机号做等
  代价校验防时序枚举。

## curl 走查（验收口径）

```bash
B=http://127.0.0.1:8787

# 运营登录 → 建号（赠 500 点）
ADMIN_TOKEN=$(curl -s -X POST $B/admin/login -H 'content-type: application/json' \
  -d '{"password":"<ADMIN_PASSWORD>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).adminToken')
curl -s -X POST $B/admin/accounts -H 'content-type: application/json' \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"phone":"13800001234","initialPassword":"initial-pass-1"}'

# 用户登录（mustChangePassword: true, points: 500）→ 保存 token 对
curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d '{"phone":"13800001234","password":"initial-pass-1"}'
curl -s $B/auth/me -H "authorization: Bearer $ACCESS_TOKEN"

# 首登改密 → 旧 JWT 401 stale_token / 旧 refresh 401 → 用新密码重新登录
curl -s -X POST $B/auth/change-password -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -d '{"currentPassword":"initial-pass-1","newPassword":"brand-new-pass-9"}'

# refresh 轮换；同一旧 refresh 再发一次 → 401 refresh_reuse_detected，
# 且轮换链条上最新一环也随会话吊销而失效
curl -s -X POST $B/auth/refresh -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}"
```

## 数据表（迁移 `0001_accounts_sessions_ledger`）

- `accounts`：手机号唯一、scrypt 哈希、`password_version`（JWT `pv` 对账）、
  `status`（active/disabled）、`must_change_password`、`balance`。
- `auth_sessions`：一次登录一个会话；30 天滑动 `expires_at`；吊销留
  `revoked_reason`（logout / password_changed / refresh_reuse）。
- `refresh_tokens`：哈希唯一、`consumed_at`/`replaced_by` 记录轮换链。
- `ledger_entries`：点数流水（`delta` + `balance_after` 成对出现），
  建号 `grant` 是第一条；permit/充值/调点由票 03 扩展。

迁 PostgreSQL 路径：业务层只依赖 `SqlClient` 接口（`src/db/client.ts`），
表结构用 ANSI 形态（TEXT 主键、ISO 时间戳、INTEGER 布尔），迁移 SQL 直接
可重放到 pg 版实现。

## 测试与验证

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run：HTTP 合约（app.request + 临时 SQLite）+ 密码/令牌/迁移单测
```

测试不触真实网络、不读真实用户目录（AGENTS.md 纪律）；`tests/helpers.ts`
提供依赖注入的测试后端（可固定时钟、覆盖 TTL）。
