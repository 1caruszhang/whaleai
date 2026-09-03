# Spec：阶段顺序闸上移到工具注册层

> 状态：ready-for-agent（架构评审候选 3 + grilling 三轮收敛版，2026-09-03）· 未实现
> 关联文档：`specs/plans/2026-09-02-geo-plan-normalization-spec.md`（票 05 顺序闸源头）、`src/server/geo/stage-order-gate.ts`、`src/server/geo/operation-progress.ts`
> 来源：2026-09-03 架构评审候选 3（Strong · in-process）；证据行号已按当前 HEAD（ed247d1，含组合根票 A/B 合入）重新核实

## Problem Statement

顺序闸本体（`src/server/geo/stage-order-gate.ts`，182 行）是分层干净的深模块：`assessStageToolOrder(tool, operations)` 纯函数三态裁决＋`stageToolOrderRejection(identity, tool)` 异步包装（自带操作服务访问、fail-closed）。但它的缝开在五个工具 handler 头部的同构插桩上（`src/server/tools/xiaojing-geo-tool.ts:1762 / 1834 / 1890 / 1991 / 2049`，恒两行「查闸→命中即拒」）：新增第 6 个阶段工具要记得手动插桩，忘了即静默绕闸，只靠集成测试事后兜。

另有两处伴生问题：其一，闸表 `GEO_STAGE_ORDER_GATED_TOOLS`（stage-order-gate.ts:19-25）与 `GEO_NEXT_STEP_GUIDES`（operation-progress.ts:172-218，7 个不同工具）是双源——闸的放行判定本就查 Guides 表（stage-order-gate.ts:102-107），被闸五工具恰是 Guides 工具集减去材料/记录类两工具的子集，两处字面各自维护；「忘加闸表」与「忘插桩」是同一个洞的两种忘法。其二，`stageToolOrderRejection` 的 fail-closed 分支（操作状态读不到 → `geo_stage_order_unavailable` 同构拒绝）全仓零测试覆盖——闸的安全姿态只活在注释里。

对维护者：给新阶段工具接闸是三步人肉纪律（加 Guides 引述、加闸表、handler 插桩），漏后两步均无构造性拦截。对用户：越序调用是否被结构化拒绝取决于维护者是否记得插桩，路径纪律存在静默退化的通道。

## Solution

闸从 handler 内部上移到注册缝：新建注册助手 `stageOrderGatedTool`，五个阶段工具经它注册，闸调用与拒绝信封构造收进助手实现；五段 handler 内插桩全删。闸表改为**派生**——被闸集 := `GEO_NEXT_STEP_GUIDES` 工具集 − 显式不闸白名单，消灭双源：新增阶段工具进 Guides 即自动入闸，不闸必须显式写白名单（有意识裁决）。闸先行对五工具无条件成立（唯一登记的窄偏离见 Decision 2），fail-closed 分支与注册期 fail-loud 均补测试钉。行为等价（单点登记偏离除外），既有单测 14＋MCP 集成 5 原样守护。

## User Stories

1. 作为 GEO 用户，未来新增的阶段能力自动受顺序闸保护，不会出现「业务层放行越序调用、状态机纹丝不动、叙事与状态分叉」（f74ce69e 类脱节）的静默退化——闸是构造保证，不是插桩自觉。
2. 作为 GEO 用户，操作状态读取故障时阶段工具仍被 fail-closed 拒绝并指路，绝不半执行——该姿态从注释升级为测试钉。
3. 作为主 Agent（小静），越序调用的拒绝信封（三态、nextStep 引述、heldStep 指引口径）与票 05 时代逐字一致——上移是搬家不是改闸。
4. 作为维护者，新增第 6 个阶段工具时只改 `GEO_NEXT_STEP_GUIDES` 一处（本来就要加引述），工具自动入闸；想让某个 Guides 工具不闸，必须把名字写进显式白名单并给理由。
5. 作为维护者，派生闸表若有增减（新工具自动入闸、白名单扩充），守护测试变红强制显式确认——闸覆盖面的变化永远是一次有意识的提交。
6. 作为维护者，想知道「哪些工具被闸、为什么不闸、拒绝信封长什么样」时，读 `stage-order-gate.ts`＋注册助手两个文件有全部答案，不在五个 handler 里找插桩。
7. 作为维护者，误用注册助手（拿它注册派生集外的工具）在 `createXiaojingGeoServer` 构造期即 fail-loud，不等到运行时。
8. 作为测试作者，注册层闸行为可在进程内直测（managementApi mock 既有先例），不需要起真 sidecar。
9. 作为下一个会话的贡献者，读注册助手模块即理解闸的完整口径矩阵（何时拒、拒成什么样、哪些工具豁免及原因），不需要考古票 05 与五处注释。

