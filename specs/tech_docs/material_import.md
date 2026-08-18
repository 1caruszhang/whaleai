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

Renderer 对处理中行每 3s 轮询 `/api/xiaojing/materials/status`（带 `materialIds`）；缺省 `materialIds` 的同一路由返回本 Session 最近材料（Rust `/api/brand-materials/list`，按 `updated_at` 倒序、上限 10），用于聊天侧导入区重挂载后恢复在途行与确认卡。非处理中材料在响应中携带批量确认卡投影——确认卡数据以权威候选为源重建，不依赖一次性响应存活。挂载恢复接管的在途行允许直接单材料重试：其原后台队列可能已随 Sidecar 进程消失。

抽取链路（含竞品富化的检索与二次抽取）带 10 分钟硬超时信号；provider 挂起按 `model_failed` 落回 failed 终态，材料不会永远停在 processing。Renderer 传输层失败（代理超时 / IPC / 网络）显示专用 `material_request_failed`，与服务端业务错误码严格区分。

## 产品入口与 Session 归属

真实用户入口全部在聊天内（票 27）：粘贴资料与官网 URL（以及文件选择）由聊天输入区的材料导入入口（`XiaojingChatMaterialImport`，挂在聊天输入框上方、同一个 `TabProvider` 内）发起，使用当前 Tab 的 `apiPost` 和固化 `sessionId`；会话附件（文件/图片）路线保持——附件由 Agent 经 `read_session_file` 判断后走 `import_pasted_material` 导入并停在知识裁决门。右侧工作台不挂任何材料面板，材料入口不出现在工作台。`BrandWorkspace` 只可由该 Tab 的 `workspacePath` 精确匹配得到，不能用全局 current workspace 补位；没有匹配品牌时不挂载该入口。仍是 pending Session 或尚无 Session 时不允许提交，并引导用户先在当前聊天建立 Session。

- 文件通过现有 Tauri OS dialog 选择；Renderer 只把路径作为结构化操作参数交给 `importBrandMaterialFiles`，不打开、不解析也不记录路径。界面只显示 basename。
- 粘贴资料和官网 URL 分别调用 `importBrandMaterialText`、`importBrandMaterialWebsite`，不伪造用户消息来触发导入。
- 批量文件逐项投影处理中、成功或失败、`materialId` 与候选数；一项失败不遮蔽其他结果。只有已取得 `materialId` 的失败项显示“仅重试此项”，并只调用单材料 retry API（同样只启动后台抽取，立即返回）。
- 入口在 deferred chat 阶段禁用导入操作，避免在 Tab 的真实 Session identity 就绪前发起请求。
- 批量确认卡是权威候选的投影，呈现为字段行复核卡（分层默认与整卡全量采纳语义见
  `knowledge_authority.md` 与 ADR 0003）：裁决提交后卡片保留、整体变暗并只读（行内呈现逐条裁决结果）；入口重挂载时按 Session 材料列表重建卡片（含已裁决的只读卡）。裁决经 decide 路由提交后，隐藏 reminder 汇总权威结果并唤醒主聊天继续推进当前 GeoOperation。卡片待决期间用户可随时在聊天中以自然语言下达修改（改/删/增候选），Agent 经通用闸门修订工具执行并记 `user-stated`，卡片按既有 3s 轮询重渲染，服务端改动覆盖卡片本地暂存编辑。

## 三类输入与原始材料

支持：

1. 文件材料：`txt / md / markdown / csv / json / html / htm / xml / log / pdf / docx / xlsx / pptx`；
2. 粘贴文本：保存为 UTF-8 `txt`；
3. 官网 URL：只抓取公开 HTTPS 的 `text/html / application/xhtml+xml / text/plain`，原始响应先保存为 `html`。

该集合来自 js_ai 当前企业 Profile 业务链路及本项目现有解析依赖。图片虽在 js_ai 中可分类，但当前链路明确不用于 Profile 抽取，因此本切片不把图片或旧 Office 格式扩成通用文档平台。

原文件写入当前品牌 `<BrandWorkspace>/materials/<material-id>.<ext>`。`brand_materials` 仅记录应用内相对路径、显示名、类型、字节数、SHA-256、安全来源投影、状态、尝试次数和固定错误码；不记录原始本机路径。`brand_material_processing` 逐次记录单份材料的 attempt、Session、候选 ID、状态和固定错误码。临时文件在同目录写完并 `sync_all` 后 rename，DB 失败则删除已复制文件。

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

## 竞品消歧与检索富化

js_ai `material-to-facts` 契约要求 "enrich real competitors"。抽取与富化规则：

- **消歧**：`competitors` 只收直接竞争品牌（同类可替代产品/服务的其他品牌）；合作商、供应商、经销商、上下游公司、投资或母子公司关系属于 `relatedBrands`；品牌自身及其别名不得进入 `competitors`。该规则同时写入抽取 prompt 与富化抽取 prompt。
- **计数与目标**：已知竞品 = 本次抽取的品牌 scope `competitors` 值 ∪ KnowledgeAuthority 中该 fact key 的已确认权威值；目标 5 家（ranking 陈列位 1 为本品牌、2–6 为竞品，见 `articleGeneration` 质量门）。产品线 scope 竞品计入去重但不计入品牌目标。
- **富化来源**：不足 5 家且注入 `keywordSearch` 能力时，先用真实检索（ARK `enable_search`，即 js_ai webGrounding 设计）查询「品牌 + 行业 + 主要竞争对手」，再用 extraction 能力做第二次严格 JSON 抽取：只允许输出在检索文本中**字面出现**的公司/品牌名（反虚构），排除品牌自身、已知竞品与 `relatedBrands` 值，逐名给出检索原文 `sourceExcerpt`，数量补足缺口即止。
- **候选形态**：富化名一律 `inferred`（卡片「待确认」行，带纯视觉逐行确认；整卡确认时随全量采纳进入权威，见 ADR 0003）；与本次已抽出的品牌 scope 竞品**合并为同一条候选**，避免同一 fact key 出现多条候选导致顺序采纳互相覆盖。合并后的候选整体降为 `inferred`，excerpt 合并保留材料与检索两侧证据。
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
