# 主题、类型与标题计划不变量

## Owner 与固定输入

- Node `TopicPlanService` 是语义聚类、主题命名、五类推荐、标题生成与 Embedding 去重的业务编排 owner。它只消费 Ticket 05 的 `generation` / `embedding` typed ports，不读取凭据或建立新的模型抽象。
- Rust `BrandWorkspaceStore` 是 confirmed question-pool snapshot、immutable knowledge snapshot、topic-plan artifact、revision CAS、变更审计与确认决策的 owner；数据继续写入同一品牌 `project.sqlite`。
- Renderer 只投影当前 Tab/Session 的计划。读取和所有写入都经 `useTabApi().apiPost`，同时携带固化的 `workspaceId / sessionId`；增删编辑、局部重生成和确认还必须携带 exact `planId / expectedRevision`。
- plan 固定绑定 `questionPoolId + questionPoolRevision + knowledgeVersion + policyVersion`。确认前若问题池 revision 或当前知识版本变化，计划不能继续确认，必须基于新快照重新规划。

## Provider 编排

1. `embedding` 对已确认问题生成真实向量并形成确定性近邻证据；generation LLM 结合原文、搜索意图和近邻证据完成语义分组与主题命名。每个 question ID 必须且只能进入一个主题，遗漏、重复或未知 ID 都失败。
2. generation LLM 为每主题推荐 1–5 个 `guide / showcase / ranking / news / news_light` 类型并逐项解释。共享 pure policy 补齐整批内容类型覆盖下限（用户裁决 2026-08-26）：guide 与 ranking 各至少 3 项、showcase/news/news_light 各至少 2 项，合计至少 12 篇；主题过少使「每主题最多五类」结构上限放不下时按最少类型数优先尽力补齐、不失败（如 2 个主题最多补到 10 篇）。
3. topic 与固定 knowledge snapshot facts 再经 Embedding 相似度选择一般 planned facts。内容类型硬事实不占语义 Top-5 名额：`ranking` 必须把该快照中的 `fullName / shortNames / relatedBrands / competitors` roster 输入钉回 item，防止竞品或排除依据因相似度排到第 6 名而消失。持久化 owner 会逐项核对 `factKey / predicate / normalizedValueJson`，不接受模型生成或 UI 伪造的事实。
4. 标题按每批最多 3 项调用 generation port 的 `title-planning` purpose（system persona + `maxTokens=2048`）。每项请求 3–5 个候选和对问题覆盖、搜索意图、差异化、品牌适配、中国市场表达的解释；showcase 必须包含已确认目标品牌，ranking 不含任何品牌名——目标品牌全称/简称、竞品与关联品牌（代理/经销、非竞品）都禁（用户裁决 2026-09-01）——且包含当前年份，并统一执行地域、行业、长度、竞品和禁词约束。锚源复合值（「医美/轻医美」）按分隔符静默拆 token：require 类规则（业务词/地域）OR 语义、forbid 类规则（竞品/品牌）逐 token 禁，服务端 WARN 留痕（复合写法说明知识登记口径有歧义）。标题候选走两轮策略（初试 + 带反馈修正重试，解析失败与校验失败共用一次重试；用户裁决 2026-09-01 少报错）：两轮中任一轮仍有 ≥1 条合格候选即按降级候选集放行（3 条下限不再杀整批，重试劣化时退回首轮幸存集），两轮幸存集都空的条目剔除（不进生成集、不记 modelAttempts，WARN 日志是可观测面），全部条目被剔除才显式失败并重抛末次拒因。标题 prompt 按 ADR-0006 重写：风格中文释义（`TITLE_STYLE_DEFINITIONS`）、占位符式 few-shot（【地域】【行业】【目标品牌】，忠实各类型品牌分布）、反抄录与口语化反堆砌条目；不变量清单见 `content_prompt_invariants.md`。
5. 所有候选与现有受保护标题使用真实 Embedding 去重，阈值 `0.92`；全部候选越阈时取相似度最低者并自证越阈（`evidence.maxSimilarity ≥ 阈值`），不再抛 `diversity_insufficient` 杀整批（用户裁决 2026-09-01）。provider snapshot 固化默认 generation pro、标题 mini 与 Embedding family/dimensions；model attempts 逐阶段追加（被剔除条目不记 title-generation attempt）。

embedding 失败语义（折中降级，用户裁决）：Provider 侧只对瞬时失败（网络错误/超时、408、429、5xx，由 `isTransientGeoUpstreamFailure` 判定）退避重试，配置类失败（其余 4xx、能力未配置）立即失败；非 2xx 响应的错误体脱敏后透出，配置类失败文案附可操作指向（如 `XIAOJING_ARK_EMBEDDING_ENDPOINT_ID` / 网关侧模型兜底配置）。瞬时失败在业务层回落确定性 FNV-1a 词频降级向量（`embedding-fallback.ts`）继续并打 WARN 日志——`TopicPlanModelAttempt` 结构无降级字段，WARN 日志是该链路的可观测面。配置类失败、Embedding 数量不符、结构覆盖不全仍显式失败。模型 JSON 解析失败先带错误现场补一轮反馈修正重试（用户裁决 2026-09-01 少报错）：语义聚类与类型推荐第二轮仍失败维持显式失败（没有条目级降级空间，全批失败是真实语义）；标题候选不足或全部语义重复不再整批失败——不足下限按幸存候选集降级放行（见编排第 4 条），全部越阈取相似度最低者自证，拒因计数与幸存候选随 `TopicPlanTitleCandidatesError` 结构化透出。生产路径不允许调用 js_ai 的 `generateMockTitles`、字符串拼接主题、模板标题、随机数或伪造去重分；测试使用无网络的 deterministic mock Provider。

