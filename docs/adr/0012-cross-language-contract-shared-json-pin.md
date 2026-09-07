# 跨语言契约：共享 JSON 双侧 pin（裁判模式）

## Context

截至 2026-09-03 架构评审，仓内约有 20 项 TS↔Rust 常量契约靠手写镜像维持：`publish_scheduler.rs` 的 POLICY_VERSION 带「逐字同步」注释、点数公式三处「同式」（shared / Rust / 网关 backend）、`geo_operations.rs` 的九张枚举表连同步注释都没有（纯裸放镜像）、发布执行/条目状态枚举只活在 SQL CHECK 字符串里。漂移没有任何测试拦截，直接落到线上：2026-09-01 配图事故的根因是 server egress 路由的**第三份**手抄副本硬编码 3，确定性拒绝了 8 图批准稿——两侧同步注释连第三份副本的存在都无法暴露。

仓内已有验证过的先例机制：`materialImagePlaceholderContractCases.json` / `rankingCompetitorContractCases.json` 由 Rust `include_str!` pin 测试与 TS import pin 测试双侧消费，运转正常。本 ADR 把该机制定为全仓规则并推广到全部双源契约。

## Decision

### 1. 裁判模式：JSON 是裁判，不是源

契约值以 `src/shared/**/*Contract.json`（geo 域在 `src/shared/geo/`）为第三份裁判；两侧保留手写常量 / union type，Rust `include_str!` + pin 测试、TS import + pin 测试断言**严格相等（含顺序）**。运行时行为零变化。故意变更需 JSON 与两侧常量三处改齐才绿灯——这是契约想要的摩擦：改齐的过程强制两侧测试套件同时过一遍。

命名：常量表契约用 `*Contract.json`，与先例的用例型契约 `*ContractCases.json`（带 cases 数组跑参数化测试）区分。键名 camelCase、与 TS 侧常量对齐；非显然语义（如重试表的产品语义日期）加 `_comment` 字段，纯枚举不带。

### 2. 三子类统一走同一机制

- **枚举集**（状态/种类/能力表）：有序数组，严格相等。
- **版本戳**（各 POLICY_VERSION）：只钉当前值等值。存量库里的旧版本串是数据不是契约，永不枚举进 JSON；语义零变更——publish 版本戳只冻结「发布什么＋不可逆影响」（见 CONTEXT.md「发布确认摘要」），重试语义变更不升版。
- **限值与公式**：数值直接 pin；公式（点数 `ceil(分×4/25)`）＝参数（multiplier/divisor/rounding）＋**用例向量**（0、非整除、大额边界），全部实现（shared / Rust / 网关 backend）跑同一组 cases——只钉参数测不出算式结构漂移（Rust `(cents*4+24)/25` 与 TS `Math.ceil` 现状即异构）。

### 3. SQL CHECK 枚举提为常量、DDL 生成式

发布执行/条目状态枚举从 SQL CHECK 字符串提为 Rust 常量，CHECK 子句由常量 `format!` 生成；`extend_publish_status_checks()` 重建迁移的字符串替换目标同步改为从常量生成。存量库本次零迁移（值不变约束不变）；未来加值仍走表重建路径。

### 4. 双守卫防新增

vitest 守卫测试两条：(a) 同步注释词汇（`同源` / `逐字同步` / `逐字一致` / `两处同源` / `同一序列` / `Keep in sync` / `independently mirrors`）在非测试源文件中零命中；(b) 每个 `*Contract.json` 必须同时被 Rust `include_str!` 与 TS import 引用（防孤儿 JSON）。守卫以「现存同步注释清单为初始豁免表」的 ratchet 形式落地，各迁移票逐项删除，末票清空豁免表达成零命中终态。规则同步入 `specs/tech_docs/pit_of_success.md`。

### 5. 七票增量落地

机制票（守卫）→ publish_scheduler 族试点 → geo_operations 九表 → articleGeneration 族 → 点数三源＋分发限额 → provider 字符串＋图片白名单 → 其余版本戳＋BINARY_EXTENSIONS 收尾。每票验收含**变异演示**：故意改一侧一个值 → 该侧测试红（PR 留证后复原）。

## Considered Options

- **派生模式（一侧或双侧从 JSON 生成常量）**：否决——TS 从 JSON import 推不出字面量 union（数组推断为 `string[]`），保类型就得保手写；Rust 需 `OnceLock`+serde 运行时解析或 build.rs 代码生成，引入新构建机制且改变运行时形态。裁判模式零运行时变化、与先例同构。
- **build.rs 代码生成 .rs/.ts**：否决——新构建步骤，生成物入仓或构建期生成两难；20 项常量表不值得。
- **维持注释同步**：否决——9-01 事故证明该模式连第三份副本的存在都无法暴露，且 `geo_operations` 九表实际连注释都没有。
- **集中式单文件（如 crossLanguageContracts.json）**：否决——与 shared 模块族失去局部性对应；按域分文件，契约与被 pin 模块、其 pin 测试同址。

## Consequences

- 契约故意变更需改三处，两侧测试套件红到改齐为止；豁免表清零后，任何新增「与 TS 同步」类注释直接红灯。
- 迁移完成后全部同步注释删除，由守卫接管；pin 测试放各消费模块自己的测试文件（Rust 同文件 `#[cfg(test)]`、TS 模块测试、backend 在 `backend/tests` 测试侧 import——网关运行时零耦合，Docker 构建不受影响）。
- 与 ADR-0006「不变量为体、文本为用」同向；先例 `materialImagePlaceholder` / `rankingCompetitor` 机制由个例升级为全仓规则。
- TCP 端口类**不入**本机制（核实为 Rust 单源动态分配、env 传递）；`ARTICLE_IMAGE_QUOTA_BY_TYPE` 为有意单侧策略，不入。
