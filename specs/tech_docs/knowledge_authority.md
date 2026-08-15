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
3. 当前 Tab 经 Session Rust proxy 调用 `/api/xiaojing/knowledge/decide` 的结构化卡片决策。

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
| `user-stated` | `knowledge-update` | 无当前值或同值都待确认；异值形成冲突 |
| `model-inferred` | 任意 | 始终保存为待确认/冲突候选，不能合并或替换 authority |
| 任意 | `chat-observation` | 普通聊天建议门；始终待确认/冲突，不能写 authority |

候选提交必须同时保存 raw input、结构化 candidate、来源材料引用、最小原文摘录和置信度。企业 Profile 材料候选还保存 `extracted / asked / inferred` provenance；材料入口的 raw input 只保存 material/field/provenance 标识，不复制整份隐私正文。候选确认前不创建或修改 current fact；同值来源也必须经过用户确认后才合并。

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
| `knowledge_versions` | 每次采纳/拆分后的品牌级单调版本、触发决策、Session、快照哈希 |
| `knowledge_version_facts` | 该品牌版本包含的全部 current fact 版本、值、单位与来源快照 |

旧 `knowledge_facts` 是 BrandWorkspace 初始骨架与删除范围兼容表，不是可写的 KnowledgeAuthority；新代码不得使用它建立第二入口。

## 并发与四类裁决

所有候选合并和用户裁决使用 SQLite `IMMEDIATE` transaction。当前不存在时 expected version 为 `0`；存在时必须等于当前版本。`knowledge_current_facts.fact_key` 主键保证唯一当前值，更新 SQL 同时匹配旧 version。任何 Session 在读后被另一 Session 抢先提交，都会得到 `knowledge_version_conflict`，不能 last-write-wins。

结构化冲突卡支持：

- `keep-current`：保留当前值，候选终结；
- `adopt-new`：同值只合并来源且版本不变；异值把旧 current 移入 history并让新值版本 `+1`；
- `split-scope`：必须改变 scope 或 effective time，并对目标键执行 version `0` CAS；
- `reject-candidate`：拒绝候选，不改 current。

四类裁决都写完整 decision audit。卡片请求中的 workspace/session 必须和当前 Sidecar 一致；actor 由 Node Session route 固定生成，Renderer 不能传入或覆盖。

`adopt-new` 或 `split-scope` 在同一事务内生成新的品牌知识版本；同值采纳虽然 fact version 不变，但来源集合发生变化，因此也生成新品牌快照。`keep-current` / `reject-candidate` 不改变权威知识，不升品牌版本。`KnowledgeDecisionResult.knowledgeVersion` 和隐藏 reminder 会返回新版本；`GeoArtifact.knowledge_version` 固化生成时使用的版本，旧快照与旧产物 lineage 永不被后续裁决覆盖。

裁决提交成功后，Node 通过既有 `SessionEngine.sendDesktopMessage` 投送纯隐藏
`XIAOJING_KNOWLEDGE_DECISION` reminder。它只包含已提交结果的结构化标识，供当前
Agent 自然确认结果；没有 visible tail，因此不会生成虚假用户气泡。提醒入队失败不会
回滚已经提交的 SQLite 决策，响应会显式返回 notification 状态。

## 回归测试

- Node pure policy：`src/server/geo/knowledge-authority.unit.test.ts`；
- Rust schema/事务/CAS/审计：`src-tauri/src/brand_workspace/knowledge.rs`；
- 原材料、抽取、SSRF、最小重试与日志：`src/server/geo/material-import.unit.test.ts`、`src-tauri/src/brand_workspace/materials.rs`；
- 结构化四按钮与无聊天消息提交：`KnowledgeConflictCard.test.tsx`；
- 小鲸 persistent prompt 建议门：`src/server/system-prompt.unit.test.ts`。
- 隐藏裁决事件及结构注入防护：`src/shared/systemReminder.test.ts`。

所有默认测试离线运行，不读取真实 Provider credential、用户目录或网络。
