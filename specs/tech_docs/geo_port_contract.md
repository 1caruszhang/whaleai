# GEO 移植契约与行为一致性基线

本文定义小鲸同学首次移植必须保持的结构化行为。Owner、进程边界和主数据流以 `specs/ARCHITECTURE.md` 为准；机器可读常量以 `src/shared/geo/portContract.ts` 为准。本契约审计自 `js_ai` 的 `dev` 分支提交 `936b971751f029e9d67fc86356e8234569e33570`，后续不能用旧 PRD、Skill 文案或演示页面覆盖该提交的代码事实。

## 使用方式

每个 GEO 切片的纯逻辑测试应直接导入 `GEO_PORT_CONTRACT`，在公开 seam 比较该切片实际使用的策略、阈值或状态转换。评分、混合检索、渠道质量、渠道配额、四路召回合并、五类内容覆盖、文章人工闸门、模型路由和确定性发布还提供纯 reference evaluator，worked cases 会真正执行这些算法，而不是只比对静态 JSON。

独立预期值位于 `src/shared/geo/__fixtures__/jsAiDevBehavior.ts`，来源固定为本契约标注的 js_ai 提交。fixture 不导入生产契约或 evaluator，避免实现与期望一起变化后测试仍然通过；`src/shared/geo/jsAiBehaviorContract.test.ts` 只通过公开纯函数执行这些 worked cases。专用入口：

```bash
npm run test:geo-contract
```

GitHub Actions 在通用 unit gate 之前单独执行该入口，使 js_ai 行为偏差在 CI 页面上有独立、可定位的失败步骤；通用 unit gate 仍会再次覆盖这些文件，防止专用脚本与默认测试集合发生漂移。

该入口运行在 unit project；`src/test/setup-no-egress.ts` 会阻断所有非 loopback 网络，契约模块本身也不读取环境变量、凭据、文件或计时器。因此测试不得依赖真实 Provider、真实密钥或用户目录。

## 领域边界与 Owner

- `BrandWorkspace` 是唯一品牌业务边界；不存在第二层 Project 业务实体。
- `Session` 只拥有聊天与 Agent 上下文，一个 Session 可产生多个 `GeoOperation`，但不能直接改共享品牌事实。
- `GeoOperation` 是一次更新知识、生成问题、生成文章、发布或探测；明确请求只组合必要步骤。
- GeoOperation 的机器可读 lifecycle、input/artifact reference、safe checkpoint、下一轮分支和 confirmation authority 由 `src/shared/geo/operation.ts` 单点定义；完整不变量见 [`geo_operations.md`](./geo_operations.md)。
- `KnowledgeAuthority` 是接受权威事实的唯一业务入口。模型和 UI 只能提交候选事实或结构化用户决策；同一事实键冲突与并发版本由它裁决。
- `GeoArtifact` 是带版本、来源和知识版本的业务产物。历史文章与问题不会因知识更新被静默改写。
- 监测调度记录仅保存唤醒引用，不复制 GEO 阶段、Operation 或产物状态；调度本身不形成独立产品界面，品牌级「效果」入口只做只读展示与显式启用门。
- `PublishScheduler` 确定性拥有付费订单的幂等、排期、提交、同步与重试；模型不能临场替代它。

品牌知识切片的可执行边界由 [`knowledge_authority.md`](./knowledge_authority.md) 细化：事实 identity 由标准化 `subject / predicate / scope / effectiveFrom / effectiveTo` 共同决定；模型推断、用户陈述和普通聊天发现都先停在待确认候选。用户只可通过结构化卡片选择 `keep-current / adopt-new / split-scope / reject-candidate`；确认 `adopt-new` 后，同键同值只合并来源，同键异值才替换并升版。所有成功裁决都带 expected current version 并进入审计。

## 阶段、依赖与确认门

首次移植保持以下语义链，而不是照搬旧 UI 的 Active Project 全局指针：

