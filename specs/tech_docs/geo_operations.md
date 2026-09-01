# 意图驱动的 GeoOperation 编排

Ticket 16 只建立 GEO 领域编排，不建立通用 Workflow Engine、`GeoRun` 或第二层 Project。主聊天是唯一 Agent 发起入口；结构化卡片仍只负责对应业务 owner 的用户决策。

## Owner 与 seam

- `src/shared/geo/operation.ts` 是意图到最小能力切片、步骤、确认门和跨语言枚举的纯 policy；`GEO_OPERATION_PHASES` 把步骤映射为六个展示阶段（品牌知识、问题机会、内容生产、渠道计划、发布、监测），阶段名与 Agent 口头汇报的环节名一致，聊天进度卡片与右侧工作台共用同一分组，正文不复述阶段链条。工作台据此渲染六阶段竖向手风琴骨架：六个阶段行恒定排列，聚焦操作所处阶段展开显示该阶段产物面板，其余收起为单行（阶段名 + 状态点），点击可展开回看该阶段产物；直接意图未覆盖的阶段行标「已跳过」。各阶段面板只承载用户已确认的产物（已确认问题池的选定问题、已确认选题计划、已批准文章、已确认分发计划），未确认的过程产物留在聊天确认卡，面板以引导文案指回聊天。
- `src/server/geo/operation.ts::GeoOperationService` 是 Node 编排 seam。它计划一次 Operation，并把 capability 返回的 artifact reference、checkpoint 和失败写回；它不复制问题、文章、分发、发布或监测算法。
- 内置 `xiaojing-geo` MCP 只开放创建、读取、下一轮知识分支以及暂停/恢复/重试/取消。主模型选择明确 intent；字符串分类函数只服务测试和非 Agent 导入面，不拦截主聊天消息。
- Rust `BrandWorkspaceStore` 是 Operation lifecycle、revision CAS、checkpoint 和 lineage 的持久化 owner。Management API 同时校验 immutable Sidecar id、generation、Session 与 workspace path。
- 一个 BrandWorkspace 仍是一个品牌；一个 Session 可以创建多个 Operation。Operation 的 `sessionId` 是「当前所有者」兼执行上下文与控制身份：列表、exact get、lineage 与 mutation 都按当前所有者裁决，所有权检查收敛于单一判定点（store 侧 `geo_operation_control_mismatch_error`、文章侧 `article_operation_owner`，改键只动判定点）。跨 Session 只共享已确认知识、confirmed question/topic/distribution plan、approved article 等品牌产物；未批准状态（`awaiting-selection`、draft、未全部批准的 article operation）属于当前所有者会话，可经接管转移（ADR-0010）。未批准投影是 owned-or-approved：当前所有者读全文投影，其他会话走既有 approved-only 投影（仍有未批准内容时拒绝）。跨会话未完成轮次的元信息 tracer 不变：`list_unfinished_geo_operations`（Sidecar 面向 `/api/brand-geo-operations/unfinished`）按品牌只读列出非终态 Operation 的元信息五要素——类型、卡住步骤（capability 随行，展示阶段由 shared policy 六阶段词汇补齐）、待审数量（当前所有者会话名下 draft_ready 且未批准的文章篇数）、所属会话（= 当前所有者）、创建/更新时间——供 `inspect_brand_context` 的品牌状态摘要在新会话一次读取；该列表不含草稿正文、正文路径或任何会话聊天记录。
- **接管（Takeover，ADR-0010）**：把一个未完成轮次的所有权从当前所有者 CAS 转移给当前会话的一次确认动作——经信息闸门卡片整卡一次确认后由 MCP 工具 `takeover_geo_operation`（Sidecar 面向 `/api/brand-geo-operations/takeover`）单次提交，不产生第二确认入口或中间确认态。守卫：终态轮次与 running/queued/recovering（与退出固化暂停同一活跃集）拒绝接管；并发接管先到者得（revision + 所有者键在同一 Immediate 事务内先读后写），后到者收到 `geo_operation_takeover_conflict` 指明赢家。同一事务内 awaiting-selection 池与仍有未批准文章的 article operation（含草稿）随 operation 整体转移、不拆分：转移只写各表 `owner_session_id` 覆盖列（有效所有者 = `COALESCE(owner_session_id, created_by_session_id)`），`created_by_session_id` 保持创建审计原义不改写；全批准产物与 confirmed 池是品牌产物，不转移。留痕：`session_id`=接管者、`taken_over_from_session_id`/`taken_over_at` 记录原所有者与时间。原会话降级不是新机器——所有权挪走后它自然落回 owned-or-approved 之外的跨会话语义，其控制类访问得到 `geo_operation_session_mismatch:taken_over_by=<接管会话>` 的可转述错误（MCP 工具层附中文恢复指引）。接管不推进步骤、不改写 18+1 步序列与确认门位置；步骤序列与确认门语义见下文。

