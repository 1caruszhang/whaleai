# GEO 渠道发现与分发计划

Ticket 12 只创建可编辑、可确认的推荐与文章分配计划。它不创建订单、不扣费、不上传正文、不发布，也不创建 `PublishScheduler` wake。后续付费和发布只能消费已确认计划，并再次经过独立显式确认。

## Owner 与数据流

- Renderer 是当前 Chat Tab 的控制面。它经 `useTabApi().apiPost` 展示 Rust 派生的上下文、真实资源候选、证据和风险；不直接请求 Provider 或 Management API。
- Node `DistributionPlanningService` 拥有 js_ai `dev` 四路召回、硬过滤、20/10 配额、文章映射和 30 分钟只读资源缓存。相同资源 kind 的并发加载合并为一次请求；Sidecar generation 更换时缓存自然销毁。
- Rust `BrandWorkspaceStore` 拥有 plan artifact、provider/resource/evidence snapshot、revision CAS、claim token、audit 和最终确认门。artifact 可由同一 BrandWorkspace 的其他已提交 Session 按 exact plan id 读取；创建 Session 只作 provenance。
- 超级媒介 capability 在本阶段仅允许分页读取资源池。Provider 不可用时 plan 明确进入 `unavailable`，候选为空；严禁生成 demo、随机或模板候选。

## Authority snapshot

开始计划时，Rust 重新派生并核对以下事实，不能信任 Renderer 传入的同名字段：

- industry 来自文章 operation 固定 knowledge version 的 `knowledge_version_facts`；
- articles 来自 exact article operation 的 approved revision；
- question sources 来自同 workspace、同 knowledge version 的成功 baseline unit citations；
- confirmed-topic-plan 文章通过 `source_plan_item_id` 与 plan item 的 `sourceQuestionIds` 精确映射到问题证据；direct article 没有可信映射时 citation 的 `articleIds` 为空。

prepare 后所有上述输入、Provider 非 secret 状态、候选资源白名单字段与四路证据都固定进 plan。start、edit、confirm 完成后均按 exact plan id 读回，不以 `latest` 猜测刚创建或刚修改的对象。

## 推荐、过滤与不确定性

四路权重固定为 passive `0.4`、active `0.2`、fallback `0.1`、preference `0.3`，同一资源只累加不同路径。资源必须先满足超级媒介 `status=2`；已知正数成功率 `1..69` 和数值价格 `>=150` 在对齐与配额前硬过滤。成功率 `0`、null 与空价格表示未知，可以作为带明确不确定性的候选保留，但只要被选择或分配就阻断确认。

候选的 name、price、published rate 和 availability 只能来自 typed Provider resource snapshot。候选展示来源证据、适配理由、价格、成功率/可用性、权重与风险。空并集保持空，不移植 `random_balanced`。

一篇文章只分配一个渠道且渠道不能复用。计划支持 1:1 或媒体/自媒体比例映射、渠道组合、预算和发布时间编辑。Rust 确认时重新计算选择、分配、价格/成功率、证据、预算和时间护栏；仅靠客户端清空 `blockingIssues` 不能越过确认门。

确认提交成功后，`distribution-plans/confirm` 路由在同一 Session 投递纯隐藏 `XIAOJING_DISTRIBUTION_PLAN_DECISION` reminder（只携带 plan/operation identity、revision、status 与 assignment 数），唤醒 agent 从权威计划继续进入发布准备，不重复询问已确认计划。提醒入队失败不回滚已提交的确认，响应显式返回 notification 状态。

## 聊天修订（票 38，ADR 0003）

待确认（draft）计划的渠道选择与计划参数可经通用闸门修订工具 `revise_gate_content`（gate=`distribution-plan`）改/删/增：`subject='channel'` 的 add/delete 等价于选择/取消选择渠道（取消选择同时把对应分配置为 `unassigned`），`subject='assignment'` 修改逐篇分配（渠道必须已选择），缺省 `subject` 修改预算/发布开始时间。handler 复用既有 `DistributionPlanningService.edit`（白名单字段整组替换、`applyDistributionPlanEdit` 重算 blockingIssues），`edit` 携带 `reason`（用户指令原文）落 `geo_distribution_plan_audit.reason` 审计列。confirmed/discovering 计划分别按 `target_not_pending` 拒绝；确认卡（`DistributionGateCard`）待决期间每 3s 轮询 `/distribution-plans/latest`，服务端渠道选择变化时采信服务端（服务端胜），否则保留本地勾选。

## 测试边界

默认 unit/DOM/Rust tests 使用 mock capability 与临时 BrandWorkspace，不访问网络、凭据或真实用户目录。资源 TTL 通过注入 `now()` 确定性验证。credentialed smoke 不属于默认验收；即使显式运行，也只能读取资源目录，不能下单或发布。路由接缝回归（`src/server/__tests__/xiaojing-decision-receipt-gates.integration.test.ts`）断言确认后注入决策回执信封、响应携带 notification 状态、投递失败不影响决策成功。
