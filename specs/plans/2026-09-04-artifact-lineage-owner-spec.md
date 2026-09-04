# Spec：产物血缘 owner 收拢（geo_operations 一表两聚合）

> 状态：ready-for-agent
> 关联文档：`docs/adr/0013-artifact-lineage-owner-before-table-split.md`（同日立项）、`specs/tech_docs/geo_operations.md`、`specs/tech_docs/pit_of_success.md`、CONTEXT.md「产物血缘（Artifact Lineage）」（2026-09-04 新登词条）
> 来源：2026-09-04 架构巡检候选 1（Strong · in-process）。证据经全仓盘点核实：`geo_operations` 表住着两个聚合——主链操作机（`kind!='artifact-lineage'`）与产物血缘行（`kind='artifact-lineage'`，7 域 **27 处**生产 SQL 写点、**31 态**词表内联无源、全库无行级 DELETE、生产写入全部在 Immediate 事务内）。

## Problem Statement

`geo_operations` 一张表承载两个聚合。**A 主链操作机**（`geo_operations.rs`）是分层干净的深模块：`apply_action` 即 transition 函数（16 种 action 各自带 from-state 守卫＋目标态）、CAS revision、单一读入口，9 态词表由 `geoOperationContract.json` 双侧 pin——它不是病根，**零改动**。**B 产物血缘行**没有 owner：7 个领域模块 27 处直写 SQL（articles 2、baseline 2、question-pool 3、topic-plan 2、distribution 3、publish 9、monitor 6），31 个状态字面量内联在各文件，无单源、无迁移校验、未进任何契约；A 机的全部查询要带 `kind!='artifact-lineage'` 过滤（6 处）避让它们，`notifications` 还要按 kind 分叉分类。表结构穿透了模块缝：改一个血缘状态字面量要 grep 全仓，新域只能复制粘贴内联 SQL，第二个写缝可以静默滋生。血缘行支撑品牌档案的产物血缘视图与会话删除阻塞判定——词表漂移会以错误展示/错误阻塞的形式直达用户。

另有一个伴生的跨语言敞口：会话删除原因词表（`SessionDeleteFailureReason` 10 值、`SessionPersistentOwnerReason` 4 值子集）在 Rust 删除谓词、TS 字面量联合、i18n 文案三处同形无 pin，且 `'monitor-active'` 与血缘态同形——改血缘词表时可能误伤它而无红灯。

## Solution

血缘写路径收拢唯一 owner：新模块 `artifact_lineage.rs`，`ArtifactLineageState` 枚举 31 变体单源词表，接口仅 `open_lineage(id, session, state)` / `set_lineage_state(id, state)` 两函数（拿 `&Connection`，血缘 SQL 唯一居所）。立项阶段**等价搬家**：数据库值一字不改、幂等语义逐位保持、零写点迁移。vitest 守卫棘轮落地：生产代码对 `geo_operations` 的 INSERT/UPDATE SQL 只允许出现在 `geo_operations.rs` 与 `artifact_lineage.rs`，豁免表初始登记 27 项、逐票清零、终态零豁免。删除原因词表两键 pin 进 `geoOperationContract.json`。拆表与否降级为 owner 的实现自由（ADR-0013 裁决），后续独立票。

## User Stories

1. 作为维护者，新增或修改一个血缘状态只动 owner 枚举一处，不再 grep 七个文件找字面量。
2. 作为维护者，血缘词表成员与迁移规则第一次有了单一测试面——「非法血缘状态」在立项前根本无处断言。
3. 作为维护者，任何人在生产代码里新写 `INSERT/UPDATE geo_operations` 直写，守卫立即红灯——第二个写缝无法静默滋生。
4. 作为维护者，豁免表就是清零进度表：剩几个域没迁、各剩几处，守卫输出一目了然。
5. 作为 GEO 用户，品牌档案的产物血缘视图展示不因词表漂移出错——状态值出自单源枚举。
6. 作为 GEO 用户，会话删除阻塞判定与现状逐位一致（等价搬家红线），不会因收拢而误拦/漏拦。
7. 作为维护者，TS/Rust 两侧删除原因词表漂移立即红灯（pin 四处改齐），改血缘词表时不会再误伤 `'monitor-active'` 同形串而无感知。
8. 作为测试作者，血缘迁移语义经 owner 接口在 tempdir SQLite 直测，不需要搭任何域服务桩。
9. 作为未来贡献者，读 `artifact_lineage.rs` 一个文件即得全部词表、族划分与迁移规则，无需考古七个域模块。
10. 作为未来的架构巡检，不会再把血缘行误判为「绕过 owner 的写点」——CONTEXT.md 术语、ADR-0013、守卫三层护栏共同钉死口径。
11. 作为维护者，每个域的清零票独立验收、独立回滚，publish 域 9 处大票可与 publish_scheduler 拆分（架构巡检候选 8）合谋时机。
12. 作为主链操作机的维护者，本 spec 全程零波及：A 机 ~15 个转移测试、publish_scheduler 68 个测试（均不断言血缘态）原样绿。

