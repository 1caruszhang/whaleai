# 真实品牌 GEO 仪表盘

## Owner 与数据流

仪表盘是 `BrandWorkspace` 的只读聚合投影，不是新的事实 owner。Rust `BrandWorkspaceStore` 在每次读取时从同一品牌 `project.sqlite` 中的 Ticket 09 baseline/evidence、Ticket 11 article、Ticket 13 publish execution/item 和 Ticket 14 monitor run/unit 权威表计算投影；没有 dashboard snapshot、truth table 或后台刷新任务。Renderer 只展示 Rust 给出的指标、口径、完整性和证据 anchor，不重新计算分母或状态。

当前 Tab 通过 `apiPost` 调用 Node 的 `/api/xiaojing/geo-dashboard/get` 和 `/drilldown`。Node 校验 Session 与请求 workspace identity，再通过既有 management control plane 读取 Rust owner。Node 只在 Rust 投影上合并 `keyword-search` typed capability 的非 secret availability；它不重算业务指标。读取仪表盘不会启动 baseline probe、发布或监测。

## 筛选与隔离

当前品牌由 Tab 的 `workspaceId` 固定。可组合筛选 Session、GeoOperation、UTC 时间和 engine：

- 时间使用 observation 或 artifact 的权威时间，区间固定为 UTC `[from,toExclusive)`。Renderer 的 `datetime-local` 输入按显式 UTC 解析，不能套用设备本地时区。
- Session 和 Operation 只接受该 workspace 的实际维度。Monitor plan 同时匹配自己的 `operationId` 和显式 `sourceOperationId`，所以按来源发布/基线 Operation 下钻仍能看见关联复测。
- engine 维度包含当前产品真实支持的 `doubao` 和该品牌历史真实 observation 中的 engine；任意其它值 fail closed。engine 只影响 baseline/monitor 指标、趋势与问题矩阵，不影响文章与发布状态。
- 请求 Session 只是同品牌读取 authority，不是 artifact owner 筛选。一个已注册 Session 可以读取同品牌其它 Session 的产物；不同 BrandWorkspace 即使使用相同 Session、Operation 或 unit ID，也始终打开不同数据库。

## 指标口径与数据质量

累计探测卡采用 `all-observations`：筛选后的 baseline observation 与每次 monitor `baseline-probe` 都计作样本；同一 `question × engine` 跨 run 复测会增加样本数。趋势则逐个真实 monitor run 展示。只有状态成功且同时存在非空回答、非 null Provider evidence、引用数组和三个布尔 analysis 字段的 observation 才进入成功分母；未知状态或解析失败进入 `completeness.failed`，pending/running 进入 `pending`。

| 指标            | numerator / denominator                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| 品牌提及        | 成功 observation 中 `brandMentioned=true` / 成功 observation                                                      |
| 推荐倾向        | 成功 observation 中 `brandRecommended=true` / 成功 observation                                                    |
| 引用覆盖        | 成功 observation 中 `hasCitationEvidence=true` / 成功 observation                                                 |
| 问题覆盖        | distinct 已成功探测 question / 对应 exact baseline 的 distinct question；monitor 复测不扩大分母                   |
| 内容 / 发布状态 | `approved` 且有 approved revision 的文章 / Ticket 11 全部文章；Ticket 13 execution/item 只作独立 durable 状态分布 |
| 监测变化        | 最新 run 成功 probe 中品牌提及 / 该 run 成功 probe；`delta` 只比较最近两个都有成功样本的 run                      |

每张卡都返回 nullable `value/numerator/denominator`、sample time、`successful/failed/pending/total`、availability、evidence anchors 和方法说明。零成功分母时值是 `null`，不是 `0%`。引擎 Provider 未配置来自 typed capability 状态，不能从零数据猜测。成功样本少于 3 条的 `sampleSufficiency=insufficient` 与 `failed>0` 的 partial-failure note 是两个独立信号；历史真实数据在 Provider 后来不可用时仍保持 available。`submitted` 只代表渠道已受理，绝不显示成 published 或 indexed。

## 有界投影与 exact 下钻

普通控制面最多返回 8 个/指标 evidence anchors、20 个趋势点、50 个问题矩阵行和 30 条观察日志，不复制文章正文或所有 Provider response。文章正文继续由 Ticket 11 的受限磁盘数据面持有。`monitor-run` exact 下钻也只返回稳定排序的前 50 个 unit 状态/error anchors，并给出 `unitCount` 与 `truncated`；只有单个 `baseline-unit` 或 `monitor-unit` exact 下钻才返回对应原始回答/evidence。所有默认测试使用 SQLite fixture、mock capability 和无网络 DOM/Node 路径，不读取凭据或调用真实 Provider。
