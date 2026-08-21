# GEO 渠道发现与分发计划

Ticket 12 只创建可编辑、可确认的推荐与文章分配计划。它不创建订单、不扣费、不上传正文、不发布，也不创建 `PublishScheduler` wake。后续付费和发布只能消费已确认计划，并再次经过独立显式确认。

## Owner 与数据流

- Renderer 是当前 Chat Tab 的控制面。它经 `useTabApi().apiPost` 展示 Rust 派生的上下文、真实资源候选、证据与召回路命中；不直接请求 Provider 或 Management API。
- Node `DistributionPlanningService` 拥有 js_ai `dev` 四路召回、硬过滤、20/10 配额、文章映射和 30 分钟只读资源缓存。相同资源 kind 的并发加载合并为一次请求；Sidecar generation 更换时缓存自然销毁。
- Rust `BrandWorkspaceStore` 拥有 plan artifact、provider/resource/evidence snapshot、revision CAS、claim token、audit 和最终确认门。artifact 可由同一 BrandWorkspace 的其他已提交 Session 按 exact plan id 读取；创建 Session 只作 provenance。
- 超级媒介 capability 在本阶段仅允许分页读取资源池。Provider 不可用时 plan 明确进入 `unavailable`，候选为空；严禁生成 demo、随机或模板候选。

## Authority snapshot

开始计划时，Rust 重新派生并核对以下事实，不能信任 Renderer 传入的同名字段：

- industry 与 derived keywords 来自文章 operation 固定 knowledge version 的 `knowledge_version_facts`；
- articles 来自 exact article operation 的 approved revision；
- questions 来自已确认问题池的选中问题（confirmed-topic-plan 计划用其绑定的 `(pool_id, revision)`，direct 文章用同知识版本最新 confirmed 池）——被动路探测的输入；confirmed-topic-plan 文章通过 `source_plan_item_id` 与 plan item 的 `sourceQuestionIds` 精确映射到问题；direct 文章无可信映射时 `articleIds` 为空；
- question sources（被动证据）由 Node 在计划 start 时**对问题池逐问现场探测**产出（keyword-search typed port 的 `probeQuestion`：ARK Responses + `doubao_app.ai_search`，2-wide 窗口限流、逐问隔离失败）；prepare 校验 question id/question text 必须命中已确认池、URL 合法、id 唯一，`articleIds` 按权威映射重盖。**不依赖基线快照**（对齐 js_ai，2026-08-18 用户裁决）。
- 单篇与单次点数上限由 Rust 在 prepare 时直接读取本机 `config.json` 的 `distributionSpendLimits` 并冻结；Sidecar 请求中的同名值只可用于预估预算，不能成为或放宽计划事实。

prepare 后所有上述输入、Provider 非 secret 状态、候选资源白名单字段与四路证据都固定进 plan。start、edit、confirm 完成后均按 exact plan id 读回，不以 `latest` 猜测刚创建或刚修改的对象。

## 四路召回（对齐 js_ai ADR-0026/0031，2026-08-18 用户裁决完全对齐）

| 路              | 权重 | 证据来源                                                                                                                                                                                         | 实现                                                       |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| 被动 passive    | 0.4  | 已确认问题逐问豆包探测的引用（域名/名称对齐资源池）                                                                                                                                              | `probeQuestion` 现场探测，2 QPS 双槽窗口；失败只降级不阻断 |
| 主动 active     | 0.2  | 全局单次召回（ADR-0031）：全部已批准文章 topics+行业+衍生关键词一次联网调用，产出 20–30 个真实渠道（注册域名门+反幻觉约束+topicNumbers→文章映射）                                                | `keywordSearch.search`（doubao-lite + enable_search）      |
| 保底 fallback   | 0.1  | 规则匹配：超级媒介结构化类目/目标人群命中（GEO 收录信号并入同一路说明）                                                                                                                          | 纯规则，无模型                                             |
| 偏好 preference | 0.3  | 人工策展：内置 exact 名单（js_ai DEFAULT_PREFERENCE_CHANNELS 十项，逐条一致）+ 品牌库 overlay（增补 `additional`/排除 `excluded`，`geo_channel_preferences` 单例表，management `/preferences/get | set`）                                                     | 域名优先；exact=精确名（全半角括号归一），用户条目=严格→模糊 |

匹配器与名单合成逻辑在 `src/shared/geo/channelRecall.ts`（js_ai sourceAlignment/preferenceChannels/globalRecall 的忠实移植：`strictMatchScore`、`fuzzyMatchScore`（品牌域名表+子串+去后缀+Jaccard）、`resolvePreferenceChannels`、`buildGlobalRecallPrompt`/`parseGlobalRecallResult`/`clampTopicNumbers`）。

## 推荐、过滤与不确定性

