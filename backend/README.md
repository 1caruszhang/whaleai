# 小鲸同学后端单体（付费内测）

Hono / TypeScript 单 monolith + SQLite：账号 API、计费核心（点数账本 + permit，
票 03）、网关主 Agent 通道与对话隐藏额度（票 04）、其余 Provider 代理与签名
重签（票 05）、超级媒介回调端点与 /admin 运营台共用一个进程与一个数据库
文件。部署形态为 Docker 单容器 + 宝塔 nginx 反代（票 12）。

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

## 部署（票 12）

Docker 单容器 + 宝塔 nginx 反代 `api.jingshanai.com`；完整上线手册（含 env
注入清单、SSL、升级/回滚、备份、密钥抽查）见
[specs/guides/deploy-api-jingshanai.md](../specs/guides/deploy-api-jingshanai.md)。

- `Dockerfile`：多阶段构建（esbuild 单文件 bundle，运行层无 node_modules、
  非 root、HEALTHCHECK 打 `/healthz`）。密钥绝不入镜像层（`.dockerignore`
  挡 `.env`/`data/`，并有容器侧抽查）。
- `docker-compose.yml`：SQLite 数据卷 `xiaojing-data` 挂出、`env_file` 注入
  环境变量、`restart: unless-stopped`、默认只绑 `127.0.0.1:8787`
  （公网流量一律经反代）。
- 本地容器级验证（构建→起容器→健康→合约冒烟→SSE 透传 mock→清理，占位
  密钥不触公网）：`npm run verify:container`。
