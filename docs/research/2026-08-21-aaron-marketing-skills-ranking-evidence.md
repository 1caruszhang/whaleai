# Aaron Marketing Skills 对排行榜竞品证据链的可借鉴性调研

调研日期：2026-08-21
上游仓库：[`aaron-he-zhu/aaron-marketing-skills`](https://github.com/aaron-he-zhu/aaron-marketing-skills)
固定源码版本：[`c8e809a7924354387ec54437ebeb2e0782e80382`](https://github.com/aaron-he-zhu/aaron-marketing-skills/tree/c8e809a7924354387ec54437ebeb2e0782e80382)
证据范围：只使用该仓库当前源码、README、测试样例与版本历史。仓库 issue 中没有检索到与 competitor/comparison/listicle/evidence 直接相关的条目。

## 结论

可以参考，但应参考它的**职责分层、证据标记、单一事实源和独立审校**，不能把它现有的竞品 skill 或 connector 直接当成“任意地域、任意行业必定得到 5 家正确竞品”的实现。

最值得借鉴的是：

1. 把竞品研究、页面构建和发布审校拆成独立阶段，不让写作模型同时决定竞品是谁、事实是什么、文章能否发布。
2. 为每个竞品维护一个可复用的事实文件，页面只能消费这份事实源；竞品主张必须带来源或明确处于未解决状态。
3. 对复数替代方案明确要求“自己的产品在第一位，后面放真实选项”。
4. 将身份事实与工作过程证据分离：已接受的实体身份由唯一 owner 管理，普通 skill 只能提交 proposal；审校器只判断，不能反写事实。
5. 缺证据应当形成显式 `Unknown/NEEDS_INPUT`，而不是让模型补造。

但鲸杉 GEO 需要比该仓库更强的生产不变量：**确认卡必须先产生并确认至少 5 家合格直接竞品；排行榜名单必须程序固定为目标品牌 + 5 家已确认竞品；每家核心内容必须来自冻结证据包；三处确定性校验失败都不得产出可见成功稿。**

## 1. 上游仓库的架构与 skill 组织

### 1.1 不是单一写作 prompt，而是分阶段营销工作流

仓库将 120 个 skill 分成 7 个营销 discipline 和一个 protocol 层；SEO/GEO 使用 `Survey → Implement → Tune → Evaluate` 的 SITE 循环。Survey 负责关键词、竞品、SERP 和内容缺口，Implement 负责写作和页面构建，Tune 负责发布前质量门，Evaluate 负责效果与权威度。这种分层避免“研究、创作、审核”混在同一轮生成中。[README 架构总览](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/README.md#L26-L41)；[SEO/GEO SITE 循环](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/README.md#L13-L43)

所有 skill 统一采用七段 contract：触发条件、Quick Start、Reads/Writes/Promotes/Done-when、handoff、数据源、执行步骤、下一 skill；skill 还声明 discipline 和 phase。这使上游研究产物和下游消费者之间存在明确契约，而不是依赖上下文偶然保留。[统一 skill contract](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/README.md#L194-L208)

### 1.2 事实 owner、工作证据和审校结果明确分开

该仓库把 canonical truth 放在 append-only registry event stream 中，projection 只是可重建视图；普通 producer 只能 `propose`，owner 才能 `accept/reject/upsert`。WARM 研究产物可以提出事实，但不会因保存而自动成为权威。[状态模型及 registry 不变量](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/references/state-model.md#L1-L43)；[WARM 证据与权威边界](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/references/state-model.md#L71-L100)

`entity-registry` 是 machine-facing identity 的唯一 owner，管理 canonical type、display name、domain、aliases、sameAs、disambiguation evidence 等；相似名称或 logo 不足以合并实体，必须有 verified cross-link 或用户确认。每次观察还需记录来源、日期和 evidence type。[Entity Registry 的 owner 边界](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/protocol/entity-registry/SKILL.md#L29-L40)；[实体核验程序](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/protocol/entity-registry/SKILL.md#L73-L85)

实体消费者只能读取 accepted projection、记录 revision/offset、拒绝 tombstoned/stale/conflicting identity，并对缺失字段提问而不是猜测。这一做法与鲸杉的 `KnowledgeAuthority`/知识版本设计高度相容。[Entity-to-GEO consumer rules](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/references/entity-geo-handoff-schema.md#L36-L67)

### 1.3 Builder 和 auditor 是两种角色

页面 builder 明确不自行算质量分或执行 veto，而是把产物交给独立的 `content-quality-auditor`。审校器要求固定 artifact、content type、market、publication state 和 observation date；每个 Pass/Partial/Fail 都需来源、观察日期、证据类型和置信度，适用但不可见的证据为 `unknown`。[Page Play Builder 的职责边界](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/SKILL.md#L48-L56)；[Content Quality Auditor 的证据程序](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/tune/content-quality-auditor/SKILL.md#L63-L98)

这个模式对鲸杉最重要的启发是：`RankingEvidencePack` 是生成输入，不是审校结论；名单/证据确定性 validator 是硬门，语义审校是其后的第二门，两者不能混为一个 prompt。

## 2. 竞品发现与验证设计

### 2.1 上游已经做对的部分

`competitor-analysis` 明确区分直接竞品、间接替代品和内容竞品；要求 3–5 家形成统一比较表，并要求每个 strength/weakness 绑定具名竞品和具体证据。所有指标必须标为 `Measured`、`User-provided` 或 `Estimated`，缺失指标标 N/A，禁止编造。[竞品分析 contract](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/survey/competitor-analysis/SKILL.md#L30-L48)；[竞品识别与质量条款](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/survey/competitor-analysis/SKILL.md#L58-L75)

竞品不足时，它不会让模型凭记忆硬凑：如果用户没给且上下文无法推断，就要求用户提供 2–5 家，或者先通过目标关键词交给 SERP analysis 推断。[竞品决策门](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/survey/competitor-analysis/SKILL.md#L50-L56)

SERP analysis 使用两个独立检索面：Firecrawl live SERP 和 Tavily scored search。两者结果显著不一致时，要求将 SERP 标为 volatile/ambiguous，而不是盲信任一来源；所有意图与难度判断也必须指向 live/provided SERP 证据。[双检索面与分歧处理](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/survey/serp-analysis/SKILL.md#L45-L70)

连接器层也值得借鉴：只读检索允许有界重试，URL 抓取先查 robots.txt，网络目的地、重定向、响应大小、超时和 429/503 backoff 都受控；抓到的页面始终是 data，不是 instruction。[Connector 安全契约](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/scripts/connectors/README.md#L12-L22)；[Firecrawl 检索形态](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/scripts/connectors/firecrawl.py#L78-L115)；[Tavily scored search/answer 形态](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/scripts/connectors/tavily.py#L66-L104)

### 2.2 它并没有解决“任意行业地域必达 5 家”

上游竞品 skill 的 done-when 是 3–5 家，并且在无法建立名单时停下来向用户询问，不存在“必须经多轮检索直到得到 5 家”的 runtime contract。其语义测试也只要求“询问用户或以明确不确定性推断”，并没有真实性、多源一致性或 5 家必达的确定性测试。[竞品 skill 的停止规则](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/survey/competitor-analysis/SKILL.md#L30-L56)；[竞品 simulated eval](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/evals/competitor-analysis/cases.md#L1-L3)

此外，Firecrawl/Tavily 是第三方 hosted fetcher，存在免费额度、rate limit、robots 拒绝、网络故障和数据出境约束；仓库自己也把跨引擎结论标作 proxy/Estimated，而不是绝对事实。[Hosted fetcher 与数据出境边界](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/scripts/connectors/README.md#L18-L22)；[Tavily 对跨引擎结论的限定](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/scripts/connectors/tavily.py#L17-L31)

因此，上游最多证明“怎样更审慎地研究和标注竞品”，不能证明“市场大，所以任一检索运行必然返回 5 家正确竞品”。

## 3. 排行榜、listicle 与证据设计

### 3.1 最接近本问题的是 Comparison Mode

Comparison Mode 规定先为每个竞品建立一份 single-source competitor data file，包含定位、目标人群、定价、特性、真实优缺点、适合/不适合对象、评论投诉、迁移信息和 sources；所有引用该竞品的页面都复用该文件，更新一次即可传播到所有页面。[单一竞品事实文件](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/references/comparison.md#L13-L23)；[数据 schema](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/references/comparison.md#L63-L87)

对 plural alternatives，它明确要求 4–7 个真实选项，并将自己的产品放在第一位；页面结构先定义筛选标准，再列选项、汇总表和逐项拆解。[Plural alternatives 的自己第一与真实选项规则](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/references/comparison.md#L32-L38)

它还要求承认真实竞品优势、说明自身限制，逐条标记事实 provenance；最终检查要求每条竞品主张有来源或标记 `[needs source]`，不得虚构定价、功能和评论数字。[诚实规则与 source check](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/references/comparison.md#L13-L23)；[页面交付清单](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/references/comparison.md#L89-L101)

### 3.2 Listicle 本身只是内容模板，不是真实性系统

`content-writer` 的 listicle blueprint 只有“summary table → criteria → repeated item cards → comparison → top pick”，它没有固定数量、目标品牌第一、已确认竞品集合或实体去重等结构不变量。[Listicle blueprint](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/content-writer/references/content-structure-templates.md#L16-L38)

写作 skill 要求事实、统计或引语必须有引用或 `[needs source]`，并建议外部权威链接，但仍允许产出带未解决标记的草稿，再交给 auditor。这适合通用编辑流程，不足以满足鲸杉“成功生成的排行榜绝不缺竞品、不能出现未证实内容”的产品承诺。[Content Writer 的证据边界](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/content-writer/SKILL.md#L59-L87)

### 3.3 通用审校强调证据，但没有 roster-specific veto

CORE-EEAT 对排行榜有有用的通用规则：数据精度、引用密度、来源层级、claim-evidence 邻接、实体精度和内部一致性；缺失的适用项为 `unknown`，完整评分要求全部适用项有观察值。[Referenceability 项](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/references/core-eeat-benchmark.md#L73-L92)；[Unknown 与完整覆盖](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/references/core-eeat-benchmark.md#L141-L160)

但它的硬 veto 只有标题承诺不符、重大内部矛盾和应披露而未披露；不存在“第 1 家不是目标品牌”“2–6 不是精确已确认竞品”“名单重复/缺失”等 roster-specific veto。[CORE-EEAT veto 列表](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/references/core-eeat-benchmark.md#L185-L199)

仓库的 page-play semantic eval 会检查“不虚构定价/功能”“承认竞品优势”“构建 single-source data file”，但这仍是 simulated seed case，而不是一个验证固定 1+5 名单和 36 个证据格的确定性程序测试。[Page Play simulated eval](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/evals/page-play-builder/cases.md#L1-L16)

## 4. 建议迁移到鲸杉 GEO 的设计

### 4.1 保留本项目现有 owner，不复制上游 registry

不应把上游的 `memory/events/entities.ndjson` 机制原样移植进来；鲸杉已有更符合桌面产品边界的 owner：

- `BrandWorkspace` / `KnowledgeAuthority` 继续拥有已确认的目标品牌与竞品事实。
- `Session` 继续拥有尚待用户裁决的候选和确认卡状态。
- 一次排行研究和正文生成的不可变输入、检索 attempts、冻结证据包由 `GeoOperation` 拥有。
- Renderer 只渲染 projection，不新增第二份竞品 authority。

应该借鉴的是“sole writer + proposal/accept + versioned projection”的语义，而不是上游具体文件格式。

### 4.2 将 `competitors: string[]` 深化为逐实体候选与证据

建议在候选阶段使用以下语义结构；最终被采纳的竞品名称仍写回现有 `enterprise-profile.competitors` 权威事实，证据记录与该知识版本/候选 ID 关联：

```ts
type CompetitorCandidate = {
  candidateId: string;
  canonicalName: string;
  aliases: string[];
  primaryDomain?: string;
  relationship: "direct" | "indirect" | "content" | "excluded";
  eligibility: {
    sameScale: EvidenceDecision;
    sameOffering: EvidenceDecision;
    overlappingMarket: EvidenceDecision;
    customerChoosesOne: EvidenceDecision;
  };
  identityEvidence: EvidenceRef[];
  relationshipEvidence: EvidenceRef[];
  discoveredBy: "material" | "web_leg" | "user";
  status: "discovered" | "verified" | "confirmed" | "rejected";
};
```

其中 `EvidenceRef` 至少固定 `url/title/excerpt/retrievedAt/sourceType/queryId`；不得只把多个竞品合并为一条数组和一个组合 excerpt。上游“一竞品一事实文件”和 entity identity 的思路可以直接转化为“一竞品一候选证据单元”。

### 4.3 把 web_leg 从一次 enrichment 改成有界研究计划

建议流程：

1. 从材料与已确认知识取候选，并排除自名、供应商、设备品牌、合作方、客户、平台和上下游。
2. 建立 query matrix：地域别名 × 具体产品/服务 × 同行/哪家好/推荐/对比/榜单，再加“目标品牌 + 竞争对手/替代”。
3. 至少使用两个独立检索面；结果分歧时标记歧义，不直接晋升 verified。
4. 对每个候选单独抓取第一方页面和独立第三方页面，分别证明实体真实存在、具体业务重叠、地域/服务覆盖和竞争关系。
5. 去重与实体消歧后，只允许 `relationship=direct` 且四项 eligibility 均有证据的候选进入确认卡推荐区。
6. 候选少于目标缓冲数时，按确定性地域扩圈继续查询，并把 `requestedMarket` 与 `effectiveMarket` 明示给用户；不得标题写区县、证据却只支持全省。
7. 到达时间/请求/结果预算仍不足时，返回 typed `competitor_discovery_insufficient`，保留已找到候选供用户补充或重新研究；不能让写作阶段补位。

这里的“百分百”应定义为：每次都百分百得到一个确定状态——`ready_for_confirmation` 或带精确缺口的 `insufficient`；不能定义为第三方互联网在有限时间内百分百返回正确的 8 家。

### 4.4 确认卡先确认实体，再冻结排行榜名单

确认卡应展示 8–12 个候选缓冲，每家独立显示：

- 名称、官网/主要实体指针；
- 直接竞品四条件的结论和证据；
- 请求地域与实际服务范围；
- 发现来源（材料/web_leg/用户）；
- 来源 URL、标题、摘录、抓取日期；
- 系统推荐/歧义/排除原因。

用户最终必须保留至少 5 家 `confirmed direct competitors`。确认后由纯策略函数生成并冻结：

```ts
type RankingRoster = readonly [
  TargetBrand,
  ConfirmedCompetitor,
  ConfirmedCompetitor,
  ConfirmedCompetitor,
  ConfirmedCompetitor,
  ConfirmedCompetitor,
];
```

固定约束：索引 0 为知识版本中的目标品牌；索引 1–5 为五个已确认直接竞品；canonical identity 去重；不得包含目标品牌别名；名单与 `knowledgeVersion`、确认 decision IDs 和确认顺序绑定。写作模型无权选人或重排。

### 4.5 用 `RankingEvidencePack` 取代“给模型一组名字”

借鉴上游 single-source competitor data file，但收紧为不可变、可验证的 operation input：

```ts
type RankingEvidencePack = {
  knowledgeVersion: number;
  roster: RankingRoster;
  requestedMarket: string;
  effectiveMarket: string;
  dimensions: readonly [Dimension, Dimension, Dimension, Dimension, Dimension, Dimension];
  cells: RankingEvidenceCell[]; // 6 家 × 6 维
  evidenceFrozenAt: string;
  packHash: string;
};
```

每格必须绑定 `entityId + dimension + claim + evidenceRefs + confidence + observedAt`。维度应在确认名单后根据共同证据覆盖选择；缺证据的格子不能让模型用行业常识补写。如果产品契约要求六家同样六维，则只有 36 格达到最低证据门槛才进入生成；否则继续研究或明确阻断。

### 4.6 程序固定骨架，模型只负责表达

程序先按 `RankingRoster` 生成六个不可变 H2 和六维表格/事实骨架：

1. 目标品牌；
2. 已确认竞品 A；
3. 已确认竞品 B；
4. 已确认竞品 C；
5. 已确认竞品 D；
6. 已确认竞品 E。

模型只负责引言、过渡、证据范围内的事实表达和“适合谁”说明，不能新增、删除、合并、改名或重排实体，也不能把产品名替代企业实体。上游 plural alternatives 的“自己第一 + 真实选项”是设计启发，但鲸杉要把它从 prompt 规则升级成生成器数据结构与 validator 不变量。

### 4.7 三个确定性硬门 + 一个语义门

1. **生成准入前**：知识版本中有目标品牌和至少 5 家 confirmed direct competitors；roster 去重且没有自名；36 格证据完整。
2. **正文持久化前**：恰好 6 个排行 H2；实体逐字/规范化匹配 frozen roster；顺序固定；每家都有相同六维；每个核心 claim 能映射到 evidence cell。失败时 `article_ranking_roster_invalid` 或 `article_ranking_evidence_incomplete`，不得保存为成功草稿。
3. **批准前**：复用同一 validator，防止人工或 Agent 修订破坏名单与证据映射。
4. **语义审校**：再检查有没有夸大、张冠李戴、将来源推断写成事实、地域口径漂移和不公平贬损。语义门不能代替前三个纯规则门。

## 5. 不可照搬项与风险

### 5.1 `[needs source]` 对鲸杉成功稿过于宽松

上游允许 builder 先交付带 `[needs source]` 的页面，再在 handoff 中解决。这是通用 agent 工作流的合理折中，但鲸杉排行榜是核心商品能力，最终成功稿不能带未解决占位或无来源主张；应在生成前阻断，而不是写完后提醒。[上游允许 source flag 的 done-when](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/seo-geo/implement/page-play-builder/references/comparison.md#L15-L23)

### 5.2 `Estimated` 不能作为竞品资格或排行榜核心事实

上游广泛允许 Estimated，只要求标签诚实。鲸杉可以把 Estimated 用于检索排序或待确认解释，但不能用于证明“这是直接竞品”或支撑文章的核心六维事实。确认卡要让用户确认实体选择，但用户点击也不能把模型估计自动变成网页事实。

### 5.3 通用 CORE-EEAT 不能替代业务不变量

上游的 80 项审校适合内容质量，但 roster 不是通用内容评分问题。若把“目标品牌第一、2–6 为精确五个已确认竞品”塞进通用反思 prompt，仍会得到概率性结果；必须写成项目自己的纯策略 validator 和回归测试。

### 5.4 Keyless connector 不能成为可用性承诺

免费额度、rate limit、robots/TOS、第三方数据出境和页面变动都会导致搜索或抓取失败。可以借鉴连接器的重试、安全和多源策略，但生产 SLA 需要可观测的 provider admission、预算、失败码、fallback 和重试计划，不能依赖仓库脚本的 keyless 宣称。

### 5.5 Entity Registry 不等于竞品关系证明

Wikidata、sameAs 或官网只能证明实体是谁，不能证明其与目标品牌在同地域、同赛道、同体量且客户会二选一。实体 identity evidence 与 competitor relationship evidence 必须分别建模；尤其本地小微服务商很可能没有知识图谱条目。

### 5.6 上游没有真实业务结果保证

仓库 README 明确说明其发布属于 engineering validation，真实项目 outcome 尚未验证；semantic cases 也标为 simulated。因此它可作为设计样本，不能作为“该方案已证明排行榜正确率”的证据。[上游对验证边界的声明](https://github.com/aaron-he-zhu/aaron-marketing-skills/blob/c8e809a7924354387ec54437ebeb2e0782e80382/README.md#L155-L187)

## 6. 推荐落地优先级

### P0：先写不可绕过的契约和测试

- `prepareRankingRoster()`：目标品牌 + 精确 5 家 confirmed direct competitors。
- `validateRankingEvidencePack()`：6 × 6 单元、实体绑定、来源、地域口径、冻结版本。
- `validateRankingArticleRoster()`：六个 H2、顺序、去重、逐实体六维和 claim-evidence mapping。
- 覆盖选题 Top-N 裁剪、直达生成、确认选题、人工修订和批准重审全部入口。

### P1：把竞品确认卡改成逐实体证据卡

- 材料无竞品或少于缓冲目标时强制进入 web_leg。
- 每家独立 evidence，不再只有合并数组 excerpt。
- 明确 ready/ambiguous/excluded/insufficient，用户最终确认少于 5 家时排行榜不可进入生成。

### P2：实现有界多源研究和透明扩圈

- query matrix、双检索面、实体抓取、四条件验证、去重消歧。
- 记录 query、provider、attempt、error、retrievedAt、requested/effective market。
- 失败显式化并允许从最小 retry unit 恢复。

### P3：冻结证据包并重构排行榜生成

- `RankingEvidencePack` 绑定 immutable knowledge version、roster、36 格与 hash。
- 程序生成不可变六家骨架，模型只在证据范围内组织语言。
- 生成完成先过纯规则门，再显示草稿。

### P4：加入时效与纠错闭环

- 定价、营业状态、服务范围等高变事实设较短 freshness window。
- 旧证据包不改写历史文章；新生成必须重新研究或显式复用仍新鲜证据。
- 用户纠错写回 `KnowledgeAuthority` 的候选/裁决链，不能只改某篇文章文本。

## 最终判断

`aaron-marketing-skills` 能很好地支持以下设计决策：

- 竞品研究、页面构建、质量审校分层；
- 一竞品一事实源、主张逐条带 provenance；
- 自己排第一、其余必须是真实选项；
- owner 管 canonical truth、普通生产者只提议；
- 缺证据显式 Unknown/NEEDS_INPUT，不能编造。

它不能直接支持的承诺是：

- 任意地域/行业有限时间内自动检索到 5 家正确竞品；
- 排行榜必定严格为目标品牌 + 5 家指定竞品；
- 六家每一维都由可追溯证据支撑；
- 生成或编辑后名单绝不会漂移。

这些必须由鲸杉自己的 `CompetitorCandidate → 用户确认 → RankingRoster → RankingEvidencePack → deterministic validators → semantic audit` 生产链补齐。换句话说：**借鉴上游的 operating model，不照搬其 prompt contract；把它的“诚实约束”升级为鲸杉的类型、owner、版本和硬门。**
