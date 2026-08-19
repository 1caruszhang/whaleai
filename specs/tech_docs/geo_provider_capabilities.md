# 小鲸 GEO Provider 能力槽位

本文定义 Ticket 05 建立的固定服务能力面。领域 owner 与进程边界以
`specs/ARCHITECTURE.md` 为准；模型、端点和结构化参数的机器可读权威是
`src/shared/geo/providerCapabilities.ts`。该目录交叉核验自 js_ai `dev`
提交 `936b971751f029e9d67fc86356e8234569e33570` 的普通源码、测试与
`specs/research/js_ai-geo-pipeline-survey.md`。

## Owner 与边界

- 票 06（commercial-beta）起客户端不再管理 Provider 凭据：原设置页、八个凭据命令、CredMan 写入与 Sidecar 凭据注入均已移除，`deepseek_credentials.rs` 删除。票 08 闭环后确定性 PublishScheduler 的上传/下单、票 14 后发布后监测查单全部经 Sidecar 网关 port（`publish-egress.ts` 分类三态、`/api/xiaojing/publish-scheduler/egress/*` 与 `/api/xiaojing/post-publish-monitor/order-query` 路由，sn 均按 `distributionOrderSn(executionId, itemId)` 派生），`geo_provider_credentials.rs` 的直连超级媒介凭据读取与 HMAC-SHA256 签名 helper 已随之整体移除——该模块现只承载子进程环境清洗名单（`SIDECAR_ENV_NAMES` / `DEVELOPMENT_SOURCE_ENV_NAMES`）与 `account_auth` 复用的网关地址覆盖校验。账号登录态（登录 token 存 OS 凭据库、7 天断网宽限、renderer 只拿无 token 投影）由 `src-tauri/src/account_auth.rs` 拥有；Sidecar admission 现在注入 `XIAOJING_GATEWAY_BASE_URL` + `XIAOJING_ACCOUNT_ACCESS_TOKEN`（网关流量消费在票 07 接线），旧 `XIAOJING_*` 凭据传输名在所有生成路径无条件清除。
- 凭据不是 `BrandWorkspace` 数据。品牌知识、产物、订单与观测仍显式绑定各自 workspace；能力复用不允许引入进程级 Active Project。
- Rust 只在已确认的品牌 Session Sidecar 出生时通过一次性 `XIAOJING_*` 环境传输注入服务配置。Node `provider-runtime.ts` 在组合 `xiaojing-geo` MCP 时立即捕获并删除传输变量；Renderer、config、品牌数据库、Session transcript 与工具结果都拿不到明文。
- Provider 端点覆盖走同一 admission 传输（`XIAOJING_ARK_PAYGO_BASE_URL`、`XIAOJING_DOUBAO_SEARCH_BASE_URL`、`XIAOJING_DEEPSEEK_OPENAI_BASE_URL`，主 Agent SDK 根为 `XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL`）：未注入时逐字节回落 `providerCapabilities.ts` 固定默认值，注入时只替换 host 根、路径与 wire shape 不变，业务层零感知。这些变量非密钥但同样在 Sidecar 出生时捕获删除；Rust 在所有生成路径无条件清除（含非品牌 Sidecar），release 构建不从环境注入端点——伪造父环境不能把带凭据的流量重定向到任意地址。
- Node GEO 业务只能依赖 `provider-capabilities.ts` 的 `GeoTextCapability`、`GeoKeywordSearchCapability`、`GeoEmbeddingCapability`、`GeoObjectStorageCapability`、`GeoDistributionCapability`。业务步骤不得读取 `process.env`、Rust credential DTO 或通用 Provider DTO。
- `GeoDistributionCapability` 开放资源池读取与网关订单面（下单/查单/催稿/取消/退款/补发，票 08 起仅网关模式）；订单提交只能由 `PublishScheduler`（用户确认后）与发布后监测查单（只读）经 Sidecar 网关路由触达，不能通过模型能力口绕过。

## 固定槽位与路由

