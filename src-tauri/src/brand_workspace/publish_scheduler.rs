use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use pulldown_cmark::{html, Options, Parser};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::sync::Notify;
use uuid::Uuid;

use super::{open_database, BrandWorkspace, BrandWorkspaceStore};

const POLICY_VERSION: &str = "js-ai-dev-deterministic-publish-v1";
const MAX_BODY_BYTES: usize = 256 * 1024;
const CLAIM_LEASE_MS: i64 = 5 * 60 * 1_000;
const BACKGROUND_INTERVAL: Duration = Duration::from_secs(30);
/// 自动重试 2 次、间隔 3 秒（产品语义 2026-09-01）：瞬时故障快速自愈，
/// 耗尽即落终态 failed-nonretryable 跳过，队列不再长时间等待退避；
/// 深度恢复交由用户驱动的「重新发布」按钮。
const RETRY_BACKOFF_MS: [i64; 2] = [3_000, 3_000];
/// 发布执行状态全集（三方裁判：`src/shared/geo/publishSchedulerContract.json`，
/// ADR-0012 双侧 pin）。顺序即契约顺序，建表 CHECK 与存量库迁移都由本表生成。
const PUBLISH_EXECUTION_STATUSES: [&str; 10] = [
    "awaiting-confirmation",
    "confirmed",
    "running",
    "scheduled",
    "partially-succeeded",
    "succeeded",
    "failed",
    "reconciliation-required",
    "superseded",
    "cancelled",
];
/// 发布条目状态全集（三方裁判：`src/shared/geo/publishSchedulerContract.json`，
/// ADR-0012 双侧 pin）。顺序即契约顺序。
const PUBLISH_ITEM_STATUSES: [&str; 9] = [
    "pending",
    "uploading",
    "uploaded",
    "submitting",
    "submitted",
    "failed-retryable",
    "failed-nonretryable",
    "reconciliation-required",
    "cancelled",
];
/// 未登录时认领到的执行单推迟到下一轮再试的间隔：不消耗重试次数，
/// 登录恢复后指纹自然匹配、自动继续执行。
const LOGIN_RESUME_DEFER_MS: i64 = 5 * 60 * 1_000;
const IRREVERSIBLE_IMPACT: &str =
    "开始后将上传最终批准正文，并可能向渠道提交付费订单；渠道受理后可能产生费用且无法由本应用撤销。";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPreviewRequest {
    pub plan_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishConfirmRequest {
    pub execution_id: String,
    pub expected_revision: i64,
    pub confirmation_digest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishStartRequest {
    pub execution_id: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRetryRequest {
    pub execution_id: String,
    pub item_id: String,
    pub expected_item_revision: i64,
}

/// 取消发布（2026-09 产品语义）：在途单（uploading/submitting）跑完本次
/// 尝试，其余未完结条目转 cancelled 不再发出。WebView 专属 UI 命令入参，
/// 与 confirm/start 同款 revision CAS。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishCancelRequest {
    pub execution_id: String,
    pub expected_revision: i64,
}

/// 聊天修订（ADR 0003，票 38）：仅作用于 awaiting-confirmation 执行的
/// modify——预算、发布开始时间与逐项排期。确认、开始与重试仍 exclusively
/// 走 Rust UI 权威入口；修订后重算确认摘要，用户须对新摘要再确认。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRevisionRequest {
    pub execution_id: String,
    pub expected_revision: i64,
    pub budget_cny: Option<f64>,
    pub publish_start_at: Option<String>,
    #[serde(default)]
    pub item_updates: Vec<PublishItemScheduleUpdate>,
    pub actor_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishItemScheduleUpdate {
    pub item_id: String,
    pub scheduled_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PublishProviderSnapshot {
    object_storage: PublishProviderSlotSnapshot,
    distribution: PublishProviderSlotSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PublishProviderSlotSnapshot {
    provider: String,
    endpoint_family: String,
    configured: bool,
    configuration_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishArticleSnapshot {
    article_id: String,
    approved_revision: i64,
    approved_body_sha256: String,
    title: String,
    body_bytes: usize,
    body_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishChannelSnapshot {
    resource_id: i64,
    kind: String,
    name: String,
    estimated_price_cny: f64,
    published_rate: f64,
    /// 渠道单笔订单的点数单价（票 09）：服务端算好投影给 renderer，
    /// 读取旧快照行时按 estimated_price_cny 重算回填，展示端不实现倍率。
    #[serde(default)]
    price_points: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishRequestSummary {
    article_id: String,
    approved_revision: i64,
    approved_body_sha256: String,
    resource_id: i64,
    scheduled_at: String,
    planned_object_url: String,
    estimated_price_cny: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishItemProjection {
    id: String,
    revision: i64,
    sequence: i64,
    article: PublishArticleSnapshot,
    channel: PublishChannelSnapshot,
    scheduled_at: String,
    status: String,
    idempotency_key: String,
    external_request_sn: String,
    payload_hash: String,
    object_key: String,
    object_url: Option<String>,
    external_order_id: Option<String>,
    external_content_id: Option<String>,
    attempts: i64,
    upload_attempts: i64,
    next_attempt_at: Option<String>,
    started_at: Option<String>,
    finished_at: Option<String>,
    request_summary: PublishRequestSummary,
    failure_code: Option<String>,
    failure_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishExecutionProjection {
    id: String,
    operation_id: String,
    workspace_id: String,
    created_by_session_id: String,
    distribution_plan_id: String,
    distribution_plan_revision: i64,
    policy_version: &'static str,
    revision: i64,
    status: String,
    budget_cny: f64,
    estimated_spend_cny: f64,
    /// 全部发布项 price_points 之和（票 09）：投影时逐项累加，不落库。
    total_price_points: i64,
    publish_start_at: String,
    irreversible_impact: &'static str,
    confirmation_digest: String,
    provider_snapshot: PublishProviderSnapshot,
    items: Vec<PublishItemProjection>,
    confirmed_at: Option<String>,
    execution_started_at: Option<String>,
    finished_at: Option<String>,
    created_at: String,
    updated_at: String,
}

/// geo_publish_executions 的 status CHECK 子句（由 PUBLISH_EXECUTION_STATUSES
/// 生成）。折行是历史存量形态：'superseded' 与 'cancelled' 两代迁移按
/// sqlite_master 原文 replace 追加、新库 DDL 对齐同一文本——生成文本必须与
/// 现存 DDL 逐字节一致（bytes-match 测试钉死），否则新旧二进制建出的库
/// sqlite_master 文本分叉，按原文匹配的表重建迁移会失配。
fn publish_execution_status_check_clause() -> String {
    let [awaiting, confirmed, running, scheduled, partially, succeeded, failed, reconciliation, superseded, cancelled] =
        PUBLISH_EXECUTION_STATUSES;
    format!(
        "status TEXT NOT NULL CHECK(status IN (
                    '{awaiting}','{confirmed}','{running}','{scheduled}',
                    '{partially}','{succeeded}','{failed}','{reconciliation}'
                    ,'{superseded}','{cancelled}'
                ))"
    )
}

/// geo_publish_items 的 status CHECK 子句（由 PUBLISH_ITEM_STATUSES 生成），
/// 逐字节一致约束同上。
fn publish_item_status_check_clause() -> String {
    let [pending, uploading, uploaded, submitting, submitted, failed_retryable, failed_nonretryable, reconciliation, cancelled] =
        PUBLISH_ITEM_STATUSES;
    format!(
        "status TEXT NOT NULL CHECK(status IN (
                    '{pending}','{uploading}','{uploaded}','{submitting}','{submitted}',
                    '{failed_retryable}','{failed_nonretryable}','{reconciliation}',
                    '{cancelled}'
                ))"
    )
}

/// 旧库（'cancelled' 入契约前）CHECK 列表尾值 → 追加 'cancelled' 后的替换
/// 对，由状态常量生成：锚定旧列表最后一个值的裸引号串。executions 旧形态
/// 为 `,'superseded'` 独立行、items 旧形态为行尾 `'reconciliation-required'`，
/// 裸值锚点对两种形态的替换结果与既有硬编码迁移逐字节一致（带前导逗号的
/// 锚点是裸值的子串，裸值只会多匹配、不会错替换——替换语义都是追加
/// 'cancelled'，方向不变）。
fn append_cancelled_replace_pair(statuses: &[&str]) -> Result<(String, String), String> {
    let (&appended, legacy) = statuses
        .split_last()
        .ok_or("publish status contract must not be empty")?;
    if appended != "cancelled" {
        return Err(format!(
            "publish status contract must end with 'cancelled' (got '{appended}')"
        ));
    }
    let &legacy_tail = legacy
        .last()
        .ok_or("publish status contract lacks a pre-cancelled tail")?;
    let anchor = format!("'{legacy_tail}'");
    Ok((anchor.clone(), format!("{anchor},'{appended}'")))
}

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    let execution_status_check = publish_execution_status_check_clause();
    let item_status_check = publish_item_status_check_clause();
    connection
        .execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS geo_publish_executions (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL UNIQUE REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                distribution_plan_id TEXT NOT NULL REFERENCES geo_distribution_plans(id),
                distribution_plan_revision INTEGER NOT NULL,
                {execution_status_check},
                revision INTEGER NOT NULL,
                budget_cny REAL NOT NULL,
                estimated_spend_cny REAL NOT NULL,
                publish_start_at TEXT NOT NULL,
                confirmation_digest TEXT NOT NULL,
                provider_snapshot_json TEXT NOT NULL,
                confirmed_at TEXT,
                execution_started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(distribution_plan_id, distribution_plan_revision)
             );
             CREATE INDEX IF NOT EXISTS geo_publish_execution_latest
                ON geo_publish_executions(updated_at DESC, id DESC);
             CREATE TABLE IF NOT EXISTS geo_publish_items (
                id TEXT PRIMARY KEY,
                execution_id TEXT NOT NULL REFERENCES geo_publish_executions(id),
                sequence INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                article_id TEXT NOT NULL REFERENCES geo_articles(id),
                approved_revision INTEGER NOT NULL,
                approved_body_sha256 TEXT NOT NULL,
                approved_body_path TEXT NOT NULL,
                article_json TEXT NOT NULL,
                channel_json TEXT NOT NULL,
                scheduled_at TEXT NOT NULL,
                scheduled_at_ms INTEGER NOT NULL,
                {item_status_check},
                idempotency_key TEXT NOT NULL UNIQUE,
                external_request_sn TEXT NOT NULL,
                payload_hash TEXT NOT NULL,
                object_key TEXT NOT NULL,
                object_url TEXT,
                external_order_id TEXT,
                external_content_id TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                upload_attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at_ms INTEGER,
                claim_token TEXT,
                lease_until_ms INTEGER,
                started_at TEXT,
                finished_at TEXT,
                request_summary_json TEXT NOT NULL,
                failure_code TEXT,
                failure_reason TEXT,
                UNIQUE(execution_id, sequence),
                UNIQUE(execution_id, article_id)
             );
             CREATE INDEX IF NOT EXISTS geo_publish_due_items
                ON geo_publish_items(status, scheduled_at_ms, next_attempt_at_ms);
             CREATE TABLE IF NOT EXISTS geo_publish_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                execution_id TEXT NOT NULL REFERENCES geo_publish_executions(id),
                item_id TEXT,
                event_type TEXT NOT NULL,
                actor_session_id TEXT,
                detail_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );",
        ))
        .map_err(|error| format!("initialize publish scheduler schema: {error}"))?;
    super::drop_brand_sessions_foreign_keys(connection, &["geo_publish_executions"])?;
    super::ensure_column(
        connection,
        "geo_publish_items",
        "upload_attempts",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    super::ensure_column(
        connection,
        "geo_publish_items",
        "external_request_sn",
        "TEXT",
    )?;
    extend_publish_status_checks(connection)
}

/// 存量库迁移（取消功能）：geo_publish_executions / geo_publish_items 的
/// status CHECK 约束不含 'cancelled' 时按 sqlite_master 原文重建——与
/// articles.rs 的 extend_geo_articles_status_check 及 drop_brand_sessions_
/// foreign_keys 同一先例（foreign_keys=OFF 包裹、索引随 DROP 消失后按原文
/// 重建）。SQLite 的 CHECK 在 UPDATE 上同样强制，无法绕开重建。
fn extend_publish_status_checks(connection: &Connection) -> Result<(), String> {
    let status_check_tables: [(&str, &[&str]); 2] = [
        ("geo_publish_executions", &PUBLISH_EXECUTION_STATUSES),
        ("geo_publish_items", &PUBLISH_ITEM_STATUSES),
    ];
    for (table, statuses) in status_check_tables {
        let (check_without, check_with) = append_cancelled_replace_pair(statuses)
            .map_err(|error| format!("inspect {table} status check: {error}"))?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect {table} status check: {error}"))?;
        let Some(existing_sql) = existing else {
            continue;
        };
        if !existing_sql.contains("status TEXT NOT NULL CHECK")
            || existing_sql.contains("'cancelled'")
        {
            continue;
        }
        let rebuilt_sql = existing_sql.replace(&check_without, &check_with);
        if rebuilt_sql == existing_sql {
            // 非预期形态（历史 schema 措辞不同）：fail loud，取消路径会因
            // CHECK 拒绝而显式报错，不会被误认为已迁移。
            return Err(format!("{table} status check migration target missing"));
        }
        let renamed_sql = super::rename_table_in_ddl(
            &rebuilt_sql,
            table,
            &format!("{table}__status_check_extended"),
        )?;

        let mut index_ddls: Vec<String> = Vec::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT sql FROM sqlite_master
                     WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL",
                )
                .map_err(|error| format!("list {table} indexes: {error}"))?;
            let mut rows = statement
                .query([table])
                .map_err(|error| format!("read {table} indexes: {error}"))?;
            while let Some(row) = rows
                .next()
                .map_err(|error| format!("advance {table} index cursor: {error}"))?
            {
                index_ddls.push(
                    row.get(0)
                        .map_err(|error| format!("read {table} index ddl: {error}"))?,
                );
            }
        }

        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(|error| format!("unlock {table} status check rebuild: {error}"))?;
        let rebuild = connection.execute_batch(&format!(
            "BEGIN IMMEDIATE;
             {renamed_sql};
             INSERT INTO {table}__status_check_extended SELECT * FROM {table};
             DROP TABLE {table};
             ALTER TABLE {table}__status_check_extended RENAME TO {table};
             {}
             COMMIT;",
            index_ddls
                .iter()
                .map(|ddl| format!("{ddl};"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
        let restored = connection.execute_batch("PRAGMA foreign_keys = ON;");
        match (rebuild, restored) {
            (Ok(()), Ok(())) => Ok(()),
            (rebuild, _) => {
                let _ = connection.execute_batch("ROLLBACK;");
                rebuild.map_err(|error| format!("rebuild {table} status check: {error}"))
            }
        }?;
    }
    Ok(())
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn external_request_sn(idempotency_key: &str) -> String {
    format!(
        "publish-order-{}",
        &sha256_hex(idempotency_key.as_bytes())[..32]
    )
}

/// 渠道订单点数单价（票 09，与网关 `publishOrderPoints` 同式）：媒介价
/// ×1.6 → 点数向上取整（1 元 = 10 点锚点）。以分为基的整数运算：
/// ceil(分 × 1.6 × 10 / 100) = ceil(分 × 4 / 25)。例：¥88.00 → 1408 点。
pub(super) fn publish_channel_price_points(price_cny: f64) -> i64 {
    if !price_cny.is_finite() || price_cny <= 0.0 {
        return 0;
    }
    let cents = (price_cny * 100.0).round() as i64;
    // ceil(a/b) = (a + b - 1) / b（正整数整除）。
    (cents * 4 + 24) / 25
}

fn now_iso(now_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_time(value: &str, code: &str) -> Result<i64, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .map_err(|_| code.to_string())
}

fn require_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM brand_sessions WHERE id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("verify publish session: {error}"))?;
    if exists {
        Ok(())
    } else {
        Err("publish_scheduler_session_not_found".to_string())
    }
}

fn bounded_body(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(path).map_err(|_| "publish_approved_body_unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() as usize > MAX_BODY_BYTES {
        return Err("publish_approved_body_unavailable".to_string());
    }
    let file =
        std::fs::File::open(path).map_err(|_| "publish_approved_body_unavailable".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "publish_approved_body_unavailable".to_string())?;
    if bytes.len() > MAX_BODY_BYTES || std::str::from_utf8(&bytes).is_err() {
        return Err("publish_approved_body_unavailable".to_string());
    }
    Ok(bytes)
}

fn body_summary(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

#[derive(Debug, Clone)]
struct PublishProviderExecutionContext {
    snapshot: PublishProviderSnapshot,
}

#[cfg(test)]
static PROVIDER_EXECUTION_CONTEXT_LOADS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// 票 08 起（网关 port 闭环）测试注入的网关 egress 身份：生产路径读
/// `account_auth` 的账号会话事实，单测不能触碰真实 OS 凭据库。
/// 外层 None = 未注入（保持旧行为）；Some(None) = 强制未登录（不受
/// 开发机真实登录态污染）；Some(Some(base)) = 强制网关基地址。
#[cfg(test)]
static TEST_GATEWAY_EGRESS_BASE_URL: std::sync::Mutex<Option<Option<String>>> =
    std::sync::Mutex::new(None);

fn gateway_egress_base_url() -> Option<String> {
    #[cfg(test)]
    if let Some(forced) = TEST_GATEWAY_EGRESS_BASE_URL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return forced;
    }
    crate::account_auth::publish_egress_gateway_base_url()
}

/// Loads one Rust-only view of the publish egress transport. 票 08 起发布
/// 不再读直连 Provider 凭据：上传与下单都经 Session Sidecar 的网关 port
/// （网关侧重签与计费），本快照冻结的是网关传输身份——账号会话在位与
/// 网关基地址（均非密钥）。服务器侧 OSS/渠道配置对客户端不可见，指纹
/// 只承诺「经同一网关执行」。
fn configured_provider_execution_context() -> Result<PublishProviderExecutionContext, String> {
    #[cfg(test)]
    PROVIDER_EXECUTION_CONTEXT_LOADS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let gateway_base = gateway_egress_base_url();
    let object_fingerprint = gateway_base
        .as_deref()
        .map(|base| sha256_hex(format!("gateway-publish-egress-v1|object-storage|{base}")));
    let distribution_fingerprint = gateway_base
        .as_deref()
        .map(|base| sha256_hex(format!("gateway-publish-egress-v1|distribution|{base}")));
    Ok(PublishProviderExecutionContext {
        snapshot: PublishProviderSnapshot {
            object_storage: PublishProviderSlotSnapshot {
                provider: "aliyun-oss".to_string(),
                endpoint_family: "gateway-oss-put".to_string(),
                configured: gateway_base.is_some(),
                configuration_fingerprint: object_fingerprint,
            },
            distribution: PublishProviderSlotSnapshot {
                provider: "超级媒介".to_string(),
                endpoint_family: "gateway-order-api".to_string(),
                configured: gateway_base.is_some(),
                configuration_fingerprint: distribution_fingerprint,
            },
        },
    })
}

fn configured_provider_snapshot() -> Result<PublishProviderSnapshot, String> {
    configured_provider_execution_context().map(|context| context.snapshot)
}

fn unavailable_provider_snapshot() -> PublishProviderSnapshot {
    PublishProviderSnapshot {
        object_storage: PublishProviderSlotSnapshot {
            provider: "aliyun-oss".to_string(),
            endpoint_family: "gateway-oss-put".to_string(),
            configured: false,
            configuration_fingerprint: None,
        },
        distribution: PublishProviderSlotSnapshot {
            provider: "超级媒介".to_string(),
            endpoint_family: "gateway-order-api".to_string(),
            configured: false,
            configuration_fingerprint: None,
        },
    }
}

/// 指纹比对只在「双方都 configured 且指纹不同」时判定配置变化：当前侧
/// 因未登录拿不到网关指纹（configured=false）时无法得出「配置变了」的
/// 结论——网关配置未必变化，只是登录态抖动——必须按「无变化」处理，
/// 等登录恢复后指纹自然匹配。
fn provider_configuration_changed(
    frozen: &PublishProviderSnapshot,
    current: &PublishProviderSnapshot,
) -> bool {
    fn slot_changed(
        frozen: &PublishProviderSlotSnapshot,
        current: &PublishProviderSlotSnapshot,
    ) -> bool {
        frozen.configured
            && current.configured
            && frozen.configuration_fingerprint != current.configuration_fingerprint
    }
    slot_changed(&frozen.object_storage, &current.object_storage)
        || slot_changed(&frozen.distribution, &current.distribution)
}

#[derive(Debug)]
struct PreparedItem {
    id: String,
    sequence: i64,
    article: PublishArticleSnapshot,
    approved_body_path: String,
    channel: PublishChannelSnapshot,
    scheduled_at: String,
    scheduled_at_ms: i64,
    idempotency_key: String,
    external_request_sn: String,
    payload_hash: String,
    object_key: String,
    request_summary: PublishRequestSummary,
}

/// 确认摘要的逐项输入（preview 与聊天修订共用，保证同一公式）。
struct PublishDigestItem {
    article_id: String,
    approved_revision: i64,
    approved_body_sha256: String,
    resource_id: i64,
    kind: String,
    name: String,
    estimated_price_cny: f64,
    published_rate: f64,
    scheduled_at: String,
    payload_hash: String,
}

impl PublishDigestItem {
    fn from_prepared(item: &PreparedItem) -> Self {
        Self {
            article_id: item.article.article_id.clone(),
            approved_revision: item.article.approved_revision,
            approved_body_sha256: item.article.approved_body_sha256.clone(),
            resource_id: item.channel.resource_id,
            kind: item.channel.kind.clone(),
            name: item.channel.name.clone(),
            estimated_price_cny: item.channel.estimated_price_cny,
            published_rate: item.channel.published_rate,
            scheduled_at: item.scheduled_at.clone(),
            payload_hash: item.payload_hash.clone(),
        }
    }
}

/// 确认摘要覆盖：策略版本、不可逆影响、计划身份、预算/花费/开始时间、
/// provider 快照与逐项最终内容（含排期与载荷哈希）。任何修订后重算，
/// 迫使用户对新摘要重新走 UI 确认。
fn confirmation_digest_of(
    plan_id: &str,
    plan_revision: i64,
    budget: f64,
    spend: f64,
    publish_start_at: &str,
    provider_snapshot_json: &str,
    items: &[PublishDigestItem],
) -> String {
    let digest_input = items
        .iter()
        .map(|item| {
            format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                item.article_id,
                item.approved_revision,
                item.approved_body_sha256,
                item.resource_id,
                item.kind,
                item.name,
                item.estimated_price_cny,
                item.published_rate,
                item.scheduled_at,
                item.payload_hash
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    sha256_hex(
        format!(
            "{POLICY_VERSION}|{IRREVERSIBLE_IMPACT}|{plan_id}|{plan_revision}|{budget}|{spend}|{publish_start_at}|{provider_snapshot_json}|{digest_input}"
        )
            .as_bytes(),
    )
}

impl BrandWorkspaceStore {
    pub fn latest_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Option<PublishExecutionProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let id = connection
            .query_row(
                "SELECT id FROM geo_publish_executions ORDER BY updated_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest publish execution: {error}"))?;
        id.map(|id| read_execution(&connection, workspace_id, &id))
            .transpose()
    }

    pub fn get_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        execution_id: &str,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        read_execution(&connection, workspace_id, execution_id)
    }

    /// Session-free projection read for the WebView's brand-level 「效果」 page:
    /// the latest query is workspace-wide, so the brand_sessions existence gate
    /// only forces users to open a chat session before viewing results.
    pub fn latest_publish_execution_readonly(
        &self,
        workspace_id: &str,
    ) -> Result<Option<PublishExecutionProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let id = connection
            .query_row(
                "SELECT id FROM geo_publish_executions ORDER BY updated_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest publish execution: {error}"))?;
        id.map(|id| read_execution(&connection, workspace_id, &id))
            .transpose()
    }

    pub fn prepare_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishPreviewRequest,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let provider_context = configured_provider_execution_context()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("prepare publish execution transaction: {error}"))?;
        let plan_id = if let Some(value) = request.plan_id {
            value
        } else {
            transaction
                .query_row(
                    "SELECT id FROM geo_distribution_plans WHERE status='confirmed'
                     ORDER BY updated_at DESC, id DESC LIMIT 1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("read confirmed distribution plan: {error}"))?
                .ok_or_else(|| "publish_confirmed_distribution_plan_required".to_string())?
        };
        let (plan_revision, status, projection_json): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, status, projection_json FROM geo_distribution_plans WHERE id=?1",
                [&plan_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read publish distribution plan: {error}"))?
            .ok_or_else(|| "publish_distribution_plan_not_found".to_string())?;
        if status != "confirmed" {
            return Err("publish_confirmed_distribution_plan_required".to_string());
        }
        if let Some(existing) = transaction
            .query_row(
                "SELECT id FROM geo_publish_executions
                 WHERE distribution_plan_id=?1 AND distribution_plan_revision=?2",
                params![plan_id, plan_revision],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read existing publish execution: {error}"))?
        {
            transaction
                .commit()
                .map_err(|error| format!("finish existing publish preview: {error}"))?;
            return read_execution(&connection, workspace_id, &existing);
        }
        // Only one never-started publish preview is actionable per brand.
        // Preparing a different exact confirmed plan explicitly abandons all
        // older awaiting previews while preserving their rows and audit.
        let awaiting_execution_ids = {
            let mut statement = transaction
                .prepare(
                    "SELECT id FROM geo_publish_executions
                     WHERE status='awaiting-confirmation' AND distribution_plan_id!=?1",
                )
                .map_err(|error| format!("prepare superseded publish previews: {error}"))?;
            let rows = statement
                .query_map([&plan_id], |row| row.get::<_, String>(0))
                .map_err(|error| format!("read superseded publish previews: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("collect superseded publish previews: {error}"))?;
            rows
        };
        let superseded_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        for execution_id in awaiting_execution_ids {
            transaction
                .execute(
                    "UPDATE geo_publish_executions SET status='superseded',
                     revision=revision+1, finished_at=?2, updated_at=?2
                     WHERE id=?1 AND status='awaiting-confirmation'",
                    params![execution_id, superseded_at],
                )
                .map_err(|error| format!("supersede old publish preview: {error}"))?;
            transaction
                .execute(
                    "UPDATE geo_publish_items
                     SET idempotency_key='superseded:' || execution_id || ':' || idempotency_key
                     WHERE execution_id=?1",
                    [&execution_id],
                )
                .map_err(|error| format!("release old publish preview keys: {error}"))?;
            transaction
                .execute(
                    "UPDATE geo_operations SET state='publish-preview-superseded'
                     WHERE id=(SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                    [&execution_id],
                )
                .map_err(|error| format!("supersede old publish operation: {error}"))?;
            insert_audit(
                &transaction,
                &execution_id,
                None,
                "preview-superseded",
                Some(session_id),
                &json!({"replacementPlanId": plan_id}),
                &superseded_at,
            )?;
        }
        let projection: Value = serde_json::from_str(&projection_json)
            .map_err(|_| "publish_distribution_snapshot_invalid".to_string())?;
        let budget = projection
            .get("budgetCny")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| "publish_budget_invalid".to_string())?;
        let per_article_max_points = projection
            .get("perArticleMaxPoints")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or(crate::distribution_spend_limits::DEFAULT_PER_ARTICLE_MAX_POINTS);
        let total_max_points = projection
            .get("totalMaxPoints")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or_else(|| publish_channel_price_points(budget));
        let publish_start_at = projection
            .get("publishStartAt")
            .and_then(Value::as_str)
            .ok_or_else(|| "publish_schedule_invalid".to_string())?
            .to_string();
        parse_time(&publish_start_at, "publish_schedule_invalid")?;
        let assignments = projection
            .get("assignments")
            .and_then(Value::as_array)
            .ok_or_else(|| "publish_assignments_invalid".to_string())?;
        let articles = projection
            .get("articles")
            .and_then(Value::as_array)
            .ok_or_else(|| "publish_articles_invalid".to_string())?;
        let candidates = projection
            .get("candidates")
            .and_then(Value::as_array)
            .ok_or_else(|| "publish_channels_invalid".to_string())?;
        if assignments.is_empty() || assignments.len() != articles.len() {
            return Err("publish_assignments_invalid".to_string());
        }

        let mut prepared = Vec::with_capacity(assignments.len());
        let mut spend = 0.0_f64;
        let mut spend_points = 0_i64;
        for (index, assignment) in assignments.iter().enumerate() {
            let article_id = assignment
                .get("articleId")
                .and_then(Value::as_str)
                .ok_or_else(|| "publish_assignment_article_invalid".to_string())?;
            let resource_id = assignment
                .get("resourceId")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .ok_or_else(|| "publish_assignment_channel_invalid".to_string())?;
            let scheduled_at = assignment
                .get("scheduledAt")
                .and_then(Value::as_str)
                .ok_or_else(|| "publish_schedule_invalid".to_string())?
                .to_string();
            let scheduled_at_ms = parse_time(&scheduled_at, "publish_schedule_invalid")?;
            let plan_article = articles
                .iter()
                .find(|article| article.get("id").and_then(Value::as_str) == Some(article_id))
                .ok_or_else(|| "publish_article_snapshot_mismatch".to_string())?;
            let approved_revision = plan_article
                .get("approvedRevision")
                .and_then(Value::as_i64)
                .filter(|value| *value > 0)
                .ok_or_else(|| "publish_article_snapshot_mismatch".to_string())?;
            let (actual_revision, title, approved_path, approved_hash): (
                i64,
                String,
                String,
                String,
            ) = transaction
                .query_row(
                    "SELECT article.approved_revision, version.title,
                            version.approved_body_path, version.body_sha256
                     FROM geo_articles article
                     JOIN geo_article_versions version
                       ON version.article_id=article.id
                      AND version.revision=article.approved_revision
                     WHERE article.id=?1 AND article.status='approved'",
                    [article_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(|error| format!("read approved publish article: {error}"))?
                .ok_or_else(|| "publish_approved_article_required".to_string())?;
            if actual_revision != approved_revision {
                return Err("publish_article_revision_mismatch".to_string());
            }
            let body = bounded_body(&workspace.root_path.join(&approved_path))?;
            if sha256_hex(&body) != approved_hash {
                return Err("publish_article_hash_mismatch".to_string());
            }
            let candidate = candidates
                .iter()
                .find(|candidate| {
                    candidate.get("resourceId").and_then(Value::as_i64) == Some(resource_id)
                })
                .ok_or_else(|| "publish_channel_snapshot_mismatch".to_string())?;
            let price = candidate
                .get("estimatedPriceCny")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or_else(|| "publish_channel_price_unknown".to_string())?;
            let price_points = publish_channel_price_points(price);
            if price_points > per_article_max_points {
                return Err("publish_per_article_limit_exceeded".to_string());
            }
            // 发布率不是决策输入（用户裁决 2026-08-18）：缺失或非法时快照记 0，
            // 不再阻断发布准备；数值仍进确认摘要保持确定性。
            let published_rate = candidate
                .get("publishedRate")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0)
                .unwrap_or(0.0);
            let kind = candidate
                .get("kind")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "media" | "we-media"))
                .ok_or_else(|| "publish_channel_snapshot_mismatch".to_string())?
                .to_string();
            let name = candidate
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "publish_channel_snapshot_mismatch".to_string())?
                .to_string();
            spend += price;
            spend_points += price_points;
            let sequence = index as i64 + 1;
            let stable = format!(
                "{plan_id}|{plan_revision}|{article_id}|{approved_revision}|{approved_hash}|{resource_id}|{scheduled_at}"
            );
            let stable_hash = sha256_hex(stable.as_bytes());
            let id = format!("publish-item-{}", &stable_hash[..24]);
            let idempotency_key =
                format!("article-{article_id}-channel-{resource_id}-v{approved_revision}");
            // The provider limits `sn` to 64 characters. Keep the full ADR key
            // for internal dedupe and freeze the exact external field separately.
            let external_request_sn = external_request_sn(&idempotency_key);
            debug_assert!(external_request_sn.len() <= 64);
            let object_key = format!(
                "articles/{workspace_id}/{article_id}/approved-v{approved_revision}-{approved_hash}.html"
            );
            // 票 08 起：URL 由网关按服务器侧 OSS 公网基地址在上传时解析，
            // 预览期冻结的是确定性对象键（见 payload_hash 的 content-key）。
            let planned_object_url = format!("gateway-oss://{object_key}");
            let structural = if kind == "media" {
                "media-order-v1".to_string()
            } else {
                "publish_form=1|publish_type=1|account_rule=2".to_string()
            };
            let payload_hash = sha256_hex(format!(
                "sn={external_request_sn}|kind={kind}|resource_id={resource_id}|title={title}|content-key={object_key}|{structural}"
            ));
            let article = PublishArticleSnapshot {
                article_id: article_id.to_string(),
                approved_revision,
                approved_body_sha256: approved_hash.clone(),
                title,
                body_bytes: body.len(),
                body_summary: body_summary(&body),
            };
            let channel = PublishChannelSnapshot {
                resource_id,
                kind,
                name,
                estimated_price_cny: price,
                published_rate,
                price_points: publish_channel_price_points(price),
            };
            let request_summary = PublishRequestSummary {
                article_id: article_id.to_string(),
                approved_revision,
                approved_body_sha256: approved_hash,
                resource_id,
                scheduled_at: scheduled_at.clone(),
                planned_object_url,
                estimated_price_cny: price,
            };
            prepared.push(PreparedItem {
                id,
                sequence,
                article,
                approved_body_path: approved_path,
                channel,
                scheduled_at,
                scheduled_at_ms,
                idempotency_key,
                external_request_sn,
                payload_hash,
                object_key,
                request_summary,
            });
        }
        if spend > budget + 0.000_001 {
            return Err("publish_budget_exceeded".to_string());
        }
        if spend_points > total_max_points {
            return Err("publish_total_limit_exceeded".to_string());
        }
        for item in &prepared {
            if let Some((existing_item_id, existing_execution_id, existing_hash, existing_status, existing_item_status)) = transaction
                .query_row(
                    "SELECT item.id, item.execution_id, item.payload_hash, execution.status, item.status
                     FROM geo_publish_items item
                     JOIN geo_publish_executions execution ON execution.id=item.execution_id
                     WHERE item.idempotency_key=?1 AND execution.status!='superseded'
                     ORDER BY execution.created_at DESC LIMIT 1",
                    [&item.idempotency_key],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| format!("inspect publish idempotency key: {error}"))?
            {
                if existing_status == "awaiting-confirmation" {
                    let superseded_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
                    transaction
                        .execute(
                            "UPDATE geo_publish_executions SET status='superseded',
                             revision=revision+1, finished_at=?2, updated_at=?2
                             WHERE id=?1 AND status='awaiting-confirmation'",
                            params![existing_execution_id, superseded_at],
                        )
                        .map_err(|error| format!("supersede publish preview: {error}"))?;
                    transaction
                        .execute(
                            "UPDATE geo_publish_items
                             SET idempotency_key='superseded:' || execution_id || ':' || idempotency_key
                             WHERE execution_id=?1",
                            [&existing_execution_id],
                        )
                        .map_err(|error| format!("release superseded publish keys: {error}"))?;
                    transaction
                        .execute(
                            "UPDATE geo_operations SET state='publish-preview-superseded'
                             WHERE id=(SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                            [&existing_execution_id],
                        )
                        .map_err(|error| format!("supersede publish operation: {error}"))?;
                    insert_audit(
                        &transaction,
                        &existing_execution_id,
                        Some(&existing_item_id),
                        "preview-superseded",
                        Some(session_id),
                        &json!({"replacementPlanId": plan_id}),
                        &superseded_at,
                    )?;
                    continue;
                }
                if existing_hash != item.payload_hash {
                    let conflict_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
                    if existing_item_status == "submitted" {
                        insert_audit(
                            &transaction,
                            &existing_execution_id,
                            Some(&existing_item_id),
                            "duplicate-payload-rejected",
                            Some(session_id),
                            &json!({
                                "idempotencyKey": item.idempotency_key,
                                "existingPayloadHash": existing_hash,
                                "rejectedPayloadHash": item.payload_hash,
                                "completedItemPreserved": true,
                            }),
                            &conflict_at,
                        )?;
                        transaction
                            .commit()
                            .map_err(|error| format!("commit publish duplicate rejection: {error}"))?;
                        return Err("publish_idempotency_payload_conflict".to_string());
                    }
                    transaction
                        .execute(
                            "UPDATE geo_publish_items SET status='reconciliation-required',
                             revision=revision+1, failure_code='payload-hash-conflict',
                             failure_reason='同一幂等键对应不同外部请求，禁止自动执行',
                             finished_at=?2, claim_token=NULL, lease_until_ms=NULL WHERE id=?1",
                            params![existing_item_id, conflict_at],
                        )
                        .map_err(|error| format!("mark publish payload conflict: {error}"))?;
                    transaction
                        .execute(
                            "UPDATE geo_publish_executions SET status='reconciliation-required',
                             revision=revision+1, updated_at=?2 WHERE id=?1",
                            params![existing_execution_id, conflict_at],
                        )
                        .map_err(|error| format!("mark publish execution conflict: {error}"))?;
                    insert_audit(
                        &transaction,
                        &existing_execution_id,
                        Some(&existing_item_id),
                        "payload-hash-conflict",
                        Some(session_id),
                        &json!({
                            "idempotencyKey": item.idempotency_key,
                            "existingPayloadHash": existing_hash,
                            "newPayloadHash": item.payload_hash,
                        }),
                        &conflict_at,
                    )?;
                    transaction
                        .commit()
                        .map_err(|error| format!("commit publish payload conflict: {error}"))?;
                    project_publish_execution_status(
                        &workspace,
                        &existing_execution_id,
                        true,
                    )?;
                    return Err("publish_idempotency_payload_conflict".to_string());
                }
                return Err("publish_item_already_exists".to_string());
            }
        }
        let provider_snapshot = provider_context.snapshot;
        let provider_snapshot_json = serde_json::to_string(&provider_snapshot)
            .map_err(|_| "publish_provider_snapshot_invalid".to_string())?;
        let confirmation_digest = confirmation_digest_of(
            &plan_id,
            plan_revision,
            budget,
            spend,
            &publish_start_at,
            &provider_snapshot_json,
            &prepared
                .iter()
                .map(PublishDigestItem::from_prepared)
                .collect::<Vec<_>>(),
        );
        let execution_hash = sha256_hex(format!("{plan_id}|{plan_revision}").as_bytes());
        let execution_id = format!("publish-execution-{}", &execution_hash[..24]);
        let operation_id = format!("publish-operation-{}", &execution_hash[..24]);
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        transaction
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES (?1, ?2, 'publish-awaiting-confirmation', ?3)",
                params![operation_id, session_id, now],
            )
            .map_err(|error| format!("create publish operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_publish_executions
                    (id, operation_id, created_by_session_id, distribution_plan_id,
                     distribution_plan_revision, status, revision, budget_cny,
                     estimated_spend_cny, publish_start_at, confirmation_digest,
                     provider_snapshot_json, confirmed_at, execution_started_at,
                     finished_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'awaiting-confirmation', 1, ?6, ?7,
                         ?8, ?9, ?10, NULL, NULL, NULL, ?11, ?11)",
                params![
                    execution_id,
                    operation_id,
                    session_id,
                    plan_id,
                    plan_revision,
                    budget,
                    spend,
                    publish_start_at,
                    confirmation_digest,
                    provider_snapshot_json,
                    now,
                ],
            )
            .map_err(|error| format!("create publish execution: {error}"))?;
        for item in &prepared {
            transaction
                .execute(
                    "INSERT INTO geo_publish_items
                        (id, execution_id, sequence, revision, article_id, approved_revision,
                         approved_body_sha256, approved_body_path, article_json, channel_json,
                         scheduled_at, scheduled_at_ms, status, idempotency_key,
                         external_request_sn, payload_hash,
                         object_key, object_url, external_order_id, external_content_id,
                         attempts, upload_attempts, next_attempt_at_ms, claim_token, lease_until_ms, started_at,
                         finished_at, request_summary_json, failure_code, failure_reason)
                     VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                             'pending', ?12, ?13, ?14, ?15, NULL, NULL, NULL, 0, 0, NULL,
                             NULL, NULL, NULL, NULL, ?16, NULL, NULL)",
                    params![
                        item.id,
                        execution_id,
                        item.sequence,
                        item.article.article_id,
                        item.article.approved_revision,
                        item.article.approved_body_sha256,
                        item.approved_body_path,
                        serde_json::to_string(&item.article)
                            .map_err(|_| "publish_article_snapshot_invalid".to_string())?,
                        serde_json::to_string(&item.channel)
                            .map_err(|_| "publish_channel_snapshot_invalid".to_string())?,
                        item.scheduled_at,
                        item.scheduled_at_ms,
                        item.idempotency_key,
                        item.external_request_sn,
                        item.payload_hash,
                        item.object_key,
                        serde_json::to_string(&item.request_summary)
                            .map_err(|_| "publish_request_summary_invalid".to_string())?,
                    ],
                )
                .map_err(|error| format!("create publish item: {error}"))?;
        }
        insert_audit(
            &transaction,
            &execution_id,
            None,
            "preview-created",
            Some(session_id),
            &json!({
                "distributionPlanId": plan_id,
                "distributionPlanRevision": plan_revision,
                "itemCount": prepared.len(),
                "estimatedSpendCny": spend,
                "budgetCny": budget,
                "confirmationDigest": confirmation_digest,
            }),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit publish execution preview: {error}"))?;
        let execution = read_execution(&connection, workspace_id, &execution_id)?;
        crate::notification::submit_publish_confirmation_required(
            workspace_id,
            session_id,
            &execution.operation_id,
            &execution.id,
            execution.revision,
        );
        Ok(execution)
    }

    pub fn confirm_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishConfirmRequest,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("confirm publish execution transaction: {error}"))?;
        let (revision, status, digest, provider_json): (i64, String, String, String) = transaction
            .query_row(
                "SELECT revision, status, confirmation_digest, provider_snapshot_json
                 FROM geo_publish_executions WHERE id=?1",
                [&request.execution_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("read publish confirmation target: {error}"))?
            .ok_or_else(|| "publish_execution_not_found".to_string())?;
        if status != "awaiting-confirmation" {
            return Err("publish_execution_already_immutable".to_string());
        }
        if revision != request.expected_revision || digest != request.confirmation_digest {
            return Err("publish_execution_confirmation_conflict".to_string());
        }
        let provider: PublishProviderSnapshot = serde_json::from_str(&provider_json)
            .map_err(|_| "publish_provider_snapshot_invalid".to_string())?;
        if !provider.object_storage.configured || !provider.distribution.configured {
            return Err("publish_provider_unavailable".to_string());
        }
        if provider != configured_provider_snapshot()? {
            return Err("publish_provider_configuration_changed".to_string());
        }
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let changed = transaction
            .execute(
                "UPDATE geo_publish_executions SET status='confirmed', revision=revision+1,
                 confirmed_at=?2, updated_at=?2 WHERE id=?1 AND revision=?3
                 AND status='awaiting-confirmation' AND confirmation_digest=?4",
                params![request.execution_id, now, revision, digest],
            )
            .map_err(|error| format!("confirm publish execution: {error}"))?;
        if changed != 1 {
            return Err("publish_execution_confirmation_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_operations SET state='publish-confirmed' WHERE id=(
                    SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                [&request.execution_id],
            )
            .map_err(|error| format!("confirm publish operation: {error}"))?;
        insert_audit(
            &transaction,
            &request.execution_id,
            None,
            "execution-confirmed",
            Some(session_id),
            &json!({"confirmationDigest": digest}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit publish confirmation: {error}"))?;
        read_execution(&connection, workspace_id, &request.execution_id)
    }

    /// 聊天修订（ADR 0003，票 38）：只作用于本 Session 创建、仍处于
    /// awaiting-confirmation 的执行；只允许调整预算、发布开始时间与逐项
    /// 排期。修订后重算确认摘要（旧摘要即刻失效，UI 确认必须重新核对新
    /// 摘要）、bump revision 并写 `revision` 审计（含用户指令原文）。
    /// 确认/开始/重试仍 exclusively 走 Rust UI 权威入口。
    pub fn revise_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishRevisionRequest,
    ) -> Result<PublishExecutionProjection, String> {
        if request.actor_id != "desktop-user" {
            return Err("publish_revision_actor_invalid".to_string());
        }
        if request.reason.trim().is_empty() {
            return Err("publish revision requires the user's explicit instruction".to_string());
        }
        let budget = match request.budget_cny {
            Some(value) if value.is_finite() && value >= 0.0 => Some(value),
            Some(_) => return Err("publish_budget_invalid".to_string()),
            None => None,
        };
        let publish_start_at = match request.publish_start_at.as_deref() {
            Some(value) => {
                parse_time(value, "publish_schedule_invalid")?;
                Some(value.trim().to_string())
            }
            None => None,
        };
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("revise publish execution transaction: {error}"))?;
        let (
            revision,
            status,
            owner_session_id,
            plan_id,
            plan_revision,
            current_budget,
            spend,
            current_start_at,
            provider_snapshot_json,
        ): (i64, String, String, String, i64, f64, f64, String, String) = transaction
            .query_row(
                "SELECT revision, status, created_by_session_id, distribution_plan_id,
                        distribution_plan_revision, budget_cny, estimated_spend_cny,
                        publish_start_at, provider_snapshot_json
                 FROM geo_publish_executions WHERE id=?1",
                [&request.execution_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read publish revision target: {error}"))?
            .ok_or_else(|| "publish_execution_not_found".to_string())?;
        if owner_session_id != session_id {
            return Err("publish_execution_session_mismatch".to_string());
        }
        if status != "awaiting-confirmation" {
            return Err("publish_execution_already_immutable".to_string());
        }
        if revision != request.expected_revision {
            return Err("publish_execution_revision_conflict".to_string());
        }
        let next_budget = budget.unwrap_or(current_budget);
        if spend > next_budget + 0.000_001 {
            return Err("publish_budget_exceeded".to_string());
        }
        let next_start_at = publish_start_at.clone().unwrap_or(current_start_at);
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

        // 逐项排期修订：先按 item id 校验归属与时间合法性。
        let mut schedule_by_item: std::collections::HashMap<String, (String, i64)> =
            std::collections::HashMap::new();
        for update in &request.item_updates {
            if update.item_id.trim().is_empty() {
                return Err("publish_revision_item_invalid".to_string());
            }
            let scheduled_at_ms =
                parse_time(update.scheduled_at.trim(), "publish_schedule_invalid")?;
            let exists: Option<i64> = transaction
                .query_row(
                    "SELECT sequence FROM geo_publish_items
                     WHERE id=?1 AND execution_id=?2 AND status='pending'",
                    params![update.item_id, request.execution_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("read publish revision item: {error}"))?;
            if exists.is_none() {
                return Err("publish_revision_item_not_found".to_string());
            }
            schedule_by_item.insert(
                update.item_id.trim().to_string(),
                (update.scheduled_at.trim().to_string(), scheduled_at_ms),
            );
        }

        // 读取全部条目快照，按新排期重算确认摘要输入。
        let mut statement = transaction
            .prepare(
                "SELECT item.id, item.article_id, item.approved_revision,
                        item.approved_body_sha256, item.channel_json,
                        item.scheduled_at, item.payload_hash, item.request_summary_json
                 FROM geo_publish_items item
                 WHERE item.execution_id=?1 ORDER BY item.sequence",
            )
            .map_err(|error| format!("read publish revision items: {error}"))?;
        let rows = statement
            .query_map([&request.execution_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|error| format!("read publish revision items: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read publish revision items: {error}"))?;
        drop(statement);

        let mut digest_items: Vec<PublishDigestItem> = Vec::with_capacity(rows.len());
        // 排期应用复用读取时的请求摘要快照（此刻行尚未被本次事务修改）。
        let mut summary_by_item: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for (
            item_id,
            article_id,
            approved_revision,
            approved_body_sha256,
            channel_json,
            scheduled_at,
            payload_hash,
            summary_json,
        ) in &rows
        {
            summary_by_item.insert(item_id.clone(), summary_json.clone());
            let channel: Value = serde_json::from_str(channel_json)
                .map_err(|_| "publish_channel_snapshot_invalid".to_string())?;
            let read_f64 = |key: &str| {
                channel
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .ok_or_else(|| "publish_channel_snapshot_invalid".to_string())
            };
            digest_items.push(PublishDigestItem {
                article_id: article_id.clone(),
                approved_revision: *approved_revision,
                approved_body_sha256: approved_body_sha256.clone(),
                resource_id: channel
                    .get("resourceId")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| "publish_channel_snapshot_invalid".to_string())?,
                kind: channel
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "publish_channel_snapshot_invalid".to_string())?
                    .to_string(),
                name: channel
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "publish_channel_snapshot_invalid".to_string())?
                    .to_string(),
                estimated_price_cny: read_f64("estimatedPriceCny")?,
                published_rate: read_f64("publishedRate")?,
                scheduled_at: schedule_by_item
                    .get(item_id)
                    .map(|(scheduled_at, _)| scheduled_at.clone())
                    .unwrap_or_else(|| scheduled_at.clone()),
                payload_hash: payload_hash.clone(),
            });
        }
        let confirmation_digest = confirmation_digest_of(
            &plan_id,
            plan_revision,
            next_budget,
            spend,
            &next_start_at,
            &provider_snapshot_json,
            &digest_items,
        );

        // 应用逐项排期：排期列、毫秒列与请求摘要中的 scheduledAt 同步更新。
        for (item_id, (scheduled_at, scheduled_at_ms)) in &schedule_by_item {
            let raw_summary = summary_by_item
                .get(item_id)
                .ok_or_else(|| "publish_revision_item_not_found".to_string())?;
            let mut summary: Value = serde_json::from_str(raw_summary)
                .map_err(|_| "publish_request_summary_invalid".to_string())?;
            summary
                .as_object_mut()
                .ok_or_else(|| "publish_request_summary_invalid".to_string())?
                .insert("scheduledAt".to_string(), json!(scheduled_at));
            let summary_json = serde_json::to_string(&summary)
                .map_err(|_| "publish_request_summary_invalid".to_string())?;
            let changed = transaction
                .execute(
                    "UPDATE geo_publish_items SET scheduled_at=?2, scheduled_at_ms=?3,
                            request_summary_json=?4
                     WHERE id=?1 AND execution_id=?5 AND status='pending'",
                    params![
                        item_id,
                        scheduled_at,
                        scheduled_at_ms,
                        summary_json,
                        request.execution_id,
                    ],
                )
                .map_err(|error| format!("apply publish item schedule: {error}"))?;
            if changed != 1 {
                return Err("publish_revision_item_not_found".to_string());
            }
        }
        let next_revision = revision + 1;
        let changed = transaction
            .execute(
                "UPDATE geo_publish_executions SET budget_cny=?2, publish_start_at=?3,
                        confirmation_digest=?4, revision=?5, updated_at=?6
                 WHERE id=?1 AND revision=?7 AND status='awaiting-confirmation'",
                params![
                    request.execution_id,
                    next_budget,
                    next_start_at,
                    confirmation_digest,
                    next_revision,
                    now,
                    revision
                ],
            )
            .map_err(|error| format!("apply publish revision: {error}"))?;
        if changed != 1 {
            return Err("publish_execution_revision_conflict".to_string());
        }
        insert_audit(
            &transaction,
            &request.execution_id,
            None,
            "revision",
            Some(session_id),
            &json!({
                "reason": request.reason,
                "budgetCny": budget,
                "publishStartAt": publish_start_at,
                "itemUpdates": request.item_updates,
            }),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit publish revision: {error}"))?;
        read_execution(&connection, workspace_id, &request.execution_id)
    }

    pub fn start_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishStartRequest,
        now_ms: i64,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start publish execution transaction: {error}"))?;
        let (revision, status): (i64, String) = transaction
            .query_row(
                "SELECT revision, status FROM geo_publish_executions WHERE id=?1",
                [&request.execution_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read publish start target: {error}"))?
            .ok_or_else(|| "publish_execution_not_found".to_string())?;
        if revision != request.expected_revision {
            return Err("publish_execution_revision_conflict".to_string());
        }
        if status != "confirmed" {
            return Err("publish_execution_not_startable".to_string());
        }
        let due: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM geo_publish_items
                 WHERE execution_id=?1 AND scheduled_at_ms<=?2)",
                params![request.execution_id, now_ms],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect publish due state: {error}"))?;
        let next_status = if due { "running" } else { "scheduled" };
        let now = now_iso(now_ms);
        let changed = transaction
            .execute(
                "UPDATE geo_publish_executions SET status=?2, revision=revision+1,
                 execution_started_at=?3, updated_at=?3
                 WHERE id=?1 AND revision=?4 AND status='confirmed'",
                params![request.execution_id, next_status, now, revision],
            )
            .map_err(|error| format!("start publish execution: {error}"))?;
        if changed != 1 {
            return Err("publish_execution_revision_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_operations SET state='publish-executing' WHERE id=(
                    SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                [&request.execution_id],
            )
            .map_err(|error| format!("start publish operation: {error}"))?;
        insert_audit(
            &transaction,
            &request.execution_id,
            None,
            "execution-started",
            Some(session_id),
            &json!({"dueNow": due}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit publish start: {error}"))?;
        read_execution(&connection, workspace_id, &request.execution_id)
    }

    /// 「重新发布」通道（2026-09 产品语义）：failed-retryable 清退避立即
    /// 重试（原行为不变）；failed-nonretryable / cancelled（以及取消执行里
    /// 卡在 uploaded 的孤儿在途单）整单重置回 pending（计数清零、清失败
    /// 字段与 finished_at，保留 object_url——已上传过的直接由认领逻辑分到
    /// 下单阶段）。执行侧：cancelled 复活为 scheduled；终态
    /// （partially-succeeded/failed）清 finished_at 并由 refresh 重算回活跃。
    /// reconciliation-required 不并入（对账语义归 resume_reconciled_execution
    /// 通道）。
    pub fn retry_publish_item(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishRetryRequest,
        now_ms: i64,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("retry publish item transaction: {error}"))?;
        let (revision, status, attempts): (i64, String, i64) = transaction
            .query_row(
                "SELECT revision, status, attempts FROM geo_publish_items
                 WHERE id=?1 AND execution_id=?2",
                params![request.item_id, request.execution_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read publish retry target: {error}"))?
            .ok_or_else(|| "publish_item_not_found".to_string())?;
        let execution_status: String = transaction
            .query_row(
                "SELECT status FROM geo_publish_executions WHERE id=?1",
                params![request.execution_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("read publish retry execution: {error}"))?;
        if revision != request.expected_item_revision {
            return Err("publish_item_revision_conflict".to_string());
        }
        // 「uploaded 仅在执行已取消时可复活」：活跃执行里的 uploaded 是
        // 管线中段（等待下单认领），不是失败；只有取消执行里它才成了
        // 孤儿（在途上传在取消后才落库，永远等不到下单认领）。
        let reset_eligible = matches!(status.as_str(), "failed-nonretryable" | "cancelled")
            || (status.as_str() == "uploaded" && execution_status == "cancelled");
        match status.as_str() {
            "failed-retryable" => {
                if attempts > RETRY_BACKOFF_MS.len() as i64 {
                    return Err("publish_item_not_safely_retryable".to_string());
                }
                let changed = transaction
                    .execute(
                        "UPDATE geo_publish_items SET next_attempt_at_ms=?3, revision=revision+1,
                         failure_code=NULL, failure_reason=NULL
                         WHERE id=?1 AND execution_id=?2 AND revision=?4 AND status='failed-retryable'",
                        params![request.item_id, request.execution_id, now_ms, revision],
                    )
                    .map_err(|error| format!("schedule publish item retry: {error}"))?;
                if changed != 1 {
                    return Err("publish_item_revision_conflict".to_string());
                }
            }
            "failed-nonretryable" | "cancelled" | "uploaded" if reset_eligible => {
                let changed = transaction
                    .execute(
                        "UPDATE geo_publish_items SET status='pending', attempts=0,
                         upload_attempts=0, next_attempt_at_ms=?3, revision=revision+1,
                         failure_code=NULL, failure_reason=NULL, finished_at=NULL,
                         claim_token=NULL, lease_until_ms=NULL
                         WHERE id=?1 AND execution_id=?2 AND revision=?4
                           AND status IN ('failed-nonretryable','cancelled','uploaded')",
                        params![request.item_id, request.execution_id, now_ms, revision],
                    )
                    .map_err(|error| format!("republish publish item: {error}"))?;
                if changed != 1 {
                    return Err("publish_item_revision_conflict".to_string());
                }
            }
            _ => return Err("publish_item_not_safely_retryable".to_string()),
        }
        let now = now_iso(now_ms);
        // 执行级联动：取消态复活为 scheduled；终态执行清 finished_at（状态
        // 标签由提交后的 refresh 重算回活跃）。
        let revived = transaction
            .execute(
                "UPDATE geo_publish_executions SET status='scheduled', revision=revision+1,
                 finished_at=NULL, updated_at=?2
                 WHERE id=?1 AND status='cancelled'",
                params![request.execution_id, now],
            )
            .map_err(|error| format!("revive cancelled publish execution: {error}"))?;
        if revived == 1 {
            insert_audit(
                &transaction,
                &request.execution_id,
                None,
                "execution-revived",
                Some(session_id),
                &json!({"itemId": request.item_id}),
                &now,
            )?;
            transaction
                .execute(
                    "UPDATE geo_operations SET state='publish-scheduled' WHERE id=(
                        SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                    params![request.execution_id],
                )
                .map_err(|error| format!("mirror revived publish operation: {error}"))?;
        }
        transaction
            .execute(
                "UPDATE geo_publish_executions SET finished_at=NULL
                 WHERE id=?1 AND finished_at IS NOT NULL
                   AND status IN ('partially-succeeded','failed')",
                params![request.execution_id],
            )
            .map_err(|error| format!("clear finished publish execution: {error}"))?;
        insert_audit(
            &transaction,
            &request.execution_id,
            Some(&request.item_id),
            "republish-requested",
            Some(session_id),
            &json!({"fromStatus": status, "attempts": attempts}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit publish item retry: {error}"))?;
        refresh_execution_status(&workspace, &request.execution_id, now_ms)?;
        read_execution(&connection, workspace_id, &request.execution_id)
    }

    /// 取消发布：把执行置为终态 cancelled，未完结条目（pending/
    /// failed-retryable/failed-nonretryable/uploaded）批量转 cancelled 不再
    /// 发出；在途条目（uploading/submitting，持有 claim_token）不动——其
    /// settle 的 UPDATE 带 claim_token 守卫照常落库，本次尝试可能产生一笔
    /// 真实订单（与用户确认的取消语义一致）。refresh_execution_status 对
    /// cancelled 执行跳过重算（选择 SQL 与 UPDATE 守卫均排除），在途单
    /// settle 后不会把取消态倒灌回 running。
    pub fn cancel_publish_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishCancelRequest,
        now_ms: i64,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("cancel publish execution transaction: {error}"))?;
        let (revision, status): (i64, String) = transaction
            .query_row(
                "SELECT revision, status FROM geo_publish_executions WHERE id=?1",
                [&request.execution_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read cancel publish execution: {error}"))?
            .ok_or_else(|| "publish_execution_not_found".to_string())?;
        if revision != request.expected_revision {
            return Err("publish_execution_revision_conflict".to_string());
        }
        if !matches!(
            status.as_str(),
            "running" | "scheduled" | "partially-succeeded" | "failed"
        ) {
            return Err("publish_execution_not_cancellable".to_string());
        }
        let cancelled_items = transaction
            .execute(
                "UPDATE geo_publish_items SET status='cancelled', revision=revision+1,
                 next_attempt_at_ms=NULL, claim_token=NULL, lease_until_ms=NULL,
                 failure_code=NULL, failure_reason=NULL, finished_at=?2
                 WHERE execution_id=?1
                   AND status IN ('pending','failed-retryable','failed-nonretryable','uploaded')",
                params![request.execution_id, now_iso(now_ms)],
            )
            .map_err(|error| format!("cancel publish items: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_publish_executions SET status='cancelled', revision=revision+1,
                 finished_at=?2, updated_at=?2
                 WHERE id=?1 AND revision=?3
                   AND status IN ('running','scheduled','partially-succeeded','failed')",
                params![request.execution_id, now_iso(now_ms), revision],
            )
            .map_err(|error| format!("cancel publish execution: {error}"))?;
        if changed != 1 {
            return Err("publish_execution_revision_conflict".to_string());
        }
        let now = now_iso(now_ms);
        transaction
            .execute(
                "UPDATE geo_operations SET state='publish-cancelled' WHERE id=(
                    SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                params![request.execution_id],
            )
            .map_err(|error| format!("mirror cancelled publish operation: {error}"))?;
        insert_audit(
            &transaction,
            &request.execution_id,
            None,
            "execution-cancelled",
            Some(session_id),
            &json!({"cancelledItems": cancelled_items}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit publish execution cancel: {error}"))?;
        read_execution(&connection, workspace_id, &request.execution_id)
    }

    /// 对账恢复通道（票 40 事故复盘）：Provider 巡检误判 / 登录态抖动把从未
    /// 提交的执行 brick 成 reconciliation-required 后，`retry_publish_item`
    /// 只接 failed-retryable，没有任何通道能把它交还给调度器。本函数在
    /// 用户确认登录态与渠道配置一致时，把从未提交的 reconciliation-required
    /// 条目回置到认领前阶段，让执行重新进入调度。
    ///
    /// 口径：只接执行状态 reconciliation-required。`refresh_execution_status`
    /// 保证任一条目为 reconciliation-required 时执行投影必为
    /// reconciliation-required（优先级最高），因此「failed 且含
    /// reconciliation-required 条目」在现行投影不变量下不可达，不再单列。
    ///
    /// 保守边界：任一条目已有 external_order_id（已提交/已扣点，存在外部
    /// 副作用）→ 整个执行拒绝恢复——已提交项的结果核对必须走查单对账
    /// （renderer 订单投影 / 人工），不在本通道的「从未提交」前提之内。
    pub fn resume_reconciled_execution(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PublishStartRequest,
        now_ms: i64,
    ) -> Result<PublishExecutionProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("resume reconciled execution transaction: {error}"))?;
        let (revision, status, provider_json): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, status, provider_snapshot_json
                 FROM geo_publish_executions WHERE id=?1",
                [&request.execution_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read reconciled execution: {error}"))?
            .ok_or_else(|| "publish_execution_not_found".to_string())?;
        if revision != request.expected_revision {
            return Err("publish_execution_revision_conflict".to_string());
        }
        if status != "reconciliation-required" {
            return Err("publish_execution_not_resumable".to_string());
        }
        // 安全闸一：当前必须已登录（两槽位都 configured，拿得到网关指纹），
        // 未登录时无法证明「配置没变」，拒绝恢复。
        let current = configured_provider_snapshot()?;
        if !current.object_storage.configured || !current.distribution.configured {
            return Err("publish_provider_unavailable".to_string());
        }
        // 安全闸二：冻结快照与当前快照构成真实配置变化（双方都 configured
        // 且指纹不同）时，旧幂等键不得复活。
        let frozen: PublishProviderSnapshot = serde_json::from_str(&provider_json)
            .map_err(|_| "publish_provider_snapshot_invalid".to_string())?;
        if provider_configuration_changed(&frozen, &current) {
            return Err("publish_provider_configuration_changed".to_string());
        }
        // 安全闸三：任一条目已有 external_order_id → 存在外部副作用，整单
        // 拒绝（保守：已提交项走查单对账，不在本通道）。
        let has_submitted: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM geo_publish_items
                 WHERE execution_id=?1 AND external_order_id IS NOT NULL)",
                [&request.execution_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect reconciled submitted items: {error}"))?;
        if has_submitted {
            return Err("publish_execution_has_submitted_items".to_string());
        }
        let now = now_iso(now_ms);
        // 只回置从未提交的 reconciliation-required 条目：按认领前阶段
        // （上传阶段→pending；提交阶段→uploaded，与 claim_next_item 的
        // object_url 判段一致），清失败信息并把 next_attempt 拉到 now，
        // 让调度器立即可重新认领；claim 租约一并清空（巡检 settle 时已清，
        // 这里防御性再清一次）。
        let resumed_items = transaction
            .execute(
                "UPDATE geo_publish_items SET
                    status=CASE WHEN object_url IS NULL THEN 'pending' ELSE 'uploaded' END,
                    revision=revision+1, failure_code=NULL, failure_reason=NULL,
                    next_attempt_at_ms=?2, finished_at=NULL,
                    claim_token=NULL, lease_until_ms=NULL
                 WHERE execution_id=?1 AND status='reconciliation-required'
                   AND external_order_id IS NULL",
                params![request.execution_id, now_ms],
            )
            .map_err(|error| format!("resume reconciled publish items: {error}"))?;
        if resumed_items == 0 {
            return Err("publish_execution_not_resumable".to_string());
        }
        let changed = transaction
            .execute(
                "UPDATE geo_publish_executions SET status='scheduled', revision=revision+1,
                 finished_at=NULL, updated_at=?2
                 WHERE id=?1 AND revision=?3 AND status='reconciliation-required'",
                params![request.execution_id, now, revision],
            )
            .map_err(|error| format!("resume reconciled execution: {error}"))?;
        if changed != 1 {
            return Err("publish_execution_revision_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_operations SET state='publish-scheduled' WHERE id=(
                    SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
                [&request.execution_id],
            )
            .map_err(|error| format!("resume reconciled operation: {error}"))?;
        insert_audit(
            &transaction,
            &request.execution_id,
            None,
            "reconciliation-resumed",
            Some(session_id),
            &json!({"resumedItems": resumed_items}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit reconciled execution resume: {error}"))?;
        read_execution(&connection, workspace_id, &request.execution_id)
    }
}

fn read_execution(
    connection: &Connection,
    workspace_id: &str,
    execution_id: &str,
) -> Result<PublishExecutionProjection, String> {
    let mut execution = connection
        .query_row(
            "SELECT id, operation_id, created_by_session_id, distribution_plan_id,
                    distribution_plan_revision, revision, status, budget_cny,
                    estimated_spend_cny, publish_start_at, confirmation_digest,
                    provider_snapshot_json, confirmed_at, execution_started_at,
                    finished_at, created_at, updated_at
             FROM geo_publish_executions WHERE id=?1",
            [execution_id],
            |row| {
                let provider_json: String = row.get(11)?;
                let provider_snapshot = serde_json::from_str(&provider_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        provider_json.len(),
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(PublishExecutionProjection {
                    id: row.get(0)?,
                    operation_id: row.get(1)?,
                    workspace_id: workspace_id.to_string(),
                    created_by_session_id: row.get(2)?,
                    distribution_plan_id: row.get(3)?,
                    distribution_plan_revision: row.get(4)?,
                    policy_version: POLICY_VERSION,
                    revision: row.get(5)?,
                    status: row.get(6)?,
                    budget_cny: row.get(7)?,
                    estimated_spend_cny: row.get(8)?,
                    // 占位 0，条目装载后按逐项单价重算（见函数尾）。
                    total_price_points: 0,
                    publish_start_at: row.get(9)?,
                    irreversible_impact: IRREVERSIBLE_IMPACT,
                    confirmation_digest: row.get(10)?,
                    provider_snapshot,
                    items: Vec::new(),
                    confirmed_at: row.get(12)?,
                    execution_started_at: row.get(13)?,
                    finished_at: row.get(14)?,
                    created_at: row.get(15)?,
                    updated_at: row.get(16)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read publish execution: {error}"))?
        .ok_or_else(|| "publish_execution_not_found".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id, revision, sequence, article_json, channel_json, scheduled_at,
                    status, idempotency_key, COALESCE(external_request_sn, id), payload_hash,
                    object_key, object_url,
                    external_order_id, external_content_id, attempts, upload_attempts, next_attempt_at_ms,
                    started_at, finished_at, request_summary_json, failure_code, failure_reason
             FROM geo_publish_items WHERE execution_id=?1 ORDER BY sequence ASC",
        )
        .map_err(|error| format!("prepare publish items: {error}"))?;
    execution.items = statement
        .query_map([execution_id], |row| {
            let article_json: String = row.get(3)?;
            let channel_json: String = row.get(4)?;
            let request_json: String = row.get(19)?;
            let article = serde_json::from_str(&article_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    article_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let channel = serde_json::from_str(&channel_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    channel_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let request_summary = serde_json::from_str(&request_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    request_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let next_attempt_ms: Option<i64> = row.get(16)?;
            Ok(PublishItemProjection {
                id: row.get(0)?,
                revision: row.get(1)?,
                sequence: row.get(2)?,
                article,
                channel,
                scheduled_at: row.get(5)?,
                status: row.get(6)?,
                idempotency_key: row.get(7)?,
                external_request_sn: row.get(8)?,
                payload_hash: row.get(9)?,
                object_key: row.get(10)?,
                object_url: row.get(11)?,
                external_order_id: row.get(12)?,
                external_content_id: row.get(13)?,
                attempts: row.get(14)?,
                upload_attempts: row.get(15)?,
                next_attempt_at: next_attempt_ms.map(now_iso),
                started_at: row.get(17)?,
                finished_at: row.get(18)?,
                request_summary,
                failure_code: row.get(20)?,
                failure_reason: row.get(21)?,
            })
        })
        .map_err(|error| format!("read publish items: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("collect publish items: {error}"))?;
    // 票 09：单价在投影时按快照媒介价重算（同一确定性函数），旧快照行
    // 缺字段也能得到权威点数；总价为逐项之和，不落库。
    let mut total_price_points = 0_i64;
    for item in &mut execution.items {
        item.channel.price_points = publish_channel_price_points(item.channel.estimated_price_cny);
        total_price_points += item.channel.price_points;
    }
    execution.total_price_points = total_price_points;
    Ok(execution)
}

fn insert_audit(
    connection: &Connection,
    execution_id: &str,
    item_id: Option<&str>,
    event_type: &str,
    actor_session_id: Option<&str>,
    detail: &Value,
    created_at: &str,
) -> Result<(), String> {
    let encoded =
        serde_json::to_string(detail).map_err(|_| "publish_audit_detail_invalid".to_string())?;
    if encoded.len() > 8 * 1024 {
        return Err("publish_audit_detail_too_large".to_string());
    }
    connection
        .execute(
            "INSERT INTO geo_publish_audit
                (execution_id, item_id, event_type, actor_session_id, detail_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                execution_id,
                item_id,
                event_type,
                actor_session_id,
                encoded,
                created_at
            ],
        )
        .map_err(|error| format!("persist publish audit: {error}"))?;
    Ok(())
}

/// Routing context for one publish egress call through the execution's source
/// Session Sidecar（票 08：Provider 传输切网关 port）。Rust 传
/// executionId + itemId，下单幂等 sn 由 Sidecar 按
/// `distributionOrderSn(executionId, itemId)` 派生——sn 单一权威不在 Rust。
#[derive(Debug, Clone)]
pub(crate) struct PublishEgressRoute {
    workspace_id: String,
    workspace_root: std::path::PathBuf,
    session_id: String,
    execution_id: String,
    item_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishUploadRequest {
    route: PublishEgressRoute,
    object_key: String,
    body: Vec<u8>,
    expected_configuration_fingerprint: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishUploadReceipt {
    object_url: String,
    external_content_id: String,
}

/// 发布配图对象（票 #15，ADR-0008 D4）：字节从材料图片资产读回，
/// sha256 为资产存储哈希（Sidecar 路由与实测互校），objectKey 由
/// capability 按字节内容寻址派生（images/ 层、公共读）。
#[derive(Debug, Clone)]
pub(crate) struct PublishImageUpload {
    image_id: String,
    sha256: String,
    media_type: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishImageUploadRequest {
    route: PublishEgressRoute,
    images: Vec<PublishImageUpload>,
    expected_configuration_fingerprint: String,
}

/// imageId → 图片对象绝对公网 URL（供渲染侧占位符替换）。
#[derive(Debug, Clone, Default)]
pub(crate) struct PublishImageUploadReceipt {
    urls: HashMap<String, String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishOrderRequest {
    route: PublishEgressRoute,
    per_article_max_points: i64,
    execution_max_points: i64,
    kind: String,
    resource_id: i64,
    title: String,
    content_url: String,
    expected_configuration_fingerprint: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PublishOrderReceipt {
    external_order_id: String,
}

#[derive(Debug, Clone)]
pub(crate) enum PublishProviderOutcome<T> {
    Success(T),
    SafeRetryable { code: String, reason: String },
    NonRetryable { code: String, reason: String },
    Unknown { code: String, reason: String },
}

type ProviderFuture<'a, T> = Pin<Box<dyn Future<Output = PublishProviderOutcome<T>> + Send + 'a>>;

pub(crate) trait PublishProvider: Send + Sync {
    fn upload<'a>(
        &'a self,
        request: PublishUploadRequest,
    ) -> ProviderFuture<'a, PublishUploadReceipt>;
    /// 配图对象批量上传（票 #15）：先于 HTML 上传执行——渲染侧要拿回
    /// 公网 URL 才能做占位符替换。键为 sha256 内容寻址，重放幂等。
    fn upload_images<'a>(
        &'a self,
        request: PublishImageUploadRequest,
    ) -> ProviderFuture<'a, PublishImageUploadReceipt>;
    fn submit<'a>(
        &'a self,
        request: PublishOrderRequest,
    ) -> ProviderFuture<'a, PublishOrderReceipt>;
}

const PUBLISH_EGRESS_HTTP_TIMEOUT: Duration = Duration::from_secs(120);

/// Why a localhost Sidecar egress call failed before producing a typed egress
/// outcome envelope.
#[derive(Debug)]
enum SidecarCallFailure {
    /// The request never left this machine (no app owner, Sidecar ensure
    /// failed, client build or connection refused) — nothing was submitted.
    Unreachable(String),
    /// The request may have been delivered but no usable envelope came back
    /// (timeout, non-success control-plane status, malformed envelope).
    Indeterminate(String),
}

fn bounded_reason(value: String) -> String {
    value.chars().take(300).collect()
}

/// Attach the execution's source Session Sidecar（`PublishExecutor` owner，
/// 同监测调度器模式），POST the egress payload to its localhost control-plane
/// route, then always release the owner. Only the typed `result` of a success
/// envelope is returned; every other failure is classified into
/// [`SidecarCallFailure`].
async fn call_publish_egress_sidecar(
    route: &PublishEgressRoute,
    endpoint: &str,
    payload: Value,
) -> Result<Value, SidecarCallFailure> {
    let app = crate::logger::get_app_handle().cloned().ok_or_else(|| {
        SidecarCallFailure::Unreachable("应用生命周期 owner 尚未就绪".to_string())
    })?;
    let manager = app
        .try_state::<crate::sidecar::ManagedSidecarManager>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| {
            SidecarCallFailure::Unreachable("Session Sidecar 管理器不可用".to_string())
        })?;
    let owner = crate::sidecar::SidecarOwner::PublishExecutor(route.execution_id.clone());
    let ensure = crate::sidecar::ensure_session_sidecar_with_lifecycle(
        app.clone(),
        manager.clone(),
        route.session_id.clone(),
        route.workspace_root.clone(),
        owner.clone(),
    )
    .await
    .map_err(|error| {
        SidecarCallFailure::Unreachable(bounded_reason(format!("Sidecar 附着失败：{error}")))
    })?;
    // 发布执行器附着后附当前新鲜账号 token：Sidecar 已长跑数小时时
    // admission env token 早已过期，请求级 token（临期自动 refresh）才是
    // 网关调用的有效凭据；未登录不附头，Sidecar 回退 env。
    let account_token = crate::account_auth::fresh_account_access_token().await;
    let request_result = post_egress_envelope(
        ensure.port,
        endpoint,
        egress_body(route, payload),
        account_token.as_deref(),
    )
    .await;
    if let Err(error) = crate::sidecar::release_session_sidecar(&manager, &route.session_id, &owner)
    {
        crate::ulog_warn!(
            "[publish-scheduler] release egress Sidecar owner execution={}: {}",
            route.execution_id,
            bounded_reason(error)
        );
    }
    request_result
}

fn egress_body(route: &PublishEgressRoute, payload: Value) -> Value {
    let mut body = payload.as_object().cloned().unwrap_or_default();
    body.insert(
        "workspaceId".to_string(),
        Value::String(route.workspace_id.clone()),
    );
    body.insert(
        "sessionId".to_string(),
        Value::String(route.session_id.clone()),
    );
    Value::Object(body)
}

/// POST one egress payload to the already-attached Sidecar's localhost
/// control-plane route and extract the typed `result` of a success envelope.
/// Separated from the attach/release lifecycle so the transport mapping is
/// deterministically testable against a local mock-sidecar listener.
/// `account_token` 是请求级新鲜账号 token（Some 时附
/// `x-xiaojing-account-token` 头，Sidecar 优先于 admission env 使用）。
async fn post_egress_envelope(
    port: u16,
    endpoint: &str,
    body: Value,
    account_token: Option<&str>,
) -> Result<Value, SidecarCallFailure> {
    let client = crate::local_http::builder()
        .timeout(PUBLISH_EGRESS_HTTP_TIMEOUT)
        .build()
        .map_err(|error| {
            SidecarCallFailure::Unreachable(bounded_reason(format!("客户端构建失败：{error}")))
        })?;
    let mut request = client
        .post(format!("http://127.0.0.1:{port}{endpoint}"))
        .json(&body);
    if let Some(token) = account_token {
        request = request.header(crate::account_auth::ACCOUNT_TOKEN_HEADER, token);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_connect() || error.is_request() {
            SidecarCallFailure::Unreachable(bounded_reason(error.to_string()))
        } else {
            SidecarCallFailure::Indeterminate(bounded_reason(error.to_string()))
        }
    })?;
    let status = response.status();
    let envelope = response
        .json::<Value>()
        .await
        .map_err(|error| SidecarCallFailure::Indeterminate(bounded_reason(error.to_string())))?;
    if !status.is_success() || envelope.get("success").and_then(Value::as_bool) != Some(true) {
        // 响应体的 error 码（如 publish_egress_upload_images_too_many）是
        // 排障的第一信号：载荷校验类确定性 400 若只报 HTTP 状态，会被当成
        // 传输故障无限退避重试（2026-09-01 事故里排障只能靠翻三层代码）。
        let detail = envelope
            .get("error")
            .and_then(Value::as_str)
            .filter(|code| !code.trim().is_empty())
            .map(|code| format!("，{code}"))
            .unwrap_or_default();
        return Err(SidecarCallFailure::Indeterminate(bounded_reason(format!(
            "Sidecar 控制面响应失败（HTTP {}{}）",
            status.as_u16(),
            detail
        ))));
    }
    envelope
        .get("result")
        .cloned()
        .ok_or_else(|| SidecarCallFailure::Indeterminate("Sidecar 响应 result 缺失".to_string()))
}

fn egress_outcome_kind(value: &Value) -> Option<&'static str> {
    value
        .get("outcome")
        .and_then(Value::as_str)
        .and_then(|kind| match kind {
            "success" => Some("success"),
            "safe-retryable" => Some("safe-retryable"),
            "non-retryable" => Some("non-retryable"),
            "unknown" => Some("unknown"),
            _ => None,
        })
}

fn egress_failure_fields(value: &Value) -> (String, String) {
    (
        value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("egress-classification-missing")
            .to_string(),
        value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("发布出口未返回失败详情")
            .to_string(),
    )
}

fn parse_upload_egress_result(value: &Value) -> PublishProviderOutcome<PublishUploadReceipt> {
    match egress_outcome_kind(value) {
        Some("success") => {
            let object_url = value
                .get("objectUrl")
                .and_then(Value::as_str)
                .filter(|url| !url.trim().is_empty());
            let external_content_id = value
                .get("externalContentId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty());
            match (object_url, external_content_id) {
                (Some(object_url), Some(external_content_id)) => {
                    PublishProviderOutcome::Success(PublishUploadReceipt {
                        object_url: object_url.to_string(),
                        external_content_id: external_content_id.to_string(),
                    })
                }
                _ => PublishProviderOutcome::SafeRetryable {
                    code: "object-storage-response-invalid".to_string(),
                    reason: "上传回执缺少对象 URL，可安全重试稳定对象键".to_string(),
                },
            }
        }
        Some("safe-retryable") | Some("non-retryable") | Some("unknown") => {
            let (code, reason) = egress_failure_fields(value);
            match egress_outcome_kind(value) {
                Some("safe-retryable") => PublishProviderOutcome::SafeRetryable { code, reason },
                Some("non-retryable") => PublishProviderOutcome::NonRetryable { code, reason },
                _ => PublishProviderOutcome::Unknown { code, reason },
            }
        }
        _ => PublishProviderOutcome::SafeRetryable {
            code: "object-storage-response-invalid".to_string(),
            reason: "上传出口响应不可解析，可安全重试稳定对象键".to_string(),
        },
    }
}

/// 配图上传回执解析（票 #15）：成功信封必须带非空 images 数组且每条
/// 都有 imageId + url（按 id 映射回渲染侧）；缺失即响应不可解析——键是
/// sha256 内容寻址，重放同一 PUT 即可纠正，安全重试。
fn parse_image_upload_egress_result(
    value: &Value,
) -> PublishProviderOutcome<PublishImageUploadReceipt> {
    match egress_outcome_kind(value) {
        Some("success") => {
            let Some(entries) = value.get("images").and_then(Value::as_array) else {
                return PublishProviderOutcome::SafeRetryable {
                    code: "object-storage-response-invalid".to_string(),
                    reason: "配图上传回执缺少图片清单，可安全重试内容寻址键".to_string(),
                };
            };
            let mut urls = HashMap::with_capacity(entries.len());
            for entry in entries {
                let image_id = entry.get("imageId").and_then(Value::as_str);
                let url = entry.get("url").and_then(Value::as_str);
                match (image_id, url) {
                    (Some(image_id), Some(url))
                        if !image_id.trim().is_empty() && !url.trim().is_empty() =>
                    {
                        urls.insert(image_id.to_string(), url.to_string());
                    }
                    _ => {
                        return PublishProviderOutcome::SafeRetryable {
                            code: "object-storage-response-invalid".to_string(),
                            reason: "配图上传回执缺少图片 URL，可安全重试内容寻址键".to_string(),
                        };
                    }
                }
            }
            PublishProviderOutcome::Success(PublishImageUploadReceipt { urls })
        }
        Some("safe-retryable") | Some("non-retryable") | Some("unknown") => {
            let (code, reason) = egress_failure_fields(value);
            match egress_outcome_kind(value) {
                Some("safe-retryable") => PublishProviderOutcome::SafeRetryable { code, reason },
                Some("non-retryable") => PublishProviderOutcome::NonRetryable { code, reason },
                _ => PublishProviderOutcome::Unknown { code, reason },
            }
        }
        _ => PublishProviderOutcome::SafeRetryable {
            code: "object-storage-response-invalid".to_string(),
            reason: "配图上传出口响应不可解析，可安全重试内容寻址键".to_string(),
        },
    }
}

fn parse_order_egress_result(value: &Value) -> PublishProviderOutcome<PublishOrderReceipt> {
    match egress_outcome_kind(value) {
        Some("success") => {
            let external_order_id = value
                .get("externalOrderId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty());
            match external_order_id {
                Some(external_order_id) => PublishProviderOutcome::Success(PublishOrderReceipt {
                    external_order_id: external_order_id.to_string(),
                }),
                None => PublishProviderOutcome::Unknown {
                    code: "distribution-order-id-missing".to_string(),
                    reason: "订单受理但未返回订单标识，必须人工核对".to_string(),
                },
            }
        }
        Some("safe-retryable") | Some("non-retryable") | Some("unknown") => {
            let (code, reason) = egress_failure_fields(value);
            match egress_outcome_kind(value) {
                Some("safe-retryable") => PublishProviderOutcome::SafeRetryable { code, reason },
                Some("non-retryable") => PublishProviderOutcome::NonRetryable { code, reason },
                _ => PublishProviderOutcome::Unknown { code, reason },
            }
        }
        _ => PublishProviderOutcome::Unknown {
            code: "distribution-response-unknown".to_string(),
            reason: "下单出口响应不可解析，必须人工核对".to_string(),
        },
    }
}

/// Immediately before each egress the production transport re-derives the
/// gateway identity fingerprint; a change since claim blocks the request.
fn current_gateway_fingerprint(endpoint_family: &str) -> Option<String> {
    configured_provider_snapshot().ok().and_then(|snapshot| {
        if endpoint_family == snapshot.object_storage.endpoint_family {
            snapshot.object_storage.configuration_fingerprint
        } else {
            snapshot.distribution.configuration_fingerprint
        }
    })
}

#[derive(Debug, Default)]
struct ProductionPublishProvider;

impl PublishProvider for ProductionPublishProvider {
    fn upload<'a>(
        &'a self,
        request: PublishUploadRequest,
    ) -> ProviderFuture<'a, PublishUploadReceipt> {
        Box::pin(async move {
            if current_gateway_fingerprint("gateway-oss-put")
                != Some(request.expected_configuration_fingerprint.clone())
            {
                return PublishProviderOutcome::Unknown {
                    code: "object-storage-configuration-changed".to_string(),
                    reason: "网关传输身份在执行前变化，禁止发出请求".to_string(),
                };
            }
            let payload = json!({
                "executionId": request.route.execution_id,
                "itemId": request.route.item_id,
                "objectKey": request.object_key,
                "html": String::from_utf8_lossy(&request.body),
            });
            match call_publish_egress_sidecar(
                &request.route,
                "/api/xiaojing/publish-scheduler/egress/upload",
                payload,
            )
            .await
            {
                Ok(result) => parse_upload_egress_result(&result),
                // Nothing left the machine and the object key is stable: a
                // later claim can replay the same PUT.
                Err(SidecarCallFailure::Unreachable(reason)) => {
                    PublishProviderOutcome::SafeRetryable {
                        code: "object-storage-sidecar-unavailable".to_string(),
                        reason,
                    }
                }
                // PUT may have been forwarded; stable-key PUT stays a safe retry.
                Err(SidecarCallFailure::Indeterminate(reason)) => {
                    PublishProviderOutcome::SafeRetryable {
                        code: "object-storage-sidecar-transport".to_string(),
                        reason,
                    }
                }
            }
        })
    }

    /// 配图对象上传（票 #15）：与 HTML 上传同一条 egress 上传路由的
    /// 图片载荷形态（images-only），网关指纹门与失败分类同款——sha256
    /// 内容寻址键重放幂等，一切非确定性拒绝都可安全重试。
    fn upload_images<'a>(
        &'a self,
        request: PublishImageUploadRequest,
    ) -> ProviderFuture<'a, PublishImageUploadReceipt> {
        Box::pin(async move {
            if current_gateway_fingerprint("gateway-oss-put")
                != Some(request.expected_configuration_fingerprint.clone())
            {
                return PublishProviderOutcome::Unknown {
                    code: "object-storage-configuration-changed".to_string(),
                    reason: "网关传输身份在执行前变化，禁止发出请求".to_string(),
                };
            }
            let payload = json!({
                "executionId": request.route.execution_id,
                "itemId": request.route.item_id,
                "images": request
                    .images
                    .iter()
                    .map(|image| json!({
                        "imageId": image.image_id,
                        "sha256": image.sha256,
                        "mediaType": image.media_type,
                        "bytesB64": BASE64.encode(&image.bytes),
                    }))
                    .collect::<Vec<_>>(),
            });
            match call_publish_egress_sidecar(
                &request.route,
                "/api/xiaojing/publish-scheduler/egress/upload",
                payload,
            )
            .await
            {
                Ok(result) => parse_image_upload_egress_result(&result),
                // Nothing left the machine and the object keys are stable: a
                // later claim can replay the same PUTs.
                Err(SidecarCallFailure::Unreachable(reason)) => {
                    PublishProviderOutcome::SafeRetryable {
                        code: "object-storage-sidecar-unavailable".to_string(),
                        reason,
                    }
                }
                // PUTs may have been forwarded; stable-key PUTs stay safe retries.
                Err(SidecarCallFailure::Indeterminate(reason)) => {
                    PublishProviderOutcome::SafeRetryable {
                        code: "object-storage-sidecar-transport".to_string(),
                        reason,
                    }
                }
            }
        })
    }

    fn submit<'a>(
        &'a self,
        request: PublishOrderRequest,
    ) -> ProviderFuture<'a, PublishOrderReceipt> {
        Box::pin(async move {
            if current_gateway_fingerprint("gateway-order-api")
                != Some(request.expected_configuration_fingerprint.clone())
            {
                return PublishProviderOutcome::Unknown {
                    code: "distribution-configuration-changed".to_string(),
                    reason: "网关传输身份在执行前变化，禁止发出请求".to_string(),
                };
            }
            let payload = json!({
                "executionId": request.route.execution_id,
                "itemId": request.route.item_id,
                "perArticleMaxPoints": request.per_article_max_points,
                "executionMaxPoints": request.execution_max_points,
                "kind": request.kind,
                "resourceId": request.resource_id,
                "title": request.title,
                "contentUrl": request.content_url,
            });
            match call_publish_egress_sidecar(
                &request.route,
                "/api/xiaojing/publish-scheduler/egress/order",
                payload,
            )
            .await
            {
                Ok(result) => parse_order_egress_result(&result),
                // Order was never sent: a later claim can safely replay the sn.
                Err(SidecarCallFailure::Unreachable(reason)) => {
                    PublishProviderOutcome::SafeRetryable {
                        code: "distribution-sidecar-unavailable".to_string(),
                        reason,
                    }
                }
                // The order may have been placed — never auto-retry.
                Err(SidecarCallFailure::Indeterminate(reason)) => PublishProviderOutcome::Unknown {
                    code: "distribution-transport-unknown".to_string(),
                    reason,
                },
            }
        })
    }
}

#[derive(Debug)]
struct ClaimedPublishItem {
    execution_id: String,
    /// 执行的来源 Session：egress 借用它的 Sidecar owner 身份（票 08）。
    source_session_id: String,
    item_id: String,
    per_article_max_points: i64,
    execution_max_points: i64,
    claim_token: String,
    stage: &'static str,
    article: PublishArticleSnapshot,
    channel: PublishChannelSnapshot,
    approved_body_path: String,
    idempotency_key: String,
    external_request_sn: String,
    payload_hash: String,
    object_key: String,
    object_url: Option<String>,
    attempts: i64,
    upload_attempts: i64,
    provider_snapshot: PublishProviderSnapshot,
}

pub struct PublishScheduler {
    store: BrandWorkspaceStore,
    provider: Arc<dyn PublishProvider>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    wake: Arc<Notify>,
}

impl PublishScheduler {
    pub(crate) fn new(
        store: BrandWorkspaceStore,
        provider: Arc<dyn PublishProvider>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            store,
            provider,
            now,
            wake: Arc::new(Notify::new()),
        }
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    pub async fn tick_all(&self) {
        let workspaces = match self.store.list_workspaces() {
            Ok(value) => value,
            Err(_) => return,
        };
        for workspace in workspaces {
            let _ = self.tick_workspace(&workspace).await;
        }
    }

    async fn tick_workspace(&self, workspace: &BrandWorkspace) -> Result<(), String> {
        let now_ms = (self.now)();
        reconcile_provider_configuration(workspace, now_ms)?;
        recover_expired_claims(workspace, now_ms)?;
        loop {
            let Some(claim) = claim_next_item(workspace, now_ms)? else {
                break;
            };
            self.execute_claim(workspace, claim, now_ms).await?;
        }
        Ok(())
    }

    async fn execute_claim(
        &self,
        workspace: &BrandWorkspace,
        claim: ClaimedPublishItem,
        now_ms: i64,
    ) -> Result<(), String> {
        let current_provider =
            configured_provider_snapshot().unwrap_or_else(|_| unavailable_provider_snapshot());
        if provider_configuration_changed(&claim.provider_snapshot, &current_provider) {
            settle_reconciliation(
                workspace,
                &claim,
                "provider-configuration-changed",
                "Provider 配置指纹在执行前变化，未发出外部请求",
                now_ms,
            )?;
            return Ok(());
        }
        if current_provider != claim.provider_snapshot {
            // 两侧快照不一致但构不成「配置变化」：当前侧未登录拿不到网关
            // 指纹。不 brick、不消耗重试次数——释放 claim 并推迟，登录
            // 恢复后指纹自然匹配、自动继续执行。
            defer_claim_until_login(workspace, &claim, now_ms)?;
            return Ok(());
        }
        if claim.stage == "uploading" {
            let body = match bounded_body(&workspace.root_path.join(&claim.approved_body_path)) {
                Ok(value) if sha256_hex(&value) == claim.article.approved_body_sha256 => value,
                _ => {
                    settle_reconciliation(
                        workspace,
                        &claim,
                        "approved-body-mismatch",
                        "批准正文版本或哈希已变化，禁止上传",
                        now_ms,
                    )?;
                    return Ok(());
                }
            };
            let markdown = String::from_utf8_lossy(&body).into_owned();
            // 配图占位符（票 #15，ADR-0008 D3/D4）：发布渲染前先把
            // material-image:// 占位符换成已上传图片对象的公网 URL。顺序固定
            // ——绑定审查 → 材料图片资产取回（内容寻址那条路）→ 图片上传
            // 拿 URL → 替换 → 渲染 → HTML 上传。绑定违例/超密度/资产缺失
            // 都属批准稿破损或资产失联，fail-closed 转人工，不静默换形发布。
            let image_urls = match self
                .resolve_publish_image_urls(workspace, &claim, &markdown)
                .await
            {
                Ok(urls) => urls,
                Err(ImageStageFailure::Reconcile { code, reason }) => {
                    settle_reconciliation(workspace, &claim, &code, &reason, now_ms)?;
                    return Ok(());
                }
                Err(ImageStageFailure::Egress(outcome)) => {
                    settle_upload(workspace, &claim, outcome, now_ms)?;
                    return Ok(());
                }
                Err(ImageStageFailure::Internal(reason)) => return Err(reason),
            };
            let rendered_markdown =
                match replace_material_image_placeholders(&markdown, &image_urls) {
                    Ok(rendered) => rendered,
                    Err(code) => {
                        settle_reconciliation(
                            workspace,
                            &claim,
                            code,
                            "批准稿配图占位符无法替换为公网 URL，禁止上传",
                            now_ms,
                        )?;
                        return Ok(());
                    }
                };
            let html = render_article_html(&claim.article.title, &rendered_markdown);
            let route = PublishEgressRoute {
                workspace_id: workspace.id.clone(),
                workspace_root: workspace.root_path.clone(),
                session_id: claim.source_session_id.clone(),
                execution_id: claim.execution_id.clone(),
                item_id: claim.item_id.clone(),
            };
            let outcome = self
                .provider
                .upload(PublishUploadRequest {
                    route,
                    object_key: claim.object_key.clone(),
                    body: html.into_bytes(),
                    expected_configuration_fingerprint: claim
                        .provider_snapshot
                        .object_storage
                        .configuration_fingerprint
                        .clone()
                        .ok_or_else(|| "publish_provider_unavailable".to_string())?,
                })
                .await;
            settle_upload(workspace, &claim, outcome, now_ms)?;
            return Ok(());
        }
        let object_url = claim
            .object_url
            .clone()
            .ok_or_else(|| "publish_uploaded_object_url_missing".to_string())?;
        let structural = if claim.channel.kind == "media" {
            "media-order-v1".to_string()
        } else {
            "publish_form=1|publish_type=1|account_rule=2".to_string()
        };
        // 载荷哈希冻结的是确定性对象键（票 08）：URL 由网关在上传时解析，
        // 提交前重算绑定同一键，防止同幂等键换内容下单。
        let actual_hash = sha256_hex(format!(
            "sn={}|kind={}|resource_id={}|title={}|content-key={}|{}",
            claim.external_request_sn,
            claim.channel.kind,
            claim.channel.resource_id,
            claim.article.title,
            claim.object_key,
            structural
        ));
        if actual_hash != claim.payload_hash {
            settle_reconciliation(
                workspace,
                &claim,
                "payload-hash-conflict",
                "同一幂等键的外部请求载荷发生变化，禁止下单",
                now_ms,
            )?;
            return Ok(());
        }
        let route = PublishEgressRoute {
            workspace_id: workspace.id.clone(),
            workspace_root: workspace.root_path.clone(),
            session_id: claim.source_session_id.clone(),
            execution_id: claim.execution_id.clone(),
            item_id: claim.item_id.clone(),
        };
        let outcome = self
            .provider
            .submit(PublishOrderRequest {
                route,
                per_article_max_points: claim.per_article_max_points,
                execution_max_points: claim.execution_max_points,
                kind: claim.channel.kind.clone(),
                resource_id: claim.channel.resource_id,
                title: claim.article.title.clone(),
                content_url: object_url,
                expected_configuration_fingerprint: claim
                    .provider_snapshot
                    .distribution
                    .configuration_fingerprint
                    .clone()
                    .ok_or_else(|| "publish_provider_unavailable".to_string())?,
            })
            .await;
        settle_submission(workspace, &claim, outcome, now_ms)?;
        Ok(())
    }

    async fn run(self: Arc<Self>) {
        loop {
            self.tick_all().await;
            tokio::select! {
                _ = tokio::time::sleep(BACKGROUND_INTERVAL) => {},
                _ = self.wake.notified() => {},
            }
        }
    }
}

/// 配图阶段失败（票 #15）：三态分流——破损/资产失联转人工对账、出口
/// 失败沿用 HTML 上传的结算分类、存储内部错误冒泡为 tick 错误。
enum ImageStageFailure {
    Reconcile { code: String, reason: String },
    Egress(PublishProviderOutcome<PublishUploadReceipt>),
    Internal(String),
}

impl PublishScheduler {
    /// 发布配图 URL 解析（票 #15）：绑定审查 → 材料图片资产字节取回 →
    /// egress 图片对象上传 → imageId→公网 URL 映射。无占位符的正文零
    /// 额外出口调用（既有纯文字文章行为不变）。
    async fn resolve_publish_image_urls(
        &self,
        workspace: &BrandWorkspace,
        claim: &ClaimedPublishItem,
        markdown: &str,
    ) -> Result<HashMap<String, String>, ImageStageFailure> {
        let image_ids =
            publish_image_bindings(markdown).map_err(|code| ImageStageFailure::Reconcile {
                code: code.to_string(),
                reason:
                    "批准稿配图占位符存在语法违例或超出密度上限（生成门已拦截，发布侧 fail-closed）"
                        .to_string(),
            })?;
        if image_ids.is_empty() {
            return Ok(HashMap::new());
        }
        // 字节取回落材料图片资产的内容寻址存储（T2/T3 那条路），不从正文
        // 重新解析；资产不可用即批准稿承诺的配图失联，禁止换形发布。
        let mut images = Vec::with_capacity(image_ids.len());
        for image_id in &image_ids {
            let (image, bytes) = self
                .store
                .read_material_image_bytes(&workspace.id, &claim.source_session_id, image_id)
                .map_err(|_| ImageStageFailure::Reconcile {
                    code: "material-image-unavailable".to_string(),
                    reason: "配图对应的材料图片资产不可用（已删除或存储失联），禁止换形发布"
                        .to_string(),
                })?;
            images.push(PublishImageUpload {
                image_id: image_id.clone(),
                sha256: image.sha256,
                media_type: image.media_type,
                bytes,
            });
        }
        let route = PublishEgressRoute {
            workspace_id: workspace.id.clone(),
            workspace_root: workspace.root_path.clone(),
            session_id: claim.source_session_id.clone(),
            execution_id: claim.execution_id.clone(),
            item_id: claim.item_id.clone(),
        };
        let expected_configuration_fingerprint = claim
            .provider_snapshot
            .object_storage
            .configuration_fingerprint
            .clone()
            .ok_or_else(|| {
                ImageStageFailure::Internal("publish_provider_unavailable".to_string())
            })?;
        // 轻量元数据副本：回执 URL 校验要在 images move 进请求后仍可用。
        let asset_keys: Vec<(String, String)> = images
            .iter()
            .map(|image| {
                (
                    image.image_id.clone(),
                    format!(
                        "images/{}.{}",
                        image.sha256,
                        image_extension_for_media_type(&image.media_type)
                    ),
                )
            })
            .collect();
        match self
            .provider
            .upload_images(PublishImageUploadRequest {
                route,
                images,
                expected_configuration_fingerprint,
            })
            .await
        {
            PublishProviderOutcome::Success(receipt) => {
                // 回执 URL 纪律与 HTML 对象一致：必须逐段指向冻结的内容寻址
                // 键（images/<sha256>.<ext>，ext 按 mediaType 白名单口径），
                // 指向别处的 URL 会把公网正文引到未授权位置——fail-closed。
                for (image_id, object_key) in &asset_keys {
                    let Some(url) = receipt.urls.get(image_id) else {
                        continue;
                    };
                    if !receipt_url_points_at_object_key(url, object_key) {
                        return Err(ImageStageFailure::Reconcile {
                            code: "material-image-url-mismatch".to_string(),
                            reason: "图片上传返回 URL 不指向内容寻址对象键".to_string(),
                        });
                    }
                }
                Ok(receipt.urls)
            }
            PublishProviderOutcome::SafeRetryable { code, reason } => Err(
                ImageStageFailure::Egress(PublishProviderOutcome::SafeRetryable { code, reason }),
            ),
            PublishProviderOutcome::NonRetryable { code, reason } => Err(
                ImageStageFailure::Egress(PublishProviderOutcome::NonRetryable { code, reason }),
            ),
            PublishProviderOutcome::Unknown { code, reason } => {
                Err(ImageStageFailure::Egress(PublishProviderOutcome::Unknown {
                    code,
                    reason,
                }))
            }
        }
    }
}

/// 图片对象扩展名（与 TS capability 的白名单口径逐字一致：jpeg 统一
/// .jpg）。白名单外类型在材料入库时已被拒，这里只做映射。
fn image_extension_for_media_type(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// 发布文章页内嵌样式层（ADR-0008 Decision 5）：单文件自包含、无外链，
/// 让所有重新发布的文章获得一致排版。只约束排版（阅读宽度、标题层级、
/// 列表表格、图片自适应），不参与 markdown→HTML 转换语义。
const ARTICLE_PAGE_CSS: &str = "\
body{margin:0 auto;padding:40px 20px 80px;max-width:720px;box-sizing:border-box;\
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',\
'Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:16px;\
line-height:1.75;color:#1f2328;background:#fff}
h1{font-size:1.75em;line-height:1.3;margin:0 0 1em;font-weight:600}
h2{font-size:1.4em;line-height:1.4;margin:1.8em 0 .6em;font-weight:600}
h3{font-size:1.2em;line-height:1.4;margin:1.5em 0 .5em;font-weight:600}
h4,h5,h6{font-size:1.05em;margin:1.5em 0 .5em;font-weight:600}
p{margin:0 0 1em}
ul,ol{margin:0 0 1em;padding-left:1.6em}
li{margin:.3em 0}
li>p{margin:0 0 .5em}
img{max-width:100%;height:auto;display:block;margin:1.6em auto;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:1.6em 0;font-size:.95em}
th,td{border:1px solid #d8dee4;padding:.5em .8em;text-align:left;vertical-align:top}
th{background:#f6f8fa;font-weight:600}
blockquote{margin:1.2em 0;padding:.1em 1.2em;border-left:4px solid #d8dee4;\
color:#59636e;background:#f9fafb}
code{font-family:ui-monospace,SFMono-Regular,Consolas,'Courier New',monospace;\
font-size:.9em;background:#f6f8fa;padding:.15em .4em;border-radius:4px}
pre{background:#f6f8fa;padding:1em 1.2em;border-radius:6px;overflow-x:auto;\
margin:0 0 1.2em}
pre code{background:none;padding:0}
a{color:#0969da;text-underline-offset:.2em}
hr{border:0;border-top:1px solid #d8dee4;margin:2.2em 0}
";

fn render_article_html(title: &str, markdown: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let markdown = if markdown
        .lines()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.starts_with("# "))
    {
        let mut lines = markdown.lines();
        let _ = lines.next();
        format!("# {title}\n{}", lines.collect::<Vec<_>>().join("\n"))
    } else {
        format!("# {title}\n{markdown}")
    };
    let mut body = String::new();
    html::push_html(&mut body, Parser::new_ext(&markdown, options));
    let escaped_title = title
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{escaped_title}</title>\n<style>{ARTICLE_PAGE_CSS}</style>\n</head>\n<body>\n{body}</body>\n</html>\n"
    )
}

// ── material-image 占位符：发布渲染期的替换侧（ADR-0008 D3/D6，票 #15）。
// 语法与替换语义和 TS 解析侧（src/shared/geo/material-image-placeholder.ts）
// 同构：占位符 = `![alt](material-image://<id>)`（id 字符集 [A-Za-z0-9-]，
// alt 不含 ] 与换行）；scheme 逃逸出该语法即违例。两侧共用同一份契约
// 用例 JSON（materialImagePlaceholderContractCases.json），Rust 侧由
// `material_image_contract_cases_*` 测试逐例钉死，防止「什么算一个占位
// 符」在两端漂移。

/// 受控 uri scheme（与契约 JSON 顶部 `uriScheme` 同值，测试断言锁死）。
const MATERIAL_IMAGE_URI_SCHEME: &str = "material-image://";

/// 配图密度上限（契约 JSON 顶部 `maxImagesPerArticle`；生成门在审核期
/// 拦截，发布侧再核一次——超限说明批准稿绕过了门，fail-closed）。
/// 类型级配额在 TS 侧（ARTICLE_IMAGE_QUOTA_BY_TYPE：详情/指南 8、新闻 3、
/// 对比清单 1，用户裁决 2026-08-31）；本常量是与 TS
/// MATERIAL_IMAGE_MAX_PER_ARTICLE 逐值同步的跨进程硬顶（各类型最大值）。
const MATERIAL_IMAGE_MAX_PER_ARTICLE: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
struct MaterialImagePlaceholderScan {
    /// 按出现顺序的合法占位符：(字节起点, 字节终点, image_id, alt)。
    matches: Vec<(usize, usize, String, String)>,
    /// scheme 出现但不构成合法占位符的违例字节位（文本逃逸）。
    violations: Vec<usize>,
}

fn material_image_id_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-'
}

/// 尝试在 `at` 处匹配 `![alt](material-image://<id>)`；与 TS 正则
/// `!\[([^\]\n]*)\]\(material-image://([A-Za-z0-9-]+)\)` 逐语义等价：
/// alt 段内出现 `]` 或换行即失败（无回溯空间），id 非空且闭括号紧跟。
fn match_material_image_placeholder(bytes: &[u8], at: usize) -> Option<(usize, String, String)> {
    let scheme = MATERIAL_IMAGE_URI_SCHEME.as_bytes();
    let mut cursor = at + 2; // 跳过 "!["（调用方已确认）
    while cursor < bytes.len() && bytes[cursor] != b']' && bytes[cursor] != b'\n' {
        cursor += 1;
    }
    if cursor >= bytes.len() || bytes[cursor] != b']' {
        return None;
    }
    let alt_end = cursor;
    // "]" 之后必须紧跟 "(material-image://"。
    cursor += 1;
    if cursor >= bytes.len() || bytes[cursor] != b'(' {
        return None;
    }
    cursor += 1;
    if bytes
        .get(cursor..cursor + scheme.len())
        .is_none_or(|found| found != scheme)
    {
        return None;
    }
    cursor += scheme.len();
    let id_start = cursor;
    while cursor < bytes.len() && material_image_id_char(bytes[cursor]) {
        cursor += 1;
    }
    if cursor == id_start {
        return None; // 空 id 不算占位符。
    }
    if cursor >= bytes.len() || bytes[cursor] != b')' {
        return None;
    }
    // 分隔符均为 ASCII，切片边界天然落在 UTF-8 字符边界上。
    let alt = String::from_utf8_lossy(&bytes[at + 2..alt_end]).into_owned();
    let image_id = String::from_utf8_lossy(&bytes[id_start..cursor]).into_owned();
    Some((cursor + 1, image_id, alt))
}

fn scan_material_image_placeholders(markdown: &str) -> MaterialImagePlaceholderScan {
    let bytes = markdown.as_bytes();
    let mut matches = Vec::new();
    let mut covered: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    while at + 1 < bytes.len() {
        if bytes[at] == b'!' && bytes[at + 1] == b'[' {
            if let Some((end, image_id, alt)) = match_material_image_placeholder(bytes, at) {
                covered.push((at, end));
                matches.push((at, end, image_id, alt));
                at = end;
                continue;
            }
        }
        at += 1;
    }
    let mut violations = Vec::new();
    let mut cursor = 0;
    while let Some(found) = markdown[cursor..].find(MATERIAL_IMAGE_URI_SCHEME) {
        let offset = cursor + found;
        if !covered
            .iter()
            .any(|(start, end)| offset >= *start && offset < *end)
        {
            violations.push(offset);
        }
        cursor = offset + MATERIAL_IMAGE_URI_SCHEME.len();
    }
    MaterialImagePlaceholderScan {
        matches,
        violations,
    }
}

/// 发布期配图绑定：按出现顺序去重后的 image id 集合 + 发布侧纪律闸。
/// 违例（scheme 逃逸）或超密度上限都按批准稿破损 fail-closed（生成门
/// 已拦，走到这里说明门被绕过，不允许换内容静默发布）。
fn publish_image_bindings(markdown: &str) -> Result<Vec<String>, &'static str> {
    let scan = scan_material_image_placeholders(markdown);
    if !scan.violations.is_empty() {
        return Err("material-image-placeholder-invalid");
    }
    let mut ids: Vec<String> = Vec::new();
    for (_, _, image_id, _) in &scan.matches {
        if !ids.iter().any(|seen| seen == image_id) {
            ids.push(image_id.clone());
        }
    }
    if ids.len() > MATERIAL_IMAGE_MAX_PER_ARTICLE {
        return Err("material-image-density-exceeded");
    }
    Ok(ids)
}

/// 占位符 → 公网 URL 替换（替换侧权威，票 #15）：保 alt 文本，
/// `material-image://<id>` 换成已上传图片对象的绝对公网 URL，再交给
/// `render_article_html` 做 markdown→HTML。映射缺失即材料图片资产不在，
/// fail-closed（发布内容不得悄悄换形）。
fn replace_material_image_placeholders(
    markdown: &str,
    urls: &HashMap<String, String>,
) -> Result<String, &'static str> {
    let scan = scan_material_image_placeholders(markdown);
    if !scan.violations.is_empty() {
        return Err("material-image-placeholder-invalid");
    }
    let mut replaced = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for (start, end, image_id, alt) in &scan.matches {
        let Some(url) = urls.get(image_id) else {
            return Err("material-image-url-missing");
        };
        replaced.push_str(&markdown[cursor..*start]);
        // URL 由 OSS 出口产出（sha256 内容寻址键 + 公网基址），不含需转义
        // 的 markdown 控制字符；alt 原样保留（与 TS 侧同语义）。
        replaced.push_str(&format!("![{alt}]({url})"));
        cursor = *end;
    }
    replaced.push_str(&markdown[cursor..]);
    Ok(replaced)
}

fn reconcile_provider_configuration(workspace: &BrandWorkspace, now_ms: i64) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let current =
        configured_provider_snapshot().unwrap_or_else(|_| unavailable_provider_snapshot());
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("inspect publish provider configuration: {error}"))?;
    let executions = {
        let mut statement = transaction
            .prepare(
                "SELECT id, provider_snapshot_json FROM geo_publish_executions
                 WHERE execution_started_at IS NOT NULL
                   AND status IN ('running','scheduled','partially-succeeded','failed')",
            )
            .map_err(|error| format!("prepare publish provider inspection: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("read publish provider inspection: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect publish provider inspection: {error}"))?;
        rows
    };
    let now = now_iso(now_ms);
    let mut failed_execution_ids = Vec::new();
    for (execution_id, snapshot_json) in executions {
        let snapshot = serde_json::from_str::<PublishProviderSnapshot>(&snapshot_json).ok();
        // 只在「双方都 configured 且指纹不同」时判为配置变化：当前侧未登录
        // 拿不到网关指纹时跳过本轮巡检，不动这些执行单（快照不可解析的行
        // 保持旧的 fail-closed 行为）。
        let unchanged = snapshot
            .as_ref()
            .is_some_and(|frozen| !provider_configuration_changed(frozen, &current));
        if unchanged {
            continue;
        }
        transaction
            .execute(
                "UPDATE geo_publish_items SET status='reconciliation-required',
                 revision=revision+1, failure_code='provider-configuration-changed',
                 failure_reason='Provider 配置指纹已变化，禁止沿旧幂等键执行',
                 finished_at=?2, claim_token=NULL, lease_until_ms=NULL
                 WHERE execution_id=?1 AND status!='submitted'",
                params![execution_id, now],
            )
            .map_err(|error| format!("stop publish items after provider change: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_publish_executions SET status='reconciliation-required',
                 revision=revision+1, updated_at=?2 WHERE id=?1",
                params![execution_id, now],
            )
            .map_err(|error| format!("stop publish execution after provider change: {error}"))?;
        if changed == 1 {
            failed_execution_ids.push(execution_id.clone());
        }
        insert_audit(
            &transaction,
            &execution_id,
            None,
            "provider-configuration-changed",
            None,
            &json!({"action": "reconciliation-required"}),
            &now,
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("commit publish provider inspection: {error}"))?;
    for execution_id in failed_execution_ids {
        project_publish_execution_status(workspace, &execution_id, true)?;
    }
    Ok(())
}

fn recover_expired_claims(workspace: &BrandWorkspace, now_ms: i64) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("recover publish claims transaction: {error}"))?;
    let expired_submissions = {
        let mut statement = transaction
            .prepare(
                "SELECT id, execution_id FROM geo_publish_items
                 WHERE status='submitting' AND lease_until_ms IS NOT NULL AND lease_until_ms<=?1",
            )
            .map_err(|error| format!("prepare expired publish submissions: {error}"))?;
        let rows = statement
            .query_map([now_ms], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("read expired publish submissions: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect expired publish submissions: {error}"))?;
        rows
    };
    let now = now_iso(now_ms);
    for (item_id, execution_id) in expired_submissions {
        transaction
            .execute(
                "UPDATE geo_publish_items SET status='reconciliation-required',
                 revision=revision+1, failure_code='submission-claim-expired',
                 failure_reason='下单进程中断，外部受理结果未知，禁止自动重试',
                 finished_at=?2, claim_token=NULL, lease_until_ms=NULL
                 WHERE id=?1 AND status='submitting'",
                params![item_id, now],
            )
            .map_err(|error| format!("recover expired publish submission: {error}"))?;
        insert_audit(
            &transaction,
            &execution_id,
            Some(&item_id),
            "submission-outcome-unknown",
            None,
            &json!({"action": "reconciliation-required"}),
            &now,
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("commit publish claim recovery: {error}"))?;
    refresh_all_execution_statuses(workspace, now_ms)
}

fn claim_next_item(
    workspace: &BrandWorkspace,
    now_ms: i64,
) -> Result<Option<ClaimedPublishItem>, String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("claim publish item transaction: {error}"))?;
    // 队首门只挡「在途」前序 item（pending/uploading/uploaded/submitting）。
    // failed-retryable 在退避停车等下次尝试，不阻塞后续 item 继续：各 item
    // 独立（自有对象键、幂等 sn 与计费），执行循环本身串行，不引入并发
    // 出口；停车单重试到期后凭更小 sequence 仍在 ORDER BY 队首，顺序语义
    // 自洽。否则一个失败单的退避窗口会让整队干等——2026-09-01 事故中
    // 8 图文章的确定性 400 把后面 11 单全部卡住（彼时退避表更长；现行
    // 退避为 3s×2 后终态停车）。
    let row = transaction
        .query_row(
            "SELECT item.id, item.execution_id, item.status, item.article_json,
                    item.channel_json, item.approved_body_path,
                    item.idempotency_key, COALESCE(item.external_request_sn, item.id),
                    item.payload_hash, item.object_key, item.object_url,
                    item.attempts, item.upload_attempts,
                    execution.provider_snapshot_json, execution.created_by_session_id,
                    plan.projection_json
             FROM geo_publish_items item
             JOIN geo_publish_executions execution ON execution.id=item.execution_id
             JOIN geo_distribution_plans plan ON plan.id=execution.distribution_plan_id
             WHERE execution.execution_started_at IS NOT NULL
               AND execution.status IN ('running','scheduled','partially-succeeded','failed')
               AND item.scheduled_at_ms<=?1
               AND (item.next_attempt_at_ms IS NULL OR item.next_attempt_at_ms<=?1)
               AND (
                    item.status IN ('pending','uploaded','failed-retryable')
                    OR (item.status='uploading' AND item.lease_until_ms<=?1)
               )
               AND NOT EXISTS (
                    SELECT 1 FROM geo_publish_items previous
                    WHERE previous.execution_id=item.execution_id
                      AND previous.sequence<item.sequence
                      AND previous.status IN ('pending','uploading','uploaded','submitting')
               )
             ORDER BY item.scheduled_at_ms ASC, item.sequence ASC LIMIT 1",
            [now_ms],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read due publish item: {error}"))?;
    let Some((
        item_id,
        execution_id,
        status,
        article_json,
        channel_json,
        approved_body_path,
        idempotency_key,
        external_request_sn,
        payload_hash,
        object_key,
        object_url,
        attempts,
        upload_attempts,
        provider_snapshot_json,
        source_session_id,
        distribution_projection_json,
    )) = row
    else {
        transaction
            .commit()
            .map_err(|error| format!("finish empty publish claim: {error}"))?;
        return Ok(None);
    };
    let stage = if object_url.is_some() || status == "uploaded" {
        "submitting"
    } else {
        "uploading"
    };
    let claim_token = Uuid::new_v4().to_string();
    let now = now_iso(now_ms);
    let changed = transaction
        .execute(
            "UPDATE geo_publish_items SET status=?2, revision=revision+1,
             claim_token=?3, lease_until_ms=?4, next_attempt_at_ms=NULL,
             started_at=COALESCE(started_at, ?5), failure_code=NULL, failure_reason=NULL
             WHERE id=?1 AND status=?6",
            params![
                item_id,
                stage,
                claim_token,
                now_ms + CLAIM_LEASE_MS,
                now,
                status
            ],
        )
        .map_err(|error| format!("claim due publish item: {error}"))?;
    if changed != 1 {
        return Err("publish_item_claim_conflict".to_string());
    }
    insert_audit(
        &transaction,
        &execution_id,
        Some(&item_id),
        if stage == "uploading" {
            "upload-claimed"
        } else {
            "submission-claimed"
        },
        None,
        &json!({"leaseUntilMs": now_ms + CLAIM_LEASE_MS}),
        &now,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("commit publish item claim: {error}"))?;
    let distribution_projection: Value = serde_json::from_str(&distribution_projection_json)
        .map_err(|_| "publish_distribution_snapshot_invalid".to_string())?;
    let per_article_max_points = distribution_projection
        .get("perArticleMaxPoints")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(crate::distribution_spend_limits::DEFAULT_PER_ARTICLE_MAX_POINTS);
    let execution_max_points = distribution_projection
        .get("totalMaxPoints")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(crate::distribution_spend_limits::DEFAULT_PER_EXECUTION_MAX_POINTS);
    Ok(Some(ClaimedPublishItem {
        execution_id,
        source_session_id,
        item_id,
        per_article_max_points,
        execution_max_points,
        claim_token,
        stage,
        article: serde_json::from_str(&article_json)
            .map_err(|_| "publish_article_snapshot_invalid".to_string())?,
        channel: serde_json::from_str(&channel_json)
            .map_err(|_| "publish_channel_snapshot_invalid".to_string())?,
        approved_body_path,
        idempotency_key,
        external_request_sn,
        payload_hash,
        object_key,
        object_url,
        attempts,
        upload_attempts,
        provider_snapshot: serde_json::from_str(&provider_snapshot_json)
            .map_err(|_| "publish_provider_snapshot_invalid".to_string())?,
    }))
}

fn retry_delay(attempt_after_failure: i64) -> Option<i64> {
    usize::try_from(attempt_after_failure - 1)
        .ok()
        .and_then(|index| RETRY_BACKOFF_MS.get(index).copied())
}

/// 解码 URL 路径分量的 `%XX` 转义（网关回传的对象 URL 以
/// encodeURIComponent 逐段编码对象键，与 sidecar/网关 encodeObjectKey
/// 口径一致）。不合法转义原样保留。
fn percent_decode_path_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = |byte: u8| match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => 0xff,
            };
            let high = hex(bytes[index + 1]);
            let low = hex(bytes[index + 2]);
            if high != 0xff && low != 0xff {
                decoded.push(high << 4 | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// 上传回执的完整性检查（票 08）：网关按服务器侧 OSS 公网基地址解析 URL，
/// 客户端冻结的权威事实是确定性对象键——回执 URL 的（解码后）路径必须
/// 精确指向该键，否则订单 content 会指向未获授权的位置。
fn receipt_url_points_at_object_key(object_url: &str, object_key: &str) -> bool {
    let Ok(parsed) = url::Url::parse(object_url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "https" | "http") {
        return false;
    }
    percent_decode_path_component(parsed.path().trim_start_matches('/')) == object_key
}

fn settle_upload(
    workspace: &BrandWorkspace,
    claim: &ClaimedPublishItem,
    outcome: PublishProviderOutcome<PublishUploadReceipt>,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("settle publish upload transaction: {error}"))?;
    let now = now_iso(now_ms);
    match outcome {
        PublishProviderOutcome::Success(receipt) => {
            if !receipt_url_points_at_object_key(&receipt.object_url, &claim.object_key) {
                transaction
                    .execute(
                        "UPDATE geo_publish_items SET status='reconciliation-required',
                         revision=revision+1, upload_attempts=upload_attempts+1,
                         failure_code='object-url-mismatch',
                         failure_reason='上传返回 URL 不指向确认冻结的对象键', claim_token=NULL,
                         lease_until_ms=NULL, finished_at=?3
                         WHERE id=?1 AND status='uploading' AND claim_token=?2",
                        params![claim.item_id, claim.claim_token, now],
                    )
                    .map_err(|error| format!("reject changed publish object URL: {error}"))?;
                insert_audit(
                    &transaction,
                    &claim.execution_id,
                    Some(&claim.item_id),
                    "object-url-mismatch",
                    None,
                    &json!({"action": "reconciliation-required"}),
                    &now,
                )?;
            } else {
                let changed = transaction
                    .execute(
                        "UPDATE geo_publish_items SET status='uploaded', revision=revision+1,
                         object_url=?3, external_content_id=?4,
                         upload_attempts=upload_attempts+1, claim_token=NULL, lease_until_ms=NULL,
                         failure_code=NULL, failure_reason=NULL
                         WHERE id=?1 AND status='uploading' AND claim_token=?2",
                        params![
                            claim.item_id,
                            claim.claim_token,
                            receipt.object_url,
                            receipt.external_content_id
                        ],
                    )
                    .map_err(|error| format!("finish publish upload: {error}"))?;
                if changed != 1 {
                    return Err("publish_upload_claim_conflict".to_string());
                }
                insert_audit(
                    &transaction,
                    &claim.execution_id,
                    Some(&claim.item_id),
                    "object-uploaded",
                    None,
                    &json!({
                        "objectKey": claim.object_key,
                        "externalContentId": receipt.external_content_id,
                    }),
                    &now,
                )?;
            }
        }
        PublishProviderOutcome::SafeRetryable { code, reason } => {
            let next_attempt = claim.upload_attempts + 1;
            let (status, next_at) = retry_delay(next_attempt)
                .map(|delay| ("failed-retryable", Some(now_ms + delay)))
                .unwrap_or(("failed-nonretryable", None));
            update_failed_claim(
                &transaction,
                FailedClaimUpdate {
                    claim,
                    status,
                    code: &code,
                    reason: &reason,
                    next_attempt_at_ms: next_at,
                    upload: true,
                    now: &now,
                },
            )?;
            insert_audit(
                &transaction,
                &claim.execution_id,
                Some(&claim.item_id),
                if status == "failed-retryable" {
                    "upload-safe-retry-scheduled"
                } else {
                    "upload-retry-exhausted"
                },
                None,
                &json!({"code": code, "nextAttemptAtMs": next_at}),
                &now,
            )?;
        }
        PublishProviderOutcome::NonRetryable { code, reason } => {
            update_failed_claim(
                &transaction,
                FailedClaimUpdate {
                    claim,
                    status: "failed-nonretryable",
                    code: &code,
                    reason: &reason,
                    next_attempt_at_ms: None,
                    upload: true,
                    now: &now,
                },
            )?;
            insert_audit(
                &transaction,
                &claim.execution_id,
                Some(&claim.item_id),
                "upload-failed-nonretryable",
                None,
                &json!({"code": code}),
                &now,
            )?;
        }
        PublishProviderOutcome::Unknown { code, reason } => {
            if code == "object-storage-configuration-changed" {
                let changed = transaction
                    .execute(
                        "UPDATE geo_publish_items SET status='reconciliation-required',
                         revision=revision+1, failure_code=?3, failure_reason=?4,
                         finished_at=?5, claim_token=NULL, lease_until_ms=NULL, next_attempt_at_ms=NULL
                         WHERE id=?1 AND status='uploading' AND claim_token=?2",
                        params![claim.item_id, claim.claim_token, code, reason, now],
                    )
                    .map_err(|error| format!("stop rotated publish upload: {error}"))?;
                if changed != 1 {
                    return Err("publish_upload_claim_conflict".to_string());
                }
                insert_audit(
                    &transaction,
                    &claim.execution_id,
                    Some(&claim.item_id),
                    "provider-configuration-changed",
                    None,
                    &json!({"action": "reconciliation-required"}),
                    &now,
                )?;
                transaction
                    .commit()
                    .map_err(|error| format!("commit rotated publish upload: {error}"))?;
                return refresh_execution_status(workspace, &claim.execution_id, now_ms);
            }
            // Stable-key PUT is idempotent, so even a transport-unknown upload
            // remains a safe retry rather than an order-like unknown outcome.
            let next_attempt = claim.upload_attempts + 1;
            let next_at = retry_delay(next_attempt).map(|delay| now_ms + delay);
            let status = if next_at.is_some() {
                "failed-retryable"
            } else {
                "failed-nonretryable"
            };
            update_failed_claim(
                &transaction,
                FailedClaimUpdate {
                    claim,
                    status,
                    code: &code,
                    reason: &reason,
                    next_attempt_at_ms: next_at,
                    upload: true,
                    now: &now,
                },
            )?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("commit publish upload result: {error}"))?;
    refresh_execution_status(workspace, &claim.execution_id, now_ms)
}

fn settle_submission(
    workspace: &BrandWorkspace,
    claim: &ClaimedPublishItem,
    outcome: PublishProviderOutcome<PublishOrderReceipt>,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("settle publish submission transaction: {error}"))?;
    let now = now_iso(now_ms);
    match outcome {
        PublishProviderOutcome::Success(receipt) => {
            let changed = transaction
                .execute(
                    "UPDATE geo_publish_items SET status='submitted', revision=revision+1,
                     external_order_id=?3, attempts=attempts+1, finished_at=?4,
                     claim_token=NULL, lease_until_ms=NULL, next_attempt_at_ms=NULL,
                     failure_code=NULL, failure_reason=NULL
                     WHERE id=?1 AND status='submitting' AND claim_token=?2",
                    params![
                        claim.item_id,
                        claim.claim_token,
                        receipt.external_order_id,
                        now
                    ],
                )
                .map_err(|error| format!("finish publish submission: {error}"))?;
            if changed != 1 {
                return Err("publish_submission_claim_conflict".to_string());
            }
            insert_audit(
                &transaction,
                &claim.execution_id,
                Some(&claim.item_id),
                "order-submitted",
                None,
                &json!({
                    "externalOrderId": receipt.external_order_id,
                    "idempotencyKey": claim.idempotency_key,
                    "payloadHash": claim.payload_hash,
                }),
                &now,
            )?;
        }
        PublishProviderOutcome::SafeRetryable { code, reason } => {
            let next_attempt = claim.attempts + 1;
            let (status, next_at) = retry_delay(next_attempt)
                .map(|delay| ("failed-retryable", Some(now_ms + delay)))
                .unwrap_or(("failed-nonretryable", None));
            update_failed_claim(
                &transaction,
                FailedClaimUpdate {
                    claim,
                    status,
                    code: &code,
                    reason: &reason,
                    next_attempt_at_ms: next_at,
                    upload: false,
                    now: &now,
                },
            )?;
            insert_audit(
                &transaction,
                &claim.execution_id,
                Some(&claim.item_id),
                if status == "failed-retryable" {
                    "order-safe-retry-scheduled"
                } else {
                    "order-retry-exhausted"
                },
                None,
                &json!({
                    "code": code,
                    "attempt": next_attempt,
                    "nextAttemptAtMs": next_at,
                    "idempotencyKey": claim.idempotency_key,
                    "payloadHash": claim.payload_hash,
                }),
                &now,
            )?;
        }
        PublishProviderOutcome::NonRetryable { code, reason } => {
            update_failed_claim(
                &transaction,
                FailedClaimUpdate {
                    claim,
                    status: "failed-nonretryable",
                    code: &code,
                    reason: &reason,
                    next_attempt_at_ms: None,
                    upload: false,
                    now: &now,
                },
            )?;
            insert_audit(
                &transaction,
                &claim.execution_id,
                Some(&claim.item_id),
                "order-failed-nonretryable",
                None,
                &json!({"code": code}),
                &now,
            )?;
        }
        PublishProviderOutcome::Unknown { code, reason } => {
            let changed = transaction
                .execute(
                    "UPDATE geo_publish_items SET status='reconciliation-required',
                     revision=revision+1, attempts=attempts+1, failure_code=?3,
                     failure_reason=?4, claim_token=NULL, lease_until_ms=NULL,
                     next_attempt_at_ms=NULL, finished_at=?5
                     WHERE id=?1 AND status='submitting' AND claim_token=?2",
                    params![claim.item_id, claim.claim_token, code, reason, now],
                )
                .map_err(|error| format!("mark unknown publish outcome: {error}"))?;
            if changed != 1 {
                return Err("publish_submission_claim_conflict".to_string());
            }
            insert_audit(
                &transaction,
                &claim.execution_id,
                Some(&claim.item_id),
                "submission-outcome-unknown",
                None,
                &json!({
                    "code": code,
                    "idempotencyKey": claim.idempotency_key,
                    "payloadHash": claim.payload_hash,
                    "action": "reconciliation-required",
                }),
                &now,
            )?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("commit publish submission result: {error}"))?;
    refresh_execution_status(workspace, &claim.execution_id, now_ms)
}

struct FailedClaimUpdate<'a> {
    claim: &'a ClaimedPublishItem,
    status: &'a str,
    code: &'a str,
    reason: &'a str,
    next_attempt_at_ms: Option<i64>,
    upload: bool,
    now: &'a str,
}

fn update_failed_claim(
    connection: &Connection,
    update: FailedClaimUpdate<'_>,
) -> Result<(), String> {
    let counter = if update.upload {
        "upload_attempts"
    } else {
        "attempts"
    };
    let changed = connection
        .execute(
            &format!(
                "UPDATE geo_publish_items SET status=?3, revision=revision+1,
                 {counter}={counter}+1, failure_code=?4, failure_reason=?5,
                 next_attempt_at_ms=?6,
                 finished_at=CASE WHEN ?3='failed-nonretryable' THEN ?7 ELSE finished_at END,
                 claim_token=NULL, lease_until_ms=NULL
                 WHERE id=?1 AND claim_token=?2"
            ),
            params![
                update.claim.item_id,
                update.claim.claim_token,
                update.status,
                update.code,
                update.reason,
                update.next_attempt_at_ms,
                update.now,
            ],
        )
        .map_err(|error| format!("persist publish provider failure: {error}"))?;
    if changed != 1 {
        return Err("publish_item_claim_conflict".to_string());
    }
    Ok(())
}

/// 未登录时认领到的执行单：释放 claim、恢复认领前状态并推迟到下一轮，
/// 不消耗重试次数也不标失败；登录恢复后指纹自然匹配、自动继续执行。
fn defer_claim_until_login(
    workspace: &BrandWorkspace,
    claim: &ClaimedPublishItem,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("defer publish claim transaction: {error}"))?;
    let now = now_iso(now_ms);
    let restored_status = if claim.stage == "uploading" {
        "pending"
    } else {
        "uploaded"
    };
    let next_attempt_at_ms = now_ms + LOGIN_RESUME_DEFER_MS;
    let changed = transaction
        .execute(
            "UPDATE geo_publish_items SET status=?3, revision=revision+1,
             claim_token=NULL, lease_until_ms=NULL, next_attempt_at_ms=?4
             WHERE id=?1 AND claim_token=?2",
            params![
                claim.item_id,
                claim.claim_token,
                restored_status,
                next_attempt_at_ms
            ],
        )
        .map_err(|error| format!("persist publish login deferral: {error}"))?;
    if changed != 1 {
        return Err("publish_item_claim_conflict".to_string());
    }
    insert_audit(
        &transaction,
        &claim.execution_id,
        Some(&claim.item_id),
        "execution-deferred-login-required",
        None,
        &json!({"code": "account-login-required", "nextAttemptAtMs": next_attempt_at_ms}),
        &now,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("commit publish login deferral: {error}"))?;
    refresh_execution_status(workspace, &claim.execution_id, now_ms)
}

fn settle_reconciliation(
    workspace: &BrandWorkspace,
    claim: &ClaimedPublishItem,
    code: &str,
    reason: &str,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("settle publish reconciliation transaction: {error}"))?;
    let now = now_iso(now_ms);
    let changed = transaction
        .execute(
            "UPDATE geo_publish_items SET status='reconciliation-required',
             revision=revision+1, failure_code=?3, failure_reason=?4,
             finished_at=?5, claim_token=NULL, lease_until_ms=NULL, next_attempt_at_ms=NULL
             WHERE id=?1 AND claim_token=?2",
            params![claim.item_id, claim.claim_token, code, reason, now],
        )
        .map_err(|error| format!("persist publish reconciliation: {error}"))?;
    if changed != 1 {
        return Err("publish_item_claim_conflict".to_string());
    }
    insert_audit(
        &transaction,
        &claim.execution_id,
        Some(&claim.item_id),
        "reconciliation-required",
        None,
        &json!({"code": code}),
        &now,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("commit publish reconciliation: {error}"))?;
    refresh_execution_status(workspace, &claim.execution_id, now_ms)
}

fn refresh_all_execution_statuses(workspace: &BrandWorkspace, now_ms: i64) -> Result<(), String> {
    let connection = open_database(workspace)?;
    let ids = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM geo_publish_executions WHERE execution_started_at IS NOT NULL
                 AND status NOT IN ('succeeded','reconciliation-required','cancelled')",
            )
            .map_err(|error| format!("prepare publish status refresh: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("read publish status refresh: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect publish status refresh: {error}"))?;
        rows
    };
    drop(connection);
    for id in ids {
        refresh_execution_status(workspace, &id, now_ms)?;
    }
    Ok(())
}

fn refresh_execution_status(
    workspace: &BrandWorkspace,
    execution_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("refresh publish execution transaction: {error}"))?;
    let counts = transaction
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status='reconciliation-required' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status='failed-nonretryable' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status IN ('pending','uploading','uploaded','submitting','failed-retryable') THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status='pending' AND scheduled_at_ms>?2 THEN 1 ELSE 0 END)
             FROM geo_publish_items WHERE execution_id=?1",
            params![execution_id, now_ms],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .map_err(|error| format!("count publish execution items: {error}"))?;
    let (total, submitted, reconciliation, terminal_failed, active, future_pending) = counts;
    let (status, finished) = if reconciliation > 0 {
        ("reconciliation-required", false)
    } else if total > 0 && submitted == total {
        ("succeeded", true)
    } else if active == 0 && terminal_failed > 0 {
        if submitted > 0 {
            ("partially-succeeded", true)
        } else {
            ("failed", true)
        }
    } else if submitted > 0 || terminal_failed > 0 {
        ("partially-succeeded", false)
    } else if future_pending == active && active > 0 {
        ("scheduled", false)
    } else {
        ("running", false)
    };
    let now = now_iso(now_ms);
    let changed = transaction
        .execute(
            "UPDATE geo_publish_executions SET status=?2, revision=revision+1,
             finished_at=CASE WHEN ?3 THEN COALESCE(finished_at, ?4) ELSE finished_at END,
             updated_at=?4 WHERE id=?1 AND status!=?2 AND status!='cancelled'",
            params![execution_id, status, finished, now],
        )
        .map_err(|error| format!("refresh publish execution: {error}"))?;
    transaction
        .execute(
            "UPDATE geo_operations SET state=?2 WHERE id=(
                SELECT operation_id FROM geo_publish_executions WHERE id=?1)",
            params![execution_id, format!("publish-{status}")],
        )
        .map_err(|error| format!("refresh publish operation: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit publish execution refresh: {error}"))?;
    if changed == 1 {
        let failed = matches!(status, "failed" | "reconciliation-required")
            || status == "partially-succeeded" && finished;
        project_publish_execution_status(workspace, execution_id, failed)?;
    }
    Ok(())
}

fn project_publish_execution_status(
    workspace: &BrandWorkspace,
    execution_id: &str,
    failed: bool,
) -> Result<(), String> {
    let connection = open_database(workspace)?;
    let (operation_id, session_id, revision) = connection
        .query_row(
            "SELECT operation_id,created_by_session_id,revision
             FROM geo_publish_executions WHERE id=?1",
            [execution_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .map_err(|error| format!("read failed publish execution notification: {error}"))?;
    if failed {
        crate::notification::submit_publish_failure(
            &workspace.id,
            &session_id,
            &operation_id,
            execution_id,
            revision,
        );
    } else {
        crate::notification::submit_geo_status_projection(&workspace.id, &session_id);
    }
    Ok(())
}

static PRODUCTION_SCHEDULER: OnceLock<Arc<PublishScheduler>> = OnceLock::new();

pub fn start_publish_scheduler_background(store: BrandWorkspaceStore) -> Arc<PublishScheduler> {
    PRODUCTION_SCHEDULER
        .get_or_init(|| {
            let scheduler = Arc::new(PublishScheduler::new(
                store,
                Arc::new(ProductionPublishProvider),
                Arc::new(|| Utc::now().timestamp_millis()),
            ));
            tauri::async_runtime::spawn(Arc::clone(&scheduler).run());
            scheduler
        })
        .clone()
}

pub fn production_publish_scheduler() -> Option<Arc<PublishScheduler>> {
    PRODUCTION_SCHEDULER.get().cloned()
}

/// Paid-action authority is deliberately a WebView/Tauri command, not a
/// Sidecar management route. The Agent runtime cannot synthesize this IPC.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_publish_execution_confirm_ui(
    workspaceId: String,
    sessionId: String,
    input: PublishConfirmRequest,
) -> Result<PublishExecutionProjection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.confirm_publish_execution(&workspaceId, &sessionId, input)
    })
    .await
    .map_err(|error| format!("publish confirmation task failed: {error}"))?
}

/// Session-free latest-execution read for the brand-level 「效果」 page; only
/// paid confirm/start/retry stay session-scoped.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_publish_execution_latest_ui(
    workspaceId: String,
) -> Result<Option<PublishExecutionProjection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.latest_publish_execution_readonly(&workspaceId)
    })
    .await
    .map_err(|error| format!("read latest publish execution failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_publish_execution_start_ui(
    workspaceId: String,
    sessionId: String,
    input: PublishStartRequest,
) -> Result<PublishExecutionProjection, String> {
    let execution = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.start_publish_execution(
            &workspaceId,
            &sessionId,
            input,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("publish start task failed: {error}"))??;
    if let Some(scheduler) = production_publish_scheduler() {
        scheduler.wake();
    }
    Ok(execution)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_publish_item_retry_ui(
    workspaceId: String,
    sessionId: String,
    input: PublishRetryRequest,
) -> Result<PublishExecutionProjection, String> {
    let execution = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.retry_publish_item(
            &workspaceId,
            &sessionId,
            input,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("publish retry task failed: {error}"))??;
    if let Some(scheduler) = production_publish_scheduler() {
        scheduler.wake();
    }
    Ok(execution)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_publish_execution_cancel_ui(
    workspaceId: String,
    sessionId: String,
    input: PublishCancelRequest,
) -> Result<PublishExecutionProjection, String> {
    let execution = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.cancel_publish_execution(
            &workspaceId,
            &sessionId,
            input,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("publish cancel task failed: {error}"))??;
    Ok(execution)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_publish_execution_resume_ui(
    workspaceId: String,
    sessionId: String,
    input: PublishStartRequest,
) -> Result<PublishExecutionProjection, String> {
    let execution = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.resume_reconciled_execution(
            &workspaceId,
            &sessionId,
            input,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("publish resume task failed: {error}"))??;
    if let Some(scheduler) = production_publish_scheduler() {
        scheduler.wake();
    }
    Ok(execution)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Mutex as StdMutex;

    use super::super::{SessionCommit, SessionTitleSource};
    use super::*;
    use tempfile::tempdir;

    static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    const TEST_GATEWAY_BASE: &str = "https://gateway.example.test";

    /// setup_fixture 的首篇文章 id（= `format!("article-{}",
    /// "long-identifier-".repeat(8))` 的字面值，与夹具构造式逐字同源）。
    const ARTICLE_ID: &str = "article-long-identifier-long-identifier-long-identifier-long-identifier-long-identifier-long-identifier-long-identifier-long-identifier-";

    /// 测试网关 egress 身份注入：生产路径读 `account_auth` 的账号会话
    /// （OS 凭据库），单测不得触碰——沿既有确定性测试模式改为静态注入。
    struct TestEnvironment(Option<Option<String>>);

    impl TestEnvironment {
        fn configured() -> Self {
            Self::with_base(TEST_GATEWAY_BASE)
        }

        fn with_base(base: &str) -> Self {
            let previous = TEST_GATEWAY_EGRESS_BASE_URL
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
            set_test_gateway_base(Some(base));
            Self(previous)
        }
    }

    fn set_test_gateway_base(base: Option<&str>) {
        *TEST_GATEWAY_EGRESS_BASE_URL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(base.map(str::to_string));
    }

    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            *TEST_GATEWAY_EGRESS_BASE_URL
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = self.0.take();
        }
    }

    #[derive(Default)]
    struct MockProvider {
        uploads: StdMutex<Vec<PublishUploadRequest>>,
        image_uploads: StdMutex<Vec<PublishImageUploadRequest>>,
        submissions: StdMutex<Vec<PublishOrderRequest>>,
        submit_outcomes: StdMutex<VecDeque<PublishProviderOutcome<PublishOrderReceipt>>>,
        upload_urls: StdMutex<VecDeque<String>>,
        /// 图片回执 URL 覆盖（缺省按内容寻址口径派生；测试指向别处用）。
        image_url_overrides: StdMutex<HashMap<String, String>>,
    }

    impl MockProvider {
        fn with_submit_outcomes(
            outcomes: Vec<PublishProviderOutcome<PublishOrderReceipt>>,
        ) -> Self {
            Self {
                submit_outcomes: StdMutex::new(outcomes.into()),
                ..Self::default()
            }
        }

        fn with_upload_urls(urls: Vec<String>) -> Self {
            Self {
                upload_urls: StdMutex::new(urls.into()),
                ..Self::default()
            }
        }

        fn counts(&self) -> (usize, usize) {
            (
                self.uploads.lock().unwrap().len(),
                self.submissions.lock().unwrap().len(),
            )
        }
    }

    impl PublishProvider for MockProvider {
        fn upload<'a>(
            &'a self,
            request: PublishUploadRequest,
        ) -> ProviderFuture<'a, PublishUploadReceipt> {
            Box::pin(async move {
                let object_url = self
                    .upload_urls
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| format!("https://cdn.example.test/{}", request.object_key));
                let receipt = PublishUploadReceipt {
                    object_url,
                    external_content_id: request.object_key.clone(),
                };
                self.uploads.lock().unwrap().push(request);
                PublishProviderOutcome::Success(receipt)
            })
        }

        /// 图片上传桩（票 #15）：回执 URL 按 Sidecar/capability 的内容寻址
        /// 口径派生（images/<sha256>.<ext>），使渲染替换产物与生产路径同形。
        fn upload_images<'a>(
            &'a self,
            request: PublishImageUploadRequest,
        ) -> ProviderFuture<'a, PublishImageUploadReceipt> {
            Box::pin(async move {
                let overrides = self.image_url_overrides.lock().unwrap().clone();
                let urls = request
                    .images
                    .iter()
                    .map(|image| {
                        let derived = || {
                            let extension = match image.media_type.as_str() {
                                "image/jpeg" => "jpg",
                                "image/png" => "png",
                                "image/gif" => "gif",
                                "image/webp" => "webp",
                                other => other.rsplit('/').next().unwrap_or("bin"),
                            };
                            format!(
                                "https://cdn.example.test/images/{}.{}",
                                image.sha256, extension
                            )
                        };
                        (
                            image.image_id.clone(),
                            overrides
                                .get(&image.image_id)
                                .cloned()
                                .unwrap_or_else(derived),
                        )
                    })
                    .collect();
                self.image_uploads.lock().unwrap().push(request);
                PublishProviderOutcome::Success(PublishImageUploadReceipt { urls })
            })
        }

        fn submit<'a>(
            &'a self,
            request: PublishOrderRequest,
        ) -> ProviderFuture<'a, PublishOrderReceipt> {
            Box::pin(async move {
                self.submissions.lock().unwrap().push(request);
                self.submit_outcomes
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| {
                        PublishProviderOutcome::Success(PublishOrderReceipt {
                            external_order_id: "provider-order-13".to_string(),
                        })
                    })
            })
        }
    }

    struct Fixture {
        store: BrandWorkspaceStore,
        workspace: BrandWorkspace,
        now_ms: i64,
        plan_id: String,
        body_marker: String,
    }

    fn setup_fixture(article_count: usize, scheduled_offset_ms: i64) -> Fixture {
        let store = BrandWorkspaceStore::at(tempdir().unwrap().keep().join("Xiaojing"));
        let workspace = store
            .create_workspace("Ticket 13 品牌", vec!["确定性发布".to_string()])
            .unwrap();
        for id in ["session-13", "session-b"] {
            store
                .commit_session(
                    &workspace.id,
                    SessionCommit {
                        id: id.to_string(),
                        title: id.to_string(),
                        title_source: SessionTitleSource::User,
                    },
                )
                .unwrap();
        }
        let now_ms = 1_787_030_400_000_i64;
        let now = now_iso(now_ms);
        let scheduled_at = now_iso(now_ms + scheduled_offset_ms);
        let body_marker = "TICKET13_APPROVED_BODY_MUST_NOT_ENTER_AUDIT".to_string();
        let connection = open_database(&workspace).unwrap();
        connection.execute("INSERT INTO knowledge_raw_inputs (id,session_id,input_text,origin,intent,created_at) VALUES ('raw-13','session-13','行业事实','user-stated','knowledge-update',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_fact_candidates (id,raw_input_id,session_id,subject,predicate,scope_json,fact_key,value_json,normalized_value_json,excerpt,confidence,profile_provenance,origin,intent,status,base_version,proposed_at,resolved_at) VALUES ('candidate-13','raw-13','session-13','品牌','enterprise-profile.industry','{}','industry','\"科技\"','\"科技\"','科技',1.0,'asked','user-stated','knowledge-update','adopted',0,?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_decisions (id,candidate_id,decision,actor_id,actor_session_id,expected_version,before_json,after_json,reason,decided_at) VALUES ('decision-13','candidate-13','adopt-new','desktop-user','session-13',0,NULL,'\"科技\"','fixture',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_versions (version,decision_id,actor_session_id,snapshot_hash,created_at) VALUES (1,'decision-13','session-13','knowledge-hash-13',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('article-operation-13','session-13','article-generation-completed',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_article_operations (operation_id,created_by_session_id,source_kind,topic_plan_id,topic_plan_revision,knowledge_version,product_line,target_region,policy_version,operation_spec_json,status,created_at,updated_at) VALUES ('article-operation-13','session-13','direct',NULL,NULL,1,'确定性发布','中国','fixture-policy','{}','completed',?1,?1)", [&now]).unwrap();

        let mut articles = Vec::new();
        let mut candidates = Vec::new();
        let mut assignments = Vec::new();
        for index in 0..article_count {
            let article_id = if index == 0 {
                format!("article-{}", "long-identifier-".repeat(8))
            } else {
                format!("article-{}", index + 1)
            };
            let title = format!("批准文章 {}", index + 1);
            let body = format!("# {title}\n\n{body_marker} {}", index + 1);
            let approved_path = format!("articles/approved/{article_id}/v1.md");
            let full_path = workspace.root_path.join(&approved_path);
            std::fs::create_dir_all(full_path.parent().unwrap()).unwrap();
            std::fs::write(&full_path, body.as_bytes()).unwrap();
            let body_hash = sha256_hex(body.as_bytes());
            connection.execute("INSERT INTO geo_articles (id,operation_id,source_plan_item_id,knowledge_version,content_type,topic,requested_title,constraints,planned_facts_json,status,revision,approved_revision,generation_attempt,created_at,updated_at) VALUES (?1,'article-operation-13',NULL,1,'guide','确定性发布',?2,'','[]','approved',1,1,1,?3,?3)", params![article_id, title, now]).unwrap();
            connection.execute("INSERT INTO geo_article_versions (article_id,revision,title,body_path,approved_body_path,body_sha256,origin,based_on_revision,review_json,model_audit_json,created_by_session_id,created_at,approved_at) VALUES (?1,1,?2,?3,?3,?4,'generated',NULL,'{}','{}','session-13',?5,?5)", params![article_id, title, approved_path, body_hash, now]).unwrap();
            let resource_id = 800 + index as i64;
            articles.push(json!({"id":article_id,"operationId":"article-operation-13","approvedRevision":1,"title":title,"topic":"确定性发布","contentType":"guide"}));
            candidates.push(json!({"resourceId":resource_id,"kind":if index % 2 == 0 {"media"} else {"we-media"},"name":format!("真实渠道 {}",index+1),"estimatedPriceCny":10.0+index as f64,"publishedRate":90.0}));
            assignments.push(json!({"articleId":article_id,"resourceId":resource_id,"reason":"weighted-score","scheduledAt":scheduled_at}));
        }
        let plan_id = "confirmed-distribution-plan-13".to_string();
        let projection = json!({"id":plan_id,"status":"confirmed","revision":5,"articles":articles,"candidates":candidates,"assignments":assignments,"perArticleMaxPoints":3_200,"totalMaxPoints":16_000,"budgetCny":500.0,"publishStartAt":scheduled_at});
        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('distribution-operation-13','session-13','distribution-plan-confirmed',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_distribution_plans (id,operation_id,created_by_session_id,article_operation_id,knowledge_version,policy_version,status,revision,discovery_claim_token,provider_snapshot_json,resource_snapshot_json,projection_json,created_at,updated_at,confirmed_at) VALUES (?1,'distribution-operation-13','session-13','article-operation-13',1,'fixture-policy','confirmed',5,NULL,'{}','[]',?2,?3,?3,?3)", params![plan_id, projection.to_string(), now]).unwrap();
        Fixture {
            store,
            workspace,
            now_ms,
            plan_id,
            body_marker,
        }
    }

    fn preview(fixture: &Fixture) -> PublishExecutionProjection {
        fixture
            .store
            .prepare_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishPreviewRequest {
                    plan_id: Some(fixture.plan_id.clone()),
                },
            )
            .unwrap()
    }

    fn confirm_start(
        fixture: &Fixture,
        preview: &PublishExecutionProjection,
    ) -> PublishExecutionProjection {
        let confirmed = fixture
            .store
            .confirm_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishConfirmRequest {
                    execution_id: preview.id.clone(),
                    expected_revision: preview.revision,
                    confirmation_digest: preview.confirmation_digest.clone(),
                },
            )
            .unwrap();
        fixture
            .store
            .start_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishStartRequest {
                    execution_id: confirmed.id,
                    expected_revision: confirmed.revision,
                },
                fixture.now_ms,
            )
            .unwrap()
    }

    fn scheduler(
        fixture: &Fixture,
        provider: Arc<MockProvider>,
        clock: Arc<AtomicI64>,
    ) -> PublishScheduler {
        PublishScheduler::new(
            fixture.store.clone(),
            provider,
            Arc::new(move || clock.load(Ordering::SeqCst)),
        )
    }

    fn insert_replacement_plan(fixture: &Fixture, plan_id: &str, scheduled_offset_ms: i64) {
        let connection = open_database(&fixture.workspace).unwrap();
        let original: String = connection
            .query_row(
                "SELECT projection_json FROM geo_distribution_plans WHERE id=?1",
                [&fixture.plan_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut projection: Value = serde_json::from_str(&original).unwrap();
        let scheduled = now_iso(fixture.now_ms + scheduled_offset_ms);
        projection["id"] = json!(plan_id);
        projection["revision"] = json!(6);
        projection["budgetCny"] = json!(650.0);
        projection["publishStartAt"] = json!(scheduled);
        for assignment in projection["assignments"].as_array_mut().unwrap() {
            assignment["scheduledAt"] = json!(scheduled);
        }
        let operation_id = format!("operation-{plan_id}");
        let updated = now_iso(fixture.now_ms + 1_000);
        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES (?1,'session-13','distribution-plan-confirmed',?2)", params![operation_id, updated]).unwrap();
        connection.execute("INSERT INTO geo_distribution_plans (id,operation_id,created_by_session_id,article_operation_id,knowledge_version,policy_version,status,revision,discovery_claim_token,provider_snapshot_json,resource_snapshot_json,projection_json,created_at,updated_at,confirmed_at) VALUES (?1,?2,'session-13','article-operation-13',1,'fixture-policy','confirmed',6,NULL,'{}','[]',?3,?4,?4,?4)", params![plan_id, operation_id, projection.to_string(), updated]).unwrap();
    }

    #[test]
    fn channel_price_points_matches_gateway_ceiling_formula() {
        // 与网关 publishOrderPoints 同式：ceil(分 × 4 / 25)。
        assert_eq!(publish_channel_price_points(88.0), 1408);
        assert_eq!(publish_channel_price_points(12.34), 198);
        // 整除边界不得多进一位：6.25 元 × 16 = 100 点恰好整除。
        assert_eq!(publish_channel_price_points(6.25), 100);
        // 最小可用单价向上取整到 1 点。
        assert_eq!(publish_channel_price_points(0.01), 1);
        assert_eq!(publish_channel_price_points(0.0), 0);
        assert_eq!(publish_channel_price_points(-3.0), 0);
        assert_eq!(publish_channel_price_points(f64::NAN), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn execution_projection_carries_per_item_and_total_price_points() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 60_000);
        let execution = preview(&fixture);
        // fixture 渠道价 ¥10.00 → 160 点、¥11.00 → 176 点；总价为逐项之和。
        let expected: Vec<i64> = execution
            .items
            .iter()
            .map(|item| publish_channel_price_points(item.channel.estimated_price_cny))
            .collect();
        assert_eq!(expected, vec![160, 176]);
        for (item, points) in execution.items.iter().zip(expected.iter()) {
            assert_eq!(item.channel.price_points, *points);
        }
        assert_eq!(execution.total_price_points, 336);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn legacy_channel_rows_without_price_points_still_project_points() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 60_000);
        let execution = preview(&fixture);
        // 模拟票 09 之前落库的 channel_json（无 pricePoints 字段）：读取投影
        // 时按媒介价重算回填，旧执行不因缺字段丢失单价与总价。
        let connection = open_database(&fixture.workspace).unwrap();
        let channel_json: String = connection
            .query_row(
                "SELECT channel_json FROM geo_publish_items WHERE execution_id=?1",
                [&execution.id],
                |row| row.get(0),
            )
            .unwrap();
        let mut legacy: Value = serde_json::from_str(&channel_json).unwrap();
        legacy.as_object_mut().unwrap().remove("pricePoints");
        connection
            .execute(
                "UPDATE geo_publish_items SET channel_json=?1 WHERE execution_id=?2",
                params![legacy.to_string(), execution.id],
            )
            .unwrap();
        let reread = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &execution.id)
            .unwrap();
        assert_eq!(reread.items[0].channel.price_points, 160);
        assert_eq!(reread.total_price_points, 160);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn readonly_latest_execution_read_does_not_require_a_session_row() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 60_000);
        let empty_brand = fixture.store.create_workspace("空品牌", vec![]).unwrap();
        assert!(fixture
            .store
            .latest_publish_execution_readonly(&empty_brand.id)
            .unwrap()
            .is_none());
        let execution = preview(&fixture);
        // A committed session still gates the sidecar-facing read…
        assert_eq!(
            fixture
                .store
                .latest_publish_execution(&fixture.workspace.id, "never-committed-session")
                .unwrap_err(),
            "publish_scheduler_session_not_found"
        );
        // …while the WebView projection read stays available without one.
        let latest = fixture
            .store
            .latest_publish_execution_readonly(&fixture.workspace.id)
            .unwrap()
            .unwrap();
        assert_eq!(latest.id, execution.id);
        assert_eq!(latest.workspace_id, execution.workspace_id);
        assert_eq!(latest.items.len(), execution.items.len());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn gate_future_schedule_restart_and_exact_payload_are_deterministic() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 60_000);
        let execution = preview(&fixture);
        assert_eq!(
            fixture
                .store
                .start_publish_execution(
                    &fixture.workspace.id,
                    "session-13",
                    PublishStartRequest {
                        execution_id: execution.id.clone(),
                        expected_revision: execution.revision,
                    },
                    fixture.now_ms,
                )
                .unwrap_err(),
            "publish_execution_not_startable"
        );
        assert!(execution.items[0].idempotency_key.len() > 64);
        assert_eq!(execution.items[0].external_request_sn.len(), 46);
        let started = confirm_start(&fixture, &execution);
        assert_eq!(started.status, "scheduled");
        assert_eq!(
            fixture
                .store
                .start_publish_execution(
                    &fixture.workspace.id,
                    "session-b",
                    PublishStartRequest {
                        execution_id: started.id.clone(),
                        expected_revision: started.revision,
                    },
                    fixture.now_ms,
                )
                .unwrap_err(),
            "publish_execution_not_startable"
        );

        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (0, 0));
        clock.store(fixture.now_ms + 60_000, Ordering::SeqCst);
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (1, 1));
        {
            let submissions = provider.submissions.lock().unwrap();
            let request = &submissions[0];
            // 载荷哈希冻结确定性对象键（票 08）：Rust 传 executionId+itemId，
            // 幂等 sn 由 sidecar 派生，请求本身不再携带 sn。
            assert_eq!(request.per_article_max_points, 3_200);
            assert_eq!(request.execution_max_points, 16_000);
            let started_projection = fixture
                .store
                .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
                .unwrap();
            let item = &started_projection.items[0];
            let structural = if request.kind == "media" {
                "media-order-v1"
            } else {
                "publish_form=1|publish_type=1|account_rule=2"
            };
            assert_eq!(item.external_request_sn.len(), 46);
            assert_eq!(
                item.payload_hash,
                sha256_hex(format!(
                    "sn={}|kind={}|resource_id={}|title={}|content-key={}|{}",
                    item.external_request_sn,
                    request.kind,
                    request.resource_id,
                    request.title,
                    item.object_key,
                    structural
                ))
            );
        }

        // A new app-managed scheduler after the Session/Sidecar disappeared
        // observes the persisted submitted item and does not run it again.
        scheduler(&fixture, provider.clone(), clock)
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (1, 1));
        let exact = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(exact.status, "succeeded");
        assert_eq!(
            exact.items[0].external_order_id.as_deref(),
            Some("provider-order-13")
        );
        let connection = open_database(&fixture.workspace).unwrap();
        let audit: String = connection
            .query_row(
                "SELECT GROUP_CONCAT(detail_json, '') FROM geo_publish_audit",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!audit.contains(&fixture.body_marker));
        // 网关 egress（票 08）：Rust 侧不再持有任何 Provider 凭据，审计里
        // 也不应出现网关基地址等传输细节。
        assert!(!audit.contains(TEST_GATEWAY_BASE));
        assert!(audit.contains("provider-order-13"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn concurrent_claim_partial_success_and_safe_retry_preserve_completed_item() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::with_submit_outcomes(vec![
            PublishProviderOutcome::Success(PublishOrderReceipt {
                external_order_id: "order-first".to_string(),
            }),
            PublishProviderOutcome::SafeRetryable {
                code: "distribution-rate-limited".to_string(),
                reason: "明确未受理".to_string(),
            },
            PublishProviderOutcome::Success(PublishOrderReceipt {
                external_order_id: "order-second".to_string(),
            }),
        ]));
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        let first = scheduler(&fixture, provider.clone(), clock.clone());
        let second = scheduler(&fixture, provider.clone(), clock.clone());
        let (a, b) = tokio::join!(
            first.tick_workspace(&fixture.workspace),
            second.tick_workspace(&fixture.workspace)
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(provider.counts(), (2, 2));
        let partial = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(partial.status, "partially-succeeded");
        assert_eq!(partial.items[0].status, "submitted");
        assert_eq!(partial.items[1].status, "failed-retryable");

        clock.store(fixture.now_ms + RETRY_BACKOFF_MS[0], Ordering::SeqCst);
        first.tick_workspace(&fixture.workspace).await.unwrap();
        assert_eq!(provider.counts(), (2, 3));
        let done = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(done.status, "succeeded");
        assert_eq!(
            done.items[0].external_order_id.as_deref(),
            Some("order-first")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn parked_backoff_item_does_not_block_later_sequence_items() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        // 手工复现 2026-09-01 事故落库形态：sequence=1 的 item 上传失败
        // 进入退避停车（next_attempt 在 21 分钟后）。
        let parked_until = fixture.now_ms + 21 * 60_000;
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute(
                "UPDATE geo_publish_items SET status='failed-retryable',
                 upload_attempts=1, next_attempt_at_ms=?2,
                 failure_code='object-storage-sidecar-transport',
                 failure_reason='Sidecar 控制面响应失败（HTTP 400）'
                 WHERE execution_id=?1 AND sequence=1",
                params![started.id, parked_until],
            )
            .unwrap();
        drop(connection);

        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        // 退避窗口内：后续 sequence=2 不被停车的前序阻塞，照常上传+下单。
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (1, 1));
        let progressing = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(progressing.items[0].status, "failed-retryable");
        assert_eq!(progressing.items[1].status, "submitted");

        // 退避到期：停车单凭更小 sequence 回到队首被重试，执行最终收尾。
        clock.store(parked_until, Ordering::SeqCst);
        scheduler(&fixture, provider.clone(), clock)
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (2, 2));
        let done = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(done.status, "succeeded");
        assert_eq!(done.items[0].status, "submitted");
    }

    /// 取消语义（2026-09）：在途单的当前阶段跑完（上传落 uploaded、不再
    /// 下单），其余未完结条目转 cancelled；在途 settle 后 refresh 不把
    /// cancelled 执行倒灌回 running；「重新发布」可复活取消执行里的条目
    /// （含卡在 uploaded 的孤儿在途单，凭保留的 object_url 直接补下单）。
    #[tokio::test(flavor = "current_thread")]
    async fn cancel_parks_unfinished_items_and_lets_inflight_attempt_finish() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 0);
        let started = confirm_start(&fixture, &preview(&fixture));

        // 在途窗口：upload 阻塞到显式放行，制造「取消时恰有一单正在
        // 上传」的真实竞态。
        let gate = Arc::new(tokio::sync::Notify::new());
        let upload_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct BlockingUploadProvider {
            gate: Arc<tokio::sync::Notify>,
            entered: Arc<std::sync::atomic::AtomicBool>,
        }
        impl PublishProvider for BlockingUploadProvider {
            fn upload<'a>(
                &'a self,
                request: PublishUploadRequest,
            ) -> ProviderFuture<'a, PublishUploadReceipt> {
                Box::pin(async move {
                    self.entered.store(true, Ordering::SeqCst);
                    self.gate.notified().await;
                    PublishProviderOutcome::Success(PublishUploadReceipt {
                        object_url: format!("https://cdn.example.test/{}", request.object_key),
                        external_content_id: request.object_key.clone(),
                    })
                })
            }
            fn upload_images<'a>(
                &'a self,
                request: PublishImageUploadRequest,
            ) -> ProviderFuture<'a, PublishImageUploadReceipt> {
                Box::pin(async move {
                    let urls = request
                        .images
                        .iter()
                        .map(|image| {
                            (
                                image.image_id.clone(),
                                format!("https://cdn.example.test/images/{}", image.sha256),
                            )
                        })
                        .collect();
                    PublishProviderOutcome::Success(PublishImageUploadReceipt { urls })
                })
            }
            fn submit<'a>(
                &'a self,
                request: PublishOrderRequest,
            ) -> ProviderFuture<'a, PublishOrderReceipt> {
                Box::pin(async move {
                    let _ = request;
                    PublishProviderOutcome::Success(PublishOrderReceipt {
                        external_order_id: "order-after-cancel-race".to_string(),
                    })
                })
            }
        }

        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        let runner = PublishScheduler::new(
            fixture.store.clone(),
            Arc::new(BlockingUploadProvider {
                gate: gate.clone(),
                entered: upload_entered.clone(),
            }),
            Arc::new(move || clock.load(Ordering::SeqCst)),
        );
        let workspace = fixture.workspace.clone();
        // tick 绑定当前 #[tokio::test] runtime（current_thread 语义），不适用
        // tauri::async_runtime 红线——该红线针对生产代码的无 caller context 场景。
        #[allow(clippy::disallowed_methods)]
        let tick = tokio::spawn(async move { runner.tick_workspace(&workspace).await });
        while !upload_entered.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        // 取消时 seq=1 在途（uploading），seq=2 pending。
        let cancelled = fixture
            .store
            .cancel_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishCancelRequest {
                    execution_id: started.id.clone(),
                    expected_revision: started.revision,
                },
                fixture.now_ms,
            )
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert_eq!(cancelled.items[0].status, "uploading");
        assert_eq!(cancelled.items[1].status, "cancelled");

        // 放行在途上传：settle 落库为 uploaded；执行保持 cancelled，后续
        // tick 不再认领（下单永不发生）。
        gate.notify_one();
        tick.await.unwrap().unwrap();
        let parked = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(parked.status, "cancelled");
        assert_eq!(parked.items[0].status, "uploaded");
        assert_eq!(parked.items[1].status, "cancelled");

        // 重新发布复活在途孤儿（uploaded 保留 object_url，直接补下单）。
        let revived = fixture
            .store
            .retry_publish_item(
                &fixture.workspace.id,
                "session-13",
                PublishRetryRequest {
                    execution_id: started.id.clone(),
                    item_id: parked.items[0].id.clone(),
                    expected_item_revision: parked.items[0].revision,
                },
                fixture.now_ms + 1_000,
            )
            .unwrap();
        assert_eq!(revived.status, "running");
        assert_eq!(revived.items[0].status, "pending");
        assert_eq!(revived.items[1].status, "cancelled");

        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms + 2_000));
        scheduler(&fixture, provider.clone(), clock)
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (0, 1));
        let finished = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(finished.items[0].status, "submitted");
        assert_eq!(finished.items[1].status, "cancelled");
    }

    /// 非重试失败（如余额不足）落终态后，「重新发布」清零重试计数复活，
    /// 执行从 failed 终态回到调度并最终成功。
    #[tokio::test(flavor = "current_thread")]
    async fn republish_revives_failed_nonretryable_item() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::with_submit_outcomes(vec![
            PublishProviderOutcome::NonRetryable {
                code: "distribution-insufficient-balance".to_string(),
                reason: "余额不足".to_string(),
            },
        ]));
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (1, 1));
        let failed = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.items[0].status, "failed-nonretryable");

        let revived = fixture
            .store
            .retry_publish_item(
                &fixture.workspace.id,
                "session-13",
                PublishRetryRequest {
                    execution_id: started.id.clone(),
                    item_id: failed.items[0].id.clone(),
                    expected_item_revision: failed.items[0].revision,
                },
                fixture.now_ms + 1_000,
            )
            .unwrap();
        assert_eq!(revived.items[0].status, "pending");
        assert_eq!(revived.items[0].attempts, 0);
        assert!(revived.items[0].finished_at.is_none());

        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms + 2_000));
        scheduler(&fixture, provider, clock)
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        let done = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(done.status, "succeeded");
        assert_eq!(done.items[0].status, "submitted");
    }

    /// 存量库迁移：CHECK 约束不含 'cancelled' 的两张表按原文重建后可写
    /// cancelled；已含 cancelled 的 DDL 幂等跳过。
    #[test]
    fn publish_status_check_migration_extends_legacy_tables() {
        let connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE geo_publish_executions (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK(status IN (
                        'awaiting-confirmation','confirmed','running','scheduled',
                        'partially-succeeded','succeeded','failed','reconciliation-required'
                        ,'superseded'
                    )),
                    revision INTEGER NOT NULL
                 );
                 CREATE TABLE geo_publish_items (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK(status IN (
                        'pending','uploading','uploaded','submitting','submitted',
                        'failed-retryable','failed-nonretryable','reconciliation-required'
                    )),
                    revision INTEGER NOT NULL
                 );
                 INSERT INTO geo_publish_executions VALUES ('e1','scheduled',1);
                 INSERT INTO geo_publish_items VALUES ('i1','pending',1);",
            )
            .unwrap();
        extend_publish_status_checks(&connection).unwrap();
        connection
            .execute(
                "UPDATE geo_publish_executions SET status='cancelled' WHERE id='e1'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE geo_publish_items SET status='cancelled' WHERE id='i1'",
                [],
            )
            .unwrap();
        // 幂等：迁移后的 DDL 已含 'cancelled'，再次执行直接跳过。
        extend_publish_status_checks(&connection).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unknown_outcome_and_expired_submission_never_auto_retry() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::with_submit_outcomes(vec![
            PublishProviderOutcome::Unknown {
                code: "distribution-transport-unknown".to_string(),
                reason: "受理结果未知".to_string(),
            },
        ]));
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        let runner = scheduler(&fixture, provider.clone(), clock);
        runner.tick_workspace(&fixture.workspace).await.unwrap();
        assert_eq!(provider.counts(), (1, 1));
        let unknown = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(unknown.status, "reconciliation-required");
        runner.tick_workspace(&fixture.workspace).await.unwrap();
        assert_eq!(provider.counts(), (1, 1));

        let second = setup_fixture(1, 0);
        let second_started = confirm_start(&second, &preview(&second));
        open_database(&second.workspace)
            .unwrap()
            .execute(
                "UPDATE geo_publish_items SET status='submitting',
                 object_url='https://cdn.example.test/existing.html', claim_token='crashed',
                 lease_until_ms=?1 WHERE execution_id=?2",
                params![second.now_ms - 1, second_started.id],
            )
            .unwrap();
        let no_calls = Arc::new(MockProvider::default());
        scheduler(
            &second,
            no_calls.clone(),
            Arc::new(AtomicI64::new(second.now_ms)),
        )
        .tick_workspace(&second.workspace)
        .await
        .unwrap();
        assert_eq!(no_calls.counts(), (0, 0));
        assert_eq!(
            second
                .store
                .get_publish_execution(&second.workspace.id, "session-13", &second_started.id)
                .unwrap()
                .status,
            "reconciliation-required"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn nonretryable_failure_is_terminal_and_approved_body_change_blocks_egress() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::with_submit_outcomes(vec![
            PublishProviderOutcome::NonRetryable {
                code: "distribution-rejected".to_string(),
                reason: "渠道明确拒绝".to_string(),
            },
        ]));
        let runner = scheduler(
            &fixture,
            provider.clone(),
            Arc::new(AtomicI64::new(fixture.now_ms)),
        );
        runner.tick_workspace(&fixture.workspace).await.unwrap();
        assert_eq!(provider.counts(), (1, 1));
        let failed = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.items[0].status, "failed-nonretryable");
        assert_eq!(failed.items[0].next_attempt_at, None);
        assert!(failed.items[0].started_at.is_some());
        assert!(failed.items[0].finished_at.is_some());
        runner.tick_workspace(&fixture.workspace).await.unwrap();
        assert_eq!(provider.counts(), (1, 1));

        let changed = setup_fixture(1, 0);
        let changed_started = confirm_start(&changed, &preview(&changed));
        let body_path: String = open_database(&changed.workspace)
            .unwrap()
            .query_row(
                "SELECT approved_body_path FROM geo_publish_items WHERE execution_id=?1",
                [&changed_started.id],
                |row| row.get(0),
            )
            .unwrap();
        std::fs::write(
            changed.workspace.root_path.join(body_path),
            "changed after approval",
        )
        .unwrap();
        let no_egress = Arc::new(MockProvider::default());
        scheduler(
            &changed,
            no_egress.clone(),
            Arc::new(AtomicI64::new(changed.now_ms)),
        )
        .tick_workspace(&changed.workspace)
        .await
        .unwrap();
        assert_eq!(no_egress.counts(), (0, 0));
        assert_eq!(
            changed
                .store
                .get_publish_execution(&changed.workspace.id, "session-13", &changed_started.id)
                .unwrap()
                .items[0]
                .failure_code
                .as_deref(),
            Some("approved-body-mismatch")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rotation_between_claim_and_egress_makes_zero_provider_calls() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let claim = claim_next_item(&fixture.workspace, fixture.now_ms)
            .unwrap()
            .unwrap();
        // 网关身份在 claim 后被替换（开发期网关切换/账号会话换网关）：执行前
        // 快照比对失败，零外发请求。
        set_test_gateway_base(Some("https://rotated-gateway.example.test"));
        let provider = Arc::new(MockProvider::default());
        scheduler(
            &fixture,
            provider.clone(),
            Arc::new(AtomicI64::new(fixture.now_ms)),
        )
        .execute_claim(&fixture.workspace, claim, fixture.now_ms)
        .await
        .unwrap();
        assert_eq!(provider.counts(), (0, 0));
        let result = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(result.status, "reconciliation-required");
        assert_eq!(
            result.items[0].failure_code.as_deref(),
            Some("provider-configuration-changed")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn provider_side_rotation_is_reconciliation_not_safe_retry() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        confirm_start(&fixture, &preview(&fixture));
        let claim = claim_next_item(&fixture.workspace, fixture.now_ms)
            .unwrap()
            .unwrap();
        settle_upload(
            &fixture.workspace,
            &claim,
            PublishProviderOutcome::Unknown {
                code: "object-storage-configuration-changed".to_string(),
                reason: "配置变化且未发出请求".to_string(),
            },
            fixture.now_ms,
        )
        .unwrap();
        let result = fixture
            .store
            .latest_publish_execution(&fixture.workspace.id, "session-13")
            .unwrap()
            .unwrap();
        assert_eq!(result.status, "reconciliation-required");
        assert_eq!(result.items[0].next_attempt_at, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn upload_receipt_is_settled_against_frozen_object_key_after_configuration_rotates() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        confirm_start(&fixture, &preview(&fixture));
        let claim = claim_next_item(&fixture.workspace, fixture.now_ms)
            .unwrap()
            .unwrap();
        let frozen_object_key = claim.object_key.clone();

        // Model a gateway identity rotation after OSS accepted the frozen-A
        // upload but before its receipt is durably settled. Settlement binds
        // the frozen object key, not the transport identity — it must not
        // reload the snapshot and reinterpret a successful A receipt.
        set_test_gateway_base(Some("https://rotated-gateway.example.test"));
        let settled_url = format!("https://cdn.example.test/{frozen_object_key}");
        settle_upload(
            &fixture.workspace,
            &claim,
            PublishProviderOutcome::Success(PublishUploadReceipt {
                object_url: settled_url.clone(),
                external_content_id: frozen_object_key.clone(),
            }),
            fixture.now_ms,
        )
        .unwrap();

        let result = fixture
            .store
            .latest_publish_execution(&fixture.workspace.id, "session-b")
            .unwrap()
            .unwrap();
        assert_eq!(result.items[0].status, "uploaded");
        assert_eq!(
            result.items[0].object_url.as_deref(),
            Some(settled_url.as_str())
        );
        assert_eq!(result.items[0].failure_code, None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn one_preview_freezes_one_provider_base_and_fingerprint_for_all_items() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 0);
        PROVIDER_EXECUTION_CONTEXT_LOADS.store(0, std::sync::atomic::Ordering::SeqCst);
        let execution = preview(&fixture);

        assert_eq!(
            PROVIDER_EXECUTION_CONTEXT_LOADS.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(execution.items.len(), 2);
        assert!(execution.provider_snapshot.object_storage.configured);
        assert!(execution
            .provider_snapshot
            .object_storage
            .configuration_fingerprint
            .is_some());
        assert!(execution
            .provider_snapshot
            .distribution
            .configuration_fingerprint
            .is_some());
        for item in &execution.items {
            // 预览冻结网关传输快照与确定性对象键（票 08）：URL 由网关在
            // 上传时按服务器侧 OSS 公网基地址解析。
            assert_eq!(
                item.request_summary.planned_object_url,
                format!("gateway-oss://{}", item.object_key)
            );
            let structural = if item.channel.kind == "media" {
                "media-order-v1"
            } else {
                "publish_form=1|publish_type=1|account_rule=2"
            };
            assert_eq!(
                item.payload_hash,
                sha256_hex(format!(
                    "sn={}|kind={}|resource_id={}|title={}|content-key={}|{}",
                    item.external_request_sn,
                    item.channel.kind,
                    item.channel.resource_id,
                    item.article.title,
                    item.object_key,
                    structural
                ))
            );
        }
        assert_ne!(
            execution.items[0].request_summary.planned_object_url,
            execution.items[1].request_summary.planned_object_url
        );
    }

    #[test]
    fn external_request_sn_is_bounded_and_binds_channel_and_revision_for_long_ids() {
        let article = "article-".to_string() + &"very-long-identifier-".repeat(20);
        let first = external_request_sn(&format!("article-{article}-channel-8-v3"));
        let other_channel = external_request_sn(&format!("article-{article}-channel-9-v3"));
        let other_revision = external_request_sn(&format!("article-{article}-channel-8-v4"));
        assert!(first.len() <= 64);
        assert_ne!(first, other_channel);
        assert_ne!(first, other_revision);
        assert_eq!(
            first,
            external_request_sn(&format!("article-{article}-channel-8-v3"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_revision_recomputes_digest_and_keeps_ui_confirm_authority() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 3_600_000);
        let execution = preview(&fixture);

        // 跨 Session 修订被拒。
        assert_eq!(
            fixture
                .store
                .revise_publish_execution(
                    &fixture.workspace.id,
                    "session-b",
                    PublishRevisionRequest {
                        execution_id: execution.id.clone(),
                        expected_revision: execution.revision,
                        budget_cny: None,
                        publish_start_at: None,
                        item_updates: vec![],
                        actor_id: "desktop-user".to_string(),
                        reason: "改预算".to_string(),
                    },
                )
                .unwrap_err(),
            "publish_execution_session_mismatch"
        );

        // 逐项排期 + 预算修订：状态保持待决、摘要重算、revision 递增。
        let item_id = execution.items[0].id.clone();
        let new_schedule = now_iso(fixture.now_ms + 7_200_000);
        let revised = fixture
            .store
            .revise_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishRevisionRequest {
                    execution_id: execution.id.clone(),
                    expected_revision: execution.revision,
                    budget_cny: Some(600.0),
                    publish_start_at: None,
                    item_updates: vec![PublishItemScheduleUpdate {
                        item_id: item_id.clone(),
                        scheduled_at: new_schedule.clone(),
                    }],
                    actor_id: "desktop-user".to_string(),
                    reason: "第一篇推迟两小时，预算提到 600".to_string(),
                },
            )
            .unwrap();
        assert_eq!(revised.status, "awaiting-confirmation");
        assert_eq!(revised.revision, execution.revision + 1);
        assert_eq!(revised.budget_cny, 600.0);
        assert_eq!(revised.items[0].scheduled_at, new_schedule);
        assert_ne!(revised.confirmation_digest, execution.confirmation_digest);

        // 修订审计携带用户指令原文。
        let (audit_rows, audit_detail): (i64, String) = open_database(&fixture.workspace)
            .unwrap()
            .query_row(
                "SELECT COUNT(*), MAX(detail_json) FROM geo_publish_audit
                 WHERE execution_id=?1 AND event_type='revision'",
                [&execution.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(audit_rows, 1);
        assert!(audit_detail.contains("第一篇推迟两小时，预算提到 600"));

        // 旧摘要即刻失效：必须对新摘要重新走 UI 确认。
        assert_eq!(
            fixture
                .store
                .confirm_publish_execution(
                    &fixture.workspace.id,
                    "session-13",
                    PublishConfirmRequest {
                        execution_id: execution.id.clone(),
                        expected_revision: revised.revision,
                        confirmation_digest: execution.confirmation_digest.clone(),
                    },
                )
                .unwrap_err(),
            "publish_execution_confirmation_conflict"
        );
        let confirmed = fixture
            .store
            .confirm_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishConfirmRequest {
                    execution_id: execution.id.clone(),
                    expected_revision: revised.revision,
                    confirmation_digest: revised.confirmation_digest.clone(),
                },
            )
            .unwrap();
        assert_eq!(confirmed.status, "confirmed");

        // 确认后不可再修订。
        assert_eq!(
            fixture
                .store
                .revise_publish_execution(
                    &fixture.workspace.id,
                    "session-13",
                    PublishRevisionRequest {
                        execution_id: execution.id.clone(),
                        expected_revision: confirmed.revision,
                        budget_cny: Some(700.0),
                        publish_start_at: None,
                        item_updates: vec![],
                        actor_id: "desktop-user".to_string(),
                        reason: "改已确认的执行".to_string(),
                    },
                )
                .unwrap_err(),
            "publish_execution_already_immutable"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn chat_revision_rejects_budget_below_estimated_spend() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 3_600_000);
        let execution = preview(&fixture);
        assert_eq!(
            fixture
                .store
                .revise_publish_execution(
                    &fixture.workspace.id,
                    "session-13",
                    PublishRevisionRequest {
                        execution_id: execution.id,
                        expected_revision: execution.revision,
                        budget_cny: Some(1.0),
                        publish_start_at: None,
                        item_updates: vec![],
                        actor_id: "desktop-user".to_string(),
                        reason: "把预算砍到 1 元".to_string(),
                    },
                )
                .unwrap_err(),
            "publish_budget_exceeded"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn awaiting_preview_can_be_superseded_but_confirmed_execution_cannot() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 3_600_000);
        let old = preview(&fixture);
        insert_replacement_plan(&fixture, "replacement-plan-13", 7_200_000);
        let replacement = fixture
            .store
            .prepare_publish_execution(
                &fixture.workspace.id,
                "session-13",
                PublishPreviewRequest {
                    plan_id: Some("replacement-plan-13".to_string()),
                },
            )
            .unwrap();
        assert_eq!(replacement.distribution_plan_id, "replacement-plan-13");
        assert_eq!(old.items[0].payload_hash, replacement.items[0].payload_hash);
        assert_eq!(
            fixture
                .store
                .get_publish_execution(&fixture.workspace.id, "session-b", &old.id)
                .unwrap()
                .status,
            "superseded"
        );
        assert_eq!(
            fixture
                .store
                .confirm_publish_execution(
                    &fixture.workspace.id,
                    "session-13",
                    PublishConfirmRequest {
                        execution_id: old.id,
                        expected_revision: old.revision + 1,
                        confirmation_digest: old.confirmation_digest,
                    },
                )
                .unwrap_err(),
            "publish_execution_already_immutable"
        );
        let started = confirm_start(&fixture, &replacement);
        assert_eq!(started.status, "scheduled");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn different_payload_duplicate_preserves_submitted_truth_and_external_id() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::default());
        scheduler(&fixture, provider, Arc::new(AtomicI64::new(fixture.now_ms)))
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        open_database(&fixture.workspace)
            .unwrap()
            .execute(
                "UPDATE geo_article_versions SET title='被改变的外部标题' WHERE article_id=(SELECT article_id FROM geo_publish_items WHERE execution_id=?1)",
                [&started.id],
            )
            .unwrap();
        insert_replacement_plan(&fixture, "conflicting-plan-13", 60_000);
        assert_eq!(
            fixture
                .store
                .prepare_publish_execution(
                    &fixture.workspace.id,
                    "session-13",
                    PublishPreviewRequest {
                        plan_id: Some("conflicting-plan-13".to_string()),
                    },
                )
                .unwrap_err(),
            "publish_idempotency_payload_conflict"
        );
        let historical = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(historical.status, "succeeded");
        assert_eq!(historical.items[0].status, "submitted");
        assert_eq!(
            historical.items[0].external_order_id.as_deref(),
            Some("provider-order-13")
        );
    }

    // ── 票 08：网关 egress 传输切换的确定性测试 ────────────────────────────

    #[tokio::test(flavor = "current_thread")]
    async fn gateway_snapshot_tracks_admission_identity_and_fails_closed_without_it() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let configured = configured_provider_snapshot().unwrap();
        assert!(configured.object_storage.configured);
        assert!(configured.distribution.configured);
        assert_eq!(configured.object_storage.endpoint_family, "gateway-oss-put");
        assert_eq!(configured.distribution.endpoint_family, "gateway-order-api");
        let fingerprint = configured
            .object_storage
            .configuration_fingerprint
            .clone()
            .unwrap();

        // 账号会话不在位（未登录/网关未注入）：快照 fail-closed，确认门拒绝。
        set_test_gateway_base(None);
        let unconfigured = configured_provider_snapshot().unwrap();
        assert!(!unconfigured.object_storage.configured);
        assert!(!unconfigured.distribution.configured);
        assert_eq!(unconfigured.object_storage.configuration_fingerprint, None);

        // 网关身份变化 = 快照变化：确认后的执行沿旧幂等键会被 reconciliation。
        set_test_gateway_base(Some("https://other-gateway.example.test"));
        let rotated = configured_provider_snapshot().unwrap();
        assert_ne!(
            rotated.object_storage.configuration_fingerprint,
            Some(fingerprint)
        );
        assert_ne!(configured, rotated);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn production_provider_blocks_egress_when_gateway_identity_rotates() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let route = PublishEgressRoute {
            workspace_id: "workspace-13".to_string(),
            workspace_root: std::path::PathBuf::from("/tmp/workspace-13"),
            session_id: "session-13".to_string(),
            execution_id: "execution-13".to_string(),
            item_id: "item-13".to_string(),
        };
        let provider = ProductionPublishProvider;
        // egress 前网关身份指纹与冻结值不一致：请求不发出（无需真实
        // Sidecar——precheck 早于任何外发）。
        set_test_gateway_base(Some("https://rotated-gateway.example.test"));
        let upload_outcome = provider
            .upload(PublishUploadRequest {
                route: route.clone(),
                object_key: "articles/a.html".to_string(),
                body: b"<html></html>".to_vec(),
                expected_configuration_fingerprint: sha256_hex(
                    "gateway-publish-egress-v1|object-storage|https://gateway.example.test",
                ),
            })
            .await;
        assert!(matches!(
            upload_outcome,
            PublishProviderOutcome::Unknown { ref code, .. }
                if code == "object-storage-configuration-changed"
        ));
        let submit_outcome = provider
            .submit(PublishOrderRequest {
                route,
                per_article_max_points:
                    crate::distribution_spend_limits::DEFAULT_PER_ARTICLE_MAX_POINTS,
                execution_max_points:
                    crate::distribution_spend_limits::DEFAULT_PER_EXECUTION_MAX_POINTS,
                kind: "media".to_string(),
                resource_id: 8,
                title: "标题".to_string(),
                content_url: "https://cdn.example.test/articles/a.html".to_string(),
                expected_configuration_fingerprint: sha256_hex(
                    "gateway-publish-egress-v1|distribution|https://gateway.example.test",
                ),
            })
            .await;
        assert!(matches!(
            submit_outcome,
            PublishProviderOutcome::Unknown { ref code, .. }
                if code == "distribution-configuration-changed"
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn logged_out_reconcile_and_claim_never_brick_frozen_executions() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));

        // 事故回归：重启巡检发生在登录恢复之前——当前快照 configured=false
        // 无指纹，与建单时冻结的已登录快照不等。这只是登录态抖动，不是配置
        // 变化：巡检不得 brick，执行不得发出请求，也不得消耗重试次数。
        set_test_gateway_base(None);
        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (0, 0));
        let deferred = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(deferred.status, "running");
        assert_eq!(deferred.items[0].status, "pending");
        assert_eq!(deferred.items[0].failure_code, None);
        assert_eq!(deferred.items[0].attempts, 0);

        // 登录恢复后指纹自然匹配：无需人工对账，执行自动继续。
        set_test_gateway_base(Some(TEST_GATEWAY_BASE));
        clock.store(fixture.now_ms + LOGIN_RESUME_DEFER_MS, Ordering::SeqCst);
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (1, 1));
        let resumed = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(resumed.status, "succeeded");
        assert_eq!(resumed.items[0].status, "submitted");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reconcile_still_bricks_when_both_fingerprints_differ() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));

        // 双方都 configured 且指纹真不同（网关身份轮换）：仍是配置变化，
        // 必须 brick 并禁止沿旧幂等键执行。
        set_test_gateway_base(Some("https://rotated-gateway.example.test"));
        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (0, 0));
        let bricked = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(bricked.status, "reconciliation-required");
        assert_eq!(bricked.items[0].status, "reconciliation-required");
        assert_eq!(
            bricked.items[0].failure_code.as_deref(),
            Some("provider-configuration-changed")
        );
    }

    /// 构造「巡检误判」现场：未提交的执行被 brick 成 reconciliation-required。
    async fn brick_execution(
        fixture: &Fixture,
        started: &PublishExecutionProjection,
    ) -> PublishExecutionProjection {
        set_test_gateway_base(Some("https://rotated-gateway.example.test"));
        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        scheduler(fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (0, 0));
        let bricked = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(bricked.status, "reconciliation-required");
        bricked
    }

    fn resume(
        fixture: &Fixture,
        execution: &PublishExecutionProjection,
    ) -> Result<PublishExecutionProjection, String> {
        fixture.store.resume_reconciled_execution(
            &fixture.workspace.id,
            "session-13",
            PublishStartRequest {
                execution_id: execution.id.clone(),
                expected_revision: execution.revision,
            },
            fixture.now_ms,
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resume_rejects_when_logged_out() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let bricked = brick_execution(&fixture, &started).await;

        // 未登录（拿不到网关指纹）时无法证明配置没变：拒绝恢复。
        set_test_gateway_base(None);
        assert_eq!(
            resume(&fixture, &bricked).unwrap_err(),
            "publish_provider_unavailable"
        );
        let still = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-13", &started.id)
            .unwrap();
        assert_eq!(still.status, "reconciliation-required");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resume_rejects_when_fingerprints_truly_differ() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let bricked = brick_execution(&fixture, &started).await;

        // 网关身份仍在轮换值上（双方都 configured 且指纹真不同）：拒绝恢复。
        assert_eq!(
            resume(&fixture, &bricked).unwrap_err(),
            "publish_provider_configuration_changed"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resume_rejects_when_any_item_has_external_order_id() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let bricked = brick_execution(&fixture, &started).await;

        // 登录恢复、指纹匹配，但任一条目已有 external_order_id（存在外部
        // 副作用）：整单拒绝，已提交项必须走查单对账。
        set_test_gateway_base(Some(TEST_GATEWAY_BASE));
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute(
                "UPDATE geo_publish_items SET external_order_id='order-1'
                 WHERE id=?1",
                [&bricked.items[0].id],
            )
            .unwrap();
        assert_eq!(
            resume(&fixture, &bricked).unwrap_err(),
            "publish_execution_has_submitted_items"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resume_restores_unsubmitted_execution_and_scheduler_submits() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(2, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        let bricked = brick_execution(&fixture, &started).await;

        // 登录恢复且指纹匹配：全部条目从未提交，可安全恢复。
        set_test_gateway_base(Some(TEST_GATEWAY_BASE));
        let resumed = resume(&fixture, &bricked).unwrap();
        assert_eq!(resumed.status, "scheduled");
        assert_eq!(resumed.revision, bricked.revision + 1);
        for item in &resumed.items {
            assert_eq!(item.status, "pending");
            assert_eq!(item.failure_code, None);
            assert_eq!(item.failure_reason, None);
            assert!(item.next_attempt_at.is_some());
        }
        let connection = open_database(&fixture.workspace).unwrap();
        let audit: String = connection
            .query_row(
                "SELECT GROUP_CONCAT(event_type, '|') FROM geo_publish_audit",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(audit.contains("reconciliation-resumed"));

        // 调度器重新认领，沿原幂等键跑到 submitted。
        let provider = Arc::new(MockProvider::default());
        let clock = Arc::new(AtomicI64::new(fixture.now_ms));
        scheduler(&fixture, provider.clone(), clock.clone())
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        assert_eq!(provider.counts(), (2, 2));
        let done = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(done.status, "succeeded");
        assert!(done
            .items
            .iter()
            .all(|item| item.status == "submitted" && item.external_order_id.is_some()));
    }

    #[test]
    fn mock_sidecar_envelopes_map_to_publish_outcomes() {
        // 上传：成功回执 → Success；余额类/限流类/未知信封按三态透传。
        let uploaded = parse_upload_egress_result(&json!({
            "outcome": "success",
            "objectUrl": "https://cdn.example.test/articles/a.html",
            "externalContentId": "articles/a.html",
        }));
        assert!(matches!(
            uploaded,
            PublishProviderOutcome::Success(ref receipt)
                if receipt.object_url == "https://cdn.example.test/articles/a.html"
        ));
        assert!(matches!(
            parse_upload_egress_result(&json!({
                "outcome": "safe-retryable",
                "code": "object-storage-http-502",
                "reason": "网关暂不可用",
            })),
            PublishProviderOutcome::SafeRetryable { ref code, .. }
                if code == "object-storage-http-502"
        ));
        // 成功信封缺 URL：稳定键 PUT 可安全重试。
        assert!(matches!(
            parse_upload_egress_result(&json!({"outcome": "success"})),
            PublishProviderOutcome::SafeRetryable { ref code, .. }
                if code == "object-storage-response-invalid"
        ));

        // 下单：网关 402 余额不足 → NonRetryable（充值语义，绝不静默重试）。
        let insufficient = parse_order_egress_result(&json!({
            "outcome": "non-retryable",
            "code": "distribution-insufficient-balance",
            "reason": "点数不足：本次需 1408 点，当前可用 100 点，请充值后再试。",
        }));
        assert!(matches!(
            insufficient,
            PublishProviderOutcome::NonRetryable { ref code, ref reason }
                if code == "distribution-insufficient-balance"
                    && reason.contains("充值")
        ));
        // 受理但缺订单标识 → Unknown（人工核对，绝不自动重试）。
        assert!(matches!(
            parse_order_egress_result(&json!({"outcome": "success"})),
            PublishProviderOutcome::Unknown { ref code, .. }
                if code == "distribution-order-id-missing"
        ));
        // 信封形状不可识别 → Unknown。
        assert!(matches!(
            parse_order_egress_result(&json!({"outcome": "garbage"})),
            PublishProviderOutcome::Unknown { ref code, .. }
                if code == "distribution-response-unknown"
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn post_egress_envelope_classifies_mock_sidecar_control_plane_failures() {
        let _lock = ENV_LOCK.lock().await;
        // 本地 mock sidecar（确定性测试模式）：按序返回预设控制面响应。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        #[allow(clippy::disallowed_methods)]
        let server = tokio::spawn(async move {
            let mut responses = VecDeque::from([
                // 1) 正常成功信封。
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 122\r\n\r\n{\"success\":true,\"result\":{\"outcome\":\"success\",\"objectUrl\":\"https://cdn.example.test/a.html\",\"externalContentId\":\"a.html\"}}".to_string(),
                // 2) 控制面非 2xx（egress 分类值只经 200 信封传递）。
                "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: 32\r\n\r\n{\"success\":false,\"error\":\"boom\"}".to_string(),
                // 3) 200 但信封不可解析。
                "HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nnotjson".to_string(),
            ]);
            while let Some(response) = responses.pop_front() {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let stream = stream;
                let _ = stream.readable().await;
                let mut scratch = [0_u8; 4096];
                let _ = stream.try_read(&mut scratch);
                let _ = stream.try_write(response.as_bytes());
            }
        });

        let ok = post_egress_envelope(
            port,
            "/api/xiaojing/publish-scheduler/egress/upload",
            json!({}),
            None,
        )
        .await
        .unwrap();
        assert_eq!(ok["outcome"], "success");
        assert!(matches!(
            post_egress_envelope(
                port,
                "/api/xiaojing/publish-scheduler/egress/order",
                json!({}),
                None,
            )
            .await,
            Err(SidecarCallFailure::Indeterminate(_))
        ));
        assert!(matches!(
            post_egress_envelope(
                port,
                "/api/xiaojing/publish-scheduler/egress/order",
                json!({}),
                None,
            )
            .await,
            Err(SidecarCallFailure::Indeterminate(_))
        ));
        // 未监听端口：连接被拒，请求从未离开本机 → Unreachable（下单可安全重试）。
        let closed_port = {
            let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            probe.local_addr().unwrap().port()
        };
        assert!(matches!(
            post_egress_envelope(
                closed_port,
                "/api/xiaojing/publish-scheduler/egress/order",
                json!({}),
                None,
            )
            .await,
            Err(SidecarCallFailure::Unreachable(_))
        ));
        server.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn post_egress_envelope_attaches_account_token_header_only_when_present() {
        let _lock = ENV_LOCK.lock().await;
        // mock sidecar 捕获请求头原文并回成功信封。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (heads_tx, mut heads_rx) = tokio::sync::mpsc::channel::<String>(4);
        #[allow(clippy::disallowed_methods)]
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let stream = stream;
                let _ = stream.readable().await;
                let mut scratch = [0_u8; 4096];
                let read = stream.try_read(&mut scratch).unwrap_or(0);
                let head = String::from_utf8_lossy(&scratch[..read]).to_string();
                let _ = heads_tx.send(head).await;
                let _ = stream.try_write(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 28\r\n\r\n{\"success\":true,\"result\":{}}",
                );
            }
        });

        post_egress_envelope(
            port,
            "/api/xiaojing/publish-scheduler/egress/upload",
            json!({}),
            Some("fresh-jwt-1"),
        )
        .await
        .unwrap();
        post_egress_envelope(
            port,
            "/api/xiaojing/publish-scheduler/egress/upload",
            json!({}),
            None,
        )
        .await
        .unwrap();

        let with_token = heads_rx.recv().await.unwrap();
        let without_token = heads_rx.recv().await.unwrap();
        assert!(
            with_token.contains("x-xiaojing-account-token: fresh-jwt-1"),
            "登录态必须附请求级 token 头：{with_token}"
        );
        assert!(
            !without_token
                .to_ascii_lowercase()
                .contains("x-xiaojing-account-token"),
            "无 token 时不得附头：{without_token}"
        );
        server.abort();
    }

    #[test]
    fn receipt_url_must_point_at_the_frozen_object_key() {
        assert!(receipt_url_points_at_object_key(
            "https://cdn.example.test/articles/w-1/a-1/approved-v1-abc.html",
            "articles/w-1/a-1/approved-v1-abc.html"
        ));
        // 逐段 percent-encoding（网关/ sidecar encodeObjectKey 口径）。
        assert!(receipt_url_points_at_object_key(
            "https://cdn.example.test/articles/w-1/a%20b/approved-v1-abc.html",
            "articles/w-1/a b/approved-v1-abc.html"
        ));
        // 指向别的键 / 指向键的前缀 / 非 http(s) 一律拒绝。
        assert!(!receipt_url_points_at_object_key(
            "https://cdn.example.test/other/key.html",
            "articles/w-1/a.html"
        ));
        assert!(!receipt_url_points_at_object_key(
            "https://cdn.example.test/articles/w-1/a.html/extra",
            "articles/w-1/a.html"
        ));
        assert!(!receipt_url_points_at_object_key(
            "ftp://cdn.example.test/articles/w-1/a.html",
            "articles/w-1/a.html"
        ));
        assert!(!receipt_url_points_at_object_key("not-a-url", "a.html"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn upload_receipt_pointing_elsewhere_requires_reconciliation() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let started = confirm_start(&fixture, &preview(&fixture));
        // mock sidecar 回执指向了别的对象：订单 content 不得指向未授权位置。
        let provider = Arc::new(MockProvider::with_upload_urls(vec![
            "https://attacker.example.test/other.html".to_string(),
        ]));
        scheduler(&fixture, provider, Arc::new(AtomicI64::new(fixture.now_ms)))
            .tick_workspace(&fixture.workspace)
            .await
            .unwrap();
        let result = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(result.status, "reconciliation-required");
        assert_eq!(
            result.items[0].failure_code.as_deref(),
            Some("object-url-mismatch")
        );
    }

    #[test]
    fn render_article_html_embeds_style_layer_and_keeps_conversion_semantics() {
        let markdown = "\
## 小节标题

正文段落，含[链接](https://example.test)与**加粗**。

- 要点一
- 要点二

| 列一 | 列二 |
| --- | --- |
| a | b |

![配图说明](https://cdn.example.test/images/a.png)
";
        let html = render_article_html("标题<&>", markdown);

        // 既有模板结构不回归：doctype、语言、charset、viewport、标题转义。
        assert!(html.starts_with(
            "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        ));
        assert!(html
            .contains("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"));
        assert!(html.contains("<title>标题&lt;&amp;&gt;</title>"));

        // 样式层存在，且位于 head 内、正文之前——单文件自包含（ADR-0008 D5）。
        let style_start = html.find("<style>").expect("模板缺少内嵌 <style> 层");
        let style_end = html.find("</style>").expect("内嵌 <style> 未闭合");
        assert!(style_start < style_end);
        assert!(style_end < html.find("<body>").expect("模板缺少 <body>"));
        let css = &html[style_start + "<style>".len()..style_end];

        // 排版地基四要素（观感本身不做快照，按选择器锚定样式层覆盖面）。
        let rule = |selector: &str| {
            css.split('}')
                .find(|rule| {
                    rule.split('{')
                        .next()
                        .is_some_and(|found| found.trim() == selector)
                })
                .and_then(|rule| rule.split_once('{').map(|(_, body)| body))
        };
        // 1) 阅读宽度约束
        assert!(
            rule("body").is_some_and(|declarations| declarations.contains("max-width")),
            "样式层缺阅读宽度约束"
        );
        // 2) 标题层级
        assert!(rule("h1").is_some(), "样式层缺一级标题样式");
        assert!(rule("h2").is_some(), "样式层缺二级标题样式");
        // 3) 列表与表格
        assert!(rule("li").is_some(), "样式层缺列表样式");
        assert!(
            rule("th,td").is_some_and(|declarations| declarations.contains("border")),
            "样式层缺表格样式"
        );
        // 4) 图片自适应
        let img_rule = rule("img").expect("样式层缺 img 规则");
        assert!(
            img_rule.contains("max-width:100%"),
            "img 规则缺自适应：{img_rule}"
        );

        // markdown→HTML 转换语义零变化：转换产物照旧由 pulldown-cmark 生成，
        // 正文不带任何表现属性——样式只存在于 <style> 层。
        let body = html
            .split("<body>\n")
            .nth(1)
            .and_then(|rest| rest.split("</body>").next())
            .expect("正文区段缺失");
        assert!(
            body.starts_with("<h1>标题&lt;&amp;&gt;</h1>"),
            "标题注入 h1 的既有语义变化：{body}"
        );
        assert!(body.contains("<h2>小节标题</h2>"));
        assert!(body.contains("<li>要点一</li>"));
        assert!(body.contains("<table>"));
        assert!(body.contains("<td>a</td>"));
        assert!(
            body.contains(r##"<img src="https://cdn.example.test/images/a.png" alt="配图说明""##)
        );
        assert!(
            !body.contains("style=") && !body.contains("class="),
            "样式必须只内嵌于 <style>，不得渗入正文标签：{body}"
        );
    }

    // ── material-image 占位符（票 #15）：共享契约 JSON 的 Rust 消费
    //（TS/Rust 同构，先例 rankingCompetitorContractCases.json）。

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MaterialImageContract {
        uri_scheme: String,
        max_images_per_article: usize,
        cases: Vec<MaterialImageContractCase>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MaterialImageContractCase {
        name: String,
        body: String,
        #[serde(default)]
        expected_image_ids: Vec<String>,
        #[serde(default)]
        expected_alts: Vec<String>,
        #[serde(default)]
        expected_parse_error: Option<String>,
    }

    #[test]
    fn material_image_contract_cases_pin_rust_scan_and_replacement() {
        let contract: MaterialImageContract = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/geo/materialImagePlaceholderContractCases.json"
        )))
        .expect("shared material-image placeholder contract cases");
        // 契约顶部的 scheme 与密度上限先钉死两侧常量，防漂移。
        assert_eq!(contract.uri_scheme, MATERIAL_IMAGE_URI_SCHEME);
        assert_eq!(
            contract.max_images_per_article,
            MATERIAL_IMAGE_MAX_PER_ARTICLE
        );
        for case in &contract.cases {
            let scan = scan_material_image_placeholders(&case.body);
            let ids: Vec<&str> = scan
                .matches
                .iter()
                .map(|(_, _, image_id, _)| image_id.as_str())
                .collect();
            let alts: Vec<&str> = scan
                .matches
                .iter()
                .map(|(_, _, _, alt)| alt.as_str())
                .collect();
            assert_eq!(
                ids, case.expected_image_ids,
                "占位符 id 列表：{}",
                case.name
            );
            assert_eq!(alts, case.expected_alts, "占位符 alt 列表：{}", case.name);

            // 发布期绑定闸：语法违例 / 超密度上限都 fail-closed。
            // 期望集合按首次出现顺序去重（与扫描语义一致）。
            let mut seen_ids = std::collections::BTreeSet::new();
            let expected_unique: Vec<String> = case
                .expected_image_ids
                .iter()
                .filter(|id| seen_ids.insert((*id).clone()))
                .cloned()
                .collect();
            let unique_count = expected_unique.len();
            let bindings = publish_image_bindings(&case.body);
            if scan.violations.is_empty() && unique_count <= MATERIAL_IMAGE_MAX_PER_ARTICLE {
                assert_eq!(
                    bindings
                        .unwrap_or_else(|code| panic!("合法用例绑定失败 {code}：{}", case.name)),
                    expected_unique,
                    "合法用例的绑定集合：{}",
                    case.name
                );
            } else if unique_count > MATERIAL_IMAGE_MAX_PER_ARTICLE {
                assert_eq!(
                    bindings.unwrap_err(),
                    "material-image-density-exceeded",
                    "超密度用例：{}",
                    case.name
                );
            } else {
                assert_eq!(
                    bindings.unwrap_err(),
                    "material-image-placeholder-invalid",
                    "scheme 逃逸用例：{}",
                    case.name
                );
            }

            // 替换语义：保 alt 文本、占位符 URL → 公网 URL、scheme 零残留。
            // 无合法占位符且无 scheme 出现的用例（如遗留【】占位符）正文
            // 原样通过；带 scheme 逃逸的用例替换必须失败（文本逃逸不上公网）。
            let urls: HashMap<String, String> = case
                .expected_image_ids
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    (
                        id.clone(),
                        format!("https://cdn.example.test/images/contract-{index}.png"),
                    )
                })
                .collect();
            let replaced = replace_material_image_placeholders(&case.body, &urls);
            if scan.violations.is_empty() {
                let rendered = replaced
                    .unwrap_or_else(|code| panic!("合法用例替换失败 {code}：{}", case.name));
                assert!(
                    !rendered.contains(MATERIAL_IMAGE_URI_SCHEME),
                    "替换后 scheme 零残留：{}",
                    case.name
                );
                for (index, alt) in case.expected_alts.iter().enumerate() {
                    assert!(
                        rendered.contains(&format!(
                            "![{alt}](https://cdn.example.test/images/contract-{index}.png)"
                        )),
                        "alt 原样保留并换绝对 URL（{}）：{rendered}",
                        case.name
                    );
                }
            } else {
                assert_eq!(
                    replaced.unwrap_err(),
                    "material-image-placeholder-invalid",
                    "逃逸用例替换必须失败：{}",
                    case.name
                );
            }
            // 解析侧错误码只由 TS 侧消费；Rust 侧只确认其存在形状。
            let _ = case.expected_parse_error;
        }
    }

    // ── publish_scheduler 契约（票 #36，ADR-0012）：共享裁判 JSON 的 Rust pin
    //（与 TS 侧 publishScheduler.test.ts 的 import pin 同一裁判文件）。

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PublishSchedulerContract {
        policy_version: String,
        retry_backoff_ms: PublishSchedulerContractRetry,
        max_safe_retries: usize,
        execution_statuses: Vec<String>,
        item_statuses: Vec<String>,
    }

    #[derive(Debug, Deserialize)]
    struct PublishSchedulerContractRetry {
        values: Vec<i64>,
    }

    #[test]
    fn publish_scheduler_contract_pins_constants() {
        let contract: PublishSchedulerContract = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/geo/publishSchedulerContract.json"
        )))
        .expect("shared publish scheduler contract json");
        assert_eq!(contract.policy_version, POLICY_VERSION);
        assert_eq!(
            contract.retry_backoff_ms.values,
            RETRY_BACKOFF_MS.to_vec(),
            "重试表；产品语义日期记于 JSON 的 _comment"
        );
        assert_eq!(contract.max_safe_retries, RETRY_BACKOFF_MS.len());
        assert_eq!(
            contract.execution_statuses,
            PUBLISH_EXECUTION_STATUSES
                .iter()
                .map(|status| status.to_string())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            contract.item_statuses,
            PUBLISH_ITEM_STATUSES
                .iter()
                .map(|status| status.to_string())
                .collect::<Vec<_>>()
        );
    }

    /// 生成式 DDL 的逐字节红线：两个 CHECK 子句的生成文本与本票重构前的
    /// 硬编码 DDL 完全一致——新旧二进制建出的库 sqlite_master 文本不因
    /// 重构分叉，按原文匹配的表重建迁移不会失配。
    #[test]
    fn publish_status_check_clauses_match_pre_contract_ddl_bytes() {
        assert_eq!(
            publish_execution_status_check_clause(),
            "status TEXT NOT NULL CHECK(status IN (
                    'awaiting-confirmation','confirmed','running','scheduled',
                    'partially-succeeded','succeeded','failed','reconciliation-required'
                    ,'superseded','cancelled'
                ))"
        );
        assert_eq!(
            publish_item_status_check_clause(),
            "status TEXT NOT NULL CHECK(status IN (
                    'pending','uploading','uploaded','submitting','submitted',
                    'failed-retryable','failed-nonretryable','reconciliation-required',
                    'cancelled'
                ))"
        );
    }

    /// 迁移替换对从常量生成后的历史等值：与 #36 前硬编码的锚点
    ///（executions `,'superseded'`、items `'reconciliation-required'`）在
    /// 已知旧库形态下替换结果逐字节一致。
    #[test]
    fn append_cancelled_replace_pair_matches_legacy_anchors() {
        let (without, with) = append_cancelled_replace_pair(&PUBLISH_EXECUTION_STATUSES).unwrap();
        assert_eq!(without, "'superseded'");
        assert_eq!(with, "'superseded','cancelled'");
        let legacy_executions =
            "CHECK(status IN ('failed','reconciliation-required'\n                    ,'superseded'\n                ))";
        assert_eq!(
            legacy_executions.replace(&without, &with),
            "CHECK(status IN ('failed','reconciliation-required'\n                    ,'superseded','cancelled'\n                ))"
        );

        let (without, with) = append_cancelled_replace_pair(&PUBLISH_ITEM_STATUSES).unwrap();
        assert_eq!(without, "'reconciliation-required'");
        assert_eq!(with, "'reconciliation-required','cancelled'");
        let legacy_items =
            "CHECK(status IN ('failed-retryable','failed-nonretryable','reconciliation-required'\n                ))";
        assert_eq!(
            legacy_items.replace(&without, &with),
            "CHECK(status IN ('failed-retryable','failed-nonretryable','reconciliation-required','cancelled'\n                ))"
        );
    }

    #[test]
    fn render_article_html_replaces_placeholders_with_absolute_public_urls() {
        let markdown = "\
## 门头实拍

![门店外景实拍](material-image://9f1c2ab4-52d8-4f6e-8a90-1c2d3e4f5a6b)

正文一段。

![同一张图复用](material-image://9f1c2ab4-52d8-4f6e-8a90-1c2d3e4f5a6b)

![外链图不动](https://example.test/external.png)
";
        let mut urls = HashMap::new();
        urls.insert(
            "9f1c2ab4-52d8-4f6e-8a90-1c2d3e4f5a6b".to_string(),
            "https://cdn.example.test/images/9f2c...f5a6b.png".to_string(),
        );
        let replaced =
            replace_material_image_placeholders(markdown, &urls).expect("placeholder replacement");
        let html = render_article_html("带配图的指南", &replaced);

        // 占位符 → 绝对公网 URL（alt 保留、同图同 URL 稳定）、scheme 零残留。
        assert_eq!(
            html.matches("https://cdn.example.test/images/9f2c...f5a6b.png")
                .count(),
            2
        );
        assert!(html.contains(
            r##"<img src="https://cdn.example.test/images/9f2c...f5a6b.png" alt="门店外景实拍""##
        ));
        assert!(html.contains(r##"alt="同一张图复用""##));
        assert!(!html.contains(MATERIAL_IMAGE_URI_SCHEME));
        // 外链图片语法不在契约管辖内：原样透传。
        assert!(html.contains(r##"src="https://example.test/external.png""##));
        // 单文件自包含：内嵌样式层仍在（AC 机制层锚点）。
        assert!(html.contains("<style>"));

        // 映射缺失（材料图片资产不在）：fail-closed，不产出带占位符的 HTML。
        assert_eq!(
            replace_material_image_placeholders(markdown, &HashMap::new()).unwrap_err(),
            "material-image-url-missing"
        );
    }

    /// 端到端机制锚点（AC4 机制层）：带占位符批准稿发布后，图片对象已按
    /// 内容寻址键送出口、HTML 内 material-image:// 已换绝对公网 URL 且
    /// 内嵌 CSS 完整。真实浏览器观感按票面留人工验收。
    struct IllustratedFixture {
        fixture: Fixture,
        image_id: String,
        png_sha256: String,
        png_bytes: Vec<u8>,
    }

    /// 带占位符批准稿夹具：材料图片入池（T2/T3 内容寻址那条路）+ 批准
    /// 正文重写为占位符形态（冻结哈希同步重算）。
    fn setup_illustrated_fixture() -> IllustratedFixture {
        let fixture = setup_fixture(1, 0);
        let png_bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4];
        let png_sha256 = format!("{:x}", Sha256::digest(&png_bytes));
        let material = fixture
            .store
            .import_brand_text(super::super::ImportBrandTextRequest {
                workspace_id: fixture.workspace.id.clone(),
                session_id: "session-13".to_string(),
                input_kind: "pasted-text".to_string(),
                display_name: "门店介绍.txt".to_string(),
                text: "门店介绍文本".to_string(),
                source_url: None,
            })
            .expect("import material");
        let image = fixture
            .store
            .save_material_image(
                &fixture.workspace.id,
                "session-13",
                super::super::MaterialImageSave {
                    source_material_id: material.id.clone(),
                    sha256: png_sha256.clone(),
                    file_ext: "png".to_string(),
                    media_type: "image/png".to_string(),
                    byte_size: png_bytes.len() as u64,
                    width: 800,
                    height: 600,
                    description: "门店外景实拍".to_string(),
                    category: "product-photo".to_string(),
                    embedded_image_b64: Some(BASE64.encode(&png_bytes)),
                },
            )
            .expect("save material image");
        let body = format!(
            "# 批准文章 1\n\n{marker} 1\n\n![门店外景实拍](material-image://{image_id})\n",
            marker = fixture.body_marker,
            image_id = image.id
        );
        let approved_path = fixture
            .workspace
            .root_path
            .join(format!("articles/approved/{ARTICLE_ID}/v1.md"));
        std::fs::write(&approved_path, body.as_bytes()).unwrap();
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute(
                "UPDATE geo_article_versions SET body_sha256=?1 WHERE article_id=?2",
                params![sha256_hex(body.as_bytes()), ARTICLE_ID],
            )
            .unwrap();
        drop(connection);
        IllustratedFixture {
            fixture,
            image_id: image.id,
            png_sha256,
            png_bytes,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn publishes_illustrated_article_through_image_egress_pipeline() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let illustrated = setup_illustrated_fixture();
        let IllustratedFixture {
            fixture,
            image_id,
            png_sha256,
            png_bytes,
        } = illustrated;
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::default());
        scheduler(
            &fixture,
            provider.clone(),
            Arc::new(AtomicI64::new(fixture.now_ms)),
        )
        .tick_workspace(&fixture.workspace)
        .await
        .unwrap();

        // 1) 图片对象：材料图片字节按 sha256/mediaType 送出口。
        let image_requests = provider.image_uploads.lock().unwrap();
        assert_eq!(image_requests.len(), 1, "占位符图片必须先于 HTML 上传");
        assert_eq!(image_requests[0].images.len(), 1);
        assert_eq!(image_requests[0].images[0].image_id, image_id);
        assert_eq!(image_requests[0].images[0].sha256, png_sha256);
        assert_eq!(image_requests[0].images[0].media_type, "image/png");
        assert_eq!(image_requests[0].images[0].bytes, png_bytes);
        // 2) HTML：占位符已换绝对公网 URL、内嵌 CSS 完整、scheme 零残留。
        let uploads = provider.uploads.lock().unwrap();
        assert_eq!(uploads.len(), 1);
        let html = String::from_utf8_lossy(&uploads[0].body).into_owned();
        assert!(
            html.contains(&format!(
                r##"<img src="https://cdn.example.test/images/{png_sha256}.png" alt="门店外景实拍""##
            )),
            "HTML 内必须是图片对象绝对公网 URL：{html}"
        );
        assert!(!html.contains(MATERIAL_IMAGE_URI_SCHEME));
        assert!(html.contains("<style>"));
        // 3) 执行收尾与既有路径一致（上传 → 下单 → submitted）。
        let done = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(done.status, "succeeded");
        assert!(done.items[0].external_order_id.is_some());
    }

    /// 图片回执指向别处（非内容寻址键）：与 HTML 对象 URL 同款纪律，
    /// fail-closed 转人工，HTML 不上传。
    #[tokio::test(flavor = "current_thread")]
    async fn image_receipt_pointing_elsewhere_requires_reconciliation() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let IllustratedFixture {
            fixture,
            image_id,
            png_sha256: _,
            png_bytes: _,
        } = setup_illustrated_fixture();
        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = MockProvider::default();
        provider.image_url_overrides.lock().unwrap().insert(
            image_id.clone(),
            "https://attacker.example.test/other.png".to_string(),
        );
        let provider = Arc::new(provider);
        scheduler(
            &fixture,
            provider.clone(),
            Arc::new(AtomicI64::new(fixture.now_ms)),
        )
        .tick_workspace(&fixture.workspace)
        .await
        .unwrap();

        let result = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(result.status, "reconciliation-required");
        assert_eq!(
            result.items[0].failure_code.as_deref(),
            Some("material-image-url-mismatch")
        );
        // 图片已上传但回执不合规：HTML 绝不上传。
        assert_eq!(provider.image_uploads.lock().unwrap().len(), 1);
        assert!(provider.uploads.lock().unwrap().is_empty());
    }

    /// 材料图片资产失联（占位符指向已不存在的 id）：fail-closed 转人工
    /// 对账，绝不换形（丢图）发布。
    #[tokio::test(flavor = "current_thread")]
    async fn missing_material_image_requires_reconciliation() {
        let _lock = ENV_LOCK.lock().await;
        let _env = TestEnvironment::configured();
        let fixture = setup_fixture(1, 0);
        let body = format!(
            "# 批准文章 1\n\n{marker} 1\n\n![配图](material-image://00000000-0000-4000-8000-000000000000)\n",
            marker = fixture.body_marker
        );
        let approved_path = fixture
            .workspace
            .root_path
            .join(format!("articles/approved/{ARTICLE_ID}/v1.md"));
        std::fs::write(&approved_path, body.as_bytes()).unwrap();
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute(
                "UPDATE geo_article_versions SET body_sha256=?1 WHERE article_id=?2",
                params![sha256_hex(body.as_bytes()), ARTICLE_ID],
            )
            .unwrap();
        drop(connection);

        let started = confirm_start(&fixture, &preview(&fixture));
        let provider = Arc::new(MockProvider::default());
        scheduler(
            &fixture,
            provider.clone(),
            Arc::new(AtomicI64::new(fixture.now_ms)),
        )
        .tick_workspace(&fixture.workspace)
        .await
        .unwrap();

        let result = fixture
            .store
            .get_publish_execution(&fixture.workspace.id, "session-b", &started.id)
            .unwrap();
        assert_eq!(result.status, "reconciliation-required");
        assert_eq!(
            result.items[0].failure_code.as_deref(),
            Some("material-image-unavailable")
        );
        // 未发出任何上传（图片与 HTML 都没有）。
        assert!(provider.uploads.lock().unwrap().is_empty());
        assert!(provider.image_uploads.lock().unwrap().is_empty());
    }

    #[test]
    fn mock_sidecar_image_envelopes_map_to_publish_outcomes() {
        // 成功回执：按 imageId 映射公网 URL。
        let uploaded = parse_image_upload_egress_result(&json!({
            "outcome": "success",
            "images": [
                {"imageId": "img-1", "url": "https://cdn.example.test/images/aa.png", "objectKey": "images/aa.png"},
                {"imageId": "img-2", "url": "https://cdn.example.test/images/bb.jpg", "objectKey": "images/bb.jpg"},
            ],
        }));
        assert!(
            matches!(
                &uploaded,
                PublishProviderOutcome::Success(receipt)
                    if receipt.urls.get("img-1").map(String::as_str)
                        == Some("https://cdn.example.test/images/aa.png")
                    && receipt.urls.get("img-2").map(String::as_str)
                        == Some("https://cdn.example.test/images/bb.jpg")
                    && receipt.urls.len() == 2
            ),
            "成功信封必须按 imageId 建立完整 URL 映射"
        );
        // 成功信封缺图片清单：内容寻址键可安全重试。
        assert!(matches!(
            parse_image_upload_egress_result(&json!({"outcome": "success"})),
            PublishProviderOutcome::SafeRetryable { ref code, .. }
                if code == "object-storage-response-invalid"
        ));
        // 出口失败分类三态透传（如网关限流 429 → SafeRetryable）。
        assert!(matches!(
            parse_image_upload_egress_result(&json!({
                "outcome": "safe-retryable",
                "code": "object-storage-http-429",
                "reason": "服务限流",
            })),
            PublishProviderOutcome::SafeRetryable { ref code, .. }
                if code == "object-storage-http-429"
        ));
    }
}
