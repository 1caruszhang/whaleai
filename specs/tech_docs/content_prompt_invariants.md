# 内容生成提示词不变量与偏离登记

本文档是内容生成链路「业务不变量清单」与「对 js_ai 合法偏离登记表」的唯一真源（ADR-0006）。提示词文本本身以代码为准——`src/shared/geo/` 的 prompt builder 与纯数据常量；本文档锁定它们必须承载的语义要素，以及每次偏离 js_ai 的裁决依据。修订不变量或新增偏离必须先改本表并升级 `policyVersion`。

## 四组业务不变量

不变量来源：js_ai ADR-0027（关键词驱动）、0028（提示词批次/五类/禁词清单）、0029（问题合并）、0030（竞品红线/标题品牌分布）、0033/0035（榜单文与格式纪律）；按 ADR-0006 系统性重写文本、保留全部已裁决语义。

### 搜索词挖掘（keyword-search 槽，lite + enable_search）

1. 第一人称业务陈述开场；「优先真实搜索行为（联网搜索验证），而非泛泛的行业常识」。
2. **热度证据纪律（修正三）**：热度档位必须以联网搜索证据为据——搜不到真实使用痕迹的词宁标 low 或不产出，严禁凭感觉把拼接词标 high。
3. **地域条件化（修正四，声明的服务范围 = 锚 + 上限）**：`deriveServiceScope` 以用户声明的服务范围为主锚与白名单上限（粒度保留，声明「新都区」不升格为成都市；多段声明全入白名单、首段为主锚），地址仅在声明不可用时兜底提取城市短名；「全国/线上/不限」类声明 = 无地缘模式（地域按真实用户语言自然呈现、不强制锚，且不落地址兜底）。有锚时 prompt 写明地域白名单与越界禁令（白名单之外的城市、省份、大区名一律禁止）；城市级锚 scene 以城市为根联网验证直接下一级真实地名裂变，**区县级锚不再向下裂变到街道乡镇**。上限 enforcement 只在提示词层（用户裁定），解析层不加地域门。
4. 三类词递进：core 挖品类 → scene 叠场景处境 → longtail 叠多元搜索意图；**数量指引** core 4–6 / scene 8–12 / longtail 12–18（消除下游「每词至少 1 条 + 总量截断」的结构冲突）。
5. **品牌词（修正三开禁）**：品牌相关词至多 1 条（「XX品牌怎么样」形态，须联网验证有真实搜索量才产出）；解析层确定性截断（超出静默丢弃）。竞品名任何情况永禁。
6. **词库沉淀（修正三提前）**：池确认后本批词写入 `brand_keyword_library`（池型合并只增不清；未裁决的词不是品牌资产）；重挖时注入已有词库做增量挖新（不重复产出）。
7. 确定性解析防线：词内禁分句/列举标点、长度 ≤30、去重（含与已入库词去重）。
8. prompt 注入 `renderMiningProfileBlock` 业务画像块（products/coreAdvantages 主参考、customerCases 辅参考）。

### 问题生成（generation 槽，pro）

1. 关键词驱动：只从挖掘词派生，不杜撰词里没有的信息。
2. 最高原则：通顺、口语化的完整中文；宁可少加东西，不拼半通不通的句子。
3. 推荐尾巴禁令：绝对禁止把「推荐/哪家好/找哪家」机械拼接到已完整的句子末尾。
4. 每个挖掘词至少转出 1 条；recommended 标 2–3 个（纯曝光价值，不驱动类型）。
5. 多样性：scene 不套固定句式，每条尽量不同问法。
6. 有地域锚时问题表述不越出锚范围，不引入其他城市/地区名（修正四，提示词层约束）。
7. 全档案画像块（`renderFullProfileBlock`）注入；词库按分类带中文标签与 ●/◐/○ 热度标记；recent 已选问题注入防重复；maxTokens 4096。

### 选题类型与标题（generation 槽 + `purpose: title-planning`，lite）