| 槽位             | 路由                                                                | 关键语义                                                                                             |
| ---------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `main-agent`     | DeepSeek `deepseek-v4-pro`，官方 Anthropic endpoint                 | high reasoning；沿 Ticket 04 Agent loop                                                              |
| `extraction`     | DeepSeek `deepseek-chat`，Chat Completions                          | 非推理抽取，避免多字段 JSON 被长思考饿死                                                             |
| `keyword-search` | ARK paygo `/api/v3/chat/completions`，`doubao-seed-2-0-lite-260428` | body `enable_search:true`；Agent Plan endpoint 不得替代                                              |
| `generation`     | ARK paygo `/api/v3/chat/completions`                                | 默认 `doubao-seed-2-0-pro-260215`；标题规划 purpose 固定 `doubao-seed-2-0-lite-260428`（mini 变体未在 paygo 开通，`/chat/completions` 404），不增加第九槽位 |
| `reflection`     | DeepSeek `deepseek-v4-pro`，Chat Completions                        | 高推理审校；纯规则风控仍先执行                                                                       |
| `embedding`      | ARK `/api/v3/embeddings/multimodal`，用户接入点 ID                  | `input:[{type:'text',text}]`；一次一段文本、单融合向量、2048 维、并发 2、额外重试 2 次（500/1000ms） |
| `object-storage` | 阿里云 OSS virtual-hosted URL                                       | HTML `PUT`，OSS V1 HMAC-SHA1；正文不进入 Agent prompt                                                |
| `distribution`   | `https://vip.chaojimeijie.com/api`                                  | GET query / POST form 参数先按原值 HMAC-SHA256；资源缓存语义 30 分钟                                 |

`extraction` 槽位的首个业务消费者是 `src/server/geo/material-import.ts::MaterialImportService`。它只接收 Rust 已保存并按 material ID 返回的有界内容；抽取响应经过 Profile 字段/provenance/scope 校验后统一进入 `KnowledgeAuthority`。该步骤不得自行读取本机路径、写 authority 或记录 prompt/response。完整边界见 `material_import.md`。

豆包 Responses `doubao_app` 与独立 `open.feedcoopapi.com` 搜索仍是 js_ai 已验证的后续召回语义，但不与当前“关键词搜索”槽位混写：当前槽位严格对应关键词挖掘的 paygo Chat + `enable_search`。后续实现被动召回时，应在同一 typed search port 下扩展显式操作，而不是建立通用 Provider 市场。

Ticket 09 已在同一个 `keyword-search` typed port 上增加显式 `probeQuestion` 操作：固定使用 ARK Responses `/responses` 与 `doubao_app.ai_search`，逐个已确认问题保存回答和结构化引用。该操作与关键词挖掘的 Chat + `enable_search` wire shape 分开，仍共享同一 ARK 应用级凭据 owner；其非 secret model/mode/endpoint-family snapshot 由 baseline 持久化，密钥和 Authorization 永不进入 snapshot 或品牌库。

竞品富化又在该 typed port 上增加显式可选操作 `searchSources`：默认直连豆包搜索 HTTP API `https://open.feedcoopapi.com/search_api/web_search`（`{Query, Count, SearchType:'web', NeedSummary:true}`，默认 Count 20），返回结构化 `title/url/summary` 逐条召回（按 URL 去重，Title 缺失回退 SiteName/URL），不经 LLM 改写——js_ai `doubaoSearchProbe` 契约。该 URL 不是硬编码：默认值钉在 `providerCapabilities.ts` 目录（keyword-search 槽位 `searchSourcesEndpoint` 语义），可被 admission 注入的 `XIAOJING_DOUBAO_SEARCH_BASE_URL` 覆盖，且与 `search`/`probeQuestion` 一样进入 Rust permit 通道（unitKind `search-sources`），不留计量缺口。Bearer 解析链：专用豆包搜索 key（Ark 服务可选字段 `doubaoSearchApiKey`，联网搜索控制台签发、月度免费额度；Rust admission 注入 `XIAOJING_DOUBAO_SEARCH_API_KEY`，dev `.env` 源 `DOUBAO_SEARCH_API_KEY`，设置页 ark 槽位可选字段）→ 复用 `arkApiKey`（volcengine 主 key / Agent Plan key 兼容豆包搜索计费面）。key 不被接受或能力未注入时，调用方（材料导入竞品腿）回落 `search()` 的 `enable_search` 生成语料，回落时记固定码降级日志（`competitor-search / degraded / doubao_search_unavailable`，合法零结果不记）。问题池的关键词挖掘继续走 `search()` 不变。

