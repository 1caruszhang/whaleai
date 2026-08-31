# 文章审核门重设计：纪律类规则改构造保证、有界修复兜底、确定性门退守实体完整性

## Context

2026-08-31 复盘「10 篇审核 8 篇过不了」，定位出四个结构性矛盾（反思 LLM 审核已于 2026-08-18 裁定停用，本次只涉确定性门 `deterministicArticleReview`）：

1. **约束是概率的，验收是精确的。** 生成侧用长契约 prompt + temperature 0.85 束缚模型；验收侧逐字符精确（ranking 六维要求归一化后逐位相等且全篇同序）。模型 compliance 是概率事件，门是全有全无，高失败率是该组合的数学必然，而非 bug。
2. **失败即丢弃，无修复环节。** 一处品牌名未加粗 = 整篇拒掉，用户点重试 = 模型全价重掷（8K token，ranking 另有联网搜索）。而最常触发的规则恰恰机械可修：加粗是确定性变换，H2 差一个是补一段的事。
3. **只有 ranking 在生成期有格式预检**（`generateOne` 内 blocking 即整次失败）；guide/showcase/news 的格式违约要等到批准卡才爆出——审核通过率低的主战场在批准门。
4. **无失败遥测。** `review.issues` 已随文落库，但无按规则聚合，历次调规则均在盲调。

用户在本次对谈中澄清一项需求偏差：ranking「六家等长」**并非严格等长，相似即可**——现行逐字符同序门属超严执行。

本 ADR 经设计对谈收敛，三项用户裁决见 Decision §1–§3。

## Decision

### 1. 品牌名加粗改为管线自动加粗（用户裁决 2026-08-31）

加粗从「模型纪律」降格为「管线保证」：`generateOne` 在 `parseGeneratedArticleBody` 之后，用 `projectBrandProfile(plannedFacts)` 投影出的全称/已确认简称清单，对正文（标题行除外）所有逐字出现自动包 `**`。跳过：已有加粗块内（防双重包裹）、链接 URL 与图片 alt、围栏代码块。生成 prompt（品牌身份块 `renderBrandIdentityBlock`）中的加粗纪律同步删除；门中加粗检查保留为断言（生成路径理论上恒过）。人工编辑路径不自动改写：批准门加粗检查对人工编辑稿仍 blocking，维持「审核门是人工编辑唯一防线」的既有立场。

- 否决「保留模型纪律 + LLM 修复」：多一次有条件 LLM 成本且修复仍可能失败，劣于零成本确定性变换。
- 否决「降为 advisory」：发布物可能真出现未加粗品牌名，GEO 实体强调打折扣。

### 2. ranking 六维结构改为「维度骨架注入 + 集合相等门」（用户裁决 2026-08-31）

生成正文前先跑一次维度选定小调用（输入行业/主题/地域/品牌事实，输出 6 个维度名 JSON 数组，校验唯一性与长度），**字面注入** prompt：六家逐字使用该清单。模型从「默写自己的内部计划六遍」变为「抄眼前一份清单」；维度**内容**仍完全自由。多样性由「每次现选」保证（与叙事种子 ADR-0006 §3 同哲学，重试重发一组；跨文章不同质，同篇内六家共用一套维度本就是产品要求）。

门同步放宽，落实「相似即可」：`exactParallelStructure`（逐字符同序）改为**归一化后维度集合相等**——顺序不敏感，每家仍须 6 条、六家集合一致。服务端持有注入清单时直接对照清单校验（比与第一家比对更强）；清单随文章落库，批准门复检（含人工编辑）可用；存量稿无清单时退回与第一家集合比对。实体名单门（第 1 家目标品牌、第 2–6 家恰为五家已确认竞品）**维持 blocking 不动**。

- 否决「注入 + 保留精确同序门」：注入后精确本可轻松满足，但对模型微调措辞零容忍，与「相似即可」裁决不符。
- 否决「不注入、只放宽门」：零成本但六家不漂移仍靠模型自觉，重试率高于注入方案。
- 否决「分段装配（每家单独生成再拼装）」：最稳但 6–7 次调用、延迟与成本明显上升，注入已把同序性变为构造保证。

### 3. 有界修复 pass：条件触发、1 次为限（用户裁决 2026-08-31）

生成期确定性修复（§1 加粗、§4 配额裁剪）之后若仍有 blocking 项（H2 差额、showcase 无列表等结构问题），带**具体违规清单**跑一次定向修复调用（「补一个覆盖 X 的 H2」粒度），修完重跑 `parseGeneratedArticleBody`（H1 标题、占位符等校验不豁免）并复检；仍违规则才判失败。无 blocking 不调用，平均成本远低于被停用的反思审核（彼为每篇必跑）。整篇重掷降为该 pass 的下策。

### 4. 配图超配额改为确定性裁剪