1. 五类语义（guide/showcase/ranking/news/news_light）与整批覆盖下限后处理（不强配额）：guide 与 ranking 各 ≥3、showcase/news/news_light 各 ≥2，合计 ≥12 篇（用户裁决 2026-08-26）；主题数不足时受每主题最多五类的结构上限约束，尽力补齐。
2. showcase 唯一带目标品牌；ranking 不带任何品牌名——目标品牌全称/简称、竞品与关联品牌（代理/经销、非竞品）都禁（用户裁决 2026-09-01，提示词与校验侧同口径）——且必含代码注入的当前年份；不得编造年份/政策/事件。标题 prompt 与 `validateTitleCandidates` 校验集的品牌名统一走 `resolveBrandName`（知识库已确认身份事实 fullName[0] → shortNames[0] 优先，workspace 名仅在无任何身份事实时兜底；炊班长事故裁决 2026-08-19）。
3. few-shot 占位符式（【地域】【行业】【目标品牌】）+ 忠实各类型品牌分布（guide 1/3、showcase 2/3、ranking 0/3、news 3/3）+ 反抄录禁令。
4. 风格中文释义（question/seo/attractive/professional）；「像真人会搜的，不是关键词堆砌」「有点击吸引力但不标题党」。
5. 极限词统一清单 + 竞品名红线 + 长度按类型；确定性校验 fail-loud。**条目级降级（用户裁决 2026-09-01 少报错）**：两轮（初试 + 带反馈修正重试，解析失败与校验失败共用）中任一轮仍有 ≥1 条合格候选即按降级候选集放行（3 条下限不再杀整批），两轮幸存集都空的条目剔除、全部条目剔除才整批失败。**行业命中按业务词锚集（用户裁决 2026-08-19 修正，v2）**：锚 = 行业词全部 ≥4 字后缀（「汽车音响改装」含「音响改装」——丢品类前缀但保业务动作）∪ 品牌已确认业务词汇（产品 + 衍生关键词，附去前导数字/符号变体「360°全景影像」→「全景影像」）；标题逐字包含任一锚即合格——「无损改装」「音响改装升级」「全景影像改装」是合法业务替换，「汽车音响店」这类丢业务动作的写法不合格，贴膜/洗车类跑题拦截；地域仍逐字。锚源与逐字比对源复合值（含分隔符，如「医美/轻医美」「华熙/爱美客」）按分隔符静默拆 token：require 类 OR 语义（任一 token 命中即合格），forbid 类逐 token 禁（整串 includes 对复合写法永假会漏放进竞品名），服务端 WARN 留痕；forbid 类清单 token 以 ≥2 字为限（单字 token 会误拦含该字的正常标题）。拒因计数与幸存候选随错误结构化透出（如 `industry=3,forbidden=1`）；选题段 policyVersion 现为 v3（v2=业务词锚集，v3=12 篇覆盖下限）。
6. system persona + maxTokens 2048。

### 正文生成（generation 槽，pro）

1. 事实纪律：只使用已批准事实；未知即省略；具体数字、日期、奖项/认证/机构名称必须可溯源（确定性 claim 门）。
2. 事实三层纪律：实体层（名称/地址/联系方式/行业/竞品）原样使用不得转述（品牌名保真；加粗由管线自动补全，ADR-0009）；事实层表达完全自由（泛化修辞、模糊化、资质修辞放行），语义不得加码；种子层（衍生关键词）不得成句断言。
3. 格式契约（确定性可校验，正文 policyVersion v3）：per-type H2 下限（guide/showcase 3、ranking 6、news 两类 2）、品牌名加粗全覆盖（2026-09-01 起为管线自动加粗 + 门断言；段落长度等表达层要求 2026-08-18 起不机械拦截）；ranking 六家等长平行结构改为集合相等门（ADR-0009：逐家覆盖同一套 6 维、顺序不敏感、对照随文落库的注入清单，存量稿回退与第一家比对），第 1 家必须是目标品牌，第 2–6 家必须恰为五家已确认有效竞品，竞品内部顺序不限，workspace 自名、已确认别名和 relatedBrands 均不计入有效竞品；news 两类导语 5W1H、news 主体 3–4 递进小标题（≤8 字）。
4. 表达层：叙事视角种子（12 组 {切入角度, 开篇写法, 小标题措辞倾向}，操作内洗牌发牌、发尽重洗）只影响开篇与表达；「骨架非填空」指令（模板=参考骨架，重组结构、换叙述顺序、调小标题措辞）。
5. 输出控制：plain Markdown、首行 H1=指定标题逐字、无【】占位符；maxTokens 8192 / temperature 0.85 / top_p 0.9。
6. 正文恒注入品牌身份块（`renderBrandIdentityBlock`，实体层子集 + 简称白名单纪律；加粗纪律已移除，改管线自动加粗——ADR-0009）；素材边界仍由 plannedFacts 圈定。`品牌：` 行与 direct 标题的品牌名取值与选题同口径（`resolveBrandName`：知识库身份事实优先，workspace 名仅兜底），不与已确认身份事实冲突。
7. 篇幅与节奏（js_ai 模板已裁决语义回迁，v2）：四类总字数 1800–2100（guide/showcase/news/news_light）、ranking 全文 ≤2500（引言 ≥100、每家约 320、每条 50–55 且单条 ≥45）；news 分段导语 ≤200/主体 ≈1400/结尾 ≤250；可读节奏每约 200 字变换角度。
8. 关键词融入（js_ai 已裁决语义回迁，v2）：全局基线约每 300 字 1 次；guide 每 500 字 1 次、news 每 300 字 1 次、news_light 每 200 字 1 次且密度 2%–5%；guide/ranking 首段嵌入 1–2 个关键词；地域/核心关键词首次出现及关键论据处加粗，单一加粗实体（品牌名与 ranking 维度名除外）≤3 次，H2 不加粗。
9. ranking 编排细则（js_ai 已裁决语义回迁，v2；维度来源 2026-09-01 改骨架注入）：维度由生成前维度选定小调用现选（lite 路由 `purpose: "dimension-planning"`，每篇现选、重试重发，解析校验 fail-loud）并字面注入正文 prompt，六家逐字共用；标题数字=正文陈列项数；全文倒数第三段选型建议（隐性条件式点首位，数字与陈列位 1 对账）；目标品牌最强维度置首、竞品两三条专精优势加一两条客观局限。
10. 配图契约（ADR-0008 T4，v6；配额 2026-08-31 按类型修订，裁剪 2026-09-01 ADR-0009）：候选池非空时正文 prompt 注入材料图片候选清单（图片 id + 描述 + 类型标签 + 来源材料名的纯文字清单，模型不看图片本体，注入上限 50）与配图纪律（类型配额 `ARTICLE_IMAGE_QUOTA_BY_TYPE`：guide/showcase 8、news/news_light 3、ranking 1，按候选池弹性取小、宁缺毋滥、只在语义相关处插图、alt 文本由模型撰写）；正文以标准 Markdown 图片语法输出 `![alt](material-image://<图片id>)` 占位符。`parseGeneratedArticleBody` 放行该受控 scheme 的图片语法，scheme 逃逸用法（裸文本/普通链接/坏 id）拒绝（`article_generation_image_placeholder_invalid`），【】禁令不变；生成路径超配额按序裁掉多余占位符（宁裁不拒），确定性审核门对占位符语法违例与超类型配额阻断（覆盖人工编辑路径）。候选池空或读取失败降级为零配图继续生成。

