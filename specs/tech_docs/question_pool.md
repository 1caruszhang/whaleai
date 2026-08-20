# 关键词 / 问题池不变量

## Owner 与身份

- Node `QuestionPoolService` 拥有挖词、生成与评分的业务编排，只使用 Ticket 05 的 `keyword-search` / `generation` / `embedding` typed ports。
- Rust `BrandWorkspaceStore` 拥有知识快照读取、pool / attempt / checkpoint / decision 持久化与 CAS。它们和 Ticket 06/07 的品牌状态位于同一 `project.sqlite`，不形成第二套品牌权威。
- Renderer 只是当前 Tab/Session 的投影；所有请求经 `useTabApi().apiPost`，必须同时携带 `workspaceId` 与已固化的 `sessionId`。
- pool identity 是 `knowledge_version + product_line + target_region + generation_parameters`。只有全部相同的 awaiting-selection / confirmed pool 可复用。

## 生成与评分

1. `keyword-search` 返回 core / scene / longtail 分类。地域提示要求目标城市及 3–5 个直属下级地域；解析后用品牌精确标识做确定性过滤。过滤后为空必须失败为 `question_pool_empty_keywords`。
2. `question-generation` 只从过滤后关键词生成问题；每个候选必须至少有一个 `sourceKeywords` 与当前真实挖掘词精确匹配。缺失或全部无效的候选直接剔除，不允许用其他关键词回填来源。
3. `embedding` 为问题、当前知识上下文与最近一批已选问题生成向量。PRED-1 的可追溯记录为：

```text
relevance             = round(clamp(max(0, cos(question, knowledge)) * 100, 0, 100))
recentPoolSimilarity  = round(clamp(max cos(question, recent selected), -1, 1) * 100)
optimizationPotential = round(clamp((1 - max cos(question, recent selected)) * 50, 0, 100))
priorityTotal         = relevance + optimizationPotential
high                  = priorityTotal >= 150
medium                = 100 <= priorityTotal < 150
low                   = priorityTotal < 100
```

当没有最近选中池时，nearest cosine 按 `0` 计，因此 `recentPoolSimilarity = 0` 且 `optimizationPotential = 50`。每题持久化三个原始分量、sum、阈值、formula 与 `policyVersion=xiaojing-content-prompt-v1`，修改阈值必须升级 policy version。

embedding 失败语义（折中降级，用户裁决）：Provider 侧只对瞬时失败（网络错误/超时、408、429、5xx，由 `isTransientGeoUpstreamFailure` 判定）退避重试，配置类失败（其余 4xx、能力未配置）立即失败；非 2xx 响应的错误体（方舟 `{error:{code,message}}` / 网关 `{error,message}` 信封）脱敏后透出，配置类失败文案附可操作指向（如 `XIAOJING_ARK_EMBEDDING_ENDPOINT_ID` / 网关侧模型兜底配置）。瞬时失败在业务层回落确定性 FNV-1a 词频降级向量（`embedding-fallback.ts`，维度与 Provider 一致）让流程继续，可观测性为硬要求：WARN 日志 + 每题 `score.formula` 追加 `; degraded-embedding` 标记（复用既有字段，先例：`user-added; not scored`）+ embedding checkpoint output 携带 `degraded: true`。配置类失败不走降级，显式失败并终止工具。

## 提示词形态（ADR-0006，修正四声明范围 = 锚 + 上限）

