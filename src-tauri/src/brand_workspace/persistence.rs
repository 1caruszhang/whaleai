//! 持久化内核（ADR-0014，票 01 立项）：BrandWorkspace 持久化基建的唯一
//! 居所——开库入口、per-path 迁移登记、会话闸单实现＋每闸声明、
//! Immediate 事务助手、错误映射助手与纯等价工具族。域 SQL 留在各域文件，
//! 本文件只收基建不收 SQL（唯一例外：initialize_database 随编排归内核，
//! 自带建库基础表 DDL 与身份行——spec 实施决策 1 钦定的等价搬家）。
//!
//! 本票为 expand 阶段（纯增量）：旧 `open_database` 及其 130 个调用点
//! 原样存活，三张清零票（02/03/04）逐文件改走 [`BrandWorkspaceStore::open`]
//! 后由收缩票（05）删除旧形态。守卫棘轮见文末 `mod guard`。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    articles, distribution_plans, ensure_column, geo_baselines, geo_operations, knowledge,
    materials, post_publish_monitoring, publish_scheduler, question_pools, topic_plans,
    validate_session_id, BrandWorkspace, BrandWorkspaceStore,
};

const DATABASE_FILE: &str = "project.sqlite";

// ═══ 迁移登记表（spec 实施决策 3；ADR-0014 裁决 2） ═══
//
// 进程内 per-workspace-path 只跑一遍迁移：canonical path 入集后，本进程
// 后续 open() 跳过全部 schema 探测（每 HTTP 请求 10 遍探测的税消失）。
// 幂等探测保留在 run_migrations 内作跨进程兜底——db 文件可被进程外脚本
// 访问（cancel-legacy-geo-operations.mjs 可写、e2e 验收只读），任何进程的
// 首开必跑一遍探测。否决 OnceLock 全局单次：cargo 测试每用例新 tempdir、
// 同进程多 workspace、Store 每请求重建，三处全碎（ADR-0014 裁决 2）。

struct MigrationRegistry {
    migrated: HashSet<PathBuf>,
    /// 「迁移只跑一遍」的观测面：run_migrations 每执行一次记一条
    /// canonical path（测试按路径断言恰一条，钉并发首开不重复迁移）。
    #[cfg(test)]
    run_log: Vec<PathBuf>,
}

fn migration_registry() -> &'static Mutex<MigrationRegistry> {
    static REGISTRY: OnceLock<Mutex<MigrationRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(MigrationRegistry {
            migrated: HashSet::new(),
            #[cfg(test)]
            run_log: Vec::new(),
        })
    })
}

/// 登记键用 canonical path（spec 实施决策 3）。取父目录 canonicalize 再拼文件名：
/// 父目录在 Store 构造前已建、不随 db 文件是否已落盘漂移，键形态稳定。
fn canonical_db_path(db_path: &Path) -> PathBuf {
    match (db_path.parent(), db_path.file_name()) {
        (Some(parent), Some(name)) => parent
            .canonicalize()
            .map(|canonical| canonical.join(name))
            .unwrap_or_else(|_| db_path.to_path_buf()),
        _ => db_path.to_path_buf(),
    }
}

// ═══ 唯一开库入口（spec 实施决策 1、2） ═══

