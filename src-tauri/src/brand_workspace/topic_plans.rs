use super::*;
use rusqlite::TransactionBehavior;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const POLICY_VERSION: &str = "xiaojing-content-prompt-v2";
const MAX_ITEMS: usize = 50;
const MAX_CONFIRMED_ITEMS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanKnowledgeFact {
    pub fact_key: String,
    pub subject: String,
    pub predicate: String,
    pub scope_json: String,
    pub normalized_value_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanSourceQuestion {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanContext {
    pub question_pool_id: String,
    pub question_pool_revision: i64,
    pub knowledge_version: i64,
    pub product_line: String,
    pub target_region: String,
    pub brand_name: String,
    pub questions: Vec<TopicPlanSourceQuestion>,
    pub facts: Vec<TopicPlanKnowledgeFact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanProjection {
    pub id: String,
    pub operation_id: String,
    pub workspace_id: String,
    pub question_pool_id: String,
    pub question_pool_revision: i64,
    pub knowledge_version: i64,
    pub product_line: String,
    pub target_region: String,
    pub policy_version: String,
    pub status: String,
    pub revision: i64,
    pub topics: Value,
    pub items: Value,
    pub selected_item_ids: Vec<String>,
    pub model_audit: Value,
    pub provider_snapshot: Value,
    pub model_attempts: Value,
    pub reused: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanPreparation {
    pub context: TopicPlanContext,
    pub existing: Option<TopicPlanProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanLatestRequest {
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanGetRequest {
    pub plan_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanPrepareRequest {
    pub question_pool_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanCreateRequest {
    pub question_pool_id: String,
    pub question_pool_revision: i64,
    pub knowledge_version: i64,
    pub policy_version: String,
    pub topics: Value,
    pub items: Value,
    pub model_audit: Value,
    pub provider_snapshot: Value,
    pub model_attempts: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanMutationRequest {
    pub plan_id: String,
    pub expected_revision: i64,
    pub kind: String,
    pub items: Value,
    pub target_item_ids: Vec<String>,
    pub preserved_item_ids: Vec<String>,
    pub actor_id: String,
    #[serde(default)]
    pub model_attempts: Value,
    /// 聊天修订（票 38）携带的用户指令原文，写入 mutations 审计。
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanMutationResult {
    pub plan: TopicPlanProjection,
    pub mutation_id: String,
    pub preserved_item_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanConfirmRequest {
    pub plan_id: String,
    pub expected_revision: i64,
    pub selected_item_ids: Vec<String>,
    pub actor_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopicPlanConfirmation {
    pub plan_id: String,
    pub decision_id: String,
    pub expected_revision: i64,
    pub revision: i64,
    pub question_pool_id: String,
    pub question_pool_revision: i64,
    pub knowledge_version: i64,
    pub selected_item_ids: Vec<String>,
    pub actor_id: String,
    pub decided_at: String,
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_topic_plans (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                question_pool_id TEXT NOT NULL REFERENCES geo_question_pools(id),
                question_pool_revision INTEGER NOT NULL,
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                product_line TEXT NOT NULL,
                target_region TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('awaiting-confirmation','confirmed')),
                revision INTEGER NOT NULL DEFAULT 0,
                topics_json TEXT NOT NULL,
                items_json TEXT NOT NULL,
                selected_item_ids_json TEXT NOT NULL DEFAULT '[]',
                model_audit_json TEXT NOT NULL,
                provider_snapshot_json TEXT NOT NULL,
                model_attempts_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS geo_topic_plan_source_identity
                ON geo_topic_plans(question_pool_id, question_pool_revision, knowledge_version, policy_version);
             CREATE INDEX IF NOT EXISTS geo_topic_plan_latest
                ON geo_topic_plans(updated_at DESC, id DESC);
             CREATE TABLE IF NOT EXISTS geo_topic_plan_mutations (
                id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL REFERENCES geo_topic_plans(id),
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('user-edit','partial-regeneration')),
                expected_revision INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                items_json TEXT NOT NULL,
                target_item_ids_json TEXT NOT NULL,
                preserved_item_ids_json TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(plan_id, revision)
             );
             CREATE TABLE IF NOT EXISTS geo_topic_plan_decisions (
                id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL UNIQUE REFERENCES geo_topic_plans(id),
                session_id TEXT NOT NULL,
                expected_revision INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                selected_item_ids_json TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                decided_at TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("initialize topic plan schema: {error}"))?;
    super::ensure_column(
        connection,
        "geo_topic_plan_mutations",
        "reason",
        "TEXT",
    )?;
    super::drop_brand_sessions_foreign_keys(
        connection,
        &[
            "geo_topic_plans",
            "geo_topic_plan_mutations",
            "geo_topic_plan_decisions",
        ],
    )
}

impl BrandWorkspaceStore {
    pub fn latest_topic_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: TopicPlanLatestRequest,
    ) -> Result<Option<TopicPlanProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_topic_plan_session(&connection, session_id)?;
        if request
            .status
            .as_deref()
            .is_some_and(|status| status != "confirmed")
        {
            return Err("topic_plan_status_filter_invalid".to_string());
        }
        let plan_id: Option<String> = connection
            .query_row(
                "SELECT id FROM geo_topic_plans
                 WHERE (?1 IS NULL OR status=?1)
                   AND (status='confirmed' OR created_by_session_id=?2)
                 ORDER BY updated_at DESC, id DESC LIMIT 1",
                params![request.status.as_deref(), session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read latest topic plan: {error}"))?;
        plan_id
            .map(|id| read_topic_plan(&connection, workspace_id, &id, true))
            .transpose()
    }

    pub fn get_topic_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: TopicPlanGetRequest,
    ) -> Result<Option<TopicPlanProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_topic_plan_session(&connection, session_id)?;
        let visibility: Option<(String, String)> = connection
            .query_row(
                "SELECT created_by_session_id, status FROM geo_topic_plans WHERE id=?1",
                [&request.plan_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("inspect topic plan: {error}"))?;
        let Some((created_by_session_id, status)) = visibility else {
            return Ok(None);
        };
        if created_by_session_id != session_id && status != "confirmed" {
            return Err("topic_plan_draft_session_mismatch".to_string());
        }
        read_topic_plan(&connection, workspace_id, &request.plan_id, false).map(Some)
    }

    pub fn prepare_topic_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: TopicPlanPrepareRequest,
    ) -> Result<TopicPlanPreparation, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_topic_plan_session(&connection, session_id)?;
        let context =
            read_topic_plan_context(&connection, &workspace, request.question_pool_id.as_deref())?;
        let existing_id: Option<String> = connection
            .query_row(
                "SELECT id FROM geo_topic_plans
                 WHERE question_pool_id=?1 AND question_pool_revision=?2
                   AND knowledge_version=?3 AND policy_version=?4
                   AND (status='confirmed' OR created_by_session_id=?5)
                 ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1",
                params![
                    context.question_pool_id,
                    context.question_pool_revision,
                    context.knowledge_version,
                    POLICY_VERSION,
                    session_id
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("find reusable topic plan: {error}"))?;
        let existing = existing_id
            .map(|id| read_topic_plan(&connection, workspace_id, &id, true))
            .transpose()?;
        Ok(TopicPlanPreparation { context, existing })
    }

    pub fn create_topic_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: TopicPlanCreateRequest,
    ) -> Result<TopicPlanProjection, String> {
        if request.policy_version != POLICY_VERSION {
            return Err("topic_plan_policy_version_invalid".to_string());
        }
        validate_topic_plan_payload(&request.topics, &request.items)?;
        if !request.model_audit.is_object() {
            return Err("topic_plan_model_audit_invalid".to_string());
        }
        if !request.provider_snapshot.is_object() || !request.model_attempts.is_array() {
            return Err("topic_plan_provider_audit_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_topic_plan_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start topic plan create: {error}"))?;
        let context =
            read_topic_plan_context(&transaction, &workspace, Some(&request.question_pool_id))?;
        if context.question_pool_revision != request.question_pool_revision
            || context.knowledge_version != request.knowledge_version
        {
            return Err("topic_plan_source_snapshot_changed".to_string());
        }
        validate_topic_question_coverage(&request.topics, &context.questions)?;
        validate_fixed_fact_keys(&transaction, request.knowledge_version, &request.items)?;
        let existing_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM geo_topic_plans
                 WHERE question_pool_id=?1 AND question_pool_revision=?2
                   AND knowledge_version=?3 AND policy_version=?4
                   AND (status='confirmed' OR created_by_session_id=?5)
                 LIMIT 1",
                params![
                    request.question_pool_id,
                    request.question_pool_revision,
                    request.knowledge_version,
                    request.policy_version,
                    session_id
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("inspect existing topic plan: {error}"))?;
        if let Some(existing_id) = existing_id {
            transaction
                .commit()
                .map_err(|error| format!("commit topic plan reuse: {error}"))?;
            return read_topic_plan(&connection, workspace_id, &existing_id, true);
        }
        let operation_id = Uuid::new_v4().to_string();
        let plan_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES (?1, ?2, 'topic-plan-awaiting-confirmation', ?3)",
                params![operation_id, session_id, now],
            )
            .map_err(|error| format!("create topic plan operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_artifacts (id, operation_id, session_id, kind, knowledge_version, created_at)
                 VALUES (?1, ?2, ?3, 'topic-plan', ?4, ?5)",
                params![plan_id, operation_id, session_id, request.knowledge_version, now],
            )
            .map_err(|error| format!("create topic plan artifact: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_topic_plans
                    (id, operation_id, created_by_session_id, question_pool_id,
                     question_pool_revision, knowledge_version, product_line, target_region,
                     policy_version, status, revision, topics_json, items_json,
                     selected_item_ids_json, model_audit_json, provider_snapshot_json,
                     model_attempts_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                         'awaiting-confirmation', 0, ?10, ?11, '[]', ?12, ?13, ?14, ?15, ?15)",
                params![
                    plan_id,
                    operation_id,
                    session_id,
                    request.question_pool_id,
                    request.question_pool_revision,
                    request.knowledge_version,
                    context.product_line,
                    context.target_region,
                    request.policy_version,
                    canonical_json(&request.topics)?,
                    canonical_json(&request.items)?,
                    canonical_json(&request.model_audit)?,
                    canonical_json(&request.provider_snapshot)?,
                    canonical_json(&request.model_attempts)?,
                    now
                ],
            )
            .map_err(|error| format!("persist topic plan: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit topic plan create: {error}"))?;
        read_topic_plan(&connection, workspace_id, &plan_id, false)
    }

    pub fn mutate_topic_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: TopicPlanMutationRequest,
    ) -> Result<TopicPlanMutationResult, String> {
        if !matches!(request.kind.as_str(), "user-edit" | "partial-regeneration") {
            return Err("topic_plan_mutation_kind_invalid".to_string());
        }
        if (request.kind == "user-edit" && request.actor_id != "desktop-user")
            || (request.kind == "partial-regeneration" && request.actor_id != "geo-domain")
        {
            return Err("topic_plan_actor_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_topic_plan_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start topic plan mutation: {error}"))?;
        let (
            revision,
            status,
            current_topics,
            current_items,
            knowledge_version,
            current_attempts,
            created_by_session_id,
        ): (i64, String, String, String, i64, String, String) = transaction
            .query_row(
                "SELECT revision, status, topics_json, items_json, knowledge_version,
                        model_attempts_json, created_by_session_id
                 FROM geo_topic_plans WHERE id=?1",
                [&request.plan_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read topic plan for mutation: {error}"))?
            .ok_or_else(|| "topic_plan_not_found".to_string())?;
        if created_by_session_id != session_id {
            return Err("topic_plan_draft_session_mismatch".to_string());
        }
        if status == "confirmed" {
            return Err("topic_plan_confirmed_immutable".to_string());
        }
        if revision != request.expected_revision {
            return Err("topic_plan_revision_conflict".to_string());
        }
        let topics: Value = serde_json::from_str(&current_topics)
            .map_err(|error| format!("parse topic plan topics: {error}"))?;
        validate_topic_plan_payload(&topics, &request.items)?;
        validate_fixed_fact_keys(&transaction, knowledge_version, &request.items)?;
        if request.kind == "partial-regeneration" {
            validate_regeneration_protection(
                &current_items,
                &request.items,
                &request.target_item_ids,
                &request.preserved_item_ids,
            )?;
        }
        let next_revision = revision + 1;
        let mutation_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let items_json = canonical_json(&request.items)?;
        let mut attempts: Vec<Value> = serde_json::from_str(&current_attempts)
            .map_err(|error| format!("parse topic plan model attempts: {error}"))?;
        let new_attempts = request
            .model_attempts
            .as_array()
            .ok_or_else(|| "topic_plan_model_attempts_invalid".to_string())?;
        attempts.extend(new_attempts.iter().cloned());
        let attempts_json = canonical_json(&attempts)?;
        transaction
            .execute(
                "INSERT INTO geo_topic_plan_mutations
                    (id, plan_id, session_id, kind, expected_revision, revision, items_json,
                     target_item_ids_json, preserved_item_ids_json, actor_id, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    mutation_id,
                    request.plan_id,
                    session_id,
                    request.kind,
                    revision,
                    next_revision,
                    items_json,
                    canonical_json(&request.target_item_ids)?,
                    canonical_json(&request.preserved_item_ids)?,
                    request.actor_id,
                    request.reason,
                    now
                ],
            )
            .map_err(|error| format!("audit topic plan mutation: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_topic_plans SET items_json=?2, revision=?3, updated_at=?4,
                     model_attempts_json=?6
                 WHERE id=?1 AND revision=?5 AND status='awaiting-confirmation'",
                params![
                    request.plan_id,
                    items_json,
                    next_revision,
                    now,
                    revision,
                    attempts_json
                ],
            )
            .map_err(|error| format!("apply topic plan mutation: {error}"))?;
        if changed != 1 {
            return Err("topic_plan_revision_conflict".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("commit topic plan mutation: {error}"))?;
        Ok(TopicPlanMutationResult {
            plan: read_topic_plan(&connection, workspace_id, &request.plan_id, false)?,
            mutation_id,
            preserved_item_ids: request.preserved_item_ids,
        })
    }

    pub fn confirm_topic_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: TopicPlanConfirmRequest,
    ) -> Result<TopicPlanConfirmation, String> {
        if request.actor_id != "desktop-user" {
            return Err("topic_plan_actor_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_topic_plan_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start topic plan confirmation: {error}"))?;
        let (
            revision,
            status,
            operation_id,
            question_pool_id,
            question_pool_revision,
            knowledge_version,
            items_json,
            created_by_session_id,
        ): (i64, String, String, String, i64, i64, String, String) = transaction
            .query_row(
                "SELECT revision, status, operation_id, question_pool_id,
                        question_pool_revision, knowledge_version, items_json,
                        created_by_session_id
                 FROM geo_topic_plans WHERE id=?1",
                [&request.plan_id],
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
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("read topic plan for confirmation: {error}"))?
            .ok_or_else(|| "topic_plan_not_found".to_string())?;
        if created_by_session_id != session_id {
            return Err("topic_plan_draft_session_mismatch".to_string());
        }
        if status == "confirmed" {
            return Err("topic_plan_confirmed_immutable".to_string());
        }
        if revision != request.expected_revision {
            return Err("topic_plan_revision_conflict".to_string());
        }
        validate_confirmed_items(&items_json, &request.selected_item_ids)?;
        let current_knowledge: i64 = transaction
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM knowledge_versions",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("read current knowledge version: {error}"))?;
        let (pool_status, pool_revision): (String, i64) = transaction
            .query_row(
                "SELECT status, revision FROM geo_question_pools WHERE id=?1",
                [&question_pool_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("read topic plan question pool: {error}"))?;
        if current_knowledge != knowledge_version
            || pool_status != "confirmed"
            || pool_revision != question_pool_revision
        {
            return Err("topic_plan_source_snapshot_changed".to_string());
        }
        let decision_id = Uuid::new_v4().to_string();
        let next_revision = revision + 1;
        let selected_json = canonical_json(&request.selected_item_ids)?;
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_topic_plan_decisions
                    (id, plan_id, session_id, expected_revision, revision,
                     selected_item_ids_json, actor_id, decided_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    decision_id,
                    request.plan_id,
                    session_id,
                    revision,
                    next_revision,
                    selected_json,
                    request.actor_id,
                    now
                ],
            )
            .map_err(|error| format!("store topic plan confirmation: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_topic_plans SET status='confirmed', revision=?2,
                     selected_item_ids_json=?3, updated_at=?4
                 WHERE id=?1 AND revision=?5 AND status='awaiting-confirmation'",
                params![request.plan_id, next_revision, selected_json, now, revision],
            )
            .map_err(|error| format!("confirm topic plan: {error}"))?;
        if changed != 1 {
            return Err("topic_plan_revision_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_operations SET state='topic-plan-confirmed' WHERE id=?1",
                [operation_id],
            )
            .map_err(|error| format!("advance topic plan operation: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit topic plan confirmation: {error}"))?;
        Ok(TopicPlanConfirmation {
            plan_id: request.plan_id,
            decision_id,
            expected_revision: revision,
            revision: next_revision,
            question_pool_id,
            question_pool_revision,
            knowledge_version,
            selected_item_ids: request.selected_item_ids,
            actor_id: request.actor_id,
            decided_at: now,
        })
    }
}

fn read_topic_plan_context(
    connection: &Connection,
    workspace: &BrandWorkspace,
    requested_pool_id: Option<&str>,
) -> Result<TopicPlanContext, String> {
    let pool_id: String = if let Some(pool_id) = requested_pool_id {
        pool_id.trim().to_string()
    } else {
        connection
            .query_row(
                "SELECT id FROM geo_question_pools WHERE status='confirmed'
                 ORDER BY updated_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read confirmed question pool: {error}"))?
            .ok_or_else(|| "topic_plan_confirmed_question_pool_required".to_string())?
    };
    let (knowledge_version, product_line, target_region, pool_status, pool_revision): (
        i64,
        String,
        String,
        String,
        i64,
    ) = connection
        .query_row(
            "SELECT knowledge_version, product_line, target_region, status, revision
             FROM geo_question_pools WHERE id=?1",
            [&pool_id],
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
        .map_err(|error| format!("read topic plan source pool: {error}"))?
        .ok_or_else(|| "topic_plan_question_pool_not_found".to_string())?;
    if pool_status != "confirmed" {
        return Err("topic_plan_confirmed_question_pool_required".to_string());
    }
    let current_knowledge: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM knowledge_versions",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("read current knowledge version: {error}"))?;
    if current_knowledge != knowledge_version {
        return Err("topic_plan_source_snapshot_changed".to_string());
    }
    let (questions_json, selected_ids_json): (String, String) = connection
        .query_row(
            "SELECT questions_json, selected_question_ids_json
             FROM geo_question_pool_decisions WHERE pool_id=?1
             ORDER BY revision DESC LIMIT 1",
            [&pool_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("read confirmed question selection: {error}"))?
        .ok_or_else(|| "topic_plan_question_pool_decision_required".to_string())?;
    let questions_value: Value = serde_json::from_str(&questions_json)
        .map_err(|error| format!("parse topic plan questions: {error}"))?;
    let selected_ids: Vec<String> = serde_json::from_str(&selected_ids_json)
        .map_err(|error| format!("parse selected question ids: {error}"))?;
    let selected = selected_ids.into_iter().collect::<HashSet<_>>();
    let questions = questions_value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|question| {
            let id = question.get("id")?.as_str()?.to_string();
            if !selected.contains(&id) {
                return None;
            }
            Some(TopicPlanSourceQuestion {
                id,
                text: question.get("text")?.as_str()?.to_string(),
            })
        })
        .collect::<Vec<_>>();
    if questions.is_empty() || questions.len() != selected.len() {
        return Err("topic_plan_confirmed_questions_invalid".to_string());
    }
    let mut statement = connection
        .prepare(
            "SELECT snapshot.fact_key, current.subject, current.predicate, current.scope_json,
                    snapshot.normalized_value_json
             FROM knowledge_version_facts snapshot
             JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1 ORDER BY snapshot.fact_key",
        )
        .map_err(|error| format!("prepare topic plan facts: {error}"))?;
    let facts = statement
        .query_map([knowledge_version], |row| {
            Ok(TopicPlanKnowledgeFact {
                fact_key: row.get(0)?,
                subject: row.get(1)?,
                predicate: row.get(2)?,
                scope_json: row.get(3)?,
                normalized_value_json: row.get(4)?,
            })
        })
        .map_err(|error| format!("query topic plan facts: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read topic plan facts: {error}"))?;
    if facts.is_empty() {
        return Err("topic_plan_knowledge_snapshot_empty".to_string());
    }
    Ok(TopicPlanContext {
        question_pool_id: pool_id,
        question_pool_revision: pool_revision,
        knowledge_version,
        product_line,
        target_region,
        brand_name: workspace.name.clone(),
        questions,
        facts,
    })
}

fn read_topic_plan(
    connection: &Connection,
    workspace_id: &str,
    plan_id: &str,
    reused: bool,
) -> Result<TopicPlanProjection, String> {
    connection
        .query_row(
            "SELECT id, operation_id, question_pool_id, question_pool_revision,
                    knowledge_version, product_line, target_region, policy_version,
                    status, revision, topics_json, items_json, selected_item_ids_json,
                    model_audit_json, provider_snapshot_json, model_attempts_json,
                    created_at, updated_at
             FROM geo_topic_plans WHERE id=?1",
            [plan_id],
            |row| {
                let topics: String = row.get(10)?;
                let items: String = row.get(11)?;
                let selected: String = row.get(12)?;
                let audit: String = row.get(13)?;
                let provider_snapshot: String = row.get(14)?;
                let model_attempts: String = row.get(15)?;
                Ok(TopicPlanProjection {
                    id: row.get(0)?,
                    operation_id: row.get(1)?,
                    workspace_id: workspace_id.to_string(),
                    question_pool_id: row.get(2)?,
                    question_pool_revision: row.get(3)?,
                    knowledge_version: row.get(4)?,
                    product_line: row.get(5)?,
                    target_region: row.get(6)?,
                    policy_version: row.get(7)?,
                    status: row.get(8)?,
                    revision: row.get(9)?,
                    topics: serde_json::from_str(&topics).unwrap_or(Value::Array(vec![])),
                    items: serde_json::from_str(&items).unwrap_or(Value::Array(vec![])),
                    selected_item_ids: serde_json::from_str(&selected).unwrap_or_default(),
                    model_audit: serde_json::from_str(&audit).unwrap_or(Value::Null),
                    provider_snapshot: serde_json::from_str(&provider_snapshot)
                        .unwrap_or(Value::Null),
                    model_attempts: serde_json::from_str(&model_attempts)
                        .unwrap_or(Value::Array(vec![])),
                    reused,
                    created_at: row.get(16)?,
                    updated_at: row.get(17)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read topic plan: {error}"))?
        .ok_or_else(|| "topic_plan_not_found".to_string())
}

fn require_topic_plan_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM brand_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("validate topic plan session: {error}"))?;
    if exists == 1 {
        Ok(())
    } else {
        Err("topic_plan_session_not_committed".to_string())
    }
}

fn canonical_json<T: ?Sized + Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("serialize topic plan JSON: {error}"))
}

fn validate_fixed_fact_keys(
    connection: &Connection,
    knowledge_version: i64,
    items: &Value,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            "SELECT snapshot.fact_key, current.predicate, snapshot.normalized_value_json
             FROM knowledge_version_facts snapshot
             JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1",
        )
        .map_err(|error| format!("prepare topic plan fact-key validation: {error}"))?;
    let allowed = statement
        .query_map([knowledge_version], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, String>(2)?),
            ))
        })
        .map_err(|error| format!("query topic plan fact-key validation: {error}"))?
        .collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("read topic plan fact-key validation: {error}"))?;
    for item in items.as_array().into_iter().flatten() {
        let facts = item
            .get("plannedFacts")
            .and_then(Value::as_array)
            .ok_or_else(|| "topic_plan_item_links_invalid".to_string())?;
        for fact in facts {
            let fact_key =
                required_string(fact, "factKey", 500, "topic_plan_knowledge_fact_invalid")?;
            let predicate =
                required_string(fact, "predicate", 500, "topic_plan_knowledge_fact_invalid")?;
            let normalized = required_string(
                fact,
                "normalizedValueJson",
                10_000,
                "topic_plan_knowledge_fact_invalid",
            )?;
            if allowed
                .get(fact_key)
                .map(|(stored_predicate, stored_normalized)| {
                    (stored_predicate.as_str(), stored_normalized.as_str())
                })
                != Some((predicate, normalized))
            {
                return Err("topic_plan_knowledge_fact_not_in_snapshot".to_string());
            }
        }
    }
    Ok(())
}

fn validate_topic_plan_payload(topics: &Value, items: &Value) -> Result<(), String> {
    let topic_list = topics
        .as_array()
        .filter(|list| !list.is_empty())
        .ok_or_else(|| "topic_plan_topics_invalid".to_string())?;
    let mut topic_ids = HashSet::new();
    let mut topic_questions = HashMap::<String, HashSet<String>>::new();
    let mut question_ids = HashSet::new();
    for topic in topic_list {
        let id = required_string(topic, "id", 100, "topic_plan_topic_id_invalid")?;
        required_string(topic, "name", 80, "topic_plan_topic_name_invalid")?;
        required_string(topic, "summary", 500, "topic_plan_topic_summary_invalid")?;
        required_string(
            topic,
            "namingReason",
            500,
            "topic_plan_topic_reason_invalid",
        )?;
        if !topic_ids.insert(id.to_string()) {
            return Err("topic_plan_topic_id_duplicate".to_string());
        }
        let ids = topic
            .get("questionIds")
            .and_then(Value::as_array)
            .filter(|ids| !ids.is_empty())
            .ok_or_else(|| "topic_plan_topic_questions_invalid".to_string())?;
        for question_id in ids {
            let value = question_id
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "topic_plan_topic_questions_invalid".to_string())?;
            if !question_ids.insert(value.to_string()) {
                return Err("topic_plan_question_assignment_invalid".to_string());
            }
            topic_questions
                .entry(id.to_string())
                .or_default()
                .insert(value.to_string());
        }
    }
    validate_items(items)?;
    for item in items.as_array().into_iter().flatten() {
        let topic_id = required_string(item, "topicId", 100, "topic_plan_item_invalid")?;
        if !topic_ids.contains(topic_id) {
            return Err("topic_plan_item_topic_invalid".to_string());
        }
        let source_question_ids = item
            .get("sourceQuestionIds")
            .and_then(Value::as_array)
            .ok_or_else(|| "topic_plan_item_links_invalid".to_string())?;
        if source_question_ids.iter().any(|question_id| {
            question_id
                .as_str()
                .is_none_or(|id| !topic_questions[topic_id].contains(id))
        }) {
            return Err("topic_plan_item_question_link_invalid".to_string());
        }
    }
    Ok(())
}

fn validate_topic_question_coverage(
    topics: &Value,
    questions: &[TopicPlanSourceQuestion],
) -> Result<(), String> {
    let expected = questions
        .iter()
        .map(|question| question.id.as_str())
        .collect::<HashSet<_>>();
    let actual = topics
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|topic| {
            topic
                .get("questionIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    if actual != expected {
        return Err("topic_plan_question_coverage_incomplete".to_string());
    }
    Ok(())
}

fn validate_items(items: &Value) -> Result<(), String> {
    let list = items
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= MAX_ITEMS)
        .ok_or_else(|| "topic_plan_items_invalid".to_string())?;
    let mut ids = HashSet::new();
    for item in list {
        let id = required_string(item, "id", 160, "topic_plan_item_invalid")?;
        required_string(item, "topicId", 100, "topic_plan_item_invalid")?;
        required_string(item, "title", 120, "topic_plan_item_invalid")?;
        required_string(item, "typeSelectionReason", 500, "topic_plan_item_invalid")?;
        if !ids.insert(id.to_string()) {
            return Err("topic_plan_item_id_duplicate".to_string());
        }
        let content_type = item
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            content_type,
            "guide" | "showcase" | "ranking" | "news" | "news_light"
        ) {
            return Err("topic_plan_content_type_invalid".to_string());
        }
        if !matches!(
            item.get("approvalStatus").and_then(Value::as_str),
            Some("draft" | "approved")
        ) {
            return Err("topic_plan_approval_status_invalid".to_string());
        }
        if item
            .get("sourceQuestionIds")
            .and_then(Value::as_array)
            .is_none_or(|ids| ids.is_empty())
            || item
                .get("plannedFacts")
                .and_then(Value::as_array)
                .is_none_or(|facts| facts.is_empty())
        {
            return Err("topic_plan_item_links_invalid".to_string());
        }
        if !matches!(
            item.get("origin").and_then(Value::as_str),
            Some("model" | "user")
        ) || item.get("userEdited").and_then(Value::as_bool).is_none()
        {
            return Err("topic_plan_item_edit_state_invalid".to_string());
        }
        let deduplication = item
            .get("deduplication")
            .and_then(Value::as_object)
            .ok_or_else(|| "topic_plan_deduplication_invalid".to_string())?;
        match deduplication.get("method").and_then(Value::as_str) {
            Some("embedding")
                if deduplication
                    .get("maxSimilarity")
                    .and_then(Value::as_f64)
                    .is_some() => {}
            Some("not-evaluated-user-override")
                if deduplication.get("maxSimilarity") == Some(&Value::Null) => {}
            _ => return Err("topic_plan_deduplication_invalid".to_string()),
        }
    }
    Ok(())
}

fn required_string<'a>(
    value: &'a Value,
    key: &str,
    max: usize,
    code: &str,
) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty() && text.chars().count() <= max)
        .ok_or_else(|| code.to_string())
}

fn validate_regeneration_protection(
    current_items_json: &str,
    incoming_items: &Value,
    target_item_ids: &[String],
    preserved_item_ids: &[String],
) -> Result<(), String> {
    let current: Value = serde_json::from_str(current_items_json)
        .map_err(|error| format!("parse current topic plan items: {error}"))?;
    let current_by_id = current
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item)))
        .collect::<HashMap<_, _>>();
    let incoming_by_id = incoming_items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item)))
        .collect::<HashMap<_, _>>();
    let targets = target_item_ids.iter().collect::<HashSet<_>>();
    let preserved = preserved_item_ids.iter().collect::<HashSet<_>>();
    if targets.is_empty()
        || targets
            .iter()
            .any(|id| !current_by_id.contains_key(id.as_str()))
    {
        return Err("topic_plan_regeneration_targets_invalid".to_string());
    }
    for target in targets {
        let current_item = current_by_id[target.as_str()];
        let protected = current_item
            .get("userEdited")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || current_item.get("approvalStatus").and_then(Value::as_str) == Some("approved");
        if protected {
            let incoming = incoming_by_id
                .get(target.as_str())
                .ok_or_else(|| "topic_plan_protected_item_missing".to_string())?;
            if *incoming != current_item || !preserved.contains(target) {
                return Err("topic_plan_protected_item_overwrite".to_string());
            }
        }
    }
    Ok(())
}