Ticket 10 的标题规划继续使用 `generation` port，但通过显式 `purpose: title-planning` 选择 js_ai `dev` 固定的 mini 模型（小鲸同学 落地为 lite），调用带 system persona 与 `maxTokens=2048`（ADR-0006 调用形态统一）；聚类与类型推荐仍使用 generation 默认 pro 模型（`maxTokens=4096`）。Topic plan 同时保存这两个非 secret model snapshot 与逐阶段 attempt。任何模型不可用、响应解析失败、标题约束不足或 Embedding 去重失败都显式失败，不能调用 js_ai 的 `generateMockTitles` 或模板 fallback 生成生产计划。

Ticket 05 的 `keywordSearch.search` 接口按 ADR-0006 扩展可选 `system` 与 `maxTokens` 参数：挖词调用传「搜索词研究专家」persona 与 `maxTokens=4096`，消息体在传 system 时变为 system+user 双消息；缺省时保持单 user 消息（竞品富化回落等旧调用不受影响）。

Ticket 11 的正文使用 `generation` 默认 pro 模型并显式保留 js_ai 参数 `max_tokens=8192 / temperature=0.85 / top_p=0.9`；审校使用 `reflection` DeepSeek pro。Provider 响应不直接拥有批准权：确定性事实、广告法、占位符和可引用结构检查先执行，再与严格 reflection JSON 合并。任一 Provider 缺失、解析失败或硬门失败均显式阻断，不能返回模板、mock 或随机正文。正文和 review response 不记录到 Provider 状态、日志或 Session transcript。

Ticket 12 的渠道发现只使用 `distribution` port 分页读取媒体与自媒体资源。Node 按 kind 保存 30 分钟非 secret snapshot cache，并合并同 kind 并发读取；Sidecar generation 替换后不复用旧缓存。资源目录不可用时只保存明确 unavailable 状态和空候选，不回退到 demo、随机或 LLM 伪造资源。候选的 name/price/rate/status 均以 typed resource snapshot 为准；本阶段没有超级媒介下单调用，credentialed smoke 也不得提交订单。

## 配置与状态

票 06 起设置页与凭据配置面已移除；能力可用性不再有客户端配置状态展示，计费/准入状态由账号网关（票 03/04/05）持有。历史版本的状态词表（`unconfigured / verifying / available / rate_limited / failed`）与「错误文本只包含服务、HTTP 状态和可操作提示」的脱敏规则继续约束任何新的服务状态展示。

开发环境的 `.env` 兼容变量：

- 票 06 起 `DEEPSEEK_API_KEY` 及其端点覆盖不再读取（主 Agent 流量票 07 切网关）；新增 `GATEWAY_BASE_URL`（账号网关根地址，本地联调指向 backend/，见 `.env.example`）
- `ARK_API_KEY`，以及可选端点覆盖 `ARK_PAYGO_BASE_URL`（Paygo Chat/Responses/Embedding 统一根）与 `DOUBAO_SEARCH_BASE_URL`（searchSources 结构化召回根）
- `ARK_EMBEDDING_API_KEY`（可选，缺失时复用 ARK）与 `ARK_EMBEDDING_MODEL`
- `ALI_OSS_ACCESS_KEY_ID`、`ALI_OSS_ACCESS_KEY_SECRET`、`ALI_OSS_BUCKET`、`ALI_OSS_REGION`、`ALI_OSS_PUBLIC_BASE_URL`
- `CHAOJIMEIJIE_APPID`、`CHAOJIMEIJIE_SECRET`、`CHAOJIMEIJIE_API_BASE_URL`

端点覆盖值必须是绝对 http(s) URL（开发构建允许 `http://` 便于本地网关冒烟）；留空时全部回落官方默认地址。

`.env.example` 的所有值必须为空。release 构建不从环境降级读取服务密钥。

## 测试分层

- catalog、wire shape、单文本 Embedding、并发/重试、错误脱敏与 Renderer 状态使用默认 unit/dom 测试，统一受 no-egress setup 保护。
- Rust 测试只验证字段白名单、脱敏状态 DTO 和 HTTP 状态分类，不发真实请求。
- `provider-capabilities.credentialed.test.ts` 仅属于 credentialed project，并额外要求 `RUN_XIAOJING_PROVIDER_SMOKE=1` 与对应显式凭据。默认 `npm test`、CI 和本 Ticket 验证都不得运行它。
- Object Storage credentialed smoke 不执行 PUT；签名 wire shape由确定性测试覆盖，连接页使用只读 bucket 请求。