impl BrandWorkspaceStore {
    /// 唯一开库入口：行为等价旧 `open_database`——保持每调用开新连接
    /// （rusqlite `Connection` 非 Sync、tauri 走 spawn_blocking，无池化
    /// 证据，spec 实施决策 2），PRAGMA 每连接必设（busy_timeout 5s / WAL /
    /// foreign_keys 原样），错误串逐字同旧实现；差异仅一处：迁移按
    /// 登记表每路径每进程只跑一遍。
    pub(crate) fn open(workspace: &BrandWorkspace) -> Result<Connection, String> {
        let db_path = workspace.root_path.join(DATABASE_FILE);
        let connection =
            Connection::open(&db_path).map_err(|error| format!("open brand database: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("configure brand database timeout: {error}"))?;
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(|error| format!("configure brand database: {error}"))?;
        migrate_once(&connection, &db_path)?;
        Ok(connection)
    }
}

/// 首开持锁串行（spec 实施决策 3）：锁内「探测登记表→执行迁移→登记」，进程内
/// 并发首开在同一把锁上排队，不重复迁移；已登记路径一次 contains 即返，
/// 不触任何 schema 探测。
fn migrate_once(connection: &Connection, db_path: &Path) -> Result<(), String> {
    let canonical = canonical_db_path(db_path);
    let registry = migration_registry();
    let mut guard = registry
        .lock()
        .map_err(|error| format!("lock brand database migration registry: {error}"))?;
    if guard.migrated.contains(&canonical) {
        return Ok(());
    }
    run_migrations(connection)?;
    guard.migrated.insert(canonical.clone());
    #[cfg(test)]
    guard.run_log.push(canonical);
    Ok(())
}

/// 迁移编排（等价旧 `open_database` 体内的探测序列）：10 个 ensure_schema
/// 串行（全幂等，sqlite_master 探测，重跑无正确性破口）＋2 个内联列迁移
/// （按表存在性条件触发）。跨进程首开的兜底路径。
fn run_migrations(connection: &Connection) -> Result<(), String> {
    geo_operations::ensure_schema(connection)?;
    knowledge::ensure_schema(connection)?;
    materials::ensure_schema(connection)?;
    question_pools::ensure_schema(connection)?;
    geo_baselines::ensure_schema(connection)?;
    topic_plans::ensure_schema(connection)?;
    articles::ensure_schema(connection)?;
    distribution_plans::ensure_schema(connection)?;
    publish_scheduler::ensure_schema(connection)?;
    post_publish_monitoring::ensure_schema(connection)?;
    let has_geo_artifacts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='geo_artifacts'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect artifact schema state: {error}"))?;
    if has_geo_artifacts == 1 {
        ensure_column(connection, "geo_artifacts", "knowledge_version", "INTEGER")?;
    }
    let has_deletion_intents: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'session_deletion_intents'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect brand database migration state: {error}"))?;
    if has_deletion_intents == 1 {
        ensure_column(
            connection,
            "session_deletion_intents",
            "admitted_at",
            "INTEGER",
        )?;
        ensure_column(
            connection,
            "session_deletion_intents",
            "transcript_deleted_at",
            "INTEGER",
        )?;
    }
    Ok(())
}

/// 建库路径（spec 实施决策 1「initialize_database 随迁移编排一并归内核」）：开库即
/// 触发首开迁移（全新库上各 ensure_schema 先建域表），再补基础表与品牌
/// 身份数据行。与旧 brand_workspace.rs 版唯一差异：开库经内核 `open()`
/// （首开后该路径入登记表）；建库时基础表 CREATE 已含全部新列，两处
/// ensure_column 为幂等 no-op，行为逐位等价。
pub(super) fn initialize_database(workspace: &BrandWorkspace) -> Result<(), String> {
    let connection = BrandWorkspaceStore::open(workspace)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS brand_workspace (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                product_lines_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS brand_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                title_source TEXT NOT NULL CHECK(title_source IN ('default', 'auto', 'user')),
                created_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL,
                archived_at TEXT
             );
             CREATE INDEX IF NOT EXISTS brand_sessions_activity
                ON brand_sessions(archived_at, last_active_at DESC);
             CREATE TABLE IF NOT EXISTS knowledge_facts (
                id TEXT PRIMARY KEY,
                fact_key TEXT NOT NULL,
                version INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS geo_operations (
                id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES brand_sessions(id) ON DELETE SET NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS geo_artifacts (
                id TEXT PRIMARY KEY,
                operation_id TEXT REFERENCES geo_operations(id) ON DELETE SET NULL,
                session_id TEXT REFERENCES brand_sessions(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                knowledge_version INTEGER,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS publish_orders (
                id TEXT PRIMARY KEY,
                operation_id TEXT REFERENCES geo_operations(id) ON DELETE SET NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS observations (
                id TEXT PRIMARY KEY,
                operation_id TEXT REFERENCES geo_operations(id) ON DELETE SET NULL,
                observed_at TEXT NOT NULL,
                evidence_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS session_deletion_intents (
                token TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES brand_sessions(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                admitted_at INTEGER,
                transcript_deleted_at INTEGER
             );",
        )
        .map_err(|error| format!("initialize brand database: {error}"))?;
    ensure_column(
        &connection,
        "session_deletion_intents",
        "admitted_at",
        "INTEGER",
    )?;
    ensure_column(
        &connection,
        "session_deletion_intents",
        "transcript_deleted_at",
        "INTEGER",
    )?;
    geo_operations::ensure_schema(&connection)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO brand_workspace
                (singleton, id, name, product_lines_json, created_at, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                workspace.id,
                workspace.name,
                serde_json::to_string(&workspace.product_lines).unwrap_or_else(|_| "[]".into()),
                workspace.created_at,
                workspace.updated_at,
            ],
        )
        .map_err(|error| format!("write brand identity: {error}"))?;
    Ok(())
}

// ═══ 会话闸单实现＋每闸声明（spec 实施决策 4；ADR-0014 裁决 3） ═══
//
// 10 个同构变体（9 命名 require_*_session ＋ geo_operations 1 处内联）收敛
// 为单实现：表固定 brand_sessions、列固定 id，查询统一 EXISTS（主键 id 上
// 与旧 COUNT 可观测等价：命中恒 0/1）；差异全部进声明——错误码、有无
// validate_session_id 前置、SQL 错误呈现。10 个错误串逐字保留（TS 侧 pin
// 不红）；materials 两段错误（count!=1 的 brand_session_not_committed 与
// SQL 错误的 brand_session_unavailable 吞细节口径）照旧。

/// 会话闸 SQL 错误的呈现口径：绝大多数闸带上下文串；materials 吞细节
/// 映射固定码（现状逐字保留）。
#[allow(dead_code)]
pub(crate) enum SessionGateSqlError {
    /// `format!("{context}: {error}")`。
    Context(&'static str),
    /// 固定 `brand_session_unavailable`（materials 口径）。
    Unavailable,
}

/// 会话闸声明：声明＝错误码＋有无 validate 前置＋SQL 错误呈现。
#[allow(dead_code)]
pub(crate) struct SessionGate {
    pub error_code: &'static str,
    pub validate_identity: bool,
    pub sql_error: SessionGateSqlError,
}

#[allow(dead_code)]
impl SessionGate {
    pub(crate) fn enforce(&self, connection: &Connection, session_id: &str) -> Result<(), String> {
        if self.validate_identity {
            validate_session_id(session_id)?;
        }
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM brand_sessions WHERE id=?1)",
                [session_id],
                |row| row.get(0),
            )
            .map_err(|error| match &self.sql_error {
                SessionGateSqlError::Context(context) => format!("{context}: {error}"),
                SessionGateSqlError::Unavailable => "brand_session_unavailable".to_string(),
            })?;
        exists
            .then_some(())
            .ok_or_else(|| self.error_code.to_string())
    }
}

/// 10 闸声明（2026-09-04 盘点现状逐字钉；各域清零票把文件内旧变体切到
/// 这些声明，错误串与 validate 前置随搬家逐字不变。票 02 已消费
/// MONITOR_SESSION/PUBLISH_SESSION，其余待票 03/04）。
#[allow(dead_code)]
pub(crate) mod gates {
    use super::{SessionGate, SessionGateSqlError};

    /// articles.rs · require_article_session（validate＋COUNT → EXISTS）。
    pub(crate) const ARTICLE_SESSION: SessionGate = SessionGate {
        error_code: "article_generation_session_not_committed",
        validate_identity: true,
        sql_error: SessionGateSqlError::Context("validate article session"),
    };
    /// materials.rs · require_committed_session（validate；SQL 错误吞细节）。
    pub(crate) const MATERIALS_SESSION: SessionGate = SessionGate {
        error_code: "brand_session_not_committed",
        validate_identity: true,
        sql_error: SessionGateSqlError::Unavailable,
    };
    /// geo_baselines.rs · require_baseline_session。
    pub(crate) const GEO_BASELINE_SESSION: SessionGate = SessionGate {
        error_code: "geo_baseline_session_not_committed",
        validate_identity: true,
        sql_error: SessionGateSqlError::Context("verify GEO baseline session"),
    };
    /// distribution_plans.rs · require_distribution_session。
    pub(crate) const DISTRIBUTION_SESSION: SessionGate = SessionGate {
        error_code: "distribution_plan_session_not_committed",
        validate_identity: true,
        sql_error: SessionGateSqlError::Context("read distribution session"),
    };
    /// topic_plans.rs · require_topic_plan_session。
    pub(crate) const TOPIC_PLAN_SESSION: SessionGate = SessionGate {
        error_code: "topic_plan_session_not_committed",
        validate_identity: true,
        sql_error: SessionGateSqlError::Context("validate topic plan session"),
    };
    /// geo_dashboard.rs · require_dashboard_session（无 validate 前置）。
    pub(crate) const DASHBOARD_SESSION: SessionGate = SessionGate {
        error_code: "geo_dashboard_session_not_found",
        validate_identity: false,
        sql_error: SessionGateSqlError::Context("verify dashboard session"),
    };
    /// post_publish_monitoring.rs · require_monitor_session（无 validate 前置）。
    pub(crate) const MONITOR_SESSION: SessionGate = SessionGate {
        error_code: "post_publish_monitor_session_not_found",
        validate_identity: false,
        sql_error: SessionGateSqlError::Context("verify monitoring session"),
    };
    /// publish_scheduler.rs · require_session（无 validate 前置）。
    pub(crate) const PUBLISH_SESSION: SessionGate = SessionGate {
        error_code: "publish_scheduler_session_not_found",
        validate_identity: false,
        sql_error: SessionGateSqlError::Context("verify publish session"),
    };
    /// question_pools.rs · require_question_pool_session。
    pub(crate) const QUESTION_POOL_SESSION: SessionGate = SessionGate {
        error_code: "question_pool_session_not_committed",
        validate_identity: true,
        sql_error: SessionGateSqlError::Context("validate question pool session"),
    };
    /// geo_operations.rs · create_geo_operation 内联闸（无 validate 前置；
    /// 票 04 随开库后重复 ensure 站点一并收编）。
    pub(crate) const GEO_OPERATION_SESSION: SessionGate = SessionGate {
        error_code: "geo_operation_session_not_committed",
        validate_identity: false,
        sql_error: SessionGateSqlError::Context("validate GEO operation Session"),
    };
}

// ═══ 事务助手（spec 实施决策 5；ADR-0014 裁决 3） ═══

/// Immediate 事务助手：收 60 处 `transaction_with_behavior(Immediate)`
/// 内联样板。start/commit 上下文由调用点传入旧串**全文**（如
/// `with_immediate_tx(&mut c, "start article operation transaction",
/// "commit article operation", …)` 产出 "start article operation
/// transaction: {error}" / "commit article operation: {error}"，与内联版
/// 逐字相同）；body 出错即返回、事务随 Drop 回滚（同内联版 `?` 早退
/// 语义）。收 `&Transaction` 的 14 个内部 helper 不经此助手；影子重建内
/// 裸 BEGIN/COMMIT 属 schema 机器，不适用。
///
/// 票 02 现场修正：helper 不内建 "start "/"commit " 前缀——各域旧串形态
/// 不一（articles 带 "start " 前缀，ppm/publish_scheduler 是
/// "prepare monitoring plan transaction" 这类动词开头的整串），前缀内建
/// 无法逐字复现；调用点一律传完整旧串。体内多出口分别 commit 且错误串
/// 各异的站点（票 02 盘点：ppm `create_due_run`、publish_scheduler
/// `prepare_publish_execution`/`claim_next_item`/`settle_upload`）不经
/// 此助手——单 commit 上下文无法逐字复现多出口串，保持内联。
pub(crate) fn with_immediate_tx<T>(
    connection: &mut Connection,
    start_context: &'static str,
    commit_context: &'static str,
    body: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("{start_context}: {error}"))?;
    let result = body(&transaction)?;
    transaction
        .commit()
        .map_err(|error| format!("{commit_context}: {error}"))?;
    Ok(result)
}

// ═══ 错误映射助手（spec 实施决策 6；ADR-0014 裁决 3） ═══

/// `rusqlite::Error → 带上下文 String` 一层助手：`.map_err(sql_err("validate
/// article session"))` 等价 `.map_err(|error| format!("validate article
/// session: {error}"))`。只收 String 目标这一层；类型化错误落候选 4 的
/// envelope 声明表，此处不做半截工程。
// 本票纯增量：生产调用点零迁移，消费方在清零票 02–04（立项票内仅测试引用）。
#[allow(dead_code)]
pub(crate) fn sql_err(context: &'static str) -> impl Fn(rusqlite::Error) -> String {
    move |error| format!("{context}: {error}")
}

// ═══ 纯等价工具族（spec 实施决策 7；ADR-0014 裁决 4） ═══
//
// now_iso ×2（post_publish_monitoring / publish_scheduler 同体）、sha256
// 2 命名（publish_scheduler::sha256_hex / post_publish_monitoring::digest）
// ＋≥8 处内联 `format!("{:x}", Sha256::digest(...))`、canonical_json ×4
// （distribution_plans/baselines/topic_plans/question_pools 同签名）收编为
// 内核等价副本；bounded_* 截断家族语义各异，明确排除。

/// 毫秒时间戳 → RFC3339 毫秒精度 Z 串（无效/越界回退当前时刻）。
pub(crate) fn now_iso(now_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// SHA-256 十六进制小写摘要（各域内联 `format!("{:x}", …)` 的等价副本）。
pub(crate) fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

/// 序列化 JSON 的统一口径：错误串 `serialize {context}: {error}`，context
/// 传各域既有名词（"GEO baseline JSON" / "distribution plan json"〔小写
/// json 为既有串原样〕 / "topic plan JSON" / "question pool JSON"）。
// 本票纯增量：生产调用点零迁移，消费方在清零票 02–04（立项票内仅测试引用）。
#[allow(dead_code)]
pub(crate) fn canonical_json<T: ?Sized + Serialize>(
    value: &T,
    context: &'static str,
) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("serialize {context}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::thread;

    use rusqlite::{Connection, OptionalExtension};
    use tempfile::tempdir;

    use super::{
        canonical_json, gates, initialize_database, now_iso, sha256_hex, with_immediate_tx,
        BrandWorkspaceStore,
    };
    use crate::brand_workspace::{open_database, BrandWorkspace};

    fn workspace_under(root: &std::path::Path) -> BrandWorkspace {
        BrandWorkspace {
            id: "ws-kernel".to_string(),
            name: "内核测试工作区".to_string(),
            product_lines: vec!["旗舰产品".to_string()],
            root_path: root.join("ws-root"),
            created_at: "2026-09-04T00:00:00.000Z".to_string(),
            updated_at: "2026-09-04T00:00:00.000Z".to_string(),
        }
    }

    fn migrated_workspace() -> (tempfile::TempDir, BrandWorkspace) {
        let root = tempdir().unwrap();
        let workspace = workspace_under(root.path());
        std::fs::create_dir_all(&workspace.root_path).unwrap();
        initialize_database(&workspace).unwrap();
        (root, workspace)
    }

    fn insert_session(connection: &Connection, session_id: &str) {
        connection
            .execute(
                "INSERT INTO brand_sessions
                    (id, title, title_source, created_at, last_active_at, archived_at)
                 VALUES (?1, 't', 'default', '2026-09-04T00:00:00.000Z',
                         '2026-09-04T00:00:00.000Z', NULL)",
                [session_id],
            )
            .unwrap();
    }

    fn table_exists(connection: &Connection, table: &str) -> bool {
        connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |_| Ok(()),
            )
            .optional()
            .unwrap()
            .is_some()
    }

    fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        columns.iter().any(|candidate| candidate == column)
    }

    #[test]
    fn first_open_completes_full_domain_migration() {
        let (_root, workspace) = migrated_workspace();
        let connection = BrandWorkspaceStore::open(&workspace).unwrap();
        // 10 个 ensure_schema 各留一张代表表＋基础表，钉首开迁移完备。
        for table in [
            "geo_operations",
            "geo_artifact_freshness",
            "knowledge_decisions",
            "brand_materials",
            "geo_question_pools",
            "geo_baselines",
            "geo_topic_plans",
            "geo_article_operations",
            "geo_distribution_plans",
            "geo_publish_executions",
            "geo_post_publish_monitor_plans",
            "brand_sessions",
            "session_deletion_intents",
        ] {
            assert!(table_exists(&connection, table), "missing table {table}");
        }
        // 建库路径的基础表 CREATE 已含新列；ensure_column 两处为幂等 no-op。
        assert!(column_exists(
            &connection,
            "session_deletion_intents",
            "admitted_at"
        ));
        assert!(column_exists(
            &connection,
            "session_deletion_intents",
            "transcript_deleted_at"
        ));
        drop(connection);
    }

    #[test]
    fn first_open_upgrades_legacy_base_tables_with_inline_columns() {
        let root = tempdir().unwrap();
        let workspace = workspace_under(root.path());
        std::fs::create_dir_all(&workspace.root_path).unwrap();
        // 模拟旧版工作区：基础表缺内联列，未跑任何域 schema。
        let legacy = Connection::open(workspace.root_path.join("project.sqlite")).unwrap();
        legacy
            .execute_batch(
                "CREATE TABLE geo_artifacts (
                    id TEXT PRIMARY KEY, operation_id TEXT, session_id TEXT,
                    kind TEXT NOT NULL, created_at TEXT NOT NULL
                 );
                 CREATE TABLE session_deletion_intents (
                    token TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
        drop(legacy);
        let connection = BrandWorkspaceStore::open(&workspace).unwrap();
        assert!(column_exists(
            &connection,
            "geo_artifacts",
            "knowledge_version"
        ));
        assert!(column_exists(
            &connection,
            "session_deletion_intents",
            "admitted_at"
        ));
        assert!(column_exists(
            &connection,
            "session_deletion_intents",
            "transcript_deleted_at"
        ));
    }

    #[test]
    fn registry_hit_skips_all_schema_probes_on_second_open() {
        let (_root, workspace) = migrated_workspace();
        let connection = BrandWorkspaceStore::open(&workspace).unwrap();
        // 探测可见性反转：删一张 ensure_schema 管理的表后再次开库——
        // 登记表命中则不重建（旧 open_database 每开必重建，两者分叉点）。
        connection
            .execute_batch("DROP TABLE geo_artifact_freshness;")
            .unwrap();
        drop(connection);
        let second = BrandWorkspaceStore::open(&workspace).unwrap();
        assert!(
            !table_exists(&second, "geo_artifact_freshness"),
            "登记表命中后不应重跑 schema 探测"
        );
        drop(second);
        let legacy = open_database(&workspace).unwrap();
        assert!(
            table_exists(&legacy, "geo_artifact_freshness"),
            "旧 open_database 保持每开必探测的现状（行为未搬动）"
        );
        drop(legacy);
    }

    #[test]
    fn concurrent_first_open_runs_migration_once_per_path() {
        let root = tempdir().unwrap();
        let workspace = workspace_under(root.path());
        std::fs::create_dir_all(&workspace.root_path).unwrap();
        let canonical = super::canonical_db_path(&workspace.root_path.join("project.sqlite"));
        // 预热 WAL：journal_mode 切换在非 WAL 库上不排队等 busy_timeout，
        // 两个「史上首开」赛跑会先在 PRAGMA 上炸（旧 open_database 同曝，
        // 非本内核语义）。预热后两线程的竞争点恰是登记表互斥——被钉对象。
        let warm = Connection::open(workspace.root_path.join("project.sqlite")).unwrap();
        warm.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        drop(warm);
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let workspace = workspace.clone();
                thread::spawn(move || BrandWorkspaceStore::open(&workspace))
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        let runs = {
            let registry = super::migration_registry().lock().unwrap();
            registry
                .run_log
                .iter()
                .filter(|path| **path == canonical)
                .count()
        };
        assert_eq!(runs, 1, "同 path 并发首开持锁串行，迁移恰跑一遍");
        // 两条连接都应看到完整 schema（此开经登记表命中，不再迁移；先放锁）。
        let connection = BrandWorkspaceStore::open(&workspace).unwrap();
        assert!(table_exists(&connection, "geo_post_publish_monitor_plans"));
    }

    #[test]
    fn session_gate_declarations_match_legacy_error_strings_verbatim() {
        let (_root, workspace) = migrated_workspace();
        let connection = BrandWorkspaceStore::open(&workspace).unwrap();
        insert_session(&connection, "session-1");

        // 三个行为维度逐闸钉：committed 命中、未提交错误串、SQL 错误呈现。
        // （validate 前置差异由下一测单独钉。）
        let cases: [(&super::SessionGate, &str); 10] = [
            (
                &gates::ARTICLE_SESSION,
                "article_generation_session_not_committed",
            ),
            (&gates::MATERIALS_SESSION, "brand_session_not_committed"),
            (
                &gates::GEO_BASELINE_SESSION,
                "geo_baseline_session_not_committed",
            ),
            (
                &gates::DISTRIBUTION_SESSION,
                "distribution_plan_session_not_committed",
            ),
            (
                &gates::TOPIC_PLAN_SESSION,
                "topic_plan_session_not_committed",
            ),
            (&gates::DASHBOARD_SESSION, "geo_dashboard_session_not_found"),
            (
                &gates::MONITOR_SESSION,
                "post_publish_monitor_session_not_found",
            ),
            (
                &gates::PUBLISH_SESSION,
                "publish_scheduler_session_not_found",
            ),
            (
                &gates::QUESTION_POOL_SESSION,
                "question_pool_session_not_committed",
            ),
            (
                &gates::GEO_OPERATION_SESSION,
                "geo_operation_session_not_committed",
            ),
        ];
        for (gate, error_code) in cases {
            assert_eq!(
                gate.enforce(&connection, "session-1"),
                Ok(()),
                "{error_code}"
            );
            assert_eq!(
                gate.enforce(&connection, "missing-session"),
                Err(error_code.to_string()),
                "{error_code}"
            );
        }

        // SQL 错误路径：无表裸库上，上下文串与 materials 吞细节口径逐字钉。
        let bare_root = tempdir().unwrap();
        let bare = Connection::open(bare_root.path().join("bare.sqlite")).unwrap();
        assert_eq!(
            gates::ARTICLE_SESSION
                .enforce(&bare, "session-1")
                .unwrap_err(),
            "validate article session: no such table: brand_sessions"
        );
        assert_eq!(
            gates::GEO_OPERATION_SESSION
                .enforce(&bare, "session-1")
                .unwrap_err(),
            "validate GEO operation Session: no such table: brand_sessions"
        );
        assert_eq!(
            gates::MATERIALS_SESSION
                .enforce(&bare, "session-1")
                .unwrap_err(),
            "brand_session_unavailable"
        );
        drop(connection);
    }

    #[test]
    fn session_gate_validate_prefix_matches_legacy_dimensions() {
        let (_root, workspace) = migrated_workspace();
        let connection = BrandWorkspaceStore::open(&workspace).unwrap();
        let invalid = "pending-abc";
        // 有 validate 前置的 6 闸：身份错误优先于库内探测。
        for gate in [
            &gates::ARTICLE_SESSION,
            &gates::MATERIALS_SESSION,
            &gates::GEO_BASELINE_SESSION,
            &gates::DISTRIBUTION_SESSION,
            &gates::TOPIC_PLAN_SESSION,
            &gates::QUESTION_POOL_SESSION,
        ] {
            assert_eq!(
                gate.enforce(&connection, invalid),
                Err("会话 identity 无效或尚未提交".to_string()),
                "{}",
                gate.error_code
            );
        }
        // 无前置的 4 闸：同一身份串按库内 EXISTS 判定走错误码。
        for gate in [
            &gates::DASHBOARD_SESSION,
            &gates::MONITOR_SESSION,
            &gates::PUBLISH_SESSION,
            &gates::GEO_OPERATION_SESSION,
        ] {
            assert_eq!(
                gate.enforce(&connection, invalid),
                Err(gate.error_code.to_string()),
                "{}",
                gate.error_code
            );
        }
        drop(connection);
    }

    #[test]
    fn with_immediate_tx_commits_and_rolls_back_like_inline_immediate() {
        let (_root, workspace) = migrated_workspace();
        let mut helper_conn = BrandWorkspaceStore::open(&workspace).unwrap();
        with_immediate_tx(
            &mut helper_conn,
            "start topic plan mutation",
            "commit topic plan mutation",
            |tx| {
                tx.execute(
                    "CREATE TABLE tx_probe (id INTEGER PRIMARY KEY, value TEXT)",
                    [],
                )
                .map_err(|error| format!("probe: {error}"))?;
                tx.execute("INSERT INTO tx_probe (value) VALUES ('kept')", [])
                    .map_err(|error| format!("probe: {error}"))
            },
        )
        .unwrap();

        // 内联 Immediate 参照（与旧域代码同形）：提交语义逐位一致。
        let mut inline_conn = BrandWorkspaceStore::open(&workspace).unwrap();
        let transaction = inline_conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("start topic plan mutation: {error}"))
            .unwrap();
        transaction
            .execute("INSERT INTO tx_probe (value) VALUES ('inline')", [])
            .unwrap();
        transaction
            .commit()
            .map_err(|error| format!("commit topic plan mutation: {error}"))
            .unwrap();
        let values: Vec<String> = helper_conn
            .prepare("SELECT value FROM tx_probe ORDER BY value")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(values, vec!["inline".to_string(), "kept".to_string()]);

        // body 出错：助手与内联 `?` 早退同样随 Drop 回滚，行不可见且连接可用。
        let error = with_immediate_tx(
            &mut helper_conn,
            "start topic plan create",
            "commit topic plan create",
            |tx| -> Result<(), String> {
                tx.execute("INSERT INTO tx_probe (value) VALUES ('doomed')", [])
                    .map_err(|error| format!("probe: {error}"))?;
                Err("topic_plan_probe_failure".to_string())
            },
        )
        .unwrap_err();
        assert_eq!(error, "topic_plan_probe_failure");
        let doomed: Option<String> = helper_conn
            .query_row(
                "SELECT value FROM tx_probe WHERE value='doomed'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(doomed, None);
        drop(inline_conn);
        drop(helper_conn);
    }

    #[test]
    fn with_immediate_tx_start_failure_error_string_matches_inline() {
        let (_root, workspace) = migrated_workspace();
        let blocker = BrandWorkspaceStore::open(&workspace).unwrap();
        blocker.execute_batch("BEGIN EXCLUSIVE;").unwrap();
        // busy_timeout 归零让两路都在锁上立即失败，比对错误串逐字相同。
        let mut helper_conn = Connection::open(workspace.root_path.join("project.sqlite")).unwrap();
        helper_conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        let helper_error =
            with_immediate_tx(&mut helper_conn, "start probe", "commit probe", |_| Ok(()))
                .unwrap_err();
        let mut inline_conn = Connection::open(workspace.root_path.join("project.sqlite")).unwrap();
        inline_conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        let inline_error = inline_conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| format!("start probe: {error}"))
            .unwrap_err();
        assert_eq!(helper_error, inline_error);
        assert!(
            helper_error.starts_with("start probe:"),
            "unexpected: {helper_error}"
        );
    }

    #[test]
    fn tool_family_matches_legacy_bodies() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(now_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            canonical_json(&serde_json::json!({"a": 1}), "topic plan JSON").unwrap(),
            "{\"a\":1}"
        );
    }
}

// ═══ cargo 文本守卫棘轮（spec 实施决策 8；ADR-0014 裁决 5；票 01 落地） ═══
//
// 三条规则（与 vitest 血缘守卫同哲学：豁免表即清零进度表，键须与现实
// 违例集严格相等，不硬编码计数——清零票逐项消项时计数断言会误红）：
//  ① brand_workspace 内禁直呼 rusqlite::Connection::open（前缀口径涵盖
//     open_in_memory；开库只能经 BrandWorkspaceStore::open / 旧
//     open_database 过渡态）；
//  ② 禁新增 require_*_session 变体（会话闸只能引用 super::persistence::
//     gates 声明；geo_operations 内联闸随票 04 收编，文本守卫不覆盖内联
//     形态，由票 04 的错误串钉守）；
//  ③ 禁 open 路径外直呼 ensure_schema（迁移编排只活在内核
//     run_migrations/initialize_database 与旧 open_database 过渡态；各域
//     ensure_schema 的定义行不算直呼）。
//
// 扫描只看生产段（首个 `#[cfg(test)]` 后紧跟 mod 声明之前的文本，沿
// ADR-0013 vitest 守卫先例）：测试 fixture 直开库/补 schema 不受约束——
// 三条规则管的是生产代码。内核 persistence.rs 对 ①③ 是结构性放行（它
// 就是 open 路径本体，不进豁免表——终态零豁免的前提），对 ② 照扫。
//
// 豁免表＝现存直呼的登记在册过渡态（非违规），按票消项：票 02（已结）消
// post_publish_monitoring/publish_scheduler/brand_workspace.rs 的调用点
// （闸变体两项随之清零；brand_workspace.rs 的 ①③ 随旧 open_database 本体
// 归票 05），票 03 消 articles/materials/distribution_plans，票 04 消
// geo_baselines/geo_dashboard/question_pools/topic_plans/geo_operations，
// 票 05 清空归零。
//
// 盘点口径注记：spec/ADR 记「豁免表初始 13 文件」为 2026-09-04 巡检笔数；
// 按本守卫生产段口径逐文件盘点为 11 文件（knowledge/geo_baselines/
// post_publish_monitoring 的 ensure_schema 直呼与 articles/materials 等 5
// 文件的 Connection::open 均只出现在测试段；巡检 13 另含 kernel 文件自身
// 与测试段命中）。表与现实严格相等由测试钉死，数目随清零单调下降。
#[cfg(test)]
mod guard {
    use std::fs;
    use std::path::{Path, PathBuf};

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Rule {
        /// ① 禁直呼 rusqlite::Connection::open。
        DirectConnectionOpen,
        /// ② 禁新增 require_*_session 变体。
        SessionGateVariant,
        /// ③ 禁 open 路径外直呼 ensure_schema。
        EnsureSchemaOutsideOpenPath,
    }

    const KERNEL_PATH: &str = "src-tauri/src/brand_workspace/persistence.rs";

    /// 生产段＝首个测试模块之前的文本（沿 ADR-0013 先例：内联
    /// `#[cfg(test)]` 静态/方法与注释里的字面文本不切段）。
    fn production_segment(content: &str) -> &str {
        const ATTR: &str = "#[cfg(test)]";
        let mut from = 0;
        while let Some(hit) = content[from..].find(ATTR) {
            let after = content[from + hit + ATTR.len()..].trim_start();
            if after.starts_with("mod") {
                return &content[..from + hit];
            }
            from += hit + ATTR.len();
        }
        content
    }

    fn rule_hits(rule: Rule, production: &str) -> usize {
        production
            .lines()
            .filter(|line| match rule {
                Rule::DirectConnectionOpen => line.contains("Connection::open"),
                Rule::SessionGateVariant => {
                    line.contains("fn require_") && line.contains("session")
                }
                Rule::EnsureSchemaOutsideOpenPath => {
                    line.contains("ensure_schema(") && !line.contains("fn ensure_schema")
                }
            })
            .count()
    }

    /// 单文件扫描→违例键集；内核文件对 ①③ 结构性放行（open 路径本体）。
    fn scan_file(rel: &str, content: &str) -> Vec<(String, Rule)> {
        let kernel = rel == KERNEL_PATH;
        let production = production_segment(content);
        [
            Rule::DirectConnectionOpen,
            Rule::SessionGateVariant,
            Rule::EnsureSchemaOutsideOpenPath,
        ]
        .into_iter()
        .filter(|rule| rule_hits(*rule, production) > 0)
        .filter(|rule| {
            !(kernel
                && matches!(
                    rule,
                    Rule::DirectConnectionOpen | Rule::EnsureSchemaOutsideOpenPath
                ))
        })
        .map(|rule| (rel.to_string(), rule))
        .collect()
    }

    /// 豁免表＝清零进度表：值按票消项，键须与现实违例集严格相等。
    fn exemption_table() -> Vec<(&'static str, Vec<Rule>)> {
        vec![
            // 旧 open_database 本体：直呼 Connection::open＋10 处 ensure_schema
            // 旧开路径（调用点票 02 清零，本体删除归票 05）。
            (
                "src-tauri/src/brand_workspace.rs",
                vec![
                    Rule::DirectConnectionOpen,
                    Rule::EnsureSchemaOutsideOpenPath,
                ],
            ),
            // 7 个命名会话闸变体（票 02 已消：post_publish_monitoring/
            // publish_scheduler；票 03：articles/materials/
            // distribution_plans；票 04：geo_baselines/geo_dashboard/
            // question_pools/topic_plans）。
            (
                "src-tauri/src/brand_workspace/articles.rs",
                vec![Rule::SessionGateVariant],
            ),
            (
                "src-tauri/src/brand_workspace/materials.rs",
                vec![Rule::SessionGateVariant],
            ),
            (
                "src-tauri/src/brand_workspace/distribution_plans.rs",
                vec![Rule::SessionGateVariant],
            ),
            (
                "src-tauri/src/brand_workspace/geo_baselines.rs",
                vec![Rule::SessionGateVariant],
            ),
            (
                "src-tauri/src/brand_workspace/geo_dashboard.rs",
                vec![Rule::SessionGateVariant],
            ),
            (
                "src-tauri/src/brand_workspace/question_pools.rs",
                vec![Rule::SessionGateVariant],
            ),
            (
                "src-tauri/src/brand_workspace/topic_plans.rs",
                vec![Rule::SessionGateVariant],
            ),
            // geo_operations：8 处开库后重复 ensure（票 04 随内联闸一并收编）。
            (
                "src-tauri/src/brand_workspace/geo_operations.rs",
                vec![Rule::EnsureSchemaOutsideOpenPath],
            ),
        ]
    }

    fn brand_workspace_sources() -> Vec<(String, String)> {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = vec![read_source(
            &manifest.join("src").join("brand_workspace.rs"),
        )];
        collect_rust_sources(&manifest.join("src").join("brand_workspace"), &mut files);
        files.sort();
        files
    }

    fn read_source(path: &Path) -> (String, String) {
        let rel = format!(
            "src-tauri/{}",
            path.strip_prefix(env!("CARGO_MANIFEST_DIR"))
                .expect("source under manifest dir")
                .to_string_lossy()
                .replace('\\', "/")
        );
        let content =
            fs::read_to_string(path).unwrap_or_else(|error| panic!("read source {rel}: {error}"));
        (rel, content)
    }

    fn collect_rust_sources(dir: &Path, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir)
            .unwrap_or_else(|error| panic!("read dir {}: {error}", dir.display()))
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                collect_rust_sources(&path, out);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                out.push(read_source(&path));
            }
        }
    }

