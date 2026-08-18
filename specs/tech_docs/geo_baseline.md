# 真实 GEO 优化前基线

## Owner 与固定引用

- Node `GeoBaselineService` 拥有逐问题真实探测、回答/引用解析、品牌信号判定、两槽并发与失败隔离，只消费 `keyword-search.probeQuestion` typed port。
- Rust `BrandWorkspaceStore` 拥有 baseline / evidence unit / attempt 持久化与 claim-token CAS。prepare 只接受已确认问题池，并一次性固定 `knowledgeVersion + questionPoolId/revision + selected questions + brand names + provider snapshots`。执行和重试结果按 `baselineId` 精确读取；`latest` 只服务默认 UI 投影，不能作为并发执行身份。
- Renderer 只通过 Session 控制面的 `apiPost` 选择已配置引擎、启动、展示和重试；普通控制面不直连 Sidecar，也没有本 Ticket 新增的 SSE 事件。基线交互宿主是左侧栏「效果」一级入口整页（`XiaojingGeoEffectPage` → `XiaojingGeoEffectPanel` 内的基线面板）：整页本身是品牌级投影，控制面请求借用该品牌已打开聊天 Tab 的 Session Sidecar owner 身份（不新建 owner token），没有已打开会话时页面如实引导先打开会话。
- 主链不内嵌基线步骤。会话内 `geo-observation` 步骤（表现检查意图）停在确认门时，聊天操作卡的闸门面板挂载交互式基线面板（引擎选择/启动/单题重试）；工作台六阶段骨架内的基线面板保持只读投影。品牌级按需基线的交互宿主是「效果」整页。基线是监测计划的前置：启用监测前必须先冻结一次基线。

## 真实证据与指标

每个 evidence unit 的最小身份是 `baseline + question + engine`。成功必须同时包含非空原始回答、Provider 原始 evidence 和结构化 analysis；空回答不能落为成功。结构化 Provider URL 优先，回答中的 URL 只以 `answer-link` provenance 作为显式回退，二者不会伪装成同一种来源。

三个指标互相独立：精确品牌标识出现为“被提及”；品牌附近存在正向推荐词且没有负向词为“被推荐”；至少一条真实解析引用为“有引用依据”。汇总的每个指标同时保存 evidence unit ids，UI 由汇总比例直接下钻原始回答和引用。比例只以成功探测为分母；成功数为零时为 `null/暂无数据`，失败结果不进入分母。

## 失败与重试

Provider 鉴权、限流、网络和无效/空响应都落为带 safe code/message 的 failed attempt，不生成回答、引用或指标。每次重试只 claim 用户选择的 failed evidence unit；已成功 unit 返回 cached，全部 attempt 历史保留。默认 unit/integration/DOM 测试使用 fake Provider 并受 no-egress setup 保护；真实 smoke 只能进入 credentialed pool，本 Ticket 不运行。
