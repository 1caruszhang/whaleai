# 品牌材料导入与企业 Profile 候选抽取

## Owner 与数据流

品牌材料属于 `BrandWorkspace`，不是 Session 私有附件，也不是 Agent 可自由读取的本机文件。固定链路为：

```text
Renderer structured operation / xiaojing product tool
  → current Session Sidecar route
  → Node MaterialImportService
  → authenticated Management API
  → Rust BrandWorkspaceStore (file IO + project.sqlite)
  → Node parser → Ticket 05 extraction port
  → Ticket 06 KnowledgeAuthority.propose
  → structured knowledge card decision
```

- Renderer 只提交显式 `workspaceId / sessionId` 与文件选择结果、粘贴文本或官网 URL，不读取文件字节，也不直写 SQLite。
- Node 只编排单份材料。普通文件路径原样交给 Rust；Node 和小鲸 Agent 工具都不打开本机路径。
- Rust 是 `materials/` 文件 IO、no-follow 打开、原子复制/写入、SHA-256、处理状态和 `project.sqlite` 的唯一 owner。
- Rust 返回给 Node 的内容读取端点位于现有 Node→Rust Management API 内，按材料 ID 鉴权并限制为 20 MiB；响应不含本机路径。它不是 Renderer 可直连的大载荷数据面，也没有新增进程或通信模式。

所有请求同时绑定 Sidecar immutable identity、generation、逻辑 Session 和 workspace path。品牌查找不能依赖 catalog 的 current workspace；材料投影与当前请求 workspace 不一致时在解析前失败。

## 异步处理与状态轮询

LLM 抽取可能远超转发控制面请求的 120s 代理超时，因此导入与重试拆成两段：

1. **请求内只做有界存储**（文件复制 / 文本落盘 / 官网抓取，无 LLM），按输入顺序返回 `{entries: [{ok:true, material} | {ok:false, errorCode}]}`。
2. **抽取在 Sidecar 内按 Session 串行的后台队列执行**；逐材料落 `awaiting-confirmation` / `failed` 终态并尽力推进 GeoOperation 里程碑。队列只活在 Sidecar 进程内，材料与 attempt 状态由 Rust 持久化。

Renderer 对处理中行每 3s 轮询 `/api/xiaojing/materials/status`（带 `materialIds`）；缺省 `materialIds` 的同一路由返回本 Session 最近材料（Rust `/api/brand-materials/list`，按 `updated_at` 倒序、上限 10），用于材料请求卡重挂载（transcript 重放）后恢复在途行与确认卡。非处理中材料在响应中携带批量确认卡投影——确认卡数据以权威候选为源重建，不依赖一次性响应存活。挂载恢复接管的在途行允许直接单材料重试：其原后台队列可能已随 Sidecar 进程消失。

抽取链路（含竞品富化的检索与二次抽取）带 10 分钟硬超时信号；provider 挂起按 `model_failed` 落回 failed 终态，材料不会永远停在 processing。Renderer 传输层失败（代理超时 / IPC / 网络）显示专用 `material_request_failed`，与服务端业务错误码严格区分。

## 产品入口与 Session 归属

真实用户入口全部在聊天内（ADR 0005，取代票 27 的输入区常驻形态）：上传由 agent 判断需要后经 `request_brand_material` 工具发起的**材料请求卡**承载（`MaterialRequestCard`，渲染在发起那轮助手消息内、随 transcript 持久），卡体提供粘贴文本、官网 URL 与文件选择三条路径，使用当前 Tab 的 `apiPost` 和固化 `sessionId`；聊天输入框上方的常驻导入区域已删除，零消息空态由起始建议中的材料引导语承接，显隐不存在任何 renderer 侧机械条件。会话附件（文件/图片）路线保持——附件由 Agent 经 `read_session_file` 判断后走 `import_pasted_material` 导入并停在知识裁决门；二进制附件由 Agent 调用 `request_brand_material` 转入材料请求卡。唤起标准（系统提示词硬规则）：制定计划时品牌无已确认知识或明显过薄、用户明确要求补材料、不可直读的二进制品牌材料；操作进行中缺材料佐证不唤起，按来源层级以 AI 补全行推进由用户裁决兜底；材料是否够用在制定计划时判断一次，判断结果只决定计划是否包含材料收集步骤——随计划执行的请求卡在放行后按步骤顺序发出，计划停在认可门期间不得提前出现（用户主动要求补充材料不受此限）。右侧工作台不挂任何材料面板，材料入口不出现在工作台，也不作为 GeoOperation 闸门。`BrandWorkspace` 只可由该 Tab 的 `workspacePath` 精确匹配得到，不能用全局 current workspace 补位；没有匹配品牌时材料请求卡禁用上传并说明原因。转录重放重新挂载卡片即恢复在途行与确认卡。

