# 文章直达生成、审校与版本边界

本文定义 Ticket 11 的文章 operation、正文大载荷与批准门。业务语义交叉核验自
`js_ai` `dev` 提交 `936b971751f029e9d67fc86356e8234569e33570`；owner 与跨进程
边界仍以 `specs/ARCHITECTURE.md` 为准。

## Owner 与输入

- Node `ArticleGenerationService` 拥有一次 operation 的业务编排、五类 prompt、并发 5、Provider 调用和生成后审校。它不拥有正文文件、revision 或批准状态。
- Rust `BrandWorkspaceStore` 拥有 operation spec、逐篇状态机、attempt、revision CAS、正文文件、hash、review audit 与批准 artifact。所有 mutation 携带 exact `operationId / articleId / expectedRevision`；claim token 防止迟到 Provider 结果覆盖当前版本。
- `latest` 只用于品牌级 UI 恢复，绝不能作为新建 operation 的完成回读。Node 创建后必须通过 Rust `get_article_operation(operationId)` 读取自身；另一个 Session 即使在生成期间创建了更新 operation，也不能改变当前请求的返回身份。
- Renderer 只沿当前 Tab 的 Session 控制面创建、读取和操作文章。projection 不含正文；正文只在用户打开单篇时按 exact article/version 读取。
- `createdBySessionId` 只记录 provenance。同品牌已提交的其他 Session 可以读取和继续该 operation；Session transcript 不是 operation spec 或正文 authority。

入口只有两类。`confirmed-topic-plan` 读取指定或最新 confirmed plan 固定 revision 的 `selectedItemIds`，且每项必须为 approved；未选择项和未确认 plan 不可消费。`direct` 必须提交明确的篇数、主题集合、五类之一与约束。两者在开始时都持久化为不可变 `operation_spec_json`，并为每篇固定当时的 immutable knowledge version 与 planned facts，后续不得从 transcript 临时补齐参数。

## 生成和质量门

正文固定使用 generation 槽位的 `doubao-seed-2-0-pro-260215`，plain Markdown，`max_tokens=8192 / temperature=0.85 / top_p=0.9`。正文 policyVersion 当前为 `xiaojing-content-prompt-v3`。五类语义保持为 `guide / showcase / ranking / news / news_light`：非 ranking 不得出现竞品；showcase 只写已确认的品牌详情；news 两类只有在事实足够时才写 5W1H 事件；ranking 使用六家并列、相同六维清单，不打分、不作名次或绝对化比较，也不能用泛称、模板或虚构竞品补位。开始 operation 前 Rust 数量门要求至少 5 家去重后的已确认有效竞品；workspace 自名、全称/简称及 relatedBrands 均被排除。不足时不创建失败草稿，而向 Agent 返回当前数量，由当前聊天自然语言补充。

Node 与 Rust 的有效竞品实现共同读取 `src/shared/geo/rankingCompetitorContractCases.json` 契约样例，防止跨进程归一化、去重和排除规则漂移；Node 内的确认工具与正文 roster 共用 `filterValidRankingCompetitors`。

ADR-0006 增补三层结构：①每篇正文 prompt 恒注入品牌身份块（实体层字段 + 加粗规则，`renderBrandIdentityBlock`）与叙事视角种子（12 组 {切入角度, 开篇写法, 小标题措屑倾向}，操作内洗牌发牌、发尽重洗、重试重发单张），种子只影响表达层并显式声明「不放松任何硬纪律」；②五类规范改为三段式纯数据契约（格式契约｜表达参考｜事实衔接，`CONTENT_TYPE_CONTRACTS`），system 同时注入「骨架非填空」与「事实三层纪律」；③`direct` 路径在正文前先跑单篇标题生成（`buildDirectTitleMessages`：3–5 候选 → 既有 `validateTitleCandidates` → 取首个有效，region/行业从 plannedFacts 投影画像锚定），失败 fail-loud 进入 `generation_failed`，不做模板兜底、不降级为主题原文。不变量清单与偏离登记见 `content_prompt_invariants.md`。

批准是双门且 fail closed：纯规则先检查未获事实支持的数字/成就硬主张（按三层纪律收窄为「具体命名/数字才须溯源」，泛化修辞放行）、广告法与模板禁词、占位符及可引用结构，另检查格式契约（per-type H2 下限：guide/showcase 3、ranking 6、news 两类 2；品牌名出现必须加粗且逐字命中全称/已确认简称；段落不超过 3 句），ranking 另检查六个序号 H2、逐家相同六维与实体集合：第 1 家是目标品牌，第 2–6 家恰为本次固定的五家已确认竞品，竞品内部顺序不限。ranking 在正文持久化前先执行同一确定性门，错误稿不会进入批准卡；批准时复检以覆盖人工编辑。reflection 槽位再检查语义、事实、广告法和可引用性（不裁语气修辞，只裁具体捏造与实体保真）。任一硬门失败、Provider 不可用或 JSON 无效都进入 `rejected`，不能批准。生产路径没有 demo、随机指标、mock output 或模板正文 fallback；确定性 mock Provider 只用于测试。

