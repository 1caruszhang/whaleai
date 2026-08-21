# System Prompt Architecture

小鲸同学只有一条主聊天 Agent prompt 路径。

`src/server/system-prompt.ts::buildSystemPrompt()` 组装产品身份、GEO 意图决策表、知识 authority 和人工确认边界。`agent-session.ts` 把它作为 SDK `systemPrompt`，同时固定模型、effort、builtin tool allowlist、`xiaojing-geo` server 与 `canUseTool` gate。

意图决策表与 `src/shared/geo/operation.ts::classifyGeoIntent` 保持一致：用户点名具体环节用对应直接意图；表达 GEO 目标但未点名环节默认 `full-optimization`。创建操作后，完整阶段与步骤计划由聊天里的进度卡片播报并停在首个确认门，不就范围做开放式提问；`goal` 只用简短目标短语（如「一轮完整的 GEO 优化」），正文不复述阶段链条，只说明当前停靠的确认门。每个有后果的步骤自带确认门，默认意图因此是安全的。

通信规则：默认用陈述句告知（notify），只有真正阻塞且无安全默认时才经 `AskUserQuestion` 工具提问，一次回复最多一个问题、2 到 4 个选项、推荐项放第一个。该规则与 `XIAOJING_SESSION_FILES` 提醒的附件处置措辞一致，两处必须同步修改。

SDK `settingSources` 为空，因此不会从用户级或 workspace 配置自动扩展产品能力。Prompt 不是权限边界；tool allowlist、Rust admission 和 BrandWorkspace revision checks 必须独立拒绝越权。

主聊天是唯一 Agent 发起入口。结构化卡片只提交用户决策或确定性 action，不能组装第二套 prompt 或启动另一个 Agent。排行榜生成返回已确认竞品不足 5 家时有一个窄例外：Agent 留在当前聊天说明缺口；Session Sidecar 同时绑定原文章请求与签发时用户消息。用户随后明确说出或确认名称后，`confirm_ranking_competitors` 逐字核对最新持久化用户消息，再把原话作为 `asked/user-stated` 审计，经同一 KnowledgeAuthority 提议并立即采纳；补足后工具直接恢复原文章请求。该入口不得接收模型推断、联网发现或仅被提到的名称。

系统文本不得包含 Provider secret、内部端口、用户正文或本地绝对路径。修改 prompt 时同步更新对应 unit test，并验证不扩大工具集合。

价格表述是硬规则：费用、预算、报价一律用「点」，agent 只能引用工具结果中已有的点数字段（budgetPoints、estimatedPricePoints、totalPricePoints、pricePoints）原值复述，不得出现人民币金额、不得换算、不得解释点数与人民币的关系或任何定价规则；换算倍率只存在于服务端/卡片代码，不进入模型可见数据（分发计划工具结果只携带点数字段，见 `distribution_planning.md`）。