| 步骤                  | 主要依赖                           | 产物 / 停点                                                                                       |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| material-to-facts     | 品牌材料                           | 14 字段档案候选、逐字段 provenance、原文可重组的知识切片；不完整或含推断值时停在档案确认          |
| keyword-mining        | 已确认档案                         | core / scene / longtail 搜索词与 high / medium / low 热度档；停在关键词确认                       |
| question-construction | 已确认档案和关键词                 | 最多 20 个自然语言问题，PRED-1 评分，状态为 pending；停在问题选择                                 |
| topic/type/title      | 已选问题                           | 语义聚类后的综合主题；每主题推荐 1–5 个类型并保证批次五类覆盖；每对主题/类型生成 3–5 个标题供选择 |
| content-production    | 已确认事实、类型模板、选中标题     | 单次模型调用生成 channel-agnostic Markdown；停在草稿确认，不进行渠道改写                          |
| review                | 已确认草稿和事实                   | 风险扫描 fail-closed；硬主张先归一化精确核对、再用 LLM 做语义兜底；风险命中优先于批准             |
| global-channel-recall | 全部已选问题、文章主题、真实渠道池 | 与正文生成并发执行四路召回，输出全局渠道候选池                                                    |
| channel-assignment    | 已确认候选集与文章                 | topic 优先、hitCount 兜底、渠道不复用的一对一映射；停在分配确认                                   |
| distribution-plan     | 已确认映射                         | 主稿只上传 OSS 一次并计算 `nextPublishAt`；停在分发计划确认，不创建付费订单                       |
| publish               | 已确认分发计划                     | `PublishScheduler` 创建、提交、同步和重试幂等订单                                                 |

文章主状态保持 `planned → drafting → draft_ready → reviewing → approved → published → assigning → scheduling → monitoring → done`；异常态为 `pending_confirmation`、`generation_failed`、`rejected`。`draft_ready → reviewing` 只消费草稿确认，不能重新生成刚确认的正文。

基线探测差异注记（用户已拍板）：js_ai 把“优化前检测”嵌在主流程内；本产品主链（full-optimization，18 步）不内嵌基线探测，基线是品牌级「效果」入口的按需动作，`performance-inspection` 直接意图保留条件化补充探测。勿据此在主链恢复基线步骤。

五类内容的唯一集合是 `guide / showcase / ranking / news / news_light`。旧注释中的“四类”“六类”以及旧调研里的“每主题最多三类”均不是当前代码事实；`dev` 当前实现允许每主题 1–5 类，并对整批五类覆盖做下限补齐。

## 算法常量

### 问题与知识检索

- PRED-1 `match = round(clamp(max(0, cosine) × 100))`。
- `potential = round(clamp((1 - nearestPoolCosine) × 50))`；空问题池使用 nearest similarity `0`，得到中性 `50`。
- 无可用向量时 match / potential 均为 `50`。两者之和 `>=150` 为 high，`>=100` 为 medium，否则 low。
- Embedding 使用 Volcengine `doubao-embedding-vision` 能力槽位、`/embeddings/multimodal`、2048 维；该端点一次请求只允许一段文本并返回一个融合向量。默认并发 2，额外重试 2 次（500ms / 1000ms）；失败降级为确定性 FNV-1a term-frequency 单位向量。具体 endpoint id 和密钥不是契约常量。
- 知识召回默认 topK 5，先取 `topK × 3` KNN 候选，再以 vector 0.45 / lexical 0.35 / title 0.12 / metadata 0.08 混合打分，经过治理过滤、冲突消解后取 topK；中文词法使用 2/3/4-gram。

### 四路渠道召回

| 路径         | 信号                               | 权重 |
| ------------ | ---------------------------------- | ---- |
| 1 passive    | 每个已选问题被豆包真实引用的 URL   | 0.4  |
| 2 active     | 一次全局编号主题的渠道召回         | 0.2  |
| 3 fallback   | 企业关键词到已批准资源池的保底召回 | 0.1  |
| 4 preference | 人工维护偏好清单到已批准资源池     | 0.3  |

四路按 resource id 求并集并只累加不同路径权重，再与真实超级媒介资源池相交。匹配先按注册域 eTLD+1，再按中文名称兜底；名称阈值 0.55，passive 域命中最多 3 个、active 最多 2 个、纯名称兜底最多 1 个。passive 每问题最多 15 条、同注册域最多 3 条；fallback 最多 50 条。

