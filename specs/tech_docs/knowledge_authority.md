# 品牌知识权威与冲突裁决

## 职责与唯一入口

`BrandWorkspace` 是品牌数据边界，`KnowledgeAuthority` 是权威事实的唯一业务写入口。三层职责固定如下：

| 层 | 可以做 | 不可以做 |
|---|---|---|
| Renderer | 展示候选/冲突卡；提交四类结构化用户决策 | 直接调用 Rust 写事实、构造 actor、伪造用户聊天消息 |
| Node GEO domain | 标准化事实键和值；识别同值/冲突；执行候选和决策 policy | 持久化第二份知识状态、绕过用户确认 |
| Rust `BrandWorkspaceStore` | 持久化、SQLite 原子事务、唯一当前值、expected version CAS、审计 | 从自然语言推断业务事实或替用户选择冲突结果 |

生产入口最终都进入 `src/server/geo/knowledge-authority.ts::KnowledgeAuthority`：

1. `xiaojing-geo` MCP 的 `propose_brand_fact` / `inspect_brand_fact`；
2. `MaterialImportService` 从原始品牌材料抽取的企业 Profile 候选；
3. 当前 Tab 经 Session Rust proxy 调用 `/api/xiaojing/knowledge/decide`（单条）或
   `/api/xiaojing/knowledge/decide-batch`（批量确认卡）的结构化卡片决策；
   `/api/xiaojing/knowledge/candidates` 供卡片在会话重载后水合候选真实状态。

4. `xiaojing-geo` MCP 的通用闸门修订工具 `revise_gate_content`：按用户在聊天中的显式自然语言指令（操作逐条携带 `userInstruction` 原文审计）对当前未决闸门内容执行改/删/增。工具是单一受限入口（参数：闸门类型 + 操作列表），内部分发到各域 handler（见 `src/server/geo/gate-revision.ts`：六个既有闸门——知识、问题池、选题、文章、渠道计划、发布准备——已全部挂接同一契约，后续新闸门经 `registerGateRevisionHandler` 接入，不得另起修改入口）；工具描述写死「仅基于用户显式指令；不得自行判断删除」。非未决目标、跨 Session/品牌目标按域错误码结构化拒绝（`target_not_pending` / `target_not_in_session` / `target_not_found` / `revision_conflict`）。知识闸门作用于本 Session 的 `awaiting-confirmation`/`conflict` 候选：
   - **modify**：新值经既有归一化管道写回候选行，provenance 升为 `asked`（只升不降），状态回到 `awaiting-confirmation`——用户显式改值即表达了对新值的选择，整卡确认按 `adopt-new` 提交；
   - **delete**：候选终结为 `rejected`，材料未决候选清零时与裁决同步置 `processed`；
   - **add**：走既有 propose 语义（`user-stated` / `knowledge-update` / `asked` 待确认候选），携带材料 id 时把新候选挂回该材料最新处理 attempt 的候选快照，卡片经既有轮询/水合投影重渲染出新行。
   每次修订写 `knowledge_candidate_revisions` 完整审计（before/after 值快照 + 指令原文），不升品牌知识版本、不投送 `XIAOJING_KNOWLEDGE_DECISION` reminder（reminder 只在裁决提交时投送）。修订按候选 id 覆盖卡片本地暂存编辑（服务端胜），见 ADR 0003。

5. `confirm_ranking_competitors` 是唯一自然语言直采纳例外：Session Sidecar 必须先持有由 ranking 数量门签发的待补充状态，并绑定原文章请求、品牌主体及签发时用户消息。该状态由 Session Sidecar 持有，不得放在每轮重建的 MCP server factory 闭包中；对同一文章请求的重复生成不得移动签发时的用户消息边界，但一次部分采纳后服务端必须把该边界推进到刚消费的用户消息——同一条用户消息不得再授权下一轮采纳（否则消息里顺带提到的名字会被后续调用逐个直采纳）。工具只接收待采纳名称；服务端逐字读取当前 Session 最新持久化用户消息，要求它晚于签发消息且逐名包含待采纳名称，目标主体从 Gate 取得，并以服务端读取的原话作 `rawInput/excerpt/reason`，按 `user-stated / knowledge-update / asked` 提议数组补充并立即 `adopt-new`。目标品牌自身、workspace 名、已确认别名和 relatedBrands 会拒绝；模型推断、搜索候选和普通聊天观察不得走该入口。补足 5 家时工具直接恢复绑定的原文章请求。

