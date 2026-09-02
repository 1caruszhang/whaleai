use std::collections::{HashMap, HashSet};

use chrono::Utc;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{
    ensure_column, open_database, validate_session_id, BrandWorkspace, BrandWorkspaceStore,
};

const MAX_JSON_BYTES: usize = 128 * 1024;
const STRUCTURED_KINDS: [&str; 9] = [
    "knowledge-update",
    "question-opportunities",
    "article-generation",
    "performance-inspection",
    "distribution-planning",
    "publishing",
    "monitoring",
    "full-optimization",
    "next-round-optimization",
];
const TERMINAL_STATUSES: [&str; 3] = ["succeeded", "failed", "cancelled"];
const OPERATION_STATUSES: [&str; 9] = [
    "ready",
    "queued",
    "running",
    "awaiting-confirmation",
    "paused",
    "recovering",
    "succeeded",
    "failed",
    "cancelled",
];
const STEP_STATUSES: [&str; 7] = [
    "pending",
    "ready",
    "running",
    "awaiting-confirmation",
    "succeeded",
    "failed",
    "skipped",
];
const CAPABILITIES: [&str; 10] = [
    "brand-material-import",
    "brand-knowledge",
    "question-opportunities",
    "geo-observation",
    "content-planning",
    "content-production",
    "distribution-planning",
    "publishing",
    "monitoring",
    "geo-dashboard",
];
const REFERENCE_KINDS: [&str; 12] = [
    "knowledge-version",
    "material",
    "question-pool",
    "baseline",
    "topic-plan",
    "article-operation",
    "article",
    "distribution-plan",
    "publish-execution",
    "monitor-plan",
    "operation",
    "report",
];
const RETRY_UNITS: [&str; 5] = [
    "operation",
    "article",
    "probe",
    "publish-item",
    "monitor-item",
];
const CONFIRMATION_KINDS: [&str; 11] = [
    "plan-ack",
    "knowledge-change",
    "next-round-knowledge",
    "question-selection",
    "baseline-probe",
    "topic-plan",
    "article-approval",
    "distribution-plan",
    "paid-publish",
    "external-publish",
    "monitoring-activation",
];
const CONFIRMATION_AUTHORITIES: [&str; 5] = [
    "geo-operation",
    "knowledge-authority",
    "brand-workspace",
    "publish-scheduler",
    "post-publish-monitor",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationReference {
    pub kind: String,
    pub id: String,
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationConfirmation {
    pub kind: String,
    pub authority: String,
    pub title: String,
    pub summary: String,
}

/// 量化进度（如逐篇生成「3/5」）。只在步骤 running 期间有意义；
/// 历史 JSON 行没有该字段，serde 缺省为 None。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationStepProgress {
    pub current: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationStep {
    pub id: String,
    pub title: String,
    pub capability: String,
    pub status: String,
    pub requires_confirmation: bool,
    pub irreversible: bool,
    pub retry_unit: String,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub confirmation: Option<GeoOperationConfirmation>,
    #[serde(default)]
    pub progress: Option<GeoOperationStepProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationCheckpoint {
    pub active_step_id: Option<String>,
    pub completed_step_ids: Vec<String>,
    pub completed_unit_refs: Vec<GeoOperationReference>,
    pub safe_to_resume: bool,
    pub saved_at: String,
    #[serde(default)]
    pub execution_generation: Option<i64>,
    #[serde(default)]
    pub sidecar_generation: Option<u64>,
    #[serde(default)]
    pub active_retry_unit: Option<String>,
    #[serde(default)]
    pub active_unit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub unit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoArtifactFreshnessProjection {
    pub artifact_id: String,
    pub status: String,
    pub compared_to_knowledge_version: i64,
    pub changed_fact_keys: Vec<String>,
    pub marked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationProjection {
    pub id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub kind: String,
    pub goal: String,
    pub status: String,
    pub steps: Vec<GeoOperationStep>,
    pub input_refs: Vec<GeoOperationReference>,
    pub artifact_refs: Vec<GeoOperationReference>,
    pub checkpoint: Option<GeoOperationCheckpoint>,
    pub pending_confirmation: Option<GeoOperationConfirmation>,
    pub error: Option<GeoOperationError>,
    pub source_operation_id: Option<String>,
    /// 本轮「是否更新品牌知识」的显式决策（票 #04，spec 2026-09-02）：
    /// Some(false)=复用轮（从问题池选择开始）、Some(true)=更新轮、
    /// None=未决（分支门未回答）/不适用（直接意图）/存量旧轮。起点推导
    /// 读轮次时以此为准，不靠 kind 意图标签推断。历史行缺列为 None。
    #[serde(default)]
    pub update_knowledge: Option<bool>,
    pub revision: i64,
    pub execution_generation: i64,
    pub execution_sidecar_generation: Option<u64>,
    pub queue_reason: Option<String>,
    pub queue_position: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
    /// 接管留痕（ADR-0010）：上一次所有权转移的原所有者与时间；
    /// 从未被接管时为 None。`session_id` 即当前所有者（= 最近一次接管的
    /// 发起者），三个字段合起来构成「谁、何时、从谁」的完整留痕。
    #[serde(default)]
    pub taken_over_from_session_id: Option<String>,
    #[serde(default)]
    pub taken_over_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationCreateRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub kind: String,
    pub goal: String,
    pub status: String,
    pub steps: Vec<GeoOperationStep>,
    #[serde(default)]
    pub input_refs: Vec<GeoOperationReference>,
    pub pending_confirmation: Option<GeoOperationConfirmation>,
    pub source_operation_id: Option<String>,
    /// 本轮是否更新品牌知识的显式决策（票 #04）：与投影同语义，
    /// 未携带存 None。请求字段即白名单——新字段必须在这里显式声明。
    #[serde(default)]
    pub update_knowledge: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationGetRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationListRequest {
    #[serde(default)]
    pub include_all_sessions: bool,
    pub limit: Option<i64>,
}

/// 跨会话未完成轮次的「卡住步骤」元信息：计划序上首个仍活跃的步骤
/// （awaiting-confirmation / running / ready）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationUnfinishedStuckStep {
    pub id: String,
    pub title: String,
    pub capability: String,
    pub status: String,
}

/// 跨会话未完成轮次的只读元信息（ADR-0010 Decision 3）：品牌状态摘要经
/// 新会话的 `inspect_brand_context` 一次读取。六要素——类型、卡住步骤、
/// 待审数量、所属会话、创建/更新时间、是否更新品牌知识（票 #04，见
/// `update_knowledge`）。绝不包含草稿正文、正文路径或任何会话聊天记录
/// （正文隔离保留在各领域 owned-or-approved 投影）；待审数量 =
/// 该操作当前所有者会话名下处于 draft_ready 且未批准的文章篇数
/// （ADR-0010 改键：接管后所有者随工作集转移）。
///
/// `session_id = None` 是无主轮（票 10 验收实证补全）：原会话被删除时
/// 外键 `ON DELETE SET NULL` 保留轮次、引用置空——轮次本身仍未完成、
/// 无所有者进程在跑，是跨会话接管的合法标的；摘要必须列出它，否则无主
/// 轮对一切新会话不可见、永远无法推进（无主轮的待审数量按 0 报告：
/// 没有所有者会话名下的工作集）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationUnfinishedSummary {
    pub id: String,
    pub session_id: Option<String>,
    pub kind: String,
    pub goal: String,
    pub status: String,
    pub stuck_step: Option<GeoOperationUnfinishedStuckStep>,
    pub pending_confirmation: Option<GeoOperationConfirmation>,
    pub pending_review_count: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 该轮是否更新品牌知识（票 #04）：Some(false)=复用轮、Some(true)=
    /// 更新轮、None=未决/不适用/存量旧轮——下一个会话的起点推导直接读
    /// 它，不靠 kind 意图标签统计推断。
    #[serde(default)]
    pub update_knowledge: Option<bool>,
}

/// 品牌状态摘要一次读取的未完成轮次上界：跨会话弃置的轮次只会累积，
/// 无上界会让每个新 Session 的 `inspect_brand_context` 为全部历史轮次
/// 付上下文。超出部分只以 `total` 计数报告，摘要侧换算 truncatedCount。
pub const UNFINISHED_GEO_OPERATION_SUMMARY_LIMIT: usize = 5;

/// 截断视图：最多 `UNFINISHED_GEO_OPERATION_SUMMARY_LIMIT` 条最新元信息 +
/// 品牌内非终态轮次总数（`total >= operations.len()`）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationUnfinishedList {
    pub operations: Vec<GeoOperationUnfinishedSummary>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationMutationRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub expected_revision: i64,
    pub action: String,
    pub step_id: Option<String>,
    pub checkpoint: Option<GeoOperationCheckpoint>,
    pub error: Option<GeoOperationError>,
    #[serde(default)]
    pub artifact_refs: Vec<GeoOperationReference>,
    #[serde(default)]
    pub replacement_steps: Option<Vec<GeoOperationStep>>,
    /// replace-plan 的调用场景（票 07）：缺省 = 知识分支决策（既有唯一
    /// 形态，守卫要求停卡在 decide-knowledge-refresh 单步）；
    /// `material-collection-skip` = 材料收集跳过出口——守卫按该场景校验
    /// 替换形状（只允许剥离知识段未走完步骤），不放宽成自由计划编辑。
    #[serde(default)]
    pub replacement_reason: Option<String>,
    /// 仅 replace-plan 消费（票 #04）：知识分支的用户显式答案随计划替换
    /// 一并落库；其余动作忽略。缺省 None 保持现值不变。
    #[serde(default)]
    pub update_knowledge: Option<bool>,
    #[serde(default)]
    pub step_progress: Option<GeoOperationStepProgress>,
    #[serde(default)]
    pub queue_reason: Option<String>,
    #[serde(default)]
    pub queue_position: Option<i64>,
    #[serde(default)]
    pub expected_execution_generation: Option<i64>,
    #[serde(default)]
    pub sidecar_generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationExternalGateInput {
    pub operation_id: String,
    pub expected_revision: i64,
    pub step_id: String,
    pub evidence_ref: GeoOperationReference,
}

/// 接管（ADR-0010 Decision 1）：把一个未完成轮次的所有权从当前所有者
/// CAS 转移给发起会话。`session_id` 是接管者（当前 Sidecar 信封身份），
/// `expected_revision` 与所有者键一起构成单赢家 CAS。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationTakeoverRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub expected_revision: i64,
}

/// 接管回执：转移后的操作投影（`session_id` 已是接管者）+ 留痕字段 +
/// 随 operation 整体转移的工作集计数（未批准文章操作、awaiting-selection
/// 池），供 agent 向用户转述「接过了什么」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoOperationTakeoverReceipt {
    pub operation: GeoOperationProjection,
    /// 接管前的所有者；None = 无主轮（原会话已删除，SET NULL 保留轮次）。
    pub previous_owner_session_id: Option<String>,
    pub taken_over_at: String,
    pub transferred_article_operations: i64,
    pub transferred_question_pools: i64,
}

pub(super) fn ensure_schema(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_operations (
                id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES brand_sessions(id) ON DELETE SET NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("initialize GEO operation base schema: {error}"))?;
    ensure_column(
        connection,
        "geo_operations",
        "kind",
        "TEXT NOT NULL DEFAULT 'artifact-lineage'",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "goal",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "status",
        "TEXT NOT NULL DEFAULT 'ready'",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "steps_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "input_refs_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "artifact_refs_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    ensure_column(connection, "geo_operations", "checkpoint_json", "TEXT")?;
    ensure_column(
        connection,
        "geo_operations",
        "pending_confirmation_json",
        "TEXT",
    )?;
    ensure_column(connection, "geo_operations", "error_json", "TEXT")?;
    ensure_column(connection, "geo_operations", "source_operation_id", "TEXT")?;
    // 本轮「是否更新品牌知识」的显式决策（票 #04）：NULL=未决/不适用/
    // 存量旧轮，0=不更新（复用轮），1=更新。
    ensure_column(connection, "geo_operations", "update_knowledge", "INTEGER")?;
    ensure_column(
        connection,
        "geo_operations",
        "revision",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "execution_generation",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "geo_operations",
        "execution_sidecar_generation",
        "INTEGER",
    )?;
    ensure_column(connection, "geo_operations", "queue_reason", "TEXT")?;
    ensure_column(connection, "geo_operations", "queue_position", "INTEGER")?;
    ensure_column(connection, "geo_operations", "updated_at", "TEXT")?;
    ensure_column(connection, "geo_operations", "terminal_at", "TEXT")?;
    // 接管留痕（ADR-0010）：原所有者与时间；session_id 即当前所有者。
    ensure_column(
        connection,
        "geo_operations",
        "taken_over_from_session_id",
        "TEXT",
    )?;
    ensure_column(connection, "geo_operations", "taken_over_at", "TEXT")?;
    connection
        .execute(
            "UPDATE geo_operations SET updated_at=created_at WHERE updated_at IS NULL",
            [],
        )
        .map_err(|error| format!("backfill GEO operation updated_at: {error}"))?;
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS geo_operations_session_activity
                ON geo_operations(session_id, updated_at DESC);
             CREATE TABLE IF NOT EXISTS geo_artifact_freshness (
                artifact_id TEXT PRIMARY KEY REFERENCES geo_artifacts(id) ON DELETE CASCADE,
                status TEXT NOT NULL CHECK(status IN ('current','needs-confirmation')),
                compared_to_knowledge_version INTEGER NOT NULL,
                changed_fact_keys_json TEXT NOT NULL,
                marked_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS geo_artifact_freshness_status
                ON geo_artifact_freshness(status, marked_at DESC);",
        )
        .map_err(|error| format!("initialize structured GEO operation schema: {error}"))
}

impl BrandWorkspaceStore {
    pub fn create_geo_operation(
        &self,
        request: GeoOperationCreateRequest,
    ) -> Result<GeoOperationProjection, String> {
        validate_create(&request)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        ensure_schema(&connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start GEO operation transaction: {error}"))?;
        let session_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM brand_sessions WHERE id=?1)",
                [&request.session_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("validate GEO operation Session: {error}"))?;
        if !session_exists {
            return Err("geo_operation_session_not_committed".to_string());
        }
        if let Some(source_operation_id) = request.source_operation_id.as_deref() {
            let source_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(
                        SELECT 1 FROM geo_operations
                        WHERE id=?1 AND session_id=?2 AND kind!='artifact-lineage'
                     )",
                    params![source_operation_id, request.session_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("validate source GEO operation: {error}"))?;
            if !source_exists {
                return Err("geo_operation_source_not_found".to_string());
            }
        }
        let operation_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_operations
                    (id, session_id, state, created_at, kind, goal, status,
                     steps_json, input_refs_json, artifact_refs_json,
                     pending_confirmation_json, source_operation_id,
                     update_knowledge, revision,
                     execution_generation, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'[]',?10,?11,?12,1,0,?4)",
                params![
                    operation_id,
                    request.session_id,
                    request.status,
                    now,
                    request.kind,
                    request.goal.trim(),
                    request.status,
                    json_string(&request.steps, "geo_operation_steps_invalid")?,
                    json_string(&request.input_refs, "geo_operation_input_refs_invalid")?,
                    optional_json_string(
                        request.pending_confirmation.as_ref(),
                        "geo_operation_confirmation_invalid"
                    )?,
                    request.source_operation_id,
                    request.update_knowledge,
                ],
            )
            .map_err(|error| format!("create GEO operation: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit GEO operation: {error}"))?;
        self.get_geo_operation(&request.workspace_id, &operation_id)
    }

    pub fn get_geo_operation(
        &self,
        workspace_id: &str,
        operation_id: &str,
    ) -> Result<GeoOperationProjection, String> {
        validate_identity(operation_id, "geo_operation_id_invalid")?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        ensure_schema(&connection)?;
        read_operation(&connection, workspace_id, operation_id)?
            .ok_or_else(|| "geo_operation_not_found".to_string())
    }

    pub fn list_geo_operations(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoOperationListRequest,
    ) -> Result<Vec<GeoOperationProjection>, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        ensure_schema(&connection)?;
        if request.include_all_sessions {
            return Err("geo_operation_session_scope_required".to_string());
        }
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let sql = "SELECT id FROM geo_operations WHERE kind!='artifact-lineage' AND session_id=?2
                   ORDER BY updated_at DESC,id DESC LIMIT ?1";
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("prepare GEO operation list: {error}"))?;
        let ids = statement
            .query_map(params![limit, session_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query GEO operation list: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read GEO operation list: {error}"))?;
        ids.into_iter()
            .map(|id| {
                read_operation(&connection, workspace_id, &id)?
                    .ok_or_else(|| "geo_operation_not_found".to_string())
            })
            .collect()
    }

    /// Cross-session read-only tracer for the brand state summary
    /// (ADR-0010 Decision 3): every non-terminal operation of this one
    /// brand, as metadata only — never draft bodies or chat transcripts.
    /// It does not widen any read/write path for unapproved content: the
    /// session-private visibility rules elsewhere stay untouched. Rows
    /// whose owning session was deleted (`ON DELETE SET NULL`) are
    /// skipped — the owning session is part of the metadata contract.
    /// Returns at most `UNFINISHED_GEO_OPERATION_SUMMARY_LIMIT` newest
    /// entries plus the brand's full non-terminal count, so abandoned
    /// rounds cannot grow the summary without bound.
    pub fn list_unfinished_geo_operations(
        &self,
        workspace_id: &str,
    ) -> Result<GeoOperationUnfinishedList, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        ensure_schema(&connection)?;
        // 无主轮（session_id NULL，原会话删除后保留）同样非终态、同样可被
        // 接管——不过滤（票 10 验收实证：过滤会让无主轮对一切新会话不可见）。
        let unfinished_filter =
            "kind!='artifact-lineage' AND status NOT IN ('succeeded','failed','cancelled')";
        let total: usize = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM geo_operations WHERE {unfinished_filter}"),
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("count unfinished GEO operations: {error}"))?
            .try_into()
            .map_err(|_| "count unfinished GEO operations: overflow".to_string())?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT id,session_id,kind,goal,status,steps_json,
                    pending_confirmation_json,created_at,COALESCE(updated_at,created_at),
                    update_knowledge
                 FROM geo_operations
                 WHERE {unfinished_filter}
                 ORDER BY COALESCE(updated_at,created_at) DESC,id DESC
                 LIMIT ?1"
            ))
            .map_err(|error| format!("prepare unfinished GEO operation list: {error}"))?;
        let rows = statement
            .query_map([UNFINISHED_GEO_OPERATION_SUMMARY_LIMIT as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<bool>>(9)?,
                ))
            })
            .map_err(|error| format!("query unfinished GEO operation list: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read unfinished GEO operation list: {error}"))?;
        drop(statement);
        let mut pending_review_by_session: HashMap<String, i64> = HashMap::new();
        let mut summaries = Vec::with_capacity(rows.len());
        for (
            id,
            session_id,
            kind,
            goal,
            status,
            steps_json,
            confirmation_json,
            created_at,
            updated_at,
            update_knowledge,
        ) in rows
        {
            let steps: Vec<GeoOperationStep> =
                parse_json(&steps_json, "geo_operation_steps_corrupt")?;
            let stuck_step = steps
                .iter()
                .find(|step| {
                    matches!(
                        step.status.as_str(),
                        "awaiting-confirmation" | "running" | "ready"
                    )
                })
                .map(|step| GeoOperationUnfinishedStuckStep {
                    id: step.id.clone(),
                    title: step.title.clone(),
                    capability: step.capability.clone(),
                    status: step.status.clone(),
                });
            // 无主轮没有所有者会话名下的工作集，待审数量按 0 报告。
            let pending_review_count = match &session_id {
                None => 0,
                Some(owner) => match pending_review_by_session.get(owner) {
                    Some(count) => *count,
                    None => {
                        let count = count_session_draft_ready_articles(&connection, owner)?;
                        pending_review_by_session.insert(owner.clone(), count);
                        count
                    }
                },
            };
            summaries.push(GeoOperationUnfinishedSummary {
                id,
                session_id,
                kind,
                goal,
                status,
                stuck_step,
                pending_confirmation: parse_optional_json(
                    confirmation_json,
                    "geo_operation_confirmation_corrupt",
                )?,
                pending_review_count,
                created_at,
                updated_at,
                update_knowledge,
            });
        }
        Ok(GeoOperationUnfinishedList {
            operations: summaries,
            total,
        })
    }

    /// Disk-first app shutdown boundary. Only locally executing states are
    /// paused; confirmation gates remain untouched because they own no local
    /// worker. Persisted artifact/unit refs form the safe resume frontier.
    pub fn pause_active_geo_operations_for_shutdown(
        &self,
    ) -> Result<Vec<GeoOperationProjection>, String> {
        let mut paused = Vec::new();
        for workspace in self.list_workspaces()? {
            paused.extend(transition_workspace_operations(
                &workspace,
                None,
                None,
                &["running", "queued", "recovering"],
                "paused",
            )?);
        }
        Ok(paused)
    }

    /// Repairs an unclean prior app termination before any Sidecar can resume
    /// work. The user sees the same explicit Resume affordance as clean exit.
    pub fn recover_interrupted_geo_operations_on_startup(
        &self,
    ) -> Result<Vec<GeoOperationProjection>, String> {
        self.pause_active_geo_operations_for_shutdown()
    }

    /// Sidecar crash transition for one exact Rust-owned process generation.
    /// A late event from that generation loses both revision and execution
    /// generation CAS after this commit and cannot settle replacement work.
    pub fn recover_geo_operations_for_sidecar_generation(
        &self,
        workspace_id: &str,
        session_id: &str,
        dead_generation: u64,
    ) -> Result<Vec<GeoOperationProjection>, String> {
        validate_session_id(session_id)?;
        if dead_generation == 0 {
            return Err("geo_operation_sidecar_generation_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        transition_workspace_operations(
            &workspace,
            Some(session_id),
            Some(dead_generation),
            &["running", "queued"],
            "recovering",
        )
    }

    pub fn mutate_geo_operation(
        &self,
        request: GeoOperationMutationRequest,
    ) -> Result<GeoOperationProjection, String> {
        validate_mutation(&request)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        ensure_schema(&connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start GEO operation mutation: {error}"))?;
        let mut operation =
            read_operation(&transaction, &request.workspace_id, &request.operation_id)?
                .ok_or_else(|| "geo_operation_not_found".to_string())?;
        if operation.session_id != request.session_id {
            return Err(geo_operation_control_mismatch_error(&operation));
        }
        if operation.revision != request.expected_revision {
            return Err("geo_operation_revision_conflict".to_string());
        }
        if request
            .expected_execution_generation
            .is_some_and(|generation| generation != operation.execution_generation)
        {
            return Err("geo_operation_execution_generation_conflict".to_string());
        }
        if matches!(
            request.action.as_str(),
            "update-queue"
                | "start-step"
                | "checkpoint"
                | "complete-step"
                | "report-step-progress"
                | "fail-step"
        ) && operation.execution_sidecar_generation.is_some()
            && operation.execution_sidecar_generation != request.sidecar_generation
        {
            return Err("geo_operation_stale_sidecar_generation".to_string());
        }
        apply_action(&mut operation, &request)?;
        for reference in request.artifact_refs {
            if !operation.artifact_refs.iter().any(|existing| {
                existing.kind == reference.kind
                    && existing.id == reference.id
                    && existing.revision == reference.revision
            }) {
                operation.artifact_refs.push(reference);
            }
        }
        validate_refs(&operation.artifact_refs)?;
        let now = Utc::now().to_rfc3339();
        operation.updated_at.clone_from(&now);
        operation.revision += 1;
        let terminal_at = TERMINAL_STATUSES
            .contains(&operation.status.as_str())
            .then_some(now.clone());
        operation.terminal_at = terminal_at.clone();
        let changed = transaction
            .execute(
                "UPDATE geo_operations SET state=?1,status=?1,steps_json=?2,
                    artifact_refs_json=?3,checkpoint_json=?4,pending_confirmation_json=?5,
                    error_json=?6,revision=?7,updated_at=?8,terminal_at=?9,
                    queue_reason=?10,queue_position=?11,execution_generation=?12,
                    execution_sidecar_generation=?13,update_knowledge=?14
                 WHERE id=?15 AND session_id=?16 AND revision=?17",
                params![
                    operation.status,
                    json_string(&operation.steps, "geo_operation_steps_invalid")?,
                    json_string(
                        &operation.artifact_refs,
                        "geo_operation_artifact_refs_invalid"
                    )?,
                    optional_json_string(
                        operation.checkpoint.as_ref(),
                        "geo_operation_checkpoint_invalid"
                    )?,
                    optional_json_string(
                        operation.pending_confirmation.as_ref(),
                        "geo_operation_confirmation_invalid"
                    )?,
                    optional_json_string(operation.error.as_ref(), "geo_operation_error_invalid")?,
                    operation.revision,
                    operation.updated_at,
                    terminal_at,
                    operation.queue_reason,
                    operation.queue_position,
                    operation.execution_generation,
                    operation.execution_sidecar_generation,
                    operation.update_knowledge,
                    request.operation_id,
                    request.session_id,
                    request.expected_revision,
                ],
            )
            .map_err(|error| format!("mutate GEO operation: {error}"))?;
        if changed != 1 {
            return Err("geo_operation_revision_conflict".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("commit GEO operation mutation: {error}"))?;
        self.get_geo_operation(&request.workspace_id, &request.operation_id)
    }

    pub fn attest_geo_operation_external_gate(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoOperationExternalGateInput,
    ) -> Result<GeoOperationProjection, String> {
        validate_external_gate_request(session_id, &request)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let operation = read_operation(&connection, workspace_id, &request.operation_id)?
            .ok_or_else(|| "geo_operation_not_found".to_string())?;
        if operation.session_id != session_id {
            return Err(geo_operation_control_mismatch_error(&operation));
        }
        if operation.revision != request.expected_revision {
            return Err("geo_operation_revision_conflict".to_string());
        }
        let step = operation
            .steps
            .iter()
            .find(|step| step.id == request.step_id)
            .ok_or_else(|| "geo_operation_step_not_found".to_string())?;
        if operation.status != "awaiting-confirmation"
            || step.status != "awaiting-confirmation"
            || !step.requires_confirmation
        {
            return Err("geo_operation_confirmation_step_invalid".to_string());
        }
        let authority = step
            .confirmation
            .as_ref()
            .map(|confirmation| confirmation.authority.as_str())
            .ok_or_else(|| "geo_operation_confirmation_step_invalid".to_string())?;
        validate_external_gate_evidence(&connection, session_id, authority, &request.evidence_ref)?;
        drop(connection);

        self.mutate_geo_operation(GeoOperationMutationRequest {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
            operation_id: request.operation_id,
            expected_revision: request.expected_revision,
            action: "attest-external-gate".to_string(),
            step_id: Some(request.step_id),
            checkpoint: None,
            error: None,
            artifact_refs: vec![request.evidence_ref],
            replacement_steps: None,
            replacement_reason: None,
            update_knowledge: None,
            step_progress: None,
            queue_reason: None,
            queue_position: None,
            expected_execution_generation: None,
            sidecar_generation: None,
        })
    }

    /// 接管一个未完成轮次（ADR-0010）：CAS 把所有权从当前所有者转移给
    /// `request.session_id`（经信息闸门卡片整卡一次确认后由 MCP 工具调用）。
    ///
    /// 守卫与不变量（与测试一一对应）：
    /// - 终态轮次不可接管——未完成才有可继续的工作；
    /// - running/queued/recovering 拒绝接管（与退出固化暂停同一活跃集），
    ///   错误文本可转述；常见路径（关旧窗再开新窗）已由 pause-on-exit
    ///   保证轮次处于可接管态；
    /// - revision + 所有者键在同一 Immediate 事务内先读后写，并发接管
    ///   先到者得；后到者收到 `geo_operation_takeover_conflict` 指明赢家；
    /// - 同一事务内 awaiting-selection 池与未批准文章操作（含草稿）随
    ///   operation 整体转移、不拆分；全批准产物与他人工作集不动；
    /// - 留痕：`session_id`=接管者，`taken_over_from_session_id`/`taken_over_at`
    ///   记录原所有者与时间；原会话随后的控制访问由
    ///   [`geo_operation_control_mismatch_error`] 得到指明接管者的错误；
    /// - 18+1 步状态机与确认门位置零改动：不推进步骤、不改写序列。
    pub fn takeover_geo_operation(
        &self,
        request: GeoOperationTakeoverRequest,
    ) -> Result<GeoOperationTakeoverReceipt, String> {
        validate_session_id(&request.session_id)?;
        validate_identity(&request.operation_id, "geo_operation_id_invalid")?;
        if request.expected_revision < 1 {
            return Err("geo_operation_revision_invalid".to_string());
        }
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        ensure_schema(&connection)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start GEO operation takeover: {error}"))?;
        // 守卫读取不走 read_operation 的整行投影：无主轮（session_id NULL，
        // 原会话删除后保留）的 session_id 在投影里是 String，NULL 行会让
        // 读取本身失败——无主轮恰恰是接管的合法标的（票 10 验收实证）。
        // CAS 成功后 get_geo_operation 读到的是新属主（非 NULL），投影安全。
        let guard = transaction
            .query_row(
                "SELECT session_id,status,revision,taken_over_at
                 FROM geo_operations WHERE id=?1 AND kind!='artifact-lineage'",
                [&request.operation_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read GEO operation takeover guard: {error}"))?;
        let (operation_session_id, operation_status, operation_revision, operation_taken_over_at) =
            guard.ok_or_else(|| "geo_operation_not_found".to_string())?;
        if TERMINAL_STATUSES.contains(&operation_status.as_str()) {
            return Err(format!(
                "geo_operation_takeover_terminal:{} (only unfinished rounds can be taken over; start a new operation instead)",
                operation_status
            ));
        }
        if matches!(
            operation_status.as_str(),
            "running" | "queued" | "recovering"
        ) {
            return Err(format!(
                "geo_operation_takeover_running:{} (the owning session is still executing this round; it must pause or finish first)",
                operation_status
            ));
        }
        if operation_session_id.as_deref() == Some(request.session_id.as_str()) {
            return Err(
                "geo_operation_takeover_already_owner (this session already owns this operation; continue with inspect_geo_operations)"
                    .to_string(),
            );
        }
        if operation_revision != request.expected_revision {
            if operation_taken_over_at.is_some() {
                return Err(format!(
                    "geo_operation_takeover_conflict:taken_over_by={} (another session took over this round first)",
                    operation_session_id.as_deref().unwrap_or("<ownerless>")
                ));
            }
            return Err("geo_operation_revision_conflict".to_string());
        }
        let previous_owner_session_id = operation_session_id;
        let now = Utc::now().to_rfc3339();
        // CAS 的属主比对必须 NULL 感知：无主轮的 previous owner 是 NULL，
        // SQL 三值逻辑下 `session_id=NULL` 恒不成立会把合法接管误判为
        // revision 冲突（票 10 验收实证）。
        let changed = transaction
            .execute(
                "UPDATE geo_operations SET session_id=?1,revision=revision+1,updated_at=?2,
                    taken_over_from_session_id=?3,taken_over_at=?2
                 WHERE id=?4
                   AND ((?3 IS NULL AND session_id IS NULL) OR session_id=?3)
                   AND revision=?5",
                params![
                    request.session_id,
                    now,
                    previous_owner_session_id,
                    request.operation_id,
                    request.expected_revision,
                ],
            )
            .map_err(|error| format!("persist GEO operation takeover: {error}"))?;
        if changed != 1 {
            return Err("geo_operation_revision_conflict".to_string());
        }
        // 无主轮没有原所有者名下的工作集，随行转移按 0 计；有主轮照旧
        // 在同一事务内转移未批准文章与待选池。
        let (transferred_article_operations, transferred_question_pools) =
            match previous_owner_session_id.as_deref() {
                None => (0, 0),
                Some(previous_owner) => (
                    super::articles::transfer_unapproved_article_work(
                        &transaction,
                        previous_owner,
                        &request.session_id,
                    )?,
                    super::question_pools::transfer_awaiting_selection_pools(
                        &transaction,
                        previous_owner,
                        &request.session_id,
                    )?,
                ),
            };
        transaction
            .commit()
            .map_err(|error| format!("commit GEO operation takeover: {error}"))?;
        let operation = self.get_geo_operation(&request.workspace_id, &request.operation_id)?;
        Ok(GeoOperationTakeoverReceipt {
            operation,
            previous_owner_session_id,
            taken_over_at: now,
            transferred_article_operations,
            transferred_question_pools,
        })
    }
}

fn transition_workspace_operations(
    workspace: &BrandWorkspace,
    session_id: Option<&str>,
    sidecar_generation: Option<u64>,
    statuses: &[&str],
    target_status: &str,
) -> Result<Vec<GeoOperationProjection>, String> {
    let mut connection = open_database(workspace)?;
    ensure_schema(&connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("start GEO recovery transaction: {error}"))?;
    let mut statement = transaction
        .prepare(
            "SELECT id FROM geo_operations
             WHERE kind!='artifact-lineage'
               AND (?1 IS NULL OR session_id=?1)
               AND (?2 IS NULL OR execution_sidecar_generation=?2)
               AND status IN ('running','queued','recovering')
             ORDER BY updated_at,id",
        )
        .map_err(|error| format!("prepare GEO recovery list: {error}"))?;
    let ids = statement
        .query_map(params![session_id, sidecar_generation], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("query GEO recovery list: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read GEO recovery list: {error}"))?;
    drop(statement);

    let now = Utc::now().to_rfc3339();
    let mut transitioned = Vec::new();
    for id in ids {
        let mut operation = read_operation(&transaction, &workspace.id, &id)?
            .ok_or_else(|| "geo_operation_not_found".to_string())?;
        if !statuses.contains(&operation.status.as_str()) {
            continue;
        }
        if operation
            .checkpoint
            .as_ref()
            .is_none_or(|checkpoint| !checkpoint.safe_to_resume)
        {
            operation.checkpoint = Some(derived_recovery_checkpoint(&operation, &now));
        }
        operation.status = target_status.to_string();
        operation.queue_reason = None;
        operation.queue_position = None;
        operation.execution_sidecar_generation = None;
        operation.execution_generation += 1;
        operation.revision += 1;
        operation.updated_at.clone_from(&now);
        operation.terminal_at = None;
        let changed = transaction
            .execute(
                "UPDATE geo_operations SET state=?1,status=?1,checkpoint_json=?2,
                    revision=?3,execution_generation=?4,
                    execution_sidecar_generation=NULL,queue_reason=NULL,
                    queue_position=NULL,updated_at=?5,terminal_at=NULL
                 WHERE id=?6 AND revision=?7",
                params![
                    operation.status,
                    optional_json_string(
                        operation.checkpoint.as_ref(),
                        "geo_operation_checkpoint_invalid"
                    )?,
                    operation.revision,
                    operation.execution_generation,
                    operation.updated_at,
                    operation.id,
                    operation.revision - 1,
                ],
            )
            .map_err(|error| format!("persist GEO recovery checkpoint: {error}"))?;
        if changed != 1 {
            return Err("geo_operation_revision_conflict".to_string());
        }
        transitioned.push(operation);
    }
    transaction
        .commit()
        .map_err(|error| format!("commit GEO recovery transaction: {error}"))?;
    Ok(transitioned)
}

fn derived_recovery_checkpoint(
    operation: &GeoOperationProjection,
    saved_at: &str,
) -> GeoOperationCheckpoint {
    let active_step = operation
        .steps
        .iter()
        .find(|step| matches!(step.status.as_str(), "running" | "ready" | "failed"));
    let active_retry_unit = active_step
        .filter(|step| step.retry_unit != "operation")
        .map(|step| step.retry_unit.clone());
    GeoOperationCheckpoint {
        active_step_id: active_step.map(|step| step.id.clone()),
        completed_step_ids: operation
            .steps
            .iter()
            .filter(|step| matches!(step.status.as_str(), "succeeded" | "skipped"))
            .map(|step| step.id.clone())
            .collect(),
        completed_unit_refs: operation.artifact_refs.clone(),
        safe_to_resume: true,
        saved_at: saved_at.to_string(),
        execution_generation: Some(operation.execution_generation),
        sidecar_generation: operation.execution_sidecar_generation,
        active_unit_id: active_retry_unit.as_ref().and_then(|_| {
            operation
                .error
                .as_ref()
                .and_then(|error| error.unit_id.clone())
                .or_else(|| active_step.map(|step| step.id.clone()))
        }),
        active_retry_unit,
    }
}

fn apply_action(
    operation: &mut GeoOperationProjection,
    request: &GeoOperationMutationRequest,
) -> Result<(), String> {
    match request.action.as_str() {
        "queue-step" => {
            require_status(&operation.status, &["ready", "recovering"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            if step.status != "ready" || step.requires_confirmation {
                return Err("geo_operation_step_not_queueable".to_string());
            }
            let (reason, position) = queue_projection(request)?;
            operation.status = "queued".to_string();
            operation.queue_reason = Some(reason);
            operation.queue_position = Some(position);
            operation.execution_sidecar_generation = request.sidecar_generation;
        }
        "update-queue" => {
            require_status(&operation.status, &["queued"])?;
            let (reason, position) = queue_projection(request)?;
            operation.queue_reason = Some(reason);
            operation.queue_position = Some(position);
        }
        "start-step" => {
            require_status(&operation.status, &["ready", "queued", "recovering"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            if step.status != "ready" || step.requires_confirmation {
                return Err("geo_operation_step_not_startable".to_string());
            }
            step.status = "running".to_string();
            operation.status = "running".to_string();
            operation.queue_reason = None;
            operation.queue_position = None;
            operation.execution_generation += 1;
            operation.execution_sidecar_generation = request.sidecar_generation;
        }
        "checkpoint" => {
            require_status(&operation.status, &["running", "recovering"])?;
            let checkpoint = request
                .checkpoint
                .clone()
                .ok_or_else(|| "geo_operation_checkpoint_required".to_string())?;
            validate_checkpoint(operation, &checkpoint)?;
            operation.checkpoint = Some(checkpoint);
        }
        // 量化进度上报：只允许 running 步骤接收（如逐篇生成 N/M），
        // 不改状态、不推进入口，进度条据此实时移动。
        "report-step-progress" => {
            require_status(&operation.status, &["running"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            if step.status != "running" {
                return Err("geo_operation_step_not_progressable".to_string());
            }
            let progress = request
                .step_progress
                .clone()
                .ok_or_else(|| "geo_operation_step_progress_required".to_string())?;
            validate_step_progress(&progress)?;
            step.progress = Some(progress);
        }
        "complete-step" => {
            require_status(&operation.status, &["running"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            if step.status != "running" || step.requires_confirmation {
                return Err("geo_operation_step_not_completable".to_string());
            }
            step.status = "succeeded".to_string();
            operation.checkpoint = None;
            advance_operation(operation)?;
        }
        "skip-step" => {
            require_status(&operation.status, &["ready", "awaiting-confirmation"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            if step.condition.is_none()
                || !matches!(step.status.as_str(), "ready" | "awaiting-confirmation")
            {
                return Err("geo_operation_step_not_skippable".to_string());
            }
            step.status = "skipped".to_string();
            operation.pending_confirmation = None;
            advance_operation(operation)?;
        }
        "confirm-step" => {
            require_status(&operation.status, &["awaiting-confirmation"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            if step.status != "awaiting-confirmation" || !step.requires_confirmation {
                return Err("geo_operation_confirmation_step_invalid".to_string());
            }
            let authority = step
                .confirmation
                .as_ref()
                .map(|value| value.authority.as_str())
                .ok_or_else(|| "geo_operation_confirmation_step_invalid".to_string())?;
            if matches!(authority, "publish-scheduler" | "post-publish-monitor") {
                return Err("geo_operation_confirmation_requires_rust_ui_authority".to_string());
            }
            step.status = "succeeded".to_string();
            operation.pending_confirmation = None;
            advance_operation(operation)?;
        }
        "attest-external-gate" => {
            require_status(&operation.status, &["awaiting-confirmation"])?;
            let step = operation_step_mut(operation, request.step_id.as_deref())?;
            let authority = step
                .confirmation
                .as_ref()
                .map(|value| value.authority.as_str())
                .ok_or_else(|| "geo_operation_confirmation_step_invalid".to_string())?;
            if step.status != "awaiting-confirmation"
                || !step.requires_confirmation
                || !matches!(authority, "publish-scheduler" | "post-publish-monitor")
            {
                return Err("geo_operation_external_gate_invalid".to_string());
            }
            step.status = "succeeded".to_string();
            operation.pending_confirmation = None;
            advance_operation(operation)?;
        }
        "replace-plan" => {
            let replacement = request
                .replacement_steps
                .clone()
                .ok_or_else(|| "geo_operation_replacement_steps_required".to_string())?;
            validate_steps(&replacement)?;
            match request.replacement_reason.as_deref() {
                // 跳过出口（票 07，spec 2026-09-02 决策 5）：材料请求卡的
                // 「跳过材料收集」经计划替换剥离知识段剩余步骤。守卫按场景
                // 校验形状——替换步骤必须恰为「原计划剥掉未走完的知识段
                // 步骤」，已完成/已确认步骤保留，不得夹带其他编辑；替换后
                // 从首个未走完步骤续接（advance_operation 尊重已成功前缀，
                // 不重停认可门）。不为该场景新增里程碑：里程碑推进器的确认
                // 门放行够不着被前置步骤挡住的等待门。
                Some("material-collection-skip") => {
                    require_status(
                        &operation.status,
                        &["ready", "running", "awaiting-confirmation"],
                    )?;
                    let expected = strip_incomplete_knowledge_steps(&operation.steps);
                    if replacement.len() == operation.steps.len() || replacement != expected {
                        return Err("geo_operation_plan_replacement_invalid".to_string());
                    }
                    operation.steps = replacement;
                    if let Some(update_knowledge) = request.update_knowledge {
                        operation.update_knowledge = Some(update_knowledge);
                    }
                    operation.pending_confirmation = None;
                    operation.checkpoint = None;
                    operation.error = None;
                    advance_operation(operation)?;
                }
                // 知识分支决策（既有唯一形态）：分支未决停卡被显式回答
                // 替换为已决计划，首个步骤重停自己的门。
                _ => {
                    require_status(&operation.status, &["awaiting-confirmation"])?;
                    if operation.kind != "next-round-optimization"
                        || operation.steps.len() != 1
                        || operation.steps[0].id != "decide-knowledge-refresh"
                    {
                        return Err("geo_operation_plan_replacement_invalid".to_string());
                    }
                    operation.steps = replacement;
                    // 知识分支的用户显式答案随替换一次落库（票 #04）：携带即覆盖，
                    // 缺省保持现值（跳过出口等后续 replace-plan 调用方不受影响）。
                    // revision 语义不变——决策持久化不额外递增，仍是一次 mutation
                    // 一次 CAS 递增。
                    if let Some(update_knowledge) = request.update_knowledge {
                        operation.update_knowledge = Some(update_knowledge);
                    }
                    operation.pending_confirmation = None;
                    operation.checkpoint = None;
                    operation.error = None;
                    normalize_first_step(operation)?;
                }
            }
        }
        "pause" => {
            if let Err(error) = require_status(
                &operation.status,
                &["ready", "queued", "running", "recovering"],
            ) {
                return Err(control_guard_error(&error, &operation.status));
            }
            if operation.status == "running"
                && !operation
                    .checkpoint
                    .as_ref()
                    .is_some_and(|checkpoint| checkpoint.safe_to_resume)
            {
                return Err("geo_operation_safe_checkpoint_required".to_string());
            }
            operation.status = "paused".to_string();
        }
        "recover" => {
            require_status(&operation.status, &["ready", "queued", "running"])?;
            if operation.status == "running"
                && !operation
                    .checkpoint
                    .as_ref()
                    .is_some_and(|checkpoint| checkpoint.safe_to_resume)
            {
                return Err("geo_operation_safe_checkpoint_required".to_string());
            }
            operation.status = "recovering".to_string();
            operation.queue_reason = None;
            operation.queue_position = None;
            operation.execution_sidecar_generation = None;
            operation.execution_generation += 1;
        }
        "resume" => {
            if let Err(error) = require_status(&operation.status, &["paused", "recovering"]) {
                return Err(control_guard_error(&error, &operation.status));
            }
            if let Some(step) = operation
                .steps
                .iter_mut()
                .find(|step| step.status == "running")
            {
                step.status = "ready".to_string();
                step.progress = None;
            }
            operation.status = "ready".to_string();
            operation.execution_generation += 1;
            operation.execution_sidecar_generation = None;
        }
        "retry" => {
            if let Err(error) = require_status(&operation.status, &["failed"]) {
                return Err(control_guard_error(&error, &operation.status));
            }
            if !operation
                .error
                .as_ref()
                .is_some_and(|error| error.retryable)
            {
                return Err(
                    "geo_operation_error_not_retryable (only failures marked retryable can be retried; start a new operation instead)"
                        .to_string(),
                );
            }
            let failed_step = operation
                .steps
                .iter()
                .find(|step| step.status == "failed")
                .ok_or_else(|| "geo_operation_step_not_found".to_string())?;
            if failed_step.retry_unit == "operation"
                || operation
                    .error
                    .as_ref()
                    .and_then(|error| error.unit_id.as_deref())
                    .is_none()
            {
                return Err("geo_operation_retry_unit_not_safe".to_string());
            }
            operation.status = "ready".to_string();
            operation.error = None;
            if let Some(step) = operation
                .steps
                .iter_mut()
                .find(|step| step.status == "failed")
            {
                step.status = "ready".to_string();
                step.progress = None;
            }
            operation.execution_generation += 1;
            operation.execution_sidecar_generation = None;
        }
        "fail-step" => {
            require_status(
                &operation.status,
                &["ready", "queued", "running", "recovering"],
            )?;
            let error = request
                .error
                .clone()
                .ok_or_else(|| "geo_operation_error_required".to_string())?;
            validate_error(&error)?;
            operation.error = Some(error);
            operation.status = "failed".to_string();
            operation_step_mut(operation, request.step_id.as_deref())?.status =
                "failed".to_string();
        }
        "cancel" => {
            if TERMINAL_STATUSES.contains(&operation.status.as_str()) {
                return Err(format!(
                    "geo_operation_already_terminal:{} (no control action is valid; start a new operation instead)",
                    operation.status
                ));
            }
            operation.status = "cancelled".to_string();
        }
        _ => return Err("geo_operation_action_invalid".to_string()),
    }
    Ok(())
}

fn queue_projection(request: &GeoOperationMutationRequest) -> Result<(String, i64), String> {
    let reason = request
        .queue_reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 240)
        .ok_or_else(|| "geo_operation_queue_reason_invalid".to_string())?;
    let position = request
        .queue_position
        .filter(|position| (1..=10_000).contains(position))
        .ok_or_else(|| "geo_operation_queue_position_invalid".to_string())?;
    Ok((reason.to_string(), position))
}

fn operation_step_mut<'a>(
    operation: &'a mut GeoOperationProjection,
    step_id: Option<&str>,
) -> Result<&'a mut GeoOperationStep, String> {
    if let Some(step_id) = step_id {
        operation.steps.iter_mut().find(|step| step.id == step_id)
    } else {
        operation.steps.iter_mut().find(|step| {
            matches!(
                step.status.as_str(),
                "ready" | "running" | "awaiting-confirmation" | "failed"
            )
        })
    }
    .ok_or_else(|| "geo_operation_step_not_found".to_string())
}

/// 知识段步骤 id（与 shared policy 的 KNOWLEDGE_STEPS 同一序列，票 07）：
/// 材料收集 / 事实提取 / 知识确认。步骤形状的 policy 在 TS，Rust 侧按 id
/// 判定「知识段剩余步骤」，职责只是把未走完的知识段步骤从持久层计划里
/// 剥掉——已完成（succeeded/skipped）的保留。
const KNOWLEDGE_SEGMENT_STEP_IDS: [&str; 3] =
    ["collect-materials", "extract-facts", "confirm-knowledge"];

/// 跳过出口（票 07）的替换形状期望值：原步骤序列剥掉未走完的知识段步骤。
fn strip_incomplete_knowledge_steps(steps: &[GeoOperationStep]) -> Vec<GeoOperationStep> {
    steps
        .iter()
        .filter(|step| {
            !KNOWLEDGE_SEGMENT_STEP_IDS.contains(&step.id.as_str())
                || matches!(step.status.as_str(), "succeeded" | "skipped")
        })
        .cloned()
        .collect()
}

fn normalize_first_step(operation: &mut GeoOperationProjection) -> Result<(), String> {
    let Some(step) = operation.steps.first_mut() else {
        return Err("geo_operation_steps_invalid".to_string());
    };
    if step.requires_confirmation {
        let confirmation = step
            .confirmation
            .clone()
            .ok_or_else(|| "geo_operation_confirmation_step_invalid".to_string())?;
        step.status = "awaiting-confirmation".to_string();
        operation.pending_confirmation = Some(confirmation);
        operation.status = "awaiting-confirmation".to_string();
    } else {
        step.status = "ready".to_string();
        operation.status = "ready".to_string();
    }
    Ok(())
}

fn advance_operation(operation: &mut GeoOperationProjection) -> Result<(), String> {
    if let Some(step) = operation
        .steps
        .iter_mut()
        .find(|step| step.status == "pending")
    {
        if step.requires_confirmation {
            let confirmation = step
                .confirmation
                .clone()
                .ok_or_else(|| "geo_operation_confirmation_step_invalid".to_string())?;
            step.status = "awaiting-confirmation".to_string();
            operation.pending_confirmation = Some(confirmation);
            operation.status = "awaiting-confirmation".to_string();
        } else {
            step.status = "ready".to_string();
            operation.status = "ready".to_string();
        }
    } else {
        operation.pending_confirmation = None;
        operation.error = None;
        operation.status = "succeeded".to_string();
    }
    Ok(())
}

fn require_status(current: &str, allowed: &[&str]) -> Result<(), String> {
    if !OPERATION_STATUSES.contains(&current) {
        Err("geo_operation_status_corrupt".to_string())
    } else if allowed.contains(&current) {
        Ok(())
    } else {
        Err(format!("geo_operation_transition_invalid:{current}"))
    }
}

/// Session/所有权检查的单一判定点（票 #26 prefactor）：非所有者会话对
/// operation 的控制类访问一律经这里产出错误文本。接管（ADR-0010）落地后，
/// 「当前所有者」取代「创建会话」成为判定键，被接管的原会话在这里拿到
/// 指明接管者的可转述错误——散落的比较收敛于此，改键只动这一处。
pub fn geo_operation_control_mismatch_error(operation: &GeoOperationProjection) -> String {
    if operation.taken_over_at.is_some() {
        format!(
            "geo_operation_session_mismatch:taken_over_by={}",
            operation.session_id
        )
    } else {
        "geo_operation_session_mismatch".to_string()
    }
}

/// Agent 可用控制动作（pause/resume/retry/cancel）按状态的可用地表。
/// 只服务于错误提示；真实守卫仍是各分支自己的 require_status。
fn control_actions_for_status(status: &str) -> &'static [&'static str] {
    match status {
        "ready" | "queued" | "running" => &["pause", "cancel"],
        "awaiting-confirmation" => &["cancel"],
        "paused" | "recovering" => &["pause", "resume", "cancel"],
        "failed" => &["retry"],
        _ => &[],
    }
}

/// 控制类动作转换失败时把当前状态下的合法动作附进错误文本，让调用方
/// （Agent / 面板）一次拿到恢复路径，不必逐个动作试探。
fn control_guard_error(error: &str, current: &str) -> String {
    if !error.starts_with("geo_operation_transition_invalid") {
        return error.to_string();
    }
    let actions = control_actions_for_status(current);
    if actions.is_empty() {
        format!("geo_operation_transition_invalid:{current} (no control action is valid in this status)")
    } else {
        format!(
            "geo_operation_transition_invalid:{current} (valid control actions: {})",
            actions.join(", ")
        )
    }
}

fn read_operation(
    connection: &rusqlite::Connection,
    workspace_id: &str,
    operation_id: &str,
) -> Result<Option<GeoOperationProjection>, String> {
    connection
        .query_row(
            "SELECT id,session_id,kind,goal,status,steps_json,input_refs_json,
                artifact_refs_json,checkpoint_json,pending_confirmation_json,error_json,
                source_operation_id,update_knowledge,revision,execution_generation,
                execution_sidecar_generation,queue_reason,queue_position,
                created_at,COALESCE(updated_at,created_at),terminal_at,
                taken_over_from_session_id,taken_over_at
             FROM geo_operations WHERE id=?1 AND kind!='artifact-lineage'",
            [operation_id],
            |row| {
                let steps_json: String = row.get(5)?;
                let input_refs_json: String = row.get(6)?;
                let artifact_refs_json: String = row.get(7)?;
                let checkpoint_json: Option<String> = row.get(8)?;
                let confirmation_json: Option<String> = row.get(9)?;
                let error_json: Option<String> = row.get(10)?;
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    steps_json,
                    input_refs_json,
                    artifact_refs_json,
                    checkpoint_json,
                    confirmation_json,
                    error_json,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, Option<bool>>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, Option<u64>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, Option<i64>>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, String>(19)?,
                    row.get::<_, Option<String>>(20)?,
                    row.get::<_, Option<String>>(21)?,
                    row.get::<_, Option<String>>(22)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read GEO operation: {error}"))?
        .map(
            |(
                id,
                session_id,
                kind,
                goal,
                status,
                steps_json,
                input_refs_json,
                artifact_refs_json,
                checkpoint_json,
                confirmation_json,
                error_json,
                source_operation_id,
                update_knowledge,
                revision,
                execution_generation,
                execution_sidecar_generation,
                queue_reason,
                queue_position,
                created_at,
                updated_at,
                terminal_at,
                taken_over_from_session_id,
                taken_over_at,
            )| {
                Ok(GeoOperationProjection {
                    id,
                    workspace_id: workspace_id.to_string(),
                    session_id,
                    kind,
                    goal,
                    status,
                    steps: parse_json(&steps_json, "geo_operation_steps_corrupt")?,
                    input_refs: parse_json(&input_refs_json, "geo_operation_input_refs_corrupt")?,
                    artifact_refs: parse_json(
                        &artifact_refs_json,
                        "geo_operation_artifact_refs_corrupt",
                    )?,
                    checkpoint: parse_optional_json(
                        checkpoint_json,
                        "geo_operation_checkpoint_corrupt",
                    )?,
                    pending_confirmation: parse_optional_json(
                        confirmation_json,
                        "geo_operation_confirmation_corrupt",
                    )?,
                    error: parse_optional_json(error_json, "geo_operation_error_corrupt")?,
                    source_operation_id,
                    update_knowledge,
                    revision,
                    execution_generation,
                    execution_sidecar_generation,
                    queue_reason,
                    queue_position,
                    created_at,
                    updated_at,
                    terminal_at,
                    taken_over_from_session_id,
                    taken_over_at,
                })
            },
        )
        .transpose()
}

/// 待审数量：当前所有者会话名下处于 draft_ready 且尚未批准的文章篇数
/// （ADR-0010 改键：所有者 = `COALESCE(owner_session_id, created_by_session_id)`，
/// 接管后随工作集走）。只统计 COUNT，不读取任何正文、标题或正文路径。
fn count_session_draft_ready_articles(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM geo_articles article
             JOIN geo_article_operations article_operation
               ON article_operation.operation_id=article.operation_id
             WHERE COALESCE(article_operation.owner_session_id,
                            article_operation.created_by_session_id)=?1
               AND article.status='draft_ready'
               AND article.approved_revision IS NULL",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("count pending article reviews: {error}"))
}

pub(super) fn mark_artifacts_affected_by_knowledge_change(
    transaction: &rusqlite::Transaction<'_>,
    knowledge_version: i64,
    fact_key: &str,
    now: &str,
) -> Result<Vec<GeoArtifactFreshnessProjection>, String> {
    ensure_schema(transaction)?;
    let mut statement = transaction
        .prepare(
            "SELECT artifact.id
             FROM geo_artifacts artifact
             LEFT JOIN knowledge_version_facts previous
               ON previous.knowledge_version=artifact.knowledge_version AND previous.fact_key=?2
             LEFT JOIN knowledge_version_facts current
               ON current.knowledge_version=?1 AND current.fact_key=?2
             WHERE artifact.knowledge_version IS NOT NULL
               AND artifact.knowledge_version < ?1
               AND artifact.kind IN ('question-pool','topic-plan','article-draft','distribution-plan')
               AND (
                 COALESCE(previous.normalized_value_json,'__missing__')
                   != COALESCE(current.normalized_value_json,'__missing__')
                 OR COALESCE(previous.unit,'') != COALESCE(current.unit,'')
               )",
        )
        .map_err(|error| format!("prepare knowledge artifact invalidation: {error}"))?;
    let artifact_ids = statement
        .query_map(params![knowledge_version, fact_key], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("query knowledge artifact invalidation: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read knowledge artifact invalidation: {error}"))?;
    drop(statement);
    let mut affected = Vec::with_capacity(artifact_ids.len());
    for artifact_id in artifact_ids {
        let existing: Option<String> = transaction
            .query_row(
                "SELECT changed_fact_keys_json FROM geo_artifact_freshness WHERE artifact_id=?1",
                [&artifact_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read artifact freshness: {error}"))?;
        let mut keys: Vec<String> = existing
            .as_deref()
            .map(|json| parse_json(json, "geo_artifact_freshness_corrupt"))
            .transpose()?
            .unwrap_or_default();
        if !keys.iter().any(|key| key == fact_key) {
            keys.push(fact_key.to_string());
            keys.sort();
        }
        transaction
            .execute(
                "INSERT INTO geo_artifact_freshness
                    (artifact_id,status,compared_to_knowledge_version,changed_fact_keys_json,marked_at)
                 VALUES (?1,'needs-confirmation',?2,?3,?4)
                 ON CONFLICT(artifact_id) DO UPDATE SET
                   status='needs-confirmation',
                   compared_to_knowledge_version=excluded.compared_to_knowledge_version,
                   changed_fact_keys_json=excluded.changed_fact_keys_json,
                   marked_at=excluded.marked_at",
                params![
                    artifact_id,
                    knowledge_version,
                    json_string(&keys, "geo_artifact_freshness_invalid")?,
                    now,
                ],
            )
            .map_err(|error| format!("mark artifact freshness: {error}"))?;
        affected.push(GeoArtifactFreshnessProjection {
            artifact_id,
            status: "needs-confirmation".to_string(),
            compared_to_knowledge_version: knowledge_version,
            changed_fact_keys: keys,
            marked_at: now.to_string(),
        });
    }
    Ok(affected)
}

fn validate_create(request: &GeoOperationCreateRequest) -> Result<(), String> {
    validate_session_id(&request.session_id)?;
    if !STRUCTURED_KINDS.contains(&request.kind.as_str()) {
        return Err("geo_operation_kind_invalid".to_string());
    }
    let goal = request.goal.trim();
    if goal.is_empty() || goal.chars().count() > 500 {
        return Err("geo_operation_goal_invalid".to_string());
    }
    if !matches!(request.status.as_str(), "ready" | "awaiting-confirmation") {
        return Err("geo_operation_initial_status_invalid".to_string());
    }
    validate_steps(&request.steps)?;
    let first = request
        .steps
        .first()
        .ok_or_else(|| "geo_operation_steps_invalid".to_string())?;
    let initial_state_matches = match request.status.as_str() {
        "ready" => first.status == "ready" && request.pending_confirmation.is_none(),
        "awaiting-confirmation" => {
            first.status == "awaiting-confirmation"
                && first.confirmation == request.pending_confirmation
        }
        _ => false,
    };
    if !initial_state_matches
        || request
            .steps
            .iter()
            .skip(1)
            .any(|step| step.status != "pending")
    {
        return Err("geo_operation_initial_state_invalid".to_string());
    }
    validate_refs(&request.input_refs)?;
    if let Some(value) = request.pending_confirmation.as_ref() {
        validate_confirmation(value)?;
    }
    Ok(())
}

fn validate_steps(steps: &[GeoOperationStep]) -> Result<(), String> {
    if steps.is_empty() || steps.len() > 64 {
        return Err("geo_operation_steps_invalid".to_string());
    }
    let mut ids = HashSet::new();
    for step in steps {
        validate_identity(&step.id, "geo_operation_step_invalid")?;
        if !ids.insert(step.id.as_str())
            || step.title.trim().is_empty()
            || step.title.chars().count() > 120
            || !CAPABILITIES.contains(&step.capability.as_str())
            || !STEP_STATUSES.contains(&step.status.as_str())
            || !RETRY_UNITS.contains(&step.retry_unit.as_str())
            || step.condition.as_deref().is_some_and(|condition| {
                !matches!(
                    condition,
                    "if-evidence-insufficient" | "if-knowledge-refresh-requested"
                )
            })
            || step.requires_confirmation != step.confirmation.is_some()
            || step
                .progress
                .as_ref()
                .is_some_and(|progress| validate_step_progress(progress).is_err())
        {
            return Err("geo_operation_step_invalid".to_string());
        }
        if let Some(value) = step.confirmation.as_ref() {
            validate_confirmation(value)?;
        }
        if step.irreversible
            && !step.confirmation.as_ref().is_some_and(|value| {
                matches!(value.kind.as_str(), "paid-publish" | "external-publish")
            })
        {
            return Err("geo_operation_irreversible_gate_invalid".to_string());
        }
    }
    Ok(())
}

fn validate_step_progress(progress: &GeoOperationStepProgress) -> Result<(), String> {
    if !(1..=100_000).contains(&progress.total) || !(0..=progress.total).contains(&progress.current)
    {
        return Err("geo_operation_step_progress_invalid".to_string());
    }
    Ok(())
}

fn validate_confirmation(value: &GeoOperationConfirmation) -> Result<(), String> {
    if !CONFIRMATION_KINDS.contains(&value.kind.as_str())
        || !CONFIRMATION_AUTHORITIES.contains(&value.authority.as_str())
        || value.title.trim().is_empty()
        || value.title.chars().count() > 160
        || value.summary.trim().is_empty()
        || value.summary.chars().count() > 1_000
    {
        return Err("geo_operation_confirmation_invalid".to_string());
    }
    let authority_matches = match value.kind.as_str() {
        "plan-ack" => value.authority == "geo-operation",
        "knowledge-change" => value.authority == "knowledge-authority",
        "paid-publish" | "external-publish" => value.authority == "publish-scheduler",
        "monitoring-activation" => value.authority == "post-publish-monitor",
        _ => value.authority == "brand-workspace",
    };
    if !authority_matches {
        return Err("geo_operation_confirmation_authority_invalid".to_string());
    }
    Ok(())
}

fn validate_checkpoint(
    operation: &GeoOperationProjection,
    checkpoint: &GeoOperationCheckpoint,
) -> Result<(), String> {
    if checkpoint
        .saved_at
        .parse::<chrono::DateTime<Utc>>()
        .is_err()
        || checkpoint
            .execution_generation
            .is_some_and(|generation| generation != operation.execution_generation)
        || checkpoint
            .sidecar_generation
            .is_some_and(|generation| generation == 0)
        || checkpoint.sidecar_generation.is_some()
            && operation.execution_sidecar_generation.is_some()
            && checkpoint.sidecar_generation != operation.execution_sidecar_generation
        || checkpoint.active_retry_unit.is_some() != checkpoint.active_unit_id.is_some()
        || checkpoint
            .active_retry_unit
            .as_deref()
            .is_some_and(|unit| unit == "operation" || !RETRY_UNITS.contains(&unit))
        || checkpoint.active_unit_id.as_deref().is_some_and(|unit_id| {
            validate_identity(unit_id, "geo_operation_checkpoint_invalid").is_err()
        })
        || checkpoint.completed_step_ids.len() > operation.steps.len()
        || checkpoint
            .active_step_id
            .as_deref()
            .is_some_and(|id| !operation.steps.iter().any(|step| step.id == id))
        || checkpoint.completed_step_ids.iter().any(|id| {
            !operation.steps.iter().any(|step| {
                step.id == *id && matches!(step.status.as_str(), "succeeded" | "skipped")
            })
        })
    {
        return Err("geo_operation_checkpoint_invalid".to_string());
    }
    let mut seen = HashSet::new();
    if checkpoint
        .completed_step_ids
        .iter()
        .any(|id| !seen.insert(id.as_str()))
    {
        return Err("geo_operation_checkpoint_invalid".to_string());
    }
    validate_refs(&checkpoint.completed_unit_refs)
        .map_err(|_| "geo_operation_checkpoint_invalid".to_string())
}

fn validate_error(error: &GeoOperationError) -> Result<(), String> {
    validate_identity(&error.code, "geo_operation_error_invalid")?;
    if error.message.trim().is_empty()
        || error.message.chars().count() > 1_000
        || error
            .unit_id
            .as_deref()
            .is_some_and(|value| validate_identity(value, "invalid").is_err())
    {
        return Err("geo_operation_error_invalid".to_string());
    }
    Ok(())
}

fn validate_external_gate_request(
    session_id: &str,
    request: &GeoOperationExternalGateInput,
) -> Result<(), String> {
    validate_session_id(session_id)?;
    validate_identity(&request.operation_id, "geo_operation_id_invalid")?;
    validate_identity(&request.step_id, "geo_operation_step_invalid")?;
    if request.expected_revision < 1 || request.evidence_ref.revision.is_none() {
        return Err("geo_operation_external_gate_evidence_invalid".to_string());
    }
    validate_refs(std::slice::from_ref(&request.evidence_ref))
}

fn validate_external_gate_evidence(
    connection: &rusqlite::Connection,
    session_id: &str,
    authority: &str,
    evidence_ref: &GeoOperationReference,
) -> Result<(), String> {
    let expected_revision = evidence_ref
        .revision
        .ok_or_else(|| "geo_operation_external_gate_evidence_invalid".to_string())?;
    let valid = match authority {
        "publish-scheduler" if evidence_ref.kind == "publish-execution" => connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM geo_publish_executions
                    WHERE id=?1 AND created_by_session_id=?2 AND revision=?3
                      AND confirmed_at IS NOT NULL
                      AND status NOT IN ('awaiting-confirmation','superseded')
                 )",
                params![evidence_ref.id, session_id, expected_revision],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("validate publish gate evidence: {error}"))?,
        "post-publish-monitor" if evidence_ref.kind == "monitor-plan" => connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM geo_post_publish_monitor_plans
                    WHERE id=?1 AND created_by_session_id=?2 AND revision=?3
                      AND status IN ('active','completed')
                 )",
                params![evidence_ref.id, session_id, expected_revision],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("validate monitor gate evidence: {error}"))?,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("geo_operation_external_gate_evidence_invalid".to_string())
    }
}

fn validate_mutation(request: &GeoOperationMutationRequest) -> Result<(), String> {
    validate_session_id(&request.session_id)?;
    validate_identity(&request.operation_id, "geo_operation_id_invalid")?;
    if request.expected_revision < 1 {
        return Err("geo_operation_revision_invalid".to_string());
    }
    if let Some(step_id) = request.step_id.as_deref() {
        validate_identity(step_id, "geo_operation_step_invalid")?;
    }
    if !matches!(
        request.action.as_str(),
        "queue-step"
            | "update-queue"
            | "start-step"
            | "checkpoint"
            | "complete-step"
            | "report-step-progress"
            | "skip-step"
            | "confirm-step"
            | "attest-external-gate"
            | "replace-plan"
            | "pause"
            | "recover"
            | "resume"
            | "retry"
            | "fail-step"
            | "cancel"
    ) {
        return Err("geo_operation_action_invalid".to_string());
    }
    if let Some(checkpoint) = request.checkpoint.as_ref() {
        json_string(checkpoint, "geo_operation_checkpoint_invalid")?;
    }
    if let Some(error) = request.error.as_ref() {
        validate_error(error)?;
    }
    if let Some(steps) = request.replacement_steps.as_ref() {
        validate_steps(steps)?;
    }
    if let Some(progress) = request.step_progress.as_ref() {
        validate_step_progress(progress)?;
    }
    if request
        .expected_execution_generation
        .is_some_and(|generation| generation < 0)
        || request
            .sidecar_generation
            .is_some_and(|generation| generation == 0)
    {
        return Err("geo_operation_execution_generation_invalid".to_string());
    }
    validate_refs(&request.artifact_refs)
}

fn validate_refs(references: &[GeoOperationReference]) -> Result<(), String> {
    if references.len() > 256 {
        return Err("geo_operation_references_invalid".to_string());
    }
    for reference in references {
        if !REFERENCE_KINDS.contains(&reference.kind.as_str()) {
            return Err("geo_operation_reference_invalid".to_string());
        }
        validate_identity(&reference.id, "geo_operation_reference_invalid")?;
        if reference.revision.is_some_and(|revision| revision < 0) {
            return Err("geo_operation_reference_invalid".to_string());
        }
    }
    Ok(())
}

fn validate_identity(value: &str, error: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(error.to_string());
    }
    Ok(())
}

fn json_string<T: Serialize>(value: &T, error: &str) -> Result<String, String> {
    let json = serde_json::to_string(value).map_err(|_| error.to_string())?;
    if json.len() > MAX_JSON_BYTES {
        return Err(error.to_string());
    }
    Ok(json)
}

fn optional_json_string<T: Serialize>(
    value: Option<&T>,
    error: &str,
) -> Result<Option<String>, String> {
    value.map(|value| json_string(value, error)).transpose()
}

fn parse_json<T: for<'de> Deserialize<'de>>(json: &str, error: &str) -> Result<T, String> {
    serde_json::from_str(json).map_err(|_| error.to_string())
}

fn parse_optional_json<T: for<'de> Deserialize<'de>>(
    json: Option<String>,
    error: &str,
) -> Result<Option<T>, String> {
    json.map(|json| parse_json(&json, error)).transpose()
}

/// Settles only the orchestration projection after the Rust UI owner has
/// already confirmed an immutable publish execution or activated a monitor.
/// It cannot create either side effect and is intentionally absent from the
/// Sidecar Management API.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_geo_operation_attest_external_gate_ui(
    workspaceId: String,
    sessionId: String,
    input: GeoOperationExternalGateInput,
) -> Result<GeoOperationProjection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.attest_geo_operation_external_gate(
            &workspaceId,
            &sessionId,
            input,
        )
    })
    .await
    .map_err(|error| format!("GEO operation gate attestation task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand_workspace::{
        ArticleOperationGetRequest, BrandWorkspace, QuestionPoolLatestRequest, SessionCommit,
        SessionTitleSource,
    };
    use tempfile::tempdir;

    fn fixture() -> (BrandWorkspaceStore, BrandWorkspace) {
        let root = tempdir().unwrap().keep();
        let store = BrandWorkspaceStore::at(root.join("Xiaojing"));
        let workspace = store.create_workspace("编排测试品牌", vec![]).unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-operation".into(),
                    title: "编排".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-operation-other".into(),
                    title: "另一个编排 Session".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        (store, workspace)
    }

    fn confirmation(kind: &str, authority: &str) -> GeoOperationConfirmation {
        GeoOperationConfirmation {
            kind: kind.into(),
            authority: authority.into(),
            title: kind.into(),
            summary: format!("confirm {kind}"),
        }
    }

    fn step(
        id: &str,
        capability: &str,
        status: &str,
        gate: Option<GeoOperationConfirmation>,
    ) -> GeoOperationStep {
        GeoOperationStep {
            id: id.into(),
            title: id.into(),
            capability: capability.into(),
            status: status.into(),
            requires_confirmation: gate.is_some(),
            irreversible: false,
            retry_unit: "operation".into(),
            condition: None,
            confirmation: gate,
            progress: None,
        }
    }

    fn mutation(
        workspace: &BrandWorkspace,
        operation: &GeoOperationProjection,
        action: &str,
        step_id: Option<&str>,
    ) -> GeoOperationMutationRequest {
        GeoOperationMutationRequest {
            workspace_id: workspace.id.clone(),
            session_id: "session-operation".into(),
            operation_id: operation.id.clone(),
            expected_revision: operation.revision,
            action: action.into(),
            step_id: step_id.map(str::to_string),
            checkpoint: None,
            error: None,
            artifact_refs: vec![],
            replacement_steps: None,
            replacement_reason: None,
            update_knowledge: None,
            step_progress: None,
            queue_reason: None,
            queue_position: None,
            expected_execution_generation: Some(operation.execution_generation),
            sidecar_generation: operation.execution_sidecar_generation,
        }
    }

    #[test]
    fn one_session_can_create_and_control_multiple_operations_with_revision_cas() {
        let (store, workspace) = fixture();
        let create = |goal: &str| GeoOperationCreateRequest {
            workspace_id: workspace.id.clone(),
            session_id: "session-operation".into(),
            kind: "article-generation".into(),
            goal: goal.into(),
            status: "ready".into(),
            steps: vec![
                step("generate", "content-production", "ready", None),
                step(
                    "review",
                    "content-production",
                    "pending",
                    Some(confirmation("article-approval", "brand-workspace")),
                ),
            ],
            input_refs: vec![],
            pending_confirmation: None,
            source_operation_id: None,
            update_knowledge: None,
        };
        let first = store.create_geo_operation(create("生成三篇文章")).unwrap();
        let second = store
            .create_geo_operation(create("生成一篇品牌文章"))
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(
            store
                .list_geo_operations(
                    &workspace.id,
                    "session-operation",
                    GeoOperationListRequest {
                        include_all_sessions: false,
                        limit: None
                    },
                )
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .list_geo_operations(
                    &workspace.id,
                    "session-operation",
                    GeoOperationListRequest {
                        include_all_sessions: true,
                        limit: None,
                    },
                )
                .unwrap_err(),
            "geo_operation_session_scope_required"
        );
        let mut cross_session_source = create("不能复用另一个 Session 的执行上下文");
        cross_session_source.session_id = "session-operation-other".into();
        cross_session_source.source_operation_id = Some(first.id.clone());
        assert_eq!(
            store
                .create_geo_operation(cross_session_source)
                .unwrap_err(),
            "geo_operation_source_not_found"
        );

        let running = store
            .mutate_geo_operation(mutation(&workspace, &first, "start-step", Some("generate")))
            .unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.execution_generation, 1);
        assert!(store
            .mutate_geo_operation(mutation(&workspace, &first, "pause", None))
            .unwrap_err()
            .contains("revision_conflict"));
    }

    #[test]
    fn cross_session_unfinished_metadata_is_read_only_brand_scoped_and_body_free() {
        let (store, workspace) = fixture();
        let other_workspace = store.create_workspace("另一个品牌", vec![]).unwrap();

        // session-operation 的一轮完整优化：文章生成完成后停在文章批准门。
        let article_confirmation = confirmation("article-approval", "brand-workspace");
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "full-optimization".into(),
                goal: "一轮完整 GEO 优化".into(),
                status: "ready".into(),
                steps: vec![
                    step("generate-articles", "content-production", "ready", None),
                    step(
                        "confirm-articles",
                        "content-production",
                        "pending",
                        Some(article_confirmation),
                    ),
                ],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let running = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("generate-articles"),
            ))
            .unwrap();
        let waiting = store
            .mutate_geo_operation(mutation(
                &workspace,
                &running,
                "complete-step",
                Some("generate-articles"),
            ))
            .unwrap();
        assert_eq!(waiting.status, "awaiting-confirmation");

        // session-operation-other 的终态操作：不得进入未完成列表。
        let finished = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation-other".into(),
                kind: "knowledge-update".into(),
                goal: "更新知识".into(),
                status: "ready".into(),
                steps: vec![step(
                    "collect-materials",
                    "brand-material-import",
                    "ready",
                    None,
                )],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let mut finished = store
            .get_geo_operation(&workspace.id, &finished.id)
            .unwrap();
        for action in ["start-step", "complete-step"] {
            let mut request = mutation(&workspace, &finished, action, Some("collect-materials"));
            request.session_id = "session-operation-other".into();
            finished = store.mutate_geo_operation(request).unwrap();
        }
        assert_eq!(finished.status, "succeeded");

        // session-operation 名下的文章工作：5 篇 draft_ready，其中 2 篇已批准，
        // 待审 3 篇。标题只写敏感标记，证明元信息列表不携带标题/正文。
        let connection = open_database(&workspace).unwrap();
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_article_operations(
                    operation_id,created_by_session_id,source_kind,topic_plan_id,
                    topic_plan_revision,knowledge_version,product_line,target_region,
                    policy_version,operation_spec_json,status,created_at,updated_at)
                 VALUES ('article-op-cross-session','session-operation','direct',NULL,
                    NULL,1,'汽车音响改装','成都','test','{}','completed',
                    '2026-08-30T09:00:00Z','2026-08-31T18:00:00Z')",
                [],
            )
            .unwrap();
        for index in 0..5 {
            let approved = index < 2;
            connection
                .execute(
                    "INSERT INTO geo_articles(
                        id,operation_id,source_plan_item_id,knowledge_version,
                        content_type,topic,requested_title,constraints,
                        planned_facts_json,status,revision,approved_revision,
                        generation_attempt,created_at,updated_at)
                     VALUES (?1,'article-op-cross-session',NULL,1,'guide',
                        'SECRET-DRAFT-主题','SECRET-DRAFT-标题-不得跨会话可见','要求','{}',
                        ?2,1,?3,0,'2026-08-30T09:00:00Z','2026-08-31T18:00:00Z')",
                    params![
                        format!("article-{index}"),
                        if approved { "approved" } else { "draft_ready" },
                        if approved { Some(1) } else { None },
                    ],
                )
                .unwrap();
        }
        drop(connection);

        let before = store.get_geo_operation(&workspace.id, &waiting.id).unwrap();
        let list = store.list_unfinished_geo_operations(&workspace.id).unwrap();
        let summaries = &list.operations;
        let after = store.get_geo_operation(&workspace.id, &waiting.id).unwrap();

        // 只读 tracer：列表调用不推进任何 revision，也不改状态。
        assert_eq!(before, after);
        // 上界语义：条目数与总数一致（未超过 LIMIT 时全量返回）。
        assert_eq!(summaries.len(), 1);
        assert_eq!(list.total, 1);
        let summary = &summaries[0];
        assert_eq!(summary.id, waiting.id);
        assert_eq!(summary.session_id, Some("session-operation".to_string()));
        assert_eq!(summary.kind, "full-optimization");
        assert_eq!(summary.goal, "一轮完整 GEO 优化");
        assert_eq!(summary.status, "awaiting-confirmation");
        let stuck = summary.stuck_step.as_ref().unwrap();
        assert_eq!(stuck.id, "confirm-articles");
        assert_eq!(stuck.capability, "content-production");
        assert_eq!(stuck.status, "awaiting-confirmation");
        assert_eq!(
            summary.pending_confirmation.as_ref().unwrap().kind,
            "article-approval"
        );
        assert_eq!(summary.pending_review_count, 3);
        assert!(!summary.created_at.is_empty());
        assert!(!summary.updated_at.is_empty());

        // 不含正文与聊天记录：序列化投影不含草稿标题标记，也没有任何
        // 正文字段或转录字段。
        let json = serde_json::to_string(&summaries).unwrap();
        assert!(!json.contains("SECRET-DRAFT"));
        assert!(!json.to_lowercase().contains("body"));
        assert!(!json.to_lowercase().contains("transcript"));

        // 按品牌：另一个品牌看不到本品牌的未完成轮次。
        assert!(store
            .list_unfinished_geo_operations(&other_workspace.id)
            .unwrap()
            .operations
            .is_empty());
    }

    #[test]
    fn unfinished_list_caps_entries_and_reports_the_full_total() {
        let (store, workspace) = fixture();
        let count = UNFINISHED_GEO_OPERATION_SUMMARY_LIMIT + 2;
        for index in 0..count {
            store
                .create_geo_operation(GeoOperationCreateRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-operation".into(),
                    kind: "question-opportunities".into(),
                    goal: format!("第 {index} 轮"),
                    status: "ready".into(),
                    steps: vec![step(
                        "collect-questions",
                        "question-opportunities",
                        "ready",
                        None,
                    )],
                    input_refs: vec![],
                    pending_confirmation: None,
                    source_operation_id: None,
                    update_knowledge: None,
                })
                .unwrap();
        }

        let list = store.list_unfinished_geo_operations(&workspace.id).unwrap();

        // 上界：条目截到 LIMIT，total 报全量，摘要侧换算 truncatedCount。
        assert_eq!(
            list.operations.len(),
            UNFINISHED_GEO_OPERATION_SUMMARY_LIMIT
        );
        assert_eq!(list.total, count);
    }

    /// 票 #04（spec 2026-09-02）：「是否更新知识」进操作投影与跨会话摘要，
    /// 创建与计划替换两条路径往返一致；起点推导读轮次不再靠意图标签推断。
    #[test]
    fn update_knowledge_decision_round_trips_create_replace_plan_and_summary() {
        let (store, workspace) = fixture();
        let branch_gate = confirmation("next-round-knowledge", "brand-workspace");
        let selection_gate = confirmation("question-selection", "brand-workspace");

        // 创建路径：显式「不更新知识」的复用轮（全链意图带该组合，fa450460
        // 实测场景）——决策随创建落库并原样读回。
        let reuse_round = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "full-optimization".into(),
                goal: "不更新知识的复用轮".into(),
                status: "ready".into(),
                steps: vec![step(
                    "select-next-question-pool",
                    "question-opportunities",
                    "ready",
                    None,
                )],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: Some(false),
            })
            .unwrap();
        assert_eq!(reuse_round.update_knowledge, Some(false));

        // 未决停卡：创建时不带决策 → 投影 None（未决，不是 false）。
        let undecided = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "next-round-optimization".into(),
                goal: "下一轮优化".into(),
                status: "awaiting-confirmation".into(),
                steps: vec![step(
                    "decide-knowledge-refresh",
                    "brand-knowledge",
                    "awaiting-confirmation",
                    Some(branch_gate),
                )],
                input_refs: vec![],
                pending_confirmation: Some(confirmation("next-round-knowledge", "brand-workspace")),
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        assert_eq!(undecided.update_knowledge, None);

        // 计划替换路径：分支答案 false 随 replace-plan 一次落库；revision
        // 语义不变——决策持久化不额外递增，仍是一次 mutation 恰好 +1。
        let mut replace = mutation(&workspace, &undecided, "replace-plan", None);
        replace.replacement_steps = Some(vec![step(
            "select-next-question-pool",
            "question-opportunities",
            "pending",
            Some(selection_gate),
        )]);
        replace.update_knowledge = Some(false);
        let decided = store.mutate_geo_operation(replace).unwrap();
        assert_eq!(decided.update_knowledge, Some(false));
        assert_eq!(decided.revision, undecided.revision + 1);
        assert_eq!(decided.steps.len(), 1);
        assert_eq!(
            decided.steps[0].status, "awaiting-confirmation",
            "replacement first step re-parks at its gate"
        );
        // 投影序列化用 TS 契约的 camelCase 键（票 #04）。
        assert!(serde_json::to_string(&decided)
            .unwrap()
            .contains(r#""updateKnowledge":false"#));

        // 跨会话摘要：未完成轮次条目携带决策；未决轮如实报 None。
        let summaries = store.list_unfinished_geo_operations(&workspace.id).unwrap();
        let decision_by_id: HashMap<String, Option<bool>> = summaries
            .operations
            .iter()
            .map(|summary| (summary.id.clone(), summary.update_knowledge))
            .collect();
        assert_eq!(
            decision_by_id.get(&reuse_round.id),
            Some(&Some(false)),
            "reuse round shows updateKnowledge=false in the summary"
        );
        assert_eq!(
            decision_by_id.get(&decided.id),
            Some(&Some(false)),
            "plan-replacement decision reaches the summary"
        );

        // 替换时不带决策：保持现值（跳过出口等后续 replace-plan 调用方
        // 不写该字段，不得把已有决策清掉）。
        let preset = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "next-round-optimization".into(),
                goal: "预置决策的停卡".into(),
                status: "awaiting-confirmation".into(),
                steps: vec![step(
                    "decide-knowledge-refresh",
                    "brand-knowledge",
                    "awaiting-confirmation",
                    Some(confirmation("next-round-knowledge", "brand-workspace")),
                )],
                input_refs: vec![],
                pending_confirmation: Some(confirmation("next-round-knowledge", "brand-workspace")),
                source_operation_id: None,
                update_knowledge: Some(true),
            })
            .unwrap();
        let mut keep = mutation(&workspace, &preset, "replace-plan", None);
        keep.replacement_steps = Some(vec![step(
            "collect-materials",
            "brand-material-import",
            "pending",
            None,
        )]);
        let kept = store.mutate_geo_operation(keep).unwrap();
        assert_eq!(
            kept.update_knowledge,
            Some(true),
            "replace-plan without the field keeps the stored decision"
        );

        // 存量旧轮（列存在之前落库）：NULL 读回 None，摘要不臆断。
        let connection = open_database(&workspace).unwrap();
        connection
            .execute(
                "INSERT INTO geo_operations(id,session_id,state,created_at,kind,goal,
                    status,steps_json,revision,execution_generation,updated_at)
                 VALUES ('legacy-round-04','session-operation','paused',
                    '2026-08-01T00:00:00Z','full-optimization','存量旧轮','paused','[]',3,0,
                    '2026-08-01T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);
        assert_eq!(
            store
                .get_geo_operation(&workspace.id, "legacy-round-04")
                .unwrap()
                .update_knowledge,
            None
        );
        let summaries = store.list_unfinished_geo_operations(&workspace.id).unwrap();
        assert_eq!(
            summaries
                .operations
                .iter()
                .find(|summary| summary.id == "legacy-round-04")
                .unwrap()
                .update_knowledge,
            None
        );
    }

    /// 全链工作步骤（票 07 测试夹具）：知识段三步 + 问题段两步，全部
    /// pending；由 released_operation 补上前置认可门。
    fn full_chain_work_steps() -> Vec<GeoOperationStep> {
        vec![
            step(
                "collect-materials",
                "brand-material-import",
                "pending",
                None,
            ),
            step("extract-facts", "brand-knowledge", "pending", None),
            step(
                "confirm-knowledge",
                "brand-knowledge",
                "pending",
                Some(confirmation("knowledge-change", "knowledge-authority")),
            ),
            step(
                "generate-question-pool",
                "question-opportunities",
                "pending",
                None,
            ),
            step(
                "confirm-question-selection",
                "question-opportunities",
                "pending",
                Some(confirmation("question-selection", "brand-workspace")),
            ),
        ]
    }

    /// 建一个「认可门已放行」的操作：创建时整单停在 plan-ack（与 TS policy
    /// 同形态），随后 confirm-step 放行，得到停在首个工作步骤的真实形态。
    fn released_operation(
        store: &BrandWorkspaceStore,
        workspace: &BrandWorkspace,
        kind: &str,
        goal: &str,
        work_steps: Vec<GeoOperationStep>,
    ) -> GeoOperationProjection {
        let ack_gate = confirmation("plan-ack", "geo-operation");
        let opening_capability = work_steps
            .first()
            .map(|step| step.capability.clone())
            .unwrap_or_else(|| "brand-knowledge".into());
        let mut steps = vec![step(
            "acknowledge-plan",
            &opening_capability,
            "awaiting-confirmation",
            Some(ack_gate.clone()),
        )];
        steps.extend(work_steps);
        let created = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: kind.into(),
                goal: goal.into(),
                status: "awaiting-confirmation".into(),
                steps,
                input_refs: vec![],
                pending_confirmation: Some(ack_gate),
                source_operation_id: None,
                update_knowledge: Some(true),
            })
            .unwrap();
        store
            .mutate_geo_operation(mutation(
                workspace,
                &created,
                "confirm-step",
                Some("acknowledge-plan"),
            ))
            .unwrap()
    }

    /// begin+complete 一个工作步骤（里程碑收尾的同款状态机路径）。
    fn run_work_step(
        store: &BrandWorkspaceStore,
        workspace: &BrandWorkspace,
        operation: &GeoOperationProjection,
        step_id: &str,
    ) -> GeoOperationProjection {
        let started = store
            .mutate_geo_operation(mutation(workspace, operation, "start-step", Some(step_id)))
            .unwrap();
        store
            .mutate_geo_operation(mutation(
                workspace,
                &started,
                "complete-step",
                Some(step_id),
            ))
            .unwrap()
    }

    /// 票 07（spec 2026-09-02 决策 5）：材料收集跳过出口走 replace-plan
    /// 剥离知识段剩余步骤——已完成/已确认步骤保留，替换后从首个未走完
    /// 步骤续接，不重停计划认可门；决策随替换落库，一次 mutation 一次
    /// revision 递增。
    #[test]
    fn replace_plan_material_skip_strips_remaining_knowledge_steps_and_continues() {
        let (store, workspace) = fixture();
        let parked = released_operation(
            &store,
            &workspace,
            "full-optimization",
            "一轮完整的 GEO 优化",
            full_chain_work_steps(),
        );
        assert_eq!(parked.status, "ready");
        assert_eq!(
            parked
                .steps
                .iter()
                .find(|step| step.id == "collect-materials")
                .unwrap()
                .status,
            "ready"
        );

        let mut skip = mutation(&workspace, &parked, "replace-plan", None);
        skip.replacement_reason = Some("material-collection-skip".into());
        skip.replacement_steps = Some(strip_incomplete_knowledge_steps(&parked.steps));
        skip.update_knowledge = Some(false);
        let skipped = store.mutate_geo_operation(skip).unwrap();

        // 认可门的成功状态保留，知识段三步剥离，当前步推进到问题池生成。
        let ids: Vec<&str> = skipped.steps.iter().map(|step| step.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "acknowledge-plan",
                "generate-question-pool",
                "confirm-question-selection"
            ]
        );
        assert_eq!(skipped.steps[0].status, "succeeded");
        assert_eq!(skipped.steps[1].status, "ready");
        assert_eq!(skipped.status, "ready");
        assert!(skipped.pending_confirmation.is_none());
        // 跳过即本轮不更新知识：决策随替换落库，revision 恰好 +1。
        assert_eq!(skipped.update_knowledge, Some(false));
        assert_eq!(skipped.revision, parked.revision + 1);
        // 跨会话摘要跟随：未完成轮次报 updateKnowledge=false。
        let summaries = store.list_unfinished_geo_operations(&workspace.id).unwrap();
        assert_eq!(
            summaries
                .operations
                .iter()
                .find(|summary| summary.id == skipped.id)
                .unwrap()
                .update_knowledge,
            Some(false)
        );
    }

    /// 停在知识确认门的跳过：已完成的材料收集/事实提取保留，未裁决的
    /// 知识门剥离，pending_confirmation 清空、状态回到 ready 续接。
    #[test]
    fn replace_plan_material_skip_keeps_succeeded_knowledge_steps() {
        let (store, workspace) = fixture();
        let parked = released_operation(
            &store,
            &workspace,
            "full-optimization",
            "更新知识的轮次",
            full_chain_work_steps(),
        );
        // 材料已导入：collect-materials 与 extract-facts 完成，知识门停靠。
        let imported = run_work_step(&store, &workspace, &parked, "collect-materials");
        let parked_at_gate = run_work_step(&store, &workspace, &imported, "extract-facts");
        assert_eq!(parked_at_gate.status, "awaiting-confirmation");

        let mut skip = mutation(&workspace, &parked_at_gate, "replace-plan", None);
        skip.replacement_reason = Some("material-collection-skip".into());
        skip.replacement_steps = Some(strip_incomplete_knowledge_steps(&parked_at_gate.steps));
        skip.update_knowledge = Some(false);
        let skipped = store.mutate_geo_operation(skip).unwrap();

        let ids: Vec<&str> = skipped.steps.iter().map(|step| step.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "acknowledge-plan",
                "collect-materials",
                "extract-facts",
                "generate-question-pool",
                "confirm-question-selection"
            ]
        );
        // 已完成步骤的状态原样保留；替换后从问题池生成续接。
        assert_eq!(skipped.steps[1].status, "succeeded");
        assert_eq!(skipped.steps[2].status, "succeeded");
        assert_eq!(skipped.steps[3].status, "ready");
        assert_eq!(skipped.status, "ready");
        assert!(skipped.pending_confirmation.is_none());
    }

    /// 知识更新单意图跳空：知识段全部剥离后无剩余工作，操作收口为
    /// succeeded——跳过出口不制造「没有步骤却非终态」的残局。
    #[test]
    fn replace_plan_material_skip_closes_a_knowledge_only_round() {
        let (store, workspace) = fixture();
        let parked = released_operation(
            &store,
            &workspace,
            "knowledge-update",
            "更新品牌知识",
            vec![step(
                "collect-materials",
                "brand-material-import",
                "pending",
                None,
            )],
        );

        let mut skip = mutation(&workspace, &parked, "replace-plan", None);
        skip.replacement_reason = Some("material-collection-skip".into());
        skip.replacement_steps = Some(strip_incomplete_knowledge_steps(&parked.steps));
        skip.update_knowledge = Some(false);
        let skipped = store.mutate_geo_operation(skip).unwrap();

        assert_eq!(skipped.status, "succeeded");
        assert_eq!(skipped.steps.len(), 1);
        assert!(skipped.terminal_at.is_some());
    }

    /// 跳过出口的形状守卫：非「剥掉未走完知识段步骤」的替换一律拒绝，
    /// 不得把 replace-plan 放宽成自由计划编辑。
    #[test]
    fn replace_plan_material_skip_rejects_tampered_or_noop_replacements() {
        let (store, workspace) = fixture();
        let parked = released_operation(
            &store,
            &workspace,
            "full-optimization",
            "一轮完整的 GEO 优化",
            full_chain_work_steps(),
        );

        // 夹带私改：替换步骤里混入原计划没有的步骤。
        let mut tampered = mutation(&workspace, &parked, "replace-plan", None);
        tampered.replacement_reason = Some("material-collection-skip".into());
        tampered.replacement_steps = Some(vec![
            step(
                "acknowledge-plan",
                "brand-knowledge",
                "succeeded",
                Some(confirmation("plan-ack", "geo-operation")),
            ),
            step("rogue-step", "brand-knowledge", "ready", None),
        ]);
        assert!(store
            .mutate_geo_operation(tampered)
            .unwrap_err()
            .contains("geo_operation_plan_replacement_invalid"));

        // 无可剥离：当前步已越过知识段，替换前后同长。
        let imported = run_work_step(&store, &workspace, &parked, "collect-materials");
        let extracted = run_work_step(&store, &workspace, &imported, "extract-facts");
        let past = store
            .mutate_geo_operation(mutation(
                &workspace,
                &extracted,
                "confirm-step",
                Some("confirm-knowledge"),
            ))
            .unwrap();
        assert_eq!(past.status, "ready");
        let mut noop = mutation(&workspace, &past, "replace-plan", None);
        noop.replacement_reason = Some("material-collection-skip".into());
        noop.replacement_steps = Some(strip_incomplete_knowledge_steps(&past.steps));
        assert!(store
            .mutate_geo_operation(noop)
            .unwrap_err()
            .contains("geo_operation_plan_replacement_invalid"));

        // paused 轮次不允许原地跳过：先 resume 再跳，控制面纪律不被绕过。
        // 取最新 revision（前段越序路径已推进过这单操作）。
        let latest = store.get_geo_operation(&workspace.id, &parked.id).unwrap();
        let paused_projection = store
            .mutate_geo_operation(mutation(&workspace, &latest, "pause", None))
            .unwrap();
        let mut paused_skip = mutation(&workspace, &paused_projection, "replace-plan", None);
        paused_skip.replacement_reason = Some("material-collection-skip".into());
        paused_skip.replacement_steps =
            Some(strip_incomplete_knowledge_steps(&paused_projection.steps));
        assert!(store
            .mutate_geo_operation(paused_skip)
            .unwrap_err()
            .contains("geo_operation_transition_invalid"));

        // 分支决策停卡（decide-knowledge-refresh 单步）不得借用跳过场景
        // 绕过停卡守卫：跳过场景要求真的剥离知识段步骤。
        let branch_gate = confirmation("next-round-knowledge", "brand-workspace");
        let undecided = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "next-round-optimization".into(),
                goal: "下一轮优化".into(),
                status: "awaiting-confirmation".into(),
                steps: vec![step(
                    "decide-knowledge-refresh",
                    "brand-knowledge",
                    "awaiting-confirmation",
                    Some(branch_gate.clone()),
                )],
                input_refs: vec![],
                pending_confirmation: Some(branch_gate),
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let mut borrowed = mutation(&workspace, &undecided, "replace-plan", None);
        borrowed.replacement_reason = Some("material-collection-skip".into());
        borrowed.replacement_steps = Some(strip_incomplete_knowledge_steps(&undecided.steps));
        assert!(store
            .mutate_geo_operation(borrowed)
            .unwrap_err()
            .contains("geo_operation_plan_replacement_invalid"));

        // 原计划原样：全部被拒的跳过尝试都没有副作用（唯一的 revision
        // 变化来自上面合法的 pause 本身）。
        let after = store
            .get_geo_operation(&workspace.id, &paused_projection.id)
            .unwrap();
        assert_eq!(after.steps.len(), paused_projection.steps.len());
        assert_eq!(after.revision, paused_projection.revision);
        assert_eq!(after.status, "paused");
    }

    #[test]
    fn report_step_progress_updates_running_step_and_rejects_bad_input() {
        let (store, workspace) = fixture();
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "article-generation".into(),
                goal: "生成三篇文章".into(),
                status: "ready".into(),
                steps: vec![
                    step("generate", "content-production", "ready", None),
                    step(
                        "review",
                        "content-production",
                        "pending",
                        Some(confirmation("article-approval", "brand-workspace")),
                    ),
                ],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let running = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("generate"),
            ))
            .unwrap();
        assert_eq!(running.status, "running");

        let mut out_of_range = mutation(
            &workspace,
            &running,
            "report-step-progress",
            Some("generate"),
        );
        out_of_range.step_progress = Some(GeoOperationStepProgress {
            current: 6,
            total: 5,
        });
        assert_eq!(
            store.mutate_geo_operation(out_of_range).unwrap_err(),
            "geo_operation_step_progress_invalid"
        );

        let mut report = mutation(
            &workspace,
            &running,
            "report-step-progress",
            Some("generate"),
        );
        report.step_progress = Some(GeoOperationStepProgress {
            current: 2,
            total: 5,
        });
        let updated = store.mutate_geo_operation(report).unwrap();
        assert_eq!(
            updated.steps[0].progress,
            Some(GeoOperationStepProgress {
                current: 2,
                total: 5
            })
        );
        assert_eq!(updated.status, "running");

        // 确认门不处于 running，进度上报必须被状态机拒绝。
        let mut wrong_step = mutation(&workspace, &updated, "report-step-progress", Some("review"));
        wrong_step.step_progress = Some(GeoOperationStepProgress {
            current: 1,
            total: 5,
        });
        assert_eq!(
            store.mutate_geo_operation(wrong_step).unwrap_err(),
            "geo_operation_step_not_progressable"
        );
    }

    #[test]
    fn typescript_wire_contract_deserializes_typed_steps_refs_and_checkpoint() {
        let request: GeoOperationCreateRequest = serde_json::from_value(serde_json::json!({
            "workspaceId": "brand-16",
            "sessionId": "session-operation",
            "kind": "performance-inspection",
            "goal": "检查当前 GEO 表现",
            "status": "ready",
            "steps": [{
                "id": "load-real-evidence",
                "title": "读取现有真实证据",
                "capability": "geo-dashboard",
                "status": "ready",
                "requiresConfirmation": false,
                "irreversible": false,
                "retryUnit": "operation",
                "condition": null,
                "confirmation": null
            }],
            "inputRefs": [{ "kind": "report", "id": "report-15", "revision": 2 }],
            "pendingConfirmation": null,
            "sourceOperationId": "source-operation-15",
            "updateKnowledge": false
        }))
        .unwrap();
        validate_create(&request).unwrap();
        assert_eq!(request.steps[0].capability, "geo-dashboard");
        assert_eq!(request.input_refs[0].kind, "report");
        // 票 #04：请求白名单接受 camelCase 的 updateKnowledge（缺省 None）。
        assert_eq!(request.update_knowledge, Some(false));

        let checkpoint: GeoOperationCheckpoint = serde_json::from_value(serde_json::json!({
            "activeStepId": "load-real-evidence",
            "completedStepIds": [],
            "completedUnitRefs": [{ "kind": "report", "id": "report-15", "revision": 2 }],
            "safeToResume": true,
            "savedAt": "2026-08-15T00:00:00Z"
        }))
        .unwrap();
        assert!(checkpoint.safe_to_resume);
        assert_eq!(checkpoint.completed_unit_refs[0].id, "report-15");
    }

    #[test]
    fn paid_publish_and_monitor_gates_cannot_be_attested_by_the_sidecar() {
        let (store, workspace) = fixture();
        for (kind, authority, operation_kind, capability, step_id, irreversible) in [
            (
                "paid-publish",
                "publish-scheduler",
                "publishing",
                "publishing",
                "confirm-publish",
                true,
            ),
            (
                "monitoring-activation",
                "post-publish-monitor",
                "monitoring",
                "monitoring",
                "confirm-monitoring",
                false,
            ),
        ] {
            let pending = confirmation(kind, authority);
            let mut gated_step = step(
                step_id,
                capability,
                "awaiting-confirmation",
                Some(pending.clone()),
            );
            gated_step.irreversible = irreversible;
            let operation = store
                .create_geo_operation(GeoOperationCreateRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-operation".into(),
                    kind: operation_kind.into(),
                    goal: step_id.into(),
                    status: "awaiting-confirmation".into(),
                    steps: vec![gated_step],
                    input_refs: vec![],
                    pending_confirmation: Some(pending),
                    source_operation_id: None,
                    update_knowledge: None,
                })
                .unwrap();
            assert_eq!(
                store
                    .mutate_geo_operation(mutation(
                        &workspace,
                        &operation,
                        "confirm-step",
                        Some(step_id),
                    ))
                    .unwrap_err(),
                "geo_operation_confirmation_requires_rust_ui_authority"
            );
        }
    }

    #[test]
    fn rust_ui_gate_attestation_requires_an_exact_confirmed_owner_revision() {
        let (store, workspace) = fixture();
        let pending = confirmation("paid-publish", "publish-scheduler");
        let mut gated_step = step(
            "confirm-publish",
            "publishing",
            "awaiting-confirmation",
            Some(pending.clone()),
        );
        gated_step.irreversible = true;
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "publishing".into(),
                goal: "确认发布".into(),
                status: "awaiting-confirmation".into(),
                steps: vec![gated_step],
                input_refs: vec![],
                pending_confirmation: Some(pending),
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();

        let connection = open_database(&workspace).unwrap();
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_publish_executions(
                    id,operation_id,created_by_session_id,distribution_plan_id,
                    distribution_plan_revision,status,revision,budget_cny,
                    estimated_spend_cny,publish_start_at,confirmation_digest,
                    provider_snapshot_json,confirmed_at,execution_started_at,
                    finished_at,created_at,updated_at)
                 VALUES ('publish-evidence-16','lineage-publish-operation',
                    'session-operation','distribution-plan-16',1,'confirmed',7,
                    100,80,'2026-08-15T00:00:00Z','digest','{}',
                    '2026-08-15T00:00:00Z',NULL,NULL,
                    '2026-08-15T00:00:00Z','2026-08-15T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let input = |revision| GeoOperationExternalGateInput {
            operation_id: operation.id.clone(),
            expected_revision: operation.revision,
            step_id: "confirm-publish".into(),
            evidence_ref: GeoOperationReference {
                kind: "publish-execution".into(),
                id: "publish-evidence-16".into(),
                revision: Some(revision),
            },
        };
        assert_eq!(
            store
                .attest_geo_operation_external_gate(&workspace.id, "session-operation", input(6),)
                .unwrap_err(),
            "geo_operation_external_gate_evidence_invalid"
        );

        let completed = store
            .attest_geo_operation_external_gate(&workspace.id, "session-operation", input(7))
            .unwrap();
        assert_eq!(completed.status, "succeeded");
        assert_eq!(completed.steps[0].status, "succeeded");
        assert_eq!(completed.artifact_refs[0].id, "publish-evidence-16");
    }

    #[test]
    fn completion_advances_to_confirmation_and_finishes_only_after_a_real_decision() {
        let (store, workspace) = fixture();
        let article_confirmation = confirmation("article-approval", "brand-workspace");
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "article-generation".into(),
                goal: "生成文章".into(),
                status: "ready".into(),
                steps: vec![
                    step("generate", "content-production", "ready", None),
                    step(
                        "approve",
                        "content-production",
                        "pending",
                        Some(article_confirmation),
                    ),
                ],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let running = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("generate"),
            ))
            .unwrap();
        let mut complete = mutation(&workspace, &running, "complete-step", Some("generate"));
        complete.artifact_refs = vec![GeoOperationReference {
            kind: "article-operation".into(),
            id: "article-operation-16".into(),
            revision: Some(1),
        }];
        let waiting = store.mutate_geo_operation(complete).unwrap();
        assert_eq!(waiting.status, "awaiting-confirmation");
        assert_eq!(waiting.steps[1].status, "awaiting-confirmation");
        assert_eq!(waiting.artifact_refs.len(), 1);

        let completed = store
            .mutate_geo_operation(mutation(
                &workspace,
                &waiting,
                "confirm-step",
                Some("approve"),
            ))
            .unwrap();
        assert_eq!(completed.status, "succeeded");
        assert!(completed.terminal_at.is_some());
    }

    #[test]
    fn running_pause_requires_a_safe_checkpoint_and_retry_requires_a_retryable_error() {
        let (store, workspace) = fixture();
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "performance-inspection".into(),
                goal: "检查表现".into(),
                status: "ready".into(),
                steps: vec![step("inspect", "geo-dashboard", "ready", None)],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let running = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("inspect"),
            ))
            .unwrap();
        assert_eq!(
            store
                .mutate_geo_operation(mutation(&workspace, &running, "pause", None))
                .unwrap_err(),
            "geo_operation_safe_checkpoint_required"
        );

        let mut checkpoint_request = mutation(&workspace, &running, "checkpoint", None);
        checkpoint_request.checkpoint = Some(GeoOperationCheckpoint {
            active_step_id: Some("inspect".into()),
            completed_step_ids: vec![],
            completed_unit_refs: vec![],
            safe_to_resume: true,
            saved_at: Utc::now().to_rfc3339(),
            execution_generation: Some(running.execution_generation),
            sidecar_generation: running.execution_sidecar_generation,
            active_retry_unit: None,
            active_unit_id: None,
        });
        let checkpointed = store.mutate_geo_operation(checkpoint_request).unwrap();
        let recovering = store
            .mutate_geo_operation(mutation(&workspace, &checkpointed, "recover", None))
            .unwrap();
        let resumed = store
            .mutate_geo_operation(mutation(&workspace, &recovering, "resume", None))
            .unwrap();
        assert_eq!(resumed.status, "ready");
        assert_eq!(resumed.steps[0].status, "ready");

        let paused = store
            .mutate_geo_operation(mutation(&workspace, &resumed, "pause", None))
            .unwrap();
        let resumed = store
            .mutate_geo_operation(mutation(&workspace, &paused, "resume", None))
            .unwrap();

        let mut fail = mutation(&workspace, &resumed, "fail-step", Some("inspect"));
        fail.error = Some(GeoOperationError {
            code: "dashboard-unavailable".into(),
            message: "dashboard unavailable".into(),
            retryable: false,
            unit_id: None,
        });
        let failed = store.mutate_geo_operation(fail).unwrap();
        let not_retryable = store
            .mutate_geo_operation(mutation(&workspace, &failed, "retry", None))
            .unwrap_err();
        assert!(not_retryable.contains("geo_operation_error_not_retryable"));
    }

    #[test]
    fn invalid_control_transitions_report_the_actions_valid_for_the_current_status() {
        let (store, workspace) = fixture();
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "article-generation".into(),
                goal: "错误提示测试".into(),
                status: "ready".into(),
                steps: vec![step("generate", "content-production", "ready", None)],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();

        // ready 状态下 resume/retry 都非法：错误必须指出当前状态与合法动作。
        let resume_error = store
            .mutate_geo_operation(mutation(&workspace, &operation, "resume", None))
            .unwrap_err();
        assert_eq!(
            resume_error,
            "geo_operation_transition_invalid:ready (valid control actions: pause, cancel)"
        );
        let retry_error = store
            .mutate_geo_operation(mutation(&workspace, &operation, "retry", None))
            .unwrap_err();
        assert_eq!(
            retry_error,
            "geo_operation_transition_invalid:ready (valid control actions: pause, cancel)"
        );

        // 合法动作仍按原语义执行，revision CAS 正常推进。
        let paused = store
            .mutate_geo_operation(mutation(&workspace, &operation, "pause", None))
            .unwrap();
        let resumed = store
            .mutate_geo_operation(mutation(&workspace, &paused, "resume", None))
            .unwrap();
        assert_eq!(resumed.status, "ready");

        let cancelled = store
            .mutate_geo_operation(mutation(&workspace, &resumed, "cancel", None))
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        let cancel_again = store
            .mutate_geo_operation(mutation(&workspace, &cancelled, "cancel", None))
            .unwrap_err();
        assert!(cancel_again.contains("geo_operation_already_terminal:cancelled"));
        assert!(cancel_again.contains("start a new operation"));
    }

    #[test]
    fn queue_projection_is_visible_and_admission_binds_the_rust_sidecar_generation() {
        let (store, workspace) = fixture();
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "article-generation".into(),
                goal: "排队生成文章".into(),
                status: "ready".into(),
                steps: vec![step("article-18", "content-production", "ready", None)],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let mut queue = mutation(&workspace, &operation, "queue-step", Some("article-18"));
        queue.queue_reason = Some("全局重型 Provider 并发已达上限（5）".into());
        queue.queue_position = Some(3);
        queue.sidecar_generation = Some(41);
        let queued = store.mutate_geo_operation(queue).unwrap();
        assert_eq!(queued.status, "queued");
        assert_eq!(queued.queue_position, Some(3));
        assert_eq!(queued.execution_sidecar_generation, Some(41));

        let mut start = mutation(&workspace, &queued, "start-step", Some("article-18"));
        start.sidecar_generation = Some(41);
        let running = store.mutate_geo_operation(start).unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.execution_sidecar_generation, Some(41));
        assert_eq!(running.queue_reason, None);
        assert_eq!(running.queue_position, None);
    }

    #[test]
    fn plan_ack_gate_parks_a_fresh_operation_and_confirm_step_releases_it() {
        let (store, workspace) = fixture();
        let gate = GeoOperationConfirmation {
            kind: "plan-ack".into(),
            authority: "geo-operation".into(),
            title: "认可本轮计划".into(),
            summary: "查看阶段与步骤计划后放行；各阶段产物仍停在各自的确认门。".into(),
        };
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "full-optimization".into(),
                goal: "完整 GEO 优化".into(),
                status: "awaiting-confirmation".into(),
                steps: vec![
                    step(
                        "acknowledge-plan",
                        "brand-material-import",
                        "awaiting-confirmation",
                        Some(gate.clone()),
                    ),
                    step(
                        "collect-materials",
                        "brand-material-import",
                        "pending",
                        None,
                    ),
                ],
                input_refs: vec![],
                pending_confirmation: Some(gate),
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        assert_eq!(operation.status, "awaiting-confirmation");

        // 计划未放行前，任何工作步骤都不能开始。
        let premature = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("collect-materials"),
            ))
            .unwrap_err();
        assert!(premature.contains("geo_operation_transition_invalid:awaiting-confirmation"));

        // plan-ack 走通用 confirm-step：不是 Rust UI authority，一步放行整份计划。
        let released = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "confirm-step",
                Some("acknowledge-plan"),
            ))
            .unwrap();
        assert_eq!(released.status, "ready");
        assert_eq!(released.pending_confirmation, None);
        assert_eq!(
            released
                .steps
                .iter()
                .find(|step| step.id == "collect-materials")
                .unwrap()
                .status,
            "ready"
        );
    }

    #[test]
    fn crash_recovery_is_session_and_generation_scoped_and_fences_stale_completion() {
        let (store, workspace) = fixture();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-operation-other".into(),
                    title: "并发会话".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let create = |session_id: &str, goal: &str| {
            store
                .create_geo_operation(GeoOperationCreateRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: session_id.into(),
                    kind: "performance-inspection".into(),
                    goal: goal.into(),
                    status: "ready".into(),
                    steps: vec![step("probe-18", "geo-observation", "ready", None)],
                    input_refs: vec![],
                    pending_confirmation: None,
                    source_operation_id: None,
                    update_knowledge: None,
                })
                .unwrap()
        };
        let first = create("session-operation", "会话 A 探测");
        let second = create("session-operation-other", "会话 B 探测");
        let mut start_first = mutation(&workspace, &first, "start-step", Some("probe-18"));
        start_first.sidecar_generation = Some(51);
        let running_first = store.mutate_geo_operation(start_first).unwrap();
        let start_second = GeoOperationMutationRequest {
            workspace_id: workspace.id.clone(),
            session_id: "session-operation-other".into(),
            operation_id: second.id.clone(),
            expected_revision: second.revision,
            action: "start-step".into(),
            step_id: Some("probe-18".into()),
            checkpoint: None,
            error: None,
            artifact_refs: vec![],
            replacement_steps: None,
            replacement_reason: None,
            update_knowledge: None,
            step_progress: None,
            queue_reason: None,
            queue_position: None,
            expected_execution_generation: Some(second.execution_generation),
            sidecar_generation: Some(52),
        };
        let running_second = store.mutate_geo_operation(start_second.clone()).unwrap();

        let recovered = store
            .recover_geo_operations_for_sidecar_generation(&workspace.id, "session-operation", 51)
            .unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, "recovering");
        assert_eq!(recovered[0].execution_sidecar_generation, None);
        assert_eq!(
            recovered[0].checkpoint.as_ref().unwrap().sidecar_generation,
            Some(51)
        );
        assert_eq!(
            store
                .get_geo_operation(&workspace.id, &running_second.id)
                .unwrap()
                .status,
            "running"
        );

        let mut stale = mutation(&workspace, &recovered[0], "complete-step", Some("probe-18"));
        stale.expected_execution_generation = Some(running_first.execution_generation);
        stale.sidecar_generation = Some(51);
        assert_eq!(
            store.mutate_geo_operation(stale).unwrap_err(),
            "geo_operation_execution_generation_conflict"
        );

        assert_eq!(running_second.execution_sidecar_generation, Some(52));
    }

    #[test]
    fn clean_shutdown_checkpoints_all_local_work_and_restart_leaves_it_resumable() {
        let (store, workspace) = fixture();
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "article-generation".into(),
                goal: "退出后继续文章".into(),
                status: "ready".into(),
                steps: vec![GeoOperationStep {
                    retry_unit: "article".into(),
                    ..step("article-18", "content-production", "ready", None)
                }],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let mut start = mutation(&workspace, &operation, "start-step", Some("article-18"));
        start.sidecar_generation = Some(61);
        let running = store.mutate_geo_operation(start).unwrap();

        let paused = store.pause_active_geo_operations_for_shutdown().unwrap();
        assert_eq!(paused.len(), 1);
        assert_eq!(paused[0].status, "paused");
        let checkpoint = paused[0].checkpoint.as_ref().unwrap();
        assert!(checkpoint.safe_to_resume);
        assert_eq!(checkpoint.active_retry_unit.as_deref(), Some("article"));
        assert_eq!(checkpoint.active_unit_id.as_deref(), Some("article-18"));
        assert_eq!(checkpoint.sidecar_generation, Some(61));
        assert!(paused[0].execution_generation > running.execution_generation);

        assert!(store
            .recover_interrupted_geo_operations_on_startup()
            .unwrap()
            .is_empty());
        let resumed = store
            .mutate_geo_operation(mutation(&workspace, &paused[0], "resume", None))
            .unwrap();
        assert_eq!(resumed.status, "ready");
        assert_eq!(resumed.steps[0].status, "ready");
    }

    /// 接管（ADR-0010）：CAS 所有权转移、运行中/终态守卫、留痕、
    /// awaiting-selection 池与未批准草稿随 operation 整体转移（不拆分、
    /// 不误伤他人工作集）、原会话降级、owned-or-approved 投影改键。
    #[test]
    fn takeover_transfers_unfinished_round_with_cas_guard_audit_and_rekeyed_visibility() {
        let (store, workspace) = fixture();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-operation-third".into(),
                    title: "第三个会话".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();

        // A（session-operation）的未完成轮：文章生成完成，停在文章批准门。
        let article_confirmation = confirmation("article-approval", "brand-workspace");
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "full-optimization".into(),
                goal: "一轮完整 GEO 优化".into(),
                status: "ready".into(),
                steps: vec![
                    step("generate-articles", "content-production", "ready", None),
                    step(
                        "confirm-articles",
                        "content-production",
                        "pending",
                        Some(article_confirmation),
                    ),
                ],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let running = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("generate-articles"),
            ))
            .unwrap();
        let waiting = store
            .mutate_geo_operation(mutation(
                &workspace,
                &running,
                "complete-step",
                Some("generate-articles"),
            ))
            .unwrap();
        assert_eq!(waiting.status, "awaiting-confirmation");

        // A 的未批准工作集：3 篇未批准草稿 + 2 篇已批准文章。
        // 另有：全批准的文章操作（品牌产物，不转移）、B 自己的草稿（不动）、
        // awaiting-selection 池（随行）与 confirmed 池（不转移）。
        let connection = open_database(&workspace).unwrap();
        connection
            .pragma_update(None, "foreign_keys", "OFF")
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_decisions(
                    id,candidate_id,decision,actor_id,actor_session_id,
                    expected_version,decided_at)
                 VALUES ('decision-kv-1','candidate-kv-1','adopt-new','desktop-user',
                    'session-operation',0,'2026-08-30T09:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_versions(
                    version,decision_id,actor_session_id,snapshot_hash,created_at)
                 VALUES (1,'decision-kv-1','session-operation','hash',
                    '2026-08-30T09:00:00Z')",
                [],
            )
            .unwrap();
        for (row, operation_id, status, approved_revision) in [
            (0, "article-op-round-one", "draft_ready", None),
            (1, "article-op-round-one", "draft_ready", None),
            (2, "article-op-round-one", "draft_ready", None),
            (3, "article-op-round-one", "approved", Some(1)),
            (4, "article-op-round-one", "approved", Some(1)),
            (5, "article-op-approved-only", "approved", Some(1)),
            (6, "article-op-approved-only", "approved", Some(1)),
            (7, "article-op-foreign-session", "draft_ready", None),
        ] {
            connection
                .execute(
                    "INSERT INTO geo_articles(
                        id,operation_id,source_plan_item_id,knowledge_version,
                        content_type,topic,requested_title,constraints,
                        planned_facts_json,status,revision,approved_revision,
                        generation_attempt,created_at,updated_at)
                     VALUES (?1,?2,NULL,1,'guide','主题','标题','要求','{}',
                        ?3,1,?4,0,'2026-08-30T09:00:00Z','2026-08-31T18:00:00Z')",
                    params![
                        format!("article-takeover-{row}"),
                        operation_id,
                        status,
                        approved_revision
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO geo_article_versions(
                        article_id,revision,title,body_path,approved_body_path,
                        body_sha256,origin,based_on_revision,review_json,
                        model_audit_json,created_by_session_id,created_at,approved_at)
                     VALUES (?1,1,'标题','articles/?1/body.md',?2,'sha','generated',
                        NULL,NULL,'{}','session-operation','2026-08-30T09:00:00Z',?3)",
                    params![
                        format!("article-takeover-{row}"),
                        approved_revision.map(|_| "articles/approved-body.md"),
                        approved_revision.map(|_| "2026-08-31T10:00:00Z"),
                    ],
                )
                .unwrap();
        }
        for (operation_id, session) in [
            ("article-op-round-one", "session-operation"),
            ("article-op-approved-only", "session-operation"),
            ("article-op-foreign-session", "session-operation-other"),
        ] {
            connection
                .execute(
                    "INSERT INTO geo_article_operations(
                        operation_id,created_by_session_id,source_kind,topic_plan_id,
                        topic_plan_revision,knowledge_version,product_line,target_region,
                        policy_version,operation_spec_json,status,created_at,updated_at)
                     VALUES (?1,?2,'direct',NULL,NULL,1,'汽车音响改装','成都',
                        'test','{}','completed','2026-08-30T09:00:00Z',
                        '2026-08-31T18:00:00Z')",
                    params![operation_id, session],
                )
                .unwrap();
        }
        for (pool_id, status) in [
            ("pool-round-one", "awaiting-selection"),
            ("pool-confirmed", "confirmed"),
        ] {
            connection
                .execute(
                    "INSERT INTO geo_question_pools(
                        id,operation_id,created_by_session_id,knowledge_version,
                        product_line,target_region,generation_parameters_json,status,
                        revision,created_at,updated_at)
                     VALUES (?1,'pool-lineage-operation','session-operation',1,
                        '汽车音响改装','成都','{}',?2,0,'2026-08-30T09:00:00Z',
                        '2026-08-31T18:00:00Z')",
                    params![pool_id, status],
                )
                .unwrap();
        }
        drop(connection);

        // 接管前：B 不是所有者，读不到 A 的未批准草稿（既有隔离不放松）。
        assert_eq!(
            store
                .get_article_operation(
                    &workspace.id,
                    "session-operation-other",
                    ArticleOperationGetRequest {
                        operation_id: "article-op-round-one".into(),
                    },
                )
                .unwrap_err(),
            "article_draft_session_mismatch"
        );

        // 运行中守卫：A 的另一个 running 操作拒绝接管，错误可转述。
        let live = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "performance-inspection".into(),
                goal: "正在跑的探测".into(),
                status: "ready".into(),
                steps: vec![step("inspect", "geo-dashboard", "ready", None)],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let live_running = store
            .mutate_geo_operation(mutation(&workspace, &live, "start-step", Some("inspect")))
            .unwrap();
        assert_eq!(
            store
                .takeover_geo_operation(GeoOperationTakeoverRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-operation-other".into(),
                    operation_id: live_running.id.clone(),
                    expected_revision: live_running.revision,
                })
                .unwrap_err(),
            "geo_operation_takeover_running:running (the owning session is still executing this round; it must pause or finish first)"
        );

        // 陈旧 revision（尚未被抢）：普通 revision 冲突，可重试。
        assert_eq!(
            store
                .takeover_geo_operation(GeoOperationTakeoverRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-operation-other".into(),
                    operation_id: waiting.id.clone(),
                    expected_revision: waiting.revision - 1,
                })
                .unwrap_err(),
            "geo_operation_revision_conflict"
        );

        // B 接管成功：CAS 转移、留痕（谁、何时）、工作集整体随行。
        let takeover = |session_id: &str, expected_revision: i64| {
            store.takeover_geo_operation(GeoOperationTakeoverRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.into(),
                operation_id: waiting.id.clone(),
                expected_revision,
            })
        };
        let receipt = takeover("session-operation-other", waiting.revision).unwrap();
        assert_eq!(receipt.operation.session_id, "session-operation-other");
        assert_eq!(receipt.operation.revision, waiting.revision + 1);
        assert_eq!(receipt.operation.status, "awaiting-confirmation");
        assert_eq!(
            receipt.operation.steps[1].status, "awaiting-confirmation",
            "接管不推进也不改写步骤序列"
        );
        assert_eq!(
            receipt.previous_owner_session_id,
            Some("session-operation".to_string())
        );
        assert!(!receipt.taken_over_at.is_empty());
        assert_eq!(receipt.transferred_article_operations, 1);
        assert_eq!(receipt.transferred_question_pools, 1);
        let taken_over = receipt.operation;

        // A→B 转移不误伤他人工作集：B 自己原生的草稿操作（row 7）不在
        // A 的转移范围内，owner 覆盖仍为空。
        {
            let connection = open_database(&workspace).unwrap();
            let foreign_owner: Option<String> = connection
                .query_row(
                    "SELECT owner_session_id FROM geo_article_operations
                     WHERE operation_id='article-op-foreign-session'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(foreign_owner, None, "他 session 的草稿不得被 A→B 接管转移");
        }

        // owned-or-approved 改键：B（现所有者）能读全部 5 篇，含 3 篇草稿。
        let owned = store
            .get_article_operation(
                &workspace.id,
                "session-operation-other",
                ArticleOperationGetRequest {
                    operation_id: "article-op-round-one".into(),
                },
            )
            .unwrap();
        assert_eq!(owned.articles.len(), 5);

        // awaiting-selection 池随行：B 的 pending latest 取得到，A 取不到。
        assert_eq!(
            store
                .latest_valid_question_pool(
                    &workspace.id,
                    "session-operation-other",
                    QuestionPoolLatestRequest {
                        product_line: None,
                        pending_only: true,
                    },
                )
                .unwrap()
                .unwrap()
                .id,
            "pool-round-one"
        );
        assert!(store
            .latest_valid_question_pool(
                &workspace.id,
                "session-operation",
                QuestionPoolLatestRequest {
                    product_line: None,
                    pending_only: true,
                },
            )
            .unwrap()
            .is_none());

        // 原会话降级：控制动作返回友好错误（指明被哪次会话接管），
        // 未批准草稿回到跨会话隔离。
        let degraded = store
            .mutate_geo_operation(mutation(&workspace, &taken_over, "cancel", None))
            .unwrap_err();
        assert_eq!(
            degraded,
            "geo_operation_session_mismatch:taken_over_by=session-operation-other"
        );
        assert_eq!(
            store
                .get_article_operation(
                    &workspace.id,
                    "session-operation",
                    ArticleOperationGetRequest {
                        operation_id: "article-op-round-one".into(),
                    },
                )
                .unwrap_err(),
            "article_draft_session_mismatch"
        );

        // 元信息 tracer 跟随当前所有者：B 名下待审 = 随行转移的 3 篇 + B
        // 自己原有的 1 篇（#25 的会话级计数语义）；A 名下已无待审草稿。
        let summaries = &store
            .list_unfinished_geo_operations(&workspace.id)
            .unwrap()
            .operations;
        let summary = summaries
            .iter()
            .find(|summary| summary.id == taken_over.id)
            .unwrap();
        assert_eq!(
            summary.session_id,
            Some("session-operation-other".to_string())
        );
        assert_eq!(summary.pending_review_count, 4);
        let live_summary = summaries
            .iter()
            .find(|summary| summary.id == live_running.id)
            .unwrap();
        assert_eq!(
            live_summary.session_id,
            Some("session-operation".to_string())
        );
        assert_eq!(live_summary.pending_review_count, 0);

        // CAS 单赢家：后来者带过期 revision 接管，收到指明赢家的明确错误。
        let loser = takeover("session-operation-third", waiting.revision).unwrap_err();
        assert_eq!(
            loser,
            "geo_operation_takeover_conflict:taken_over_by=session-operation-other (another session took over this round first)"
        );

        // 刷新 revision 后允许链式接管（B→C）；B 名下的未批准工作集（随行
        // 的 article-op-round-one + B 自己原生的 article-op-foreign-session）
        // 与 awaiting-selection 池继续随 operation 整体走。
        let chained = takeover("session-operation-third", taken_over.revision).unwrap();
        assert_eq!(chained.operation.session_id, "session-operation-third");
        assert_eq!(
            chained.previous_owner_session_id,
            Some("session-operation-other".to_string())
        );
        assert_eq!(chained.transferred_article_operations, 2);
        assert_eq!(chained.transferred_question_pools, 1);
        let owned_by_third = store
            .get_article_operation(
                &workspace.id,
                "session-operation-third",
                ArticleOperationGetRequest {
                    operation_id: "article-op-round-one".into(),
                },
            )
            .unwrap();
        assert_eq!(owned_by_third.articles.len(), 5);

        // 所有者本人重复接管：明确拒绝而不是幂等静默。
        assert_eq!(
            takeover("session-operation-third", chained.operation.revision).unwrap_err(),
            "geo_operation_takeover_already_owner (this session already owns this operation; continue with inspect_geo_operations)"
        );

        // 终态轮次不可接管。
        let finished = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "knowledge-update".into(),
                goal: "已完成的更新".into(),
                status: "ready".into(),
                steps: vec![step(
                    "collect-materials",
                    "brand-material-import",
                    "ready",
                    None,
                )],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: None,
            })
            .unwrap();
        let finished_started = store
            .mutate_geo_operation(mutation(
                &workspace,
                &finished,
                "start-step",
                Some("collect-materials"),
            ))
            .unwrap();
        let finished = store
            .mutate_geo_operation(mutation(
                &workspace,
                &finished_started,
                "complete-step",
                Some("collect-materials"),
            ))
            .unwrap();
        assert_eq!(finished.status, "succeeded");
        assert_eq!(
            store
                .takeover_geo_operation(GeoOperationTakeoverRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-operation-other".into(),
                    operation_id: finished.id.clone(),
                    expected_revision: finished.revision,
                })
                .unwrap_err(),
            "geo_operation_takeover_terminal:succeeded (only unfinished rounds can be taken over; start a new operation instead)"
        );

        // 转移不误伤：全批准操作与 confirmed 池不转移（品牌产物，历次
        // 接管后 owner 覆盖仍为空）。
        let connection = open_database(&workspace).unwrap();
        for (sql, label) in [
            (
                "SELECT owner_session_id FROM geo_article_operations
                 WHERE operation_id='article-op-approved-only'",
                "全批准文章操作",
            ),
            (
                "SELECT owner_session_id FROM geo_question_pools WHERE id='pool-confirmed'",
                "confirmed 问题池",
            ),
        ] {
            let owner_override: Option<String> = connection
                .query_row(sql, [], |row| row.get(0))
                .unwrap_or_else(|error| panic!("{label} 读取失败: {error}"));
            assert_eq!(owner_override, None, "{label} 不得被接管转移");
        }
    }

    /// 无主轮（session_id NULL：原会话被删除，外键 SET NULL 保留轮次）必须
    /// 进跨会话未完成摘要、且可被接管（票 10 验收实证：NULL 行被摘要过滤
    /// 排除 + 接管 CAS 的 `session_id=NULL` 三值逻辑恒假，无主轮对一切新
    /// 会话不可见也不可接管，永久搁浅——0cada786 实例）。
    #[test]
    fn ownerless_round_is_listed_in_summary_and_takeable() {
        let (store, workspace) = fixture();
        let operation = store
            .create_geo_operation(GeoOperationCreateRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation".into(),
                kind: "next-round-optimization".into(),
                goal: "新一轮内容优化到发布".into(),
                status: "ready".into(),
                steps: vec![
                    step("acknowledge-plan", "question-opportunities", "ready", None),
                    step(
                        "select-next-question-pool",
                        "question-opportunities",
                        "pending",
                        Some(confirmation("question-selection", "brand-workspace")),
                    ),
                ],
                input_refs: vec![],
                pending_confirmation: None,
                source_operation_id: None,
                update_knowledge: Some(false),
            })
            .unwrap();
        // 推进到问题确认门：认可门放行后停在 select-next-question-pool
        //（0cada786 的真实形态：next-round + updateKnowledge=false + 问题门）。
        let started = store
            .mutate_geo_operation(mutation(
                &workspace,
                &operation,
                "start-step",
                Some("acknowledge-plan"),
            ))
            .unwrap();
        let operation = store
            .mutate_geo_operation(mutation(
                &workspace,
                &started,
                "complete-step",
                Some("acknowledge-plan"),
            ))
            .unwrap();
        assert_eq!(operation.status, "awaiting-confirmation");

        // 原会话删除：轮次保留、引用置空（brand_workspace.rs 的 SET NULL 语义）。
        {
            let connection = open_database(&workspace).unwrap();
            connection
                .execute(
                    "DELETE FROM brand_sessions WHERE id='session-operation'",
                    [],
                )
                .unwrap();
        }

        // 摘要列出无主轮：sessionId 为 null、待审 0、决策字段原样。
        let list = store.list_unfinished_geo_operations(&workspace.id).unwrap();
        let summary = list
            .operations
            .iter()
            .find(|summary| summary.id == operation.id)
            .expect("无主轮必须出现在未完成摘要里");
        assert_eq!(summary.session_id, None);
        assert_eq!(summary.pending_review_count, 0);
        assert_eq!(summary.update_knowledge, Some(false));
        assert_eq!(
            summary.stuck_step.as_ref().map(|step| step.id.as_str()),
            Some("select-next-question-pool")
        );
        assert_eq!(list.total, 1);

        // 新会话单次接管成功：所有者落位、revision+1、无随行工作集、
        // 留痕 previous owner 为 null。
        let receipt = store
            .takeover_geo_operation(GeoOperationTakeoverRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-operation-other".into(),
                operation_id: operation.id.clone(),
                expected_revision: operation.revision,
            })
            .unwrap();
        assert_eq!(receipt.operation.session_id, "session-operation-other");
        assert_eq!(receipt.operation.revision, operation.revision + 1);
        assert_eq!(receipt.previous_owner_session_id, None);
        assert_eq!(receipt.transferred_article_operations, 0);
        assert_eq!(receipt.transferred_question_pools, 0);
        // 接管后摘要条目归属新会话。
        let list = store.list_unfinished_geo_operations(&workspace.id).unwrap();
        let summary = list.operations.first().unwrap();
        assert_eq!(
            summary.session_id,
            Some("session-operation-other".to_string())
        );
    }
}
