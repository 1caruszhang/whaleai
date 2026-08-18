use super::*;
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};

const BASELINE_POLICY_VERSION: &str = "xiaojing-geo-baseline-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselinePrepareRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub question_pool_id: String,
    pub engine_ids: Vec<String>,
    pub provider_snapshots: Value,
    pub idempotency_key: String,
    pub policy_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineLatestRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineGetRequest {
    pub baseline_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineUnitClaimRequest {
    pub baseline_id: String,
    pub unit_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineUnitFinishRequest {
    pub baseline_id: String,
    pub unit_id: String,
    pub claim_token: String,
    pub status: String,
    pub raw_answer: Option<String>,
    pub raw_evidence: Option<Value>,
    pub citations: Option<Value>,
    pub analysis: Option<Value>,
    pub duration_ms: i64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineUnitClaim {
    pub action: String,
    pub claim_token: Option<String>,
    pub attempt_number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineAttempt {
    pub attempt_number: i64,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineEvidenceUnit {
    pub id: String,
    pub question_id: String,
    pub question: String,
    pub engine_id: String,
    pub provider_snapshot: Value,
    pub status: String,
    pub attempt_number: i64,
    pub raw_answer: Option<String>,
    pub raw_evidence: Option<Value>,
    pub citations: Value,
    pub analysis: Option<Value>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub attempts: Vec<GeoBaselineAttempt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineEvidenceIds {
    pub brand_mentioned: Vec<String>,
    pub brand_recommended: Vec<String>,
    pub with_citation_evidence: Vec<String>,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineMetrics {
    pub total: i64,
    pub completed: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub pending: i64,
    pub brand_mentioned: i64,
    pub brand_recommended: i64,
    pub with_citation_evidence: i64,
    pub mention_rate: Option<i64>,
    pub recommendation_rate: Option<i64>,
    pub citation_rate: Option<i64>,
    pub evidence_unit_ids: GeoBaselineEvidenceIds,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselineProjection {
    pub id: String,
    pub operation_id: String,
    pub workspace_id: String,
    pub created_by_session_id: String,
    pub question_pool_id: String,
    pub question_pool_revision: i64,
    pub knowledge_version: i64,
    pub brand_names: Vec<String>,
    pub provider_snapshots: Value,
    pub policy_version: String,
    pub status: String,
    pub metrics: GeoBaselineMetrics,
    pub units: Vec<GeoBaselineEvidenceUnit>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoBaselinePreparation {
    pub baseline: GeoBaselineProjection,
    pub brand_names: Vec<String>,
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_baselines (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                question_pool_id TEXT NOT NULL REFERENCES geo_question_pools(id),
                question_pool_revision INTEGER NOT NULL,
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                brand_names_json TEXT NOT NULL,
                provider_snapshots_json TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','failed')),
                idempotency_key TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS geo_baselines_latest
                ON geo_baselines(updated_at DESC, id DESC);
             CREATE TABLE IF NOT EXISTS geo_baseline_units (
                id TEXT PRIMARY KEY,
                baseline_id TEXT NOT NULL REFERENCES geo_baselines(id),
                question_id TEXT NOT NULL,
                question_text TEXT NOT NULL,
                engine_id TEXT NOT NULL,
                provider_snapshot_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
                attempt_number INTEGER NOT NULL DEFAULT 0,
                current_claim_token TEXT,
                raw_answer TEXT,
                raw_evidence_json TEXT,
                citations_json TEXT NOT NULL DEFAULT '[]',
                analysis_json TEXT,
                started_at TEXT,
                finished_at TEXT,
                duration_ms INTEGER,
                error_code TEXT,
                error_message TEXT,
                UNIQUE(baseline_id, question_id, engine_id)
             );
             CREATE TABLE IF NOT EXISTS geo_baseline_attempts (
                unit_id TEXT NOT NULL REFERENCES geo_baseline_units(id),
                attempt_number INTEGER NOT NULL,
                claim_token TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
                started_at TEXT NOT NULL,
                finished_at TEXT,
                duration_ms INTEGER,
                error_code TEXT,
                error_message TEXT,
                PRIMARY KEY(unit_id, attempt_number)
             );",
        )
        .map_err(|error| format!("initialize GEO baseline schema: {error}"))?;
    super::drop_brand_sessions_foreign_keys(connection, &["geo_baselines"])
}

impl BrandWorkspaceStore {
    pub fn latest_geo_baseline(
        &self,
        workspace_id: &str,
        session_id: &str,
        _request: GeoBaselineLatestRequest,
    ) -> Result<Option<GeoBaselineProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_baseline_session(&connection, session_id)?;
        let baseline_id: Option<String> = connection
            .query_row(
                "SELECT id FROM geo_baselines ORDER BY updated_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read latest GEO baseline: {error}"))?;
        baseline_id
            .map(|id| read_geo_baseline(&connection, workspace_id, &id))
            .transpose()
    }

    pub fn get_geo_baseline(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoBaselineGetRequest,
    ) -> Result<Option<GeoBaselineProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_baseline_session(&connection, session_id)?;
        if request.baseline_id.trim().is_empty() {
            return Err("geo_baseline_id_invalid".to_string());
        }
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM geo_baselines WHERE id=?1",
                [&request.baseline_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("find exact GEO baseline: {error}"))?;
        if exists == 0 {
            return Ok(None);
        }
        read_geo_baseline(&connection, workspace_id, &request.baseline_id).map(Some)
    }

    pub fn prepare_geo_baseline(
        &self,
        request: GeoBaselinePrepareRequest,
    ) -> Result<GeoBaselinePreparation, String> {
        validate_prepare(&request)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_baseline_session(&connection, &request.session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start GEO baseline preparation: {error}"))?;

        if let Some(existing_id) = transaction
            .query_row(
                "SELECT id FROM geo_baselines WHERE idempotency_key=?1",
                [&request.idempotency_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read idempotent GEO baseline: {error}"))?
        {
            let existing = read_geo_baseline(&transaction, &workspace.id, &existing_id)?;
            if existing.question_pool_id != request.question_pool_id
                || existing.provider_snapshots != request.provider_snapshots
            {
                return Err("geo_baseline_idempotency_conflict".to_string());
            }
            let brand_names = existing.brand_names.clone();
            transaction
                .commit()
                .map_err(|error| format!("commit idempotent GEO baseline read: {error}"))?;
            return Ok(GeoBaselinePreparation {
                baseline: existing,
                brand_names,
            });
        }

        let (pool_status, pool_revision, knowledge_version): (String, i64, i64) = transaction
            .query_row(
                "SELECT status, revision, knowledge_version FROM geo_question_pools WHERE id=?1",
                [&request.question_pool_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read baseline question pool: {error}"))?
            .ok_or_else(|| "geo_baseline_question_pool_not_found".to_string())?;
        if pool_status != "confirmed" {
            return Err("geo_baseline_question_pool_not_confirmed".to_string());
        }
        let (decision_revision, questions_json, selected_ids_json): (i64, String, String) =
            transaction
                .query_row(
                    "SELECT revision, questions_json, selected_question_ids_json
                 FROM geo_question_pool_decisions WHERE pool_id=?1
                 ORDER BY revision DESC LIMIT 1",
                    [&request.question_pool_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| format!("read confirmed baseline questions: {error}"))?
                .ok_or_else(|| "geo_baseline_question_pool_decision_missing".to_string())?;
        if decision_revision != pool_revision {
            return Err("geo_baseline_question_pool_revision_mismatch".to_string());
        }
        let questions: Value = serde_json::from_str(&questions_json)
            .map_err(|error| format!("parse confirmed baseline questions: {error}"))?;
        let selected_ids: Vec<String> = serde_json::from_str(&selected_ids_json)
            .map_err(|error| format!("parse selected baseline question ids: {error}"))?;
        let selected = selected_questions(&questions, &selected_ids)?;
        let brand_names = baseline_brand_names(&transaction, &workspace, knowledge_version)?;
        let snapshots = validated_snapshots(&request.engine_ids, &request.provider_snapshots)?;
        let now = Utc::now().to_rfc3339();
        let baseline_id = Uuid::new_v4().to_string();
        let operation_id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES (?1, ?2, 'baseline-running', ?3)",
                params![operation_id, request.session_id, now],
            )
            .map_err(|error| format!("create baseline operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_artifacts
                    (id, operation_id, session_id, kind, knowledge_version, created_at)
                 VALUES (?1, ?2, ?3, 'pre-optimization-baseline', ?4, ?5)",
                params![
                    baseline_id,
                    operation_id,
                    request.session_id,
                    knowledge_version,
                    now
                ],
            )
            .map_err(|error| format!("create baseline artifact: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_baselines
                    (id, operation_id, created_by_session_id, question_pool_id,
                     question_pool_revision, knowledge_version, brand_names_json,
                     provider_snapshots_json, policy_version, status, idempotency_key,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10, ?11, ?11)",
                params![
                    baseline_id,
                    operation_id,
                    request.session_id,
                    request.question_pool_id,
                    pool_revision,
                    knowledge_version,
                    serde_json::to_string(&brand_names).map_err(|error| error.to_string())?,
                    canonical_json(&request.provider_snapshots)?,
                    request.policy_version,
                    request.idempotency_key,
                    now
                ],
            )
            .map_err(|error| format!("persist GEO baseline: {error}"))?;
        for (engine_id, snapshot) in snapshots {
            for (question_id, question) in &selected {
                transaction
                    .execute(
                        "INSERT INTO geo_baseline_units
                            (id, baseline_id, question_id, question_text, engine_id,
                             provider_snapshot_json, status, attempt_number, citations_json)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 0, '[]')",
                        params![
                            Uuid::new_v4().to_string(),
                            baseline_id,
                            question_id,
                            question,
                            engine_id,
                            canonical_json(&snapshot)?
                        ],
                    )
                    .map_err(|error| format!("create GEO baseline evidence unit: {error}"))?;
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("commit GEO baseline preparation: {error}"))?;
        let baseline = read_geo_baseline(&connection, &workspace.id, &baseline_id)?;
        Ok(GeoBaselinePreparation {
            baseline,
            brand_names,
        })
    }

    pub fn claim_geo_baseline_unit(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoBaselineUnitClaimRequest,
    ) -> Result<GeoBaselineUnitClaim, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_baseline_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start baseline unit claim: {error}"))?;
        let (baseline_id, status, attempt_number): (String, String, i64) = transaction
            .query_row(
                "SELECT baseline_id, status, attempt_number FROM geo_baseline_units WHERE id=?1",
                [&request.unit_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read baseline evidence unit: {error}"))?
            .ok_or_else(|| "geo_baseline_unit_not_found".to_string())?;
        if baseline_id != request.baseline_id {
            return Err("geo_baseline_unit_identity_mismatch".to_string());
        }
        if status == "succeeded" {
            return Ok(GeoBaselineUnitClaim {
                action: "cached".to_string(),
                claim_token: None,
                attempt_number,
            });
        }
        if status == "running" {
            return Ok(GeoBaselineUnitClaim {
                action: "busy".to_string(),
                claim_token: None,
                attempt_number,
            });
        }
        let next_attempt = attempt_number + 1;
        let claim_token = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE geo_baseline_units
                 SET status='running', attempt_number=?2, current_claim_token=?3,
                     started_at=?4, finished_at=NULL, duration_ms=NULL
                 WHERE id=?1 AND status IN ('pending','failed') AND attempt_number=?5",
                params![
                    request.unit_id,
                    next_attempt,
                    claim_token,
                    now,
                    attempt_number
                ],
            )
            .map_err(|error| format!("claim baseline evidence unit: {error}"))?;
        if changed != 1 {
            return Err("geo_baseline_unit_claim_conflict".to_string());
        }
        transaction
            .execute(
                "INSERT INTO geo_baseline_attempts
                    (unit_id, attempt_number, claim_token, status, started_at)
                 VALUES (?1, ?2, ?3, 'running', ?4)",
                params![request.unit_id, next_attempt, claim_token, now],
            )
            .map_err(|error| format!("record baseline evidence attempt: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit baseline unit claim: {error}"))?;
        Ok(GeoBaselineUnitClaim {
            action: "execute".to_string(),
            claim_token: Some(claim_token),
            attempt_number: next_attempt,
        })
    }

    pub fn finish_geo_baseline_unit(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoBaselineUnitFinishRequest,
    ) -> Result<GeoBaselineEvidenceUnit, String> {
        validate_finish(&request)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_baseline_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start baseline unit finish: {error}"))?;
        let (baseline_id, status, attempt_number, claim_token): (
            String,
            String,
            i64,
            Option<String>,
        ) = transaction
            .query_row(
                "SELECT baseline_id, status, attempt_number, current_claim_token
                 FROM geo_baseline_units WHERE id=?1",
                [&request.unit_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("read claimed baseline unit: {error}"))?
            .ok_or_else(|| "geo_baseline_unit_not_found".to_string())?;
        if baseline_id != request.baseline_id {
            return Err("geo_baseline_unit_identity_mismatch".to_string());
        }
        if status != "running" || claim_token.as_deref() != Some(&request.claim_token) {
            return Err("geo_baseline_unit_claim_stale".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let citations = canonical_json(request.citations.as_ref().unwrap_or(&json!([])))?;
        let raw_evidence = request
            .raw_evidence
            .as_ref()
            .map(canonical_json)
            .transpose()?;
        let analysis = request.analysis.as_ref().map(canonical_json).transpose()?;
        transaction
            .execute(
                "UPDATE geo_baseline_units SET status=?2, current_claim_token=NULL,
                     raw_answer=?3, raw_evidence_json=?4, citations_json=?5,
                     analysis_json=?6, finished_at=?7, duration_ms=?8,
                     error_code=?9, error_message=?10 WHERE id=?1",
                params![
                    request.unit_id,
                    request.status,
                    request.raw_answer,
                    raw_evidence,
                    citations,
                    analysis,
                    now,
                    request.duration_ms,
                    request.error_code,
                    request.error_message
                ],
            )
            .map_err(|error| format!("finish baseline evidence unit: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_baseline_attempts SET status=?3, finished_at=?4,
                     duration_ms=?5, error_code=?6, error_message=?7
                 WHERE unit_id=?1 AND attempt_number=?2 AND claim_token=?8 AND status='running'",
                params![
                    request.unit_id,
                    attempt_number,
                    request.status,
                    now,
                    request.duration_ms,
                    request.error_code,
                    request.error_message,
                    request.claim_token
                ],
            )
            .map_err(|error| format!("finish baseline evidence attempt: {error}"))?;

        if request.status == "succeeded" {
            let evidence = json!({
                "baselineId": request.baseline_id,
                "unitId": request.unit_id,
                "attemptNumber": attempt_number,
                "rawAnswer": request.raw_answer,
                "rawEvidence": request.raw_evidence,
                "citations": request.citations,
                "analysis": request.analysis,
            });
            transaction
                .execute(
                    "INSERT INTO observations (id, operation_id, observed_at, evidence_json)
                     SELECT ?1, operation_id, ?2, ?3 FROM geo_baselines WHERE id=?4",
                    params![
                        format!("{}-attempt-{}", request.unit_id, attempt_number),
                        now,
                        canonical_json(&evidence)?,
                        request.baseline_id
                    ],
                )
                .map_err(|error| format!("store baseline observation evidence: {error}"))?;
        }
        let (baseline_status, operation_state) =
            baseline_status(&transaction, &request.baseline_id)?;
        transaction
            .execute(
                "UPDATE geo_baselines SET status=?2, updated_at=?3 WHERE id=?1",
                params![request.baseline_id, baseline_status, now],
            )
            .map_err(|error| format!("update baseline aggregate state: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state=?2
                 WHERE id=(SELECT operation_id FROM geo_baselines WHERE id=?1)",
                params![request.baseline_id, operation_state],
            )
            .map_err(|error| format!("update baseline operation state: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit baseline unit finish: {error}"))?;
        read_geo_baseline_unit(&connection, &request.unit_id)
    }
}

fn validate_prepare(request: &GeoBaselinePrepareRequest) -> Result<(), String> {
    validate_session_id(&request.session_id)?;
    if request.workspace_id.trim().is_empty() || request.question_pool_id.trim().is_empty() {
        return Err("geo_baseline_identity_invalid".to_string());
    }
    if request.idempotency_key.trim().is_empty() || request.idempotency_key.len() > 160 {
        return Err("geo_baseline_idempotency_key_invalid".to_string());
    }
    if request.policy_version != BASELINE_POLICY_VERSION {
        return Err("geo_baseline_policy_version_invalid".to_string());
    }
    if request.engine_ids.is_empty() {
        return Err("geo_baseline_engine_required".to_string());
    }
    Ok(())
}

fn canonical_json<T: ?Sized + Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("serialize GEO baseline JSON: {error}"))
}

fn validate_finish(request: &GeoBaselineUnitFinishRequest) -> Result<(), String> {
    if !matches!(request.status.as_str(), "succeeded" | "failed") {
        return Err("geo_baseline_finish_status_invalid".to_string());
    }
    if request.duration_ms < 0 {
        return Err("geo_baseline_duration_invalid".to_string());
    }
    if request.status == "succeeded" {
        if request
            .raw_answer
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
            || request.raw_evidence.is_none()
            || request
                .analysis
                .as_ref()
                .and_then(Value::as_object)
                .is_none()
        {
            return Err("geo_baseline_success_evidence_required".to_string());
        }
    } else if request
        .error_code
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
        || request
            .error_message
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
    {
        return Err("geo_baseline_failure_diagnostic_required".to_string());
    }
    Ok(())
}

fn require_baseline_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM brand_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("verify GEO baseline session: {error}"))?;
    if exists == 1 {
        Ok(())
    } else {
        Err("geo_baseline_session_not_committed".to_string())
    }
}

fn selected_questions(
    value: &Value,
    selected_ids: &[String],
) -> Result<Vec<(String, String)>, String> {
    let selected: std::collections::HashSet<&str> =
        selected_ids.iter().map(String::as_str).collect();
    let questions = value
        .as_array()
        .ok_or_else(|| "geo_baseline_questions_invalid".to_string())?;
    let mut result = Vec::new();
    for question in questions {
        let Some(id) = question.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !selected.contains(id) {
            continue;
        }
        let text = question
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .ok_or_else(|| "geo_baseline_question_text_invalid".to_string())?;
        result.push((id.to_string(), text.to_string()));
    }
    if result.len() != selected.len() || result.is_empty() {
        return Err("geo_baseline_selected_questions_invalid".to_string());
    }
    Ok(result)
}

fn validated_snapshots(
    engine_ids: &[String],
    value: &Value,
) -> Result<Vec<(String, Value)>, String> {
    let allowed: std::collections::HashSet<&str> = engine_ids.iter().map(String::as_str).collect();
    if allowed.len() != engine_ids.len() || allowed.iter().any(|id| *id != "doubao") {
        return Err("geo_baseline_engine_invalid".to_string());
    }
    let snapshots = value
        .as_array()
        .ok_or_else(|| "geo_baseline_provider_snapshot_invalid".to_string())?;
    let mut result = Vec::new();
    for snapshot in snapshots {
        let object = snapshot
            .as_object()
            .ok_or_else(|| "geo_baseline_provider_snapshot_invalid".to_string())?;
        let keys: std::collections::HashSet<&str> = object.keys().map(String::as_str).collect();
        let expected: std::collections::HashSet<&str> = [
            "engineId",
            "provider",
            "capabilitySlot",
            "model",
            "endpointFamily",
            "searchMode",
            "configurationFingerprint",
            "policyVersion",
        ]
        .into_iter()
        .collect();
        if keys != expected
            || object.get("provider").and_then(Value::as_str) != Some("volcengine")
            || object.get("capabilitySlot").and_then(Value::as_str) != Some("keyword-search")
            || object.get("endpointFamily").and_then(Value::as_str) != Some("ark-responses")
            || object.get("searchMode").and_then(Value::as_str) != Some("doubao-app-ai-search")
            || object.get("policyVersion").and_then(Value::as_str) != Some(BASELINE_POLICY_VERSION)
            || object
                .get("configurationFingerprint")
                .and_then(Value::as_str)
                .map(|value| value.is_empty() || value.len() > 128)
                != Some(false)
        {
            return Err("geo_baseline_provider_snapshot_invalid".to_string());
        }
        let engine_id = object
            .get("engineId")
            .and_then(Value::as_str)
            .ok_or_else(|| "geo_baseline_provider_snapshot_invalid".to_string())?;
        if !allowed.contains(engine_id) || result.iter().any(|(id, _)| id == engine_id) {
            return Err("geo_baseline_provider_snapshot_invalid".to_string());
        }
        result.push((engine_id.to_string(), snapshot.clone()));
    }
    if result.len() != allowed.len() {
        return Err("geo_baseline_provider_snapshot_invalid".to_string());
    }
    Ok(result)
}

fn baseline_brand_names(
    connection: &Connection,
    workspace: &BrandWorkspace,
    knowledge_version: i64,
) -> Result<Vec<String>, String> {
    let mut names = vec![workspace.name.clone()];
    let mut statement = connection
        .prepare(
            "SELECT current.predicate, snapshot.normalized_value_json
             FROM knowledge_version_facts snapshot
             JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1
               AND (current.predicate LIKE '%.fullName' OR current.predicate LIKE '%.shortNames')",
        )
        .map_err(|error| format!("prepare baseline brand identifiers: {error}"))?;
    let rows = statement
        .query_map([knowledge_version], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("query baseline brand identifiers: {error}"))?;
    for row in rows {
        let (_predicate, raw) =
            row.map_err(|error| format!("read baseline brand identifiers: {error}"))?;
        let value: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        match value {
            Value::String(name) if !name.trim().is_empty() => names.push(name.trim().to_string()),
            Value::Array(values) => names.extend(
                values
                    .into_iter()
                    .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
                    .filter(|name| !name.is_empty()),
            ),
            _ => {}
        }
    }
    names.sort();
    names.dedup();
    Ok(names)
}

fn baseline_status(connection: &Connection, baseline_id: &str) -> Result<(String, String), String> {
    let (total, succeeded, failed, running): (i64, i64, i64, i64) = connection
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END)
             FROM geo_baseline_units WHERE baseline_id=?1",
            [baseline_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("aggregate baseline unit state: {error}"))?;
    if running > 0 {
        Ok(("running".to_string(), "baseline-running".to_string()))
    } else if total > 0 && succeeded == total {
        Ok(("succeeded".to_string(), "baseline-succeeded".to_string()))
    } else if succeeded > 0 && failed > 0 {
        Ok(("partial".to_string(), "baseline-partial".to_string()))
    } else {
        Ok(("failed".to_string(), "baseline-failed".to_string()))
    }
}

fn read_geo_baseline(
    connection: &Connection,
    workspace_id: &str,
    baseline_id: &str,
) -> Result<GeoBaselineProjection, String> {
    let mut projection = connection
        .query_row(
            "SELECT id, operation_id, created_by_session_id, question_pool_id,
                    question_pool_revision, knowledge_version, brand_names_json,
                    provider_snapshots_json, policy_version, status, created_at, updated_at
             FROM geo_baselines WHERE id=?1",
            [baseline_id],
            |row| {
                let brand_names: String = row.get(6)?;
                let snapshots: String = row.get(7)?;
                Ok(GeoBaselineProjection {
                    id: row.get(0)?,
                    operation_id: row.get(1)?,
                    workspace_id: workspace_id.to_string(),
                    created_by_session_id: row.get(2)?,
                    question_pool_id: row.get(3)?,
                    question_pool_revision: row.get(4)?,
                    knowledge_version: row.get(5)?,
                    brand_names: serde_json::from_str(&brand_names).unwrap_or_default(),
                    provider_snapshots: serde_json::from_str(&snapshots).unwrap_or(json!([])),
                    policy_version: row.get(8)?,
                    status: row.get(9)?,
                    metrics: empty_metrics(),
                    units: Vec::new(),
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read GEO baseline projection: {error}"))?
        .ok_or_else(|| "geo_baseline_not_found".to_string())?;
    let mut statement = connection
        .prepare("SELECT id FROM geo_baseline_units WHERE baseline_id=?1 ORDER BY question_id, engine_id")
        .map_err(|error| format!("prepare baseline evidence units: {error}"))?;
    let ids = statement
        .query_map([baseline_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("query baseline evidence units: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read baseline evidence unit ids: {error}"))?;
    projection.units = ids
        .iter()
        .map(|id| read_geo_baseline_unit(connection, id))
        .collect::<Result<Vec<_>, _>>()?;
    projection.metrics = metrics(&projection.units);
    Ok(projection)
}

fn read_geo_baseline_unit(
    connection: &Connection,
    unit_id: &str,
) -> Result<GeoBaselineEvidenceUnit, String> {
    let mut unit = connection
        .query_row(
            "SELECT id, question_id, question_text, engine_id, provider_snapshot_json,
                    status, attempt_number, raw_answer, raw_evidence_json, citations_json,
                    analysis_json, started_at, finished_at, duration_ms, error_code, error_message
             FROM geo_baseline_units WHERE id=?1",
            [unit_id],
            |row| {
                let snapshot: String = row.get(4)?;
                let raw_evidence: Option<String> = row.get(8)?;
                let citations: String = row.get(9)?;
                let analysis: Option<String> = row.get(10)?;
                Ok(GeoBaselineEvidenceUnit {
                    id: row.get(0)?,
                    question_id: row.get(1)?,
                    question: row.get(2)?,
                    engine_id: row.get(3)?,
                    provider_snapshot: serde_json::from_str(&snapshot).unwrap_or(Value::Null),
                    status: row.get(5)?,
                    attempt_number: row.get(6)?,
                    raw_answer: row.get(7)?,
                    raw_evidence: raw_evidence.and_then(|raw| serde_json::from_str(&raw).ok()),
                    citations: serde_json::from_str(&citations).unwrap_or(json!([])),
                    analysis: analysis.and_then(|raw| serde_json::from_str(&raw).ok()),
                    started_at: row.get(11)?,
                    finished_at: row.get(12)?,
                    duration_ms: row.get(13)?,
                    error_code: row.get(14)?,
                    error_message: row.get(15)?,
                    attempts: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|error| format!("read baseline evidence unit: {error}"))?
        .ok_or_else(|| "geo_baseline_unit_not_found".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT attempt_number, status, started_at, finished_at, duration_ms,
                    error_code, error_message FROM geo_baseline_attempts
             WHERE unit_id=?1 ORDER BY attempt_number",
        )
        .map_err(|error| format!("prepare baseline attempt history: {error}"))?;
    unit.attempts = statement
        .query_map([unit_id], |row| {
            Ok(GeoBaselineAttempt {
                attempt_number: row.get(0)?,
                status: row.get(1)?,
                started_at: row.get(2)?,
                finished_at: row.get(3)?,
                duration_ms: row.get(4)?,
                error_code: row.get(5)?,
                error_message: row.get(6)?,
            })
        })
        .map_err(|error| format!("query baseline attempt history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read baseline attempt history: {error}"))?;
    Ok(unit)
}

fn empty_metrics() -> GeoBaselineMetrics {
    GeoBaselineMetrics {
        total: 0,
        completed: 0,
        succeeded: 0,
        failed: 0,
        pending: 0,
        brand_mentioned: 0,
        brand_recommended: 0,
        with_citation_evidence: 0,
        mention_rate: None,
        recommendation_rate: None,
        citation_rate: None,
        evidence_unit_ids: GeoBaselineEvidenceIds {
            brand_mentioned: vec![],
            brand_recommended: vec![],
            with_citation_evidence: vec![],
            failed: vec![],
        },
    }
}

fn metrics(units: &[GeoBaselineEvidenceUnit]) -> GeoBaselineMetrics {
    let mut result = empty_metrics();
    result.total = units.len() as i64;
    for unit in units {
        match unit.status.as_str() {
            "succeeded" => {
                result.succeeded += 1;
                if unit
                    .analysis
                    .as_ref()
                    .and_then(|value| value.get("brandMentioned"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    result.brand_mentioned += 1;
                    result
                        .evidence_unit_ids
                        .brand_mentioned
                        .push(unit.id.clone());
                }
                if unit
                    .analysis
                    .as_ref()
                    .and_then(|value| value.get("brandRecommended"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    result.brand_recommended += 1;
                    result
                        .evidence_unit_ids
                        .brand_recommended
                        .push(unit.id.clone());
                }
                if unit
                    .analysis
                    .as_ref()
                    .and_then(|value| value.get("hasCitationEvidence"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    result.with_citation_evidence += 1;
                    result
                        .evidence_unit_ids
                        .with_citation_evidence
                        .push(unit.id.clone());
                }
            }
            "failed" => {
                result.failed += 1;
                result.evidence_unit_ids.failed.push(unit.id.clone());
            }
            _ => {}
        }
    }
    result.completed = result.succeeded + result.failed;
    result.pending = result.total - result.completed;
    if result.succeeded > 0 {
        result.mention_rate =
            Some((result.brand_mentioned * 100 + result.succeeded / 2) / result.succeeded);
        result.recommendation_rate =
            Some((result.brand_recommended * 100 + result.succeeded / 2) / result.succeeded);
        result.citation_rate =
            Some((result.with_citation_evidence * 100 + result.succeeded / 2) / result.succeeded);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn baseline_requires_confirmed_pool_and_retries_only_the_failed_unit() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store
            .create_workspace("鲸跃汽车", vec!["汽车音响".into()])
            .unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-09".into(),
                    title: "基线".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        seed_confirmed_pool(&brand);
        let request = GeoBaselinePrepareRequest {
            workspace_id: brand.id.clone(),
            session_id: "session-09".into(),
            question_pool_id: "pool-08".into(),
            engine_ids: vec!["doubao".into()],
            provider_snapshots: json!([snapshot()]),
            idempotency_key: "baseline-request-09".into(),
            policy_version: BASELINE_POLICY_VERSION.into(),
        };
        let prepared = store.prepare_geo_baseline(request.clone()).unwrap();
        assert_eq!(prepared.baseline.knowledge_version, 1);
        assert_eq!(prepared.baseline.question_pool_revision, 1);
        assert_eq!(prepared.baseline.units.len(), 2);
        assert_eq!(prepared.baseline.provider_snapshots, json!([snapshot()]));
        assert_eq!(
            store.prepare_geo_baseline(request).unwrap().baseline.id,
            prepared.baseline.id
        );

        let first = prepared.baseline.units[0].clone();
        let second = prepared.baseline.units[1].clone();
        let first_claim = store
            .claim_geo_baseline_unit(
                &brand.id,
                "session-09",
                GeoBaselineUnitClaimRequest {
                    baseline_id: prepared.baseline.id.clone(),
                    unit_id: first.id.clone(),
                },
            )
            .unwrap();
        store
            .finish_geo_baseline_unit(
                &brand.id,
                "session-09",
                success(
                    &prepared.baseline.id,
                    &first.id,
                    first_claim.claim_token.unwrap(),
                ),
            )
            .unwrap();
        let second_claim = store
            .claim_geo_baseline_unit(
                &brand.id,
                "session-09",
                GeoBaselineUnitClaimRequest {
                    baseline_id: prepared.baseline.id.clone(),
                    unit_id: second.id.clone(),
                },
            )
            .unwrap();
        store
            .finish_geo_baseline_unit(
                &brand.id,
                "session-09",
                failure(
                    &prepared.baseline.id,
                    &second.id,
                    second_claim.claim_token.unwrap(),
                ),
            )
            .unwrap();
        let partial = store
            .latest_geo_baseline(&brand.id, "session-09", GeoBaselineLatestRequest {})
            .unwrap()
            .unwrap();
        assert_eq!(partial.status, "partial");
        assert_eq!(partial.metrics.succeeded, 1);
        assert_eq!(partial.metrics.failed, 1);
        assert_eq!(
            partial.metrics.evidence_unit_ids.failed,
            vec![second.id.clone()]
        );
        assert_eq!(
            store
                .claim_geo_baseline_unit(
                    &brand.id,
                    "session-09",
                    GeoBaselineUnitClaimRequest {
                        baseline_id: partial.id.clone(),
                        unit_id: first.id,
                    },
                )
                .unwrap()
                .action,
            "cached"
        );

        let retry = store
            .claim_geo_baseline_unit(
                &brand.id,
                "session-09",
                GeoBaselineUnitClaimRequest {
                    baseline_id: partial.id.clone(),
                    unit_id: second.id.clone(),
                },
            )
            .unwrap();
        assert_eq!(retry.attempt_number, 2);
        store
            .finish_geo_baseline_unit(
                &brand.id,
                "session-09",
                success(&partial.id, &second.id, retry.claim_token.unwrap()),
            )
            .unwrap();
        let complete = store
            .latest_geo_baseline(&brand.id, "session-09", GeoBaselineLatestRequest {})
            .unwrap()
            .unwrap();
        assert_eq!(complete.status, "succeeded");
        assert_eq!(complete.units[1].attempts.len(), 2);

        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-10".into(),
                    title: "同品牌复核".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let exact = store
            .get_geo_baseline(
                &brand.id,
                "session-10",
                GeoBaselineGetRequest {
                    baseline_id: complete.id.clone(),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(exact.id, complete.id);

        let other_brand = store.create_workspace("另一品牌", vec![]).unwrap();
        store
            .commit_session(
                &other_brand.id,
                SessionCommit {
                    id: "session-other-brand".into(),
                    title: "隔离复核".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        assert!(store
            .get_geo_baseline(
                &other_brand.id,
                "session-other-brand",
                GeoBaselineGetRequest {
                    baseline_id: complete.id,
                },
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn empty_or_unproven_success_cannot_be_persisted() {
        let request = GeoBaselineUnitFinishRequest {
            baseline_id: "baseline".into(),
            unit_id: "unit".into(),
            claim_token: "claim".into(),
            status: "succeeded".into(),
            raw_answer: Some("".into()),
            raw_evidence: Some(json!({})),
            citations: Some(json!([])),
            analysis: Some(json!({})),
            duration_ms: 1,
            error_code: None,
            error_message: None,
        };
        assert_eq!(
            validate_finish(&request).unwrap_err(),
            "geo_baseline_success_evidence_required"
        );
    }

    fn snapshot() -> Value {
        json!({
            "engineId": "doubao",
            "provider": "volcengine",
            "capabilitySlot": "keyword-search",
            "model": "doubao-seed-2-0-lite-260428",
            "endpointFamily": "ark-responses",
            "searchMode": "doubao-app-ai-search",
            "configurationFingerprint": "test-config-fingerprint",
            "policyVersion": BASELINE_POLICY_VERSION,
        })
    }

    fn success(
        baseline_id: &str,
        unit_id: &str,
        claim_token: String,
    ) -> GeoBaselineUnitFinishRequest {
        GeoBaselineUnitFinishRequest {
            baseline_id: baseline_id.into(),
            unit_id: unit_id.into(),
            claim_token,
            status: "succeeded".into(),
            raw_answer: Some("推荐鲸跃汽车。".into()),
            raw_evidence: Some(json!({"output_text": "推荐鲸跃汽车。"})),
            citations: Some(
                json!([{"url": "https://example.cn", "provenance": "structured-provider"}]),
            ),
            analysis: Some(json!({
                "brandMentioned": true,
                "brandRecommended": true,
                "hasCitationEvidence": true
            })),
            duration_ms: 10,
            error_code: None,
            error_message: None,
        }
    }

    fn failure(
        baseline_id: &str,
        unit_id: &str,
        claim_token: String,
    ) -> GeoBaselineUnitFinishRequest {
        GeoBaselineUnitFinishRequest {
            baseline_id: baseline_id.into(),
            unit_id: unit_id.into(),
            claim_token,
            status: "failed".into(),
            raw_answer: None,
            raw_evidence: None,
            citations: None,
            analysis: None,
            duration_ms: 10,
            error_code: Some("geo_baseline_rate_limited".into()),
            error_message: Some("服务限流（HTTP 429）".into()),
        }
    }

    fn seed_confirmed_pool(brand: &BrandWorkspace) {
        let connection = open_database(brand).unwrap();
        // Seed only the immutable snapshot rows needed by this owner; foreign
        // keys require a real candidate/raw-input/decision lineage.
        connection.execute(
            "INSERT INTO knowledge_raw_inputs (id, session_id, input_text, origin, intent, created_at)
             VALUES ('raw-k', 'session-09', '品牌事实', 'user-stated', 'knowledge-update', 'now')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO knowledge_fact_candidates
                (id, raw_input_id, session_id, subject, predicate, scope_json, fact_key,
                 value_json, normalized_value_json, excerpt, confidence, origin, intent,
                 status, base_version, proposed_at, resolved_at)
             VALUES ('candidate-k', 'raw-k', 'session-09', '鲸跃汽车', 'enterprise-profile.fullName', '{}',
                     'brand-name', '\"鲸跃汽车\"', '\"鲸跃汽车\"', '品牌事实', 1,
                     'user-stated', 'knowledge-update', 'adopted', 0, 'now', 'now')",
            [],
        ).unwrap();
        connection.execute(
            "INSERT INTO knowledge_current_facts
                (fact_key, subject, predicate, scope_json, normalized_value_json, version,
                 confirmed_by, confirmed_at, updated_at)
             VALUES ('brand-name', '鲸跃汽车', 'enterprise-profile.fullName', '{}', '\"鲸跃汽车\"', 1,
                     'desktop-user', 'now', 'now')",
            [],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_decisions
                (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
                 before_json, after_json, reason, decided_at)
             VALUES ('decision-k', 'candidate-k', 'adopt-new', 'desktop-user', 'session-09', 0,
                     NULL, '{}', NULL, 'now')",
                [],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO knowledge_versions (version, decision_id, actor_session_id, snapshot_hash, created_at)
             VALUES (1, 'decision-k', 'session-09', 'hash', 'now')",
            [],
        ).unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_version_facts
                (knowledge_version, fact_key, fact_version, normalized_value_json, sources_json)
             VALUES (1, 'brand-name', 1, '\"鲸跃汽车\"', '[]')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
             VALUES ('operation-08', 'session-09', 'question-pool-confirmed', 'now')",
                [],
            )
            .unwrap();
        connection.execute(
            "INSERT INTO geo_question_pools
                (id, operation_id, created_by_session_id, knowledge_version, product_line,
                 target_region, generation_parameters_json, source_evidence_json, keywords_json,
                 questions_json, status, revision, created_at, updated_at)
             VALUES ('pool-08', 'operation-08', 'session-09', 1, '汽车音响', '成都', '{}', '[]', '[]',
                     '[]', 'confirmed', 1, 'now', 'now')",
            [],
        ).unwrap();
        let questions = json!([
            {"id": "q-1", "text": "成都汽车音响改装哪家好？", "selected": true},
            {"id": "q-2", "text": "成都汽车隔音怎么选？", "selected": true}
        ]);
        connection
            .execute(
                "INSERT INTO geo_question_pool_decisions
                (id, pool_id, session_id, decision, expected_revision, revision, questions_json,
                 selected_question_ids_json, actor_id, decided_at)
             VALUES ('decision-08', 'pool-08', 'session-09', 'confirm-selection', 0, 1, ?1,
                     '[\"q-1\",\"q-2\"]', 'desktop-user', 'now')",
                [canonical_json(&questions).unwrap()],
            )
            .unwrap();
    }
}
