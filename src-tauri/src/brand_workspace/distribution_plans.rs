use super::*;
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const POLICY_VERSION: &str = "js-ai-dev-four-path-distribution-v1";
const MAX_CANDIDATES: usize = 30;

fn canonical_json<T: ?Sized + Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("serialize distribution plan json: {error}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanLatestRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanGetRequest {
    pub plan_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionQuestionSource {
    pub id: String,
    pub question_id: String,
    pub question: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub article_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionArticleSnapshot {
    pub id: String,
    pub operation_id: String,
    pub approved_revision: i64,
    pub title: String,
    pub topic: String,
    pub content_type: String,
}

/// 已确认问题池里待探测的问题（被动路现场探测的输入，js_ai 语义：
/// 证据来自对问题池的逐问题豆包探测，不依赖基线快照）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionContextQuestion {
    pub id: String,
    pub question: String,
    #[serde(default)]
    pub article_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanningContext {
    pub article_operation_id: String,
    pub knowledge_version: i64,
    pub industry: String,
    pub articles: Vec<DistributionArticleSnapshot>,
    /// 已确认问题池的选中问题（被动路探测输入）。
    pub questions: Vec<DistributionContextQuestion>,
    /// 品牌衍生关键词（主动路全局召回输入）。
    pub derived_keywords: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanningContextRequest {
    pub article_operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanPrepareRequest {
    pub article_operation_id: String,
    pub article_ids: Vec<String>,
    pub industry: String,
    pub target_audience: String,
    #[serde(default)]
    pub question_sources: Vec<DistributionQuestionSource>,
    #[serde(default)]
    pub preferred_resource_ids: Vec<i64>,
    pub mapping_mode: String,
    pub ratio: Value,
    pub budget_cny: f64,
    pub publish_start_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanPreparation {
    pub plan: Value,
    pub claim_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanDiscoveryFinishRequest {
    pub plan_id: String,
    pub expected_revision: i64,
    pub claim_token: String,
    pub provider_state: String,
    pub provider_snapshot: Value,
    pub resource_snapshot: Value,
    pub candidates: Value,
    pub selected_resource_ids: Value,
    pub assignments: Value,
    pub discovery_summary: Value,
    pub blocking_issues: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanEditRequest {
    pub plan_id: String,
    pub expected_revision: i64,
    pub edit: Value,
    /// 聊天修订（票 38）携带的用户指令原文，写入 geo_distribution_plan_audit。
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPlanConfirmRequest {
    pub plan_id: String,
    pub expected_revision: i64,
}

/// 偏好名单条目（js_ai preferenceChannels 设置形状）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPreferenceEntryPayload {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub exact: bool,
}

/// 偏好 overlay：增补名单 + 排除名单；内置名单由共享层合成，不落库。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelPreferencesPayload {
    pub additional_preference_channels: Vec<ChannelPreferenceEntryPayload>,
    pub excluded_preference_channels: Vec<String>,
}

impl Default for ChannelPreferencesPayload {
    fn default() -> Self {
        Self {
            additional_preference_channels: Vec::new(),
            excluded_preference_channels: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPreferencesGetRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelPreferencesSetRequest {
    pub preferences: ChannelPreferencesPayload,
}

fn validate_channel_preferences(payload: &ChannelPreferencesPayload) -> Result<(), String> {
    if payload.additional_preference_channels.len() > 100
        || payload.excluded_preference_channels.len() > 100
    {
        return Err("channel_preferences_limit_exceeded".to_string());
    }
    for entry in &payload.additional_preference_channels {
        let name = entry.name.trim();
        if name.is_empty() || name.chars().count() > 200 {
            return Err("channel_preferences_entry_invalid".to_string());
        }
        if let Some(domain) = entry.domain.as_deref() {
            let domain = domain.trim();
            if domain.chars().count() > 200 {
                return Err("channel_preferences_entry_invalid".to_string());
            }
        }
    }
    for excluded in &payload.excluded_preference_channels {
        let value = excluded.trim();
        if value.is_empty() || value.chars().count() > 200 {
            return Err("channel_preferences_exclusion_invalid".to_string());
        }
    }
    Ok(())
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_distribution_plans (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                article_operation_id TEXT NOT NULL REFERENCES geo_article_operations(operation_id),
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                policy_version TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('discovering','draft','unavailable','confirmed')),
                revision INTEGER NOT NULL DEFAULT 0,
                discovery_claim_token TEXT,
                provider_snapshot_json TEXT NOT NULL,
                resource_snapshot_json TEXT NOT NULL,
                projection_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                confirmed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS geo_distribution_plans_latest
                ON geo_distribution_plans(updated_at DESC, id DESC);
             CREATE TABLE IF NOT EXISTS geo_distribution_plan_audit (
                id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL REFERENCES geo_distribution_plans(id),
                revision INTEGER NOT NULL,
                action TEXT NOT NULL CHECK(action IN ('prepared','discovered','edited','confirmed')),
                actor_session_id TEXT NOT NULL,
                detail_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS geo_channel_preferences (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                additional_json TEXT NOT NULL DEFAULT '[]',
                excluded_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
             );",
        )
        .map_err(|error| format!("initialize distribution plan schema: {error}"))?;
    super::ensure_column(
        connection,
        "geo_distribution_plan_audit",
        "reason",
        "TEXT",
    )?;
    super::drop_brand_sessions_foreign_keys(
        connection,
        &["geo_distribution_plans", "geo_distribution_plan_audit"],
    )
}

impl BrandWorkspaceStore {
    pub fn distribution_planning_context(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: DistributionPlanningContextRequest,
    ) -> Result<DistributionPlanningContext, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        read_distribution_context(&connection, request.article_operation_id.as_deref())
    }

    pub fn latest_distribution_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        _request: DistributionPlanLatestRequest,
    ) -> Result<Option<Value>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        let plan_id = connection
            .query_row(
                "SELECT id FROM geo_distribution_plans
                 WHERE status='confirmed' OR created_by_session_id=?1
                 ORDER BY updated_at DESC, id DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest distribution plan: {error}"))?;
        plan_id
            .map(|id| read_distribution_plan(&connection, workspace_id, &id))
            .transpose()
    }

    pub fn get_distribution_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: DistributionPlanGetRequest,
    ) -> Result<Value, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        require_distribution_plan_visibility(&connection, &request.plan_id, session_id, true)?;
        read_distribution_plan(&connection, workspace_id, &request.plan_id)
    }

    /// 偏好渠道 overlay（js_ai preferenceChannels）：品牌库内单例存储。
    pub fn get_channel_preferences(
        &self,
        workspace_id: &str,
        session_id: &str,
        _request: ChannelPreferencesGetRequest,
    ) -> Result<ChannelPreferencesPayload, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        read_channel_preferences(&connection)
    }

    pub fn set_channel_preferences(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ChannelPreferencesSetRequest,
    ) -> Result<ChannelPreferencesPayload, String> {
        validate_channel_preferences(&request.preferences)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO geo_channel_preferences (singleton, additional_json, excluded_json, updated_at)
                 VALUES (1, ?1, ?2, ?3)
                 ON CONFLICT(singleton) DO UPDATE SET
                   additional_json=excluded.additional_json,
                   excluded_json=excluded.excluded_json,
                   updated_at=excluded.updated_at",
                params![
                    canonical_json(&request.preferences.additional_preference_channels)?,
                    canonical_json(&request.preferences.excluded_preference_channels)?,
                    now
                ],
            )
            .map_err(|error| format!("store channel preferences: {error}"))?;
        read_channel_preferences(&connection)
    }

    pub fn prepare_distribution_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: DistributionPlanPrepareRequest,
    ) -> Result<DistributionPlanPreparation, String> {
        validate_prepare_request(&request)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("prepare distribution plan transaction: {error}"))?;
        let context = read_distribution_context(&transaction, Some(&request.article_operation_id))?;
        if normalize_compare(&request.industry) != normalize_compare(&context.industry) {
            return Err("distribution_plan_industry_snapshot_mismatch".to_string());
        }
        let article_map = context
            .articles
            .iter()
            .map(|article| (article.id.as_str(), article))
            .collect::<HashMap<_, _>>();
        let mut article_ids = Vec::new();
        let mut articles = Vec::new();
        for article_id in &request.article_ids {
            if article_ids.contains(article_id) {
                return Err("distribution_plan_article_duplicate".to_string());
            }
            let article = article_map
                .get(article_id.as_str())
                .ok_or_else(|| "distribution_plan_approved_article_mismatch".to_string())?;
            article_ids.push(article_id.clone());
            articles.push((*article).clone());
        }
        if articles.is_empty() {
            return Err("distribution_plan_approved_articles_required".to_string());
        }
        // 被动路证据改为现场探测（js_ai 语义）：来源由 Node 探测产出，这里做
        // 结构与溯源校验——question_id/question 必须命中已确认问题池，URL 必须
        // 是合法 http(s)，id 唯一；article_ids 不信任请求，按权威映射重盖。
        let pool_questions = context
            .questions
            .iter()
            .map(|question| (question.id.as_str(), question))
            .collect::<HashMap<_, _>>();
        let mut question_sources = Vec::new();
        let mut source_ids = HashSet::new();
        for source in &request.question_sources {
            if !source_ids.insert(source.id.clone()) {
                return Err("distribution_plan_question_source_duplicate".to_string());
            }
            let pool_question = pool_questions
                .get(source.question_id.as_str())
                .ok_or_else(|| "distribution_plan_question_not_in_confirmed_pool".to_string())?;
            if normalize_compare(&source.question) != normalize_compare(&pool_question.question) {
                return Err("distribution_plan_question_text_mismatch".to_string());
            }
            let url = source.url.trim();
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err("distribution_plan_question_source_url_invalid".to_string());
            }
            let mut derived = source.clone();
            derived.article_ids = pool_question
                .article_ids
                .iter()
                .filter(|article_id| article_ids.contains(article_id))
                .cloned()
                .collect();
            question_sources.push(derived);
        }

        let plan_id = Uuid::new_v4().to_string();
        let operation_id = Uuid::new_v4().to_string();
        let artifact_id = Uuid::new_v4().to_string();
        let claim_token = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        // 被动证据为空不再构成初始阻断（用户裁决 2026-08-18）：探测失败只降级。
        let blocking_issues = json!([
            "distribution-provider-unavailable",
            "channel-candidate-unavailable",
            "article-channel-unassigned"
        ]);
        let assignments = articles
            .iter()
            .map(|article| {
                json!({
                    "articleId": article.id,
                    "resourceId": Value::Null,
                    "reason": "unassigned",
                    "scheduledAt": request.publish_start_at,
                })
            })
            .collect::<Vec<_>>();
        let provider_snapshot = json!({
            "slot": "distribution",
            "provider": "超级媒介",
            "endpointFamily": "chaojimeijie-resource-api",
            "policyVersion": POLICY_VERSION,
            "fetchedAt": Value::Null,
            "mediaTotal": 0,
            "weMediaTotal": 0,
        });
        let projection = json!({
            "id": plan_id,
            "operationId": operation_id,
            "workspaceId": workspace_id,
            "createdBySessionId": session_id,
            "articleOperationId": context.article_operation_id,
            "policyVersion": POLICY_VERSION,
            "status": "discovering",
            "revision": 0,
            "industry": context.industry,
            "targetAudience": request.target_audience.trim(),
            "questionSources": question_sources,
            "preferredResourceIds": request.preferred_resource_ids,
            "mappingMode": request.mapping_mode,
            "ratio": request.ratio,
            "articles": articles,
            "providerState": "pending",
            "providerSnapshot": provider_snapshot,
            "resourceSnapshot": [],
            "candidates": [],
            "selectedResourceIds": [],
            "assignments": assignments,
            "budgetCny": request.budget_cny,
            "publishStartAt": request.publish_start_at,
            "discoverySummary": empty_discovery_summary(),
            "blockingIssues": blocking_issues,
            "createdAt": now,
            "updatedAt": now,
            "confirmedAt": Value::Null,
        });
        reject_secret_shaped_data(&projection)?;
        transaction
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES (?1, ?2, 'distribution-discovering', ?3)",
                params![operation_id, session_id, now],
            )
            .map_err(|error| format!("create distribution operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_artifacts
                    (id, operation_id, session_id, kind, knowledge_version, created_at)
                 VALUES (?1, ?2, ?3, 'distribution-plan', ?4, ?5)",
                params![
                    artifact_id,
                    operation_id,
                    session_id,
                    context.knowledge_version,
                    now
                ],
            )
            .map_err(|error| format!("create distribution artifact: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_distribution_plans
                    (id, operation_id, created_by_session_id, article_operation_id,
                     knowledge_version, policy_version, status, revision,
                     discovery_claim_token, provider_snapshot_json, resource_snapshot_json,
                     projection_json, created_at, updated_at, confirmed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'discovering', 0, ?7, ?8, '[]', ?9, ?10, ?10, NULL)",
                params![
                    plan_id,
                    operation_id,
                    session_id,
                    context.article_operation_id,
                    context.knowledge_version,
                    POLICY_VERSION,
                    claim_token,
                    canonical_json(&provider_snapshot)?,
                    canonical_json(&projection)?,
                    now,
                ],
            )
            .map_err(|error| format!("persist distribution plan: {error}"))?;
        insert_distribution_audit(
            &transaction,
            &plan_id,
            0,
            "prepared",
            session_id,
            &json!({"articleIds": article_ids, "questionSourceIds": source_ids}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit distribution plan preparation: {error}"))?;
        Ok(DistributionPlanPreparation {
            plan: read_distribution_plan(&connection, workspace_id, &plan_id)?,
            claim_token,
        })
    }

    pub fn finish_distribution_plan_discovery(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: DistributionPlanDiscoveryFinishRequest,
    ) -> Result<Value, String> {
        validate_discovery_result(&request)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("finish distribution discovery transaction: {error}"))?;
        require_distribution_plan_visibility(&transaction, &request.plan_id, session_id, false)?;
        let (revision, status, claim_token, projection_json, operation_id): (
            i64,
            String,
            Option<String>,
            String,
            String,
        ) = transaction
            .query_row(
                "SELECT revision, status, discovery_claim_token, projection_json, operation_id
                 FROM geo_distribution_plans WHERE id=?1",
                [&request.plan_id],
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
            .map_err(|error| format!("read claimed distribution plan: {error}"))?
            .ok_or_else(|| "distribution_plan_not_found".to_string())?;
        if status != "discovering" {
            return Err("distribution_plan_discovery_already_finished".to_string());
        }
        if revision != request.expected_revision {
            return Err("distribution_plan_revision_conflict".to_string());
        }
        if claim_token.as_deref() != Some(request.claim_token.as_str()) {
            return Err("distribution_plan_claim_conflict".to_string());
        }
        let mut projection: Value = serde_json::from_str(&projection_json)
            .map_err(|error| format!("parse distribution plan projection: {error}"))?;
        validate_discovery_against_plan(&request, &projection)?;
        let next_status = if request.provider_state == "available"
            && request
                .candidates
                .as_array()
                .is_some_and(|items| !items.is_empty())
        {
            "draft"
        } else {
            "unavailable"
        };
        let next_revision = revision + 1;
        let now = Utc::now().to_rfc3339();
        set_projection_field(&mut projection, "status", json!(next_status))?;
        set_projection_field(&mut projection, "revision", json!(next_revision))?;
        set_projection_field(
            &mut projection,
            "providerState",
            json!(request.provider_state),
        )?;
        set_projection_field(
            &mut projection,
            "providerSnapshot",
            request.provider_snapshot.clone(),
        )?;
        set_projection_field(
            &mut projection,
            "resourceSnapshot",
            request.resource_snapshot.clone(),
        )?;
        set_projection_field(&mut projection, "candidates", request.candidates.clone())?;
        set_projection_field(
            &mut projection,
            "selectedResourceIds",
            request.selected_resource_ids.clone(),
        )?;
        set_projection_field(&mut projection, "assignments", request.assignments.clone())?;
        set_projection_field(
            &mut projection,
            "discoverySummary",
            request.discovery_summary.clone(),
        )?;
        set_projection_field(
            &mut projection,
            "blockingIssues",
            request.blocking_issues.clone(),
        )?;
        set_projection_field(&mut projection, "updatedAt", json!(now))?;
        reject_secret_shaped_data(&projection)?;
        transaction
            .execute(
                "UPDATE geo_distribution_plans
                 SET status=?2, revision=?3, discovery_claim_token=NULL,
                     provider_snapshot_json=?4, resource_snapshot_json=?5,
                     projection_json=?6, updated_at=?7
                 WHERE id=?1 AND revision=?8 AND discovery_claim_token=?9",
                params![
                    request.plan_id,
                    next_status,
                    next_revision,
                    canonical_json(&request.provider_snapshot)?,
                    canonical_json(&request.resource_snapshot)?,
                    canonical_json(&projection)?,
                    now,
                    request.expected_revision,
                    request.claim_token,
                ],
            )
            .map_err(|error| format!("finish distribution discovery: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state=?2 WHERE id=?1",
                params![
                    operation_id,
                    if next_status == "draft" {
                        "distribution-plan-draft"
                    } else {
                        "distribution-unavailable"
                    }
                ],
            )
            .map_err(|error| format!("finish distribution operation: {error}"))?;
        insert_distribution_audit(
            &transaction,
            &request.plan_id,
            next_revision,
            "discovered",
            session_id,
            &json!({"providerState": request.provider_state, "status": next_status}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit distribution discovery: {error}"))?;
        read_distribution_plan(&connection, workspace_id, &request.plan_id)
    }

    pub fn edit_distribution_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: DistributionPlanEditRequest,
    ) -> Result<Value, String> {
        validate_edit_payload(&request.edit)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("edit distribution plan transaction: {error}"))?;
        require_distribution_plan_visibility(&transaction, &request.plan_id, session_id, false)?;
        let (revision, status, projection_json): (i64, String, String) = transaction
            .query_row(
                "SELECT revision, status, projection_json FROM geo_distribution_plans WHERE id=?1",
                [&request.plan_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read distribution plan edit target: {error}"))?
            .ok_or_else(|| "distribution_plan_not_found".to_string())?;
        if status == "confirmed" {
            return Err("distribution_plan_confirmed_immutable".to_string());
        }
        if status == "discovering" {
            return Err("distribution_plan_discovery_incomplete".to_string());
        }
        if revision != request.expected_revision {
            return Err("distribution_plan_revision_conflict".to_string());
        }
        let mut projection: Value = serde_json::from_str(&projection_json)
            .map_err(|error| format!("parse distribution plan projection: {error}"))?;
        let edit = request
            .edit
            .as_object()
            .ok_or_else(|| "distribution_plan_edit_invalid".to_string())?;
        for key in [
            "selectedResourceIds",
            "assignments",
            "budgetCny",
            "publishStartAt",
            "blockingIssues",
        ] {
            set_projection_field(
                &mut projection,
                key,
                edit.get(key)
                    .cloned()
                    .ok_or_else(|| "distribution_plan_edit_invalid".to_string())?,
            )?;
        }
        let next_revision = revision + 1;
        let now = Utc::now().to_rfc3339();
        set_projection_field(&mut projection, "revision", json!(next_revision))?;
        set_projection_field(&mut projection, "updatedAt", json!(now))?;
        reject_secret_shaped_data(&projection)?;
        let changed = transaction
            .execute(
                "UPDATE geo_distribution_plans SET revision=?2, projection_json=?3, updated_at=?4
                 WHERE id=?1 AND revision=?5 AND status!='confirmed'",
                params![
                    request.plan_id,
                    next_revision,
                    canonical_json(&projection)?,
                    now,
                    revision
                ],
            )
            .map_err(|error| format!("edit distribution plan: {error}"))?;
        if changed != 1 {
            return Err("distribution_plan_revision_conflict".to_string());
        }
        insert_distribution_audit_with_reason(
            &transaction,
            &request.plan_id,
            next_revision,
            "edited",
            session_id,
            &request.edit,
            request
                .reason
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit distribution plan edit: {error}"))?;
        read_distribution_plan(&connection, workspace_id, &request.plan_id)
    }

    pub fn confirm_distribution_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: DistributionPlanConfirmRequest,
    ) -> Result<Value, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_distribution_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("confirm distribution plan transaction: {error}"))?;
        require_distribution_plan_visibility(&transaction, &request.plan_id, session_id, false)?;
        let (revision, status, projection_json, operation_id): (i64, String, String, String) =
            transaction
                .query_row(
                    "SELECT revision, status, projection_json, operation_id
                 FROM geo_distribution_plans WHERE id=?1",
                    [&request.plan_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(|error| format!("read distribution plan confirmation target: {error}"))?
                .ok_or_else(|| "distribution_plan_not_found".to_string())?;
        if status == "confirmed" {
            return Err("distribution_plan_already_confirmed".to_string());
        }
        if status != "draft" {
            return Err("distribution_plan_not_confirmable".to_string());
        }
        if revision != request.expected_revision {
            return Err("distribution_plan_revision_conflict".to_string());
        }
        let mut projection: Value = serde_json::from_str(&projection_json)
            .map_err(|error| format!("parse distribution plan projection: {error}"))?;
        let issues = confirmation_issues(&projection)?;
        if !issues.is_empty() {
            return Err(format!(
                "distribution_plan_confirmation_blocked:{}",
                issues.join(",")
            ));
        }
        let next_revision = revision + 1;
        let now = Utc::now().to_rfc3339();
        set_projection_field(&mut projection, "status", json!("confirmed"))?;
        set_projection_field(&mut projection, "revision", json!(next_revision))?;
        set_projection_field(&mut projection, "confirmedAt", json!(now))?;
        set_projection_field(&mut projection, "updatedAt", json!(now))?;
        let changed = transaction
            .execute(
                "UPDATE geo_distribution_plans
                 SET status='confirmed', revision=?2, projection_json=?3,
                     updated_at=?4, confirmed_at=?4
                 WHERE id=?1 AND revision=?5 AND status='draft'",
                params![
                    request.plan_id,
                    next_revision,
                    canonical_json(&projection)?,
                    now,
                    revision
                ],
            )
            .map_err(|error| format!("confirm distribution plan: {error}"))?;
        if changed != 1 {
            return Err("distribution_plan_revision_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_operations SET state='distribution-plan-confirmed' WHERE id=?1",
                [&operation_id],
            )
            .map_err(|error| format!("confirm distribution operation: {error}"))?;
        insert_distribution_audit(
            &transaction,
            &request.plan_id,
            next_revision,
            "confirmed",
            session_id,
            &json!({"confirmed": true}),
            &now,
        )?;
        transaction
            .commit()
            .map_err(|error| format!("commit distribution plan confirmation: {error}"))?;
        read_distribution_plan(&connection, workspace_id, &request.plan_id)
    }
}

fn read_channel_preferences(
    connection: &Connection,
) -> Result<ChannelPreferencesPayload, String> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT additional_json, excluded_json FROM geo_channel_preferences WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("read channel preferences: {error}"))?;
    let Some((additional_json, excluded_json)) = row else {
        return Ok(ChannelPreferencesPayload::default());
    };
    let additional: Vec<ChannelPreferenceEntryPayload> =
        serde_json::from_str(&additional_json).unwrap_or_default();
    let excluded: Vec<String> = serde_json::from_str(&excluded_json).unwrap_or_default();
    Ok(ChannelPreferencesPayload {
        additional_preference_channels: additional,
        excluded_preference_channels: excluded,
    })
}

fn require_distribution_plan_visibility(
    connection: &Connection,
    plan_id: &str,
    session_id: &str,
    allow_confirmed_cross_session: bool,
) -> Result<(), String> {
    let target: Option<(String, String)> = connection
        .query_row(
            "SELECT created_by_session_id, status FROM geo_distribution_plans WHERE id=?1",
            [plan_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| format!("inspect distribution plan visibility: {error}"))?;
    let Some((created_by_session_id, status)) = target else {
        return Err("distribution_plan_not_found".to_string());
    };
    if created_by_session_id == session_id
        || (allow_confirmed_cross_session && status == "confirmed")
    {
        return Ok(());
    }
    Err("distribution_plan_draft_session_mismatch".to_string())
}

fn read_distribution_context(
    connection: &Connection,
    requested_operation_id: Option<&str>,
) -> Result<DistributionPlanningContext, String> {
    let operation_id = if let Some(value) = requested_operation_id {
        validate_short(value, 160, "distribution_plan_article_operation_invalid")?
    } else {
        connection
            .query_row(
                "SELECT operation_id FROM geo_article_operations op
                 WHERE EXISTS (SELECT 1 FROM geo_articles article
                               WHERE article.operation_id=op.operation_id
                                 AND article.status='approved'
                                 AND article.approved_revision IS NOT NULL)
                 ORDER BY op.updated_at DESC, op.operation_id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest approved article operation: {error}"))?
            .ok_or_else(|| "distribution_plan_approved_articles_required".to_string())?
    };
    let knowledge_version: i64 = connection
        .query_row(
            "SELECT knowledge_version FROM geo_article_operations WHERE operation_id=?1",
            [&operation_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read distribution article knowledge version: {error}"))?
        .ok_or_else(|| "distribution_plan_article_operation_not_found".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT article.id, article.operation_id, article.approved_revision,
                    version.title, article.topic, article.content_type
             FROM geo_articles article
             JOIN geo_article_versions version
               ON version.article_id=article.id AND version.revision=article.approved_revision
             WHERE article.operation_id=?1 AND article.status='approved'
               AND article.approved_revision IS NOT NULL
             ORDER BY article.created_at, article.id",
        )
        .map_err(|error| format!("prepare approved distribution articles: {error}"))?;
    let articles = statement
        .query_map([&operation_id], |row| {
            Ok(DistributionArticleSnapshot {
                id: row.get(0)?,
                operation_id: row.get(1)?,
                approved_revision: row.get(2)?,
                title: row.get(3)?,
                topic: row.get(4)?,
                content_type: row.get(5)?,
            })
        })
        .map_err(|error| format!("query approved distribution articles: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read approved distribution articles: {error}"))?;
    if articles.is_empty() {
        return Err("distribution_plan_approved_articles_required".to_string());
    }
    let industry_json: String = connection
        .query_row(
            "SELECT snapshot.normalized_value_json
             FROM knowledge_version_facts snapshot
             LEFT JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1
               AND (snapshot.fact_key='industry' OR current.predicate='enterprise-profile.industry')
             ORDER BY CASE WHEN snapshot.fact_key='industry' THEN 0 ELSE 1 END LIMIT 1",
            [knowledge_version],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read distribution industry snapshot: {error}"))?
        .ok_or_else(|| "distribution_plan_industry_snapshot_missing".to_string())?;
    let industry = serde_json::from_str::<Value>(&industry_json)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "distribution_plan_industry_snapshot_invalid".to_string())?;
    let (question_article_map, baseline_scope) =
        read_question_article_map(connection, &operation_id)?;
    let questions = read_context_questions(connection, knowledge_version, &question_article_map, baseline_scope.as_ref())?;
    let derived_keywords = read_derived_keywords(connection, knowledge_version)?;
    Ok(DistributionPlanningContext {
        article_operation_id: operation_id,
        knowledge_version,
        industry,
        articles,
        questions,
        derived_keywords,
    })
}

/// 已确认问题池的选中问题（js_ai 被动路语义）：confirmed-topic-plan 计划用
/// 其绑定的 (pool_id, revision)，direct 文章用同知识版本最新 confirmed 池；
/// 选中集读该池最新 decision 的 questions_json（无 decision 行回落池行本身）。
fn read_context_questions(
    connection: &Connection,
    knowledge_version: i64,
    question_article_map: &HashMap<String, Vec<String>>,
    scope: Option<&(String, i64)>,
) -> Result<Vec<DistributionContextQuestion>, String> {
    let pool_row: Option<(String, i64)> = if let Some((pool_id, pool_revision)) = scope {
        connection
            .query_row(
                "SELECT id, revision FROM geo_question_pools
                 WHERE id=?1 AND knowledge_version=?2 AND status='confirmed'",
                params![pool_id, knowledge_version],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read scoped confirmed question pool: {error}"))?
            .filter(|(_, revision)| *revision == *pool_revision)
    } else {
        None
    };
    let pool_id = if let Some(row) = pool_row {
        row.0
    } else {
        connection
            .query_row(
                "SELECT id FROM geo_question_pools
                 WHERE knowledge_version=?1 AND status='confirmed'
                 ORDER BY updated_at DESC, id DESC LIMIT 1",
                [knowledge_version],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest confirmed question pool: {error}"))?
            .ok_or_else(|| "distribution_plan_question_pool_missing".to_string())?
    };
    let questions_json: Option<String> = connection
        .query_row(
            "SELECT questions_json FROM geo_question_pool_decisions
             WHERE pool_id=?1 ORDER BY revision DESC, decided_at DESC LIMIT 1",
            [&pool_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read confirmed pool decision questions: {error}"))?;
    let raw = match questions_json {
        Some(value) => value,
        None => connection
            .query_row(
                "SELECT questions_json FROM geo_question_pools WHERE id=?1",
                [&pool_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("read confirmed pool questions: {error}"))?,
    };
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("parse confirmed pool questions: {error}"))?;
    let mut questions = Vec::new();
    for entry in value.as_array().into_iter().flatten() {
        if entry.get("selected").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(text) = entry.get("text").and_then(Value::as_str) else {
            continue;
        };
        if id.trim().is_empty() || text.trim().is_empty() {
            continue;
        }
        questions.push(DistributionContextQuestion {
            id: id.trim().to_string(),
            question: text.trim().to_string(),
            article_ids: question_article_map.get(id).cloned().unwrap_or_default(),
        });
        if questions.len() >= 50 {
            break;
        }
    }
    Ok(questions)
}

/// 主动路全局召回的衍生关键词输入：知识快照里的品牌词库种子。
fn read_derived_keywords(
    connection: &Connection,
    knowledge_version: i64,
) -> Result<Vec<String>, String> {
    let keywords_json: Option<String> = connection
        .query_row(
            "SELECT snapshot.normalized_value_json
             FROM knowledge_version_facts snapshot
             LEFT JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1
               AND (snapshot.fact_key='derivedkeywords'
                    OR current.predicate='enterprise-profile.derivedkeywords')
             ORDER BY CASE WHEN snapshot.fact_key='derivedkeywords' THEN 0 ELSE 1 END LIMIT 1",
            [knowledge_version],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read distribution derived keywords snapshot: {error}"))?;
    let Some(raw) = keywords_json else {
        return Ok(Vec::new());
    };
    let value: Value = serde_json::from_str(&raw)
        .ok()
        .unwrap_or(Value::Array(Vec::new()));
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|keyword| !keyword.is_empty() && keyword.chars().count() <= 60)
        .map(str::to_string)
        .take(50)
        .collect())
}

type QuestionArticleMap = (HashMap<String, Vec<String>>, Option<(String, i64)>);

fn read_question_article_map(
    connection: &Connection,
    operation_id: &str,
) -> Result<QuestionArticleMap, String> {
    let (source_kind, topic_plan_id, topic_plan_revision): (String, Option<String>, Option<i64>) =
        connection
            .query_row(
                "SELECT source_kind, topic_plan_id, topic_plan_revision
             FROM geo_article_operations WHERE operation_id=?1",
                [operation_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("read article source for distribution evidence: {error}"))?;
    if source_kind != "confirmed-topic-plan" {
        return Ok((HashMap::new(), None));
    }
    let plan_id =
        topic_plan_id.ok_or_else(|| "distribution_plan_topic_plan_snapshot_missing".to_string())?;
    let plan_revision = topic_plan_revision
        .ok_or_else(|| "distribution_plan_topic_plan_snapshot_missing".to_string())?;
    let (items_json, question_pool_id, question_pool_revision): (String, String, i64) = connection
        .query_row(
            "SELECT items_json, question_pool_id, question_pool_revision
             FROM geo_topic_plans
             WHERE id=?1 AND revision=?2 AND status='confirmed'",
            params![plan_id, plan_revision],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("read distribution topic-plan items: {error}"))?
        .ok_or_else(|| "distribution_plan_topic_plan_snapshot_missing".to_string())?;
    let items = serde_json::from_str::<Value>(&items_json)
        .map_err(|error| format!("parse distribution topic-plan items: {error}"))?;
    let by_item = items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let item_id = item.get("id")?.as_str()?.to_string();
            let question_ids = item
                .get("sourceQuestionIds")?
                .as_array()?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            Some((item_id, question_ids))
        })
        .collect::<HashMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT id, source_plan_item_id FROM geo_articles
             WHERE operation_id=?1 AND status='approved' AND approved_revision IS NOT NULL",
        )
        .map_err(|error| format!("prepare distribution article question links: {error}"))?;
    let rows = statement
        .query_map([operation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| format!("query distribution article question links: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read distribution article question links: {error}"))?;
    let mut result: HashMap<String, Vec<String>> = HashMap::new();
    for (article_id, item_id) in rows {
        let Some(question_ids) = item_id.as_ref().and_then(|id| by_item.get(id)) else {
            continue;
        };
        for question_id in question_ids {
            result
                .entry(question_id.clone())
                .or_default()
                .push(article_id.clone());
        }
    }
    Ok((result, Some((question_pool_id, question_pool_revision))))
}

fn read_distribution_plan(
    connection: &Connection,
    workspace_id: &str,
    plan_id: &str,
) -> Result<Value, String> {
    let raw = connection
        .query_row(
            "SELECT projection_json FROM geo_distribution_plans WHERE id=?1",
            [plan_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read distribution plan: {error}"))?
        .ok_or_else(|| "distribution_plan_not_found".to_string())?;
    let projection: Value =
        serde_json::from_str(&raw).map_err(|error| format!("parse distribution plan: {error}"))?;
    if projection.get("workspaceId").and_then(Value::as_str) != Some(workspace_id) {
        return Err("distribution_plan_workspace_mismatch".to_string());
    }
    Ok(projection)
}

fn validate_prepare_request(request: &DistributionPlanPrepareRequest) -> Result<(), String> {
    validate_short(
        &request.article_operation_id,
        160,
        "distribution_plan_article_operation_invalid",
    )?;
    validate_short(&request.industry, 200, "distribution_plan_industry_invalid")?;
    validate_short(
        &request.target_audience,
        500,
        "distribution_plan_audience_invalid",
    )?;
    if request.article_ids.is_empty() || request.article_ids.len() > 50 {
        return Err("distribution_plan_articles_invalid".to_string());
    }
    if request.question_sources.len() > 100 {
        return Err("distribution_plan_question_sources_invalid".to_string());
    }
    if !matches!(request.mapping_mode.as_str(), "one-to-one" | "ratio") {
        return Err("distribution_plan_mapping_mode_invalid".to_string());
    }
    let media = request
        .ratio
        .get("media")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    let we_media = request
        .ratio
        .get("weMedia")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if media < 0 || we_media < 0 || media + we_media < 1 {
        return Err("distribution_plan_ratio_invalid".to_string());
    }
    if !request.budget_cny.is_finite()
        || request.budget_cny < 0.0
        || request.budget_cny > 10_000_000.0
    {
        return Err("distribution_plan_budget_invalid".to_string());
    }
    if !looks_like_iso_time(&request.publish_start_at) {
        return Err("distribution_plan_publish_time_invalid".to_string());
    }
    Ok(())
}

fn validate_discovery_result(
    request: &DistributionPlanDiscoveryFinishRequest,
) -> Result<(), String> {
    if !matches!(request.provider_state.as_str(), "available" | "unavailable") {
        return Err("distribution_plan_provider_state_invalid".to_string());
    }
    reject_secret_shaped_data(&request.provider_snapshot)?;
    reject_secret_shaped_data(&request.resource_snapshot)?;
    reject_secret_shaped_data(&request.candidates)?;
    let resources = request
        .resource_snapshot
        .as_array()
        .ok_or_else(|| "distribution_plan_resource_snapshot_invalid".to_string())?;
    let candidates = request
        .candidates
        .as_array()
        .ok_or_else(|| "distribution_plan_candidates_invalid".to_string())?;
    if candidates.len() > MAX_CANDIDATES {
        return Err("distribution_plan_candidate_limit".to_string());
    }
    if request.provider_state == "unavailable" {
        if !resources.is_empty() || !candidates.is_empty() {
            return Err("distribution_plan_unavailable_must_be_empty".to_string());
        }
        return Ok(());
    }
    if request
        .provider_snapshot
        .get("slot")
        .and_then(Value::as_str)
        != Some("distribution")
        || request
            .provider_snapshot
            .get("provider")
            .and_then(Value::as_str)
            != Some("超级媒介")
        || request
            .provider_snapshot
            .get("policyVersion")
            .and_then(Value::as_str)
            != Some(POLICY_VERSION)
    {
        return Err("distribution_plan_provider_snapshot_invalid".to_string());
    }
    let mut resource_map = HashMap::new();
    for resource in resources {
        validate_resource_snapshot(resource)?;
        let key = resource_key(resource)?;
        if resource_map.insert(key, resource).is_some() {
            return Err("distribution_plan_resource_snapshot_duplicate".to_string());
        }
    }
    for candidate in candidates {
        let key = resource_key(candidate)?;
        let resource = resource_map
            .get(&key)
            .ok_or_else(|| "distribution_plan_candidate_outside_resource_snapshot".to_string())?;
        validate_candidate(candidate, resource)?;
    }
    Ok(())
}

fn validate_discovery_against_plan(
    request: &DistributionPlanDiscoveryFinishRequest,
    projection: &Value,
) -> Result<(), String> {
    if request.provider_state == "unavailable" {
        return Ok(());
    }
    let sources = projection
        .get("questionSources")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_question_sources_invalid".to_string())?;
    let industry = projection
        .get("industry")
        .and_then(Value::as_str)
        .ok_or_else(|| "distribution_plan_industry_snapshot_invalid".to_string())?;
    let audience = projection
        .get("targetAudience")
        .and_then(Value::as_str)
        .ok_or_else(|| "distribution_plan_audience_invalid".to_string())?;
    // preferredResourceIds 快照字段保留兼容读取，但偏好路校验已改为
    // reference 前缀契约（js_ai preferenceChannels），不再消费该集合。
    let _preferred = projection
        .get("preferredResourceIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_preference_snapshot_invalid".to_string())?;
    let candidates = request
        .candidates
        .as_array()
        .ok_or_else(|| "distribution_plan_candidates_invalid".to_string())?;
    for candidate in candidates {
        let _resource_id = candidate
            .get("resourceId")
            .and_then(Value::as_i64)
            .ok_or_else(|| "distribution_plan_resource_identity_invalid".to_string())?;
        let _kind = candidate
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "distribution_plan_resource_identity_invalid".to_string())?;
        let evidence = candidate
            .get("evidence")
            .and_then(Value::as_array)
            .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
        let evidence_paths = evidence
            .iter()
            .filter_map(|item| item.get("path").and_then(Value::as_str))
            .collect::<HashSet<_>>();
        let path_hits = candidate
            .get("pathHits")
            .and_then(Value::as_array)
            .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?
            .iter()
            .filter_map(Value::as_str)
            .collect::<HashSet<_>>();
        if path_hits != evidence_paths
            || candidate.get("hitCount").and_then(Value::as_u64)
                != Some(evidence_paths.len() as u64)
        {
            return Err("distribution_plan_candidate_evidence_mismatch".to_string());
        }
        if candidate
            .pointer("/availability/state")
            .and_then(Value::as_str)
            != Some("available")
            || candidate
                .pointer("/availability/basis")
                .and_then(Value::as_str)
                != Some("supermedia-approved-resource")
        {
            return Err("distribution_plan_candidate_unavailable".to_string());
        }
        for item in evidence {
            let path = item
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
            let reference = item
                .get("reference")
                .and_then(Value::as_str)
                .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
            let article_ids = item
                .get("articleIds")
                .and_then(Value::as_array)
                .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
            match path {
                "passive" => {
                    let question_ids = reference.split(',').collect::<HashSet<_>>();
                    if question_ids.is_empty() || question_ids.contains("") {
                        return Err("distribution_plan_passive_evidence_mismatch".to_string());
                    }
                    let matching = sources
                        .iter()
                        .filter(|source| {
                            source
                                .get("questionId")
                                .and_then(Value::as_str)
                                .is_some_and(|id| question_ids.contains(id))
                        })
                        .collect::<Vec<_>>();
                    if matching.is_empty()
                        || matching
                            .iter()
                            .filter_map(|source| source.get("questionId").and_then(Value::as_str))
                            .collect::<HashSet<_>>()
                            != question_ids
                        || !matching
                            .iter()
                            .any(|source| source.get("url") == item.get("url"))
                    {
                        return Err("distribution_plan_passive_evidence_mismatch".to_string());
                    }
                    let expected_articles = matching
                        .iter()
                        .flat_map(|source| {
                            source
                                .get("articleIds")
                                .and_then(Value::as_array)
                                .into_iter()
                                .flatten()
                        })
                        .filter_map(Value::as_str)
                        .collect::<HashSet<_>>();
                    let actual_articles = article_ids
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<HashSet<_>>();
                    if expected_articles != actual_articles
                        || actual_articles.len() != article_ids.len()
                    {
                        return Err("distribution_plan_passive_evidence_mismatch".to_string());
                    }
                }
                // 主动路（ADR-0031 全局召回）：reference 携带召回渠道名，
                // articleIds 允许携带主题→文章映射。
                "active" => {
                    if !reference.starts_with("recall:") || reference.len() <= "recall:".len() {
                        return Err("distribution_plan_active_evidence_mismatch".to_string());
                    }
                }
                // 保底路：结构化类目/人群规则匹配（合并后单路）。
                "fallback" => {
                    if reference != format!("industry:{industry}")
                        && reference != format!("audience:{audience}")
                    {
                        return Err("distribution_plan_fallback_evidence_mismatch".to_string());
                    }
                    if !article_ids.is_empty() {
                        return Err("distribution_plan_fallback_evidence_mismatch".to_string());
                    }
                }
                // 偏好路：reference 携带命中的偏好名单条目名。
                "preference" => {
                    if !reference.starts_with("preference:")
                        || reference.len() <= "preference:".len()
                        || !article_ids.is_empty()
                    {
                        return Err("distribution_plan_preference_evidence_mismatch".to_string());
                    }
                }
                _ => return Err("distribution_plan_candidate_evidence_invalid".to_string()),
            }
        }
    }
    Ok(())
}

fn validate_resource_snapshot(resource: &Value) -> Result<(), String> {
    if resource.get("status").and_then(Value::as_i64) != Some(2) {
        return Err("distribution_plan_resource_unavailable".to_string());
    }
    // 发布率不是决策输入（用户裁决 2026-08-18）：低发布率资源合法。
    if let Some(price) = parsed_price(resource.get("price")) {
        if price >= 150.0 {
            return Err("distribution_plan_resource_high_price".to_string());
        }
    }
    Ok(())
}

fn validate_candidate(candidate: &Value, resource: &Value) -> Result<(), String> {
    for field in ["name"] {
        if candidate.get(field) != resource.get(field) {
            return Err("distribution_plan_candidate_snapshot_mismatch".to_string());
        }
    }
    if candidate.get("publishedRate") != resource.get("publishedRate") {
        return Err("distribution_plan_candidate_snapshot_mismatch".to_string());
    }
    if candidate.get("resourceSnapshot") != Some(resource) {
        return Err("distribution_plan_candidate_snapshot_mismatch".to_string());
    }
    let expected_price = parsed_price(resource.get("price"));
    let candidate_price = candidate.get("estimatedPriceCny").and_then(Value::as_f64);
    if !same_optional_number(expected_price, candidate_price) {
        return Err("distribution_plan_candidate_snapshot_mismatch".to_string());
    }
    if candidate
        .pointer("/availability/providerStatus")
        .and_then(Value::as_i64)
        != Some(2)
    {
        return Err("distribution_plan_candidate_unavailable".to_string());
    }
    let evidence = candidate
        .get("evidence")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
    if evidence.is_empty() {
        return Err("distribution_plan_candidate_evidence_missing".to_string());
    }
    let mut paths = HashSet::new();
    let weights = HashMap::from([
        ("passive", 0.4_f64),
        ("active", 0.2_f64),
        ("fallback", 0.1_f64),
        ("preference", 0.3_f64),
    ]);
    let mut score = 0.0;
    for item in evidence {
        let path = item
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
        let expected = weights
            .get(path)
            .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
        if !paths.insert(path) {
            return Err("distribution_plan_candidate_evidence_duplicate".to_string());
        }
        let actual = item
            .get("weight")
            .and_then(Value::as_f64)
            .ok_or_else(|| "distribution_plan_candidate_evidence_invalid".to_string())?;
        if (actual - expected).abs() > f64::EPSILON {
            return Err("distribution_plan_candidate_weight_mismatch".to_string());
        }
        score += expected;
    }
    if (candidate
        .get("recommendationWeight")
        .and_then(Value::as_f64)
        .unwrap_or(-1.0)
        - score)
        .abs()
        > 1e-9
    {
        return Err("distribution_plan_candidate_weight_mismatch".to_string());
    }
    Ok(())
}

fn validate_edit_payload(edit: &Value) -> Result<(), String> {
    let object = edit
        .as_object()
        .ok_or_else(|| "distribution_plan_edit_invalid".to_string())?;
    for key in [
        "selectedResourceIds",
        "assignments",
        "budgetCny",
        "publishStartAt",
        "blockingIssues",
    ] {
        if !object.contains_key(key) {
            return Err("distribution_plan_edit_invalid".to_string());
        }
    }
    if object
        .get("selectedResourceIds")
        .and_then(Value::as_array)
        .is_none()
        || object
            .get("assignments")
            .and_then(Value::as_array)
            .is_none()
        || object
            .get("blockingIssues")
            .and_then(Value::as_array)
            .is_none()
        || object.get("budgetCny").and_then(Value::as_f64).is_none()
        || !object
            .get("publishStartAt")
            .and_then(Value::as_str)
            .is_some_and(looks_like_iso_time)
    {
        return Err("distribution_plan_edit_invalid".to_string());
    }
    reject_secret_shaped_data(edit)
}

fn confirmation_issues(projection: &Value) -> Result<Vec<String>, String> {
    let mut issues = projection
        .get("blockingIssues")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec!["blocking-issues-invalid".to_string()]);
    if projection.get("providerState").and_then(Value::as_str) != Some("available") {
        issues.push("distribution-provider-unavailable".to_string());
    }
    if projection
        .get("questionSources")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        issues.push("question-source-evidence-missing".to_string());
    }
    let articles = projection
        .get("articles")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_articles_invalid".to_string())?;
    let candidates = projection
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_candidates_invalid".to_string())?;
    let selected = projection
        .get("selectedResourceIds")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_selection_invalid".to_string())?;
    let assignments = projection
        .get("assignments")
        .and_then(Value::as_array)
        .ok_or_else(|| "distribution_plan_assignments_invalid".to_string())?;
    let candidate_map = candidates
        .iter()
        .filter_map(|candidate| Some((candidate.get("resourceId")?.as_i64()?, candidate)))
        .collect::<HashMap<_, _>>();
    let selected_ids = selected
        .iter()
        .filter_map(Value::as_i64)
        .collect::<Vec<_>>();
    let selected_set = selected_ids.iter().copied().collect::<HashSet<_>>();
    if selected_ids.len() != selected.len() || selected_set.len() != selected_ids.len() {
        issues.push("selected-channel-duplicate".to_string());
    }
    let mut total = 0.0;
    for id in &selected_ids {
        let Some(candidate) = candidate_map.get(id) else {
            issues.push("selected-channel-outside-resource-snapshot".to_string());
            continue;
        };
        if candidate
            .pointer("/availability/providerStatus")
            .and_then(Value::as_i64)
            != Some(2)
        {
            issues.push("selected-channel-unavailable".to_string());
        }
        match candidate.get("estimatedPriceCny").and_then(Value::as_f64) {
            Some(price) => total += price,
            None => issues.push("selected-channel-price-unknown".to_string()),
        }
        // 发布率不是决策输入（用户裁决 2026-08-18）：不再阻断确认。
        if candidate
            .get("evidence")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            issues.push("selected-channel-evidence-missing".to_string());
        }
    }
    let article_ids = articles
        .iter()
        .filter_map(|article| article.get("id")?.as_str())
        .collect::<HashSet<_>>();
    let mut assigned_articles = HashSet::new();
    let mut assigned_resources = HashSet::new();
    for assignment in assignments {
        let article_id = assignment
            .get("articleId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !article_ids.contains(article_id) || !assigned_articles.insert(article_id) {
            issues.push("article-assignment-invalid".to_string());
        }
        let Some(resource_id) = assignment.get("resourceId").and_then(Value::as_i64) else {
            issues.push("article-channel-unassigned".to_string());
            continue;
        };
        if !selected_set.contains(&resource_id) {
            issues.push("article-channel-not-selected".to_string());
        }
        if !assigned_resources.insert(resource_id) {
            issues.push("channel-reuse-forbidden".to_string());
        }
        if !assignment
            .get("scheduledAt")
            .and_then(Value::as_str)
            .is_some_and(looks_like_iso_time)
        {
            issues.push("assignment-time-invalid".to_string());
        }
    }
    if assigned_articles.len() != article_ids.len() {
        issues.push("article-assignment-incomplete".to_string());
    }
    let budget = projection
        .get("budgetCny")
        .and_then(Value::as_f64)
        .unwrap_or(-1.0);
    if budget < total {
        issues.push("distribution-budget-exceeded".to_string());
    }
    issues.sort();
    issues.dedup();
    Ok(issues)
}

fn set_projection_field(projection: &mut Value, key: &str, value: Value) -> Result<(), String> {
    projection
        .as_object_mut()
        .ok_or_else(|| "distribution_plan_projection_invalid".to_string())?
        .insert(key.to_string(), value);
    Ok(())
}

fn insert_distribution_audit(
    connection: &Connection,
    plan_id: &str,
    revision: i64,
    action: &str,
    session_id: &str,
    detail: &Value,
    now: &str,
) -> Result<(), String> {
    insert_distribution_audit_with_reason(
        connection, plan_id, revision, action, session_id, detail, None, now,
    )
}

/// 聊天修订（票 38）额外落 reason 列（用户指令原文）；普通编辑保持 NULL。
#[allow(clippy::too_many_arguments)]
fn insert_distribution_audit_with_reason(
    connection: &Connection,
    plan_id: &str,
    revision: i64,
    action: &str,
    session_id: &str,
    detail: &Value,
    reason: Option<&str>,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO geo_distribution_plan_audit
                (id, plan_id, revision, action, actor_session_id, detail_json, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v4().to_string(),
                plan_id,
                revision,
                action,
                session_id,
                canonical_json(detail)?,
                reason,
                now
            ],
        )
        .map_err(|error| format!("record distribution plan audit: {error}"))?;
    Ok(())
}

fn require_distribution_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM brand_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("read distribution session: {error}"))?;
    if exists == 1 {
        Ok(())
    } else {
        Err("distribution_plan_session_not_committed".to_string())
    }
}

fn validate_short(value: &str, max: usize, code: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() || normalized.chars().count() > max {
        return Err(code.to_string());
    }
    Ok(normalized.to_string())
}

fn normalize_compare(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn looks_like_iso_time(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn resource_key(value: &Value) -> Result<String, String> {
    let id = value
        .get("resourceId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "distribution_plan_resource_identity_invalid".to_string())?;
    let kind = value
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "media" | "we-media"))
        .ok_or_else(|| "distribution_plan_resource_identity_invalid".to_string())?;
    Ok(format!("{kind}:{id}"))
}

fn parsed_price(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => value
            .parse::<f64>()
            .ok()
            .filter(|price| price.is_finite() && *price >= 0.0),
        Some(Value::Number(value)) => value
            .as_f64()
            .filter(|price| price.is_finite() && *price >= 0.0),
        _ => None,
    }
}

fn same_optional_number(left: Option<f64>, right: Option<f64>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => (left - right).abs() < 1e-9,
        (None, None) => true,
        _ => false,
    }
}

fn empty_discovery_summary() -> Value {
    json!({
        "inputResources": 0,
        "approvedResources": 0,
        "filteredUnavailable": 0,
        "filteredLowPublishedRate": 0,
        "filteredHighPrice": 0,
        "alignedResources": 0,
        "recommendedResources": 0,
    })
}

fn reject_secret_shaped_data(value: &Value) -> Result<(), String> {
    fn walk(value: &Value) -> bool {
        match value {
            Value::Object(object) => object.iter().any(|(key, value)| {
                let lower = key.to_ascii_lowercase();
                lower.contains("secret")
                    || lower.contains("apikey")
                    || lower.contains("api_key")
                    || lower == "authorization"
                    || lower == "signature"
                    || walk(value)
            }),
            Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }
    if walk(value) {
        Err("distribution_plan_secret_field_forbidden".to_string())
    } else {
        Ok(())
    }
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
        for (id, title) in [("session-12", "分发计划"), ("session-other", "另一个会话")] {
            store
                .commit_session(
                    &workspace.id,
                    SessionCommit {
                        id: id.to_string(),
                        title: title.to_string(),
                        title_source: SessionTitleSource::User,
                    },
                )
                .unwrap();
        }
        seed_authority(&workspace);
        (store, workspace)
    }

    fn seed_authority(workspace: &BrandWorkspace) {
        let connection = open_database(workspace).unwrap();
        let now = Utc::now().to_rfc3339();
        connection.execute("INSERT INTO knowledge_raw_inputs (id, session_id, input_text, origin, intent, created_at) VALUES ('raw-12','session-12','汽车行业','user-stated','knowledge-update',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_fact_candidates (id,raw_input_id,session_id,subject,predicate,scope_json,fact_key,value_json,normalized_value_json,excerpt,confidence,profile_provenance,origin,intent,status,base_version,proposed_at,resolved_at) VALUES ('candidate-12','raw-12','session-12','鲸跃','enterprise-profile.industry','{}','industry','\"汽车\"','\"汽车\"','汽车',1.0,'asked','user-stated','knowledge-update','adopted',0,?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_decisions (id,candidate_id,decision,actor_id,actor_session_id,expected_version,before_json,after_json,reason,decided_at) VALUES ('decision-12','candidate-12','adopt-new','desktop-user','session-12',0,NULL,'\"汽车\"','test fixture',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_current_facts (fact_key,subject,predicate,scope_json,normalized_value_json,unit,version,confirmed_by,confirmed_at,updated_at) VALUES ('industry','鲸跃','enterprise-profile.industry','{}','\"汽车\"',NULL,1,'desktop-user',?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_versions (version,decision_id,actor_session_id,snapshot_hash,created_at) VALUES (1,'decision-12','session-12','hash-12',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO knowledge_version_facts (knowledge_version,fact_key,fact_version,normalized_value_json,unit,sources_json) VALUES (1,'industry',1,'\"汽车\"',NULL,'[]')", []).unwrap();

        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('operation-pool','session-12','question-pool-confirmed',?1)", [&now]).unwrap();
        let pool_questions = json!([
            {"id":"q1","text":"汽车音响怎么选","selected":true},
            {"id":"q2","text":"新能源车主关注什么","selected":true}
        ]);
        connection.execute("INSERT INTO geo_question_pools (id,operation_id,created_by_session_id,knowledge_version,product_line,target_region,generation_parameters_json,source_evidence_json,keywords_json,questions_json,status,revision,created_at,updated_at) VALUES ('pool-12','operation-pool','session-12',1,'汽车音响','中国','{}','[]','[]',?1,'confirmed',1,?2,?2)", params![pool_questions.to_string(), now]).unwrap();
        connection.execute("INSERT INTO geo_question_pool_decisions (id,pool_id,session_id,decision,expected_revision,revision,questions_json,selected_question_ids_json,actor_id,decided_at) VALUES ('decision-pool-12','pool-12','session-12','confirm-selection',0,1,?1,?2,'desktop-user',?3)", params![pool_questions.to_string(), "[\"q1\",\"q2\"]", now]).unwrap();

        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('operation-topic','session-12','topic-plan-confirmed',?1)", [&now]).unwrap();
        let items = json!([
            {"id":"item-1","sourceQuestionIds":["q1"],"approvalStatus":"approved"},
            {"id":"item-2","sourceQuestionIds":["q2"],"approvalStatus":"approved"}
        ]);
        connection.execute("INSERT INTO geo_topic_plans (id,operation_id,created_by_session_id,question_pool_id,question_pool_revision,knowledge_version,product_line,target_region,policy_version,status,revision,topics_json,items_json,selected_item_ids_json,model_audit_json,provider_snapshot_json,model_attempts_json,created_at,updated_at) VALUES ('topic-plan-12','operation-topic','session-12','pool-12',1,1,'汽车音响','中国','fixture-policy','confirmed',1,'[]',?1,'[\"item-1\",\"item-2\"]','{}','{}','[]',?2,?2)", params![items.to_string(), now]).unwrap();

        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('operation-articles','session-12','article-generation-completed',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_article_operations (operation_id,created_by_session_id,source_kind,topic_plan_id,topic_plan_revision,knowledge_version,product_line,target_region,policy_version,operation_spec_json,status,created_at,updated_at) VALUES ('operation-articles','session-12','confirmed-topic-plan','topic-plan-12',1,1,'汽车音响','中国','fixture-policy','{}','completed',?1,?1)", [&now]).unwrap();
        for (id, item, title, topic) in [
            ("article-1", "item-1", "文章一固定标题", "汽车音响选择"),
            ("article-2", "item-2", "文章二固定标题", "新能源车主"),
        ] {
            connection.execute("INSERT INTO geo_articles (id,operation_id,source_plan_item_id,knowledge_version,content_type,topic,requested_title,constraints,planned_facts_json,status,revision,approved_revision,generation_attempt,created_at,updated_at) VALUES (?1,'operation-articles',?2,1,'guide',?3,?4,'','[]','approved',1,1,1,?5,?5)", params![id, item, topic, title, now]).unwrap();
            connection.execute("INSERT INTO geo_article_versions (article_id,revision,title,body_path,approved_body_path,body_sha256,origin,based_on_revision,review_json,model_audit_json,created_by_session_id,created_at,approved_at) VALUES (?1,1,?2,?3,?3,'fixture-sha','generated',NULL,'{}','{}','session-12',?4,?4)", params![id, title, format!("articles/{id}.md"), now]).unwrap();
        }

        connection.execute("INSERT INTO geo_operations (id,session_id,state,created_at) VALUES ('operation-baseline','session-12','baseline-succeeded',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_baselines (id,operation_id,created_by_session_id,question_pool_id,question_pool_revision,knowledge_version,brand_names_json,provider_snapshots_json,policy_version,status,idempotency_key,created_at,updated_at) VALUES ('baseline-12','operation-baseline','session-12','pool-12',1,1,'[\"鲸跃\"]','[]','fixture-policy','succeeded','baseline-fixture',?1,?1)", [&now]).unwrap();
        for (id, question_id, question, title, url) in [
            (
                "unit-1",
                "q1",
                "汽车音响怎么选",
                "可信来源一",
                "https://source-one.example.com/guide",
            ),
            (
                "unit-2",
                "q2",
                "新能源车主关注什么",
                "可信来源二",
                "https://source-two.example.com/report",
            ),
        ] {
            let citations = json!([{"title": title, "url": url}]);
            connection.execute("INSERT INTO geo_baseline_units (id,baseline_id,question_id,question_text,engine_id,provider_snapshot_json,status,attempt_number,citations_json) VALUES (?1,'baseline-12',?2,?3,'doubao','{}','succeeded',1,?4)", params![id, question_id, question, citations.to_string()]).unwrap();
        }
    }

    /// 模拟 Node 现场探测产出的问题来源（每问一条引用）。
    fn probed_sources(context: &DistributionPlanningContext) -> Vec<DistributionQuestionSource> {
        context
            .questions
            .iter()
            .enumerate()
            .map(|(index, question)| DistributionQuestionSource {
                id: format!("probe:{}:1", question.id),
                question_id: question.id.clone(),
                question: question.question.clone(),
                title: format!("探测来源{}", index + 1),
                url: format!("https://probe-{index}.example.com/source"),
                article_ids: Vec::new(),
            })
            .collect()
    }

    fn prepare_request(context: &DistributionPlanningContext) -> DistributionPlanPrepareRequest {
        DistributionPlanPrepareRequest {
            article_operation_id: context.article_operation_id.clone(),
            article_ids: context
                .articles
                .iter()
                .map(|article| article.id.clone())
                .collect(),
            industry: context.industry.clone(),
            target_audience: "新能源车主".to_string(),
            question_sources: probed_sources(context),
            preferred_resource_ids: vec![],
            mapping_mode: "one-to-one".to_string(),
            ratio: json!({"media": 1, "weMedia": 1}),
            budget_cny: 500.0,
            publish_start_at: "2026-08-20T02:00:00Z".to_string(),
        }
    }

    fn finish_request(
        preparation: &DistributionPlanPreparation,
        price: Value,
        published_rate: i64,
    ) -> DistributionPlanDiscoveryFinishRequest {
        let resource = json!({
            "resourceId": 8,
            "kind": "media",
            "name": "汽车 GEO 产业观察",
            "status": 2,
            "price": price,
            "publishedRate": published_rate,
            "entranceLink": "https://source-one.example.com",
            "remark": "汽车 GEO",
            "channelType": 6,
            "industryCategory": Value::Null,
            "area": Value::Null,
            "canWeekend": true,
            "publishSpeed": Value::Null,
            "publishedAverageMinutes": Value::Null,
            "platform": Value::Null,
        });
        let estimated_price = parsed_price(resource.get("price"));
        let candidate = json!({
            "resourceId": 8,
            "kind": "media",
            "name": "汽车 GEO 产业观察",
            "estimatedPriceCny": estimated_price,
            "publishedRate": published_rate,
            "availability": {
                "state": "available",
                "providerStatus": 2,
                "basis": "supermedia-approved-resource"
            },
            "recommendationWeight": 0.7,
            "hitCount": 3,
            "pathHits": ["passive", "active", "fallback"],
            "evidence": [
                {"path":"passive","weight":0.4,"label":"真实来源","reference":"q1","url":"https://probe-0.example.com/source","articleIds":["article-1"]},
                {"path":"active","weight":0.2,"label":"全局召回","reference":"recall:汽车 GEO 产业观察","url":"https://probe-0.example.com","articleIds":[]},
                {"path":"fallback","weight":0.1,"label":"类目","reference":"industry:汽车","url":"https://source-one.example.com","articleIds":[]}
            ],
            "fitReasons": ["行业匹配", "内容可发"],
            "risks": [],
            "uncertainties": if estimated_price.is_none() { json!(["unknown"]) } else { json!([]) },
            "resourceSnapshot": resource,
        });
        DistributionPlanDiscoveryFinishRequest {
            plan_id: preparation.plan["id"].as_str().unwrap().to_string(),
            expected_revision: preparation.plan["revision"].as_i64().unwrap(),
            claim_token: preparation.claim_token.clone(),
            provider_state: "available".to_string(),
            provider_snapshot: json!({
                "slot":"distribution",
                "provider":"超级媒介",
                "endpointFamily":"chaojimeijie-resource-api",
                "policyVersion":POLICY_VERSION,
                "fetchedAt":"2026-08-15T00:00:00Z",
                "mediaTotal":1,
                "weMediaTotal":0
            }),
            resource_snapshot: json!([resource]),
            candidates: json!([candidate]),
            selected_resource_ids: json!([8]),
            assignments: json!([{
                "articleId":"article-1",
                "resourceId":8,
                "reason":"source-evidence",
                "scheduledAt":"2026-08-20T02:00:00Z"
            }]),
            discovery_summary: json!({
                "inputResources":1,"approvedResources":1,"filteredUnavailable":0,
                "filteredLowPublishedRate":0,"filteredHighPrice":0,
                "alignedResources":1,"recommendedResources":1
            }),
            blocking_issues: json!([]),
        }
    }

    #[test]
    fn confirmed_topic_plan_maps_each_question_only_to_its_article() {
        let (store, workspace) = setup();
        let context = store
            .distribution_planning_context(
                &workspace.id,
                "session-other",
                DistributionPlanningContextRequest {
                    article_operation_id: Some("operation-articles".to_string()),
                },
            )
            .unwrap();
        assert_eq!(context.industry, "汽车");
        assert_eq!(context.articles.len(), 2);
        let by_question = context
            .questions
            .iter()
            .map(|question| (question.id.as_str(), question.article_ids.clone()))
            .collect::<HashMap<_, _>>();
        assert_eq!(by_question["q1"], vec!["article-1"]);
        assert_eq!(by_question["q2"], vec!["article-2"]);
    }

    #[test]
    fn direct_articles_do_not_invent_per_article_question_hits() {
        let (store, workspace) = setup();
        let connection = open_database(&workspace).unwrap();
        connection.execute("UPDATE geo_article_operations SET source_kind='direct', topic_plan_id=NULL, topic_plan_revision=NULL WHERE operation_id='operation-articles'", []).unwrap();
        let context = store
            .distribution_planning_context(
                &workspace.id,
                "session-12",
                DistributionPlanningContextRequest {
                    article_operation_id: Some("operation-articles".to_string()),
                },
            )
            .unwrap();
        assert!(context
            .questions
            .iter()
            .all(|question| question.article_ids.is_empty()));
    }

    #[test]
    fn prepare_rejects_tampered_sources_and_articles_and_fixes_authority_snapshot() {
        let (store, workspace) = setup();
        let context = store
            .distribution_planning_context(
                &workspace.id,
                "session-12",
                DistributionPlanningContextRequest {
                    article_operation_id: Some("operation-articles".to_string()),
                },
            )
            .unwrap();

        let mut tampered_source = prepare_request(&context);
        tampered_source.question_sources[0].question = "伪造的问题文本".to_string();
        assert_eq!(
            store
                .prepare_distribution_plan(&workspace.id, "session-12", tampered_source)
                .unwrap_err(),
            "distribution_plan_question_text_mismatch"
        );
        let mut unknown_question = prepare_request(&context);
        unknown_question.question_sources[0].question_id = "q-forged".to_string();
        assert_eq!(
            store
                .prepare_distribution_plan(&workspace.id, "session-12", unknown_question)
                .unwrap_err(),
            "distribution_plan_question_not_in_confirmed_pool"
        );

        let mut tampered_article = prepare_request(&context);
        tampered_article.article_ids = vec!["article-forged".to_string()];
        assert_eq!(
            store
                .prepare_distribution_plan(&workspace.id, "session-12", tampered_article)
                .unwrap_err(),
            "distribution_plan_approved_article_mismatch"
        );

        let mut trusted = prepare_request(&context);
        trusted.question_sources[0].article_ids = vec!["article-2".to_string()];
        let preparation = store
            .prepare_distribution_plan(&workspace.id, "session-12", trusted)
            .unwrap();
        assert_eq!(
            preparation
                .plan
                .pointer("/questionSources/0/articleIds")
                .unwrap(),
            &json!(["article-1"])
        );
        assert_eq!(
            preparation.plan.pointer("/articles/0/title").unwrap(),
            "文章一固定标题"
        );
        assert_eq!(
            store
                .get_distribution_plan(
                    &workspace.id,
                    "session-other",
                    DistributionPlanGetRequest {
                        plan_id: preparation.plan["id"].as_str().unwrap().to_string(),
                    },
                )
                .unwrap_err(),
            "distribution_plan_draft_session_mismatch"
        );
    }

    #[test]
    fn discovery_rejects_tampered_resource_fields_and_path_evidence_then_fixes_snapshot() {
        let (store, workspace) = setup();
        let context = store
            .distribution_planning_context(
                &workspace.id,
                "session-12",
                DistributionPlanningContextRequest {
                    article_operation_id: Some("operation-articles".to_string()),
                },
            )
            .unwrap();
        let mut source = prepare_request(&context);
        source.article_ids = vec!["article-1".to_string()];
        source.question_sources = probed_sources(&context);
        let preparation = store
            .prepare_distribution_plan(&workspace.id, "session-12", source)
            .unwrap();

        let mut tampered_name = finish_request(&preparation, json!("80"), 90);
        tampered_name.candidates[0]["name"] = json!("LLM 伪造名称");
        assert_eq!(
            store
                .finish_distribution_plan_discovery(&workspace.id, "session-12", tampered_name)
                .unwrap_err(),
            "distribution_plan_candidate_snapshot_mismatch"
        );

        let mut tampered_evidence = finish_request(&preparation, json!("80"), 90);
        tampered_evidence.candidates[0]["evidence"][0]["reference"] = json!("q-forged");
        assert_eq!(
            store
                .finish_distribution_plan_discovery(&workspace.id, "session-12", tampered_evidence)
                .unwrap_err(),
            "distribution_plan_passive_evidence_mismatch"
        );

        let finished = store
            .finish_distribution_plan_discovery(
                &workspace.id,
                "session-12",
                finish_request(&preparation, json!("80"), 90),
            )
            .unwrap();
        assert_eq!(finished["resourceSnapshot"][0]["name"], "汽车 GEO 产业观察");
        assert_eq!(finished["candidates"][0]["evidence"][0]["reference"], "q1");
    }

    #[test]
    fn rust_confirmation_recomputes_unknown_price_blockers_only() {
        let (store, workspace) = setup();
        let context = store
            .distribution_planning_context(
                &workspace.id,
                "session-12",
                DistributionPlanningContextRequest {
                    article_operation_id: Some("operation-articles".to_string()),
                },
            )
            .unwrap();
        let mut source = prepare_request(&context);
        source.article_ids = vec!["article-1".to_string()];
        source.question_sources = probed_sources(&context);
        let preparation = store
            .prepare_distribution_plan(&workspace.id, "session-12", source)
            .unwrap();
        let finished = store
            .finish_distribution_plan_discovery(
                &workspace.id,
                "session-12",
                finish_request(&preparation, Value::Null, 0),
            )
            .unwrap();
        assert_eq!(
            store
                .confirm_distribution_plan(
                    &workspace.id,
                    "session-other",
                    DistributionPlanConfirmRequest {
                        plan_id: finished["id"].as_str().unwrap().to_string(),
                        expected_revision: finished["revision"].as_i64().unwrap(),
                    },
                )
                .unwrap_err(),
            "distribution_plan_draft_session_mismatch"
        );
        let error = store
            .confirm_distribution_plan(
                &workspace.id,
                "session-12",
                DistributionPlanConfirmRequest {
                    plan_id: finished["id"].as_str().unwrap().to_string(),
                    expected_revision: finished["revision"].as_i64().unwrap(),
                },
            )
            .unwrap_err();
        assert!(error.contains("selected-channel-price-unknown"));
        // 发布率不参与决策（用户裁决 2026-08-18）：不再产生 rate 阻断码。
        assert!(!error.contains("selected-channel-published-rate-unknown"));
    }
}