除上述 ranking 竞品不足的窄例外外，裁决入口固定为聊天内的结构化卡片：材料导入（`import_pasted_material` /
`import_website_material` / `retry_brand_material` 的工具结果）渲染一张字段行复核卡
（`knowledge-candidates-card`，同字段候选合并为一行、按固定字段序排列）。候选按
材料自然分布进卡，不设单字段配额——各类值分布不均匀是常态（全称 1 条、产品/地址
多条按材料而定）；总量上限 500（`KNOWLEDGE_CARD_MAX_CANDIDATES`，宽余量——真实
批次典型 15–30 条）只是转录体积边界，
仅当批次超总量时先保底每个出现的字段 1 条（防大容量字段把其他类整类挤掉），再按
payload 自然顺序填充，未进卡候选按字段归因在行内提示溢出。
`materials/status` 重建不做前置截断，配额与溢出统一由 builder 分配；会话重载
水合端点 `/api/xiaojing/knowledge/candidates` 的 candidateIds 上限与卡片总量上限
一致。卡片投影按复核所需裁剪单条体积：摘录截断至 300 字符
（`KNOWLEDGE_CARD_EXCERPT_MAX_CHARS`，完整摘录留在候选与审计里），不再携带与
normalized 值重复的原始 `valueJson`——卡片 JSON 是工具结果正文、随转录进 Agent
上下文，单条体积由此封顶。单条提议渲染
`knowledge-conflict-card`。材料请求卡
（ADR 0005）发起的上传复用同一卡组件，确认卡直接渲染在请求卡卡体内。卡片正文按类分格
（GD 反馈演进）：每个企业 Profile 字段类一格（双列网格、固定字段序），同一类格内材料
原文/已裁决候选（绿色「已就绪」徽章）与推断/冲突/失败候选（黄色「待确认」徽章）并存，
行头给出该类「已就绪 N / 待确认 N」摘要；含待确认内容的类排网格前部（组内保持固定
字段序）。卡片头部计数按类（「共 N 类信息 · M 类待确认」，全部就绪时「全部已就绪」），
不呈现候选条数总数。候选值以胶囊（pill）呈现，数组值一值一胶囊逐项陈列，
冲突胶囊内联展示「当前值 → 新值」对比（当前值数组同样逐值陈列）；字段名由行头
承载，摘录与置信度收进展开详情。正文限高内滚
（`max-h-[60vh] overflow-y-auto`）：所有确认卡都随聊天滚动，超长批次靠卡片自身滚轴
浏览，不得把内容推出窗口底边。整卡确认按钮常驻卡片头部（收起正文也可见），全部裁决后隐藏。
卡片按来源层级分层默认（ADR 0003）：材料原文行
（`extracted`）视为已就绪、无任何控件；AI 补全行（`inferred`）只带纯视觉的逐行
「确认」（本地状态，按候选 id 扛住 3s 轮询重建）；冲突行必须显式「采用新值 / 保留
当前值」，未全部解决前整卡确认禁用；每行可「更改」（内联编辑、暂存不落库），被更改
行视为「用户补充」（`asked`）、已就绪。卡片不提供拒绝；整卡一次「确认」即构成对全部未决候选的用户裁决并全量采纳（含从未
逐条查看的 AI 补全行；改值行提交 `adopt-edited`，其余 `adopt-new`）。确认后的权威
事实投影在右侧 GEO 工作台常驻的「品牌知识」面板（位于多操作
切换器与六阶段骨架之间，工作台组成见 `geo_operations.md`），Agent 通过一条聚合
`XIAOJING_KNOWLEDGE_DECISION` reminder 得到全部结果。

卡片时间戳两态（geo-plan-normalization 票 08，与材料请求卡共用 `CardStatusTime`
组件钉死同一语义）：裁决线未收口（仍有候选待确认/冲突未选/失败待重试）时页脚显示
「生成中」状态词、绝不出钟点；全部候选落定后显示完成时刻 = 各候选裁决落库时刻
（`resolvedAt`）的最大值（最后一次裁决的时刻）。`resolvedAt` 的唯一权威源是 Rust
决策事务内与终态同笔写入的 `knowledge_fact_candidates.resolved_at`（聊天 delete 终结
同样写入）：`KnowledgeCandidate` 投影与 `KnowledgeDecisionResult` 均透传该字段，
`decide-batch` 路由将其原样映射为结果项的 `settledAt`（实时路径），水合端点经
`toKnowledgeCardCandidate` 投影 `resolvedAt`（重挂载路径）。渲染侧不另行打点、
不造第二时间源；落定但拿不到权威时刻（旧投影未带）时时间槽整体缺席，不用客户端
钟点伪造。

