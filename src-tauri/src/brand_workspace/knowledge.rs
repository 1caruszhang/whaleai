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
                decision TEXT NOT NULL CHECK(decision IN ('keep-current', 'adopt-new', 'split-scope', 'reject-candidate')),
                actor_id TEXT NOT NULL,
                actor_session_id TEXT NOT NULL,
                expected_version INTEGER NOT NULL,
                before_json TEXT,
                after_json TEXT,
                reason TEXT,
                decided_at TEXT NOT NULL
             );
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
    )
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
            transaction
                .commit()
                .map_err(|error| format!("commit knowledge candidate lookup: {error}"))?;
            return self.knowledge_candidate(
                &request.workspace_id,
                &request.session_id,
                &candidate_id,
            );
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
        let before = read_current(&transaction, &candidate.key.identity)?;
        require_version(before.as_ref(), request.expected_current_version)?;
        let now = Utc::now().to_rfc3339();

        let (status, after) = match request.decision.as_str() {
            "keep-current" => {
                if before.is_none() {
                    return Err("keep-current requires an existing current fact".to_string());
                }
                ("kept-current", before.clone())
            }
            "reject-candidate" => ("rejected", before.clone()),
            "adopt-new" => {
                let next = if before.as_ref().is_some_and(|current| {
                    current.normalized_value_json == candidate.normalized_value_json
                        && current.unit == candidate.unit
                }) {
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
                ("adopted", Some(next))
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
                ("split-scope", Some(next))
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
            &request.candidate_id,
            &request.decision,
            &request.actor_id,
            &request.session_id,
            request.expected_current_version,
            before.as_ref(),
            after.as_ref(),
            request.reason.as_deref(),
            &now,
        )?;
        let knowledge_version = if matches!(request.decision.as_str(), "adopt-new" | "split-scope")
        {
            Some(snapshot_brand_knowledge(
                &transaction,
                &decision_id,
                &request.session_id,
                &now,
            )?)
        } else {
            None
        };
        if let Some(material_id) = candidate.source.material_id.as_deref() {
            let unresolved: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM knowledge_fact_candidates
                     WHERE material_id=?1 AND status IN ('awaiting-confirmation','conflict')",
                    [material_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("count material candidates: {error}"))?;
            if unresolved == 0 {
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
            }
        }
        transaction
            .commit()
            .map_err(|error| format!("commit knowledge decision: {error}"))?;
        Ok(KnowledgeDecisionResult {
            candidate_id: request.candidate_id,
            fact_key: candidate.key.identity,
            decision: request.decision,
            status: status.to_string(),
            current: after,
            knowledge_version,
        })
    }
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
        &key.identity,
        version,
        &candidate.id,
        &raw_input_id,
        &candidate.source,
        &candidate.origin,
        now,
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
        &current.key.identity,
        current.version,
        &candidate.id,
        &raw_input_id,
        &candidate.source,
        &candidate.origin,
        now,
    )?;
    read_current(transaction, &current.key.identity)?
        .ok_or_else(|| "current fact missing after source merge".to_string())
}

fn insert_source(
    transaction: &rusqlite::Transaction<'_>,
    fact_key: &str,
    version: i64,
    candidate_id: &str,
    raw_input_id: &str,
    source: &KnowledgeSourceInput,
    origin: &str,
    now: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT OR IGNORE INTO knowledge_fact_sources
            (id, fact_key, fact_version, candidate_id, raw_input_id, material_id, excerpt,
             confidence, profile_provenance, origin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                Uuid::new_v4().to_string(),
                fact_key,
                version,
                candidate_id,
                raw_input_id,
                source.material_id,
                source.excerpt,
                source.confidence,
                source.profile_provenance,
                origin,
                now
            ],
        )
        .map_err(|error| format!("store knowledge source: {error}"))?;
    Ok(())
}

fn insert_audit(
    transaction: &rusqlite::Transaction<'_>,
    candidate_id: &str,
    decision: &str,
    actor_id: &str,
    session_id: &str,
    expected_version: i64,
    before: Option<&KnowledgeCurrentFact>,
    after: Option<&KnowledgeCurrentFact>,
    reason: Option<&str>,
    now: &str,
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
                candidate_id,
                decision,
                actor_id,
                session_id,
                expected_version,
                serde_json::to_string(&before).map_err(|e| e.to_string())?,
                serde_json::to_string(&after).map_err(|e| e.to_string())?,
                reason,
                now
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
        assert_eq!(versions, 2);
        assert_eq!(
            (old_value.as_str(), new_value.as_str()),
            ("\"100\"", "\"110\"")
        );
        assert_eq!(artifact_version, 1);
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
}
