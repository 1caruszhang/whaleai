use super::*;
use rusqlite::TransactionBehavior;
use serde_json::Value;

const STAGES: [&str; 4] = [
    "keyword-search",
    "question-generation",
    "embedding",
    "persist",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolPrepareRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub product_line: String,
    pub target_region: String,
    pub generation_parameters: Value,
    pub idempotency_key: String,
    #[serde(default = "default_true")]
    pub reuse_existing: bool,
    #[serde(default)]
    pub retry: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolKnowledgeFact {
    pub fact_key: String,
    pub subject: String,
    pub predicate: String,
    pub scope_json: String,
    pub normalized_value_json: String,
    pub unit: Option<String>,
    pub sources: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolLibraryKeyword {
    pub term: String,
    pub category: String,
    pub heat: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolKnowledgeContext {
    pub knowledge_version: i64,
    pub brand_name: String,
    pub product_lines: Vec<String>,
    pub facts: Vec<QuestionPoolKnowledgeFact>,
    pub recent_selected_questions: Vec<String>,
    /// 品牌词库（用户确认过的词，跨池复用；ADR-0006 修正三）。
    pub keyword_library: Vec<QuestionPoolLibraryKeyword>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolCheckpoint {
    pub stage: String,
    pub status: String,
    pub attempt_number: i64,
    pub billing_key: String,
    pub input_hash: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolProjection {
    pub id: String,
    pub attempt_id: Option<String>,
    pub operation_id: String,
    pub workspace_id: String,
    pub knowledge_version: i64,
    pub product_line: String,
    pub target_region: String,
    pub generation_parameters: Value,
    pub status: String,
    pub revision: i64,
    pub keywords: Value,
    pub questions: Value,
    pub source_evidence: Value,
    pub checkpoints: Vec<QuestionPoolCheckpoint>,
    pub reused: bool,
    pub derived_from_pool_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolAttempt {
    pub id: String,
    pub pool_id: String,
    pub state: String,
    pub current_stage: Option<String>,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolPreparation {
    pub kind: String,
    pub context: QuestionPoolKnowledgeContext,
    pub attempt: Option<QuestionPoolAttempt>,
    pub pool: QuestionPoolProjection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolStepClaimRequest {
    pub attempt_id: String,
    pub stage: String,
    pub input_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolStepClaim {
    pub action: String,
    pub claim_token: Option<String>,
    pub output: Option<Value>,
    pub attempt_number: i64,
    pub billing_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolStepFinishRequest {
    pub attempt_id: String,
    pub stage: String,
    pub claim_token: String,
    pub status: String,
    pub output: Option<Value>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolPersistRequest {
    pub attempt_id: String,
    pub keywords: Value,
    pub questions: Value,
    pub source_evidence: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolCancelRequest {
    pub attempt_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolLatestRequest {
    pub product_line: Option<String>,
    /// 聊天修订（票 38）解析目标：只取本 Session 最新的 awaiting-selection
    /// 池，跳过会排在普通 latest 前面的同版本 confirmed 池。
    #[serde(default)]
    pub pending_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolDecisionRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub pool_id: String,
    pub expected_revision: i64,
    pub questions: Value,
    pub selected_question_ids: Vec<String>,
    pub actor_id: String,
}

/// 聊天修订（ADR 0003，票 38）：Sidecar 转发的单条改/删/增指令。Node 侧已
/// 完成数组策略（applyQuestionPoolRevision），这里按 decide 同级校验落库。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolRevisionRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub pool_id: String,
    pub expected_revision: i64,
    pub action: String,
    pub target_kind: String,
    pub target_id: Option<String>,
    pub keywords: Value,
    pub questions: Value,
    pub actor_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionPoolDecisionResult {
    pub pool_id: String,
    pub decision_id: String,
    pub decision: String,
    pub expected_revision: i64,
    pub revision: i64,
    pub knowledge_version: i64,
    pub questions: Value,
    pub selected_question_ids: Vec<String>,
    pub actor_id: String,
    pub decided_at: String,
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_question_pools (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                product_line TEXT NOT NULL,
                target_region TEXT NOT NULL,
                generation_parameters_json TEXT NOT NULL,
                source_evidence_json TEXT NOT NULL DEFAULT '[]',
                keywords_json TEXT NOT NULL DEFAULT '[]',
                questions_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL CHECK(status IN ('generating','awaiting-selection','confirmed','failed','cancelled')),
                revision INTEGER NOT NULL DEFAULT 0,
                derived_from_pool_id TEXT REFERENCES geo_question_pools(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS geo_question_pool_identity
                ON geo_question_pools(knowledge_version, product_line, target_region, updated_at DESC);
             CREATE TABLE IF NOT EXISTS geo_question_pool_attempts (
                id TEXT PRIMARY KEY,
                pool_id TEXT NOT NULL REFERENCES geo_question_pools(id),
                session_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK(state IN ('running','awaiting-selection','confirmed','failed','cancelled')),
                current_stage TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS geo_question_pool_checkpoints (
                attempt_id TEXT NOT NULL REFERENCES geo_question_pool_attempts(id),
                stage TEXT NOT NULL CHECK(stage IN ('keyword-search','question-generation','embedding','persist')),
                status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
                attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
                claim_token TEXT,
                billing_key TEXT NOT NULL,
                input_hash TEXT NOT NULL,
                output_json TEXT,
                error_code TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                PRIMARY KEY(attempt_id, stage)
             );
             CREATE TABLE IF NOT EXISTS geo_question_pool_decisions (
                id TEXT PRIMARY KEY,
                pool_id TEXT NOT NULL REFERENCES geo_question_pools(id),
                session_id TEXT NOT NULL,
                decision TEXT NOT NULL CHECK(decision='confirm-selection'),
                expected_revision INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                questions_json TEXT NOT NULL,
                selected_question_ids_json TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                decided_at TEXT NOT NULL,
                UNIQUE(pool_id, revision)
             );
             CREATE TABLE IF NOT EXISTS geo_question_pool_revisions (
                id TEXT PRIMARY KEY,
                pool_id TEXT NOT NULL REFERENCES geo_question_pools(id),
                session_id TEXT NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('modify','delete','add')),
                target_kind TEXT NOT NULL CHECK(target_kind IN ('question','keyword')),
                target_id TEXT,
                before_json TEXT,
                after_json TEXT,
                actor_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                revised_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS brand_keyword_library (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                term TEXT NOT NULL,
                category TEXT NOT NULL CHECK(category IN ('core','scene','longtail')),
                heat TEXT NOT NULL CHECK(heat IN ('high','medium','low')),
                source_pool_id TEXT REFERENCES geo_question_pools(id),
                created_at TEXT NOT NULL,
                UNIQUE(workspace_id, term)
             );
             CREATE INDEX IF NOT EXISTS brand_keyword_library_terms
                ON brand_keyword_library(workspace_id, created_at);",
        )
        .map_err(|error| format!("initialize question pool schema: {error}"))?;
    // 接管所有权覆盖（ADR-0010）：NULL = 所有者即创建会话；接管后写入
    // 接管会话，awaiting-selection 池随之对当前所有者可裁决。创建审计不动。
    super::ensure_column(connection, "geo_question_pools", "owner_session_id", "TEXT")?;
    super::drop_brand_sessions_foreign_keys(
        connection,
        &[
            "geo_question_pools",
            "geo_question_pool_attempts",
            "geo_question_pool_decisions",
            "geo_question_pool_revisions",
        ],
    )
}

/// 所有权判定键（ADR-0010 改键）：问题池的当前所有者 =
/// `COALESCE(owner_session_id, created_by_session_id)`——接管只写覆盖列，
/// 创建审计不动。confirmed 池是跨会话品牌产物，判定与所有者无关。
pub(super) const QUESTION_POOL_OWNER_KEY: &str =
    "COALESCE(owner_session_id, created_by_session_id)";

/// 接管的同一事务内，把原所有者名下的 awaiting-selection 池整体转移给
/// 接管会话（只写覆盖列）：待决池随 operation 走、不拆分；confirmed 池
/// 是品牌产物，不转移。返回转移的池数。
pub(super) fn transfer_awaiting_selection_pools(
    transaction: &rusqlite::Transaction<'_>,
    previous_owner: &str,
    new_owner: &str,
) -> Result<i64, String> {
    transaction
        .execute(
            "UPDATE geo_question_pools SET owner_session_id=?1
             WHERE COALESCE(owner_session_id, created_by_session_id)=?2
               AND status='awaiting-selection'",
            params![new_owner, previous_owner],
        )
        .map(|changed| changed as i64)
        .map_err(|error| format!("transfer awaiting-selection pools: {error}"))
}

impl BrandWorkspaceStore {
    pub fn latest_valid_question_pool(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: QuestionPoolLatestRequest,
    ) -> Result<Option<QuestionPoolProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_question_pool_session(&connection, session_id)?;
        let knowledge_version: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM knowledge_versions",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("read current knowledge version: {error}"))?;
        if knowledge_version <= 0 {
            return Ok(None);
        }
        let product_line = request
            .product_line
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if product_line.is_some_and(|line| !workspace.product_lines.iter().any(|item| item == line))
        {
            return Err(format!(
                "question_pool_product_line_unknown（「{}」不是已确认的产品线；合法产品线：{}）",
                product_line.unwrap_or_default(),
                workspace.product_lines.join("、")
            ));
        }
        let pool_id: Option<String> = if request.pending_only {
            connection
                .query_row(
                    &format!(
                        "SELECT id FROM geo_question_pools
                         WHERE knowledge_version=?1 AND status='awaiting-selection'
                           AND {QUESTION_POOL_OWNER_KEY}=?3
                           AND (?2 IS NULL OR product_line=?2)
                         ORDER BY updated_at DESC, id DESC
                         LIMIT 1"
                    ),
                    params![knowledge_version, product_line, session_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("read latest valid question pool: {error}"))?
        } else {
            connection
                .query_row(
                    &format!(
                        "SELECT id FROM geo_question_pools
                         WHERE knowledge_version=?1 AND status IN ('awaiting-selection','confirmed')
                           AND (?2 IS NULL OR product_line=?2)
                           AND (status='confirmed' OR {QUESTION_POOL_OWNER_KEY}=?3)
                         ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, updated_at DESC, id DESC
                         LIMIT 1"
                    ),
                    params![knowledge_version, product_line, session_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("read latest valid question pool: {error}"))?
        };
        pool_id
            .map(|pool_id| read_question_pool(&connection, workspace_id, &pool_id, true))
            .transpose()
    }

    pub fn prepare_question_pool(
        &self,
        request: QuestionPoolPrepareRequest,
    ) -> Result<QuestionPoolPreparation, String> {
        validate_question_pool_prepare(&request)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, &request.session_id)?;
        let context = read_question_pool_context(
            &connection,
            &workspace,
            &request.product_line,
            &request.target_region,
        )?;
        let parameters_json = canonical_json(&request.generation_parameters)?;

        if let Some(attempt) = read_attempt_by_key(&connection, &request.idempotency_key)? {
            let attempt_session: String = connection
                .query_row(
                    "SELECT session_id FROM geo_question_pool_attempts WHERE id=?1",
                    [&attempt.id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("read question pool attempt owner: {error}"))?;
            if attempt_session != request.session_id {
                return Err("question_pool_identity_mismatch".to_string());
            }
            let pool = read_question_pool(&connection, &workspace.id, &attempt.pool_id, false)?;
            if pool.knowledge_version != context.knowledge_version
                || pool.product_line != request.product_line.trim()
                || pool.target_region != request.target_region.trim()
                || canonical_json(&pool.generation_parameters)? != parameters_json
            {
                return Err("question_pool_idempotency_conflict".to_string());
            }
            if request.retry {
                if pool.status == "confirmed" {
                    return Err("question_pool_confirmed_immutable".to_string());
                }
                connection
                    .execute(
                        "UPDATE geo_question_pool_attempts SET state='running', updated_at=?2 WHERE id=?1",
                        params![attempt.id, Utc::now().to_rfc3339()],
                    )
                    .map_err(|error| format!("resume question pool attempt: {error}"))?;
            }
            let attempt = read_attempt_by_key(&connection, &request.idempotency_key)?
                .ok_or_else(|| "question_pool_attempt_not_found".to_string())?;
            let pool = read_question_pool(&connection, &workspace.id, &attempt.pool_id, false)?;
            return Ok(QuestionPoolPreparation {
                kind: "attempt".to_string(),
                context,
                attempt: Some(attempt),
                pool,
            });
        }

        if request.reuse_existing {
            if let Some(pool_id) = connection
                .query_row(
                    &format!(
                        "SELECT id FROM geo_question_pools
                         WHERE knowledge_version=?1 AND product_line=?2 AND target_region=?3
                           AND generation_parameters_json=?4
                           AND status IN ('awaiting-selection','confirmed')
                           AND (status='confirmed' OR {QUESTION_POOL_OWNER_KEY}=?5)
                         ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, updated_at DESC, id DESC
                         LIMIT 1"
                    ),
                    params![
                        context.knowledge_version,
                        request.product_line.trim(),
                        request.target_region.trim(),
                        parameters_json,
                        request.session_id
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| format!("find reusable question pool: {error}"))?
            {
                let pool = read_question_pool(&connection, &workspace.id, &pool_id, true)?;
                return Ok(QuestionPoolPreparation {
                    kind: "reused".to_string(),
                    context,
                    attempt: None,
                    pool,
                });
            }
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool transaction: {error}"))?;
        let operation_id = Uuid::new_v4().to_string();
        let pool_id = Uuid::new_v4().to_string();
        let attempt_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES (?1, ?2, 'question-pool-generating', ?3)",
                params![operation_id, request.session_id, now],
            )
            .map_err(|error| format!("create question pool operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_artifacts (id, operation_id, session_id, kind, knowledge_version, created_at)
                 VALUES (?1, ?2, ?3, 'question-pool', ?4, ?5)",
                params![pool_id, operation_id, request.session_id, context.knowledge_version, now],
            )
            .map_err(|error| format!("create question pool artifact: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_question_pools
                    (id, operation_id, created_by_session_id, knowledge_version, product_line,
                     target_region, generation_parameters_json, status, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'generating', 0, ?8, ?8)",
                params![
                    pool_id,
                    operation_id,
                    request.session_id,
                    context.knowledge_version,
                    request.product_line.trim(),
                    request.target_region.trim(),
                    parameters_json,
                    now
                ],
            )
            .map_err(|error| format!("create question pool: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_question_pool_attempts
                    (id, pool_id, session_id, idempotency_key, state, current_stage, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'running', NULL, ?5, ?5)",
                params![attempt_id, pool_id, request.session_id, request.idempotency_key, now],
            )
            .map_err(|error| format!("create question pool attempt: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit question pool preparation: {error}"))?;
        let attempt = read_attempt_by_key(&connection, &request.idempotency_key)?
            .ok_or_else(|| "question_pool_attempt_not_found".to_string())?;
        let pool = read_question_pool(&connection, &workspace.id, &pool_id, false)?;
        Ok(QuestionPoolPreparation {
            kind: "attempt".to_string(),
            context,
            attempt: Some(attempt),
            pool,
        })
    }

    pub fn claim_question_pool_step(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: QuestionPoolStepClaimRequest,
    ) -> Result<QuestionPoolStepClaim, String> {
        validate_stage(&request.stage)?;
        validate_hash(&request.input_hash)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool step claim: {error}"))?;
        let (attempt_session, attempt_state, pool_id): (String, String, String) = transaction
            .query_row(
                "SELECT session_id, state, pool_id FROM geo_question_pool_attempts WHERE id=?1",
                [&request.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read question pool attempt: {error}"))?
            .ok_or_else(|| "question_pool_attempt_not_found".to_string())?;
        if attempt_session != session_id {
            return Err("question_pool_identity_mismatch".to_string());
        }
        if matches!(attempt_state.as_str(), "cancelled" | "confirmed") {
            return Err(format!("question_pool_attempt_{attempt_state}"));
        }
        let has_decision: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM geo_question_pool_decisions WHERE pool_id=?1",
                [&pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect confirmed question pool: {error}"))?;
        if has_decision > 0 {
            return Err("question_pool_confirmed_immutable".to_string());
        }
        let stage_index = STAGES
            .iter()
            .position(|stage| *stage == request.stage)
            .ok_or_else(|| "question_pool_stage_invalid".to_string())?;
        if stage_index > 0 {
            let previous = STAGES[stage_index - 1];
            let previous_status: Option<String> = transaction
                .query_row(
                    "SELECT status FROM geo_question_pool_checkpoints WHERE attempt_id=?1 AND stage=?2",
                    params![request.attempt_id, previous],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("read previous question pool checkpoint: {error}"))?;
            if previous_status.as_deref() != Some("completed") {
                return Err(format!(
                    "question_pool_previous_stage_incomplete:{previous}"
                ));
            }
        }
        let existing: Option<(String, i64, String, Option<String>, String)> = transaction
            .query_row(
                "SELECT status, attempt_number, input_hash, output_json, billing_key
                 FROM geo_question_pool_checkpoints WHERE attempt_id=?1 AND stage=?2",
                params![request.attempt_id, request.stage],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read question pool checkpoint: {error}"))?;
        if let Some((status, attempt_number, input_hash, output_json, billing_key)) =
            existing.as_ref()
        {
            if input_hash != &request.input_hash {
                return Err("question_pool_checkpoint_input_conflict".to_string());
            }
            if status == "completed" {
                let output = output_json
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()
                    .map_err(|error| format!("parse checkpoint output: {error}"))?;
                transaction
                    .commit()
                    .map_err(|error| format!("commit cached step claim: {error}"))?;
                return Ok(QuestionPoolStepClaim {
                    action: "cached".to_string(),
                    claim_token: None,
                    output,
                    attempt_number: *attempt_number,
                    billing_key: billing_key.clone(),
                });
            }
            if status == "running" {
                return Ok(QuestionPoolStepClaim {
                    action: "busy".to_string(),
                    claim_token: None,
                    output: None,
                    attempt_number: *attempt_number,
                    billing_key: billing_key.clone(),
                });
            }
        }
        let next_attempt = existing
            .as_ref()
            .map_or(1, |(_, number, _, _, _)| number + 1);
        let billing_key = existing
            .as_ref()
            .map(|(_, _, _, _, key)| key.clone())
            .unwrap_or_else(|| format!("{}:{}", request.attempt_id, request.stage));
        let claim_token = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_question_pool_checkpoints
                    (attempt_id, stage, status, attempt_number, claim_token, billing_key,
                     input_hash, output_json, error_code, started_at, finished_at)
                 VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, NULL, NULL, ?7, NULL)
                 ON CONFLICT(attempt_id, stage) DO UPDATE SET
                    status='running', attempt_number=excluded.attempt_number,
                    claim_token=excluded.claim_token, error_code=NULL,
                    started_at=excluded.started_at, finished_at=NULL",
                params![
                    request.attempt_id,
                    request.stage,
                    next_attempt,
                    claim_token,
                    billing_key,
                    request.input_hash,
                    now
                ],
            )
            .map_err(|error| format!("claim question pool checkpoint: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_question_pool_attempts SET state='running', current_stage=?2, updated_at=?3 WHERE id=?1",
                params![request.attempt_id, request.stage, now],
            )
            .map_err(|error| format!("advance question pool attempt: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit question pool step claim: {error}"))?;
        Ok(QuestionPoolStepClaim {
            action: "execute".to_string(),
            claim_token: Some(claim_token),
            output: None,
            attempt_number: next_attempt,
            billing_key,
        })
    }

    pub fn finish_question_pool_step(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: QuestionPoolStepFinishRequest,
    ) -> Result<QuestionPoolCheckpoint, String> {
        validate_stage(&request.stage)?;
        if !matches!(
            request.status.as_str(),
            "completed" | "failed" | "cancelled"
        ) {
            return Err("question_pool_step_status_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool step finish: {error}"))?;
        let attempt_session: String = transaction
            .query_row(
                "SELECT session_id FROM geo_question_pool_attempts WHERE id=?1",
                [&request.attempt_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read question pool attempt: {error}"))?
            .ok_or_else(|| "question_pool_attempt_not_found".to_string())?;
        if attempt_session != session_id {
            return Err("question_pool_identity_mismatch".to_string());
        }
        let output_json = request.output.as_ref().map(canonical_json).transpose()?;
        let changed = transaction
            .execute(
                "UPDATE geo_question_pool_checkpoints
                 SET status=?4, output_json=?5, error_code=?6, finished_at=?7, claim_token=NULL
                 WHERE attempt_id=?1 AND stage=?2 AND claim_token=?3 AND status='running'",
                params![
                    request.attempt_id,
                    request.stage,
                    request.claim_token,
                    request.status,
                    output_json,
                    request.error_code,
                    Utc::now().to_rfc3339()
                ],
            )
            .map_err(|error| format!("finish question pool checkpoint: {error}"))?;
        if changed != 1 {
            return Err("question_pool_checkpoint_cas_conflict".to_string());
        }
        if request.status != "completed" {
            transaction
                .execute(
                    "UPDATE geo_question_pool_attempts SET state=?2, updated_at=?3 WHERE id=?1",
                    params![request.attempt_id, request.status, Utc::now().to_rfc3339()],
                )
                .map_err(|error| format!("mark question pool attempt terminal: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit question pool checkpoint: {error}"))?;
        read_checkpoint(&connection, &request.attempt_id, &request.stage)
    }

    pub fn persist_question_pool(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: QuestionPoolPersistRequest,
    ) -> Result<QuestionPoolProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool persist: {error}"))?;
        let (pool_id, attempt_session): (String, String) = transaction
            .query_row(
                "SELECT pool_id, session_id FROM geo_question_pool_attempts WHERE id=?1",
                [&request.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read question pool attempt: {error}"))?
            .ok_or_else(|| "question_pool_attempt_not_found".to_string())?;
        if attempt_session != session_id {
            return Err("question_pool_identity_mismatch".to_string());
        }
        let has_decision: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM geo_question_pool_decisions WHERE pool_id=?1",
                [&pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect question pool decisions: {error}"))?;
        if has_decision > 0 {
            return Err("question_pool_confirmed_immutable".to_string());
        }
        let embedding_complete: Option<String> = transaction
            .query_row(
                "SELECT status FROM geo_question_pool_checkpoints WHERE attempt_id=?1 AND stage='embedding'",
                [&request.attempt_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read embedding checkpoint: {error}"))?;
        if embedding_complete.as_deref() != Some("completed") {
            return Err("question_pool_embedding_incomplete".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let keywords = canonical_json(&request.keywords)?;
        let questions = canonical_json(&request.questions)?;
        let source_evidence = canonical_json(&request.source_evidence)?;
        transaction
            .execute(
                "UPDATE geo_question_pools
                 SET keywords_json=?2, questions_json=?3, source_evidence_json=?4,
                     status='awaiting-selection', updated_at=?5 WHERE id=?1",
                params![pool_id, keywords, questions, source_evidence, now],
            )
            .map_err(|error| format!("persist question pool artifact: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_question_pool_attempts
                 SET state='awaiting-selection', current_stage='persist', updated_at=?2 WHERE id=?1",
                params![request.attempt_id, now],
            )
            .map_err(|error| format!("finish question pool attempt: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state='question-pool-awaiting-selection'
                 WHERE id=(SELECT operation_id FROM geo_question_pools WHERE id=?1)",
                [&pool_id],
            )
            .map_err(|error| format!("advance question pool operation: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit question pool artifact: {error}"))?;
        read_question_pool(&connection, &workspace.id, &pool_id, false)
    }

    pub fn cancel_question_pool_attempt(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: QuestionPoolCancelRequest,
    ) -> Result<QuestionPoolProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool cancellation: {error}"))?;
        let (pool_id, attempt_session): (String, String) = transaction
            .query_row(
                "SELECT pool_id, session_id FROM geo_question_pool_attempts WHERE id=?1",
                [&request.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read question pool attempt: {error}"))?
            .ok_or_else(|| "question_pool_attempt_not_found".to_string())?;
        if attempt_session != session_id {
            return Err("question_pool_identity_mismatch".to_string());
        }
        let has_decision: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM geo_question_pool_decisions WHERE pool_id=?1",
                [&pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect question pool decisions: {error}"))?;
        if has_decision > 0 {
            return Err("question_pool_confirmed_immutable".to_string());
        }
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "UPDATE geo_question_pool_attempts SET state='cancelled', updated_at=?2 WHERE id=?1",
                params![request.attempt_id, now],
            )
            .map_err(|error| format!("cancel question pool attempt: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_question_pool_checkpoints
                 SET status='cancelled', error_code='question_pool_cancelled', finished_at=?2, claim_token=NULL
                 WHERE attempt_id=?1 AND status='running'",
                params![request.attempt_id, now],
            )
            .map_err(|error| format!("cancel question pool checkpoint: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_question_pools SET status='cancelled', updated_at=?2 WHERE id=?1",
                params![pool_id, now],
            )
            .map_err(|error| format!("cancel question pool artifact: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit question pool cancellation: {error}"))?;
        read_question_pool(&connection, &workspace.id, &pool_id, false)
    }

    pub fn decide_question_pool(
        &self,
        request: QuestionPoolDecisionRequest,
    ) -> Result<QuestionPoolDecisionResult, String> {
        validate_session_id(&request.session_id)?;
        if request.actor_id != "desktop-user" {
            return Err("question_pool_actor_invalid".to_string());
        }
        validate_decision_payload(&request.questions, &request.selected_question_ids)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, &request.session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool decision: {error}"))?;
        let (revision, status, operation_id, knowledge_version, owner_session_id, keywords_json): (
            i64,
            String,
            String,
            i64,
            String,
            String,
        ) = transaction
            .query_row(
                &format!(
                    "SELECT revision, status, operation_id, knowledge_version,
                            {QUESTION_POOL_OWNER_KEY}, keywords_json
                     FROM geo_question_pools WHERE id=?1"
                ),
                [&request.pool_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read question pool: {error}"))?
            .ok_or_else(|| "question_pool_not_found".to_string())?;
        if owner_session_id != request.session_id {
            return Err("question_pool_identity_mismatch".to_string());
        }
        if !matches!(status.as_str(), "awaiting-selection" | "confirmed") {
            return Err("question_pool_not_selectable".to_string());
        }
        if revision != request.expected_revision {
            return Err("question_pool_revision_conflict".to_string());
        }
        let decision_id = Uuid::new_v4().to_string();
        let next_revision = revision + 1;
        let now = Utc::now().to_rfc3339();
        let questions_json = canonical_json(&request.questions)?;
        let selected_json = canonical_json(&request.selected_question_ids)?;
        transaction
            .execute(
                "INSERT INTO geo_question_pool_decisions
                    (id, pool_id, session_id, decision, expected_revision, revision,
                     questions_json, selected_question_ids_json, actor_id, decided_at)
                 VALUES (?1, ?2, ?3, 'confirm-selection', ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    decision_id,
                    request.pool_id,
                    request.session_id,
                    revision,
                    next_revision,
                    questions_json,
                    selected_json,
                    request.actor_id,
                    now
                ],
            )
            .map_err(|error| format!("store question pool decision: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_question_pools SET status='confirmed', revision=?2, updated_at=?3
                 WHERE id=?1 AND revision=?4",
                params![request.pool_id, next_revision, now, revision],
            )
            .map_err(|error| format!("confirm question pool: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_question_pool_attempts SET state='confirmed', updated_at=?2 WHERE pool_id=?1",
                params![request.pool_id, now],
            )
            .map_err(|error| format!("confirm question pool attempt: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state='question-pool-confirmed' WHERE id=?1",
                [operation_id],
            )
            .map_err(|error| format!("confirm question pool operation: {error}"))?;
        persist_keywords_to_library(
            &transaction,
            &workspace.id,
            &request.pool_id,
            &keywords_json,
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit question pool decision: {error}"))?;
        Ok(QuestionPoolDecisionResult {
            pool_id: request.pool_id,
            decision_id,
            decision: "confirm-selection".to_string(),
            expected_revision: revision,
            revision: next_revision,
            knowledge_version,
            questions: request.questions,
            selected_question_ids: request.selected_question_ids,
            actor_id: request.actor_id,
            decided_at: now,
        })
    }

    /// 聊天修订（ADR 0003，票 38）：仅作用于本 Session 的 awaiting-selection
    /// 待决池。modify/delete/add 均由 Node 侧算好新词库/问题数组后整组落库
    /// （与 decide 信任边界同构），这里做形状校验、身份/状态/CAS 栅栏，并按
    /// 条写 geo_question_pool_revisions 审计（含用户指令原文 reason）。
    pub fn revise_question_pool(
        &self,
        request: QuestionPoolRevisionRequest,
    ) -> Result<QuestionPoolProjection, String> {
        validate_session_id(&request.session_id)?;
        if request.actor_id != "desktop-user" {
            return Err("question_pool_actor_invalid".to_string());
        }
        if request.reason.trim().is_empty() {
            return Err(
                "question pool revision requires the user's explicit instruction".to_string(),
            );
        }
        if !matches!(request.action.as_str(), "modify" | "delete" | "add") {
            return Err("question_pool_revision_action_invalid".to_string());
        }
        if !matches!(request.target_kind.as_str(), "question" | "keyword") {
            return Err("question_pool_revision_target_invalid".to_string());
        }
        if matches!(request.action.as_str(), "modify" | "delete")
            && request
                .target_id
                .as_deref()
                .map(str::trim)
                .is_none_or(|value| value.is_empty())
        {
            return Err("question_pool_revision_target_required".to_string());
        }
        validate_revision_payload(&request.keywords, &request.questions)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_question_pool_session(&connection, &request.session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start question pool revision: {error}"))?;
        let (revision, status, keywords_json, questions_json, owner_session_id): (
            i64,
            String,
            String,
            String,
            String,
        ) = transaction
            .query_row(
                &format!(
                    "SELECT revision, status, keywords_json, questions_json,
                            {QUESTION_POOL_OWNER_KEY}
                     FROM geo_question_pools WHERE id=?1"
                ),
                [&request.pool_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read question pool for revision: {error}"))?
            .ok_or_else(|| "question_pool_not_found".to_string())?;
        if owner_session_id != request.session_id {
            return Err("question_pool_identity_mismatch".to_string());
        }
        let has_decision: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM geo_question_pool_decisions WHERE pool_id=?1",
                [&request.pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect question pool decisions: {error}"))?;
        if has_decision > 0 || status == "confirmed" {
            return Err("question_pool_confirmed_immutable".to_string());
        }
        if status != "awaiting-selection" {
            return Err("question_pool_not_selectable".to_string());
        }
        if revision != request.expected_revision {
            return Err("question_pool_revision_conflict".to_string());
        }
        let next_revision = revision + 1;
        let now = Utc::now().to_rfc3339();
        let next_keywords_json = canonical_json(&request.keywords)?;
        let next_questions_json = canonical_json(&request.questions)?;
        transaction
            .execute(
                "INSERT INTO geo_question_pool_revisions
                    (id, pool_id, session_id, action, target_kind, target_id,
                     before_json, after_json, actor_id, reason, revised_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    Uuid::new_v4().to_string(),
                    request.pool_id,
                    request.session_id,
                    request.action,
                    request.target_kind,
                    request.target_id,
                    serde_json::json!({
                        "keywords": serde_json::from_str::<Value>(&keywords_json)
                            .unwrap_or(Value::Null),
                        "questions": serde_json::from_str::<Value>(&questions_json)
                            .unwrap_or(Value::Null),
                    })
                    .to_string(),
                    serde_json::json!({
                        "keywords": request.keywords,
                        "questions": request.questions,
                    })
                    .to_string(),
                    request.actor_id,
                    request.reason,
                    now
                ],
            )
            .map_err(|error| format!("audit question pool revision: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_question_pools
                 SET keywords_json=?2, questions_json=?3, revision=?4, updated_at=?5
                 WHERE id=?1 AND revision=?6 AND status='awaiting-selection'",
                params![
                    request.pool_id,
                    next_keywords_json,
                    next_questions_json,
                    next_revision,
                    now,
                    revision
                ],
            )
            .map_err(|error| format!("apply question pool revision: {error}"))?;
        if changed != 1 {
            return Err("question_pool_revision_conflict".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("commit question pool revision: {error}"))?;
        read_question_pool(&connection, &workspace.id, &request.pool_id, false)
    }
}

fn validate_question_pool_prepare(request: &QuestionPoolPrepareRequest) -> Result<(), String> {
    validate_session_id(&request.session_id)?;
    if request.product_line.trim().is_empty() || request.product_line.chars().count() > 80 {
        return Err("question_pool_product_line_required".to_string());
    }
    if request.target_region.trim().is_empty() || request.target_region.chars().count() > 80 {
        return Err("question_pool_target_region_required".to_string());
    }
    if request.idempotency_key.trim().is_empty() || request.idempotency_key.len() > 160 {
        return Err("question_pool_idempotency_key_invalid".to_string());
    }
    if !request.generation_parameters.is_object() {
        return Err("question_pool_generation_parameters_invalid".to_string());
    }
    Ok(())
}

fn validate_stage(stage: &str) -> Result<(), String> {
    if STAGES.contains(&stage) {
        Ok(())
    } else {
        Err("question_pool_stage_invalid".to_string())
    }
}

fn validate_hash(value: &str) -> Result<(), String> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("question_pool_input_hash_invalid".to_string())
    }
}

fn canonical_json<T: ?Sized + Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("serialize question pool JSON: {error}"))
}

fn require_question_pool_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM brand_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("validate question pool session: {error}"))?;
    if exists == 1 {
        Ok(())
    } else {
        Err("question_pool_session_not_committed".to_string())
    }
}

fn read_question_pool_context(
    connection: &Connection,
    workspace: &BrandWorkspace,
    product_line: &str,
    target_region: &str,
) -> Result<QuestionPoolKnowledgeContext, String> {
    if !workspace
        .product_lines
        .iter()
        .any(|line| line == product_line.trim())
    {
        // 带上合法产品线清单，让 Agent 一次自纠即命中（questionErrorCode 按
        // 「question_pool_」前缀截取错误码，中文括号不破坏码提取）。
        return Err(format!(
            "question_pool_product_line_unknown（「{}」不是已确认的产品线；合法产品线：{}）",
            product_line.trim(),
            workspace.product_lines.join("、")
        ));
    }
    let version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM knowledge_versions",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("read current knowledge version: {error}"))?;
    if version <= 0 {
        return Err("question_pool_knowledge_version_missing".to_string());
    }
    let mut statement = connection
        .prepare(
            "SELECT snapshot.fact_key, current.subject, current.predicate, current.scope_json,
                    snapshot.normalized_value_json, snapshot.unit, snapshot.sources_json
             FROM knowledge_version_facts snapshot
             JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1 ORDER BY snapshot.fact_key",
        )
        .map_err(|error| format!("prepare question pool knowledge context: {error}"))?;
    let facts = statement
        .query_map([version], |row| {
            let sources_json: String = row.get(6)?;
            Ok(QuestionPoolKnowledgeFact {
                fact_key: row.get(0)?,
                subject: row.get(1)?,
                predicate: row.get(2)?,
                scope_json: row.get(3)?,
                normalized_value_json: row.get(4)?,
                unit: row.get(5)?,
                sources: serde_json::from_str(&sources_json).unwrap_or(Value::Array(vec![])),
            })
        })
        .map_err(|error| format!("query question pool knowledge context: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read question pool knowledge context: {error}"))?;
    if facts.is_empty() {
        return Err("question_pool_knowledge_snapshot_empty".to_string());
    }
    let recent_selected_questions =
        read_recent_selected_questions(connection, product_line.trim(), target_region.trim())?;
    let keyword_library = read_keyword_library(connection, &workspace.id)?;
    Ok(QuestionPoolKnowledgeContext {
        knowledge_version: version,
        brand_name: workspace.name.clone(),
        product_lines: workspace.product_lines.clone(),
        facts,
        recent_selected_questions,
        keyword_library,
    })
}

fn read_keyword_library(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Vec<QuestionPoolLibraryKeyword>, String> {
    let mut statement = connection
        .prepare(
            "SELECT term, category, heat FROM brand_keyword_library
             WHERE workspace_id=?1 ORDER BY created_at, term",
        )
        .map_err(|error| format!("prepare keyword library read: {error}"))?;
    let library = statement
        .query_map([workspace_id], |row| {
            Ok(QuestionPoolLibraryKeyword {
                term: row.get(0)?,
                category: row.get(1)?,
                heat: row.get(2)?,
            })
        })
        .map_err(|error| format!("query keyword library: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read keyword library: {error}"))?;
    Ok(library)
}

/// 池确认时把本批词沉淀进品牌词库（池型合并只增不清；ADR-0006 修正三：
/// 用户闸门确认后才复用——未裁决的词不是品牌资产）。
fn persist_keywords_to_library(
    transaction: &Connection,
    workspace_id: &str,
    pool_id: &str,
    keywords_json: &str,
    now: &str,
) -> Result<(), String> {
    let keywords: Value = serde_json::from_str(keywords_json)
        .map_err(|error| format!("parse pool keywords for library: {error}"))?;
    let Some(entries) = keywords.as_array() else {
        return Ok(());
    };
    for entry in entries {
        let (term, category, heat) = (
            entry.get("term").and_then(Value::as_str),
            entry.get("category").and_then(Value::as_str),
            entry.get("heat").and_then(Value::as_str),
        );
        let (Some(term), Some(category), Some(heat)) = (term, category, heat) else {
            continue;
        };
        if !matches!(category, "core" | "scene" | "longtail")
            || !matches!(heat, "high" | "medium" | "low")
            || term.trim().is_empty()
        {
            continue;
        }
        transaction
            .execute(
                "INSERT OR IGNORE INTO brand_keyword_library
                    (id, workspace_id, term, category, heat, source_pool_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    Uuid::new_v4().to_string(),
                    workspace_id,
                    term.trim(),
                    category,
                    heat,
                    pool_id,
                    now
                ],
            )
            .map_err(|error| format!("persist keyword to library: {error}"))?;
    }
    Ok(())
}

fn read_recent_selected_questions(
    connection: &Connection,
    product_line: &str,
    target_region: &str,
) -> Result<Vec<String>, String> {
    let questions_json: Option<String> = connection
        .query_row(
            "SELECT decision.questions_json
             FROM geo_question_pool_decisions decision
             JOIN geo_question_pools pool ON pool.id=decision.pool_id
             WHERE pool.product_line=?1 AND pool.target_region=?2
             ORDER BY decision.decided_at DESC, decision.revision DESC LIMIT 1",
            params![product_line, target_region],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read recent selected question pool: {error}"))?;
    let Some(raw) = questions_json else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("parse recent selected question pool: {error}"))?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter(|question| question.get("selected").and_then(Value::as_bool) == Some(true))
        .filter_map(|question| question.get("text").and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

fn read_attempt_by_key(
    connection: &Connection,
    idempotency_key: &str,
) -> Result<Option<QuestionPoolAttempt>, String> {
    connection
        .query_row(
            "SELECT id, pool_id, state, current_stage, idempotency_key
             FROM geo_question_pool_attempts WHERE idempotency_key=?1",
            [idempotency_key],
            |row| {
                Ok(QuestionPoolAttempt {
                    id: row.get(0)?,
                    pool_id: row.get(1)?,
                    state: row.get(2)?,
                    current_stage: row.get(3)?,
                    idempotency_key: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read question pool attempt: {error}"))
}

fn read_question_pool(
    connection: &Connection,
    workspace_id: &str,
    pool_id: &str,
    reused: bool,
) -> Result<QuestionPoolProjection, String> {
    let mut pool = connection
        .query_row(
            "SELECT id, operation_id, knowledge_version, product_line, target_region,
                    generation_parameters_json, status, revision, keywords_json, questions_json,
                    source_evidence_json, derived_from_pool_id, created_at, updated_at
             FROM geo_question_pools WHERE id=?1",
            [pool_id],
            |row| {
                let parameters: String = row.get(5)?;
                let keywords: String = row.get(8)?;
                let questions: String = row.get(9)?;
                let evidence: String = row.get(10)?;
                Ok(QuestionPoolProjection {
                    id: row.get(0)?,
                    attempt_id: None,
                    operation_id: row.get(1)?,
                    workspace_id: workspace_id.to_string(),
                    knowledge_version: row.get(2)?,
                    product_line: row.get(3)?,
                    target_region: row.get(4)?,
                    generation_parameters: serde_json::from_str(&parameters).unwrap_or(Value::Null),
                    status: row.get(6)?,
                    revision: row.get(7)?,
                    keywords: serde_json::from_str(&keywords).unwrap_or(Value::Array(vec![])),
                    questions: serde_json::from_str(&questions).unwrap_or(Value::Array(vec![])),
                    source_evidence: serde_json::from_str(&evidence)
                        .unwrap_or(Value::Array(vec![])),
                    checkpoints: Vec::new(),
                    reused,
                    derived_from_pool_id: row.get(11)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read question pool: {error}"))?
        .ok_or_else(|| "question_pool_not_found".to_string())?;
    let attempt_id: Option<String> = connection
        .query_row(
            "SELECT id FROM geo_question_pool_attempts WHERE pool_id=?1 ORDER BY created_at DESC LIMIT 1",
            [pool_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read question pool attempt identity: {error}"))?;
    if let Some(attempt_id) = attempt_id {
        pool.checkpoints = read_checkpoints(connection, &attempt_id)?;
        pool.attempt_id = Some(attempt_id);
    }
    let latest_decision: Option<(String, String)> = connection
        .query_row(
            "SELECT questions_json, selected_question_ids_json
             FROM geo_question_pool_decisions WHERE pool_id=?1
             ORDER BY revision DESC LIMIT 1",
            [pool_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("read latest question pool decision: {error}"))?;
    if let Some((questions, _selected)) = latest_decision {
        pool.questions = serde_json::from_str(&questions)
            .map_err(|error| format!("parse latest question pool decision: {error}"))?;
    }
    Ok(pool)
}

fn read_checkpoints(
    connection: &Connection,
    attempt_id: &str,
) -> Result<Vec<QuestionPoolCheckpoint>, String> {
    let mut statement = connection
        .prepare(
            "SELECT stage, status, attempt_number, billing_key, input_hash, error_code
             FROM geo_question_pool_checkpoints WHERE attempt_id=?1
             ORDER BY CASE stage
                WHEN 'keyword-search' THEN 1 WHEN 'question-generation' THEN 2
                WHEN 'embedding' THEN 3 ELSE 4 END",
        )
        .map_err(|error| format!("prepare question pool checkpoints: {error}"))?;
    let checkpoints = statement
        .query_map([attempt_id], |row| {
            Ok(QuestionPoolCheckpoint {
                stage: row.get(0)?,
                status: row.get(1)?,
                attempt_number: row.get(2)?,
                billing_key: row.get(3)?,
                input_hash: row.get(4)?,
                error_code: row.get(5)?,
            })
        })
        .map_err(|error| format!("query question pool checkpoints: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read question pool checkpoints: {error}"))?;
    Ok(checkpoints)
}

fn read_checkpoint(
    connection: &Connection,
    attempt_id: &str,
    stage: &str,
) -> Result<QuestionPoolCheckpoint, String> {
    read_checkpoints(connection, attempt_id)?
        .into_iter()
        .find(|checkpoint| checkpoint.stage == stage)
        .ok_or_else(|| "question_pool_checkpoint_not_found".to_string())
}

fn validate_question_entries(
    questions: &Value,
) -> Result<std::collections::HashSet<String>, String> {
    let list = questions
        .as_array()
        .ok_or_else(|| "question_pool_questions_invalid".to_string())?;
    if list.is_empty() || list.len() > 50 {
        return Err("question_pool_questions_invalid".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for question in list {
        let id = question
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "question_pool_question_id_invalid".to_string())?;
        let text = question
            .get("text")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.chars().count() <= 500)
            .ok_or_else(|| "question_pool_question_text_invalid".to_string())?;
        let _ = text;
        if !ids.insert(id.to_string()) {
            return Err("question_pool_question_id_duplicate".to_string());
        }
    }
    Ok(ids)
}

fn validate_decision_payload(
    questions: &Value,
    selected_question_ids: &[String],
) -> Result<(), String> {
    let ids = validate_question_entries(questions)?;
    if selected_question_ids.is_empty()
        || selected_question_ids.len() > ids.len()
        || selected_question_ids.iter().any(|id| !ids.contains(id))
    {
        return Err("question_pool_selection_invalid".to_string());
    }
    Ok(())
}

/// 修订载荷校验（与 decide 同级）：问题沿用 1-50 条与逐条 id/text 规则，
/// 词库要求逐条 id/term 合法且不重复。
fn validate_revision_payload(keywords: &Value, questions: &Value) -> Result<(), String> {
    validate_question_entries(questions)?;
    let list = keywords
        .as_array()
        .ok_or_else(|| "question_pool_keywords_invalid".to_string())?;
    let mut ids = std::collections::HashSet::new();
    for keyword in list {
        let id = keyword
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "question_pool_keyword_id_invalid".to_string())?;
        let term = keyword
            .get("term")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty() && value.chars().count() <= 120)
            .ok_or_else(|| "question_pool_keyword_term_invalid".to_string())?;
        let _ = term;
        if !ids.insert(id.to_string()) {
            return Err("question_pool_keyword_id_duplicate".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup() -> (BrandWorkspaceStore, BrandWorkspace) {
        let root = tempdir().unwrap().keep();
        let store = BrandWorkspaceStore::at(root.join("Xiaojing"));
        let workspace = store
            .create_workspace("鲸跃", vec!["汽车音响".to_string()])
            .unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-08".to_string(),
                    title: "问题池".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-other".to_string(),
                    title: "另一个会话".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        seed_knowledge(&workspace, 1, "汽车改装");
        (store, workspace)
    }

    fn seed_knowledge(workspace: &BrandWorkspace, version: i64, value: &str) {
        let connection = open_database(workspace).unwrap();
        let now = Utc::now().to_rfc3339();
        let raw_input_id = format!("raw-{version}");
        let candidate_id = format!("candidate-{version}");
        let decision_id = format!("decision-{version}");
        connection
            .execute(
                "INSERT INTO knowledge_raw_inputs
                    (id, session_id, input_text, origin, intent, created_at)
                 VALUES (?1, 'session-08', ?2, 'user-stated', 'knowledge-update', ?3)",
                params![raw_input_id, value, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_fact_candidates
                    (id, raw_input_id, session_id, subject, predicate, scope_json, fact_key,
                     value_json, normalized_value_json, excerpt, confidence, profile_provenance,
                     origin, intent, status, base_version, proposed_at, resolved_at)
                 VALUES (?1, ?2, 'session-08', '鲸跃', 'enterprise-profile.industry', '{}',
                         'industry', ?3, ?3, ?4, 1.0, 'asked', 'user-stated',
                         'knowledge-update', 'adopted', ?5, ?4, ?4)",
                params![
                    candidate_id,
                    raw_input_id,
                    serde_json::to_string(value).unwrap(),
                    now,
                    version - 1
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_decisions
                    (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
                     before_json, after_json, reason, decided_at)
                 VALUES (?1, ?2, 'adopt-new', 'desktop-user', 'session-08', ?3,
                         NULL, ?4, 'question pool test fixture', ?5)",
                params![
                    decision_id,
                    candidate_id,
                    version - 1,
                    serde_json::to_string(value).unwrap(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_current_facts
                    (fact_key, subject, predicate, scope_json, normalized_value_json, unit,
                     version, confirmed_by, confirmed_at, updated_at)
                 VALUES ('industry', '鲸跃', 'enterprise-profile.industry', '{}', ?1, NULL,
                         ?2, 'desktop-user', ?3, ?3)
                 ON CONFLICT(fact_key) DO UPDATE SET normalized_value_json=excluded.normalized_value_json,
                    version=excluded.version, updated_at=excluded.updated_at",
                params![
                    serde_json::to_string(value).unwrap(),
                    version,
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_versions (version, decision_id, actor_session_id, snapshot_hash, created_at)
                 VALUES (?1, ?2, 'session-08', ?3, ?4)",
                params![version, decision_id, format!("hash-{version}"), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_version_facts
                    (knowledge_version, fact_key, fact_version, normalized_value_json, unit, sources_json)
                 VALUES (?1, 'industry', ?1, ?2, NULL, '[]')",
                params![version, serde_json::to_string(value).unwrap()],
            )
            .unwrap();
    }

    fn prepare(
        store: &BrandWorkspaceStore,
        workspace: &BrandWorkspace,
        key: &str,
    ) -> QuestionPoolPreparation {
        store
            .prepare_question_pool(QuestionPoolPrepareRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                product_line: "汽车音响".to_string(),
                target_region: "成都".to_string(),
                generation_parameters: serde_json::json!({"policyVersion":"js-ai-dev-pred-1-v1"}),
                idempotency_key: key.to_string(),
                reuse_existing: true,
                retry: false,
            })
            .unwrap()
    }

    fn complete_step(
        store: &BrandWorkspaceStore,
        workspace: &BrandWorkspace,
        attempt_id: &str,
        stage: &str,
    ) -> QuestionPoolStepClaim {
        let claim = store
            .claim_question_pool_step(
                &workspace.id,
                "session-08",
                QuestionPoolStepClaimRequest {
                    attempt_id: attempt_id.to_string(),
                    stage: stage.to_string(),
                    input_hash: "a".repeat(64),
                },
            )
            .unwrap();
        store
            .finish_question_pool_step(
                &workspace.id,
                "session-08",
                QuestionPoolStepFinishRequest {
                    attempt_id: attempt_id.to_string(),
                    stage: stage.to_string(),
                    claim_token: claim.claim_token.clone().unwrap(),
                    status: "completed".to_string(),
                    output: Some(serde_json::json!({"stage":stage})),
                    error_code: None,
                },
            )
            .unwrap();
        claim
    }

    #[test]
    fn chat_revision_touches_only_pending_pools_and_audits_the_verbatim_instruction() {
        let (store, workspace) = setup();
        let prepared = prepare(&store, &workspace, "revise-08");
        let attempt_id = prepared.attempt.unwrap().id;
        for stage in ["keyword-search", "question-generation", "embedding"] {
            complete_step(&store, &workspace, &attempt_id, stage);
        }
        let pending = store
            .persist_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolPersistRequest {
                    attempt_id,
                    keywords: serde_json::json!([
                        {"id":"kw-1","term":"成都汽车改装","category":"core","heat":"high","platform":"doubao"},
                        {"id":"kw-2","term":"成都汽车隔音","category":"scene","heat":"medium","platform":"doubao"}
                    ]),
                    questions: serde_json::json!([
                        {"id":"q-1","text":"成都汽车改装哪家好？","selected":true}
                    ]),
                    source_evidence: serde_json::json!([]),
                },
            )
            .unwrap();
        assert_eq!(pending.status, "awaiting-selection");

        // 跨 Session 修订被拒。
        assert_eq!(
            store
                .revise_question_pool(QuestionPoolRevisionRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-other".to_string(),
                    pool_id: pending.id.clone(),
                    expected_revision: pending.revision,
                    action: "delete".to_string(),
                    target_kind: "keyword".to_string(),
                    target_id: Some("kw-2".to_string()),
                    keywords: pending.keywords.clone(),
                    questions: pending.questions.clone(),
                    actor_id: "desktop-user".to_string(),
                    reason: "删掉第二个搜索词".to_string(),
                })
                .unwrap_err(),
            "question_pool_identity_mismatch"
        );

        // 合法 modify：词库更新、revision 递增、状态保持待决。
        let next_questions = serde_json::json!([
            {"id":"q-1","text":"成都汽车改装哪家靠谱？","selected":true},
            {"id":"q-user-1","text":"成都贴隐形车衣多少钱？","selected":false}
        ]);
        let revised = store
            .revise_question_pool(QuestionPoolRevisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: pending.id.clone(),
                expected_revision: pending.revision,
                action: "add".to_string(),
                target_kind: "question".to_string(),
                target_id: None,
                keywords: pending.keywords.clone(),
                questions: next_questions,
                actor_id: "desktop-user".to_string(),
                reason: "补一个价格问题".to_string(),
            })
            .unwrap();
        assert_eq!(revised.status, "awaiting-selection");
        assert_eq!(revised.revision, pending.revision + 1);
        assert_eq!(revised.questions.as_array().unwrap().len(), 2);

        // 逐条审计携带用户指令原文。
        let connection = open_database(&workspace).unwrap();
        let (audit_count, audit_reason, audit_action): (i64, String, String) = connection
            .query_row(
                "SELECT COUNT(*), MAX(reason), MAX(action) FROM geo_question_pool_revisions
                 WHERE pool_id=?1",
                [&pending.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(audit_count, 1);
        assert_eq!(audit_reason, "补一个价格问题");
        assert_eq!(audit_action, "add");

        // 旧 revision CAS 冲突。
        assert_eq!(
            store
                .revise_question_pool(QuestionPoolRevisionRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-08".to_string(),
                    pool_id: pending.id.clone(),
                    expected_revision: pending.revision,
                    action: "delete".to_string(),
                    target_kind: "question".to_string(),
                    target_id: Some("q-user-1".to_string()),
                    keywords: pending.keywords.clone(),
                    questions: revised.questions.clone(),
                    actor_id: "desktop-user".to_string(),
                    reason: "删掉刚才加的".to_string(),
                })
                .unwrap_err(),
            "question_pool_revision_conflict"
        );

        // 裁决后的池不可再修订。
        store
            .decide_question_pool(QuestionPoolDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: pending.id.clone(),
                expected_revision: revised.revision,
                questions: revised.questions.clone(),
                selected_question_ids: vec!["q-1".to_string()],
                actor_id: "desktop-user".to_string(),
            })
            .unwrap();
        assert_eq!(
            store
                .revise_question_pool(QuestionPoolRevisionRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-08".to_string(),
                    pool_id: pending.id.clone(),
                    expected_revision: revised.revision,
                    action: "modify".to_string(),
                    target_kind: "question".to_string(),
                    target_id: Some("q-1".to_string()),
                    keywords: pending.keywords.clone(),
                    questions: revised.questions.clone(),
                    actor_id: "desktop-user".to_string(),
                    reason: "改已确认的问题".to_string(),
                })
                .unwrap_err(),
            "question_pool_confirmed_immutable"
        );
    }

    #[test]
    fn confirmed_keywords_persist_to_brand_library_and_return_in_context() {
        let (store, workspace) = setup();
        let prepared = prepare(&store, &workspace, "library-08");
        let attempt_id = prepared.attempt.unwrap().id;
        for stage in ["keyword-search", "question-generation", "embedding"] {
            complete_step(&store, &workspace, &attempt_id, stage);
        }
        let pending = store
            .persist_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolPersistRequest {
                    attempt_id,
                    keywords: serde_json::json!([
                        {"id":"kw-1","term":"成都汽车改装","category":"core","heat":"high","platform":"doubao"},
                        {"id":"kw-2","term":"成都汽车隔音","category":"scene","heat":"medium","platform":"doubao"},
                        {"id":"kw-3","term":"废词","category":"unknown","heat":"high","platform":"doubao"}
                    ]),
                    questions: serde_json::json!([
                        {"id":"q-1","text":"成都汽车改装哪家好？","selected":true}
                    ]),
                    source_evidence: serde_json::json!([]),
                },
            )
            .unwrap();

        // 确认前：词库为空——未裁决的词不是品牌资产（ADR-0006 修正三）。
        let before = prepare(&store, &workspace, "library-before");
        assert!(before.context.keyword_library.is_empty());

        store
            .decide_question_pool(QuestionPoolDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: pending.id.clone(),
                expected_revision: pending.revision,
                questions: pending.questions.clone(),
                selected_question_ids: vec!["q-1".to_string()],
                actor_id: "desktop-user".to_string(),
            })
            .unwrap();

        // 确认后：合法词入库（非法 category 被跳过）；重挖 prepare 返回词库。
        let after = prepare(&store, &workspace, "library-after");
        let terms: Vec<&str> = after
            .context
            .keyword_library
            .iter()
            .map(|keyword| keyword.term.as_str())
            .collect();
        assert_eq!(terms, vec!["成都汽车改装", "成都汽车隔音"]);
    }

    #[test]
    fn pending_only_latest_resolves_the_shadowed_awaiting_pool() {
        let (store, workspace) = setup();
        let prepared = prepare(&store, &workspace, "shadow-08");
        let attempt_id = prepared.attempt.unwrap().id;
        for stage in ["keyword-search", "question-generation", "embedding"] {
            complete_step(&store, &workspace, &attempt_id, stage);
        }
        let first = store
            .persist_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolPersistRequest {
                    attempt_id,
                    keywords: serde_json::json!([{"id":"kw-1","term":"成都汽车改装"}]),
                    questions: serde_json::json!([
                        {"id":"q-1","text":"成都汽车改装哪家好？","selected":true}
                    ]),
                    source_evidence: serde_json::json!([]),
                },
            )
            .unwrap();
        store
            .decide_question_pool(QuestionPoolDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: first.id.clone(),
                expected_revision: first.revision,
                questions: first.questions.clone(),
                selected_question_ids: vec!["q-1".to_string()],
                actor_id: "desktop-user".to_string(),
            })
            .unwrap();

        // 同 Session 再有一个 awaiting 池（如跨产品线并行挖掘）时，普通
        // latest 会被排在前面的 confirmed 池遮蔽，pending_only 必须解析到
        // 本 Session 的待决池。
        let connection = open_database(&workspace).unwrap();
        connection
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES ('operation-shadow', 'session-08', 'question-pool-awaiting', '2026-08-16T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_question_pools
                    (id, operation_id, created_by_session_id, knowledge_version, product_line,
                     target_region, generation_parameters_json, source_evidence_json,
                     keywords_json, questions_json, status, revision, created_at, updated_at)
                 VALUES ('pool-shadow', 'operation-shadow', 'session-08', 1, '汽车音响', '成都',
                         '{\"policyVersion\":\"js-ai-dev-pred-1-v1\"}', '[]',
                         '[{\"id\":\"kw-1\",\"term\":\"成都汽车改装\"}]',
                         '[{\"id\":\"q-1\",\"text\":\"成都汽车改装哪家好？\",\"selected\":true},
                           {\"id\":\"q-2\",\"text\":\"成都汽车隔音多少钱？\",\"selected\":false}]',
                         'awaiting-selection', 0, '2026-08-16T00:00:00Z', '2026-08-16T01:00:00Z')",
                [],
            )
            .unwrap();
        let second = store
            .latest_valid_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolLatestRequest {
                    product_line: None,
                    pending_only: true,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(second.id, "pool-shadow");
        // 普通 latest 仍优先返回 confirmed 池（卡片水合语义不变）。
        let plain_latest = store
            .latest_valid_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolLatestRequest {
                    product_line: None,
                    pending_only: false,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(plain_latest.id, first.id);

        // 修订落在待决池上，confirmed 池不受影响。
        let revised = store
            .revise_question_pool(QuestionPoolRevisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: second.id.clone(),
                expected_revision: second.revision,
                action: "delete".to_string(),
                target_kind: "question".to_string(),
                target_id: Some("q-2".to_string()),
                keywords: second.keywords.clone(),
                questions: serde_json::json!([
                    {"id":"q-1","text":"成都汽车改装哪家好？","selected":true}
                ]),
                actor_id: "desktop-user".to_string(),
                reason: "删掉隔音问题".to_string(),
            })
            .unwrap();
        assert_eq!(revised.id, second.id);
        assert_eq!(revised.revision, second.revision + 1);
    }

    #[test]
    fn pool_identity_binds_version_product_region_parameters_and_reuses_only_valid_pool() {
        let (store, workspace) = setup();
        let first = prepare(&store, &workspace, "attempt-08");
        assert_eq!(first.context.knowledge_version, 1);
        assert_eq!(first.pool.product_line, "汽车音响");
        assert_eq!(first.pool.target_region, "成都");
        let attempt_id = first.attempt.unwrap().id;
        for stage in ["keyword-search", "question-generation", "embedding"] {
            complete_step(&store, &workspace, &attempt_id, stage);
        }
        let pending = store
            .persist_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolPersistRequest {
                    attempt_id,
                    keywords: serde_json::json!([{"term":"成都汽车改装"}]),
                    questions: serde_json::json!([{"id":"q1","text":"成都汽车改装哪家好","selected":true}]),
                    source_evidence: serde_json::json!([{"kind":"knowledge-fact","reference":"industry","excerpt":"汽车改装"}]),
                },
            )
            .unwrap();
        assert!(store
            .latest_valid_question_pool(
                &workspace.id,
                "session-other",
                QuestionPoolLatestRequest {
                    product_line: Some("汽车音响".to_string()),
                    pending_only: false,
                },
            )
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .prepare_question_pool(QuestionPoolPrepareRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-other".to_string(),
                    product_line: "汽车音响".to_string(),
                    target_region: "成都".to_string(),
                    generation_parameters: serde_json::json!({"policyVersion":"js-ai-dev-pred-1-v1"}),
                    idempotency_key: "attempt-08".to_string(),
                    reuse_existing: true,
                    retry: false,
                })
                .unwrap_err(),
            "question_pool_identity_mismatch"
        );
        let questions = pending.questions.clone();
        assert_eq!(
            store
                .decide_question_pool(QuestionPoolDecisionRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-other".to_string(),
                    pool_id: pending.id.clone(),
                    expected_revision: pending.revision,
                    questions: questions.clone(),
                    selected_question_ids: vec!["q1".to_string()],
                    actor_id: "desktop-user".to_string(),
                })
                .unwrap_err(),
            "question_pool_identity_mismatch"
        );
        store
            .decide_question_pool(QuestionPoolDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: pending.id,
                expected_revision: pending.revision,
                questions,
                selected_question_ids: vec!["q1".to_string()],
                actor_id: "desktop-user".to_string(),
            })
            .unwrap();
        assert!(store
            .latest_valid_question_pool(
                &workspace.id,
                "session-other",
                QuestionPoolLatestRequest {
                    product_line: Some("汽车音响".to_string()),
                    pending_only: false,
                },
            )
            .unwrap()
            .is_some());
        let reused = prepare(&store, &workspace, "attempt-08-next");
        assert_eq!(reused.kind, "reused");
        assert!(reused.pool.reused);

        seed_knowledge(&workspace, 2, "新能源汽车改装");
        let invalidated = prepare(&store, &workspace, "attempt-08-v2");
        assert_eq!(invalidated.kind, "attempt");
        assert_eq!(invalidated.context.knowledge_version, 2);
        assert_ne!(invalidated.pool.id, reused.pool.id);
    }

    #[test]
    fn checkpoints_are_same_attempt_idempotent_and_retry_only_the_failed_stage() {
        let (store, workspace) = setup();
        let prepared = prepare(&store, &workspace, "checkpoint-08");
        let attempt_id = prepared.attempt.unwrap().id;
        let first = complete_step(&store, &workspace, &attempt_id, "keyword-search");
        let cached = store
            .claim_question_pool_step(
                &workspace.id,
                "session-08",
                QuestionPoolStepClaimRequest {
                    attempt_id: attempt_id.clone(),
                    stage: "keyword-search".to_string(),
                    input_hash: "a".repeat(64),
                },
            )
            .unwrap();
        assert_eq!(cached.action, "cached");
        assert_eq!(cached.billing_key, first.billing_key);
        assert_eq!(cached.attempt_number, 1);

        let failed = store
            .claim_question_pool_step(
                &workspace.id,
                "session-08",
                QuestionPoolStepClaimRequest {
                    attempt_id: attempt_id.clone(),
                    stage: "question-generation".to_string(),
                    input_hash: "b".repeat(64),
                },
            )
            .unwrap();
        store
            .finish_question_pool_step(
                &workspace.id,
                "session-08",
                QuestionPoolStepFinishRequest {
                    attempt_id: attempt_id.clone(),
                    stage: "question-generation".to_string(),
                    claim_token: failed.claim_token.unwrap(),
                    status: "failed".to_string(),
                    output: None,
                    error_code: Some("provider_failed".to_string()),
                },
            )
            .unwrap();
        let retry = store
            .claim_question_pool_step(
                &workspace.id,
                "session-08",
                QuestionPoolStepClaimRequest {
                    attempt_id,
                    stage: "question-generation".to_string(),
                    input_hash: "b".repeat(64),
                },
            )
            .unwrap();
        assert_eq!(retry.action, "execute");
        assert_eq!(retry.attempt_number, 2);
        assert_eq!(retry.billing_key, failed.billing_key);
    }

    #[test]
    fn cancellation_and_confirmation_are_cas_guarded_and_confirmed_output_is_immutable() {
        let (store, workspace) = setup();
        let cancelled = prepare(&store, &workspace, "cancel-08");
        let cancelled_pool = store
            .cancel_question_pool_attempt(
                &workspace.id,
                "session-08",
                QuestionPoolCancelRequest {
                    attempt_id: cancelled.attempt.unwrap().id,
                },
            )
            .unwrap();
        assert_eq!(cancelled_pool.status, "cancelled");

        let prepared = prepare(&store, &workspace, "confirm-08");
        let attempt_id = prepared.attempt.unwrap().id;
        for stage in ["keyword-search", "question-generation", "embedding"] {
            complete_step(&store, &workspace, &attempt_id, stage);
        }
        let pool = store
            .persist_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolPersistRequest {
                    attempt_id: attempt_id.clone(),
                    keywords: serde_json::json!([{"term":"成都汽车改装"}]),
                    questions: serde_json::json!([{"id":"q1","text":"原问题","selected":true}]),
                    source_evidence: serde_json::json!([]),
                },
            )
            .unwrap();
        let decision = store
            .decide_question_pool(QuestionPoolDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: pool.id,
                expected_revision: 0,
                questions: serde_json::json!([{"id":"q1","text":"用户编辑的问题","selected":true}]),
                selected_question_ids: vec!["q1".to_string()],
                actor_id: "desktop-user".to_string(),
            })
            .unwrap();
        assert_eq!(decision.revision, 1);
        assert!(store
            .persist_question_pool(
                &workspace.id,
                "session-08",
                QuestionPoolPersistRequest {
                    attempt_id,
                    keywords: serde_json::json!([]),
                    questions: serde_json::json!([]),
                    source_evidence: serde_json::json!([]),
                },
            )
            .unwrap_err()
            .contains("confirmed_immutable"));
        assert!(store
            .decide_question_pool(QuestionPoolDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-08".to_string(),
                pool_id: decision.pool_id,
                expected_revision: 0,
                questions: serde_json::json!([{"id":"q1","text":"迟到覆盖","selected":true}]),
                selected_question_ids: vec!["q1".to_string()],
                actor_id: "desktop-user".to_string(),
            })
            .unwrap_err()
            .contains("revision_conflict"));
    }
}