## Implementation Decisions

1. **拓扑：先同表收 owner，拆表降级为实现自由**。血缘行留在 `geo_operations` 表，owner 只收写路径；一旦全部写经接口，表怎么分变成 owner 内部重构，届时不再动 27 个调用点。*否决：现在拆表*——影子表迁移＋dashboard 4 处 JOIN＋notifications 分类改写的成本前置且绑定本票；*否决：只收词表不收写点*——缝仍漏，守卫无从豁免清零。裁决沉淀 ADR-0013。
2. **owner 模块与接口形状**：`src-tauri/src/brand_workspace/artifact_lineage.rs`，自由函数拿 `&Connection`（`pub use *` 平铺下零登记成本），血缘 SQL 唯一居所；store 方法与域函数变薄壳调用。接口＝`ArtifactLineageState` 枚举＋`open_lineage`/`set_lineage_state` 两函数。*否决：每域一族记录函数（≈21 个，接口与实现一样宽）；泛化字符串参数（词表继续无源）*。
3. **枚举形态与串映射**：扁平单一枚举 31 变体（域前缀 PascalCase，如 `QuestionPoolGenerating`），配 `ALL` 常量表＋`family()` 助手（镜像 `OPERATION_STATUSES` 既有风格）；`Display` 精确映射现状 kebab 串，**数据库值一字不改**。错误码 `artifact_lineage_state_invalid` / `artifact_lineage_transition_invalid:{from}`，镜像 `geo_operation_transition_invalid:{current}` 风格。*否决：每域子枚举（接口宽出 6 个类型）；趁势美化串名（触发数据迁移＋破坏 i18n 同形串）*。
4. **等价搬家语义**：`open_lineage`＝INSERT，重复 id 报错（现主键冲突行为）；`set_lineage_state` 对缺失行 no-op（现 UPDATE 影响 0 行被忽略的行为，如 retry 复活分支）；立项票不做任何语义收紧——收紧属逐族清零票职权，按该族调用方真实期望裁决。
5. **守卫棘轮**：vitest 守卫与 `crossLanguageContractGuard.test.ts` 同居（复用 `repoFileScan` 读 Rust 源文本），生产段＝首个 `#[cfg(test)]` 之前的文本；正则匹配 `INSERT INTO geo_operations` / `UPDATE geo_operations`；allowlist＝{`geo_operations.rs`, `artifact_lineage.rs`}；豁免表初始 **27 项**（按域×写点登记），逐票清零、终态零豁免；守卫自测钉「生产段切分」启发式与「故意注入直写样例必红」的变异演示。测试 fixture 的裸 INSERT 不受约束（守卫只看生产段）。
6. **迁移守卫强弱分档**：立项票 owner 只做词表成员校验（set 值 ∈ `ALL`）；from-state 表随每域清零票逐族补——谁迁移谁钉规则（如 `monitor-paused` 只能自 `monitor-active`），规则来自真实代码而非想象（聚合驱动型转移如 article refresh 的 from 集合可能是多对多，一次铺全量矩阵会逼人编规则）。*否决：立项即全量 from×to 矩阵*。
7. **删除原因词表 pin**：`geoOperationContract.json` 新增 `sessionDeletionFailureReasons`（10 值）与 `sessionPersistentOwnerReasons`（4 值子集）两键，TS 侧 `tauriClient` 字面量联合与 Rust 删除谓词产出双侧 pin（ADR-0012 四处改齐摩擦照旧）。血缘词表本身**不进** JSON——TS 无消费方，不满足双侧契约前提。
8. **A 机零改动红线**：`apply_action`/`advance_operation`/CAS/takeover/`transition_workspace_operations`/kind 过滤全部原样；kind 过滤 wart 随未来拆表票消失，不在本 spec。
9. **票切分**：立项票（owner＋枚举＋守卫＋豁免表 27 项＋pin 两键，**零写点迁移**，纯增量全绿）＋七域清零票各一张（迁该域全部写点＋补该族 from 规则＋豁免表消项）；首张清零选 **baseline 族**（4 态 2 写点，最小样板）；publish 域 9 写点票与架构巡检候选 8（publish_scheduler 拆分）合谋时机。分支建议 `geo/artifact-lineage-owner`。
10. **顺序**：本候选（巡检候选 1）→ 持久化内核（候选 2）→ publish_scheduler 拆分（候选 8）；owner 是后两者的挂点。