## Implementation Decisions

1. **wrapper 为独立小模块**（`src/server/tools/stage-order-gate-registration.ts`）：导出注册助手 `stageOrderGatedTool(toolFn, def)`（def＝名/描述/schema/handler，toolFn 即 SDK 动态 import 到手的 `tool`），内部完成闸调用＋拒绝信封构造。`stageOrderGateResult`（现 xiaojing-geo-tool.ts:568-572 模块级私有）随迁入该模块；identity 经参数注入——调用方传既有 `stageIdentity()`，wrapper 与 handler 闭包读同一模块级 `context` 引用，**不动组合根**（`stageToolOrderRejection` 只要 identity，自带操作服务访问）。*否决备选：塞进 xiaojing-geo-tool.ts 当局部 helper*——2092 行工具文件只减不增；闸的拼装知识独立成模块才可独读（小深模块风格，stage-order-gate.ts 自身即先例）。
2. **闸先行无条件统一（含唯一登记的窄偏离）**：五工具一律闸先于 handler 一切工作。唯一可观察行为变更：`generate_articles`（现 xiaojing-geo-tool.ts:1884-1891 先做纯入参解析再闸）在「互斥入参错误 × 越序调用」交叉点，从返回 isError 校验错变为返回闸拒绝信封；其余四工具语义不变。已核实无既有测试钉此交叉（`articleOperationSourceFromGenerateInput` 仅纯函数单测）。*否决备选：per-tool 闸前置校验配置 / 该工具保留 handler 内插桩 / 纯校验上提进 wrapper 配置*——三者都把单工具变异固化进接口或留下未收敛点，重开「记得配置」类人肉洞（组合根 spec Decision 9 否决过的「接口为特例变宽」同族）；且交叉点上是模型 UX 角落，越序＋坏入参时给指路信封比给校验错更有用。
3. **闸表派生，消灭双源**：`GEO_STAGE_ORDER_GATED_TOOLS` := `GEO_NEXT_STEP_GUIDES` 值域工具集 − 显式不闸白名单 `GEO_STAGE_ORDER_UNGATED_TOOLS`＝`["request_brand_material"`（计划外补材料是合法入口，票 05 口径）, `"choose_next_round_knowledge"`（知识段用户答复记录，无产物无花费，与材料类同口径）`]。派生集恰好等于现五工具（Guides 7 工具 − 2 白名单，等价由守护测试证明）。类型随派生从字面量联合放宽为 string（仅服务端内部消费点，无外部契约面）。闸表无 Rust 消费方（全仓仅定义＋两个测试三处引用），**不入共享 Contract.json**（ADR-0012 口径：pin 只锁双侧契约）。
4. **注册期 fail-loud**：派生集外的工具名经 `stageOrderGatedTool` 注册 → 注册助手在 `createXiaojingGeoServer` 构造期 throw——闸覆盖面是构造事实，误用早死。
5. **既有五段插桩注释的裁决理由收进 wrapper 模块文档注释**：「在任何业务工作（含缺省产品线回读）之前被拒」「prepare_publish 只读预览也闸」等 rationale 不随插桩删除而失传，与「白名单两工具为什么不闸」同处沉淀。
6. **单票交付**：注册助手落地＋闸表派生＋五段插桩删除＋补测一次合入。*否决备选：两票（先试点一个工具再全删）*——改动面小、既有集成测试已是验收网；中间态＝闸双挂在 wrapper＋插桩两处，恰是要消灭的形态。分支建议 `geo/stage-order-gate-upmove`。
7. **闸本体零改动**：`assessStageToolOrder` 纯函数、三态信封结构、放行从宽口径（任一非终态操作当前步应调工具恰等被调工具）、heldStep 指引按 authority 区分（publish/monitor 指路产品界面不指路聊天卡片）全部原样——本 spec 只动「闸在哪里被调用」，不动「闸怎么判」。

## Testing Decisions

- **等价性验收**：合入前后现有全部 TS 单测与集成测试结果一致（绿→绿）；既有顺序闸单测 14 例（`stage-order-gate.unit.test.ts`）与 MCP 集成 5 例（`xiaojing-geo-stage-order-gate.integration.test.ts`，含「每工具恰好一次 `/api/brand-geo-operations/list`、零业务路由触达」的协议级时序断言）原样守护——时序断言的落点从 handler 头部变为 wrapper，行为等价则 mock 面不变。
- **「恰好五工具」钉改写为派生钉**（stage-order-gate.unit.test.ts:82-94）：断言派生集 == 现五工具 ∧ 白名单 == 恰好两工具。此后 Guides 增工具、白名单扩充都经此钉强制显式确认。
- **注册层防线新增**：(a) 派生集内工具经助手注册后实际被包闸（越序被拒）——与既有集成 (2) 同源互证；(b) 派生集外工具不被误包——既有集成 (5)（只读查询与材料工具不闸）延续；(c) 信封同构等价钉——既有集成 (2) 的信封与时序断言原样绿即迁移等价证明（仓库「三处同源＋集成测试钉逐字一致」先例同族）。
- **fail-closed 补测一条**：managementApi mock 令 list 报错 → 工具返回 `geo_stage_order_unavailable` 信封、零业务调用——`stageToolOrderRejection` 的 catch 分支从零覆盖到有钉。
- **fail-loud 直测一条**：派生集外工具名调用 `stageOrderGatedTool` → throw（纯单测直调，不起 server）。
- **Rust 侧不涉及**（闸表无 Rust 消费方，本变更纯 TS 服务端）。

## Out of Scope

- 闸本体判别逻辑的任何调整（Decision 7 红线：三态裁决、放行口径、指引口径全部不动）。
- `GEO_NEXT_STEP_GUIDES` 表本身的重构与提示词纪律单源化（架构评审候选 6，独立成案）。
- 闸表入跨语言共享 JSON pin（无 Rust 消费方，不满足 ADR-0012 双侧契约前提）。
- 只读查询与材料类工具（`inspect_geo_operations`、`request_brand_material` 等）的任何闸化。
- HTTP 面板路由与闸门修订路径（闸只在 MCP 工具层，面板不经 MCP 工具）。
- 架构评审其余候选（管理端路由表、轮询刷新统一、竞品名单深模块、material-import 拆分等）——各自独立成案。
- `generate_articles` 交叉点行为变更之外的任何行为统一——本票唯一登记偏离即 Decision 2 那一处。

## Further Notes

- **票依赖骨架**：单票，无内部依赖；验收＝全量测试绿＋上述新增测试在位。
- **变异矩阵存档（收敛前现状，验收对照用）**：五段插桩同构两行式；`run_question_pool`/`plan_topics`/`plan_distribution` 标准形态（注释文案各异）；`generate_articles` 纯入参解析先于闸（唯一顺序变异，本票消解并登记为窄偏离）；`prepare_publish` 仅注释/identity 声明顺序差异（无可观察语义）。
- **证据链摘要**：f74ce69e（业务层放行越序、状态机纹丝不动）为票 05 立闸实证；评审行号经组合根票 A（净 -86 行）漂移已按 HEAD 重核；「闸表×Guides 双源」「fail-closed 零覆盖」「无注册层 wrapper 先例」均经 2026-09-03 探查核实（`tool()` 全 24 处裸 SDK 调用；admission 包装先例在 provider 能力层，不在工具层）。
- **决策日志**：grilling 三轮收敛——Round 1 身份确认（评审记录 HTML：候选 3＝顺序闸上移）；Round 2 等价红线/单票/三防线测试/spec 产出形态；Round 3 全按推荐锁定（generate_articles 窄偏离、闸表派生消双源、独立 wrapper 模块、fail-closed 补测）。
- **词汇沉淀口径**：「注册缝」「派生闸表」为架构词汇，不进 CONTEXT.md；领域侧无新概念，不建 ADR（注册层随时可逆，不满足「难以逆转」）。
