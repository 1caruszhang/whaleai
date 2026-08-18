use std::collections::HashSet;

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
const CONFIRMATION_KINDS: [&str; 10] = [
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
const CONFIRMATION_AUTHORITIES: [&str; 4] = [
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
    pub revision: i64,
    pub execution_generation: i64,
    pub execution_sidecar_generation: Option<u64>,
    pub queue_reason: Option<String>,
    pub queue_position: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub terminal_at: Option<String>,
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
                     pending_confirmation_json, source_operation_id, revision,
                     execution_generation, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'[]',?10,?11,1,0,?4)",
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
            return Err("geo_operation_session_mismatch".to_string());
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
            "update-queue" | "start-step" | "checkpoint" | "complete-step" | "fail-step"
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
                    execution_sidecar_generation=?13
                 WHERE id=?14 AND session_id=?15 AND revision=?16",
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
            return Err("geo_operation_session_mismatch".to_string());
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
            queue_reason: None,
            queue_position: None,
            expected_execution_generation: None,
            sidecar_generation: None,
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
            require_status(&operation.status, &["awaiting-confirmation"])?;
            if operation.kind != "next-round-optimization"
                || operation.steps.len() != 1
                || operation.steps[0].id != "decide-knowledge-refresh"
            {
                return Err("geo_operation_plan_replacement_invalid".to_string());
            }
            let replacement = request
                .replacement_steps
                .clone()
                .ok_or_else(|| "geo_operation_replacement_steps_required".to_string())?;
            validate_steps(&replacement)?;
            operation.steps = replacement;
            operation.pending_confirmation = None;
            operation.checkpoint = None;
            operation.error = None;
            normalize_first_step(operation)?;
        }
        "pause" => {
            if let Err(error) =
                require_status(&operation.status, &["ready", "queued", "running", "recovering"])
            {
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
                source_operation_id,revision,execution_generation,
                execution_sidecar_generation,queue_reason,queue_position,
                created_at,COALESCE(updated_at,created_at),terminal_at
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
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, Option<u64>>(14)?,
                    row.get::<_, Option<String>>(15)?,
                    row.get::<_, Option<i64>>(16)?,
                    row.get::<_, String>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, Option<String>>(19)?,
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
                revision,
                execution_generation,
                execution_sidecar_generation,
                queue_reason,
                queue_position,
                created_at,
                updated_at,
                terminal_at,
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
                    revision,
                    execution_generation,
                    execution_sidecar_generation,
                    queue_reason,
                    queue_position,
                    created_at,
                    updated_at,
                    terminal_at,
                })
            },
        )
        .transpose()
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
    use crate::brand_workspace::{BrandWorkspace, SessionCommit, SessionTitleSource};
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
            "sourceOperationId": "source-operation-15"
        }))
        .unwrap();
        validate_create(&request).unwrap();
        assert_eq!(request.steps[0].capability, "geo-dashboard");
        assert_eq!(request.input_refs[0].kind, "report");

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
}