- 文件通过现有 Tauri OS dialog 选择；Renderer 只把路径作为结构化操作参数交给 `importBrandMaterialFiles`，不打开、不解析也不记录路径。界面只显示 basename。
- 粘贴资料和官网 URL 分别调用 `importBrandMaterialText`、`importBrandMaterialWebsite`，不伪造用户消息来触发导入。
- 批量文件逐项投影处理中、成功或失败、`materialId` 与候选数；一项失败不遮蔽其他结果。只有已取得 `materialId` 的失败项显示“仅重试此项”，并只调用单材料 retry API（同样只启动后台抽取，立即返回）。
- 材料请求卡只出现在真实 Session 的转录里（agent 调用先于任何上传发生），deferred chat 阶段不存在可提交的导入 UI；恢复窗口内提交仍由 Session identity 守卫拦截。
- 批量确认卡是权威候选的投影，呈现为字段行复核卡（分层默认与整卡全量采纳语义见
  `knowledge_authority.md` 与 ADR 0003）：裁决提交后卡片保留、整体变暗并只读（行内呈现逐条裁决结果）；入口重挂载时按 Session 材料列表重建卡片（含已裁决的只读卡）。裁决经 decide 路由提交后，隐藏 reminder 汇总权威结果并唤醒主聊天继续推进当前 GeoOperation。卡片待决期间用户可随时在聊天中以自然语言下达修改（改/删/增候选），Agent 经通用闸门修订工具执行并记 `user-stated`，卡片按既有 3s 轮询重渲染，服务端改动覆盖卡片本地暂存编辑。

## 三类输入与原始材料

支持：

1. 文件材料：`txt / md / markdown / csv / json / html / htm / xml / log / pdf / docx / xlsx / pptx`；
2. 粘贴文本：保存为 UTF-8 `txt`；
3. 官网 URL：只抓取公开 HTTPS 的 `text/html / application/xhtml+xml / text/plain`，原始响应先保存为 `html`。

该集合来自 js_ai 当前企业 Profile 业务链路及本项目现有解析依赖。图片虽在 js_ai 中可分类，但当前链路明确不用于 Profile 抽取，因此本切片不把图片或旧 Office 格式扩成通用文档平台。

原文件写入当前品牌 `<BrandWorkspace>/materials/<material-id>.<ext>`。`brand_materials` 仅记录应用内相对路径、显示名、类型、字节数、SHA-256、安全来源投影、状态、尝试次数和固定错误码；不记录原始本机路径。`brand_material_processing` 逐次记录单份材料的 attempt、Session、候选 ID、状态和固定错误码。临时文件在同目录写完并 `sync_all` 后 rename，DB 失败则删除已复制文件。

材料删除有两个入口：材料请求卡条目上的「移除」按钮（`POST /api/xiaojing/materials/delete`）与 Agent 的 `delete_brand_material` 工具（按 materialId 或精确显示名解析，重名/无匹配时返回本 Session 材料列表让用户选择，不猜）。删除语义（Rust `delete_brand_material` 单事务）：删材料行（attempts 随 FK 级联）、未决候选（awaiting-confirmation/conflict/rejected，先摘 `knowledge_candidate_revisions` 与 `knowledge_decisions` 的无级联外键引用）与磁盘文件；已采纳进确认知识的候选（adopted/kept-current/split-scope）作为裁决历史保留，`knowledge_current_facts` 不动。`processing` 中的材料拒绝删除（`material_processing_active`），文件缺失不阻断删除。

