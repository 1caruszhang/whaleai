use super::*;
use rusqlite::{params, TransactionBehavior};
use sha2::{Digest, Sha256};

const OPTIMISTIC_CONFLICT: &str = "knowledge_version_conflict";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFactKey {
    pub subject: String,
    pub predicate: String,
    pub scope_json: String,
    pub effective_from: Option<String>,
    pub effective_to: Option<String>,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSourceInput {
    pub material_id: Option<String>,
    pub excerpt: String,
    pub confidence: f64,
    pub profile_provenance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCurrentFact {
    pub key: KnowledgeFactKey,
    pub normalized_value_json: String,
    pub unit: Option<String>,
    pub version: i64,
    pub confirmed_by: String,
    pub confirmed_at: String,
    pub sources: Vec<KnowledgeFactSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeFactSource {
    pub raw_input_id: String,
    pub material_id: Option<String>,
    pub excerpt: String,
    pub confidence: f64,
    pub profile_provenance: Option<String>,
    pub origin: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCandidateSubmission {
    pub workspace_id: String,
    pub session_id: String,
    pub raw_input: String,
    pub origin: String,
    pub intent: String,
    pub key: KnowledgeFactKey,
    pub value_json: String,
    pub normalized_value_json: String,
    pub unit: Option<String>,
    pub source: KnowledgeSourceInput,
    pub expected_current_version: i64,
    pub disposition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCandidate {
    pub id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub key: KnowledgeFactKey,
    pub value_json: String,
    pub normalized_value_json: String,
    pub unit: Option<String>,
    pub source: KnowledgeSourceInput,
    pub origin: String,
    pub intent: String,
    pub status: String,
    pub base_version: i64,
    pub proposed_at: String,
    pub current: Option<KnowledgeCurrentFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDecisionRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub candidate_id: String,
    pub decision: String,
    pub expected_current_version: i64,
    pub actor_id: String,
    pub reason: Option<String>,
    pub split_key: Option<KnowledgeFactKey>,
    pub split_expected_version: Option<i64>,
    pub edited_normalized_value_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDecisionResult {
    pub candidate_id: String,
    pub fact_key: String,
    pub decision: String,
    pub status: String,
    pub current: Option<KnowledgeCurrentFact>,
    pub knowledge_version: Option<i64>,
    pub affected_artifacts: Vec<GeoArtifactFreshnessProjection>,
    /// 方案 D：采纳「行业」事实时新同步进品牌产品线的领域，供前端提示。
    #[serde(default)]
    pub product_line_sync: Option<Vec<String>>,
}

/// 聊天修订（ADR 0003）：仅作用于未决候选的改/删/增。`knowledge_decisions`
/// 每候选仅一条且只收录五类裁决，修订审计走独立的
/// `knowledge_candidate_revisions` 表（同一候选可修订多次）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRevisionRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub action: String,
    pub candidate_id: Option<String>,
    pub actor_id: String,
    /// 用户显式指令原文（逐字引用）；add 动作同时充当 raw input。
    pub reason: String,
    pub value_json: Option<String>,
    pub normalized_value_json: Option<String>,
    pub unit: Option<String>,
    /// add 动作的完整候选载荷，复用 submit 校验与去重语义。
    pub submission: Option<KnowledgeCandidateSubmission>,
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS knowledge_raw_inputs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                input_text TEXT NOT NULL,
                origin TEXT NOT NULL CHECK(origin IN ('user-stated', 'model-inferred')),
                intent TEXT NOT NULL CHECK(intent IN ('knowledge-update', 'chat-observation')),
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS knowledge_fact_candidates (
                id TEXT PRIMARY KEY,
                raw_input_id TEXT NOT NULL REFERENCES knowledge_raw_inputs(id),
                session_id TEXT NOT NULL,
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                effective_from TEXT,
                effective_to TEXT,
                fact_key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                normalized_value_json TEXT NOT NULL,
                unit TEXT,
                material_id TEXT,
                excerpt TEXT NOT NULL,
                confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
                profile_provenance TEXT CHECK(profile_provenance IN ('extracted', 'asked', 'inferred')),
                origin TEXT NOT NULL CHECK(origin IN ('user-stated', 'model-inferred')),
                intent TEXT NOT NULL CHECK(intent IN ('knowledge-update', 'chat-observation')),
                status TEXT NOT NULL CHECK(status IN ('awaiting-confirmation', 'conflict', 'adopted', 'kept-current', 'split-scope', 'rejected')),
                base_version INTEGER NOT NULL CHECK(base_version >= 0),
                proposed_at TEXT NOT NULL,
                resolved_at TEXT
             );
             CREATE INDEX IF NOT EXISTS knowledge_candidates_pending
                ON knowledge_fact_candidates(status, fact_key, proposed_at);
             CREATE TABLE IF NOT EXISTS knowledge_current_facts (
                fact_key TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                effective_from TEXT,
                effective_to TEXT,
                normalized_value_json TEXT NOT NULL,
                unit TEXT,
                version INTEGER NOT NULL CHECK(version > 0),
                confirmed_by TEXT NOT NULL,
                confirmed_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS knowledge_fact_versions (
                id TEXT PRIMARY KEY,
                fact_key TEXT NOT NULL,
                version INTEGER NOT NULL CHECK(version > 0),
                subject TEXT NOT NULL,
                predicate TEXT NOT NULL,
                scope_json TEXT NOT NULL,
                effective_from TEXT,
                effective_to TEXT,
                normalized_value_json TEXT NOT NULL,
                unit TEXT,
                confirmed_by TEXT NOT NULL,
                confirmed_at TEXT NOT NULL,
                superseded_at TEXT NOT NULL,
                superseded_by_candidate_id TEXT NOT NULL,
                UNIQUE(fact_key, version)
             );
             CREATE TABLE IF NOT EXISTS knowledge_fact_sources (
                id TEXT PRIMARY KEY,
                fact_key TEXT NOT NULL,
                fact_version INTEGER NOT NULL,
                candidate_id TEXT NOT NULL,
                raw_input_id TEXT NOT NULL REFERENCES knowledge_raw_inputs(id),
                material_id TEXT,
                excerpt TEXT NOT NULL,
                confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
                profile_provenance TEXT CHECK(profile_provenance IN ('extracted', 'asked', 'inferred')),
                origin TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(fact_key, fact_version, raw_input_id, excerpt)
             );
             CREATE TABLE IF NOT EXISTS knowledge_decisions (
                id TEXT PRIMARY KEY,
                candidate_id TEXT NOT NULL UNIQUE REFERENCES knowledge_fact_candidates(id),
                decision TEXT NOT NULL CHECK(decision IN ('keep-current', 'adopt-new', 'adopt-edited', 'split-scope', 'reject-candidate')),
                actor_id TEXT NOT NULL,
                actor_session_id TEXT NOT NULL,
                expected_version INTEGER NOT NULL,
                before_json TEXT,
                after_json TEXT,
                reason TEXT,
                decided_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS knowledge_candidate_revisions (
                id TEXT PRIMARY KEY,
                candidate_id TEXT NOT NULL REFERENCES knowledge_fact_candidates(id),
                action TEXT NOT NULL CHECK(action IN ('modify', 'delete', 'add')),
                actor_id TEXT NOT NULL,
                actor_session_id TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                reason TEXT NOT NULL,
                revised_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS knowledge_candidate_revisions_candidate
                ON knowledge_candidate_revisions(candidate_id, revised_at);
             CREATE TABLE IF NOT EXISTS knowledge_versions (
                version INTEGER PRIMARY KEY,
                decision_id TEXT NOT NULL UNIQUE REFERENCES knowledge_decisions(id),
                actor_session_id TEXT NOT NULL,
                snapshot_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS knowledge_version_facts (
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                fact_key TEXT NOT NULL,
                fact_version INTEGER NOT NULL,
                normalized_value_json TEXT NOT NULL,
                unit TEXT,
                sources_json TEXT NOT NULL,
                PRIMARY KEY(knowledge_version, fact_key)
             );",
        )
        .map_err(|error| format!("initialize brand knowledge schema: {error}"))?;
    ensure_column(
        connection,
        "knowledge_fact_candidates",
        "profile_provenance",
        "TEXT",
    )?;
    ensure_column(
        connection,
        "knowledge_fact_sources",
        "profile_provenance",
        "TEXT",
    )?;
    ensure_decisions_admit_adopt_edited(connection)
}

/// `adopt-edited`（批量确认卡内的用户改值裁决）晚于首版 schema 引入。SQLite
/// 无法原地修改 CHECK，旧库需要一次幂等重建；决策行原样搬运，审计不重写。
fn ensure_decisions_admit_adopt_edited(connection: &Connection) -> Result<(), String> {
    let decisions_sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_decisions'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect knowledge decisions schema: {error}"))?;
    let Some(decisions_sql) = decisions_sql else {
        return Ok(());
    };
    if decisions_sql.contains("adopt-edited") {
        return Ok(());
    }
    connection
        .execute_batch("PRAGMA foreign_keys=OFF;")
        .map_err(|error| format!("unlock knowledge decisions rebuild: {error}"))?;
    let rebuild = connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE knowledge_decisions_rebuilt (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE REFERENCES knowledge_fact_candidates(id),
            decision TEXT NOT NULL CHECK(decision IN ('keep-current', 'adopt-new', 'adopt-edited', 'split-scope', 'reject-candidate')),
            actor_id TEXT NOT NULL,
            actor_session_id TEXT NOT NULL,
            expected_version INTEGER NOT NULL,
            before_json TEXT,
            after_json TEXT,
            reason TEXT,
            decided_at TEXT NOT NULL
         );
         INSERT INTO knowledge_decisions_rebuilt
            (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
             before_json, after_json, reason, decided_at)
         SELECT id, candidate_id, decision, actor_id, actor_session_id, expected_version,
            before_json, after_json, reason, decided_at
         FROM knowledge_decisions;
         DROP TABLE knowledge_decisions;
         ALTER TABLE knowledge_decisions_rebuilt RENAME TO knowledge_decisions;
         COMMIT;",
    );
    let restored = connection.execute_batch("PRAGMA foreign_keys=ON;");
    match (rebuild, restored) {
        (Ok(()), Ok(())) => Ok(()),
        (rebuild, _) => {
            let _ = connection.execute_batch("ROLLBACK;");
            rebuild.map_err(|error| format!("rebuild knowledge decisions table: {error}"))
        }
    }
}

impl BrandWorkspaceStore {
    pub fn knowledge_current(
        &self,
        workspace_id: &str,
        session_id: &str,
        fact_key: &str,
    ) -> Result<Option<KnowledgeCurrentFact>, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        read_current(&connection, fact_key)
    }

    pub fn submit_knowledge_candidate(
        &self,
        request: KnowledgeCandidateSubmission,
    ) -> Result<KnowledgeCandidate, String> {
        validate_submission(&request)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start knowledge candidate transaction: {error}"))?;
        let current = read_current(&transaction, &request.key.identity)?;
        require_version(current.as_ref(), request.expected_current_version)?;

        let candidate_id = persist_candidate_submission(&transaction, &request)?;
        transaction
            .commit()
            .map_err(|error| format!("commit knowledge candidate: {error}"))?;
        self.knowledge_candidate(&request.workspace_id, &request.session_id, &candidate_id)
    }

    pub fn knowledge_candidate(
        &self,
        workspace_id: &str,
        session_id: &str,
        candidate_id: &str,
    ) -> Result<KnowledgeCandidate, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        read_candidate(&connection, workspace_id, session_id, candidate_id)
    }

    pub fn decide_knowledge_candidate(
        &self,
        request: KnowledgeDecisionRequest,
    ) -> Result<KnowledgeDecisionResult, String> {
        validate_session_id(&request.session_id)?;
        if request.actor_id.trim().is_empty() {
            return Err("knowledge decision requires a confirmed actor".to_string());
        }
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start knowledge decision transaction: {error}"))?;
        let candidate = read_candidate(
            &transaction,
            &request.workspace_id,
            &request.session_id,
            &request.candidate_id,
        )?;
        if !matches!(
            candidate.status.as_str(),
            "awaiting-confirmation" | "conflict"
        ) {
            return Err("knowledge candidate is no longer pending".to_string());
        }
        if request.decision != "adopt-edited" && request.edited_normalized_value_json.is_some() {
            return Err("edited value is only valid for adopt-edited".to_string());
        }
        let before = read_current(&transaction, &candidate.key.identity)?;
        require_version(before.as_ref(), request.expected_current_version)?;
        let now = Utc::now().to_rfc3339();

        let (status, after, changed_fact_key) = match request.decision.as_str() {
            "keep-current" => {
                if before.is_none() {
                    return Err("keep-current requires an existing current fact".to_string());
                }
                ("kept-current", before.clone(), None)
            }
            "reject-candidate" => ("rejected", before.clone(), None),
            "adopt-new" => {
                let same_value = before.as_ref().is_some_and(|current| {
                    current.normalized_value_json == candidate.normalized_value_json
                        && current.unit == candidate.unit
                });
                let next = if same_value {
                    merge_candidate_source(
                        &transaction,
                        &candidate,
                        before.as_ref().expect("same value requires current"),
                        &now,
                    )?
                } else {
                    adopt_candidate(
                        &transaction,
                        &candidate,
                        &candidate.key,
                        before.as_ref(),
                        &request.actor_id,
                        &now,
                    )?
                };
                (
                    "adopted",
                    Some(next),
                    (!same_value).then(|| candidate.key.identity.clone()),
                )
            }
            "adopt-edited" => {
                let edited = request
                    .edited_normalized_value_json
                    .as_deref()
                    .ok_or_else(|| {
                        "adopt-edited requires an edited normalized value".to_string()
                    })?;
                if edited.trim().is_empty() {
                    return Err("adopt-edited requires an edited normalized value".to_string());
                }
                serde_json::from_str::<serde_json::Value>(edited)
                    .map_err(|_| "adopt-edited value must be valid JSON".to_string())?;
                // The candidate row keeps the original proposed value; only the
                // adopted current fact carries the user-edited value, so the
                // decision audit can always reconstruct original → edited.
                let same_value = before.as_ref().is_some_and(|current| {
                    current.normalized_value_json == edited && current.unit == candidate.unit
                });
                let edited_candidate = KnowledgeCandidate {
                    normalized_value_json: edited.to_string(),
                    ..candidate.clone()
                };
                let next = if same_value {
                    merge_candidate_source(
                        &transaction,
                        &candidate,
                        before.as_ref().expect("same value requires current"),
                        &now,
                    )?
                } else {
                    adopt_candidate(
                        &transaction,
                        &edited_candidate,
                        &candidate.key,
                        before.as_ref(),
                        &request.actor_id,
                        &now,
                    )?
                };
                (
                    "adopted",
                    Some(next),
                    (!same_value).then(|| candidate.key.identity.clone()),
                )
            }
            "split-scope" => {
                let split_key = request.split_key.as_ref().ok_or_else(|| {
                    "split-scope requires a structured replacement key".to_string()
                })?;
                if split_key.identity == candidate.key.identity {
                    return Err("split-scope must change scope or effective time".to_string());
                }
                let target = read_current(&transaction, &split_key.identity)?;
                require_version(
                    target.as_ref(),
                    request.split_expected_version.ok_or_else(|| {
                        "split-scope requires target expected version".to_string()
                    })?,
                )?;
                if target.is_some() {
                    return Err("split target already has an authoritative value".to_string());
                }
                let next = adopt_candidate(
                    &transaction,
                    &candidate,
                    split_key,
                    None,
                    &request.actor_id,
                    &now,
                )?;
                ("split-scope", Some(next), Some(split_key.identity.clone()))
            }
            _ => return Err("invalid knowledge decision".to_string()),
        };
        let changed = transaction
            .execute(
                "UPDATE knowledge_fact_candidates SET status = ?1, resolved_at = ?2
             WHERE id = ?3 AND status IN ('awaiting-confirmation', 'conflict')",
                params![status, now, request.candidate_id],
            )
            .map_err(|error| format!("resolve knowledge candidate: {error}"))?;
        if changed != 1 {
            return Err(OPTIMISTIC_CONFLICT.to_string());
        }
        let decision_id = insert_audit(
            &transaction,
            KnowledgeAuditInsert {
                candidate_id: &request.candidate_id,
                decision: &request.decision,
                actor_id: &request.actor_id,
                session_id: &request.session_id,
                expected_version: request.expected_current_version,
                before: before.as_ref(),
                after: after.as_ref(),
                reason: request.reason.as_deref(),
                now: &now,
            },
        )?;
        let knowledge_version = if matches!(
            request.decision.as_str(),
            "adopt-new" | "split-scope" | "adopt-edited"
        ) {
            Some(snapshot_brand_knowledge(
                &transaction,
                &decision_id,
                &request.session_id,
                &now,
            )?)
        } else {
            None
        };
        let affected_artifacts = match (knowledge_version, changed_fact_key.as_deref()) {
            (Some(version), Some(fact_key)) => {
                mark_artifacts_affected_by_knowledge_change(&transaction, version, fact_key, &now)?
            }
            _ => Vec::new(),
        };
        if let Some(material_id) = candidate.source.material_id.as_deref() {
            settle_material_if_resolved(&transaction, material_id, &now)?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit knowledge decision: {error}"))?;
        // 方案 D（GD-11）：采纳「行业」事实=用户确认了品牌领域，写回目录中的
        // 产品线（只增不删、去重）。目录独立于事实事务：同步失败不回滚裁决，
        // 下次采纳行业事实会重试；industry 为必填抽取字段，零产品线品牌经
        // 材料导入 → 知识裁决即自愈。
        let product_line_sync =
            derive_industry_product_lines(&candidate.key.predicate, after.as_ref())
                .and_then(|lines| {
                    self.merge_workspace_product_lines(&request.workspace_id, lines)
                        .ok()
                })
                .filter(|added| !added.is_empty());
        Ok(KnowledgeDecisionResult {
            candidate_id: request.candidate_id,
            fact_key: candidate.key.identity,
            decision: request.decision,
            status: status.to_string(),
            current: after,
            knowledge_version,
            affected_artifacts,
            product_line_sync,
        })
    }

    /// 聊天修订（ADR 0003）：只作用于本 Session 仍处
    /// `awaiting-confirmation`/`conflict` 的候选。modify 把 Node 归一化后的
    /// 新值写回候选行并把 provenance 升到 `asked`（只升不降），状态回到
    /// awaiting-confirmation——用户显式改值即表达了对新值的选择，整卡确认时
    /// 按 adopt-new 提交，不再要求冲突二选一；delete 终结候选；add 复用
    /// submit 语义落为 user-stated/asked 待确认候选，并挂回所属材料的最新
    /// 处理 attempt 使复核卡在既有轮询内重渲染。全部动作写
    /// `knowledge_candidate_revisions` 审计，不升品牌知识版本、不投送决策
    /// reminder（reminder 只在裁决提交时投送）。
    pub fn revise_knowledge_candidate(
        &self,
        request: KnowledgeRevisionRequest,
    ) -> Result<KnowledgeCandidate, String> {
        validate_session_id(&request.session_id)?;
        if request.actor_id.trim().is_empty() {
            return Err("knowledge revision requires a confirmed actor".to_string());
        }
        if request.reason.trim().is_empty() {
            return Err("knowledge revision requires the user's explicit instruction".to_string());
        }
        let workspace = self.workspace(&request.workspace_id)?;
        let mut connection = open_database(&workspace)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start knowledge revision transaction: {error}"))?;
        let now = Utc::now().to_rfc3339();
        let resolved_candidate_id: String = match request.action.as_str() {
            "modify" => {
                let candidate_id = request
                    .candidate_id
                    .as_deref()
                    .ok_or_else(|| "knowledge revision requires a candidate id".to_string())?;
                let value_json = request
                    .value_json
                    .clone()
                    .ok_or_else(|| "knowledge revision modify requires a value".to_string())?;
                let normalized = request.normalized_value_json.clone().ok_or_else(|| {
                    "knowledge revision modify requires a normalized value".to_string()
                })?;
                if normalized.trim().is_empty() {
                    return Err("knowledge revision modify requires a normalized value".to_string());
                }
                serde_json::from_str::<serde_json::Value>(&normalized)
                    .map_err(|_| "knowledge revision value must be valid JSON".to_string())?;
                let candidate = read_candidate(
                    &transaction,
                    &request.workspace_id,
                    &request.session_id,
                    candidate_id,
                )?;
                require_pending(&candidate)?;
                // 来源只升不降：显式改值至少升到 asked，extracted 保持原级。
                let upgraded =
                    if profile_provenance_rank(candidate.source.profile_provenance.as_deref())
                        >= profile_provenance_rank(Some("asked"))
                    {
                        candidate.source.profile_provenance.clone()
                    } else {
                        Some("asked".to_string())
                    };
                let changed = transaction
                    .execute(
                        "UPDATE knowledge_fact_candidates
                         SET value_json=?1, normalized_value_json=?2, unit=?3,
                             profile_provenance=?4, status='awaiting-confirmation'
                         WHERE id=?5 AND status IN ('awaiting-confirmation', 'conflict')",
                        params![value_json, normalized, request.unit, upgraded, candidate_id],
                    )
                    .map_err(|error| format!("revise knowledge candidate: {error}"))?;
                if changed != 1 {
                    return Err(OPTIMISTIC_CONFLICT.to_string());
                }
                let after = serde_json::json!({
                    "valueJson": value_json,
                    "normalizedValueJson": normalized,
                    "unit": request.unit,
                    "profileProvenance": upgraded,
                    "status": "awaiting-confirmation",
                });
                insert_revision_audit(
                    &transaction,
                    KnowledgeRevisionAuditInsert {
                        candidate_id,
                        action: "modify",
                        actor_id: &request.actor_id,
                        session_id: &request.session_id,
                        before: Some(&revision_snapshot(&candidate)),
                        after: Some(&after),
                        reason: &request.reason,
                        now: &now,
                    },
                )?;
                candidate_id.to_string()
            }
            "delete" => {
                let candidate_id = request
                    .candidate_id
                    .as_deref()
                    .ok_or_else(|| "knowledge revision requires a candidate id".to_string())?;
                let candidate = read_candidate(
                    &transaction,
                    &request.workspace_id,
                    &request.session_id,
                    candidate_id,
                )?;
                require_pending(&candidate)?;
                let changed = transaction
                    .execute(
                        "UPDATE knowledge_fact_candidates SET status='rejected', resolved_at=?1
                         WHERE id=?2 AND status IN ('awaiting-confirmation', 'conflict')",
                        params![now, candidate_id],
                    )
                    .map_err(|error| format!("delete knowledge candidate: {error}"))?;
                if changed != 1 {
                    return Err(OPTIMISTIC_CONFLICT.to_string());
                }
                insert_revision_audit(
                    &transaction,
                    KnowledgeRevisionAuditInsert {
                        candidate_id,
                        action: "delete",
                        actor_id: &request.actor_id,
                        session_id: &request.session_id,
                        before: Some(&revision_snapshot(&candidate)),
                        after: None,
                        reason: &request.reason,
                        now: &now,
                    },
                )?;
                if let Some(material_id) = candidate.source.material_id.as_deref() {
                    settle_material_if_resolved(&transaction, material_id, &now)?;
                }
                candidate_id.to_string()
            }
            "add" => {
                let submission = request.submission.clone().ok_or_else(|| {
                    "knowledge revision add requires a candidate submission".to_string()
                })?;
                // 嵌套 submission 的身份一致性在 management API handler 的
                // 信任边界校验（与 submit/decide 同构），store 不重复判定。
                validate_submission(&submission)?;
                let current = read_current(&transaction, &submission.key.identity)?;
                require_version(current.as_ref(), submission.expected_current_version)?;
                let candidate_id = persist_candidate_submission(&transaction, &submission)?;
                if let Some(material_id) = submission.source.material_id.as_deref() {
                    append_candidate_to_material_attempt(
                        &transaction,
                        &request.session_id,
                        material_id,
                        &candidate_id,
                        &now,
                    )?;
                }
                let candidate = read_candidate(
                    &transaction,
                    &request.workspace_id,
                    &request.session_id,
                    &candidate_id,
                )?;
                insert_revision_audit(
                    &transaction,
                    KnowledgeRevisionAuditInsert {
                        candidate_id: &candidate_id,
                        action: "add",
                        actor_id: &request.actor_id,
                        session_id: &request.session_id,
                        before: None,
                        after: Some(&revision_snapshot(&candidate)),
                        reason: &request.reason,
                        now: &now,
                    },
                )?;
                candidate_id
            }
            _ => return Err("invalid knowledge revision action".to_string()),
        };
        transaction
            .commit()
            .map_err(|error| format!("commit knowledge revision: {error}"))?;
        self.knowledge_candidate(
            &request.workspace_id,
            &request.session_id,
            &resolved_candidate_id,
        )
    }
}

/// 候选落库（submit 与聊天修订 add 共用）：同 Session、同事实键、同值、同
/// 单位/材料/origin/intent 且仍待决的重复提交只做 provenance 升级并返回
/// 既有候选；否则写入 raw input 与新候选行，返回候选 id。
fn persist_candidate_submission(
    transaction: &rusqlite::Transaction<'_>,
    request: &KnowledgeCandidateSubmission,
) -> Result<String, String> {
    let existing_candidate: Option<(String, Option<String>)> = transaction
        .query_row(
            "SELECT id, profile_provenance FROM knowledge_fact_candidates
             WHERE session_id=?1 AND fact_key=?2 AND normalized_value_json=?3
               AND unit IS ?4 AND material_id IS ?5
               AND origin=?6 AND intent=?7
               AND status IN ('awaiting-confirmation','conflict')
             ORDER BY proposed_at, id LIMIT 1",
            params![
                request.session_id,
                request.key.identity,
                request.normalized_value_json,
                request.unit,
                request.source.material_id,
                request.origin,
                request.intent
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("deduplicate knowledge candidate: {error}"))?;
    if let Some((candidate_id, existing_provenance)) = existing_candidate {
        if profile_provenance_rank(request.source.profile_provenance.as_deref())
            > profile_provenance_rank(existing_provenance.as_deref())
        {
            transaction
                .execute(
                    "UPDATE knowledge_fact_candidates
                     SET excerpt=?2, confidence=?3, profile_provenance=?4
                     WHERE id=?1",
                    params![
                        &candidate_id,
                        &request.source.excerpt,
                        request.source.confidence,
                        &request.source.profile_provenance
                    ],
                )
                .map_err(|error| format!("upgrade knowledge candidate provenance: {error}"))?;
        }
        return Ok(candidate_id);
    }

    let raw_input_id = Uuid::new_v4().to_string();
    let candidate_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let status = match request.disposition.as_str() {
        "awaiting-confirmation" | "conflict" => request.disposition.as_str(),
        _ => return Err("invalid knowledge candidate disposition".to_string()),
    };
    transaction.execute(
        "INSERT INTO knowledge_raw_inputs (id, session_id, input_text, origin, intent, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![raw_input_id, request.session_id, request.raw_input, request.origin, request.intent, now],
    ).map_err(|error| format!("store knowledge raw input: {error}"))?;
    transaction
        .execute(
            "INSERT INTO knowledge_fact_candidates
            (id, raw_input_id, session_id, subject, predicate, scope_json, effective_from,
             effective_to, fact_key, value_json, normalized_value_json, unit, material_id,
             excerpt, confidence, profile_provenance, origin, intent, status, base_version,
             proposed_at, resolved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, NULL)",
            params![
                candidate_id,
                raw_input_id,
                request.session_id,
                request.key.subject,
                request.key.predicate,
                request.key.scope_json,
                request.key.effective_from,
                request.key.effective_to,
                request.key.identity,
                request.value_json,
                request.normalized_value_json,
                request.unit,
                request.source.material_id,
                request.source.excerpt,
                request.source.confidence,
                request.source.profile_provenance,
                request.origin,
                request.intent,
                status,
                request.expected_current_version,
                now
            ],
        )
        .map_err(|error| format!("store knowledge candidate: {error}"))?;
    Ok(candidate_id)
}

fn require_pending(candidate: &KnowledgeCandidate) -> Result<(), String> {
    if matches!(
        candidate.status.as_str(),
        "awaiting-confirmation" | "conflict"
    ) {
        return Ok(());
    }
    Err("knowledge candidate is no longer pending".to_string())
}

/// 材料的未决候选清零后，把材料状态与最新处理 attempt 对齐为 processed；
/// 裁决与聊天删除两类终结共用。
fn settle_material_if_resolved(
    transaction: &rusqlite::Transaction<'_>,
    material_id: &str,
    now: &str,
) -> Result<(), String> {
    let unresolved: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM knowledge_fact_candidates
             WHERE material_id=?1 AND status IN ('awaiting-confirmation','conflict')",
            [material_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("count material candidates: {error}"))?;
    if unresolved != 0 {
        return Ok(());
    }
    transaction
        .execute(
            "UPDATE brand_materials SET status='processed', updated_at=?2
             WHERE id=?1 AND EXISTS (
               SELECT 1 FROM brand_material_processing latest
               WHERE latest.material_id=?1
                 AND latest.status='awaiting-confirmation'
                 AND latest.attempt_number=(
                   SELECT MAX(attempt_number) FROM brand_material_processing
                   WHERE material_id=?1
                 )
             )",
            params![material_id, now],
        )
        .map_err(|error| format!("settle material status: {error}"))?;
    Ok(())
}

/// 把聊天新增的候选挂回材料最新一次处理 attempt 的候选快照：复核卡成员
/// 来自该快照（materials 列表），追加后卡片在既有轮询内重渲染出新行。
/// attempt 已终结或快照已满时不追加；成功追加会把材料拉回
/// awaiting-confirmation（processed 语义上表示已无未决候选）。
fn append_candidate_to_material_attempt(
    transaction: &rusqlite::Transaction<'_>,
    session_id: &str,
    material_id: &str,
    candidate_id: &str,
    now: &str,
) -> Result<(), String> {
    let attempt: Option<(String, String)> = transaction
        .query_row(
            "SELECT id, candidate_ids_json FROM brand_material_processing
             WHERE material_id=?1 AND session_id=?2 AND status='awaiting-confirmation'
             ORDER BY attempt_number DESC LIMIT 1",
            params![material_id, session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("read material attempt for revision: {error}"))?;
    let Some((attempt_id, ids_json)) = attempt else {
        return Ok(());
    };
    let mut ids: Vec<String> = serde_json::from_str(&ids_json)
        .map_err(|_| "material_candidate_ids_invalid".to_string())?;
    if ids.iter().any(|id| id == candidate_id) {
        return Ok(());
    }
    if ids.len() >= 100 {
        return Err("knowledge revision card is full (100 pending candidates)".to_string());
    }
    ids.push(candidate_id.to_string());
    let serialized =
        serde_json::to_string(&ids).map_err(|_| "material_candidate_ids_invalid".to_string())?;
    transaction
        .execute(
            "UPDATE brand_material_processing SET candidate_ids_json=?2 WHERE id=?1",
            params![attempt_id, serialized],
        )
        .map_err(|error| format!("attach revised candidate to material attempt: {error}"))?;
    transaction
        .execute(
            "UPDATE brand_materials SET status='awaiting-confirmation', updated_at=?2
             WHERE id=?1",
            params![material_id, now],
        )
        .map_err(|error| format!("reopen material for revised candidate: {error}"))?;
    Ok(())
}

/// 修订审计的候选快照投影：值、单位、provenance 与状态足以重建
/// 「原值 → 改值」链路，与决策审计的 before/after JSON 同构使用。
fn revision_snapshot(candidate: &KnowledgeCandidate) -> serde_json::Value {
    serde_json::json!({
        "valueJson": candidate.value_json,
        "normalizedValueJson": candidate.normalized_value_json,
        "unit": candidate.unit,
        "profileProvenance": candidate.source.profile_provenance,
        "status": candidate.status,
    })
}

struct KnowledgeRevisionAuditInsert<'a> {
    candidate_id: &'a str,
    action: &'a str,
    actor_id: &'a str,
    session_id: &'a str,
    before: Option<&'a serde_json::Value>,
    after: Option<&'a serde_json::Value>,
    reason: &'a str,
    now: &'a str,
}

fn insert_revision_audit(
    transaction: &rusqlite::Transaction<'_>,
    input: KnowledgeRevisionAuditInsert<'_>,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO knowledge_candidate_revisions
                (id, candidate_id, action, actor_id, actor_session_id, before_json, after_json, reason, revised_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                Uuid::new_v4().to_string(),
                input.candidate_id,
                input.action,
                input.actor_id,
                input.session_id,
                serde_json::to_string(&input.before).map_err(|error| error.to_string())?,
                serde_json::to_string(&input.after).map_err(|error| error.to_string())?,
                input.reason,
                input.now
            ],
        )
        .map_err(|error| format!("store knowledge revision audit: {error}"))?;
    Ok(())
}

/// 只从 `enterprise-profile.industry`（领域级）推导产品线；
/// products 等细粒度业务不进注册表，经题库的 businessFocus 使用。
fn derive_industry_product_lines(
    predicate: &str,
    adopted: Option<&KnowledgeCurrentFact>,
) -> Option<Vec<String>> {
    if predicate != "enterprise-profile.industry" {
        return None;
    }
    let fact = adopted?;
    let value = serde_json::from_str::<serde_json::Value>(&fact.normalized_value_json).ok()?;
    let lines: Vec<String> = match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim().to_string();
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed]
            }
        }
        serde_json::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                serde_json::Value::String(text) => Some(text.trim().to_string()),
                _ => None,
            })
            .filter(|text| !text.is_empty() && text.chars().count() <= 80)
            .collect(),
        _ => Vec::new(),
    };
    (!lines.is_empty()).then_some(lines)
}