## Testing Decisions

- **接口即测试面**：owner 接口测试经真实 tempdir SQLite 直测（先例：`geo_operations.rs`/`publish_scheduler.rs` 文件内 `#[cfg(test)]`＋真实 `BrandWorkspaceStore` 形态），只断言外部行为（词表成员、开/迁结果、错误码），不断言 SQL 文本。
- **等价性验收**：全量 `cargo test` 与 `npm test` 绿→绿；ppm 两处 `SELECT state FROM geo_operations` 断言（`monitor-active`/`monitor-paused` 路径）原样守护；A 机 ~15 个转移测试与 publish_scheduler 68 个测试零改动即绿。
- **新增钉**：(a) 词表钉——`ALL` 恰为 31 态、`Display` 映射与现状串逐字一致（防搬家改名）；(b) 成员校验钉——set 非法串返回 `artifact_lineage_state_invalid`；(c) 幂等钉——open 重复 id 报错、set 缺失行 no-op；(d) 守卫钉——豁免表恰 27 项、allowlist 恰两文件、生产段切分自测、注入直写样例必红。
- **pin 钉**：新两键在 TS pin 测试与 Rust pin 测试双侧逐键 expect（ADR-0012 口径）。
- **清零票验收模板**：该域豁免项归零＋该族 from 规则测试在位＋全量测试绿。

## Out of Scope

- A 主链操作机的任何改动（Decision 8 红线）。
- 拆表迁移与 kind 过滤移除（ADR-0013 登记为后续独立票）。
- 架构巡检候选 2（持久化内核）、候选 8（publish_scheduler 拆分）及其余候选——各自独立成案。
- 血缘词表进跨语言 JSON（无 TS 消费方）；血缘行读取路径（dashboard JOIN、notifications classify）的任何重构。
- from-state 全量矩阵（逐族清零票职权）；语义收紧（open 幂等化、set 缺失报错）。
- 测试 fixture 裸 INSERT 的清理（守卫只约束生产段）。

## Further Notes

- **票依赖骨架**：立项票（零依赖，纯增量）→ 七域清零票（各依赖立项票，彼此独立；publish 票建议与候选 8 协调）。验收＝守卫绿＋豁免表相应项归零＋npm/cargo 全绿。
- **决策日志**：grilling 三轮全按推荐锁定。Round 1 题设修订（「13 模块绕过状态机」修正为「一表两聚合、病灶在血缘系」——A 机盘点证实已是深模块）；Round 2 拓扑/接口/守卫/枚举/pin/ADR/票切分；Round 3 命名映射/幂等语义/收尾动作。共识摘要口径「21 处写点」经全仓盘点修正为 **27 处**（按 SQL 文本出现计）。
- **词汇沉淀**：产物血缘（Artifact Lineage）已进 CONTEXT.md（2026-09-04）；ADR-0013 同日立项（满足难逆/无上下文困惑/真实取舍三条件——不记录则未来巡检必重提拆表）。
- **证据底座**：2026-09-04 三路架构勘察（TS 服务层/Rust 工作台层/共享契约与渲染层）＋ geo_operations 写点全仓盘点（两套写入体系判定、27 生产写点定位、31 态词表清点、事务纪律与 DELETE 缺位确认、TS 侧零 SQL 写入确认）。