- 挖词与问题生成两段 prompt 按 js_ai 不变量清单承载（第一人称陈述、三类递进、意图维度+反同质化、通顺最高原则、推荐尾巴禁令、每词至少 1 条、recommended 2–3 个）。清单唯一真源见 `content_prompt_invariants.md`。
- 调用形态：两段都带 system persona（搜索词研究专家 / GEO 用户意图研究员）与 `maxTokens=4096`；`keywordSearch.search` 接口可选传 `system` 与 `maxTokens`。
- 画像注入：挖词注入 `renderMiningProfileBlock`（products/coreAdvantages 主参考、customerCases 辅参考），问题生成注入 `renderFullProfileBlock`（全档案中文标签块），由 `projectBrandProfile` 从知识快照事实按 `brand.<field>` 谓词投影。
- 地域锚（修正四）：`deriveServiceScope` 以**用户声明的服务范围为主锚与白名单上限**（粒度保留——声明「新都区」就是新都区，不升格为成都市；多段声明全入白名单、首段为主锚）；地址仅在声明不可用时兜底提取城市短名；「全国/线上/不限」类声明直接进无地缘模式（不落地址兜底）。有锚时挖词 prompt 写明地域白名单与越界禁令，城市级锚 scene 以城市为根裂变、区县级锚不向下裂变到街道乡镇；问题生成补地域不越界硬约束。上限 enforcement 只在提示词层（用户裁定），解析层不加地域门。解析防线：词内禁标点、长度 ≤30、与已入库词去重。
- 品牌词（修正三）：品牌相关词至多 1 条、须联网验证有真实搜索量；解析层确定性截断，竞品名永禁。
- 数量指引与配额：挖词 core 4–6 / scene 8–12 / longtail 12–18；问题生成在词多于配额时优先覆盖高热度与意图多样的词，不逐词平铺。
- 词库沉淀（修正三）：`brand_keyword_library` 表（`UNIQUE(workspace_id, term)`、池型合并只增不清）；`prepare` 上下文返回词库并注入挖词 prompt 做增量挖新；`decide_question_pool` 确认事务内把本批合法词写入库。

## Checkpoint、取消与确认

- 阶段固定为 `keyword-search -> question-generation -> embedding -> persist`，不是可扩展的通用工作流。
- `idempotency_key` 定位 attempt；`attempt_id + stage` 定位 checkpoint；`attempt_id:stage` 是稳定 billing key。每次 claim 记录 input hash、attempt number 与一次性 claim token，finish 使用 token CAS。
- completed checkpoint 必须返回缓存输出，不重复调用 Provider；重试只重新 claim 当前 failed stage，已成功的付费阶段不重复计费。
- 取消同时 abort 当前 Provider signal 并把 attempt/checkpoint 标记为 cancelled。
- 用户勾选的结果以 `confirm-selection` decision 附加写入，并用 expected revision CAS。已有 decision 的 pool 不可再 persist 或覆写。Sidecar 只投送带固定 tag 的隐藏结构化 event，不生成可见 user message。

## 聊天修订（票 38，ADR 0003）

- 待决（awaiting-selection）池的搜索词与候选问题可经通用闸门修订工具 `revise_gate_content`（gate=`question-pool`，`subject='keyword'` 指词、缺省指问题）改/删/增：`QuestionPoolService.revise` 只读最新待决池，数组策略在 `applyQuestionPoolRevision` 纯函数中执行（文本 1–500、去重、问题 1–50 条、上限内新增），Rust `/api/brand-question-pools/revise` 做形状校验、身份/状态/CAS 栅栏并逐条写 `geo_question_pool_revisions` 审计（before/after 全量数组 + 用户指令原文）。
- 用户补充的问题无模型评分：中性占位分（全 0、低优先级、formula=`user-added; not scored`）+ `user-added` 证据；补充的词默认 `longtail`/`medium`，id 续 `kw-user-*`/`q-user-*`。
- 修订不改 pool 状态、不产生 decision、不投送 reminder；确认卡（`QuestionPoolGateCard`）待决期间每 3s 轮询 `/question-pools/latest`，按问题文本指纹做服务端胜合并（被改行采信服务端、未改行保留本地勾选），确认用最新 revision CAS。

## 测试边界

Provider 单测必须使用 fake/stub，不访问网络、凭据或付费端点。Rust 测试覆盖 identity/reuse/version/CAS 与修订审计；Node 测试覆盖 typed-port 编排、阶段重试与 revise 策略；DOM 测试覆盖真实工作台入口、结构化增删改选与轮询服务端胜。
