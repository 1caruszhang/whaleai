# GEO 通知与精准深链

GEO 系统通知是 BrandWorkspace 已提交状态的只读投影，不是执行 owner，也不参与 Operation 的状态迁移、重试、恢复或持久化。关闭通知分类只改变 OS toast 是否展示。

## Owner 与数据流

1. `BrandWorkspaceStore`、发布调度器或发布后监测执行器先提交自己的权威事务。
2. 提交成功后调用 `notification.rs` 的 GEO 投影入口；该入口发出侧栏刷新事件，并按用户偏好决定是否显示隐私安全的静态通知正文。
3. 通知携带稳定 locator：`workspaceId + sessionId + operationId + card + artifact(kind/id/revision)`；Operation 通知还可携带 `stepId`。任何字段都不表示“最近一条”。
4. 点击时 Rust 使用 BrandWorkspace 数据库重新校验完整 locator。Renderer 只消费 `exact` 结果，不自行猜测或改写目标。
5. Renderer 先切换精确品牌，再通过现有 Session 打开 owner 恢复精确 Session，然后按卡片落点分发（票 32）：
   - `geo-operation`、`article-generation`、`publish-execution`（含待确认门）落到对应聊天 Tab，聊天滚动定位到该操作的闸门卡（优先交互闸门面板，回退进度卡步骤列表；会话恢复期间按固定节奏重试），工作台只接收聚焦投影。
   - `post-publish-monitoring`（监测告警）落到品牌级「效果」整页：按精确 `planId` exact get 读取监测计划并滚动定位其最新 run 视图，不进入聊天工作台。效果页控制面借用该品牌已打开聊天 Tab 的 Session Sidecar owner 身份，通知路由照常先恢复精确 Session 以提供该身份。
   - 监测落点是一次性消费：用户随后主动进入「效果」页（侧栏入口或 Tab 栏选中）即丢弃未消费的深链落点，恢复 latest 视图；通知对应的计划已完成（终态），其最新 run 即告警对应的监测结果。
   - 文章、发布和监测落点都使用 exact get，不调用 latest。

## 启动与安全降级

Renderer 安装 `notification:click` listener 后才向 Rust 声明 ready。ready 之前最多保留一个精确点击；相同通知 ID 去重，不同点击并存时视为歧义并拒绝定向。合法可路由点击会认领本次冷启动；没有点击或 locator 为空时，产品仍按普通流程创建新 Session。

若品牌、Session、Operation、card 或 artifact 在点击前被删除，Rust 返回 `fallback`，且绝不替换成其它最近对象。Renderer 只回到对应品牌（若仍存在）的新 Session 入口，或当前安全品牌入口，并显示可理解提示。落点读取同样不做相似对象替换：监测深链的计划在点击后、面板读取前被删除时，面板显示读取错误而不是回落到 latest。

## 隐私与偏好

通知标题和正文来自 Rust 静态 i18n 文案，不拼接 Provider key、提示词、附件正文、渠道凭据、业务长文或失败原文。设置中的五类偏好分别控制待确认、Operation 失败、批次完成、发布失败和监测完成；总开关仍是 `osNotifications`。

侧栏状态是 Session 最新 GEO Operation 的不泄密投影，只展示待确认、失败、排队、进行中、完成或就绪，不展示业务正文或凭据。