## 编辑、局部重生成与确认

- 用户新增项只能复用当前 plan 已固定的 topic、source questions 和 knowledge facts；material edit 将该项标为 `userEdited`，并把已有 approval 重置为 draft。用户手工标题明确记录为未重新评估的 user override，不伪造 Embedding 分数。
- 删除是同一 items projection 上的 `user-edit` mutation，不提供绕开 revision 的独立删除入口。所有 mutation 先由 Node 读取 exact plan，再由 Rust 在事务内核对请求来自该 BrandWorkspace 的已提交 Session、expected revision 和 awaiting-confirmation 状态。`createdBySessionId` 只记录 provenance；计划是 BrandWorkspace 共享 artifact，不以创建 Session 做访问隔离。
- 局部重生成的 target IDs 必须属于 exact plan。`userEdited` 或 `approved` target 原样保留并写入 `preservedItemIds`；只有未受保护 target 会产生新的 title-planning 与 Embedding attempt。Rust 再比较旧/新 JSON，防止绕过 Node 覆盖受保护项。重生成目标的标题两轮（初试 + 带反馈修正）幸存集都空时按条目级降级剔除（用户裁决 2026-09-01 少报错）：被剔除目标保留原标题与原批准态原样通过（不替换、不重置 approval），merge 目标集只含「有替换件或受保护」的目标，mutation 的 `targetItemIds` 仍保持完整请求集留审计；全部目标被剔除时如实重抛末次拒因——沉默的空成功比错误更误导。
- explicit confirm 只接受已 approved 的 selected IDs，数量为 1–20；确认决策 append-only，plan revision 增 1 并变为 immutable `confirmed`。只有 confirmation 中的 selected IDs 是后续内容生产的权威输入；本 Ticket 不生成正文。确认卡（`TopicPlanGateCard`）的勾选只是本地暂存；确认点击先经 `/topic-plans/items`（`saveItems` user-edit mutation，勾选项写 `approved`）把批准落盘，再用返回的新 revision 调 confirm——不落盘直接 confirm 会因 selected IDs 仍为 draft 被 `topic_plan_approved_selection_required` 拒绝。
- 复用停卡重选（2026-09-01，与题库复用契约修订同构）：`plan_topics` 复用命中既有 confirmed 计划（prepare 按 `question_pool_id + question_pool_revision + knowledge_version + policy_version` 键查找）时，结果信封携带 `outcome=reused-confirmed-plan`（`TOPIC_PLAN_REUSE_OUTCOME`），卡片进入重选模式——预勾上次的已批准项、只可收窄（冻结计划上未批准项不可新勾），「沿用此计划（N）」走同一 `/topic-plans/confirm` 端点（Rust `confirm_topic_plan` 允许对 confirmed 计划再确认：内容仍 immutable，条目子集仍须 ⊆ 已批准项，决策与 revision 照常推进），另提供「重新生成内容计划」按钮（generate 路由 `regenerate: true` → 服务 `forceRegenerate` → Rust prepare `force_regenerate` 跳过复用查找，create 事务内复用查找同受 `force_regenerate` 约束跳过——同一 source identity 允许落第二代计划，旧 confirmed 计划保留为历史、`latest` 按更新时间取新代；`geo_topic_plan_source_identity` 因此为普通索引，非强制路径的至多一代由 create 事务内复用查找保证；强制重新规划、真实 provider 花费），成功后以正常待决流程呈现新计划。内容计划门只在用户的卡片确认后放行，工具侧不自动放行；跨会话：confirmed 计划是工作区级事实，`confirm_topic_plan` 对非 owner 会话的沿用确认放行（owner 闸只约束待决计划）。
- 聊天修订（票 38，ADR 0003）：待确认（awaiting-confirmation）计划的选题条目可经通用闸门修订工具 `revise_gate_content`（gate=`topic-plan`）改/删/增——handler 复用 `saveItems` 的 `user-edit` mutation（`applyTopicPlanUserEdits` 钳制、Rust fact-key 核对），`mutate` 携带 `reason`（用户指令原文）落 `geo_topic_plan_mutations.reason` 审计列。confirmed 计划在 handler 层按 `target_not_pending` 拒绝；确认卡（`TopicPlanGateCard`）待决期间每 3s 轮询 `/topic-plans/latest`，按条目内容指纹服务端胜合并。

## 确定性验证

- shared unit：严格解析、五类覆盖、标题规则、Embedding 去重、protected merge。
- Node unit：typed-port 编排、固定 snapshot/model attempts、Provider fail-closed、exact-plan CAS、局部保护与 explicit confirmation。
- Rust unit：source snapshot、fact-key authority、revision/identity/confirmed immutable、保护项二次校验。
- DOM/client unit：当前 Tab 控制面、结构化增删改批、局部重生成保护、显式错误与确认门；默认测试无网络、无凭据、无扣费。
- 工具分发缝（`gate-revision.unit.test.ts`）：选题修订操作映射、逐条回执、confirmed/缺失目标的越权拒绝。