    #[test]
    fn persistence_guard_ratchet_strictly_matches_reality() {
        let found: Vec<(String, Rule)> = brand_workspace_sources()
            .iter()
            .flat_map(|(rel, content)| scan_file(rel, content))
            .collect();
        let expected: Vec<(String, Rule)> = exemption_table()
            .into_iter()
            .flat_map(|(rel, rules)| rules.into_iter().map(move |rule| (rel.to_string(), rule)))
            .collect();

        let unregistered: Vec<&(String, Rule)> =
            found.iter().filter(|hit| !expected.contains(hit)).collect();
        assert!(
            unregistered.is_empty(),
            "发现未登记的持久化违例（新直开库/新会话闸变体/open 路径外直呼 \
             ensure_schema 均不允许：开库经 BrandWorkspaceStore::open，闸用 \
             persistence::gates 声明，迁移编排只活在内核）。违例：{unregistered:?}"
        );

        let stale: Vec<&(String, Rule)> =
            expected.iter().filter(|hit| !found.contains(hit)).collect();
        assert!(
            stale.is_empty(),
            "豁免表里已无对应现实违例的登记项：该文件违例已被迁移或删除时必须同票\
             消项（豁免表即清零进度表，不允许悬挂登记）。悬挂：{stale:?}"
        );
    }