字段行的分组键与展示标签按 `knowledgeFieldKeyOfPredicate` 大小写不敏感归一为规范
camelCase 字段 token（`canonicalEnterpriseProfileField`）：identity 入库时 predicate
被统一小写（如 `enterprise-profile.servicearea`），展示侧必须还原成 `serviceArea`
并映射 i18n 字段标签（「服务区域」），不得让裸 predicate 或重复语义字段漏出到 UI；
右侧「品牌知识」面板的 FactItem 沿用同一映射，非 Profile 字段保持 predicate 原文。

知识版本史与产物血缘的呈现位置是左侧栏「品牌档案」一级入口：品牌级只读整页
（`XiaojingBrandArchivePage`），跟随当前选中品牌、不依赖任何 Session，数据来自
`cmd_brand_workspace_history` 返回的 `BrandHistoryProjection`（`knowledge_versions`
用户批准快照与已批准产物的 `sourceRefs`/`usedBy` 血缘）。页面分三层（DESIGN.md
布局节）：「当前档案」看板只投影最新版本事实（字段经 `canonicalEnterpriseProfileField`
归一后按语义 widget 分格），「版本历史」默认收起、每行携带与上一版的前端 diff
摘要，「产物」按七类分组、工程标识折叠进「技术详情」。整页除读取（刷新/重试）
外不提供任何确认或动作入口；右侧 GEO 工作台不再渲染历史面板。

Node 再通过既有 Management API `/api/brand-knowledge/*` 交给 Rust。Rust 同时校验 Sidecar immutable management id、process generation、逻辑 Session id 和品牌 workspace path；JSON 中换一个 `workspaceId` 不能访问另一品牌。

## 事实 identity 与标准化

事实键不是随机 ID 或自然语言句子，而是下列标准化结构的 canonical JSON：

```text
subject + predicate + sorted scope + effectiveFrom + effectiveTo
```

- `subject` / `predicate` 去首尾和重复空白，并使用稳定大小写归一；
- `scope` 是键排序后的标量 JSON 对象；地域、产品线、渠道或套餐等差异都形成不同键；
- effective time 接受 ISO 日期或时间，结束必须晚于开始；不同有效时间形成不同键；
- value 递归排序对象键、规范字符串空白与有限数值；单位使用 canonical token（如 `元/RMB → cny`）。

因此只有事实键完全相同才参与同值/异值比较。范围或有效时间不同是合法多值，不产生冲突。

## 候选 policy

候选携带 `origin` 与 `intent`：

| origin | intent | 行为 |
|---|---|---|
| `user-stated` | `knowledge-update` | 无当前值或同值都待确认；异值形成冲突（数组字段例外，见下） |
| `model-inferred` | 任意 | 始终保存为待确认/冲突候选，不能合并或替换 authority |
| 任意 | `chat-observation` | 普通聊天建议门；始终待确认/冲突，不能写 authority |

数组字段（products/customerCases/coreAdvantages 等）的差异是**补充语义而非矛盾**：current 与候选同为 JSON 数组时，propose（含聊天修订 add）把候选值改写为「current 各项在前、候选新增项按 canonicalJson 逐项去重后追加」的并集，分类为 `awaiting-confirmation`——确认卡展示的候选值即 `adopt-new` 后的最终形态，整卡确认一次即完成增量合并，不要求二选一。并集与 current 完全相同（候选无新增）时沿用同值路径：仍落待确认候选，确认后仅合并来源、不升事实版本。只有标量 vs 标量差异、或类型不一致（一边数组一边标量）才判 `conflict` 走二选一。

候选提交必须同时保存 raw input、结构化 candidate、来源材料引用、最小原文摘录和置信度。企业 Profile 材料候选还保存 `extracted / asked / inferred` provenance；材料入口的 raw input 只保存 material/field/provenance 标识，不复制整份隐私正文。候选确认前不创建或修改 current fact；同值来源也必须经过用户确认后才合并（确认粒度为整卡一次确认，见 ADR 0003）。

## 持久化模型

每个品牌自己的 `project.sqlite` 使用以下分离表：

| 表 | 内容 |
|---|---|
| `knowledge_raw_inputs` | 用户原话或模型发现的原始文本、origin、intent、Session |
| `knowledge_fact_candidates` | 结构化键、原值/标准化值、单位、provenance、状态、base version |
| `knowledge_current_facts` | 每个 `fact_key` 唯一一行的当前权威值、确认人/时间、版本 |
| `knowledge_fact_versions` | 被替换的历史权威版本；不与 current 混存 |
| `knowledge_fact_sources` | 每一事实版本合并后的材料、摘录、置信度和 origin |
| `knowledge_decisions` | 决策、actor/Session、expected version、before/after、reason、时间 |
| `knowledge_candidate_revisions` | 聊天修订审计：action（modify/delete/add）、actor/Session、before/after 值快照、用户指令原文、时间；同一候选可多条 |
| `knowledge_versions` | 每次采纳/拆分后的品牌级单调版本、触发决策、Session、快照哈希 |
| `knowledge_version_facts` | 该品牌版本包含的全部 current fact 版本、值、单位与来源快照 |