生成路径上超出 `ARTICLE_IMAGE_QUOTA_BY_TYPE` 的占位符按序裁掉多余项，而非拒稿。scheme 逃逸用法维持 blocking（受控 uri 契约，见 ADR-0008 T4）；人工编辑路径超配额仍 blocking（不改写用户编辑）。

### 5. 生成期预检扩展到全类型

现行仅 ranking 有的生成期确定性预检，随 §3 修复 pass 一并扩展到五类型：parse → 确定性修复 → 确定性审核 → （blocking 时）1 次修复 → 复检 → 落库/失败。格式违约在生成期就地消解，不再漏到批准门爆出。

### 6. 批准卡分区：blocking 与 advisory 分列

`ArticleApprovalGateCard` 现将全部 issues 混排（无 severity filter），advisory 红字加剧「都过不了」观感。改为两区：「为何不能通过」（blocking）与「发布前建议人工处理」（advisory，硬主张无依据、广告法禁词），advisory 可带警告批准。

### 7. 失败遥测

backend 按 `category × policyVersion` 聚合 `review.issues` 计数并暴露查询。此后规则分层调整（何种问题降 advisory、修复预算是否放宽）皆有数据支撑。

## Considered Options

- **反思 LLM 审核恢复为 blocking**：否决——2026-08-18 已裁定暂停；语义判断归人，门的职责收缩到机器可精确断言的实体/格式完整性，方向不变。
- **审核期自动修复人工编辑稿**：否决——`finishReview` 无 body 持久化通道（需扩 HTTP 契约），且静默改写用户编辑有语义风险；编辑器保存时前端自动补粗列为二期可选。
- **广告法禁词确定性替换**：否决——替换需语义（「最好」的改写依语境而异），机器动正文风险大于收益；维持 advisory + 人工改写。
- **静态行业维度模板池**：否决——跨文章同质化；维度现选保多样性（§2）。
- **自动重掷 N 次再报失败**：否决——每次全价重掷，ranking 浪费最大；定向修复一次远廉于重掷一遍。

## Consequences

- 门语义收敛为「实体完整性 + 不可修契约」断言：保留 blocking 的是【】占位符、图片 scheme 逃逸、ranking 实体名单，及修复失败后的 H2 下限/showcase 列表；纪律类（加粗、六维同序）转为构造保证后理论上不再触发。
- 改动面：`src/shared/geo/articleGeneration.ts`（新增 `autoBoldBrandMentions`、配额裁剪、集合相等门、ranking 契约改注入措辞、`buildArticleGenerationMessages` 输入扩展）、`src/server/geo/article-generation.ts`（generateOne 重排为修复管线、维度选定小调用、维度清单落库、全类型预检）、`ArticleApprovalGateCard.tsx`（分区渲染）、backend（遥测聚合端点）、生成 prompt（删加粗纪律）。
- 成本：ranking 每篇多一次几百 token 的维度选定调用；修复 pass 仅在有 blocking 时发生。停用的反思审核不恢复。
- 风险登记：自动加粗对品牌名出现在链接/alt/代码块内的跳过规则需测试覆盖；注入清单未落库的存量 ranking 稿走第一家集合比对回退。
- `specs/tech_docs/article_generation.md` §批准段与实现脱节处（「段落不超过 3 句」已于 2026-08-18 随 advisory 化废除）随本 ADR 一并订正。

## 实施顺序（三阶段，每阶段独立可交付、不劣化现状）

> **状态（2026-09-01）**：三阶段已全部实施并随本轮提交——Phase 1/2/3 代码、测试与 spec 同步均在其中；Phase 3 未等遥测闸门，经用户指示直接实施。评审修复一并落地：遥测问题计数升级为 policyVersion × severity × category 交叉、维度排除集补竞品名、盲区遍历与区间剔除抽取共享原语（`textSpans.ts` / `brandMentionLines`）。

**Phase 1 —— 零 LLM 成本（预计吃掉大半失败率）**
1. `autoBoldBrandMentions` + 配额裁剪，挂入 `generateOne` parse 之后；
2. 批准卡 blocking/advisory 分区；
3. backend 失败遥测聚合；
4. spec 订正（`article_generation.md` 批准段）。
测试：`articleGeneration.test.ts` / `article-generation.unit.test.ts` 补加粗跳过案例（标题、已有加粗、链接、alt、代码块）与配额裁剪案例。

**Phase 2 —— 有界修复 pass + 全类型生成期预检**
`generateOne` 重排为 §5 管线；修复 prompt builder（输入正文 + 违规清单，输出整篇修正稿）；modelAudit 记录 `repairUsed`。修复调用默认复用 generation 槽位，maxTokens 可低于 8K（实施时定）。

**Phase 3 —— ranking 骨架注入 + 集合相等门**
维度选定小调用（JSON 数组校验、重试重发）、契约措辞替换（`CONTENT_TYPE_CONTRACTS.ranking.format` 的「自选维度」条款改为「使用注入清单」）、门替换为集合相等 + 注入清单对照 + 存量回退、维度清单随文落库。
