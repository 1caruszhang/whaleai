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

## 产品入口与 Session 归属

真实用户入口是聊天 Tab 内的 `XiaojingGeoWorkbench` 品牌材料面板。该工作台挂在同一个 `TabProvider` 内，使用当前 Tab 的 `apiPost` 和固化 `sessionId`；`BrandWorkspace` 只可由该 Tab 的 `agentDir` 精确匹配得到，不能用全局 current workspace 补位。没有匹配品牌、仍是 pending Session 或尚无 Session 时不允许提交，并引导用户先在当前聊天建立 Session。

- 文件通过现有 Tauri OS dialog 选择；Renderer 只把路径作为结构化操作参数交给 `importBrandMaterialFiles`，不打开、不解析也不记录路径。界面只显示 basename。
- 粘贴资料和官网 URL 分别调用 `importBrandMaterialText`、`importBrandMaterialWebsite`，不伪造用户消息来触发导入。
- 批量文件逐项投影处理中、成功或失败、`materialId` 与候选数；一项失败不遮蔽其他结果。只有已取得 `materialId` 的失败项显示“仅重试此项”，并只调用单材料 retry API。
- 面板在 deferred chat 阶段不挂载导入操作，避免在 Tab 的真实通信身份就绪前错发到 Global Sidecar。

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

同 Session 的待确认候选重试只允许 `inferred → asked → extracted` 方向提升来源及 excerpt，低等级结果不能覆盖高等级来源。

每个字段显式属于品牌整体 scope，或属于 BrandWorkspace 已登记的某一产品线；未知产品线降为品牌 scope。品牌与产品线使用不同事实 identity，因此可并存且不会串值。

## 失败、确认与版本

批量文件按单份顺序隔离；一份导入、解析、模型调用或候选提交失败不会终止其他材料。重试 API 只接受一个 `materialId`，新增该材料的 attempt，不重新导入或重跑批次其他项。若一次 attempt 在中途已提交部分候选，失败记录保留这些 candidate ID；同 Session 对同材料、同 fact identity/value/unit 的待确认候选由 KnowledgeAuthority 事务内复用，重试不会复制已经成功的部分。

解析结果全部调用 `KnowledgeAuthority.propose`，不建立第二套去重、冲突或确认逻辑。原材料状态在候选创建后为 `awaiting-confirmation`；关联候选全部裁决后为 `processed`。

`adopt-new` 与 `split-scope` 成功时，Rust 在同一 `IMMEDIATE` transaction 中创建单调递增的品牌知识快照：`knowledge_versions` 保存决策、Session、快照哈希，`knowledge_version_facts` 保存当时所有 current fact 版本、值与来源。旧快照不覆盖。`geo_artifacts.knowledge_version` 固化产物生成时使用的品牌知识版本，因此后续知识更新不会改写历史产物的 lineage。

## 日志与测试

材料流程只允许记录固定 operation、合法 workspace/session/material ID、状态和固定 error code。路径样式 identity 直接投影为 `invalid`；raw error、API Key、URL query、材料正文、模型 prompt/response 均不得写普通日志。

默认回归覆盖：三类输入、文件白名单与解析、no-follow/品牌隔离/哈希/相对路径、SSRF/DNS/redirect/类型/大小、Profile 字段/provenance/scope、单份失败与最小重试、KnowledgeAuthority 唯一入口、知识快照与旧产物 lineage、日志脱敏。所有网站测试使用注入式 fake fetch。

## js_ai 交叉核验风险

本切片在 2026-08-15 只用普通文件读取核对 `/Users/kezzz/Downloads/js_ai` 的 `materials.ts`、`evidencePlanning.ts`、相邻测试和本项目 research 文档。任务明确禁止任何 Git 命令或对象读取，因此无法证明该目录当时确为目标 `dev` 工作树，也无法核验 commit identity；上述字段、类型和来源语义以可见源码快照为准，后续若获得允许，应单独核对分支身份，但不得据此静默改变本契约。
