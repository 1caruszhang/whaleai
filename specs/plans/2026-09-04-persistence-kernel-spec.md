# Spec：持久化内核（BrandWorkspace 开库 · 迁移 · 会话闸 · 事务 · 错误映射单源）

> 状态：**全部五票结案**（分支 geo/persistence-kernel）。立项票 01 已落地（8f60eb6——内核 persistence.rs：`open()` 唯一开库入口＋per-path 迁移登记表〔首开持锁串行，幂等探测留作跨进程兜底〕＋会话闸单实现与 10 闸声明〔错误串逐字钉〕＋`with_immediate_tx`/`sql_err`/纯等价工具族；cargo 守卫棘轮三条规则落地，豁免表按守卫生产段口径登记现实基线 **11 文件**〔巡检记 13 为笔误：knowledge/geo_baselines/post_publish_monitoring 的 ensure_schema 直呼与 articles/materials 等 5 文件的 Connection::open 实为测试段命中，巡检另含 kernel 文件自身〕，纯增量全绿）；清零票 02 已落地（161473a——热 churn 三文件 post_publish_monitoring/publish_scheduler/brand_workspace.rs 56 站点改走 `store.open()`，闸变体/事务样板/工具副本切换内核版，豁免 11→9）；清零票 03 已落地（a4fb7e4——内容域三文件 articles/materials/distribution_plans 35 站点改走 `store.open()`，materials 两段闸错误逐字保持，两处存量迁移测试的重探测触发显式化，豁免 9→6）；清零票 04 已落地（7ef70f0——九文件 38 站点改走 `store.open()`＋geo_operations 7 处开库后重复 ensure 清理＋内联闸收编进 GEO_OPERATION_SESSION〔10 闸全部接驳、域内变体清零〕，豁免 6→1）；收缩票 05 已落地（a8e8365——旧开库函数本体删除〔含 `#[allow(dead_code)]` 过渡标记〕，仓内 rg 零引用；14 文件测试段 fixture 调用与 import 收编走 `store.open()`；三处存量迁移测试的中段重探测〔articles 旧 CHECK 重建、materials processing CHECK 加宽、brand_workspace 旧 session 外键影子重建〕改经内核 `forget_migration` 测试钩子〔`#[cfg(test)]`，「新进程首开」的进程内等价替身〕触发，断言零改动；守卫豁免表清空 1→0——**0 项严格相等终态钉死**，三条规则此后对任何新增违例永久红灯；TS 产品壳契约的 WAL 权威钉随开库路径改指内核文件；等价全绿 cargo 495＋1＋1、npm 1248＋551＋156）。豁免表收敛轨迹 **11→9→6→1→0**（现实基线 11）。独立验收：派发方在各票落地后均以干净会话复跑双侧全量测试（cargo＋npm）与红线复核（geo_operations.rs/artifact_lineage.rs 不改名不挪窝、vitest 血缘守卫零豁免严格相等、会话闸 10 错误串钉在位），全部绿。
> 关联文档：`docs/adr/0014-persistence-kernel.md`（同日立项）、`docs/adr/0013-artifact-lineage-owner-before-table-split.md`（排序预告「血缘 owner → 持久化内核 → publish_scheduler 拆分」的中环）、CONTEXT.md「持久化内核（Persistence Kernel）」「会话闸（Session Gate）」（2026-09-04 新登词条）
> 来源：2026-09-04 架构巡检候选 2（Strong · in-process）。证据经两路只读勘察核实，并修正巡检三处数字：调用点 119→**130**（非测试）、会话闸 8→**10**（9 命名＋1 内联）、map_err ≈760→**≈923**；「一致性风险点」降级为「税」——10 个 ensure_schema 全幂等（sqlite_master 探测），重跑无正确性破口；另发现巡检漏报的 **canonical_json ×4**（同签名，distribution_plans/baselines/topic_plans/question_pools）。

