# 文章直达生成、审校与版本边界

本文定义 Ticket 11 的文章 operation、正文大载荷与批准门。业务语义交叉核验自
`js_ai` `dev` 提交 `936b971751f029e9d67fc86356e8234569e33570`；owner 与跨进程
边界仍以 `specs/ARCHITECTURE.md` 为准。

## Owner 与输入

- Node `ArticleGenerationService` 拥有一次 operation 的业务编排、五类 prompt、并发 5、Provider 调用和生成后审校。它不拥有正文文件、revision 或批准状态。
- Rust `BrandWorkspaceStore` 拥有 operation spec、逐篇状态机、attempt、revision CAS、正文文件、hash、review audit 与批准 artifact。所有 mutation 携带 exact `operationId / articleId / expectedRevision`；claim token 防止迟到 Provider 结果覆盖当前版本。
- `latest` 只用于恢复场景（品牌级 UI 恢复与聊天批准卡恢复），绝不能作为新建 operation 的完成回读。Node 创建后必须通过 Rust `get_article_operation(operationId)` 读取自身；另一个 Session 即使在生成期间创建了更新 operation，也不能改变当前请求的返回身份。聊天恢复入口是只读工具 `get_article_operation`：用户要求重新呈现批准卡或查询生成状态时，按 `operationId` 读取（缺省回落 `latest`，只做展示恢复），返回与 `generate_articles` 相同的 `article-operation` 信封重渲染批准卡；查无此操作返回 `article-operation-not-found`。该工具不生成、不编辑、不批准，绝不能靠重新 `generate_articles` 找回卡片。
- Renderer 只沿当前 Tab 的 Session 控制面创建、读取和操作文章。projection 不含正文；正文只在用户打开单篇时按 exact article/version 读取。
- `createdBySessionId` 只记录 provenance。同品牌已提交的其他 Session 可以读取和继续该 operation；Session transcript 不是 operation spec 或正文 authority。

入口只有两类。`confirmed-topic-plan` 读取指定或最新 confirmed plan 固定 revision 的 `selectedItemIds`，且每项必须为 approved；未选择项和未确认 plan 不可消费。**生成时选取（票 #34）**：确认的 plan 冻结的是「有资格生成」的集合，不是「必须全部生成」的义务——调用可携带 `itemIds` 子集（工具 schema 限制 1–20 项，与 `direct` 互斥），Rust seeds 准备时校验子集逐项命中 `selectedItemIds` 且无重复（违例分别回 `article_generation_plan_item_not_selected` / `article_generation_plan_selection_invalid`），缺省消费全部；跨 operation 无「已消费」守卫，与「重新生成只产生新草稿」语义一致，未消费项留在资格集里可被后续 operation 消费（已生成与否由 `geo_articles.source_plan_item_id` 派生）。`direct` 必须提交明确的篇数、主题集合、五类之一与约束。两者在开始时都持久化为不可变 `operation_spec_json`（plan 入口同时记录 `selectedItemIds`＝本次消费子集与 `planSelectedItemIds`＝资格全集，血缘可追溯），并为每篇固定当时的 immutable knowledge version 与 planned facts，后续不得从 transcript 临时补齐参数。

## 生成和质量门

正文固定使用 generation 槽位的 `doubao-seed-2-0-pro-260215`，plain Markdown，`max_tokens=8192 / temperature=0.85 / top_p=0.9`。正文 policyVersion 当前为 `xiaojing-content-prompt-v10`（v7 覆盖 ADR-0009 全部三阶段；v8 追加正文可信度与结构化表达纪律 D19——正文 prompt 恒注入「经验/专业/权威/可信」四信号与「实体-关系-属性」表达纪律，EEAT 与知识图谱原则的写作纪律转写、不出现两组原字样，权威信号的竞品表述限定对比清单类型，纯提示词层尽力约束、不新增 reflection 维度或格式契约变更；ranking 收束结构强化 D20——「总—分—总」总领、引言禁 `##` 小节标题、选型建议由「倒数第三段」改顺序语义并新增其后独立 80–150 字总结段（2026-09-03 精化为全文最后一个独立小节、固定「总结」小标题、不与选型建议混写；同轮裁决泛化五类——所有文章类型以最后一个独立小节收束、单独设「总结」小标题），现有八条 format 规则与 2500 字上限不变，确定性审核门不新增校验；v9 追加品牌指称序 D21——正文品牌指称「首次全称、其后钉第一个已确认简称」门 blocking，生成期有界修复兜住，人工批准路径存量稿豁免；v10 追加列表项标签加粗 D22——「标签+内容」列表项的标签加粗推广为全类型管线保证（`autoBoldListLabels`，冒号/空格两形态、2–12 字约束、空格型停用词闸，盲区与品牌加粗同源），prompt 全局加粗规则同步声明并把「单一加粗实体 ≤3 次」豁免扩列，不新增 blocking 门）。五类语义保持为 `guide / showcase / ranking / news / news_light`：非 ranking 不得出现竞品；showcase 只写已确认的品牌详情；news 两类只有在事实足够时才写 5W1H 事件；ranking 使用六家并列、逐家覆盖同一套六维（ADR-0009 Decision 2 骨架注入：正文生成前先由维度选定小调用现选 6 个维度名——lite 路由 `purpose: "dimension-planning"`，每篇现选保跨文章多样性、重试重发一组，解析校验 fail-loud 不回退模型自选——字面注入 prompt，六维同名由构造保证），不打分、不作名次或绝对化比较，也不能用泛称、模板或虚构竞品补位。维度清单随生成稿落库（`geo_articles.ranking_dimensions_json`，存量库 `ensure_column` 迁移），批准门复检对照；存量稿无清单时回退与第一家集合比对。开始 operation 前 Rust 数量门要求至少 5 家去重后的已确认有效竞品；workspace 自名、全称/简称及 relatedBrands 均被排除。不足时不创建失败草稿，而向 Agent 返回当前数量，由当前聊天自然语言补充。

