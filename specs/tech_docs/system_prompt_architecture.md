# System Prompt Architecture

小鲸同学只有一条主聊天 Agent prompt 路径。

`src/server/system-prompt.ts::buildSystemPrompt()` 组装产品身份、GEO 意图决策表、知识 authority 和人工确认边界。`agent-session.ts` 把它作为 SDK `systemPrompt`，同时固定模型、effort、builtin tool allowlist、`xiaojing-geo` server 与 `canUseTool` gate。

意图决策表与 `src/shared/geo/operation.ts::classifyGeoIntent` 保持一致：用户点名具体环节用对应直接意图；表达 GEO 目标但未点名环节默认 `full-optimization`。创建操作后，完整阶段与步骤计划由聊天里的进度卡片播报并停在首个确认门，不就范围做开放式提问；`goal` 只用简短目标短语（如「一轮完整的 GEO 优化」），正文不复述阶段链条，只说明当前停靠的确认门；`goal` 措辞必须与结构跨度一致（ADR-0011 Decision 5，票 #33）：起点为知识链路时不得写「从问题选择开始」类措辞，起止选择如实经 `startingPointReason`/`endingPhase` 进入认可门文案，goal、认可门 summary 与进度卡跨度标签三处叙事不得互相矛盾。每个有后果的步骤自带确认门，默认意图因此是安全的。

通信规则：默认用陈述句告知（notify），只有真正阻塞且无安全默认时才经 `AskUserQuestion` 工具提问，一次回复最多一个问题、2 到 4 个选项、推荐项放第一个。起点推导的带推荐询问是该条款的显式例外（geo-plan-normalization 票 06；票 11 起该询问只裁决起点）：它是创建或接管前的固定动作，不受「阻塞且无安全默认」门槛约束，也不得援引该例外为其他场合扩大提问面——例外化消除「默认告知」与「先问起点」两条规则的现场优先级排序。该规则与 `XIAOJING_SESSION_FILES` 提醒的附件处置措辞一致，两处必须同步修改。

新轮次入口的起点推导（ADR-0010 Decision 5 + 2026-09-02 票 10/票 11 修订）：用户表达 GEO 目标但未指明起点时按品牌状态查表三行——品牌全新直接按决策表创建全链；用户话语里已有更新品牌知识的意愿（点名更新、带来新材料、说明品牌信息变了）直接创建从知识更新开始的轮次；其余情况出一次两项选择卡：开新一轮（复用品牌知识与问题池，不更新知识，从问题池开始，推荐）与全量重来（从知识更新开始），语义模糊按无更新意愿处理。复用边界成文（票 11）：可复用的品牌资产只有知识与问题池，内容计划、文章、分发计划、发布都不跨轮复用（文章每轮重新生成）——「沿产物链派生入口」的派生席位整体废止；硬边界沿用票 10：起点推导不考虑、不提及任何其他会话的轮次（2026-09-02 实测：摘要携带 4 个未完成轮时选项取舍思考 17,742 字，信息撤出场才除病）。终点不问（票 11 撤销票 #34 的起止追问）：轮次默认做到发布完成，endingPhase 显式携带发布段，用户点名终点照带，监测段仅点名进入。选项到动作的映射在提示词与两个工具描述三方锁定（票 06 起源，票 10 修订）：起点选项一律走 `start_geo_operation` 创建（开新一轮首选显式带 `updateKnowledge=false`，首选非强制——票 02 归一保证两入口同形兜底，但答案不得省略）；继续之前的轮次是唯一例外，且只经点名续轮路径——用户明确要求续轮时 `inspect_geo_operations`（includeUnfinishedRounds 跨会话未完成轮查询）→ 查得轮次列一张选择卡（哪怕只有一轮，每项带目标/卡点/待审/所属或无主）→ 选定即整卡一次确认 → 单次 `takeover_geo_operation`；接管永不主动提供（不进推导卡、不进任何推荐）。推导结果经 `start_geo_operation` 的 `startingPointReason` 与 `endingPhase`/`endingPointReason` 进入计划认可门文案（「从哪里开始、到哪里结束、为什么」）；跨度只由 endingPhase 表达（跨度组合与校验语义见 `geo_operations.md`），不增删确认门、不移动门位置。一个轮次从起点到终点只用一个操作：终点之后的阶段不新起操作、轮内不重复征询「接下来做什么」，只有用户中途改主意才新开操作或点名续轮。接管被拒时把工具结果 hint 转述为可行动的下一步，不裸报错误。文章生成时选取与弃用的 prompt 指引（`itemIds` 子集、以已批准集合为事实依据、不替用户追问弃用原因）随 `article_generation.md` 的票 #34 行为演进同步维护。

SDK `settingSources` 为空，因此不会从用户级或 workspace 配置自动扩展产品能力。产品能力边界的静态说明（登记能力全部可用、范围外不得声称或代答）收敛在 prompt 身份段一次说清，`inspect_brand_context` 返回体不再逐次重复携带。Prompt 不是权限边界；tool allowlist、Rust admission 和 BrandWorkspace revision checks 必须独立拒绝越权。

主聊天是唯一 Agent 发起入口。结构化卡片只提交用户决策或确定性 action，不能组装第二套 prompt 或启动另一个 Agent。排行榜生成返回已确认竞品不足 5 家时有一个窄例外：Agent 留在当前聊天说明缺口；Session Sidecar 同时绑定原文章请求与签发时用户消息，该状态跨 Agent turn 与每轮 MCP server 重建存续，同请求重试不移动原签发边界。用户随后明确写出名称后，`confirm_ranking_competitors` 只传名称；服务端从 Gate 取主体、逐字核对最新持久化用户消息，再把该原话作为 `asked/user-stated` 审计，经同一 KnowledgeAuthority 提议并立即采纳；补足后工具直接恢复原文章请求。该入口不得接收模型推断、联网发现或仅被提到的名称。

系统文本不得包含 Provider secret、内部端口、用户正文或本地绝对路径。修改 prompt 时同步更新对应 unit test，并验证不扩大工具集合。

价格表述是硬规则：费用、预算、报价一律用「点」，agent 只能引用工具结果中已有的点数字段（budgetPoints、estimatedPricePoints、totalPricePoints、pricePoints）原值复述，不得出现人民币金额、不得换算、不得解释点数与人民币的关系或任何定价规则；换算倍率只存在于服务端/卡片代码，不进入模型可见数据（分发计划工具结果只携带点数字段，见 `distribution_planning.md`）。