官网来源入库前删除 query 与 fragment。粘贴/抓取正文和解析文本不会进入普通日志；KnowledgeAuthority 的 material raw-input 也只保存材料 ID、字段和 provenance 标识，证据正文只保留在原材料与该候选需要的最小 excerpt 中。

## 官网网络护栏

官网抓取复用 `tool-attachments.ts` 的 URL 词法校验与 DNS pinning dispatcher，并在每次 redirect 后重新执行完整校验：

- 只允许 HTTPS，拒绝 credentials、localhost、loopback、私网、link-local、metadata 与 IPv6 ULA/link-local；
- `redirect: manual`，最多 3 次；每个目标重新解析、重新 DNS 校验并使用钉死已验证 IP 的 dispatcher；
- 15 秒组合超时；响应体按 chunk 读取，解压后累计最大 2 MiB，不能依赖 `Content-Length`；
- 只接受上述文本内容类型，拒绝缺失/其他类型；
- 默认测试注入 fake fetch 与 fake dispatcher，绝不访问真实官网。

## 企业 Profile 契约

字段沿用当前 js_ai 普通源码的 15 个字段：

`fullName / shortNames / addresses / serviceArea / industry / products / relatedBrands / competitors / targetCustomers / coreAdvantages / trustEndorsements / customerPainPoints / customerCases / contactInfo / derivedKeywords`。

必要字段仍是 `fullName / industry / products / coreAdvantages`。来源层级保持 `extracted(3) > asked(2) > inferred(1)`：

- `extracted` 必须携带逐字 `sourceExcerpt`，否则降为 `inferred`；
- 模型抽取不得生成 `asked`，收到非法/asked 值按 `inferred` 处理；
- provenance 逐候选写入 KnowledgeAuthority 的 candidate/source，模型产物仍统一是待确认候选，不能凭来源级别直接成为 authority。

同 Session 的待确认候选重试只允许 `inferred → asked → extracted` 方向提升来源及 excerpt，低等级结果不能覆盖高等级来源。用户经卡片「更改」或聊天修订的候选记 `asked`（用户补充），与该提升方向一致。

每个字段显式属于品牌整体 scope，或属于 BrandWorkspace 已登记的某一产品线；未知产品线降为品牌 scope。品牌与产品线使用不同事实 identity，因此可并存且不会串值。

## 竞品两腿契约（js_ai enrich real competitors）

- **抽取提示词**：逐字段显式定义与边界（js_ai geo-fact-extraction 契约）——事实类字段（fullName/shortNames/addresses/serviceArea/industry/contactInfo）逐字复制、没有就省略；判断类字段（products/coreAdvantages/targetCustomers/customerPainPoints/customerCases/trustEndorsements/relatedBrands/competitors）材料没有时可推断并标 inferred（唯一例外见下：competitors 禁止推断）；derivedKeywords 一律 inferred；数组字段全部要求原子项。
- **contactInfo 数组契约**：电话号码是数组字段——多门店/多号码各占一项全部保留；`contactInfo` 与 `addresses` 同属「一品牌多实体联系点」的字段形态。
- **同 (field, scope) 合并护栏**：抽取契约是每字段每 scope 一条事实；模型重复输出同字段同 scope 多条时（如多门店电话各成一条），`parseProfileFacts` 落库前合并为一条——数组字段拼接去重、标量字段保留 provenance 层级最高且先出现者、合并后 provenance 整体取较低层级（与竞品富化合并的保守契约一致）。否则同一 fact key 会出现多条待决候选，整卡确认时第二条必然触发 `knowledge_version_conflict`（首条 adopt 后版本已 +1）。
- **确定性自名过滤**：`parseProfileFacts` 在落库前对 `relatedBrands`/`competitors` 值剔除品牌名、同批抽出的 fullName 与 shortNames（大小写不敏感、双向子串——目标品牌「九味牛」连「成都九味牛食品」一起拦下）；全部被剔除时整条丢弃，不产出空数组候选。提示词只降频，这层是结构不变式（js_ai dedupeAndFilterCompetitors 契约）。
- **原子化兜底拆分**：模型违反「数组保持原子项」契约（如把全部竞品拼成一个顿号长串）时，`cleanValue` 按中英文列表分隔符（、，,；;）把复合串拆回原子项并去重；`customerCases` 是散文式描述，句内逗号不是列表分隔，不拆。
- **relatedBrands 消歧**：合作商、供应商、经销商、上下游公司、投资或母子公司关系属于 `relatedBrands`，其正向定义是「与目标品牌有业务关联、但不是直接竞品的其他品牌」（代理/经销、同集团兄弟品牌、战略合作、上下游深度绑定）；品牌自身、其全称/简称/别名不得进入 `relatedBrands` 与 `competitors`。