    #[test]
    fn guard_scanner_flags_injected_samples_for_all_three_rules() {
        // ①：直呼开库（含 open_in_memory 前缀口径）。
        assert_eq!(
            rule_hits(
                Rule::DirectConnectionOpen,
                "let c = Connection::open(path)?;"
            ),
            1
        );
        assert_eq!(
            rule_hits(
                Rule::DirectConnectionOpen,
                "let c = rusqlite::Connection::open_in_memory().unwrap();"
            ),
            1
        );
        // ②：新增会话闸变体；非 session 的 require_* 不误伤。
        assert_eq!(
            rule_hits(
                Rule::SessionGateVariant,
                "fn require_new_domain_session(c: &Connection, s: &str) -> Result<(), String> {",
            ),
            1
        );
        assert_eq!(
            rule_hits(
                Rule::SessionGateVariant,
                "fn require_pending(candidate: &Candidate) -> Result<(), String> {",
            ),
            0
        );
        // ③：ensure_schema 直呼；定义行不算。
        assert_eq!(
            rule_hits(
                Rule::EnsureSchemaOutsideOpenPath,
                "ensure_schema(&connection)?;"
            ),
            1
        );
        assert_eq!(
            rule_hits(
                Rule::EnsureSchemaOutsideOpenPath,
                "pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {",
            ),
            0
        );
    }