已确认 topic plan 之后若用户才补足竞品，文章开始边界允许一个受限快照前移：用最新 KnowledgeAuthority 快照替换 ranking item 的 roster 输入事实（`fullName / shortNames / relatedBrands / competitors`），并要求其他原 planned facts 在新快照中仍逐项同值；随后 operation 固化新知识版本。其他事实有变更时仍 fail closed，不能借竞品补充绕开选题事实血缘。

批准提交成功后，`articles/approve` 路由在同一 Session 投递纯隐藏 `XIAOJING_ARTICLE_APPROVAL_DECISION` reminder（只携带 operation/article identity、revision、status、approvedRevision 与 knowledge version），唤醒 agent 从权威审校结果继续进入渠道分发规划，不重复询问已裁决文章。提醒入队失败不回滚已提交的批准，响应显式返回 notification 状态。

## 正文、版本与恢复

SQLite 只保存正文相对路径、SHA-256、revision、origin、review/model audit 和引用。正文写入 BrandWorkspace 管理的磁盘目录：草稿按 `operations/{operationId}/articles/{articleId}/v{revision}.md`，批准副本按 `articles/approved/{articleId}/v{revision}.md`。写入使用 create-new 语义；若中断后目标已存在，仅当字节完全相同才幂等恢复，不同内容一律冲突且永不覆盖。

生成、人工编辑和单篇重新生成只追加新 revision。批准会复制并校验 exact draft revision 的正文/hash，设置稳定 `approvedRevision`，并创建确定性的 `article-{articleId}-v{revision}` artifact。后续生成只产生新草稿，不能修改批准副本或重复创建原批准 artifact。大正文不进入普通 projection、Session transcript 或无关 Agent prompt。

单篇 Provider 失败只记录该文章的 `generation_failed` 与 attempt reason；其他文章继续。重试只 claim exact article/revision，不重跑整个 operation。此 operation 不调用 baseline、渠道召回、分配、OSS、发布或监测。后续分发必须从批准 artifact 进入 `PublishScheduler`，本 Ticket 不建立该路径。

## 聊天修订（票 38，ADR 0003）

待审批（draft_ready）文章的标题与正文可经通用闸门修订工具 `revise_gate_content`（gate=`article`，仅 modify）修改：handler 走既有 `ArticleGenerationService.edit` 语义（新版本行 origin=`user-edited`、状态回到 draft_ready、必须重新过审批门），`edit` 携带 `reason`（用户指令原文）写入版本行 `model_audit_json.revisionReason`。已批准/生成中/审校中的文章按 `target_not_pending` 拒绝；delete/add 不是本闸门语义，回执 `action_not_supported`。批准卡（`ArticleApprovalGateCard`）待审批期间每 3s 轮询 `/articles/latest` 采信新投影（批准继续走既有审批门）。

批准卡同样提供卡内直改（js_ai 门卡交互）：正文可展开/收起（按 revision 缓存），draft_ready 稿件可在卡上进入编辑并经 `POST /api/xiaojing/articles/edit`（不带 `reason`，`model_audit_json` 保持 `{}`）落成 `user-edited` 新版本，标题取正文首行 H1；整卡「批准并继续」按各篇最新 revision 逐篇走既有 `articles/approve`（单篇失败不阻断其余），批准后的稿件才是进入分发计划的事实依据。

## 测试

- shared pure tests：direct spec、五类 prompt、plain Markdown、事实/广告法/结构与 reflection 双门。
- Node unit tests：并发上限 5、单篇失败隔离、exact retry、reflection 失效和虚假通过均 fail closed。
- Rust owner tests：confirmed selected-only、固定 operation spec/knowledge version、CAS/attempt 恢复、正文幂等落盘、批准 copy/hash、批准后再生成稳定、artifact 去重与跨 Session 读取。
- Renderer DOM/client tests：单篇查看、编辑、重生成、批准以及 exact identity/revision 请求。
- 路由接缝回归：批准后注入决策回执信封、响应携带 notification 状态、投递失败不影响决策成功（`src/server/__tests__/xiaojing-decision-receipt-gates.integration.test.ts`）。