## 生命周期

Operation 状态为 `ready / queued / running / awaiting-confirmation / paused / recovering / succeeded / failed / cancelled`。步骤状态为 `pending / ready / running / awaiting-confirmation / succeeded / failed / skipped`。

- 开始 exact ready step 时递增 `executionGeneration`；完成后只激活下一个既有步骤。最后一步完成才进入 `succeeded`，不存在把全部步骤一次性改成成功的通用入口。
- running 的工作步骤可携带量化进度 `progress: {current, total}`（如文章逐篇 N/M）：由 Sidecar 的 `report-step-progress` mutation 带 revision CAS 上报，只作用于恰为 running 的步骤；`begin`/`retry`/`recover` 等重置执行路径会清空 `progress`。进度上报是 best-effort 投影增强，失败不影响业务结果。
- 里程碑桥（Sidecar `operation-progress.ts`）的 `*-started` 里程碑只 begin（步骤推进到 running，让进度条立刻反映真实工作），完成类里程碑把 running 步骤收尾并放行对应确认门。`*-started` 必须在工具输入校验之后、真实 Provider 工作之前触发——纯校验失败不得把步骤留在 running；工具失败后 running 步骤由 agent 原地重试的成功里程碑收敛，用户取消或操作级 retry 兜底，不存在自动 fail-step。
- running Operation 只有保存 `safeToResume=true` 的结构化 checkpoint 后才能暂停或进入 `recovering`；进程恢复时先持久化该显式状态，再由 `resume` 把 running step 放回 ready 并递增 execution generation。checkpoint 只含当前/已完成 step identity 和已持久化 unit refs，不复制 Provider 正文、密钥或请求体。
- retry 只接受带 `retryable=true` 的结构化失败，并继续使用 exact artifact/unit owner 的最小重试语义。取消是终态；失败记录 terminal time，但可通过 revision CAS 进入新的 execution generation。
- 控制类动作（pause/resume/retry/cancel）转换失败时，Rust 错误文本携带当前状态与该状态下合法的控制动作（如 `geo_operation_transition_invalid:ready (valid control actions: pause, cancel)`）；Agent 工具 `control_geo_operation` 把失败包装为 `ok:false` 结构化结果并附恢复指引（先 `inspect_geo_operations` 取最新 revision），不依赖裸 throw 的 isError 单行文本。
- `inputRefs` 固定调用前依赖，`artifactRefs` 只追加已持久化结果；完整优化引用 09–15 的真实产物，不建立第二套产物表。

## 多 Session 后台执行与应用级 admission