## Problem Statement

BrandWorkspace 持久化的基建在 130 个调用点上逐字复制：每个 store 方法手工重演「开库（旧开库函数，票 05 收缩删除）→ PRAGMA（busy_timeout 5s / WAL / foreign_keys）→ 10 个 `ensure_schema` 串行探测（6 个含影子表重建探测）→ 2 个内联 `ensure_column` 迁移 → 会话闸 → map_err 样板」。axum 每个 HTTP 请求经 `production_store()` 重建 Store 再开库——**每个请求都重演全部 schema 探测**。会话闸 10 个同构变体（9 命名＋geo_operations 1 处内联）散在 9 文件，差异藏在 COUNT/EXISTS、validate 前置、错误码三个维度；60 处 Immediate 事务内联样板；≈923 处 `map_err` 目标全是 `String`；now_iso ×2、sha256 2 命名＋≥8 内联、canonical_json ×4。基建不在任何模块的接口后面——改一处 PRAGMA 或迁移语义要 grep 全目录，新域只能复制粘贴整副骨架。

## Solution

立持久化内核 `src-tauri/src/brand_workspace/persistence.rs`：`BrandWorkspaceStore::open()` 成为唯一开库入口；迁移按进程内 per-workspace-path 登记表只跑一遍（幂等探测保留作跨进程兜底）；会话闸收敛单实现＋每闸声明；`with_immediate_tx` 收事务样板；`sql_err` 收错误映射；纯等价工具族（now_iso/sha256_hex/canonical_json）收编。**严格等价移动**：全部 10 个会话闸错误串、每处 map_err 错误串逐字不变。cargo 文本守卫棘轮钉死（三条规则），豁免表初始 13 文件、逐票清零。

## User Stories

1. 作为维护者，改 PRAGMA、迁移编排或事务语义只动 `persistence.rs` 一处，不再 grep 13 个文件。
2. 作为维护者，每 HTTP 请求 10 遍 schema 探测的税消失（登记表命中即跳过）。
3. 作为维护者，新增一个域的 store 方法不再复制「开库→闸→事务→map_err」骨架——内核各出现一次。
4. 作为维护者，任何人在 brand_workspace 内新写 `Connection::open` 直开库、新增 `require_*_session` 变体、或绕过 open 路径直呼 `ensure_schema`，cargo 守卫立即红灯。
5. 作为 GEO 用户，一切行为逐位不变——错误串、闸语义、事务边界全部等价搬家，会话删除阻塞与产物血缘判定不受波及。
6. 作为测试作者，内核语义（迁移只跑一遍、闸口径、事务提交/回滚）第一次有单一测试面；测试照旧 tempdir 真库直测。
7. 作为未来贡献者，读 `persistence.rs` 一个文件即得开库/迁移/闸/事务/错误映射全部口径。
8. 作为候选 1（GeoOperation 主链写路径 owner）的实施者，owner 直接生在内核上，9 个写点改造一次到位、无需二次返工。

## Implementation Decisions