fn validate_submission(request: &KnowledgeCandidateSubmission) -> Result<(), String> {
    validate_session_id(&request.session_id)?;
    if request.raw_input.trim().is_empty() || request.raw_input.chars().count() > 20_000 {
        return Err("knowledge raw input must be 1-20000 characters".to_string());
    }
    if !matches!(request.origin.as_str(), "user-stated" | "model-inferred") {
        return Err("invalid knowledge candidate origin".to_string());
    }
    if !matches!(
        request.intent.as_str(),
        "knowledge-update" | "chat-observation"
    ) {
        return Err("invalid knowledge request intent".to_string());
    }
    if request.key.subject.is_empty()
        || request.key.predicate.is_empty()
        || request.key.identity.is_empty()
        || request.normalized_value_json.is_empty()
        || request.source.excerpt.trim().is_empty()
        || !(0.0..=1.0).contains(&request.source.confidence)
    {
        return Err("knowledge candidate is incomplete".to_string());
    }
    if request
        .source
        .profile_provenance
        .as_deref()
        .is_some_and(|value| !matches!(value, "extracted" | "asked" | "inferred"))
    {
        return Err("invalid profile provenance".to_string());
    }
    Ok(())
}

fn profile_provenance_rank(value: Option<&str>) -> u8 {
    match value {
        Some("extracted") => 3,
        Some("asked") => 2,
        Some("inferred") => 1,
        _ => 0,
    }
}