四路权重固定为 passive `0.4`、active `0.2`、fallback `0.1`、preference `0.3`，同一资源只累加不同路径。资源必须先满足超级媒介 `status=2`；数值价格先按统一公式换算为点数（`价格 × 1.6 × 10`，以分为基向上取整），超过用户“每篇文章最高点数”的资源在对齐与配额前硬过滤。该设置默认 `3000` 点；“每次分发最高点数”默认 `20000` 点。两项由左下角「个人信息」维护，并在新建计划时冻结，后续修改不反写已有计划。自动分配按候选顺序逐篇选择未使用且可纳入剩余总点数的渠道；昂贵候选放不下时继续尝试下一候选。价格未知无法证明在单篇上限内，因此不返回、不自动分配；旧计划若已有未知价渠道，确认门仍会阻断。计划预算可以低于用户总上限，但不能放宽该硬上限；确认与发布预览都会重新校验单篇和总点数。**发布率不是决策输入（用户裁决 2026-08-18）**：不设最低发布率门槛，发布率 `0`/null/未知既不过滤、不进不确定性、不阻断确认，也不在候选行展示；调度器消费已确认计划时快照缺失记 `0`，不因发布率报 `publish_channel_rate_unknown`。**被动证据为空不阻断**（对齐 js_ai：探测失败只是没有被动路，`question-source-evidence-missing` 阻断码已删除）。

候选的 name、price 和 availability 只能来自 typed Provider resource snapshot。候选展示来源证据、召回路命中（被动/主动/保底/偏好，含各路证据说明）、适配理由、价格与权重；不再逐条展示风险行（用户裁决 2026-08-18），价格未知仍由行内「未知」标记与确认阻断码呈现。空并集保持空，不移植 `random_balanced`。Rust finish/confirm 门的证据校验按四路新契约：passive 的 reference=questionId 且 URL 必须命中来源、articleIds 等于来源并集；active 的 `recall:` 前缀；fallback 的 `industry:`/`audience:`；preference 的 `preference:` 前缀。

一篇文章只分配一个渠道且渠道不能复用。计划支持 1:1 或媒体/自媒体比例映射、渠道组合、预算和发布时间编辑。Rust 确认时重新计算选择、分配、价格/成功率、证据、预算和时间护栏；仅靠客户端清空 `blockingIssues` 不能越过确认门。

确认提交成功后，`distribution-plans/confirm` 路由在同一 Session 投递纯隐藏 `XIAOJING_DISTRIBUTION_PLAN_DECISION` reminder（只携带 plan/operation identity、revision、status 与 assignment 数），唤醒 agent 从权威计划继续进入发布准备，不重复询问已确认计划。提醒入队失败不回滚已提交的确认，响应显式返回 notification 状态。

`plan_distribution` 工具结果是聊天转录的一部分，只返回**卡片最小投影**（契约类型 `DistributionPlanCardProjection`，`shared/geo/distributionPlan.ts`：id/状态/预算/选择/阻断 + 候选的名称·报价·路径命中·适配·证据标签≤64 字；articles 只带 id、assignments 全量保留防轮询前确认）——约 13K 字符/6K tokens，完整权威投影由卡片 3s 轮询 `/distribution-plans/latest` 水合。转录里的费用字段一律是点数（`budgetPoints` / `estimatedPricePoints`，由服务端 `cnyToPoints` 算好）：CNY 金额与换算倍率不进聊天，agent 只能引用点数字段复述费用；预算入参同样只收点数（`budgetPoints`，服务端 `planDistributionBudgetCny` 换算，缺省使用当前“每次分发最高点数”），确认卡在轮询水合前提交时按 `pointsToCny` 把点数预算回算为内部 CNY（预算上限语义，任意点数精确往返）。

## 聊天修订（票 38，ADR 0003）

待确认（draft）计划的渠道选择与计划参数可经通用闸门修订工具 `revise_gate_content`（gate=`distribution-plan`）改/删/增：`subject='channel'` 的 add/delete 等价于选择/取消选择渠道（取消选择同时把对应分配置为 `unassigned`），`subject='assignment'` 修改逐篇分配（渠道必须已选择），缺省 `subject` 修改预算/发布开始时间——预算补丁只携带点数（`budgetPoints`，服务端按 `pointsToCny` 换算回内部 CNY，兼容旧转录的 `budgetCny`）。handler 复用既有 `DistributionPlanningService.edit`（白名单字段整组替换、`applyDistributionPlanEdit` 重算 blockingIssues），`edit` 携带 `reason`（用户指令原文）落 `geo_distribution_plan_audit.reason` 审计列。confirmed/discovering 计划分别按 `target_not_pending` 拒绝；确认卡（`DistributionGateCard`）待决期间每 3s 轮询 `/distribution-plans/latest`，服务端渠道选择变化时采信服务端（服务端胜），否则保留本地勾选。

## 测试边界

默认 unit/DOM/Rust tests 使用 mock capability 与临时 BrandWorkspace，不访问网络、凭据或真实用户目录。资源 TTL 通过注入 `now()` 确定性验证。credentialed smoke 不属于默认验收；即使显式运行，也只能读取资源目录，不能下单或发布。路由接缝回归（`src/server/__tests__/xiaojing-decision-receipt-gates.integration.test.ts`）断言确认后注入决策回执信封、响应携带 notification 状态、投递失败不影响决策成功。