1. **内核形态**：单文件 `persistence.rs` 起步（长再说拆目录）；`BrandWorkspaceStore::open()` 唯一开库入口，签名等价替换 130 处旧开库函数调用（机械改写）；`initialize_database`（建库路径，含 `INSERT OR REPLACE INTO brand_workspace` 数据行）随迁移编排一并归内核。
2. **连接形态**：**保持每调用开新连接**——现状零池、WAL 下开库便宜、rusqlite `Connection` 非 Sync、tauri 走 `spawn_blocking`，无并发痛点证据；PRAGMA 每连接必设（journal_mode/foreign_keys/busy_timeout 原样）。*否决：共享连接/池*——组合根层面改动，与候选 4 纠缠。*否决：`production_store()` 缓存*——Store 只是 PathBuf 结构，无收益，spec 登记归候选 4。*
3. **迁移登记表**：`static Mutex<HashSet<PathBuf>>`（canonical path），**持锁期间执行首开迁移**（进程内并发首开串行化、避免重复迁移）；后续 open 跳过全部探测。幂等探测保留作跨进程兜底（`cancel-legacy-geo-operations.mjs` 可写、e2e 验收只读，均不跑迁移；app 进程首开必跑）。测试进程内 HashSet 随 tempdir 增长可忽略。*否决：OnceLock 全局单次*——测试每用例新 tempdir、同进程多 workspace、Store 每请求重建，三处全碎。*否决：append-only 版本表*（backend/ 范型）——换范型超本卡，留未来独立案。
4. **会话闸收敛**：单实现＋每闸声明结构（表固定 `brand_sessions`、列固定 `id`；声明＝错误码＋有无 `validate_session_id` 前置）。**10 个错误串逐字保留**（`article_generation_session_not_committed` … `publish_scheduler_session_not_found`，TS 侧 pin 不红）；COUNT→EXISTS（主键 id 可观测等价）；materials 两段错误（not found vs `brand_session_unavailable`）保留，吞细节行为逐字保持；geo_operations 内联闸（`geo_operation_session_not_committed`）一并收编。*否决：统一 validate 口径、合并错误码*——行为变更，登记遗留另议。
5. **事务助手**：`with_immediate_tx(&mut conn, |tx| ...)` 收 60 处内联 Immediate 样板，错误串逐字不变；14 个收 `&Transaction` 的内部 helper 不动；影子重建内 6 处裸 `BEGIN/COMMIT` 属 schema 机器，随迁移归内核后成内部实现细节。
6. **错误映射**：`sql_err(context)` 助手只收 `rusqlite::Error → 带上下文 String` 一层；采用随清零票棘轮逐步推进，不强制一次换 923 处。*否决：类型化 `PersistenceError`*——落点在候选 4 envelope 声明表，现在做是半截工程。
7. **工具族**：now_iso、sha256_hex（含 8 处内联 `format!("{:x}", Sha256::digest(...))`）、canonical_json ×4 收编为内核等价副本收敛；**bounded_* 截断家族排除**（300/500+脱敏等语义各异，非等价副本）。
8. **守卫棘轮（cargo 文本守卫，与 pin_tests 同居 `cargo test`）**：三条规则——①brand_workspace 内禁直呼 `rusqlite::Connection::open`；②禁新增 `require_*_session` 变体；③禁 open 路径外直呼 `ensure_schema`（geo_operations 7 处开库后重复 ensure 的站点即首批清理对象，随其清零票消）。豁免表初始 **13 文件**、逐票清零、终态零豁免；守卫自测钉「故意注入违例样例必红」。*选 cargo 不选 vitest：本守卫纯 Rust 内部事实，重构发生在 `cargo test` 里，红灯不必等 `npm test`；vitest 留给跨语言事实（0013 先例）。*
9. **文件红线**：`geo_operations.rs` 与 `artifact_lineage.rs` **不改名不挪窝**（ADR-0013 血缘守卫豁免名单恰好是这两文件，挪动即红灯）；域 SQL 语句一律留在各域文件——内核只收基建，不收 SQL。
10. **票切分（expand–contract，`/to-tickets` 修正为五票，票文件在 `.scratch/persistence-kernel/issues/`）**：立项票（内核落地＋守卫三条＋豁免表 13 文件＋工具族收编＋`open()` 就绪，**零调用点强制迁移**，纯增量全绿）＋ 3 张清零票：
    - **票 A**：post_publish_monitoring 21 ＋ publish_scheduler 20 ＋ brand_workspace.rs 16（57 站点，最热 churn 区）
    - **票 B**：articles 13 ＋ materials 13 ＋ distribution_plans 9（35 站点）
    - **票 C**：geo_operations 8（含 7 处重复 ensure 清理＋内联闸收编）＋ question_pools 8 ＋ geo_baselines 7 ＋ topic_plans 6 ＋ knowledge 5 ＋ geo_dashboard 2 ＋ brand_history/notifications/artifact_lineage 各 1（38 站点，文件多而浅）
    ＋ **收缩票**（被 A/B/C 全部阻塞）：删除旧开库函数形态（其体内直呼 `Connection::open`，不删则 brand_workspace.rs 豁免永不清零）＋豁免表清空 0 项严格相等终态钉＋spec 状态头结案。三张清零票各被立项票阻塞、彼此独立（建议 A→B→C 顺序）。
    分支建议 `geo/persistence-kernel`。