旧 `knowledge_facts` 是 BrandWorkspace 初始骨架与删除范围兼容表，不是可写的 KnowledgeAuthority；新代码不得使用它建立第二入口。

## 并发与五类裁决

所有候选合并和用户裁决使用 SQLite `IMMEDIATE` transaction。当前不存在时 expected version 为 `0`；存在时必须等于当前版本。`knowledge_current_facts.fact_key` 主键保证唯一当前值，更新 SQL 同时匹配旧 version。任何 Session 在读后被另一 Session 抢先提交，都会得到 `knowledge_version_conflict`，不能 last-write-wins。

结构化冲突卡支持：

- `keep-current`：保留当前值，候选终结；
- `adopt-new`：同值只合并来源且版本不变；异值把旧 current 移入 history并让新值版本 `+1`（数组补充候选的"新值"即 propose 时写入的去重并集，裁决路径无需再做合并）；
- `adopt-edited`：采用用户在批量确认卡内编辑后的值（Node 先经同一归一化管道）。编辑值与当前权威同值时仅合并来源；候选行保留原始提议值，审计 before/after 可重建"原值→改值"链路；
- `split-scope`：必须改变 scope 或 effective time，并对目标键执行 version `0` CAS；
- `reject-candidate`：拒绝候选，不改 current。

五类裁决都写完整 decision audit。卡片请求中的 workspace/session 必须和当前 Sidecar 一致；actor 由 Node Session route 固定生成，Renderer 不能传入或覆盖。`knowledge_decisions.decision` 的 CHECK 约束包含全部五类；首版 schema 旧库由 `ensure_decisions_admit_adopt_edited` 幂等重建迁移。批量裁决逐条独立事务提交，部分失败不回滚已提交项，卡片按条目呈现成败并可重试失败条目。

`adopt-new`、`adopt-edited` 或 `split-scope` 在同一事务内生成新的品牌知识版本；同值采纳虽然 fact version 不变，但来源集合发生变化，因此也生成新品牌快照。`keep-current` / `reject-candidate` 不改变权威知识，不升品牌版本。`KnowledgeDecisionResult.knowledgeVersion` 和隐藏 reminder 会返回新版本；`GeoArtifact.knowledge_version` 固化生成时使用的版本，旧快照与旧产物 lineage 永不被后续裁决覆盖。

裁决提交成功后，Node 通过当前 Session message path 投送纯隐藏
`XIAOJING_KNOWLEDGE_DECISION` reminder（单条决策一条；批量确认卡一次提交只投送
一条聚合全部条目的 reminder）。它只包含已提交结果的结构化标识，供当前
Agent 自然确认结果；没有 visible tail，因此不会生成虚假用户气泡。提醒入队失败不会
回滚已经提交的 SQLite 决策，响应会显式返回 notification 状态。

## 回归测试

- Node pure policy：`src/server/geo/knowledge-authority.unit.test.ts`；
- 通用闸门修订分发与工具纪律：`src/server/geo/gate-revision.unit.test.ts`；
- Rust schema/事务/CAS/审计：`src-tauri/src/brand_workspace/knowledge.rs`（含 adopt-edited、旧库重建迁移与聊天修订改/删/增）；
- 批量卡契约与投影：`src/shared/geo/knowledgeCard.test.ts`；
- 聚合 reminder 结构与注入防护：`src/shared/systemReminder.test.ts`；
- 原材料、抽取、SSRF、最小重试与日志：`src/server/geo/material-import.unit.test.ts`、`src-tauri/src/brand_workspace/materials.rs`；
- 结构化四按钮与无聊天消息提交：`KnowledgeConflictCard.test.tsx`；
- 字段行复核卡分层默认/整卡全量采纳/更改暂存/水合/部分失败：`KnowledgeBatchCard.test.tsx`；
- 工作台权威知识投影：`XiaojingBrandKnowledgePanel.test.tsx`；
- 品牌档案只读整页（版本史与血缘投影、无动作入口）：`XiaojingBrandArchivePage.test.tsx`；
- 小鲸 persistent prompt 建议门：`src/server/system-prompt.unit.test.ts`。

所有默认测试离线运行，不读取真实 Provider credential、用户目录或网络。