## 合法偏离登记表（相对 js_ai）

| # | 偏离 | js_ai 行为 | 小鲸同学 行为 | 依据 |
|---|---|---|---|---|
| D1 | 问题/标题/反思 maxTokens | 未显式设置 | 4096 / 2048 / 2048（挖词 4096 为 js_ai 对齐，其余为本工程发明） | ADR-0006 §2 |
| D2 | 事实三层纪律 | 必填字段「精确引用不得改写」 | 实体原样、事实层可改写不加码、资质修辞（S4）放行 | ADR-0006 §4 |
| D3 | 成就类硬主张判定 | 无确定性 claim 门 | 具体命名/数字才须溯源；泛化修辞放行 | ADR-0006 §4 执行面 |
| D4 | 地域锚定 | `serviceArea \|\| '本地'` 单锚 | 单锚语义 + 声明优先：`deriveServiceScope` 以声明的服务范围为主锚与白名单上限（粒度保留），地址仅兜底；全国/线上类声明=无地缘模式；上限 enforcement 仅提示词层 | ADR-0006 修正四 |
| D5 | 叙事视角种子 | 6 组纯随机、仅开篇维度 | 12 组、批内洗牌不重复、两维（开篇+小标题措辞倾向） | ADR-0006 §3 |
| D6 | 格式确定性校验 | ranking 专属，其余纯 prompt | 全类型：per-type H2 下限、品牌加粗（ADR-0009 起为管线自动加粗 + 门断言） | ADR-0006 §3；ADR-0009 |
| D7 | direct 路径标题 | 无 direct 路径 | 每 theme 一次标题调用（3–5 候选→校验→取首），fail-loud，无模板兜底 | ADR-0006 §2 |
| D8 | 标题模型档位 | pro（article_generation 槽） | lite（paygo 未开通 mini；titlePlanningModel） | 移植现状，延后裁决 |
| D9 | policyVersion | js-ai-dev-* 各段异名 | xiaojing-content-prompt 统一命名；正文段 v2（回迁 js_ai 篇幅/关键词/ranking 编排纪律）、选题段 v2（行业核心词子串 + corrective 重试，2026-08-19），挖词/问题段 v1 | ADR-0006 §6；本文档 v2 修订 |
| D10 | 画像注入形态 | 15 字段档案块 | 同左，分段渲染（mining/full/identity 三渲染器，纯数据投影） | ADR-0006 §2 |

## 合法偏离登记表（续，修正三新增）

