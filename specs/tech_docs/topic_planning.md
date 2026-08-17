# 主题、类型与标题计划不变量

## Owner 与固定输入

- Node `TopicPlanService` 是语义聚类、主题命名、五类推荐、标题生成与 Embedding 去重的业务编排 owner。它只消费 Ticket 05 的 `generation` / `embedding` typed ports，不读取凭据或建立新的模型抽象。
- Rust `BrandWorkspaceStore` 是 confirmed question-pool snapshot、immutable knowledge snapshot、topic-plan artifact、revision CAS、变更审计与确认决策的 owner；数据继续写入同一品牌 `project.sqlite`。
- Renderer 只投影当前 Tab/Session 的计划。读取和所有写入都经 `useTabApi().apiPost`，同时携带固化的 `workspaceId / sessionId`；增删编辑、局部重生成和确认还必须携带 exact `planId / expectedRevision`。
- plan 固定绑定 `questionPoolId + questionPoolRevision + knowledgeVersion + policyVersion`。确认前若问题池 revision 或当前知识版本变化，计划不能继续确认，必须基于新快照重新规划。

## Provider 编排

1. `embedding` 对已确认问题生成真实向量并形成确定性近邻证据；generation LLM 结合原文、搜索意图和近邻证据完成语义分组与主题命名。每个 question ID 必须且只能进入一个主题，遗漏、重复或未知 ID 都失败。
2. generation LLM 为每主题推荐 1–5 个 `guide / showcase / ranking / news / news_light` 类型并逐项解释。共享 pure policy 沿 js_ai `dev` 补齐整批五类覆盖下限：主题少于 5 时每类至少 1 项，至少 5 个主题时每类至少 2 项。
3. topic 与固定 knowledge snapshot facts 再经 Embedding 相似度选择 planned facts。持久化 owner 会逐项核对 `factKey / predicate / normalizedValueJson`，不接受模型生成或 UI 伪造的事实。
4. 标题按每批最多 3 项调用 generation port 的 `title-planning` purpose。每项返回 3–5 个候选和对问题覆盖、搜索意图、差异化、品牌适配、中国市场表达的解释；showcase 必须包含已确认目标品牌，ranking 不含目标品牌且包含当前年份，并统一执行地域、行业、长度、竞品和禁词约束。
5. 所有候选与现有受保护标题使用真实 Embedding 去重，阈值 `0.92`。provider snapshot 固化默认 generation pro、标题 mini 与 Embedding family/dimensions；model attempts 逐阶段追加。

任何 Provider 不可用、Embedding 数量不符、模型 JSON 解析失败、结构覆盖不全、候选不足或全部语义重复都显式失败。生产路径不允许调用 js_ai 的 `generateMockTitles`、字符串拼接主题、模板标题、随机数或伪造去重分；测试使用无网络的 deterministic mock Provider。

## 编辑、局部重生成与确认

- 用户新增项只能复用当前 plan 已固定的 topic、source questions 和 knowledge facts；material edit 将该项标为 `userEdited`，并把已有 approval 重置为 draft。用户手工标题明确记录为未重新评估的 user override，不伪造 Embedding 分数。
- 删除是同一 items projection 上的 `user-edit` mutation，不提供绕开 revision 的独立删除入口。所有 mutation 先由 Node 读取 exact plan，再由 Rust 在事务内核对请求来自该 BrandWorkspace 的已提交 Session、expected revision 和 awaiting-confirmation 状态。`createdBySessionId` 只记录 provenance；计划是 BrandWorkspace 共享 artifact，不以创建 Session 做访问隔离。
- 局部重生成的 target IDs 必须属于 exact plan。`userEdited` 或 `approved` target 原样保留并写入 `preservedItemIds`；只有未受保护 target 会产生新的 title-planning 与 Embedding attempt。Rust 再比较旧/新 JSON，防止绕过 Node 覆盖受保护项。
- explicit confirm 只接受已 approved 的 selected IDs，数量为 1–20；确认决策 append-only，plan revision 增 1 并变为 immutable `confirmed`。只有 confirmation 中的 selected IDs 是后续内容生产的权威输入；本 Ticket 不生成正文。
- 聊天修订（票 38，ADR 0003）：待确认（awaiting-confirmation）计划的选题条目可经通用闸门修订工具 `revise_gate_content`（gate=`topic-plan`）改/删/增——handler 复用 `saveItems` 的 `user-edit` mutation（`applyTopicPlanUserEdits` 钳制、Rust fact-key 核对），`mutate` 携带 `reason`（用户指令原文）落 `geo_topic_plan_mutations.reason` 审计列。confirmed 计划在 handler 层按 `target_not_pending` 拒绝；确认卡（`TopicPlanGateCard`）待决期间每 3s 轮询 `/topic-plans/latest`，按条目内容指纹服务端胜合并。

## 确定性验证

- shared unit：严格解析、五类覆盖、标题规则、Embedding 去重、protected merge。
- Node unit：typed-port 编排、固定 snapshot/model attempts、Provider fail-closed、exact-plan CAS、局部保护与 explicit confirmation。
- Rust unit：source snapshot、fact-key authority、revision/identity/confirmed immutable、保护项二次校验。
- DOM/client unit：当前 Tab 控制面、结构化增删改批、局部重生成保护、显式错误与确认门；默认测试无网络、无凭据、无扣费。
- 工具分发缝（`gate-revision.unit.test.ts`）：选题修订操作映射、逐条回执、confirmed/缺失目标的越权拒绝。