- 生产 SQLite 每日备份自动化（票 15）：`deploy-ecs.sh backup-install/run/list/uninstall`
  子命令组（VACUUM INTO 在线热备、保留最近 14 份、cron 幂等安装），机制与
  恢复手册见 runbook §5；本地全链路演练（造数据→备份→删卷回放→数据可读）：
  `npm run verify:backup`。

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `AUTH_SECRET` | ✔ | — | JWT HS256 签名 + refresh token 哈希胡椒（账本密钥），≥32 字符 |
| `ADMIN_PASSWORD` | ✔ | — | /admin 运营登录密码 |
| `DEEPSEEK_API_KEY` | ✔ | — | DeepSeek 上游密钥（主 Agent 通道票 04 + extraction/reflection 代理票 05），只经环境变量注入 |
| `ARK_API_KEY` | ✔ | — | 火山方舟 API Key（ARK chat/responses/embeddings 代理，票 05） |
| `OSS_ACCESS_KEY_ID` | ✔ | — | 阿里云 OSS AccessKey ID（网关 V1 重签，私钥仅在服务器） |
| `OSS_ACCESS_KEY_SECRET` | ✔ | — | 阿里云 OSS AccessKey Secret |
| `OSS_BUCKET` | ✔ | — | OSS bucket |
| `DISTRIBUTION_APP_ID` | ✔ | — | 超级媒介代理商 appid（网关 HMAC-SHA256 重签） |
| `DISTRIBUTION_SECRET` | ✔ | — | 超级媒介签名 secret |
| `DATABASE_PATH` | | `data/xiaojing-backend.sqlite` | SQLite 文件路径 |
| `PORT` / `HOST` | | `8787` / `0.0.0.0` | 监听地址 |
| `ACCESS_TOKEN_TTL_SECONDS` | | `7200` | 账号 JWT 有效期（规格 1–2h，取上限） |
| `REFRESH_TOKEN_TTL_SECONDS` | | `2592000` | refresh 30 天滑动窗口 |
| `ADMIN_TOKEN_TTL_SECONDS` | | `3600` | 运营 JWT 有效期（JSON Bearer 与 SSR 会话 cookie 共用） |
| `ADMIN_LOGIN_THROTTLE_UNIT_MS` | | `500` | 运营密码错误登录节流步长：连续失败第 n 次延时 min(n×步长, 20×步长)，只延时不断锁 |
| `ADMIN_MEDIA_POOL_LOW_BALANCE_CNY` | | `500` | /admin 媒介池低余额提醒阈值（元） |
| `SIGNUP_GRANT_POINTS` | | `500` | 开号赠送点数 |
| `MAX_CONCURRENT_PERMITS_PER_ACCOUNT` | | `2` | 每账号并发计费准入上限（open permit 数） |
| `DEEPSEEK_BASE_URL` | | `https://api.deepseek.com/anthropic` | DeepSeek Anthropic 兼容上游基地址 |
| `DEEPSEEK_OPENAI_BASE_URL` | | `https://api.deepseek.com` | DeepSeek OpenAI 兼容上游基地址（extraction/reflection） |
| `ARK_BASE_URL` | | `https://ark.cn-beijing.volces.com/api/v3` | 火山方舟 paygo 基地址 |
| `ARK_EMBEDDING_API_KEY` | | 回落 `ARK_API_KEY` | ARK embedding 专用 key（与 sidecar 口径一致） |
| `DOUBAO_SEARCH_API_KEY` | | 回落 `ARK_API_KEY` | 豆包搜索专用 key |
| `DOUBAO_SEARCH_BASE_URL` | | `https://open.feedcoopapi.com` | 豆包搜索 HTTP API 基地址 |
| `OSS_REGION` | | `oss-cn-chengdu` | OSS 地域（内网 endpoint 缺省由它推导） |
| `OSS_INTERNAL_HOST` | | `{OSS_REGION}-internal.aliyuncs.com` | OSS 同地域内网 endpoint host |
| `OSS_PUBLIC_BASE_URL` | | — | OSS 公网访问基地址（putHtml 返回 URL 优先用它拼，生产建议配置） |
| `DISTRIBUTION_BASE_URL` | | `https://vip.chaojimeijie.com/api` | 超级媒介 API 基地址 |
| `CHAT_HIDDEN_QUOTA_POINTS` | | `100` | 对话隐藏额度（点等值），用尽暂停对话、任意档位充值刷新 |
| `CHAT_INPUT_CNY_PER_MTOK` | | `2` | 对话旁路计量：未命中缓存输入单价（元/百万 token，默认值为占位口径，生产按 DeepSeek 官网现价调整） |
| `CHAT_INPUT_CACHE_HIT_CNY_PER_MTOK` | | `0.2` | 对话旁路计量：缓存命中输入单价（元/百万 token） |
| `CHAT_OUTPUT_CNY_PER_MTOK` | | `3` | 对话旁路计量：输出单价（元/百万 token） |

密钥红线：`AUTH_SECRET`、`ADMIN_PASSWORD` 与全部上游密钥（`DEEPSEEK_API_KEY`、
`ARK_API_KEY`、`ARK_EMBEDDING_API_KEY`、`DOUBAO_SEARCH_API_KEY`、OSS AK/SK、
`DISTRIBUTION_APP_ID`/`DISTRIBUTION_SECRET`）只从服务器环境变量进入，不写日志、
不落库、不进构建产物；缺失时启动即失败（`src/config.ts`）。上游密钥只出现在
网关对上游的请求头/签名里；上游错误体回显密钥时由清洗层抹除后才回传客户端。

**OSS 同地域内网直连**（票 05）：网关把 OSS putHtml 重签后投递到
`https://{bucket}.{OSS_REGION}-internal.aliyuncs.com/{key}` 内网 endpoint
（OSS V1 签名不含 Host，换内网 endpoint 不破坏签名）。**部署前提：ECS 与
OSS bucket 必须同地域（成都，`oss-cn-chengdu`）**，否则内网域名不可解析；
跨地域部署时用 `OSS_INTERNAL_HOST` 显式覆盖为公网或正确地域的 endpoint。