fn validate_confirmed_items(items_json: &str, selected_item_ids: &[String]) -> Result<(), String> {
    if selected_item_ids.is_empty() || selected_item_ids.len() > MAX_CONFIRMED_ITEMS {
        return Err("topic_plan_approved_selection_required".to_string());
    }
    let items: Value = serde_json::from_str(items_json)
        .map_err(|error| format!("parse topic plan items for confirmation: {error}"))?;
    let approved = items
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.get("approvalStatus").and_then(Value::as_str) == Some("approved"))
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<HashSet<_>>();
    let selected = selected_item_ids.iter().collect::<HashSet<_>>();
    if selected.len() != selected_item_ids.len()
        || selected.iter().any(|id| !approved.contains(id.as_str()))
    {
        return Err("topic_plan_approved_selection_required".to_string());
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
                    id: "session-10".to_string(),
                    title: "内容规划".to_string(),
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
        seed_source(&workspace);
        (store, workspace)
    }

    fn seed_source(workspace: &BrandWorkspace) {
        let connection = open_database(workspace).unwrap();
        let now = Utc::now().to_rfc3339();
        connection.execute("INSERT INTO knowledge_raw_inputs (id, session_id, input_text, origin, intent, created_at) VALUES ('raw-10','session-10','汽车音响改装','user-stated','knowledge-update',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_fact_candidates (id,raw_input_id,session_id,subject,predicate,scope_json,fact_key,value_json,normalized_value_json,excerpt,confidence,profile_provenance,origin,intent,status,base_version,proposed_at,resolved_at) VALUES ('candidate-10','raw-10','session-10','鲸跃','enterprise-profile.industry','{}','industry','\"汽车音响改装\"','\"汽车音响改装\"','汽车音响改装',1.0,'asked','user-stated','knowledge-update','adopted',0,?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_decisions (id,candidate_id,decision,actor_id,actor_session_id,expected_version,before_json,after_json,reason,decided_at) VALUES ('decision-10','candidate-10','adopt-new','desktop-user','session-10',0,NULL,'\"汽车音响改装\"','test',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_current_facts (fact_key,subject,predicate,scope_json,normalized_value_json,unit,version,confirmed_by,confirmed_at,updated_at) VALUES ('industry','鲸跃','enterprise-profile.industry','{}','\"汽车音响改装\"',NULL,1,'desktop-user',?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_versions (version,decision_id,actor_session_id,snapshot_hash,created_at) VALUES (1,'decision-10','session-10','hash-10',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_version_facts (knowledge_version,fact_key,fact_version,normalized_value_json,unit,sources_json) VALUES (1,'industry',1,'\"汽车音响改装\"',NULL,'[]')", []).unwrap();
        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('operation-q10','session-10','question-pool-confirmed',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_artifacts (id,operation_id,session_id,kind,knowledge_version,created_at) VALUES ('pool-10','operation-q10','session-10','question-pool',1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_question_pools (id,operation_id,created_by_session_id,knowledge_version,product_line,target_region,generation_parameters_json,source_evidence_json,keywords_json,questions_json,status,revision,created_at,updated_at) VALUES ('pool-10','operation-q10','session-10',1,'汽车音响','成都','{}','[]','[]','[]','confirmed',1,?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_question_pool_decisions (id,pool_id,session_id,decision,expected_revision,revision,questions_json,selected_question_ids_json,actor_id,decided_at) VALUES ('pool-decision-10','pool-10','session-10','confirm-selection',0,1,?1,'[\"q1\"]','desktop-user',?2)", params![serde_json::json!([{"id":"q1","text":"成都汽车音响改装哪家好","selected":true}]).to_string(), now]).unwrap();
    }

    fn topics() -> Value {
        serde_json::json!([{
            "id":"topic-1","name":"成都汽车音响改装选型","summary":"解释本地选店标准",
            "questionIds":["q1"],"searchIntent":"commercial-investigation","namingReason":"选型意图"
        }])
    }

    fn item(id: &str, title: &str, edited: bool, approved: bool) -> Value {
        serde_json::json!({
            "id":id,"topicId":"topic-1","sourceQuestionIds":["q1"],"contentType":"guide",
            "typeSelectionReason":"适合指南","title":title,"titleCandidates":[title],
            "titleRationale":{"questionCoverage":"覆盖","searchIntent":"比较","differentiation":"差异","brandFit":"品牌","chinaMarketExpression":"中文"},
            "plannedFacts":[{"factKey":"industry","predicate":"enterprise-profile.industry","normalizedValueJson":"\"汽车音响改装\""}],
            "deduplication":{"method":"embedding","comparedItemIds":[],"maxSimilarity":0,"threshold":0.92},
            "userEdited":edited,"approvalStatus":if approved {"approved"} else {"draft"},"origin":"model"
        })
    }

    fn create_plan(store: &BrandWorkspaceStore, workspace: &BrandWorkspace) -> TopicPlanProjection {
        store.create_topic_plan(&workspace.id, "session-10", TopicPlanCreateRequest {
            question_pool_id:"pool-10".to_string(), question_pool_revision:1, knowledge_version:1,
            policy_version:POLICY_VERSION.to_string(), topics:topics(), items:serde_json::json!([item("editable","原标题",false,false),item("protected","用户标题",true,false),item("approved","批准标题",false,true)]),
            model_audit:serde_json::json!({"clustering":"embedding+generation-llm"}),
            provider_snapshot:serde_json::json!({"generation":{"model":"doubao-seed-2-0-pro-260215"},"titlePlanning":{"model":"doubao-seed-2-0-mini-260428"},"embedding":{"modelFamily":"doubao-embedding-vision"}}),
            model_attempts:serde_json::json!([{"stage":"topic-clustering","status":"success"}]),
        }).unwrap()
    }

    #[test]
    fn plan_binds_confirmed_pool_and_knowledge_then_requires_explicit_confirmation() {
        let (store, workspace) = setup();
        let prepared = store
            .prepare_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanPrepareRequest {
                    question_pool_id: Some("pool-10".to_string()),
                },
            )
            .unwrap();
        assert_eq!(prepared.context.question_pool_revision, 1);
        assert_eq!(prepared.context.questions[0].id, "q1");
        let plan = create_plan(&store, &workspace);
        assert_eq!(plan.status, "awaiting-confirmation");
        assert_eq!(
            store
                .get_topic_plan(
                    &workspace.id,
                    "session-other",
                    TopicPlanGetRequest {
                        plan_id: plan.id.clone()
                    }
                )
                .unwrap_err(),
            "topic_plan_draft_session_mismatch"
        );
        assert!(store
            .latest_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanLatestRequest {
                    status: Some("confirmed".to_string())
                }
            )
            .unwrap()
            .is_none());
        let confirmation = store
            .confirm_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanConfirmRequest {
                    plan_id: plan.id.clone(),
                    expected_revision: 0,
                    selected_item_ids: vec!["approved".to_string()],
                    actor_id: "desktop-user".to_string(),
                },
            )
            .unwrap();
        assert_eq!(confirmation.revision, 1);
        let confirmed = store
            .latest_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanLatestRequest {
                    status: Some("confirmed".to_string()),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(confirmed.selected_item_ids, vec!["approved"]);
        assert_eq!(
            store
                .get_topic_plan(
                    &workspace.id,
                    "session-other",
                    TopicPlanGetRequest {
                        plan_id: plan.id.clone(),
                    },
                )
                .unwrap()
                .unwrap()
                .id,
            plan.id
        );
        assert!(store
            .mutate_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanMutationRequest {
                    plan_id: plan.id,
                    expected_revision: 1,
                    kind: "user-edit".to_string(),
                    items: confirmed.items,
                    target_item_ids: vec![],
                    preserved_item_ids: vec![],
                    actor_id: "desktop-user".to_string(),
                    model_attempts: serde_json::json!([]),
                
                    reason: None,
                }
            )
            .unwrap_err()
            .contains("confirmed_immutable"));
    }

    #[test]
    fn partial_regeneration_cannot_overwrite_user_edited_or_approved_items() {
        let (store, workspace) = setup();
        let plan = create_plan(&store, &workspace);
        let unchanged = serde_json::json!([
            item("editable", "原标题", false, false),
            item("protected", "用户标题", true, false),
            item("approved", "批准标题", false, true)
        ]);
        assert!(store
            .mutate_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanMutationRequest {
                    plan_id: plan.id.clone(),
                    expected_revision: 9,
                    kind: "user-edit".to_string(),
                    items: unchanged.clone(),
                    target_item_ids: vec![],
                    preserved_item_ids: vec![],
                    actor_id: "desktop-user".to_string(),
                    model_attempts: serde_json::json!([]),
                
                    reason: None,
                }
            )
            .unwrap_err()
            .contains("revision_conflict"));
        assert!(store
            .mutate_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanMutationRequest {
                    plan_id: plan.id.clone(),
                    expected_revision: 0,
                    kind: "partial-regeneration".to_string(),
                    items: unchanged.clone(),
                    target_item_ids: vec!["foreign-item".to_string()],
                    preserved_item_ids: vec![],
                    actor_id: "geo-domain".to_string(),
                    model_attempts: serde_json::json!([]),
                
                    reason: None,
                }
            )
            .unwrap_err()
            .contains("regeneration_targets_invalid"));
        let mut invented_fact = unchanged;
        invented_fact[0]["plannedFacts"][0]["factKey"] = Value::String("invented".to_string());
        assert!(store
            .mutate_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanMutationRequest {
                    plan_id: plan.id.clone(),
                    expected_revision: 0,
                    kind: "user-edit".to_string(),
                    items: invented_fact,
                    target_item_ids: vec![],
                    preserved_item_ids: vec![],
                    actor_id: "desktop-user".to_string(),
                    model_attempts: serde_json::json!([]),
                
                    reason: None,
                }
            )
            .unwrap_err()
            .contains("knowledge_fact_not_in_snapshot"));
        let overwritten = serde_json::json!([
            item("editable", "新标题", false, false),
            item("protected", "被覆盖", false, false),
            item("approved", "批准标题", false, true)
        ]);
        assert!(store
            .mutate_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanMutationRequest {
                    plan_id: plan.id.clone(),
                    expected_revision: 0,
                    kind: "partial-regeneration".to_string(),
                    items: overwritten,
                    target_item_ids: vec!["editable".to_string(), "protected".to_string()],
                    preserved_item_ids: vec!["protected".to_string()],
                    actor_id: "geo-domain".to_string(),
                    model_attempts: serde_json::json!([]),
                
                    reason: None,
                }
            )
            .unwrap_err()
            .contains("protected_item_overwrite"));
        let safe = serde_json::json!([
            item("editable", "新标题", false, false),
            item("protected", "用户标题", true, false),
            item("approved", "批准标题", false, true)
        ]);
        let result = store
            .mutate_topic_plan(
                &workspace.id,
                "session-10",
                TopicPlanMutationRequest {
                    plan_id: plan.id,
                    expected_revision: 0,
                    kind: "partial-regeneration".to_string(),
                    items: safe,
                    target_item_ids: vec!["editable".to_string(), "protected".to_string()],
                    preserved_item_ids: vec!["protected".to_string()],
                    actor_id: "geo-domain".to_string(),
                    model_attempts: serde_json::json!([]),
                
                    reason: None,
                },
            )
            .unwrap();
        assert_eq!(result.preserved_item_ids, vec!["protected"]);
        assert_eq!(result.plan.revision, 1);
    }
}