- 每个 Session 继续使用自己的 1:1 Sidecar、对话 generator 与 GeoOperation revision/generation。品牌切换或工作台 unmount 只终止当次只读 projection 请求，不调用 Operation cancel；窗口可见时工作台以有界轮询刷新，重新显示或重新挂载立即从 Rust truth 重读。Chat turn 已进入后台时继续复用 `BackgroundCompletion` owner，不建立 GEO 专用 owner、port 或 Renderer lifecycle 副本。
- 操作生命周期控制（暂停/恢复/重试失败单元/取消，经 `/api/xiaojing/geo-operations/control` 提交 revision CAS）与 provider 排队、checkpoint 恢复提示只呈现在聊天进度卡区域：控制按钮按操作状态呈现，provider 排队横幅沿用 `geo-provider-queue-updated` Tauri 事件通道（不新增 SSE 事件）。过程控制只有聊天一个入口。
- 聊天进度卡按计划边界分层显示，且展示模式跟随 live 投影而非消息快照：live 停在计划认可门（即计划开始）或终态（succeeded/failed/cancelled，即计划结束）时渲染完整进度卡（含权威步骤计划重播与「GEO 操作已更新」标题；计划认可门停靠时认可面板作为卡头主操作、先于步骤重播渲染，其余闸门面板仍在卡尾）；用户放行计划后，承载认可面板的那张卡随轮询翻到中间态、就地收敛为闸门进度条，历史消息不残留步骤计划重播。其余一切非边界状态（ready/queued/running/paused/recovering 与中间确认门停靠，通常来自 reminder 唤醒的 `inspect_geo_operations` 回合）只渲染 compact 轻量条——目标行、状态行、闸门进度条、生命周期控制、排队/恢复提示与 `GeoOperationGatePanels` 阀门面板（保留 `data-geo-gate-panels` 深链锚点），不重播步骤计划，且非交互宿主的历史信封整条不渲染：同一操作任意时刻至多一条轻量条，随最新信封下移。闸门进度条（`GeoGateProgressStrip`，视觉语言参考 js_ai 的分段进度条）的段由计划内的确认门步骤按计划序派生——全量优化 8 道门，直接意图只显示自己的门子集；计划卡与轻量条渲染同一条进度条：停靠认可门时随计划卡一起出现（「计划」段停在待确认），放行后原地推进，不作为新元素出现；完成（succeeded/skipped）=accent 实心、当前运行=accent 脉冲、当前停在待确认=warning 脉冲、失败=error、未到=line，全部放行后整条实心无脉冲；段下两字短名，闸门全称与停靠状态放 tooltip；状态行报 `N/M 道闸门 · 当前：…`，无确认门的计划回退 `N/M 步`。输入框上方另挂常驻停靠条（`GeoOperationDockedStrip`）：只要本 Session 存在非终态操作（计划停靠认可门起、终态止）就常驻展示同一条闸门进度与状态行，不随消息滚动离开视野；取 `loadGeoOperations` 列表首个非终态操作（与工作台聚焦推导一致），`toolCompleteCount` 变化即刷新（新操作的进度卡出现的回合停靠条同拍出现）、在跑时按同款 3s 有界轮询补拉；停靠条只读，不承载确认或生命周期控制（过程控制仍只在聊天进度卡），点击定位到对应闸门卡锚点（复用通知深链同款滚动工具与「跟随底部」抑制），全部终态后消失。信封统一为轻量容器 `data-geo-operation-cards`，完整卡（`data-geo-operation-event`）与轻量条（`data-geo-operation-strip`）标记落在各自操作卡上。中间回合的产物确认由各阶段自己的闸门卡片承载（见 `DESIGN.md` 信息闸门卡片）。认可卡与其他确认卡（如附件导入产出的知识确认卡）同回合共存时，agent 正文必须点明先后：先放行计划，知识确认是第一阶段第一道门，先裁决任一门都不阻塞；卡片指引文案不用「上方/下方」方位指代。
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

直接意图只生成所需切片：知识更新、问题机会、文章生成、表现检查、分发计划或监测互不夹带其它阶段；发布意图若已引用 confirmed distribution plan 就直接进入发布预览，否则只补齐“分发计划 → 确认”这一必需前置。`full-optimization` 组合相同知识、问题池、主题/文章、分发、发布与监测定义（含计划认可门共 19 步），不复制实现；主链不内嵌基线探测——基线改为品牌级「效果」入口内的按需动作（见 `geo_baseline.md`），监测启用前必须先冻结一次基线，`performance-inspection` 直接意图仍保留条件化补充探测。

“下一轮优化”第一次固定停在“是否更新知识”：不更新从已有问题池选择开始；更新从知识材料/候选链路开始。Dashboard report 可以作为 `report` input ref，但 policy 不读取它决定分支。

每个可执行计划的首步都是合成的 `acknowledge-plan` 步骤（borrowing 首个工作步骤的 capability 以落进开头阶段），携带 `plan-ack` typed confirmation：operation 创建即整单停靠在计划认可门，用户在聊天进度卡的 `GeoPlanAckPanel` 上一次点击放行整份计划（走既有 `/api/xiaojing/geo-operations/confirm-step` 端点与 revision CAS；路由随决策投递 `XIAOJING_GEO_OPERATION_EVENT` reminder 唤醒 agent 从第一阶段继续）。认可门 confirmation 的 summary 可携带可选的起点推导理由（`start_geo_operation` 的 `startingPointReason`，票 #27 / ADR-0010 Decision 5）：agent 经「带推荐与理由的选项式询问」得到用户选择后写入一句话理由，计划门呈现「从哪里开始、为什么」——用户放行的是起点；该字段只改 summary 文案，经既有 steps payload 通道持久化与渲染，步骤序列与确认门位置零改动。放行不裁决任何阶段产物：各阶段仍停在各自的产物门。`decide-knowledge-refresh` 未决分支是唯一没有计划认可门的计划——它本身就是决策步；`choose_next_round_knowledge` 的显式回答即计划放行，replace-plan 在 service seam 剥离认可门，替换后的计划直接从首个工作步骤（或首个产物门）开始，不再二次停靠。

每个需要用户判断或 Provider 用量的步骤都携带 typed confirmation。知识、问题、主题、文章和分发确认继续由各自 BrandWorkspace owner 裁决；付费/外部发布的 authority 固定为 `PublishScheduler`，监测激活固定为 `PostPublishMonitor`。Node/MCP 的通用确认入口会拒绝后二者，不能把 Operation projection 当成付款或发布授权。Rust UI owner 完成真实确认后，独立 Tauri attestation 还必须校验 exact execution/plan revision 与已确认状态，才只推进 Operation projection；该入口不创建付款、发布或监测副作用，Management API 也显式拒绝同名 mutation action。