11. **顺序**：血缘 owner（已结案，ADR-0013）→ **本卡** → 候选 1（GeoOperation 主链写路径 owner，生在内核上）→ 候选 8（publish_scheduler 拆分）。

## Testing Decisions

- **等价性验收**：每票全量 `cargo test` 与 `npm test` 绿→绿；会话闸 10 个错误串逐字不变抽查钉（防搬家改串）；血缘守卫（vitest）与 ADR-0013 终态钉原样绿——零豁免名单严格相等。
- **内核新增钉**：(a) 迁移登记表钉——同 tempdir 二次 open 不再触发 schema 探测（可用探测计数或行为观测）、新 tempdir 首 open 迁移完备（10 表＋2 内联列全在）；(b) 并发首开钉——两线程同 path 并发 open 不重复迁移（持锁串行）；(c) 闸口径钉——每闸声明产出与其旧实现逐字同错误串（含 materials 两段）；(d) 事务钉——`with_immediate_tx` 提交/回滚行为与内联版逐位一致；(e) 守卫钉——豁免表恰 13 项、三条规则注入违例样例必红。
- **既有测试零改动即绿**：全部 tempdir 真库测试经新 `open()` 路径跑通（等价搬家的最强证据）。
- **清零票验收模板**：该文件豁免项归零＋该文件错误串抽查钉在位＋全量测试绿。

## Out of Scope

- 类型化错误枚举与 envelope 收敛（候选 4）；`production_store()` 组合根缓存（候选 4）。
- bounded_* 截断家族统一、会话闸 validate 口径统一（行为变更，遗留登记，等真实痛点或与候选 4/5 撞车再议）。
- append-only 版本表迁移范型（backend/ 树）；共享连接/池；共享测试夹具。
- 候选 1/3/5/6/7/8/9 及其余巡检候选——各自独立成案。
- 域 SQL 语句搬家（SQL 留在各域，内核只收基建）。

## Further Notes

- **票依赖骨架**：立项票（零依赖，纯增量）→ 三张清零票（各依赖立项票，彼此独立；建议按 A→B→C 顺序，最热 churn 区先获得局部性）。
- **决策日志**：grilling 两轮全按推荐锁定。Round 1 九项（范围四件套＋工具族、per-path 登记表、每调用开库、闸等价线、错误映射深度、事务助手、先 2 后 1、0013 打法、命名落点）；Round 2 五项（ADR-0014、cargo 守卫、票切分、组合根出范围、遗留只登记）。`/to-tickets` 一轮：四票修正为五票——「终态零豁免」需要删除旧开库函数本体的 contract 步（expand–contract 宽面重构打法），用户确认粒度/阻塞边/第五票全部照拟。
- **词汇沉淀**：持久化内核（Persistence Kernel）、会话闸（Session Gate，与聊天侧「闸门卡片」消歧）已进 CONTEXT.md（2026-09-04）。
- **证据底座**：2026-09-04 两路只读勘察——Rust 持久化层全量盘点（130 调用点分文件清点、10 闸三维差异表、923 map_err 计数、60 事务站点、工具族副本定位、10 ensure_schema 幂等性分类、测试 tempdir 形态、进程外访问者）＋ ADR/词汇表/在飞工作核查（0013 全结案无冲突面、backend 另库确认）。