竞品判别只有一条规则：**同体量层级、同赛道（看 products 不看 industry 大类）、同地域（看 serviceArea）、竞争关系（客户会二选一比价）四个条件必须同时满足**。来源只有两个——用户上传的材料、材料不足时的联网检索；**禁止模型凭记忆推断竞品**。

- **材料腿（主抽取）**：只收材料里有明确竞争信号的名字（点名「竞品/对手」、客户二选一、对比中被列为替代选项；「被提到」不算）。提示词携带层级原则（先由 industry/products/serviceArea 判断目标品牌体量层级，按行业给例：医美——公立三甲/全国连锁/上市原料商不是；汽车音响改装——惠威/摩雷/阿尔派等**音响设备厂商**不是，它们卖器材给改装店不抢改装客户；开锁——跨城不算）、★前东家最高优先级排除（履历句式中的 X 不是竞品，输出前逐名自检）、其他禁止（供应商/设备品牌、客户/甲方、合作方、平台渠道、上下游、权威标杆与对标对象、品牌自身及别名）。材料没有就省略，空缺交给检索腿。
- **触发与计数**：已知竞品 = 本次抽取的品牌 scope `competitors` 值 ∪ KnowledgeAuthority 中该 fact key 的已确认权威值；目标 8 家（ranking 陈列位 1 为本品牌、2–6 为竞品共 5 家 + 3 家缓冲）。产品线 scope 竞品计入去重但不计入品牌目标。
- **画像注入**：检索腿判别四条件需要目标品牌画像——products/serviceArea 取本次材料值，缺失时用 KnowledgeAuthority 已确认权威值补齐（predicate 按小写化契约 `enterprise-profile.servicearea`）；都没有时提示词声明未知并收紧判别（名字必须与本地门店/服务商语境共现）。
- **检索形态**：语料优先豆包搜索结构化召回（`keyword-search` typed port 的显式 `searchSources` 操作：`open.feedcoopapi.com/search_api/web_search`，逐条 Title/Summary 纯检索结果、无 LLM 改写、跨 query 按 URL 去重——js_ai `doubaoSearchProbe` 契约；Bearer 解析链：专用豆包搜索 key（可选配置）→ 复用 ARK key）；能力未注入或调用失败时回落 ARK `enable_search` 生成语料，回落记固定码降级日志（合法零结果不记）。query 用 js_ai 三互补形态：区域 + 行业已知时发「{区域} {行业} 排行榜 十大品牌 对比」「{区域} {行业} 哪家好 推荐 口碑」「{品牌} 主要竞争对手 同行」，未知时回落品牌点名单 query；逐 query 容错、结果拼接。排行榜语料混有的国际大牌由富化提示词的画像锚定与榜单警示过滤。
- **富化抽取提示词**：目标品牌画像块（品牌/行业/核心产品/服务区域/体量层级）+ 四条件判别标准（同赛道明确「看具体产品/服务，不看行业大类」）+ 榜单语料警示（「国家/地区 + 品牌 + 英文名」的榜单行文是国际品牌条目，一律不取；散文/品类/评价语不是企业专名）+ 已知竞品与排除名单 + 宁缺毋滥（没有同层级本地同行返回空数组）。
- **反虚构与自名过滤**：只允许输出在检索文本中**字面出现**的公司/品牌名；排除名单（品牌自身/别名/关联主体）按双向子串匹配。逐名给出检索原文 `sourceExcerpt`，数量补足缺口即止。
- **候选形态**：富化名一律 `inferred`（卡片「待确认」行；整卡确认时随全量采纳进入权威，见 ADR 0003）；与本次已抽出的品牌 scope 竞品**合并为同一条候选**，避免同一 fact key 多条候选顺序采纳互相覆盖。合并后的候选整体降为 `inferred`，excerpt 合并保留材料与检索两侧证据。
- **失败语义**：检索或富化解析失败按 independent-best-effort 静默跳过，不产生错误码、不影响主导入结果；后续 ranking 质量门仍会 fail-closed 挡住竞品不足的稿件。