| # | 偏离 | js_ai 行为 | 小鲸同学 行为 | 依据 |
|---|---|---|---|---|
| D11 | 品牌词 | 词面全禁品牌名 | 证据开禁、硬上限 1 条（解析层截断）；竞品永禁 | ADR-0006 修正三（用户裁决） |
| D12 | 词库沉淀时机 | 挖完即存（keyword_library） | 池确认后才写入 `brand_keyword_library`；重挖注入已有词库增量挖新 | ADR-0006 修正三（用户裁决） |
| D13 | 产量纪律 | 挖词无数量指引、下游硬截断 | 挖词数量指引（4–6/8–12/12–18）+ 问题生成配额策略（高热度与意图多样优先） | ADR-0006 修正三（F2/F6 缺陷修补） |
| D14 | 正文事实来源 | 生成模型离线，只吃已批准事实 | ranking 类型整篇联网（enable_search）：竞品条目联网取材消除结构性编造；目标品牌段落仍受「只使用已批准事实」提示词纪律约束，网络素材渗入风险由用户明示接受；非排行类型保持离线。正文段 policyVersion v3→v4 | ADR-0007 Decision 4（用户裁决） |
| D15 | ranking 名单构成 | 五家陈列位全部来自已确认 competitors（直接层） | 两层名单（ADR-0007 Decision 6）：直接层（三同全中）优先，不足 5 家时用 potentialCompetitors（潜在层：相近场景/替代品类）按序补足到 5；跨层归一名嵌套互斥，身份/关联主体排除两层共用（TS `mergeRankingCompetitorTiers` 与 Rust `valid_ranking_competitors` 同构，契约用例共享 rankingCompetitorContractCases.json）；标题红线名单同步含两层。正文段 policyVersion v4→v5 | ADR-0007 Decision 6（用户裁决 2026-08-30） |
| D16 | 正文配图 | 纯文字正文，无配图约定 | 材料图片候选清单注入正文 prompt（纯文字清单，模型不看图本体）+ 配图纪律（类型配额：guide/showcase 8、news 两类 3、ranking 1，按池弹性取小、宁缺毋滥、语义相关处插图、alt 由模型撰写）；正文输出 `material-image://` markdown 图片占位符，发布期由 Rust 替换为真实 URL（#15）；占位符语法/校验用例共享 materialImagePlaceholderContractCases.json（TS/Rust 同构，先例 rankingCompetitorContractCases.json）。正文段 policyVersion v5→v6 | ADR-0008 Decision 3（2026-08-31） |
| D17 | 品牌加粗执行方式 | 无对应机制（prompt 纪律 + 门拦截） | 加粗从模型纪律降格为管线保证：parse 后 `autoBoldBrandMentions` 自动补粗（盲区：标题行、围栏代码块、图片语法、链接 URL），身份块 prompt 删加粗纪律（简称白名单保留）；配图超配额按序裁剪（宁裁不拒）；生成期全类型确定性预检 + 一次有界修复 pass（`buildArticleRepairMessages`，修复稿过同一 parse/审核门，modelAudit 记 `repairUsed`）；审核门加粗检查保留为断言并对人工编辑路径仍 blocking；批准卡 blocking/advisory 分区；新增审核失败遥测 `/api/brand-articles/review/stats`。正文段 policyVersion v6→v7 | ADR-0009 Decision 1/3/4/5/6/7（2026-09-01） |
| D18 | ranking 六维来源 | prompt 要求模型自选并保持六家同序，门逐字符同序验收 | 维度骨架注入：生成前维度选定小调用（lite 路由 `purpose: "dimension-planning"`）现选 6 维字面注入 prompt，六家逐字共用；清单随稿落库（`geo_articles.ranking_dimensions_json`）；门改集合相等（顺序不敏感，对照注入清单，存量稿回退第一家比对）。契约措辞从「自选」改为「逐字使用注入清单」。v7 覆盖 | ADR-0009 Decision 2（2026-09-01） |

## 显式延后（下一批裁决）

- ranking 文末 JSON-LD ItemList 结构化数据块（js_ai 模板 rule 20）：与本工程「纯 Markdown、无代码围栏」输出契约冲突，且 小鲸同学 尚无预览页 `<head>` 注入消费方；落地需正文抽取与发布管线配套，延后单独裁决。
- 标题模型档位 lite→pro 与标题子串硬校验放宽（D8）。
- 问题池语义合并阶段（js_ai Question Merge 综合主题句）。
- 打分基准：potential 对全量已有池（当前仅对最近一次已选）。
- sourceKeywords 逐字过滤放宽（当前静默丢弃无逐字来源候选）。

## 验收

- 确定性：各段 prompt 的单测断言不变量在场（`questionPool.test.ts`、`topicPlan.test.ts`、`articleGeneration.test.ts`）。
- 人工评审：`specs/eval/content-prompt-eval.md` 三个合成品牌样本全链跑评（通顺度/多样性/意图覆盖/格式达成）；js_ai 同样本对照可选。
