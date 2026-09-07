# 一表两聚合：产物血缘 owner 先于拆表

## Context

`geo_operations` 表实际承载两个聚合：**主链 GeoOperation 状态机**（结构化行，`geo_operations.rs` 管理——`apply_action` 即 transition 函数，16 种 action 各自带 from-state 守卫，CAS revision，9 态词表经 `geoOperationContract.json` 双侧 pin）与**产物血缘行**（`kind='artifact-lineage'`，行 id 即各域操作 id，支撑品牌档案血缘视图与会话删除阻塞判定）。血缘行由 7 个领域模块 **27 处**生产 SQL 直写（articles 2、baseline 2、question-pool 3、topic-plan 2、distribution 3、publish 9、monitor 6），**31 个状态字面量内联无源**、无迁移校验；主链操作机的查询处处带 `kind!='artifact-lineage'` 过滤（6 处）避让，`notifications` 按 kind 分叉分类。

2026-09-04 架构巡检把该表现列为候选 1（Strong）：表结构穿透模块缝，第二个写缝可静默滋生。同日全仓盘点证实主链操作机本身已是深模块——**病灶只在血缘系**。巡检的第一反应是「拆表」；grilling 三轮修订题设后裁决分阶段收口（`specs/plans/2026-09-04-artifact-lineage-owner-spec.md`）。

## Decision

### 1. 血缘写路径收敛唯一 owner，主链操作机零改动

血缘的全部写（INSERT 四列＋UPDATE `state` 单列）收敛到唯一 owner（`artifact_lineage.rs`）：`ArtifactLineageState` 枚举 31 变体单源词表＋`open_lineage`/`set_lineage_state` 两函数接口（拿 `&Connection`，血缘 SQL 唯一居所）。立项阶段等价搬家：数据库值一字不改、幂等语义逐位保持。主链操作机（`apply_action`/`advance_operation`/CAS/takeover/`transition_workspace_operations`）原样。

### 2. 拆表不现在做——表拓扑降级为 owner 的实现自由

血缘行留在 `geo_operations` 表。一旦全部写经 owner 接口，「表怎么分」（拆独立表、dashboard 4 处 JOIN 改写、主链操作机的 kind 过滤移除）变成 owner 的**内部实现细节**：届时拆表是零调用点波及的内部迁移，不再动 27 个写点。拆表作为独立后续票，触发条件＝kind 过滤 wart 或血缘行形状约束（如需要血缘专属列）再次造成实际摩擦；不按日历触发。

### 3. 裁决由守卫棘轮钉死，不靠纪律

vitest 守卫只允许 `geo_operations.rs` 与 `artifact_lineage.rs` 两处生产 SQL 写点；豁免表初始登记现存 27 项、逐域清零、终态零豁免。豁免表清零前，现存直写是登记在册的过渡态而非违规；清零后任何新直写红灯。

### 4. 契约边界

血缘词表不进跨语言契约 JSON（TS 无消费方，不满足 ADR-0012 双侧前提）；与血缘态部分同形的会话删除原因词表（10＋4 值）pin 进 `geoOperationContract.json`，防改血缘词表时误伤同形串而无红灯。

## Considered Options

- **现在拆表**（独立 `geo_artifact_lineage` 表）：否决——影子表迁移＋dashboard JOIN 改写＋notifications 分类改写的成本前置，且与「收写路径」耦合在同一批调用点上；先收接口后拆表，把改动摊成两次：一次接口切换（等价搬家）、一次零调用点波及的内部迁移。
- **只收词表**（常量＋守卫、写点不动）：否决——SQL 仍散在 7 文件，缝仍漏；「词表单源但写法散装」是半截治理。
- **全聚合仓库（读写全收）**：否决——读路径（dashboard JOIN、notifications classify）现状不泄漏迁移语义，YAGNI。
- **每域一族记录函数（≈21 个）**：否决——接口与实现一样宽，浅模块。
- **主链状态机一并重构**：否决——盘点证实它已是深模块，动它是无收益风险。

## Consequences

- 31 个血缘状态字面量从 7 文件收敛到 owner 枚举一处；血缘迁移语义第一次获得单一测试面（此前「非法血缘状态」无处断言）。
- 主链操作机与血缘的耦合面收窄为：同表共存＋A 机 kind 过滤（wart 保留至拆表票，属登记在册的有意过渡态）。
- 未来架构巡检不应把「`artifact_lineage.rs` 写 `geo_operations` 表」或「A 机 kind 过滤」单独列为治理候选——那是本文登记的过渡态；重开需新证据（实际摩擦触发拆表票）。
- 逐域清零票顺带钉该族 from-state 规则（谁迁移谁钉，规则来自真实代码）；from×to 全量矩阵不预铺。
- 与 ADR-0012 同向：能进共享 JSON 的（删除原因词表）进 JSON 裁判，单侧词表（血缘 31 态）留在语言内单源。CONTEXT.md「产物血缘（Artifact Lineage）」词条（2026-09-04）与本文互为引用。