### Autonomy profile

`config.json::geoAutonomyProfile` 是工作区级自治档位，Rust 在 Session Sidecar spawn 时读取并注入 `XIAOJING_GEO_AUTONOMY_PROFILE`（仅品牌工作区 Session；未知或缺失值一律回落 `manual`）。门位 widening 政策唯一权威在 `src/shared/geo/autonomy.ts::AUTO_CONFIRMABLE_CONFIRMATION_KINDS`，当前只含 `question-selection`：`auto` 档下问题池生成后按 `recommended` 标记自动确认选择门、照常播报决策提醒并记录 milestone，自动确认失败时安全退回 `awaiting-selection` 等待用户。计划认可门（`plan-ack`）、知识裁决、基线探测、内容计划、文章批准、分发确认、付费/外部发布与监测激活在任何档位都保持用户所有。

## 知识更新与历史

KnowledgeAuthority 采纳产生新知识版本时，在同一 SQLite transaction 比较每个下游 artifact 固定的 `knowledge_version`。值或单位真正变化后，旧问题池、主题计划、文章草稿和分发计划写入 `geo_artifact_freshness(status='needs-confirmation')` 与 changed fact keys；同值只合并来源时不标记。

批准文章、真实 baseline/monitor evidence 和报告是历史证据，不被删除、改写或伪装成当前计划。它们保留原知识版本和 lineage；后续用户可以据此显式创建新计划或草稿。

品牌 Session 删除不级联到这些领域行：各 GEO 表的 `created_by_session_id` / `session_id` / `actor_session_id` 是审计标签（NOT NULL 值，与 `knowledge_decisions.actor_session_id` 同形态），不携带指向 `brand_sessions` 的外键，因此 Session 删除总是成功且领域行原样保留；只有 `geo_operations` / `geo_artifacts.session_id` 保持 `ON DELETE SET NULL`。存量库由 `drop_brand_sessions_foreign_keys` 重建迁移在下次打开时收敛。

## 测试边界

Shared contract tests覆盖直接 intent、完整组合、下一轮两分支、报告非 authority、计划认可门和所有 gate；Node tests 从 `GeoOperationService` seam 验证最小计划、分支替换、queue projection、Provider admission 和 Rust UI authority，MCP 协议级 brand-context 测试验证新会话经真实 server 一次拿到跨会话状态摘要（含未完成轮次元信息，无正文无转录，无未完成轮次时与现状一致），MCP 协议级 takeover 测试验证接管工具单次调用完成所有权转移（信封与 Rust 端点契约一致）、运行中守卫与 CAS 单赢家拒绝以可转述结构化结果返回、原会话控制失败提示接管者；Rust tests覆盖多 Session 隔离、跨会话未完成元信息列表（只读、按品牌、不含正文）、接管不变量（CAS 单赢家指明赢家、运行中/终态守卫、留痕、awaiting-selection 池与未批准草稿随 operation 整体转移且不误伤全批准产物与他人工作集、接管后元信息 tracer 跟随新所有者、原会话降级与 owned-or-approved 投影改键）、应用级 FIFO/资源耗尽、revision + generation CAS、退出 checkpoint、crash recovery、stale event、最小 retry、终态、不可逆 gate、知识引用标记与 plan-ack 放行前阻断/一步放行。DOM tests覆盖聊天进度卡的排队原因/位置、恢复提示、控制按钮按操作状态呈现/禁用与 revision CAS 提交、计划认可门确认面板（提交 confirm-step、失败不刷新宿主卡）、计划放行后完整卡就地收敛为闸门进度条、完整卡头部结构派生跨度标签（与 goal 并排、轻量条不重复报）、中间确认门停靠走轻量条不展开大卡，以及闸门进度条的分段派生/按状态配色/两字短名/全部放行无脉冲、输入框上方常驻停靠条（非终态操作渲染于输入框之上/全终态或无 Session 消失/点击定位锚点/toolCompleteCount 与可见性轮询刷新），工作台单一操作视图（无视图页签、无效果面板）与阶段骨架的当前阶段展开/收起行点击回看/产物按阶段归属渲染/暂停与出错状态点/空态引导，「效果」一级入口整页的三面板交互保留与控制面借用身份，以及工作台无控制按钮与排队/恢复横幅残留、仅挂载于聊天 Tab、卸载不产生 cancel。默认测试无网络、无真实凭据、无付款、上传或发布。
