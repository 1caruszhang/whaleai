# 持久化内核：开库、迁移、会话闸、事务与错误映射单源

## Context

BrandWorkspace 持久化没有深模块挡在 SQL 之前：旧开库函数（立项时居 brand_workspace.rs:1176-1226，票 05 收缩删除）每次打开都串行重跑 10 个 `ensure_schema`（6 个含影子表重建探测）＋2 个内联 `ensure_column` 迁移；全目录 **130 处**非测试调用点（axum 每 HTTP 请求经 `production_store()` 重建 Store 再开库——**每个请求都重演全部 schema 探测**）；会话闸 **10 个**同构变体（9 个命名 `require_*_session` ＋ geo_operations 1 处内联）散在 9 个文件；≈923 处 `map_err` 目标全是 `Result<T, String>`，无中央错误层；60 处 `transaction_with_behavior(Immediate)` 内联样板；now_iso ×2、sha256 2 命名＋≥8 内联、canonical_json ×4 同签名复制。2026-09-04 架构巡检立为候选 2（Strong），grilling 两轮锁定范围后裁决。

## Decision

### 1. 立持久化内核为唯一开库入口

新模块 `brand_workspace/persistence.rs`：`BrandWorkspaceStore::open()` 成为全目录唯一开库路径（PRAGMA 每连接必设；**保持每调用开新连接**，不引池不共享连接）；`initialize_database`（建库路径，含 INSERT 数据行）与 10 个 `ensure_schema` 的编排一并归内核。

### 2. 迁移按进程内 per-workspace-path 登记表只跑一遍

`static Mutex<HashSet<PathBuf>>`（canonical path），持锁期间执行首开迁移（进程内并发首开串行化）；后续 open 跳过全部 schema 探测。ensure_schema 的幂等探测**保留**作跨进程兜底（同文件存在两个进程外脚本访问者：`cancel-legacy-geo-operations.mjs` 可写、e2e 验收只读，均不跑迁移）。*否决：进程级 OnceLock*——cargo 测试每用例新建 tempdir、同进程可开多 workspace、`production_store()` 每请求重建 Store，三处都会被全局单次语义打碎。*否决：append-only 版本表迁移范型*——那是 backend/（账户/计费，另库另进程）的树，换范型远超本卡收益，值得与否留未来独立案。

### 3. 会话闸、事务、错误映射严格等价收敛

会话闸 10 个变体收敛为单实现＋每闸声明：**10 个错误串逐字保留**（`*_not_committed` 与 `*_not_found` 口径差异照旧）；`validate_session_id` 前置有无随声明保留现状；COUNT 统一为 EXISTS（主键 id 上可观测等价）；materials 两段错误（not found vs `brand_session_unavailable`）保留。`with_immediate_tx` 收 60 处内联 Immediate 样板（错误串逐字不变）。错误映射只收 `rusqlite::Error → 带上下文 String` 一层助手（`sql_err`）。*否决：类型化 PersistenceError 枚举*——130 站点 × 923 处的签名全换是半截工程，真正落点在候选 4 的 envelope 声明表。*否决：顺手统一行为*（validate 全加、错误码合并）——行为变更一律另票，不混进等价重构。

### 4. 纯等价工具族收编，语义异构族排除

now_iso、sha256_hex、canonical_json（×4 同签名）收编为内核附带工具；**bounded_* 截断家族明确排除**（限额/脱敏语义各异，非等价副本，硬统一会改行为）。

### 5. 裁决由守卫棘轮钉死

cargo 文本守卫三条：brand_workspace 内禁直呼 `rusqlite::Connection::open`、禁新增 `require_*_session` 变体、禁 open 路径外直呼 `ensure_schema`；豁免表初始 13 文件、逐票清零、终态零豁免。铁律：`geo_operations.rs` 与 `artifact_lineage.rs` 不改名不挪窝（ADR-0013 血缘守卫豁免名单）。

## Consequences

- 每 HTTP 请求 10 遍 schema 探测的税消失；迁移语义（何时跑、跑什么）第一次有单一居所与单一测试面。
- 候选 1（GeoOperation 主链写路径 owner）在此之后落地——owner 直接生在内核上，不需二次返工；候选 4 的 envelope 声明表届时可顺带评估类型化错误与 `production_store()` 组合根缓存（本卡显式不做）。
- 行为统一类遗留（会话闸 validate 口径、bounded_* 家族）只在 spec 登记，等真实痛点或与候选 4/5 撞车再议。
- CONTEXT.md「持久化内核（Persistence Kernel）」「会话闸（Session Gate）」词条（2026-09-04）与本文互为引用。
