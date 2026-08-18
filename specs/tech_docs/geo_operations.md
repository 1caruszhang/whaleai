# 意图驱动的 GeoOperation 编排

Ticket 16 只建立 GEO 领域编排，不建立通用 Workflow Engine、`GeoRun` 或第二层 Project。主聊天是唯一 Agent 发起入口；结构化卡片仍只负责对应业务 owner 的用户决策。

## Owner 与 seam

- `src/shared/geo/operation.ts` 是意图到最小能力切片、步骤、确认门和跨语言枚举的纯 policy；`GEO_OPERATION_PHASES` 把步骤映射为六个展示阶段（品牌知识、问题机会、内容生产、渠道计划、发布、监测），阶段名与 Agent 口头汇报的环节名一致，聊天进度卡片与右侧工作台共用同一分组，正文不复述阶段链条。工作台据此渲染六阶段竖向手风琴骨架：六个阶段行恒定排列，聚焦操作所处阶段展开显示该阶段产物面板，其余收起为单行（阶段名 + 状态点），点击可展开回看该阶段已生成产物；直接意图未覆盖的阶段行标「已跳过」。
- `src/server/geo/operation.ts::GeoOperationService` 是 Node 编排 seam。它计划一次 Operation，并把 capability 返回的 artifact reference、checkpoint 和失败写回；它不复制问题、文章、分发、发布或监测算法。
- 内置 `xiaojing-geo` MCP 只开放创建、读取、下一轮知识分支以及暂停/恢复/重试/取消。主模型选择明确 intent；字符串分类函数只服务测试和非 Agent 导入面，不拦截主聊天消息。
- Rust `BrandWorkspaceStore` 是 Operation lifecycle、revision CAS、checkpoint 和 lineage 的持久化 owner。Management API 同时校验 immutable Sidecar id、generation、Session 与 workspace path。
- 一个 BrandWorkspace 仍是一个品牌；一个 Session 可以创建多个 Operation。Operation 的 `sessionId` 同时是执行上下文和控制身份：列表、exact get、lineage 与 mutation 都不能跨 Session。跨 Session 只共享已确认知识、confirmed question/topic/distribution plan、approved article 等品牌产物；`awaiting-selection`、draft、未全部批准的 article operation 与其它未批准状态必须留在创建 Session。

## 生命周期

Operation 状态为 `ready / queued / running / awaiting-confirmation / paused / recovering / succeeded / failed / cancelled`。步骤状态为 `pending / ready / running / awaiting-confirmation / succeeded / failed / skipped`。

- 开始 exact ready step 时递增 `executionGeneration`；完成后只激活下一个既有步骤。最后一步完成才进入 `succeeded`，不存在把全部步骤一次性改成成功的通用入口。
- running Operation 只有保存 `safeToResume=true` 的结构化 checkpoint 后才能暂停或进入 `recovering`；进程恢复时先持久化该显式状态，再由 `resume` 把 running step 放回 ready 并递增 execution generation。checkpoint 只含当前/已完成 step identity 和已持久化 unit refs，不复制 Provider 正文、密钥或请求体。
- retry 只接受带 `retryable=true` 的结构化失败，并继续使用 exact artifact/unit owner 的最小重试语义。取消是终态；失败记录 terminal time，但可通过 revision CAS 进入新的 execution generation。
- 控制类动作（pause/resume/retry/cancel）转换失败时，Rust 错误文本携带当前状态与该状态下合法的控制动作（如 `geo_operation_transition_invalid:ready (valid control actions: pause, cancel)`）；Agent 工具 `control_geo_operation` 把失败包装为 `ok:false` 结构化结果并附恢复指引（先 `inspect_geo_operations` 取最新 revision），不依赖裸 throw 的 isError 单行文本。
- `inputRefs` 固定调用前依赖，`artifactRefs` 只追加已持久化结果；完整优化引用 09–15 的真实产物，不建立第二套产物表。

## 多 Session 后台执行与应用级 admission