质量过滤在对齐和比例分配之前执行：已知正数发布率必须 `>=70`，发布率 `0` 表示未知而不是失败；价格按数字解析并必须 `<150`。最终最多 30 个，媒体 / 自媒体目标配额 20 / 10；一侧不足时剩余名额流向另一侧。排序依次为路径加权分、命中路数、名称。

### 发布护栏

- 一篇文章只分配一个渠道；渠道改写已退役。
- 草稿池默认上限 50；scheduler 默认每 60 秒扫描。
- 媒体默认每日 5 次，自媒体 3 次。达到日限后排到本地次日 00:01；不支持周末的渠道跳到周一。
- 幂等键为 `article-{articleId}-channel-{resourceId}-v{version}`，默认版本 1；payload 用 `SHA-256(title|content|remark)`。
- 可重试错误最多额外重试 3 次，退避 1 / 5 / 15 分钟；分发失败不能回滚文章已发布状态。

## 模型、联网、Prompt 与并发

模型路由顺序为显式阶段配置 → 阶段默认 pin → 当前 active model。`question_pool` 与 `title` pin 到 `volcengine / doubao-seed-2-0-lite-260428`（mini 变体未在 paygo 账号开通，`/chat/completions` 返回 404，故与关键词挖掘同走 lite 档），`draft` pin 到 `volcengine / doubao-seed-2-0-pro-260215`；pin 后只调用该模型，不走 failover。抽取默认 `deepseek-chat`。关键词挖掘单独走 Volcengine paygo `/api/v3`，以 body parameter `enable_search=true` 联网，不能误发到 agent-plan endpoint。

Prompt 文字可以演进，但以下结构不能变：档案输出 14 字段及逐字段来源；关键词输出三类 JSON 和热度档且不含品牌名；Question 只含 text / recommended，不携带内容类型；主题合并覆盖每个输入问题；标题遵守五类 style、长度、品牌与 ranking 当前年份规则；正文输入已确认事实和类型模板，输出 plain Markdown 且不得残留 `【】`；全局召回输出 channel name / URL / topicNumbers，非法 topic number 只丢编号、不丢合法渠道。

主题计划的结构化 projection 额外固定携带 source question-pool id/revision、knowledge version、topics、items、provider snapshot 与 model attempts。每个 item 必须绑定 `sourceQuestionIds / topicId / contentType / typeSelectionReason / plannedFacts`；`plannedFacts` 的 key、predicate 和 normalized value 必须逐项来自该 plan 固定的 knowledge snapshot，模型不得自由发明。增删改、局部重生成与确认全部使用 `planId + expectedRevision` CAS；confirmed plan 不可再 mutate，局部重生成必须原样保留 user-edited 或 approved 项。

文章 operation 只能固定消费 confirmed plan 的 selected approved items，或固定的 direct `count / themes / contentType / constraints` spec；两者都在开始时钉住 knowledge version 和逐篇 planned facts。每次生成、编辑、重生成和审核都携带 exact operation/article identity、expected revision 与持久化 claim token。正文由 Rust 磁盘 owner 保存，SQLite 仅存路径/hash/版本/audit；批准复制 exact draft revision 为 immutable approved body，后续草稿不能覆盖。正文生成与审校不得隐式启动 baseline、渠道召回、发布或监测。

并发发生在明确层级：文章生命周期默认并发 5、其余 FIFO 排队且单篇失败隔离；每文章 Supervisor 互斥；embedding 并发 2 并保持输入顺序；豆包 App passive 召回因 2 QPS 使用两槽，普通 web_search 可全并发；双腿信源并行；全局召回与正文生成 fire-and-forget 并发，passive 与 active 召回也并行；品牌写串行、读并发。

## 明确不移植

- 历史测试数据库和旧用户数据。
- 演示品牌、测试品牌与演示 runner。
- GeoDemoDashboard 的 mock 数值或任何由假指标驱动的决策。
- 为旧 Active Project、旧四/六分类、退役渠道改写等保留的兼容逻辑。
- “效果报告自动规划下一轮”能力；当前只有真实探测与证据化报告，不能把演示看板伪装成闭环策略。