    #[test]
    fn guard_production_segment_cuts_only_at_test_module() {
        let sample = [
            "fn prod_one() {}",
            "#[cfg(test)]",
            "static INLINE_TEST_ONLY: u8 = 0; // 内联 cfg(test) 静态不切段",
            "// 注释里的 #[cfg(test)] 字面文本不切段",
            "#[cfg(test)]",
            "mod tests {",
            "    let c = Connection::open(path);",
            "}",
        ]
        .join("\n");
        let production = production_segment(&sample);
        assert!(production.contains("fn prod_one"));
        assert!(production.contains("INLINE_TEST_ONLY"));
        assert!(!production.contains("mod tests"));
    }

    #[test]
    fn guard_injected_new_domain_file_must_be_red() {
        // 变异演示：新域文件若自带「直开库＋直呼 ensure_schema＋新闸变体」
        // 整副旧骨架，三条规则同时命中且均未登记——棘轮红灯路径复现。
        let injected = [
            "fn store(root: &Path) {",
            "    let connection = Connection::open(root.join(\"project.sqlite\")).unwrap();",
            "    ensure_schema(&connection).unwrap();",
            "}",
            "fn require_new_domain_session(connection: &Connection, id: &str) {}",
            "#[cfg(test)]",
            "mod tests {}",
        ]
        .join("\n");
        let hits = scan_file("src-tauri/src/brand_workspace/new_domain.rs", &injected);
        assert_eq!(hits.len(), 3, "三条规则应同时命中：{hits:?}");
        let table = exemption_table();
        for (rel, rule) in &hits {
            assert!(
                !table
                    .iter()
                    .any(|(exempted, rules)| *exempted == rel.as_str() && rules.contains(rule)),
                "注入样例不得命中豁免表：{rel}::{rule:?}"
            );
        }
    }

    #[test]
    fn guard_kernel_file_is_structural_allowlist_not_exemption() {
        // 内核自身的 Connection::open/ensure_schema 编排不进豁免表（结构性
        // 放行——终态零豁免的前提），但 ② 照扫：内核不得长出闸变体。
        let kernel_sample = [
            "pub(crate) fn open(ws: &BrandWorkspace) -> Result<Connection, String> {",
            "    let connection = Connection::open(ws.root_path.join(\"project.sqlite\"))?;",
            "    run_migrations(&connection)?;",
            "}",
            "#[cfg(test)]",
            "mod tests {}",
        ]
        .join("\n");
        let hits = scan_file(KERNEL_PATH, &kernel_sample);
        assert_eq!(hits, vec![]);
        let with_variant =
            format!("fn require_sneaky_session(c: &Connection, s: &str) {{}}\n{kernel_sample}");
        assert_eq!(
            scan_file(KERNEL_PATH, &with_variant),
            vec![(KERNEL_PATH.to_string(), Rule::SessionGateVariant)]
        );
        assert!(
            !exemption_table().iter().any(|(rel, _)| *rel == KERNEL_PATH),
            "内核不得进豁免表"
        );
    }
}