**对话旁路计量折点口径**（票 04）：锚点 1 元 = 10 点；缓存写（cache
creation）按未命中输入价计、缓存读按命中价计；折点内部以千分之一点
（milli-point）整数累计，避免小额调用取整归零。三个单价环境变量的默认值
（2 / 0.2 / 3 元每百万 token）是 **deepseek-chat 标价的占位口径**，DeepSeek
调价或切换模型时改环境变量即可，无需改代码。

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

## API（票 04 网关主 Agent 通道与对话隐藏额度）

主 Agent（Claude Agent SDK）经 env 注入 base URL + 账号 access token 指向
网关的 Anthropic 兼容端点；SSE 流式、工具调用块、count_tokens 兜底全部
透传至 DeepSeek 上游（禁缓冲、不吞事件），响应字节与直连上游等价。

对话规则：对用户免费且不显示任何额度；余额为 0 拒绝对话（402
`chat_balance_zero`）；每次调用的真实 token 用量旁路计量折点累计，每个
充值周期内 100 点等值隐藏额度（默认，`CHAT_HIDDEN_QUOTA_POINTS`）用尽
暂停对话（402 `chat_quota_exhausted`，文案同样引导充值，错误码与余额 0
区分）；任意档位充值（topup）刷新额度立即恢复。剩余额度对客户端接口
不可见——任何用户侧响应都不携带对话额度字段。

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/messages` | Bearer（账号 JWT） | Anthropic Messages 兼容代理：请求体原样转发上游（注入 DeepSeek 密钥、剥除客户端凭证头），SSE 逐块透传；非流式 JSON 亦透传并旁路计量 |
| `POST /v1/messages/count_tokens` | Bearer（账号 JWT） | count_tokens 兜底纯透传（非流式、不计量），共用对话闸门 |
| `GET /admin/accounts/:accountId/chat-usage` | 运营 JWT | 旁路计量对账：按请求列 token 用量与折点（`records`，最新在前，`?limit=1..200` 默认 50）+ 本周期累计 `quotaUsedMilli` |

网关错误码：`chat_balance_zero`（余额为 0）、`chat_quota_exhausted`
（隐藏额度用尽）、`upstream_unavailable`（上游不可达，502）；上游返回
错误时状态码照常透传、正文经密钥清洗。鉴权失败复用账号 JWT 语义
（401 `invalid_token` / `token_expired` / `stale_token`，403 `account_disabled`）。

安全模型（票 04 增量）：上游密钥只在对上游请求头出现；客户端账号 token
不转发上游；上游错误体先抹掉密钥/token 再回传（保形 JSON 或通用兜底体）；
旁路计量表只经 /admin 运营面暴露。

错误体统一为 `{"error": "<code>", "message": "..."}`。

## API（票 05 其余 Provider 代理与签名重签）

主 Agent 通道（票 04）以外的全部 Provider 流量经网关代理：客户端只持账号
token，上游密钥与签名身份全部在服务器侧。路径约定与 Sidecar 端点覆盖机制
（票 01）对接——网关路径 = 上游路径：把 Sidecar 的
`XIAOJING_ARK_PAYGO_BASE_URL` 指到 `<网关>/gw/ark`、
`XIAOJING_DOUBAO_SEARCH_BASE_URL` 指到 `<网关>/gw/doubao-search`、
`XIAOJING_DISTRIBUTION_BASE_URL` 指到 `<网关>/gw/distribution`，Sidecar 拼出的
固定子路径原样落到下列路由（票 07 接线）；OSS 走 `PUT /gw/oss/{encodedObjectKey}`。

| 方法与路径 | 上游 | 说明 |
|---|---|---|
| `POST /gw/deepseek/chat/completions` | DeepSeek OpenAI | extraction/reflection：body 全透传，鉴权头重写为服务器 DeepSeek key |
| `POST /gw/ark/chat/completions` | ARK | generation / keyword-search（body 的 `enable_search:true` 原样透传），鉴权头重写为 ARK key |
| `POST /gw/ark/responses` | ARK | probeQuestion：网关注入非标头 `ark-beta-doubao-app: true`，Responses body 全透传 |
| `POST /gw/ark/embeddings/multimodal` | ARK | embedding：专用 key 缺省回落 ARK key（与 sidecar 口径一致） |
| `POST /gw/doubao-search/search_api/web_search` | 豆包搜索 | searchSources 结构化召回：专用 key 缺省回落 ARK key |
| `PUT /gw/oss/{encodedObjectKey}` | 阿里云 OSS（**同地域内网**） | putHtml：网关以服务器 AK/SK 按 OSS V1 HMAC-SHA1 重签（Host 不参与签名，换内网 endpoint 签名不变），URL 编码口径与 sidecar `encodeObjectKey` 一致；成功返回 `{url}`（配了 `OSS_PUBLIC_BASE_URL` 用公网拼，否则内网上游 URL） |
| `GET /gw/distribution/media/resource`、`GET /gw/distribution/we-media/resource` | 超级媒介 | 资源读取：网关以服务器 appid/secret 按 HMAC-SHA256 展平算法重签；公共参数（appid/timestamp/algorithm/signature）全部由网关生成，客户端混入的签名参数一律忽略；`timestamp` 取网关时钟（10 位 unix 秒，上游 5 分钟时效恒新鲜）；业务参数仅 `page`（≥1，默认 1）与 `size`（1–200，默认 20） |

旁路计量（票 05）：每次上游 2xx 的代理请求落一行
`provider_usage_records`——LLM 流量记真实 token（OpenAI 系 usage 口径：
`prompt_tokens`/`completion_tokens` 与 `input_tokens`/`output_tokens` 两族都
识别；SSE 兜底分支按次数），OSS/超级媒介按次数。计量只作运营与火山/豆包/
OSS 账单对账，不动 `ledger_entries`（Σdelta == balance 不变量）；计费扣点
走 permit 通道（票 03/07）。

签名移植对照（票 05 验收）：OSS V1 与超级媒介展平签名逐字节移植自 Sidecar
现有 Node 实现（`src/server/geo/provider-capabilities.ts`，只读参照），
`tests/provider-signing-parity.test.ts` 用 sidecar 真跑捕获的黄金向量锁定
一致性（含路由级端到端：同输入经网关发出的 Authorization/query 与 sidecar
逐字节相同）。

安全模型（票 05 增量，同票 04）：上游密钥只在对上游请求头/签名出现；客户端
账号 token 不转发上游；上游错误体先抹掉密钥/token 再回传；OSS 私钥
（AccessKeySecret）与超级媒介 secret 不进任何日志、响应或数据库；
`upstream_unavailable`（502）与 `invalid_object_key`（400）不带内部信息。

安全模型要点：

- **JWT**：HS256，claims 含 `sid`（会话）与 `pv`（密码版本）。改密后 `pv`
  失配 → 旧 JWT 立即 401；其余情况 JWT 依自身 TTL 自然失效（决策票 12
  允许 ≤2h 窗口）。停用账号在任何入口立即 403。
- **refresh**：不透明随机串，库里只存 `HMAC-SHA256(AUTH_SECRET, raw)`；
  每次轮换滑动续期 30 天；已消费 token 再次出现视为泄露，吊销整个会话
  （该会话此后一切 refresh 失效，只能重新登录）。
- **密码**：Node 内置 scrypt（N=16384, r=8, p=1），登录对未知手机号做等
  代价校验防时序枚举。

## 运营台（票 10 /admin SSR 页面）

服务端渲染的运营管理页，运营全程不接触命令行。与 JSON 运营 API 并存：
页面 GET 挂 `/admin` 与 `/admin/accounts/:accountId`，表单动作统一挂
`/admin/ui/*`（与 JSON API 路径不重合）；写操作走表单 POST + 303（PRG）。

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `GET /admin` | 会话 cookie | 未登录渲染登录页；已登录渲染仪表盘：媒介池余额卡（代理超级媒介 `GET /profile` 实测值，低于阈值提醒预存）+ 账号列表 + 建号表单（开通即赠点） |
| `POST /admin/session` | — | 运营密码登录：签发运营 JWT 进 `HttpOnly;SameSite=Lax` cookie（`xiaojing_admin`，有效期同 `ADMIN_TOKEN_TTL_SECONDS`）；错误密码 401 + 递增延时节流（与 JSON 登录共享计数） |
| `POST /admin/logout` | 会话 cookie | 清除会话 cookie（Max-Age=0） |
| `POST /admin/ui/accounts` | 会话 cookie | 建号（手机号 + 初始密码 ≥8 位） |
| `POST /admin/ui/accounts/:accountId/status` | 会话 cookie | 停用/启用；停用即时吊销账号全部会话（`revoked_reason=admin_disabled`），余额与流水不动 |
| `POST /admin/ui/accounts/:accountId/topup` | 会话 cookie | 充值对账确认：金额（元，最小粒度 0.1 元 = 1 点）+ 来源备注同落 `topup` 流水（`充值 ¥X：备注`） |
| `POST /admin/ui/accounts/:accountId/adjust` | 会话 cookie | 调点（正负整数 ≠0，备注必填），落 `adjust` 流水 |
| `GET /admin/accounts/:accountId` | 会话 cookie | 账号对账页：余额三口径 + 点数流水 + 计费操作（permit 扣点口径）+ 发布订单 + Provider 计量 + 对话计量 |

形态与安全：纯模板字符串渲染 + 统一 `esc()` 转义（手机号/备注等一切回显），
零客户端 `<script>`、零新依赖、无独立前端工程；低余额阈值比较在服务端
渲染时完成。会话凭证复用运营 JWT（audience 隔离：用户 access token 进
cookie 无效）；`SameSite=Lax` 挡跨站表单 POST（CSRF 主要面）。/profile 代理
复用票 05 展平签名栈（timestamp 取网关时钟）；上游失败时余额卡降级为
「获取失败」，不阻断账号管理。`/profile` 余额字段上游文档未定案，现按
`data.money` / `data.balance`（number 或十进制字符串）防御式解析，取不到
有限数字按上游失败处理。

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

### curl 走查（票 04 网关主 Agent 通道验收口径）

```bash
B=http://127.0.0.1:8787
ACCESS=<用户 accessToken>   # 走查上方登录流程取得
ADMIN_TOKEN=<运营 adminToken>

# ① 流式对话：SSE 逐块透传（工具调用块/ping 原样），Ctrl-C 中断
curl -N -X POST $B/v1/messages -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"deepseek-chat","max_tokens":256,"stream":true,
       "messages":[{"role":"user","content":"你好"}]}'

# ② count_tokens 兜底
curl -X POST $B/v1/messages/count_tokens -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'

# ③ 余额为 0 / 隐藏额度用尽 → 402 chat_balance_zero / chat_quota_exhausted（文案均引导充值）；
#    任意档位充值后对话立即恢复
curl -s -X POST $B/admin/ledger/topup -H 'content-type: application/json' \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -d '{"accountId":"<ACCOUNT_ID>","points":2000,"note":"对公转账 ¥200"}'

# ④ 运营旁路计量对账：每请求 token 用量与折点 + 本周期累计（千分点）
curl -s "$B/admin/accounts/<ACCOUNT_ID>/chat-usage?limit=50" -H "authorization: Bearer $ADMIN_TOKEN"
```

### curl 走查（票 05 Provider 代理验收口径）

```bash
B=http://127.0.0.1:8787
ACCESS=<用户 accessToken>   # 走查上方登录流程取得

# ① ARK chat/completions（keyword-search 的 enable_search / generation 同端点）
curl -s -X POST $B/gw/ark/chat/completions -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2-0-lite-260428","messages":[{"role":"user","content":"关键词"}],
       "stream":false,"enable_search":true}'

# ② probeQuestion：/responses（网关注入 ark-beta-doubao-app 头）
curl -s -X POST $B/gw/ark/responses -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"model":"doubao-seed-2-0-lite-260428","input":[{"role":"user","content":"基线问题"}],
       "stream":false,"tools":[{"type":"doubao_app","feature":{"ai_search":{"type":"enabled"}}}]}'

# ③ embedding / 豆包搜索 searchSources / DeepSeek extraction
curl -s -X POST $B/gw/ark/embeddings/multimodal -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"model":"ep-xxxx","input":[{"type":"text","text":"知识片段"}]}'
curl -s -X POST $B/gw/doubao-search/search_api/web_search -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"Query":"竞品 品牌","Count":20,"SearchType":"web","NeedSummary":true}'
curl -s -X POST $B/gw/deepseek/chat/completions -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"材料"}],"stream":false}'

# ④ OSS putHtml（网关重签 + 内网直连；objectKey 需 URL 编码，与 sidecar encodeObjectKey 同口径）
curl -s -X PUT "$B/gw/oss/articles/2026/%E6%A0%87%E9%A2%98.html" \
  -H "authorization: Bearer $ACCESS" -H 'content-type: text/html; charset=utf-8' \
  --data-binary '<html><body>文章预览</body></html>'
# → {"url":"https://<OSS_PUBLIC_BASE_URL>/articles/2026/%E6%A0%87%E9%A2%98.html"}

# ⑤ 超级媒介资源读取（page/size 为仅有的业务参数；签名身份由网关生成）
curl -s "$B/gw/distribution/media/resource?page=1&size=20" -H "authorization: Bearer $ACCESS"
curl -s "$B/gw/distribution/we-media/resource?page=2&size=15" -H "authorization: Bearer $ACCESS"
```

## 数据表（迁移 `0001_accounts_sessions_ledger` + `0002_billing_permits` + `0003_ledger_entry_seq` + `0004_chat_usage_metering` + `0005_provider_usage_metering`）

- `accounts`：手机号唯一、scrypt 哈希、`password_version`（JWT `pv` 对账）、
  `status`（active/disabled）、`must_change_password`、`balance`（账面总余额，
  含冻结）。
- `auth_sessions`：一次登录一个会话；30 天滑动 `expires_at`；吊销留
  `revoked_reason`（logout / password_changed / refresh_reuse / admin_disabled）。
- `refresh_tokens`：哈希唯一、`consumed_at`/`replaced_by` 记录轮换链。
- `ledger_entries`：点数流水（`delta` + `balance_after` 成对出现），
  kind ∈ grant / topup / adjust / consume；建号 `grant` 是第一条，
  Σdelta 恒等于 `accounts.balance`。
- `billing_permits`：计费 permit（客户端幂等键为主键、操作类型、单位数、
  单价/基础费、`frozen_remaining` 剩余冻结、`status` open/settled）；
  open 计入账号并发准入（默认上限 2）。
- `permit_unit_reports`：逐单位回报审计（permit+unit 主键、success/failure、
  回报时间），失败/未回报单位的回补不改账面余额故不进 ledger。
- `accounts.chat_quota_used_milli`（0004）：本充值周期内的对话旁路计量累计
  （千分之一点）；topup 入账事务清零（任意档位充值刷新对话额度）。
- `chat_usage_records`（0004）：网关每次 `/v1/messages` 调用的真实 token 用量
  （input/cache read/cache creation/output）与折点（`points_milli`），供运营
  与 DeepSeek 账单对账；免费对话无余额变动，不进 `ledger_entries`，账本
  Σdelta == balance 口径不被污染。
- `provider_usage_records`（0005）：网关代理的每次 Provider 请求（上游 2xx）
  一行——`provider`（deepseek/ark/doubao-search/oss/distribution）、`route`
  稳定路由标签、token 用量（LLM；OSS/超级媒介记次数）。只作运营与上游账单
  对账，不是余额变动，不进 `ledger_entries`；表中不含上游密钥、请求体或
  账号 token。

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