Node 与 Rust 的有效竞品实现共同读取 `src/shared/geo/rankingCompetitorContractCases.json` 契约样例，防止跨进程归一化、去重和排除规则漂移；Node 内的确认工具与正文 roster 共用 `filterValidRankingCompetitors`。

ADR-0006 增补三层结构：①每篇正文 prompt 恒注入品牌身份块（实体层字段 + 加粗规则，`renderBrandIdentityBlock`）与叙事视角种子（12 组 {切入角度, 开篇写法, 小标题措屑倾向}，操作内洗牌发牌、发尽重洗、重试重发单张），种子只影响表达层并显式声明「不放松任何硬纪律」；②五类规范改为三段式纯数据契约（格式契约｜表达参考｜事实衔接，`CONTENT_TYPE_CONTRACTS`），system 同时注入「骨架非填空」与「事实三层纪律」；③`direct` 路径在正文前先跑单篇标题生成（`buildDirectTitleMessages`：3–5 候选 → 既有 `validateTitleCandidates` → 取首个有效，region/行业从 plannedFacts 投影画像锚定；校验集合与选题同口径——品牌裁决名 + 已确认简称、竞品与 relatedBrands 都进禁用源，ranking 提示词禁一切品牌名（用户裁决 2026-09-01），锚源复合值按分隔符拆 token、服务端 WARN 留痕），失败 fail-loud 进入 `generation_failed`，不做模板兜底、不降级为主题原文。不变量清单与偏离登记见 `content_prompt_invariants.md`。

配图契约（ADR-0008 T4，2026-08-31 按类型配额修订）：正文生成前读取品牌材料图片候选池（Rust `/api/brand-materials/images/list`，注入上限 50；池空或读取失败在服务内降级为零配图，不阻塞生成主链，降级留痕进统一日志），候选清单（图片 id + 描述 + 类型标签 + 来源材料名的纯文字清单）与配图纪律注入正文 prompt——配额按内容类型（`ARTICLE_IMAGE_QUOTA_BY_TYPE`：guide/showcase 8、news/news_light 3、ranking 1，排行类只允许目标品牌小节配图），按候选池弹性取小，首图锚定开篇综述之后的首屏位置、其余只在语义相关处由模型定位，alt 文本由模型撰写——生成模型只看清单文字，不看图片本体。正文以标准 Markdown 图片语法输出 `![alt](material-image://<图片id>)` 占位符（普通 markdown 行，可被聊天修订或人工编辑删除）；`parseGeneratedArticleBody` 放行该受控 scheme，scheme 逃逸用法按 `article_generation_image_placeholder_invalid` 拒绝，【】占位符禁令不变；确定性审核门对占位符语法违例与超出类型配额阻断（人工编辑路径不走 parse，审核门是唯一防线）。跨进程硬顶 `MATERIAL_IMAGE_MAX_PER_ARTICLE` = 8（各类型配额最大值），TS/Rust 两侧与契约 JSON 逐值同步。占位符语法与校验用例钉在 `src/shared/geo/materialImagePlaceholderContractCases.json`（TS 侧消费；T5 Rust 发布替换侧读同一份 JSON，同构先例 rankingCompetitorContractCases.json）。发布期占位符替换为真实 OSS URL 属发布链（#15），本模块不消费图片字节。