## 失败、确认与版本

批量文件按单份顺序隔离；一份导入、解析、模型调用或候选提交失败不会终止其他材料。重试 API 只接受一个 `materialId`，新增该材料的 attempt，不重新导入或重跑批次其他项。若一次 attempt 在中途已提交部分候选，失败记录保留这些 candidate ID；同 Session 对同材料、同 fact identity/value/unit 的待确认候选由 KnowledgeAuthority 事务内复用，重试不会复制已经成功的部分。

解析结果全部调用 `KnowledgeAuthority.propose`，不建立第二套去重、冲突或确认逻辑。原材料状态在候选创建后为 `awaiting-confirmation`；关联候选全部裁决后为 `processed`。

`adopt-new` 与 `split-scope` 成功时，Rust 在同一 `IMMEDIATE` transaction 中创建单调递增的品牌知识快照：`knowledge_versions` 保存决策、Session、快照哈希，`knowledge_version_facts` 保存当时所有 current fact 版本、值与来源。旧快照不覆盖。`geo_artifacts.knowledge_version` 固化产物生成时使用的品牌知识版本，因此后续知识更新不会改写历史产物的 lineage。

## 日志与测试

材料流程只允许记录固定 operation、合法 workspace/session/material ID、状态和固定 error code；Sidecar 以 `[materials]` 前缀输出 `materialLogProjection` 的脱敏投影（导入/抓取启动完成、后台抽取完成或失败、重试）。该投影同时覆盖 HTTP 路由路径与 Agent 工具路径（`import_pasted_material` / `import_website_material` / `retry_brand_material`），工具发起的导入失败不会只存在于 SQLite。路径样式 identity 直接投影为 `invalid`；raw error、API Key、URL query、材料正文、模型 prompt/response 均不得写普通日志。

失败错误码精确区分：模型输出坏 JSON 落 `model_response_invalid`（同一超时信号内自动重抽一次，两次都坏才落终态）；management hop 自由文本错误落 `material_management_failed`（Rust 材料存储固定码原样透传）。泛化 `material_processing_failed` 只保留给真正未分类的错误。真实 provider 冒烟走 `material-import.credentialed.test.ts`（显式 opt-in，不在默认测试命令内）。

默认回归覆盖：三类输入、文件白名单与解析、no-follow/品牌隔离/哈希/相对路径、SSRF/DNS/redirect/类型/大小、Profile 字段/provenance/scope、单份失败与最小重试、抽取挂起硬超时落 failed、异步启动与状态轮询、会话恢复重建卡片、KnowledgeAuthority 唯一入口、知识快照与旧产物 lineage、日志脱敏。所有网站测试使用注入式 fake fetch。

## js_ai 交叉核验风险

本切片在 2026-08-15 只用普通文件读取核对 `/Users/kezzz/Downloads/js_ai` 的 `materials.ts`、`evidencePlanning.ts`、相邻测试和本项目 research 文档。任务明确禁止任何 Git 命令或对象读取，因此无法证明该目录当时确为目标 `dev` 工作树，也无法核验 commit identity；上述字段、类型和来源语义以可见源码快照为准，后续若获得允许，应单独核对分支身份，但不得据此静默改变本契约。
