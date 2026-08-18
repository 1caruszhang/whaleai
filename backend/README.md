# 小鲸同学后端单体（付费内测）

Hono / TypeScript 单 monolith + SQLite：账号 API、计费核心（点数账本 + permit，
票 03）、超级媒介回调端点与 /admin 运营台共用一个进程与一个数据库文件。
计费网关代理（票 04/05）在此基础上扩展。部署形态为 Docker 单容器 + 宝塔
nginx 反代（票 12）。

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
| `MAX_CONCURRENT_PERMITS_PER_ACCOUNT` | | `2` | 每账号并发计费准入上限（open permit 数） |

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

## API（票 03 点数账本与 permit 计费核心）

计费协议：Sidecar 发起计费操作时申请 permit（操作类型、单位数、单价）→
网关按服务端价目校验并**预扣冻结** → 操作按**最小成败单位**逐个回报
（成功结转、失败自动回补）→ 全部单位回报完毕 permit 自动结清；中止收尾
用 close 把未回报单位全部回补。`permitId` 为客户端生成的幂等键，网络重试/
恢复重跑重放同一申请不二次预扣。

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /billing/balance` | Bearer | 余额三口径 `{total, available, frozen}`（total = available + frozen）+ open permit 列表 |
| `POST /billing/permits` | Bearer | 申请 permit：`{permitId, operation, units, unitPrice, basePrice?}`；价目校验（400 `price_mismatch`）、并发准入（429 `concurrency_limit`）、余额不足（402 `insufficient_balance` 含 `required`/`available`）；幂等重放返回 200 |
| `GET /billing/permits/:permitId` | Bearer | 查询 permit 状态（恢复/对账用） |
| `POST /billing/permits/:permitId/report` | Bearer | 逐单位回报 `{unit, outcome}`；成功立即结转并落 `consume` 流水，失败立即回补冻结；同单位同结果重放幂等 |
| `POST /billing/permits/:permitId/close` | Bearer | 结清：未回报单位视为失败全部回补（操作中止/收尾） |
| `POST /admin/ledger/topup` | 运营 JWT | 充值入账 `{accountId, points, note?}`，落 `topup` 流水 |
| `POST /admin/ledger/adjust` | 运营 JWT | 运营调点 `{accountId, delta≠0, note 必填}`，落 `adjust` 流水；调减不得动用冻结中的点数（409） |
| `GET /admin/accounts/:accountId/ledger` | 运营 JWT | 余额 + 流水（最新在前，`?limit=1..200` 默认 50） |

价目表（服务端唯一权威，`src/domain/pricing.ts`，与《计费标准》公示同源）：
材料导入 20/份；问题池 15/次；基线探测 5/问；主题规划 20（重生成 10）；
文章生成 20/篇（改写 10/篇）；分发计划基础 30 + 被动路 5/问；监测巡检
5/问/次。基础费绑定 permit 的**首个成功单位**结转（整体全失败随回补退回）。
发布订单按渠道变价（媒介费×1.6 向上取整），属票 08 的渠道价目面。

不变量：账本是余额唯一权威——`accounts.balance` 只经 `ledger_entries`
流水变动（grant/topup/adjust/consume，Σdelta == balance 恒成立）；冻结
不改变账面余额，`total = available + frozen` 任何路径不得打破；permit
按账号隔离，跨账号访问一律 404。

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

### curl 走查（票 03 计费核心验收口径）

```bash
B=http://127.0.0.1:8787
ACCESS=<用户 accessToken>   # 走查上方登录流程取得
ADMIN_TOKEN=<运营 adminToken>

# 充值入账与调点：均落流水（topup / adjust），余额 = 可用 + 冻结
curl -s -X POST $B/admin/ledger/topup -H 'content-type: application/json' \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"accountId":"<ACCOUNT_ID>","points":2000,"note":"对公转账 ¥200"}'

# 余额三口径
curl -s $B/billing/balance -H "authorization: Bearer $ACCESS"

# ① 申请 permit：材料导入 3 份 × 20 点 → 预扣冻结 60（available 减 60，total 不变）
curl -s -X POST $B/billing/permits -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS" \
  -d '{"permitId":"pm-material-001","operation":"material_import","units":3,"unitPrice":20}'

# ② 逐最小成败单位回报：unit0 成功 → 结转 20；unit1 失败 → 回补 20；
#    unit2 成功 → 结转 20 且 permit 自动结清（consumed=40 refunded=20 frozen=0）
curl -s -X POST $B/billing/permits/pm-material-001/report -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS" -d '{"unit":0,"outcome":"success"}'
curl -s -X POST $B/billing/permits/pm-material-001/report -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS" -d '{"unit":1,"outcome":"failure"}'
curl -s -X POST $B/billing/permits/pm-material-001/report -H 'content-type: application/json' \
  -H "authorization: Bearer $ACCESS" -d '{"unit":2,"outcome":"success"}'

# ③ 同一 permitId 重放申请 → 200 且不二次预扣（frozen 不变）；
#    换参数重放 → 409 permit_id_conflict
curl -s -X POST $B/billing/permits ... -d '{"permitId":"pm-material-001","operation":"material_import","units":3,"unitPrice":20}'

# ④ 并发准入：连开两个 permit 后第三个 → 429 concurrency_limit（前两个不受影响）
#    中止收尾：close 把未回报单位全部回补
curl -s -X POST $B/billing/permits/pm-xxx/close -H "authorization: Bearer $ACCESS"

# ⑤ 余额不足 → 402 insufficient_balance，响应携带 required（所需点数）与 available（当前可用）
# ⑥ 运营查流水：Σdelta == balance == available + frozen
curl -s "$B/admin/accounts/<ACCOUNT_ID>/ledger?limit=50" -H "authorization: Bearer $ADMIN_TOKEN"
```

## 数据表（迁移 `0001_accounts_sessions_ledger` + `0002_billing_permits`）

- `accounts`：手机号唯一、scrypt 哈希、`password_version`（JWT `pv` 对账）、
  `status`（active/disabled）、`must_change_password`、`balance`（账面总余额，
  含冻结）。
- `auth_sessions`：一次登录一个会话；30 天滑动 `expires_at`；吊销留
  `revoked_reason`（logout / password_changed / refresh_reuse）。
- `refresh_tokens`：哈希唯一、`consumed_at`/`replaced_by` 记录轮换链。
- `ledger_entries`：点数流水（`delta` + `balance_after` 成对出现），
  kind ∈ grant / topup / adjust / consume；建号 `grant` 是第一条，
  Σdelta 恒等于 `accounts.balance`。
- `billing_permits`：计费 permit（客户端幂等键为主键、操作类型、单位数、
  单价/基础费、`frozen_remaining` 剩余冻结、`status` open/settled）；
  open 计入账号并发准入（默认上限 2）。
- `permit_unit_reports`：逐单位回报审计（permit+unit 主键、success/failure、
  回报时间），失败/未回报单位的回补不改账面余额故不进 ledger。

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