批准门（确定性面）只拦格式契约与实体完整性：per-type H2 下限（guide/showcase 3、ranking 6、news 两类 2）、showcase 卖点用列表或表格、品牌名逐字加粗（盲区不计：标题行、围栏代码块、图片语法、链接 URL——ADR-0009 与自动加粗对齐；段落长度等表达层要求 2026-08-18 起不机械拦截）、品牌指称序（首次全称、其后第一个已确认简称；`approve` 对存量稿豁免 `brandNameOrderEnforced: false`，不追诉 v8 及更早稿件，2026-09-03 裁决）、ranking 六个序号 H2、逐家覆盖同一套六维（ADR-0009 集合相等门：顺序不敏感；服务端持有随文落库的注入清单时对照清单，存量稿回退与第一家集合比对）与实体集合：第 1 家是目标品牌，第 2–6 家恰为本次固定的五家已确认竞品，竞品内部顺序不限、【】占位符、material-image 占位符违例与超类型配额。未获事实支持的数字/成就硬主张与广告法/模板禁词为 advisory（2026-08-18 裁定：记录可追溯但不阻断；批准卡分区提示，可带警告批准）。reflection 语义审核暂停中（2026-08-18 裁定，`REFLECTION_REVIEW_ENABLED=false`，恢复时改回）。任一 blocking 失败进入 `rejected`，不能批准。**弃用终态（票 #34）**：用户对明确不要的稿（`draft_ready / generation_failed / rejected` 均可）经 `/articles/discard`（CAS revision、owner-only）翻转为 `discarded` 终态——不建版本、不碰正文文件、清空 failure_reason；`approved`（分发事实依据）与 `planned`/在途态不可弃（`article_discard_status_invalid`），弃用后编辑、复审 claim 与重试 claim 全部关闭，且不投递决策 reminder（弃用是减法，不改变「以 approved 集合继续」的推进语义）。操作状态机把 `discarded` 与 `generation_failed` 同视为「未获批准的已收束终态」：approved ∪ discarded ∪ generation_failed 全收束即 `completed-with-failures`，批准卡不再挂起。存量库迁移：`geo_articles.status` CHECK 约束按 sqlite_master 原文重建补入 `discarded`（`extend_geo_articles_status_check`，foreign_keys=OFF 包裹、索引按原文重建，与 session-FK 重建同一先例）。生产路径没有 demo、随机指标、mock output 或模板正文 fallback；确定性 mock Provider 只用于测试。

生成路径在 parse 后另有确定性修复层（ADR-0009 Phase 1，2026-09-01）：品牌名自动加粗——加粗从模型纪律降格为管线保证，身份块 prompt 不再要求手动加粗（实体纪律保留）；列表项标签自动加粗（2026-09-04 裁决 D22，`autoBoldListLabels` 先于品牌加粗执行，标签内含品牌名时不嵌套包裹）；配图超类型配额时按序裁掉多余占位符，宁裁不拒。Phase 2（同日）起生成期确定性预检从 ranking 扩展到全部五类型：确定性修复后仍有 blocking 项时触发**一次有界修复 pass**（`buildArticleRepairMessages`：输入草稿与违规清单逐字注入，低温 0.3、离线复用 generation 槽；修复稿同样过 parse 门与确定性修复后复检，ranking 另注入名单硬约束说明），复检通过则修复稿落库，仍违规则按 `article_generation_output_invalid`（ranking 为 `article_generation_ranking_output_invalid`）失败，失败原因直指未解决问题清单；modelAudit 记录 `repairUsed`。修复调用失败不掩盖原始违规。批准时复检以覆盖人工编辑（人工编辑路径不走 parse 与自动修复，审核门是唯一防线）。审核失败遥测：`/api/brand-articles/review/stats`（Node 端口 `RustArticlePort.reviewStats`）聚合本工作区历次审核——总量/通过/失败、按内容类型的通过率、按 policyVersion 的尝试分布，以及 severity × category × policyVersion 的问题交叉计数（缺版本记 unknown）——供规则分层调整取数。后续阶段（ranking 维度骨架注入）见 ADR-0009 实施顺序。

已确认 topic plan 之后若用户才补足竞品，文章开始边界允许一个受限快照前移：用最新 KnowledgeAuthority 快照替换 ranking item 的 roster 输入事实（`fullName / shortNames / relatedBrands / competitors`），并要求其他原 planned facts 在新快照中仍逐项同值；随后 operation 固化新知识版本。其他事实有变更时仍 fail closed，不能借竞品补充绕开选题事实血缘。

批准提交成功后，`articles/approve` 路由在同一 Session 投递纯隐藏 `XIAOJING_ARTICLE_APPROVAL_DECISION` reminder（只携带 operation/article identity、revision、status、approvedRevision 与 knowledge version），唤醒 agent 从权威审校结果继续进入渠道分发规划，不重复询问已裁决文章。提醒入队失败不回滚已提交的批准，响应显式返回 notification 状态。