- 每个 Session 继续使用自己的 1:1 Sidecar、对话 generator 与 GeoOperation revision/generation。品牌切换或工作台 unmount 只终止当次只读 projection 请求，不调用 Operation cancel；窗口可见时工作台以有界轮询刷新，重新显示或重新挂载立即从 Rust truth 重读。Chat turn 已进入后台时继续复用 `BackgroundCompletion` owner，不建立 GEO 专用 owner、port 或 Renderer lifecycle 副本。
- 操作生命周期控制（暂停/恢复/重试失败单元/取消，经 `/api/xiaojing/geo-operations/control` 提交 revision CAS）与 provider 排队、checkpoint 恢复提示只呈现在聊天进度卡区域：控制按钮按操作状态呈现，provider 排队横幅沿用 `geo-provider-queue-updated` Tauri 事件通道（不新增 SSE 事件）。过程控制只有聊天一个入口。
- 右侧工作台仅在聊天 Tab 挂载（欢迎页/设置页主区全宽），且已收为单一操作视图（票 31 移除「操作/效果」双页签），自上而下只有三段：多操作切换器（「目前所在阶段」跟随聚焦操作）→ 常驻当前已确认品牌知识面板 → 六阶段手风琴骨架。阶段行以状态点+文字表达暂停/出错，阶段总览 grid、最小执行步骤列表、checkpoint、pending/error 明细与原始产物引用等过程块只存在于聊天进度卡，工作台不再渲染；无进行中操作时骨架区显示空态并引导去聊天发起。按需基线探测、监测计划管理与真实证据看板由左侧栏「效果」一级入口整页承载（见 `geo_baseline.md`），不在工作台内。
- 所有 typed GEO Provider ports 在真正出站前都向 Rust `GeoProviderLimiter` 申请 permit。该 limiter 是应用进程单一 owner，跨品牌、Session 和 Sidecar 共用 FIFO；Node 的文章 worker / embedding producer 只安排本地最小单元，不能成为全局并发 authority。embedding batch 会拆成单条真实请求逐项 admission，避免一个 permit 内并发多个上游请求。
- `config.json::geoProviderConcurrencyLimit` 是配置入口，缺省为 5；Rust 对任何磁盘值强制夹在 `[1,16]`。队列最多 512 项，满时返回可见 `resource_exhausted`，不绕过 admission。projection 持久化 `queueReason/queuePosition`；permit release、cancel 或 Sidecar generation retirement 按 FIFO 推进位置。
- admission 只包裹 GEO typed Provider ports，不进入普通 Chat Provider 路径；因此某个品牌的重型 GEO 排队不会占用其它 Session 的普通聊天执行入口。

## 退出、崩溃与 generation fence

- 正常退出在 Sidecar 停止前扫描所有 BrandWorkspace，把 `running/queued/recovering` Operation 固化为 `paused`。checkpoint 只从已持久化的 succeeded/skipped steps、artifact refs 和当前最小 retry unit 派生；不会保存 prompt、Provider 请求体或 secret。下次启动在 Management API/Sidecar 可见前幂等修复非正常退出遗留，用户通过既有 Resume 继续。
- `queue-step/start-step` 都绑定 Management API immutable header 中的 Rust Sidecar generation。Sidecar health recovery 只回收 exact `(workspace, session, deadGeneration)` 的 active/queued Operation 和 permit，写入 `recovering`、清空旧 process binding，并递增 revision 与 `executionGeneration`。其它 Session/品牌不受影响。
- checkpoint、queue update、start、complete 与 fail 同时服从 current Sidecar generation 和 execution-generation CAS。旧 generation 即使迟到也不能更新 queue、提交 artifact 或结束新代次；恢复只把当前 running 最小单元放回 ready，不整条重跑。
- 通用 Operation retry 拒绝 `retryUnit=operation` 或缺失 `error.unitId`。可重试边界固定为 article / probe / publish-item / monitor-item，并继续复用各领域 owner 已有 claim token、idempotency key 与 CAS；知识并发仍由 KnowledgeAuthority 的 optimistic version/CAS 裁决。
- `geo_post_publish_monitor` 只是 BrandWorkspace scheduler 的稳定 wake reference；receipt 只表示 deterministic executor 已接纳唤醒，不形成产品级任务 owner。

## 意图与确认门