fn require_version(current: Option<&KnowledgeCurrentFact>, expected: i64) -> Result<(), String> {
    let actual = current.map_or(0, |fact| fact.version);
    if actual != expected {
        return Err(format!(
            "{OPTIMISTIC_CONFLICT}: expected {expected}, actual {actual}"
        ));
    }
    Ok(())
}

fn read_current(
    connection: &Connection,
    fact_key: &str,
) -> Result<Option<KnowledgeCurrentFact>, String> {
    let row = connection
        .query_row(
            "SELECT subject, predicate, scope_json, effective_from, effective_to,
                normalized_value_json, unit, version, confirmed_by, confirmed_at
         FROM knowledge_current_facts WHERE fact_key = ?1",
            [fact_key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read current knowledge fact: {error}"))?;
    let Some((
        subject,
        predicate,
        scope_json,
        effective_from,
        effective_to,
        normalized_value_json,
        unit,
        version,
        confirmed_by,
        confirmed_at,
    )) = row
    else {
        return Ok(None);
    };
    let sources = read_sources(connection, fact_key, version)?;
    Ok(Some(KnowledgeCurrentFact {
        key: KnowledgeFactKey {
            subject,
            predicate,
            scope_json,
            effective_from,
            effective_to,
            identity: fact_key.to_string(),
        },
        normalized_value_json,
        unit,
        version,
        confirmed_by,
        confirmed_at,
        sources,
    }))
}

fn read_sources(
    connection: &Connection,
    fact_key: &str,
    version: i64,
) -> Result<Vec<KnowledgeFactSource>, String> {
    let mut statement = connection.prepare(
        "SELECT raw_input_id, material_id, excerpt, confidence, profile_provenance, origin, created_at
         FROM knowledge_fact_sources WHERE fact_key = ?1 AND fact_version = ?2 ORDER BY created_at, id"
    ).map_err(|error| format!("prepare knowledge sources: {error}"))?;
    let sources = statement
        .query_map(params![fact_key, version], |row| {
            Ok(KnowledgeFactSource {
                raw_input_id: row.get(0)?,
                material_id: row.get(1)?,
                excerpt: row.get(2)?,
                confidence: row.get(3)?,
                profile_provenance: row.get(4)?,
                origin: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("query knowledge sources: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read knowledge sources: {error}"))?;
    Ok(sources)
}

fn read_candidate(
    connection: &Connection,
    workspace_id: &str,
    session_id: &str,
    candidate_id: &str,
) -> Result<KnowledgeCandidate, String> {
    let candidate = connection
        .query_row(
            "SELECT session_id, subject, predicate, scope_json, effective_from, effective_to,
                fact_key, value_json, normalized_value_json, unit, material_id, excerpt,
                confidence, profile_provenance, origin, intent, status, base_version, proposed_at
         FROM knowledge_fact_candidates WHERE id = ?1 AND session_id = ?2",
            params![candidate_id, session_id],
            |row| {
                Ok(KnowledgeCandidate {
                    id: candidate_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    session_id: row.get(0)?,
                    key: KnowledgeFactKey {
                        subject: row.get(1)?,
                        predicate: row.get(2)?,
                        scope_json: row.get(3)?,
                        effective_from: row.get(4)?,
                        effective_to: row.get(5)?,
                        identity: row.get(6)?,
                    },
                    value_json: row.get(7)?,
                    normalized_value_json: row.get(8)?,
                    unit: row.get(9)?,
                    source: KnowledgeSourceInput {
                        material_id: row.get(10)?,
                        excerpt: row.get(11)?,
                        confidence: row.get(12)?,
                        profile_provenance: row.get(13)?,
                    },
                    origin: row.get(14)?,
                    intent: row.get(15)?,
                    status: row.get(16)?,
                    base_version: row.get(17)?,
                    proposed_at: row.get(18)?,
                    current: None,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read knowledge candidate: {error}"))?
        .ok_or_else(|| "knowledge candidate not found for this Session".to_string())?;
    let current = read_current(connection, &candidate.key.identity)?;
    Ok(KnowledgeCandidate {
        current,
        ..candidate
    })
}

fn adopt_candidate(
    transaction: &rusqlite::Transaction<'_>,
    candidate: &KnowledgeCandidate,
    key: &KnowledgeFactKey,
    before: Option<&KnowledgeCurrentFact>,
    actor_id: &str,
    now: &str,
) -> Result<KnowledgeCurrentFact, String> {
    if let Some(previous) = before {
        transaction.execute(
            "INSERT INTO knowledge_fact_versions
                (id, fact_key, version, subject, predicate, scope_json, effective_from, effective_to,
                 normalized_value_json, unit, confirmed_by, confirmed_at, superseded_at, superseded_by_candidate_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![Uuid::new_v4().to_string(), previous.key.identity, previous.version,
                previous.key.subject, previous.key.predicate, previous.key.scope_json,
                previous.key.effective_from, previous.key.effective_to, previous.normalized_value_json,
                previous.unit, previous.confirmed_by, previous.confirmed_at, now, candidate.id],
        ).map_err(|error| format!("archive knowledge fact version: {error}"))?;
    }
    let version = before.map_or(1, |fact| fact.version + 1);
    if before.is_some() {
        let changed = transaction
            .execute(
                "UPDATE knowledge_current_facts SET subject=?1, predicate=?2, scope_json=?3,
                effective_from=?4, effective_to=?5, normalized_value_json=?6, unit=?7,
                version=?8, confirmed_by=?9, confirmed_at=?10, updated_at=?10
             WHERE fact_key=?11 AND version=?12",
                params![
                    key.subject,
                    key.predicate,
                    key.scope_json,
                    key.effective_from,
                    key.effective_to,
                    candidate.normalized_value_json,
                    candidate.unit,
                    version,
                    actor_id,
                    now,
                    key.identity,
                    version - 1
                ],
            )
            .map_err(|error| format!("replace current knowledge fact: {error}"))?;
        if changed != 1 {
            return Err(OPTIMISTIC_CONFLICT.to_string());
        }
    } else {
        transaction.execute(
            "INSERT INTO knowledge_current_facts
                (fact_key, subject, predicate, scope_json, effective_from, effective_to,
                 normalized_value_json, unit, version, confirmed_by, confirmed_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10, ?10)",
            params![key.identity, key.subject, key.predicate, key.scope_json, key.effective_from,
                key.effective_to, candidate.normalized_value_json, candidate.unit, actor_id, now],
        ).map_err(|error| {
            if matches!(error, rusqlite::Error::SqliteFailure(ref code, _) if code.extended_code == 1555 || code.extended_code == 2067) {
                OPTIMISTIC_CONFLICT.to_string()
            } else { format!("insert current knowledge fact: {error}") }
        })?;
    }
    let raw_input_id: String = transaction
        .query_row(
            "SELECT raw_input_id FROM knowledge_fact_candidates WHERE id=?1",
            [&candidate.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("read candidate raw input: {error}"))?;
    insert_source(
        transaction,
        KnowledgeSourceInsert {
            fact_key: &key.identity,
            version,
            candidate_id: &candidate.id,
            raw_input_id: &raw_input_id,
            source: &candidate.source,
            origin: &candidate.origin,
            now,
        },
    )?;
    read_current(transaction, &key.identity)?
        .ok_or_else(|| "current fact missing after adoption".to_string())
}

fn merge_candidate_source(
    transaction: &rusqlite::Transaction<'_>,
    candidate: &KnowledgeCandidate,
    current: &KnowledgeCurrentFact,
    now: &str,
) -> Result<KnowledgeCurrentFact, String> {
    let raw_input_id: String = transaction
        .query_row(
            "SELECT raw_input_id FROM knowledge_fact_candidates WHERE id=?1",
            [&candidate.id],
            |row| row.get(0),
        )
        .map_err(|error| format!("read candidate raw input: {error}"))?;
    insert_source(
        transaction,
        KnowledgeSourceInsert {
            fact_key: &current.key.identity,
            version: current.version,
            candidate_id: &candidate.id,
            raw_input_id: &raw_input_id,
            source: &candidate.source,
            origin: &candidate.origin,
            now,
        },
    )?;
    read_current(transaction, &current.key.identity)?
        .ok_or_else(|| "current fact missing after source merge".to_string())
}

struct KnowledgeSourceInsert<'a> {
    fact_key: &'a str,
    version: i64,
    candidate_id: &'a str,
    raw_input_id: &'a str,
    source: &'a KnowledgeSourceInput,
    origin: &'a str,
    now: &'a str,
}

fn insert_source(
    transaction: &rusqlite::Transaction<'_>,
    input: KnowledgeSourceInsert<'_>,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO knowledge_fact_sources
            (id, fact_key, fact_version, candidate_id, raw_input_id, material_id, excerpt,
             confidence, profile_provenance, origin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                Uuid::new_v4().to_string(),
                input.fact_key,
                input.version,
                input.candidate_id,
                input.raw_input_id,
                input.source.material_id,
                input.source.excerpt,
                input.source.confidence,
                input.source.profile_provenance,
                input.origin,
                input.now
            ],
        )
        .map_err(|error| format!("store knowledge source: {error}"))?;
    Ok(())
}

struct KnowledgeAuditInsert<'a> {
    candidate_id: &'a str,
    decision: &'a str,
    actor_id: &'a str,
    session_id: &'a str,
    expected_version: i64,
    before: Option<&'a KnowledgeCurrentFact>,
    after: Option<&'a KnowledgeCurrentFact>,
    reason: Option<&'a str>,
    now: &'a str,
}

fn insert_audit(
    transaction: &rusqlite::Transaction<'_>,
    input: KnowledgeAuditInsert<'_>,
) -> Result<String, String> {
    let decision_id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO knowledge_decisions
            (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
             before_json, after_json, reason, decided_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                decision_id,
                input.candidate_id,
                input.decision,
                input.actor_id,
                input.session_id,
                input.expected_version,
                serde_json::to_string(&input.before).map_err(|e| e.to_string())?,
                serde_json::to_string(&input.after).map_err(|e| e.to_string())?,
                input.reason,
                input.now
            ],
        )
        .map_err(|error| format!("store knowledge decision audit: {error}"))?;
    Ok(decision_id)
}

fn snapshot_brand_knowledge(
    transaction: &rusqlite::Transaction<'_>,
    decision_id: &str,
    session_id: &str,
    now: &str,
) -> Result<i64, String> {
    let version: i64 = transaction
        .query_row(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM knowledge_versions",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("allocate knowledge version: {error}"))?;
    let mut statement = transaction
        .prepare(
            "SELECT fact_key, version, normalized_value_json, unit
             FROM knowledge_current_facts ORDER BY fact_key",
        )
        .map_err(|error| format!("prepare knowledge snapshot: {error}"))?;
    let facts = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("query knowledge snapshot: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read knowledge snapshot: {error}"))?;
    drop(statement);
    let mut hash = Sha256::new();
    let mut snapshot_rows = Vec::with_capacity(facts.len());
    for (fact_key, fact_version, value, unit) in &facts {
        let sources = read_sources(transaction, fact_key, *fact_version)?;
        let sources_json = serde_json::to_string(&sources)
            .map_err(|error| format!("serialize knowledge snapshot sources: {error}"))?;
        hash.update(fact_key.as_bytes());
        hash.update(fact_version.to_be_bytes());
        hash.update(value.as_bytes());
        hash.update(unit.as_deref().unwrap_or_default().as_bytes());
        hash.update(sources_json.as_bytes());
        snapshot_rows.push((fact_key, fact_version, value, unit, sources_json));
    }
    transaction
        .execute(
            "INSERT INTO knowledge_versions
                (version, decision_id, actor_session_id, snapshot_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                version,
                decision_id,
                session_id,
                format!("{:x}", hash.finalize()),
                now
            ],
        )
        .map_err(|error| format!("store knowledge version: {error}"))?;
    for (fact_key, fact_version, value, unit, sources_json) in snapshot_rows {
        transaction
            .execute(
                "INSERT INTO knowledge_version_facts
                    (knowledge_version, fact_key, fact_version, normalized_value_json, unit, sources_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![version, fact_key, fact_version, value, unit, sources_json],
            )
            .map_err(|error| format!("store knowledge snapshot fact: {error}"))?;
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture() -> (BrandWorkspaceStore, BrandWorkspace) {
        let root = tempdir().unwrap().keep();
        let store = BrandWorkspaceStore::at(root.join("Xiaojing"));
        let workspace = store.create_workspace("知识测试品牌", vec![]).unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-knowledge".into(),
                    title: "知识".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        (store, workspace)
    }

    fn key(scope: &str, from: Option<&str>) -> KnowledgeFactKey {
        let identity = format!("brand|price|{scope}|{}|", from.unwrap_or(""));
        KnowledgeFactKey {
            subject: "brand".into(),
            predicate: "price".into(),
            scope_json: scope.into(),
            effective_from: from.map(str::to_string),
            effective_to: None,
            identity,
        }
    }

    fn submission(
        workspace: &BrandWorkspace,
        key: KnowledgeFactKey,
        value: &str,
        expected: i64,
        disposition: &str,
    ) -> KnowledgeCandidateSubmission {
        KnowledgeCandidateSubmission {
            workspace_id: workspace.id.clone(),
            session_id: "session-knowledge".into(),
            raw_input: format!("价格是 {value}"),
            origin: "user-stated".into(),
            intent: "knowledge-update".into(),
            key,
            value_json: format!("\"{value}\""),
            normalized_value_json: format!("\"{value}\""),
            unit: Some("cny".into()),
            source: KnowledgeSourceInput {
                material_id: Some("material-1".into()),
                excerpt: format!("价格是 {value}"),
                confidence: 0.98,
                profile_provenance: None,
            },
            expected_current_version: expected,
            disposition: disposition.into(),
        }
    }

    fn adopt(
        store: &BrandWorkspaceStore,
        workspace: &BrandWorkspace,
        candidate: KnowledgeCandidate,
    ) -> KnowledgeDecisionResult {
        store
            .decide_knowledge_candidate(KnowledgeDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-knowledge".into(),
                candidate_id: candidate.id,
                decision: "adopt-new".into(),
                expected_current_version: candidate.base_version,
                actor_id: "user-1".into(),
                reason: None,
                split_key: None,
                split_expected_version: None,
                edited_normalized_value_json: None,
            })
            .unwrap()
    }

    #[test]
    fn current_fact_is_unique_and_stale_sessions_cannot_overwrite() {
        let (store, workspace) = fixture();
        let first = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, first);
        let stale = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "120",
                1,
                "conflict",
            ))
            .unwrap();
        let newer = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "110",
                1,
                "conflict",
            ))
            .unwrap();
        adopt(&store, &workspace, newer);
        let error = store
            .decide_knowledge_candidate(KnowledgeDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-knowledge".into(),
                candidate_id: stale.id,
                decision: "adopt-new".into(),
                expected_current_version: 1,
                actor_id: "user-2".into(),
                reason: None,
                split_key: None,
                split_expected_version: None,
                edited_normalized_value_json: None,
            })
            .unwrap_err();
        assert!(error.contains(OPTIMISTIC_CONFLICT));
        assert_eq!(
            store
                .knowledge_current(
                    &workspace.id,
                    "session-knowledge",
                    &key("{}", None).identity
                )
                .unwrap()
                .unwrap()
                .version,
            2
        );
    }

    #[test]
    fn equal_value_merges_sources_without_new_fact_version() {
        let (store, workspace) = fixture();
        let first = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, first);
        let duplicate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                1,
                "awaiting-confirmation",
            ))
            .unwrap();
        let before_confirmation = store
            .knowledge_current(
                &workspace.id,
                "session-knowledge",
                &key("{}", None).identity,
            )
            .unwrap()
            .unwrap();
        assert_eq!(before_confirmation.sources.len(), 1);
        let merged = adopt(&store, &workspace, duplicate);
        assert_eq!(merged.status, "adopted");
        assert!(merged.affected_artifacts.is_empty());
        let current = store
            .knowledge_current(
                &workspace.id,
                "session-knowledge",
                &key("{}", None).identity,
            )
            .unwrap()
            .unwrap();
        assert_eq!(current.version, 1);
        assert_eq!(current.sources.len(), 2);
    }

    #[test]
    fn adopted_candidates_create_immutable_brand_versions_and_artifacts_keep_their_version() {
        let (store, workspace) = fixture();
        let first = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let first_result = adopt(&store, &workspace, first);
        assert_eq!(first_result.knowledge_version, Some(1));

        let connection = open_database(&workspace).unwrap();
        connection
            .execute(
                "INSERT INTO geo_artifacts
                    (id, operation_id, session_id, kind, knowledge_version, created_at)
                 VALUES ('artifact-v1', NULL, 'session-knowledge', 'approved-article', 1, 'now')",
                [],
            )
            .unwrap();
        for (id, kind) in [
            ("question-pool-v1", "question-pool"),
            ("topic-plan-v1", "topic-plan"),
            ("article-draft-v1", "article-draft"),
            ("distribution-plan-v1", "distribution-plan"),
            ("baseline-v1", "geo-baseline"),
        ] {
            connection
                .execute(
                    "INSERT INTO geo_artifacts
                        (id, operation_id, session_id, kind, knowledge_version, created_at)
                     VALUES (?1, NULL, 'session-knowledge', ?2, 1, 'now')",
                    params![id, kind],
                )
                .unwrap();
        }
        drop(connection);

        let replacement = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "110",
                1,
                "conflict",
            ))
            .unwrap();
        let second_result = adopt(&store, &workspace, replacement);
        assert_eq!(second_result.knowledge_version, Some(2));
        assert_eq!(second_result.affected_artifacts.len(), 4);
        assert!(second_result
            .affected_artifacts
            .iter()
            .all(|artifact| artifact.status == "needs-confirmation"));

        let connection = open_database(&workspace).unwrap();
        let versions: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let old_value: String = connection
            .query_row(
                "SELECT normalized_value_json FROM knowledge_version_facts
                 WHERE knowledge_version=1 AND fact_key=?1",
                [&key("{}", None).identity],
                |row| row.get(0),
            )
            .unwrap();
        let new_value: String = connection
            .query_row(
                "SELECT normalized_value_json FROM knowledge_version_facts
                 WHERE knowledge_version=2 AND fact_key=?1",
                [&key("{}", None).identity],
                |row| row.get(0),
            )
            .unwrap();
        let artifact_version: i64 = connection
            .query_row(
                "SELECT knowledge_version FROM geo_artifacts WHERE id='artifact-v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let freshness_ids = connection
            .prepare("SELECT artifact_id FROM geo_artifact_freshness ORDER BY artifact_id")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(versions, 2);
        assert_eq!(
            (old_value.as_str(), new_value.as_str()),
            ("\"100\"", "\"110\"")
        );
        assert_eq!(artifact_version, 1);
        assert_eq!(
            freshness_ids,
            vec![
                "article-draft-v1",
                "distribution-plan-v1",
                "question-pool-v1",
                "topic-plan-v1",
            ]
        );
    }

    #[test]
    fn scope_and_effective_time_create_independent_current_values() {
        let (store, workspace) = fixture();
        for fact_key in [
            key("{\"region\":\"cn\"}", None),
            key("{\"region\":\"us\"}", None),
            key("{}", Some("2027-01-01")),
        ] {
            let candidate = store
                .submit_knowledge_candidate(submission(
                    &workspace,
                    fact_key,
                    "100",
                    0,
                    "awaiting-confirmation",
                ))
                .unwrap();
            adopt(&store, &workspace, candidate);
        }
        let connection = open_database(&workspace).unwrap();
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_current_facts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn model_inference_is_persisted_only_as_a_pending_candidate() {
        let (store, workspace) = fixture();
        let mut inferred = submission(
            &workspace,
            key("{}", None),
            "100",
            0,
            "awaiting-confirmation",
        );
        inferred.origin = "model-inferred".into();
        inferred.intent = "chat-observation".into();

        let candidate = store.submit_knowledge_candidate(inferred).unwrap();

        assert_eq!(candidate.status, "awaiting-confirmation");
        assert!(store
            .knowledge_current(
                &workspace.id,
                "session-knowledge",
                &key("{}", None).identity,
            )
            .unwrap()
            .is_none());
        let connection = open_database(&workspace).unwrap();
        let raw_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_raw_inputs", [], |row| {
                row.get(0)
            })
            .unwrap();
        let candidate_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_fact_candidates",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!((raw_count, candidate_count), (1, 1));
    }

    #[test]
    fn retry_deduplicates_the_same_pending_material_candidate() {
        let (store, workspace) = fixture();
        let mut request = submission(
            &workspace,
            key("{}", None),
            "100",
            0,
            "awaiting-confirmation",
        );
        request.source.profile_provenance = Some("inferred".into());

        let first = store.submit_knowledge_candidate(request.clone()).unwrap();
        request.source.profile_provenance = Some("extracted".into());
        request.source.excerpt = "官网明确标价 100 元".into();
        let retried = store.submit_knowledge_candidate(request).unwrap();

        assert_eq!(retried.id, first.id);
        assert_eq!(
            retried.source.profile_provenance.as_deref(),
            Some("extracted")
        );
        assert_eq!(retried.source.excerpt, "官网明确标价 100 元");
        let connection = open_database(&workspace).unwrap();
        let counts: (i64, i64) = (
            connection
                .query_row("SELECT COUNT(*) FROM knowledge_raw_inputs", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            connection
                .query_row(
                    "SELECT COUNT(*) FROM knowledge_fact_candidates",
                    [],
                    |row| row.get(0),
                )
                .unwrap(),
        );
        assert_eq!(counts, (1, 1));
    }

    #[test]
    fn knowledge_reads_never_follow_the_catalog_current_workspace() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let first = store.create_workspace("知识品牌甲", vec![]).unwrap();
        let second = store.create_workspace("知识品牌乙", vec![]).unwrap();
        for workspace in [&first, &second] {
            store
                .commit_session(
                    &workspace.id,
                    SessionCommit {
                        id: "session-knowledge".into(),
                        title: "知识".into(),
                        title_source: SessionTitleSource::User,
                    },
                )
                .unwrap();
        }
        let candidate = store
            .submit_knowledge_candidate(submission(
                &first,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &first, candidate);
        store.switch_workspace(&second.id).unwrap();

        assert!(store
            .knowledge_current(&first.id, "session-knowledge", &key("{}", None).identity,)
            .unwrap()
            .is_some());
        assert!(store
            .knowledge_current(&second.id, "session-knowledge", &key("{}", None).identity,)
            .unwrap()
            .is_none());
    }

    #[test]
    fn all_four_user_decisions_are_audited_and_replacements_keep_history() {
        let (store, workspace) = fixture();
        let initial = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, initial);
        let decide = |candidate: KnowledgeCandidate,
                      decision: &str,
                      split_key: Option<KnowledgeFactKey>,
                      expected: i64| {
            store
                .decide_knowledge_candidate(KnowledgeDecisionRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-knowledge".into(),
                    candidate_id: candidate.id,
                    decision: decision.into(),
                    expected_current_version: expected,
                    actor_id: "user-auditor".into(),
                    reason: Some("verified".into()),
                    split_key,
                    split_expected_version: (decision == "split-scope").then_some(0),
                    edited_normalized_value_json: None,
                })
                .unwrap()
        };
        let keep = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "101",
                1,
                "conflict",
            ))
            .unwrap();
        decide(keep, "keep-current", None, 1);
        let reject = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "102",
                1,
                "conflict",
            ))
            .unwrap();
        decide(reject, "reject-candidate", None, 1);
        let split = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "103",
                1,
                "conflict",
            ))
            .unwrap();
        decide(
            split,
            "split-scope",
            Some(key("{\"tier\":\"pro\"}", None)),
            1,
        );
        let adopt_new = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "104",
                1,
                "conflict",
            ))
            .unwrap();
        decide(adopt_new, "adopt-new", None, 1);
        let connection = open_database(&workspace).unwrap();
        let decision_kinds: i64 = connection.query_row("SELECT COUNT(DISTINCT decision) FROM knowledge_decisions WHERE decision IN ('keep-current','reject-candidate','split-scope','adopt-new')", [], |row| row.get(0)).unwrap();
        let history: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_fact_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let incomplete_audits: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_decisions
             WHERE actor_id = '' OR actor_session_id = '' OR decided_at = ''
                OR before_json IS NULL OR after_json IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let raw_inputs: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_raw_inputs", [], |row| {
                row.get(0)
            })
            .unwrap();
        let candidates: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_fact_candidates",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let current: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_current_facts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(decision_kinds, 4);
        assert_eq!(history, 1);
        assert_eq!(incomplete_audits, 0);
        assert_eq!((raw_inputs, candidates, current), (5, 5, 2));
    }

    #[test]
    fn legacy_decisions_table_is_rebuilt_to_admit_adopt_edited() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, candidate);
        let connection = open_database(&workspace).unwrap();
        // 模拟首版 schema：把 CHECK 退回不含 adopt-edited 的旧表，保留审计行。
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE knowledge_decisions_legacy (
                    id TEXT PRIMARY KEY,
                    candidate_id TEXT NOT NULL UNIQUE REFERENCES knowledge_fact_candidates(id),
                    decision TEXT NOT NULL CHECK(decision IN ('keep-current', 'adopt-new', 'split-scope', 'reject-candidate')),
                    actor_id TEXT NOT NULL,
                    actor_session_id TEXT NOT NULL,
                    expected_version INTEGER NOT NULL,
                    before_json TEXT,
                    after_json TEXT,
                    reason TEXT,
                    decided_at TEXT NOT NULL
                 );
                 INSERT INTO knowledge_decisions_legacy
                    (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
                     before_json, after_json, reason, decided_at)
                 SELECT id, candidate_id, decision, actor_id, actor_session_id, expected_version,
                    before_json, after_json, reason, decided_at
                 FROM knowledge_decisions;
                 DROP TABLE knowledge_decisions;
                 ALTER TABLE knowledge_decisions_legacy RENAME TO knowledge_decisions;
                 PRAGMA foreign_keys=ON;",
            )
            .unwrap();
        ensure_schema(&connection).unwrap();
        let schema_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_decisions'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(schema_sql.contains("adopt-edited"));
        let legacy_rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(legacy_rows, 1);
        // 迁移后同一连接可立即写入新决策类型。
        let second = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{\"tier\":\"pro\"}", None),
                "80",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let edited = store
            .decide_knowledge_candidate(KnowledgeDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-knowledge".into(),
                candidate_id: second.id,
                decision: "adopt-edited".into(),
                expected_current_version: 0,
                actor_id: "user-editor".into(),
                reason: None,
                split_key: None,
                split_expected_version: None,
                edited_normalized_value_json: Some("\"78\"".into()),
            })
            .unwrap();
        assert_eq!(edited.current.unwrap().normalized_value_json, "\"78\"");
    }

    #[test]
    fn adopt_edited_adopts_user_value_and_keeps_original_in_candidate_row() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let result = store
            .decide_knowledge_candidate(KnowledgeDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-knowledge".into(),
                candidate_id: candidate.id.clone(),
                decision: "adopt-edited".into(),
                expected_current_version: 0,
                actor_id: "user-editor".into(),
                reason: Some("价格口径修正".into()),
                split_key: None,
                split_expected_version: None,
                edited_normalized_value_json: Some("\"95\"".into()),
            })
            .unwrap();
        assert_eq!(result.status, "adopted");
        assert_eq!(result.decision, "adopt-edited");
        let current = result.current.expect("edited adoption creates current");
        assert_eq!(current.normalized_value_json, "\"95\"");
        assert_eq!(current.version, 1);
        assert_eq!(current.confirmed_by, "user-editor");
        assert!(result.knowledge_version.is_some());
        let stored = store
            .knowledge_candidate(&workspace.id, "session-knowledge", &candidate.id)
            .unwrap();
        assert_eq!(stored.normalized_value_json, "\"100\"");
        assert_eq!(stored.status, "adopted");
        let connection = open_database(&workspace).unwrap();
        let (decision, after_json): (String, String) = connection
            .query_row(
                "SELECT decision, after_json FROM knowledge_decisions WHERE candidate_id = ?1",
                [&candidate.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(decision, "adopt-edited");
        assert!(after_json.contains("95"));
    }

    #[test]
    fn adopt_edited_matching_current_merges_sources_without_fact_bump() {
        let (store, workspace) = fixture();
        let first = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, first);
        let duplicate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "120",
                1,
                "conflict",
            ))
            .unwrap();
        let result = store
            .decide_knowledge_candidate(KnowledgeDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-knowledge".into(),
                candidate_id: duplicate.id,
                decision: "adopt-edited".into(),
                expected_current_version: 1,
                actor_id: "user-editor".into(),
                reason: None,
                split_key: None,
                split_expected_version: None,
                edited_normalized_value_json: Some("\"100\"".into()),
            })
            .unwrap();
        assert_eq!(result.status, "adopted");
        let current = result.current.expect("merge keeps current");
        assert_eq!(current.version, 1);
        assert_eq!(current.normalized_value_json, "\"100\"");
        let connection = open_database(&workspace).unwrap();
        let sources: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_fact_sources WHERE fact_version = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(sources, 2);
        let versions: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_fact_versions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(versions, 0);
    }

    #[test]
    fn adopt_edited_requires_valid_edited_value_only_for_its_decision() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let request = |decision: &str, edited: Option<String>| KnowledgeDecisionRequest {
            workspace_id: workspace.id.clone(),
            session_id: "session-knowledge".into(),
            candidate_id: candidate.id.clone(),
            decision: decision.into(),
            expected_current_version: 0,
            actor_id: "user-editor".into(),
            reason: None,
            split_key: None,
            split_expected_version: None,
            edited_normalized_value_json: edited,
        };
        assert!(store
            .decide_knowledge_candidate(request("adopt-edited", None))
            .is_err());
        assert!(store
            .decide_knowledge_candidate(request("adopt-edited", Some("not-json".into())))
            .is_err());
        assert!(store
            .decide_knowledge_candidate(request("adopt-edited", Some("   ".into())))
            .is_err());
        assert_eq!(
            store
                .decide_knowledge_candidate(request("adopt-new", Some("\"95\"".into())))
                .unwrap_err(),
            "edited value is only valid for adopt-edited"
        );
        // 无效请求全部被拒后候选仍待确认，可继续正常裁决。
        let ok = store
            .decide_knowledge_candidate(request("adopt-edited", Some("\"96\"".into())))
            .unwrap();
        assert_eq!(ok.current.unwrap().normalized_value_json, "\"96\"");
    }

    fn industry_key() -> KnowledgeFactKey {
        KnowledgeFactKey {
            subject: "brand".into(),
            predicate: "enterprise-profile.industry".into(),
            scope_json: "{}".into(),
            effective_from: None,
            effective_to: None,
            identity: "brand|enterprise-profile.industry|{}||".into(),
        }
    }

    // 方案 D（GD-11）：零产品线品牌采纳「行业」事实后自愈——
    // 行业（领域级）写回品牌产品线；只增不删、去重；非行业事实不写。
    #[test]
    fn adopting_industry_fact_syncs_brand_product_lines() {
        let (store, workspace) = fixture();
        assert!(workspace.product_lines.is_empty());

        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                industry_key(),
                "汽车音响改装",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let result = adopt(&store, &workspace, candidate);
        assert_eq!(
            result.product_line_sync,
            Some(vec!["汽车音响改装".to_string()])
        );
        let healed = store.workspace(&workspace.id).unwrap();
        assert_eq!(healed.product_lines, vec!["汽车音响改装".to_string()]);

        let duplicate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                industry_key(),
                "汽车音响改装",
                1,
                "conflict",
            ))
            .unwrap();
        let merged = store
            .decide_knowledge_candidate(KnowledgeDecisionRequest {
                workspace_id: workspace.id.clone(),
                session_id: "session-knowledge".into(),
                candidate_id: duplicate.id,
                decision: "adopt-edited".into(),
                expected_current_version: 1,
                actor_id: "user-1".into(),
                reason: None,
                split_key: None,
                split_expected_version: None,
                edited_normalized_value_json: Some("\"汽车音响改装\"".into()),
            })
            .unwrap();
        assert_eq!(merged.product_line_sync, None);
        let after_merge = store.workspace(&workspace.id).unwrap();
        assert_eq!(after_merge.product_lines.len(), 1);

        let price = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let price_result = adopt(&store, &workspace, price);
        assert_eq!(price_result.product_line_sync, None);
        let final_workspace = store.workspace(&workspace.id).unwrap();
        assert_eq!(final_workspace.product_lines.len(), 1);
    }

    // 产品线叶子名（用户裁决 2026-09-01）：行业事实保持两级「大类/细分」
    // 口径，写回目录的产品线取细分叶子名——题库等下游闸门按叶子名精确
    // 匹配（现场「食堂干蒸菜档口」被拒即两级值整串入库所致）。
    #[test]
    fn adopting_two_level_industry_syncs_leaf_product_line() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                industry_key(),
                "餐饮/食堂干蒸菜档口",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let result = adopt(&store, &workspace, candidate);
        assert_eq!(
            result.product_line_sync,
            Some(vec!["食堂干蒸菜档口".to_string()])
        );
        assert_eq!(
            store.workspace(&workspace.id).unwrap().product_lines,
            vec!["食堂干蒸菜档口".to_string()]
        );
    }

    fn revision_request(
        workspace: &BrandWorkspace,
        action: &str,
        candidate_id: Option<&str>,
    ) -> KnowledgeRevisionRequest {
        KnowledgeRevisionRequest {
            workspace_id: workspace.id.clone(),
            session_id: "session-knowledge".into(),
            action: action.into(),
            candidate_id: candidate_id.map(str::to_string),
            actor_id: "desktop-user".into(),
            reason: "行业改成汽车后市场装具".into(),
            value_json: Some("\"汽车后市场装具\"".into()),
            normalized_value_json: Some("\"汽车后市场装具\"".into()),
            unit: None,
            submission: None,
        }
    }

    fn add_revision_submission(
        workspace: &BrandWorkspace,
        key: KnowledgeFactKey,
        value: &str,
        expected: i64,
        material_id: Option<&str>,
    ) -> KnowledgeCandidateSubmission {
        KnowledgeCandidateSubmission {
            workspace_id: workspace.id.clone(),
            session_id: "session-knowledge".into(),
            raw_input: "加一条核心产品：隐形车衣".into(),
            origin: "user-stated".into(),
            intent: "knowledge-update".into(),
            key,
            value_json: format!("[\"{value}\"]"),
            normalized_value_json: format!("[\"{value}\"]"),
            unit: None,
            source: KnowledgeSourceInput {
                material_id: material_id.map(str::to_string),
                excerpt: "加一条核心产品：隐形车衣".into(),
                confidence: 1.0,
                profile_provenance: Some("asked".into()),
            },
            expected_current_version: expected,
            disposition: "awaiting-confirmation".into(),
        }
    }

    fn revision_audit_rows(
        workspace: &BrandWorkspace,
        candidate_id: &str,
    ) -> Vec<(String, String)> {
        let connection = open_database(workspace).unwrap();
        let mut statement = connection
            .prepare(
                "SELECT action, reason FROM knowledge_candidate_revisions
                 WHERE candidate_id=?1 ORDER BY revised_at, id",
            )
            .unwrap();
        statement
            .query_map(params![candidate_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn chat_revision_modify_updates_value_upgrades_provenance_and_audits() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let revised = store
            .revise_knowledge_candidate(revision_request(&workspace, "modify", Some(&candidate.id)))
            .unwrap();
        assert_eq!(revised.status, "awaiting-confirmation");
        assert_eq!(revised.normalized_value_json, "\"汽车后市场装具\"");
        // inferred → asked：来源只升不降（ADR 0003）。
        assert_eq!(revised.source.profile_provenance.as_deref(), Some("asked"));
        let audits = revision_audit_rows(&workspace, &candidate.id);
        assert_eq!(audits.len(), 1);
        assert_eq!(
            audits[0],
            ("modify".into(), "行业改成汽车后市场装具".into())
        );
        // 修订不写权威、不升品牌知识版本、不产生决策审计。
        assert!(store
            .knowledge_current(
                &workspace.id,
                "session-knowledge",
                &key("{}", None).identity
            )
            .unwrap()
            .is_none());
        let connection = open_database(&workspace).unwrap();
        let decisions: i64 = connection
            .query_row("SELECT COUNT(*) FROM knowledge_decisions", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(decisions, 0);
    }

    #[test]
    fn chat_revision_modify_resets_conflict_and_keeps_extracted_provenance() {
        let (store, workspace) = fixture();
        let first = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, first);
        let mut conflicting_submission =
            submission(&workspace, key("{}", None), "120", 1, "conflict");
        conflicting_submission.source.profile_provenance = Some("extracted".into());
        let conflicting = store
            .submit_knowledge_candidate(conflicting_submission)
            .unwrap();
        assert_eq!(conflicting.status, "conflict");
        let revised = store
            .revise_knowledge_candidate(revision_request(
                &workspace,
                "modify",
                Some(&conflicting.id),
            ))
            .unwrap();
        // 用户显式改值即表达了对新值的选择：冲突行回到待确认，整卡确认时按
        // adopt-new 提交，不再要求二选一（ADR 0003）。
        assert_eq!(revised.status, "awaiting-confirmation");
        // extracted(3) > asked(2)：来源只升不降。
        assert_eq!(
            revised.source.profile_provenance.as_deref(),
            Some("extracted")
        );
    }

    #[test]
    fn chat_revision_delete_terminates_candidate_with_audit() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        let revised = store
            .revise_knowledge_candidate(revision_request(&workspace, "delete", Some(&candidate.id)))
            .unwrap();
        assert_eq!(revised.status, "rejected");
        assert!(revised.current.is_none());
        let audits = revision_audit_rows(&workspace, &candidate.id);
        assert_eq!(audits.len(), 1);
        assert_eq!(
            audits[0],
            ("delete".into(), "行业改成汽车后市场装具".into())
        );
    }

    #[test]
    fn chat_revision_add_creates_user_stated_candidate_and_joins_material_card() {
        let (store, workspace) = fixture();
        let connection = open_database(&workspace).unwrap();
        connection
            .execute(
                "INSERT INTO brand_materials
                    (id, imported_by_session_id, input_kind, display_name, file_ext, media_type,
                     relative_path, byte_size, sha256, source_json, status, attempt_count,
                     created_at, updated_at)
                 VALUES ('material-revise', 'session-knowledge', 'pasted-text', '资料', '.txt',
                         'text/plain', 'materials/material-revise.txt', 1, 'hash', '{}',
                         'processed', 1, '2026-08-15T00:00:00Z', '2026-08-15T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO brand_material_processing
                    (id, material_id, session_id, attempt_number, status, candidate_ids_json,
                     error_code, started_at, finished_at)
                 VALUES ('attempt-1', 'material-revise', 'session-knowledge', 1,
                         'awaiting-confirmation', '[]', NULL, '2026-08-15T00:00:00Z',
                         '2026-08-15T00:00:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let mut request = revision_request(&workspace, "add", None);
        request.reason = "加一条核心产品：隐形车衣".into();
        request.submission = Some(add_revision_submission(
            &workspace,
            key("{}", None),
            "隐形车衣",
            0,
            Some("material-revise"),
        ));
        let added = store.revise_knowledge_candidate(request).unwrap();
        assert_eq!(added.status, "awaiting-confirmation");
        assert_eq!(added.origin, "user-stated");
        assert_eq!(added.intent, "knowledge-update");
        assert_eq!(added.source.profile_provenance.as_deref(), Some("asked"));
        assert_eq!(added.source.material_id.as_deref(), Some("material-revise"));
        assert_eq!(
            revision_audit_rows(&workspace, &added.id),
            vec![("add".into(), "加一条核心产品：隐形车衣".into())]
        );

        // 新候选挂回材料最新 attempt：复核卡轮询据此重渲染出新行；
        // 已 processed 的材料被拉回 awaiting-confirmation。
        let connection = open_database(&workspace).unwrap();
        let ids_json: String = connection
            .query_row(
                "SELECT candidate_ids_json FROM brand_material_processing WHERE id='attempt-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ids_json, format!("[\"{}\"]", added.id));
        let material_status: String = connection
            .query_row(
                "SELECT status FROM brand_materials WHERE id='material-revise'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(material_status, "awaiting-confirmation");
    }

    #[test]
    fn chat_revision_add_deduplicates_identical_pending_submissions() {
        let (store, workspace) = fixture();
        let mut request = revision_request(&workspace, "add", None);
        request.reason = "加一条核心产品：隐形车衣".into();
        let submission = add_revision_submission(&workspace, key("{}", None), "隐形车衣", 0, None);
        request.submission = Some(submission.clone());
        let first = store.revise_knowledge_candidate(request.clone()).unwrap();
        let second = store.revise_knowledge_candidate(request).unwrap();
        assert_eq!(first.id, second.id);
        // 两次显式新增各写一条审计；候选行仍只有一条。
        assert_eq!(revision_audit_rows(&workspace, &first.id).len(), 2);
        let connection = open_database(&workspace).unwrap();
        let candidates: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM knowledge_fact_candidates",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(candidates, 1);
    }

    #[test]
    fn chat_revision_rejects_terminal_and_foreign_targets() {
        let (store, workspace) = fixture();
        let candidate = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "100",
                0,
                "awaiting-confirmation",
            ))
            .unwrap();
        adopt(&store, &workspace, candidate.clone());
        let terminal = store
            .revise_knowledge_candidate(revision_request(&workspace, "delete", Some(&candidate.id)))
            .unwrap_err();
        assert!(terminal.contains("no longer pending"));

        let pending = store
            .submit_knowledge_candidate(submission(
                &workspace,
                key("{}", None),
                "130",
                1,
                "conflict",
            ))
            .unwrap();
        // 跨 Session/品牌的候选读不到（行级 session 过滤）。
        let mut foreign = revision_request(&workspace, "delete", Some(&pending.id));
        foreign.session_id = "session-other".into();
        let missing = store.revise_knowledge_candidate(foreign).unwrap_err();
        assert!(missing.contains("not found for this Session"));
    }

    #[test]
    fn chat_revision_requires_actor_and_instruction() {
        let (store, workspace) = fixture();
        let mut no_actor = revision_request(&workspace, "delete", Some("any"));
        no_actor.actor_id = "  ".into();
        assert!(store
            .revise_knowledge_candidate(no_actor)
            .unwrap_err()
            .contains("requires a confirmed actor"));
        let mut no_reason = revision_request(&workspace, "delete", Some("any"));
        no_reason.reason = " ".into();
        assert!(store
            .revise_knowledge_candidate(no_reason)
            .unwrap_err()
            .contains("explicit instruction"));
        assert!(store
            .revise_knowledge_candidate(revision_request(&workspace, "bogus", None))
            .unwrap_err()
            .contains("invalid knowledge revision action"));
    }
}