## 正文、版本与恢复

SQLite 只保存正文相对路径、SHA-256、revision、origin、review/model audit 和引用。正文写入 BrandWorkspace 管理的磁盘目录：草稿按 `operations/{operationId}/articles/{articleId}/v{revision}.md`，批准副本按 `articles/approved/{articleId}/v{revision}.md`。写入使用 create-new 语义；若中断后目标已存在，仅当字节完全相同才幂等恢复，不同内容一律冲突且永不覆盖。

生成、人工编辑和单篇重新生成只追加新 revision。批准会复制并校验 exact draft revision 的正文/hash，设置稳定 `approvedRevision`，并创建确定性的 `article-{articleId}-v{revision}` artifact。后续生成只产生新草稿，不能修改批准副本或重复创建原批准 artifact。大正文不进入普通 projection、Session transcript 或无关 Agent prompt。

单篇 Provider 失败只记录该文章的 `generation_failed` 与 attempt reason；其他文章继续。重试只 claim exact article/revision，不重跑整个 operation。此 operation 不调用 baseline、渠道召回、分配、OSS、发布或监测。后续分发必须从批准 artifact 进入 `PublishScheduler`，本 Ticket 不建立该路径。

## 聊天修订（票 38，ADR 0003）

待审批（draft_ready）文章的标题与正文可经通用闸门修订工具 `revise_gate_content`（gate=`article`，仅 modify）修改：handler 走既有 `ArticleGenerationService.edit` 语义（新版本行 origin=`user-edited`、状态回到 draft_ready、必须重新过审批门），`edit` 携带 `reason`（用户指令原文）写入版本行 `model_audit_json.revisionReason`。已批准/生成中/审校中/已弃用的文章按 `target_not_pending` 拒绝（Rust edit 对 `discarded` 回 `article_edit_status_invalid`）；delete/add 不是本闸门语义，回执 `action_not_supported`——「不要这篇」的落点是批准卡上的 discard 终态，不是删除。批准卡（`ArticleApprovalGateCard`）在待审批、投影含 drafting 篇目或本卡有单篇重试在途时每 3s 轮询 `/articles/latest` 采信新投影（批准继续走既有审批门）；单篇重试是 fire-and-forget，行内「重新生成中」由本地重试票据驱动，轮询投递 attempt 递增且落定的投影时自动退出等待；收到 `article_retry_in_progress` 也以 observed 票据进入同一等待态。等待期间隐藏旧的 failureReason，超过 5 分钟提示「生成时间较长，可稍候；也可再点一次重试」并恢复重试按钮。**批准选择（票 #34，默认全选）**：待审稿逐篇 checkbox，选择态存「取消勾选集合」——后到的新待审稿（如重试落定、聊天修订回到待审）自动入选，不需要与投影同步的 effect；「批准所选（N 篇）」只提交勾选篇目（N=0 时禁用），未勾选篇目留在待审；「不要这篇」两步确认（防误触）后走 `/api/xiaojing/articles/discard`。

批准卡同样提供卡内直改（js_ai 门卡交互）：正文可展开/收起（按 revision 缓存），draft_ready 稿件可在卡上进入编辑并经 `POST /api/xiaojing/articles/edit`（不带 `reason`，`model_audit_json` 保持 `{}`）落成 `user-edited` 新版本，标题取正文首行 H1；「批准所选」按各篇最新 revision 逐篇走既有 `articles/approve`（单篇失败不阻断其余），批准后的稿件才是进入分发计划的事实依据；批准 + 弃用收束后卡片呈现「已全部处理（批准 X · 弃用 Y）」，弃用稿不再提供勾选、编辑与重试入口。

## 测试

- shared pure tests：direct spec、五类 prompt、plain Markdown、事实/广告法/结构与 reflection 双门。
- Node unit tests：并发上限 5、单篇失败隔离、exact retry、reflection 失效和虚假通过均 fail closed。
- Rust owner tests：confirmed selected-only、固定 operation spec/knowledge version、CAS/attempt 恢复、正文幂等落盘、批准 copy/hash、批准后再生成稳定、artifact 去重与跨 Session 读取；生成子集（命中/未选/重复/空）、discard 状态机（可弃态、approved/planned 拒绝、CAS、终态关闭编辑/复审/重试、approved∪discarded∪failed 收束）与 status CHECK 存量重建。
- Renderer DOM/client tests：单篇查看、编辑、重生成、批准所选（默认全选、取消勾选不提交）、两步弃用与收束态、exact identity/revision 请求。
- 路由接缝回归：批准后注入决策回执信封、响应携带 notification 状态、投递失败不影响决策成功（`src/server/__tests__/xiaojing-decision-receipt-gates.integration.test.ts`）。