直接意图只生成所需切片：知识更新、问题机会、文章生成、表现检查、分发计划或监测互不夹带其它阶段；发布意图若已引用 confirmed distribution plan 就直接进入发布预览，否则只补齐“分发计划 → 确认”这一必需前置。`full-optimization` 组合相同知识、问题池、主题/文章、分发、发布与监测定义（共 18 步），不复制实现；主链不内嵌基线探测——基线改为品牌级「效果」入口内的按需动作（见 `geo_baseline.md`），监测启用前必须先冻结一次基线，`performance-inspection` 直接意图仍保留条件化补充探测。

“下一轮优化”第一次固定停在“是否更新知识”：不更新从已有问题池选择开始；更新从知识材料/候选链路开始。Dashboard report 可以作为 `report` input ref，但 policy 不读取它决定分支。

每个需要用户判断或 Provider 用量的步骤都携带 typed confirmation。知识、问题、主题、文章和分发确认继续由各自 BrandWorkspace owner 裁决；付费/外部发布的 authority 固定为 `PublishScheduler`，监测激活固定为 `PostPublishMonitor`。Node/MCP 的通用确认入口会拒绝后二者，不能把 Operation projection 当成付款或发布授权。Rust UI owner 完成真实确认后，独立 Tauri attestation 还必须校验 exact execution/plan revision 与已确认状态，才只推进 Operation projection；该入口不创建付款、发布或监测副作用，Management API 也显式拒绝同名 mutation action。

### Autonomy profile

`config.json::geoAutonomyProfile` 是工作区级自治档位，Rust 在 Session Sidecar spawn 时读取并注入 `XIAOJING_GEO_AUTONOMY_PROFILE`（仅品牌工作区 Session；未知或缺失值一律回落 `manual`）。门位 widening 政策唯一权威在 `src/shared/geo/autonomy.ts::AUTO_CONFIRMABLE_CONFIRMATION_KINDS`，当前只含 `question-selection`：`auto` 档下问题池生成后按 `recommended` 标记自动确认选择门、照常播报决策提醒并记录 milestone，自动确认失败时安全退回 `awaiting-selection` 等待用户。知识裁决、基线探测、内容计划、文章批准、分发确认、付费/外部发布与监测激活在任何档位都保持用户所有。

## 知识更新与历史

KnowledgeAuthority 采纳产生新知识版本时，在同一 SQLite transaction 比较每个下游 artifact 固定的 `knowledge_version`。值或单位真正变化后，旧问题池、主题计划、文章草稿和分发计划写入 `geo_artifact_freshness(status='needs-confirmation')` 与 changed fact keys；同值只合并来源时不标记。

批准文章、真实 baseline/monitor evidence 和报告是历史证据，不被删除、改写或伪装成当前计划。它们保留原知识版本和 lineage；后续用户可以据此显式创建新计划或草稿。

品牌 Session 删除不级联到这些领域行：各 GEO 表的 `created_by_session_id` / `session_id` / `actor_session_id` 是审计标签（NOT NULL 值，与 `knowledge_decisions.actor_session_id` 同形态），不携带指向 `brand_sessions` 的外键，因此 Session 删除总是成功且领域行原样保留；只有 `geo_operations` / `geo_artifacts.session_id` 保持 `ON DELETE SET NULL`。存量库由 `drop_brand_sessions_foreign_keys` 重建迁移在下次打开时收敛。

## 测试边界

Shared contract tests覆盖直接 intent、完整组合、下一轮两分支、报告非 authority 和所有 gate；Node tests 从 `GeoOperationService` seam 验证最小计划、分支替换、queue projection、Provider admission 和 Rust UI authority；Rust tests覆盖多 Session 隔离、应用级 FIFO/资源耗尽、revision + generation CAS、退出 checkpoint、crash recovery、stale event、最小 retry、终态、不可逆 gate 与知识引用标记。DOM tests覆盖聊天进度卡的排队原因/位置、恢复提示、控制按钮按操作状态呈现/禁用与 revision CAS 提交，工作台单一操作视图（无视图页签、无效果面板）与阶段骨架的当前阶段展开/收起行点击回看/产物按阶段归属渲染/暂停与出错状态点/空态引导，「效果」一级入口整页的三面板交互保留与控制面借用身份，以及工作台无控制按钮与排队/恢复横幅残留、仅挂载于聊天 Tab、卸载不产生 cancel。默认测试无网络、无真实凭据、无付款、上传或发布。
