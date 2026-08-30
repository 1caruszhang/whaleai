use super::*;
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write;

const POLICY_VERSION: &str = "xiaojing-content-prompt-v5";
const MAX_ARTICLES: usize = 20;
const MAX_BODY_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleDirectSpec {
    pub count: usize,
    pub themes: Vec<String>,
    pub content_type: String,
    #[serde(default)]
    pub constraints: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleOperationStartRequest {
    pub source_kind: String,
    pub topic_plan_id: Option<String>,
    pub direct_spec: Option<ArticleDirectSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleLatestRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleOperationGetRequest {
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleGetRequest {
    pub operation_id: String,
    pub article_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleGenerationClaimRequest {
    pub operation_id: String,
    pub article_id: String,
    pub expected_revision: i64,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleGenerationFinishRequest {
    pub operation_id: String,
    pub article_id: String,
    pub expected_revision: i64,
    pub claim_token: String,
    pub title: String,
    pub body: String,
    pub model_audit: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleGenerationFailRequest {
    pub operation_id: String,
    pub article_id: String,
    pub expected_revision: i64,
    pub claim_token: String,
    pub failure_reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleEditRequest {
    pub operation_id: String,
    pub article_id: String,
    pub expected_revision: i64,
    pub title: String,
    pub body: String,
    /// 聊天修订（票 38）携带的用户指令原文，写入版本行 model_audit_json。
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleBodyRequest {
    pub operation_id: String,
    pub article_id: String,
    pub revision: Option<i64>,
    #[serde(default)]
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleBodyProjection {
    pub article_id: String,
    pub revision: i64,
    pub title: String,
    pub body: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleReviewClaimRequest {
    pub operation_id: String,
    pub article_id: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArticleReviewFinishRequest {
    pub operation_id: String,
    pub article_id: String,
    pub expected_revision: i64,
    pub claim_token: String,
    pub review: Value,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleVersionProjection {
    pub revision: i64,
    pub title: String,
    pub body_path: String,
    pub body_sha256: String,
    pub origin: String,
    pub based_on_revision: Option<i64>,
    pub review: Option<Value>,
    pub created_at: String,
    pub approved_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleProjection {
    pub id: String,
    pub operation_id: String,
    pub workspace_id: String,
    pub source_plan_item_id: Option<String>,
    pub knowledge_version: i64,
    pub content_type: String,
    pub topic: String,
    pub requested_title: String,
    pub constraints: String,
    pub planned_facts: Value,
    pub status: String,
    pub revision: i64,
    pub approved_revision: Option<i64>,
    pub failure_reason: Option<String>,
    pub generation_attempt: i64,
    pub current_version: Option<ArticleVersionProjection>,
    pub approved_version: Option<ArticleVersionProjection>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleOperationProjection {
    pub id: String,
    pub workspace_id: String,
    pub created_by_session_id: String,
    pub source_kind: String,
    pub topic_plan_id: Option<String>,
    pub topic_plan_revision: Option<i64>,
    pub knowledge_version: i64,
    pub policy_version: String,
    pub status: String,
    pub articles: Vec<ArticleProjection>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArticleGenerationContext {
    pub article: ArticleProjection,
    pub brand_name: String,
    pub product_line: String,
    pub target_region: String,
    pub claim_token: String,
}

#[derive(Debug, Clone)]
struct ArticleSeed {
    source_plan_item_id: Option<String>,
    content_type: String,
    topic: String,
    requested_title: String,
    constraints: String,
    planned_facts: Value,
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_article_operations (
                operation_id TEXT PRIMARY KEY REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                source_kind TEXT NOT NULL CHECK(source_kind IN ('confirmed-topic-plan','direct')),
                topic_plan_id TEXT,
                topic_plan_revision INTEGER,
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                product_line TEXT NOT NULL,
                target_region TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                operation_spec_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('running','completed','completed-with-failures')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS geo_article_operation_latest
                ON geo_article_operations(updated_at DESC, operation_id DESC);
             CREATE TABLE IF NOT EXISTS geo_articles (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL REFERENCES geo_article_operations(operation_id),
                source_plan_item_id TEXT,
                knowledge_version INTEGER NOT NULL REFERENCES knowledge_versions(version),
                content_type TEXT NOT NULL CHECK(content_type IN ('guide','showcase','ranking','news','news_light')),
                topic TEXT NOT NULL,
                requested_title TEXT NOT NULL,
                constraints TEXT NOT NULL,
                planned_facts_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('planned','drafting','draft_ready','reviewing','approved','generation_failed','rejected')),
                revision INTEGER NOT NULL DEFAULT 0,
                approved_revision INTEGER,
                failure_reason TEXT,
                generation_attempt INTEGER NOT NULL DEFAULT 0,
                generation_claim_token TEXT,
                review_claim_token TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(operation_id, source_plan_item_id)
             );
             CREATE TABLE IF NOT EXISTS geo_article_versions (
                article_id TEXT NOT NULL REFERENCES geo_articles(id),
                revision INTEGER NOT NULL,
                title TEXT NOT NULL,
                body_path TEXT NOT NULL,
                approved_body_path TEXT,
                body_sha256 TEXT NOT NULL,
                origin TEXT NOT NULL CHECK(origin IN ('generated','user-edited')),
                based_on_revision INTEGER,
                review_json TEXT,
                model_audit_json TEXT NOT NULL,
                created_by_session_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                approved_at TEXT,
                PRIMARY KEY(article_id, revision)
             );
             CREATE TABLE IF NOT EXISTS geo_article_generation_attempts (
                id TEXT PRIMARY KEY,
                article_id TEXT NOT NULL REFERENCES geo_articles(id),
                attempt INTEGER NOT NULL,
                base_revision INTEGER NOT NULL,
                mode TEXT NOT NULL CHECK(mode IN ('initial','regenerate')),
                outcome TEXT NOT NULL CHECK(outcome IN ('running','success','failed')),
                failure_reason TEXT,
                model_audit_json TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(article_id, attempt)
             );
             CREATE TABLE IF NOT EXISTS geo_article_review_attempts (
                id TEXT PRIMARY KEY,
                article_id TEXT NOT NULL REFERENCES geo_articles(id),
                revision INTEGER NOT NULL,
                outcome TEXT NOT NULL CHECK(outcome IN ('running','passed','failed')),
                review_json TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT
             );",
        )
        .map_err(|error| format!("initialize article schema: {error}"))?;
    super::drop_brand_sessions_foreign_keys(
        connection,
        &["geo_article_operations", "geo_article_versions"],
    )
}

impl BrandWorkspaceStore {
    pub fn latest_article_operation(
        &self,
        workspace_id: &str,
        session_id: &str,
        _request: ArticleLatestRequest,
    ) -> Result<Option<ArticleOperationProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let id = connection
            .query_row(
                "SELECT operation_id FROM geo_article_operations
                 WHERE created_by_session_id=?1
                 ORDER BY updated_at DESC, operation_id DESC LIMIT 1",
                [session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest article operation: {error}"))?;
        id.map(|id| read_article_operation(&connection, workspace_id, &id))
            .transpose()
    }

    pub fn get_article_operation(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleOperationGetRequest,
    ) -> Result<ArticleOperationProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let is_owner = require_article_operation_visibility(
            &connection,
            &request.operation_id,
            session_id,
            true,
        )?;
        let operation = read_article_operation(&connection, workspace_id, &request.operation_id)?;
        Ok(if is_owner {
            operation
        } else {
            approved_only_operation(operation)?
        })
    }

    pub fn get_article(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleGetRequest,
    ) -> Result<ArticleProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let article = read_article(&connection, workspace_id, &request.article_id)?;
        if article.operation_id != request.operation_id {
            return Err("article_generation_operation_mismatch".to_string());
        }
        let owner_session_id: String = connection
            .query_row(
                "SELECT created_by_session_id FROM geo_article_operations
                 WHERE operation_id=?1",
                [&request.operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read article operation owner: {error}"))?
            .ok_or_else(|| "article_generation_operation_not_found".to_string())?;
        let is_owner = owner_session_id == session_id;
        Ok(if is_owner {
            article
        } else {
            approved_only_article(article)?
        })
    }

    pub fn start_article_operation(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleOperationStartRequest,
    ) -> Result<ArticleOperationProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article operation transaction: {error}"))?;
        let (
            knowledge_version,
            product_line,
            target_region,
            topic_plan_id,
            topic_plan_revision,
            spec,
            seeds,
        ) = match request.source_kind.as_str() {
            "confirmed-topic-plan" => prepare_plan_article_seeds(
                &transaction,
                &workspace,
                request.topic_plan_id.as_deref(),
            )?,
            "direct" => prepare_direct_article_seeds(
                &transaction,
                &workspace,
                request.direct_spec.as_ref(),
            )?,
            _ => return Err("article_generation_source_invalid".to_string()),
        };
        if seeds.is_empty() || seeds.len() > MAX_ARTICLES {
            return Err("article_generation_article_count_invalid".to_string());
        }
        let operation_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
                 VALUES (?1, ?2, 'article-generation-running', ?3)",
                params![operation_id, session_id, now],
            )
            .map_err(|error| format!("create article operation: {error}"))?;
        transaction
            .execute(
                "INSERT INTO geo_article_operations
                    (operation_id, created_by_session_id, source_kind, topic_plan_id,
                     topic_plan_revision, knowledge_version, product_line, target_region,
                     policy_version, operation_spec_json, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'running', ?11, ?11)",
                params![
                    operation_id,
                    session_id,
                    request.source_kind,
                    topic_plan_id,
                    topic_plan_revision,
                    knowledge_version,
                    product_line,
                    target_region,
                    POLICY_VERSION,
                    canonical_article_json(&spec)?,
                    now
                ],
            )
            .map_err(|error| format!("persist article operation: {error}"))?;
        for seed in seeds {
            let article_id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    "INSERT INTO geo_articles
                        (id, operation_id, source_plan_item_id, knowledge_version,
                         content_type, topic, requested_title, constraints,
                         planned_facts_json, status, revision, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'planned', 0, ?10, ?10)",
                    params![
                        article_id,
                        operation_id,
                        seed.source_plan_item_id,
                        knowledge_version,
                        seed.content_type,
                        seed.topic,
                        seed.requested_title,
                        seed.constraints,
                        canonical_article_json(&seed.planned_facts)?,
                        now
                    ],
                )
                .map_err(|error| format!("persist planned article: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO geo_artifacts
                        (id, operation_id, session_id, kind, knowledge_version, created_at)
                     VALUES (?1, ?2, ?3, 'article-draft', ?4, ?5)",
                    params![article_id, operation_id, session_id, knowledge_version, now],
                )
                .map_err(|error| format!("persist article artifact: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit article operation: {error}"))?;
        read_article_operation(&connection, workspace_id, &operation_id)
    }

    pub fn claim_article_generation(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleGenerationClaimRequest,
    ) -> Result<ArticleGenerationContext, String> {
        if !matches!(request.mode.as_str(), "initial" | "regenerate") {
            return Err("article_generation_mode_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article generation claim: {error}"))?;
        let (operation_id, status, revision, attempt): (String, String, i64, i64) = transaction
            .query_row(
                "SELECT operation_id, status, revision, generation_attempt FROM geo_articles WHERE id=?1",
                [&request.article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("read article generation claim: {error}"))?
            .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if operation_id != request.operation_id {
            return Err("article_generation_operation_mismatch".to_string());
        }
        require_article_operation_visibility(&transaction, &operation_id, session_id, false)?;
        if revision != request.expected_revision {
            return Err("article_generation_revision_conflict".to_string());
        }
        let allowed = if request.mode == "initial" {
            status == "planned"
        } else {
            matches!(
                status.as_str(),
                "generation_failed" | "draft_ready" | "rejected" | "approved"
            )
        };
        if !allowed {
            return Err("article_generation_status_invalid".to_string());
        }
        let claim_token = Uuid::new_v4().to_string();
        let attempt_id = Uuid::new_v4().to_string();
        let next_attempt = attempt + 1;
        let now = Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE geo_articles SET status='drafting', generation_attempt=?2,
                     generation_claim_token=?3, review_claim_token=NULL,
                     failure_reason=NULL, updated_at=?4
                 WHERE id=?1 AND revision=?5 AND status=?6",
                params![
                    request.article_id,
                    next_attempt,
                    claim_token,
                    now,
                    revision,
                    status
                ],
            )
            .map_err(|error| format!("claim article generation: {error}"))?;
        if changed != 1 {
            return Err("article_generation_revision_conflict".to_string());
        }
        transaction
            .execute(
                "INSERT INTO geo_article_generation_attempts
                    (id, article_id, attempt, base_revision, mode, outcome, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)",
                params![
                    attempt_id,
                    request.article_id,
                    next_attempt,
                    revision,
                    request.mode,
                    now
                ],
            )
            .map_err(|error| format!("audit article generation claim: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit article generation claim: {error}"))?;
        let article = read_article(&connection, workspace_id, &request.article_id)?;
        let (brand_name, product_line, target_region): (String, String, String) = connection
            .query_row(
                "SELECT workspace.name, operation.product_line, operation.target_region
                 FROM geo_articles article
                 JOIN geo_article_operations operation ON operation.operation_id=article.operation_id
                 CROSS JOIN brand_workspace workspace
                 WHERE article.id=?1 AND workspace.singleton=1",
                [&request.article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("read article generation context: {error}"))?;
        Ok(ArticleGenerationContext {
            article,
            brand_name,
            product_line,
            target_region,
            claim_token,
        })
    }

    pub fn finish_article_generation(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleGenerationFinishRequest,
    ) -> Result<ArticleProjection, String> {
        validate_article_title_body(&request.title, &request.body)?;
        if !request.model_audit.is_object() {
            return Err("article_generation_model_audit_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article generation finish: {error}"))?;
        let (operation_id, revision, attempt, status, claim): (
            String,
            i64,
            i64,
            String,
            Option<String>,
        ) = transaction
            .query_row(
                "SELECT operation_id, revision, generation_attempt, status, generation_claim_token
                     FROM geo_articles WHERE id=?1",
                [&request.article_id],
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
            .map_err(|error| format!("read article generation finish: {error}"))?
            .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if revision != request.expected_revision
            || operation_id != request.operation_id
            || status != "drafting"
            || claim.as_deref() != Some(request.claim_token.as_str())
        {
            return Err("article_generation_claim_conflict".to_string());
        }
        require_article_operation_visibility(&transaction, &operation_id, session_id, false)?;
        let next_revision = revision + 1;
        let relative_path = format!(
            "operations/{operation_id}/articles/{}/v{next_revision}.md",
            request.article_id
        );
        let body_path = workspace.root_path.join(&relative_path);
        atomic_write_immutable(&body_path, request.body.as_bytes())?;
        let body_sha256 = format!("{:x}", Sha256::digest(request.body.as_bytes()));
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "INSERT INTO geo_article_versions
                    (article_id, revision, title, body_path, body_sha256, origin,
                     based_on_revision, model_audit_json, created_by_session_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'generated', ?6, ?7, ?8, ?9)",
                params![
                    request.article_id,
                    next_revision,
                    request.title.trim(),
                    relative_path,
                    body_sha256,
                    if revision == 0 { None } else { Some(revision) },
                    canonical_article_json(&request.model_audit)?,
                    session_id,
                    now
                ],
            )
            .map_err(|error| format!("persist article version: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_articles SET status='draft_ready', revision=?2,
                     generation_claim_token=NULL, review_claim_token=NULL,
                     failure_reason=NULL, updated_at=?3
                 WHERE id=?1 AND revision=?4 AND generation_claim_token=?5",
                params![
                    request.article_id,
                    next_revision,
                    now,
                    revision,
                    request.claim_token
                ],
            )
            .map_err(|error| format!("finish article generation: {error}"))?;
        if changed != 1 {
            return Err("article_generation_claim_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_article_generation_attempts
                 SET outcome='success', model_audit_json=?3, finished_at=?4
                 WHERE article_id=?1 AND attempt=?2 AND outcome='running'",
                params![
                    request.article_id,
                    attempt,
                    canonical_article_json(&request.model_audit)?,
                    now
                ],
            )
            .map_err(|error| format!("finish article generation audit: {error}"))?;
        refresh_article_operation_status(&transaction, &operation_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("commit article generation: {error}"))?;
        read_article(&connection, workspace_id, &request.article_id)
    }

    pub fn fail_article_generation(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleGenerationFailRequest,
    ) -> Result<ArticleProjection, String> {
        let reason = request.failure_reason.trim();
        if reason.is_empty() || reason.len() > 1_000 {
            return Err("article_generation_failure_reason_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article generation failure: {error}"))?;
        let (operation_id, revision, attempt, status, claim): (
            String,
            i64,
            i64,
            String,
            Option<String>,
        ) = transaction
            .query_row(
                "SELECT operation_id, revision, generation_attempt, status, generation_claim_token
                     FROM geo_articles WHERE id=?1",
                [&request.article_id],
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
            .map_err(|error| format!("read article generation failure: {error}"))?
            .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if revision != request.expected_revision
            || operation_id != request.operation_id
            || status != "drafting"
            || claim.as_deref() != Some(request.claim_token.as_str())
        {
            return Err("article_generation_claim_conflict".to_string());
        }
        require_article_operation_visibility(&transaction, &operation_id, session_id, false)?;
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "UPDATE geo_articles SET status='generation_failed', failure_reason=?2,
                     generation_claim_token=NULL, updated_at=?3
                 WHERE id=?1 AND revision=?4 AND generation_claim_token=?5",
                params![
                    request.article_id,
                    reason,
                    now,
                    revision,
                    request.claim_token
                ],
            )
            .map_err(|error| format!("fail article generation: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_article_generation_attempts
                 SET outcome='failed', failure_reason=?3, finished_at=?4
                 WHERE article_id=?1 AND attempt=?2 AND outcome='running'",
                params![request.article_id, attempt, reason, now],
            )
            .map_err(|error| format!("fail article generation audit: {error}"))?;
        refresh_article_operation_status(&transaction, &operation_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("commit article generation failure: {error}"))?;
        read_article(&connection, workspace_id, &request.article_id)
    }

    pub fn edit_article(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleEditRequest,
    ) -> Result<ArticleProjection, String> {
        validate_article_title_body(&request.title, &request.body)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article edit: {error}"))?;
        let (operation_id, revision, status): (String, i64, String) = transaction
            .query_row(
                "SELECT operation_id, revision, status FROM geo_articles WHERE id=?1",
                [&request.article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read article edit: {error}"))?
            .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if revision != request.expected_revision {
            return Err("article_generation_revision_conflict".to_string());
        }
        if operation_id != request.operation_id {
            return Err("article_generation_operation_mismatch".to_string());
        }
        require_article_operation_visibility(&transaction, &operation_id, session_id, false)?;
        if matches!(status.as_str(), "drafting" | "reviewing") || revision == 0 {
            return Err("article_edit_status_invalid".to_string());
        }
        let next_revision = revision + 1;
        let relative_path = format!(
            "operations/{operation_id}/articles/{}/v{next_revision}.md",
            request.article_id
        );
        atomic_write_immutable(
            &workspace.root_path.join(&relative_path),
            request.body.as_bytes(),
        )?;
        let hash = format!("{:x}", Sha256::digest(request.body.as_bytes()));
        let now = Utc::now().to_rfc3339();
        // 聊天修订把用户指令原文留在版本行审计里；普通面板/接口编辑保持 '{}'。
        let model_audit_json = request
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| serde_json::json!({ "revisionReason": value }).to_string())
            .unwrap_or_else(|| "{}".to_string());
        transaction
            .execute(
                "INSERT INTO geo_article_versions
                    (article_id, revision, title, body_path, body_sha256, origin,
                     based_on_revision, model_audit_json, created_by_session_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'user-edited', ?6, ?7, ?8, ?9)",
                params![
                    request.article_id,
                    next_revision,
                    request.title.trim(),
                    relative_path,
                    hash,
                    revision,
                    model_audit_json,
                    session_id,
                    now
                ],
            )
            .map_err(|error| format!("persist article edit version: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_articles SET status='draft_ready', revision=?2,
                     failure_reason=NULL, generation_claim_token=NULL,
                     review_claim_token=NULL, updated_at=?3
                 WHERE id=?1 AND revision=?4 AND status=?5",
                params![request.article_id, next_revision, now, revision, status],
            )
            .map_err(|error| format!("finish article edit: {error}"))?;
        refresh_article_operation_status(&transaction, &operation_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("commit article edit: {error}"))?;
        read_article(&connection, workspace_id, &request.article_id)
    }

    pub fn read_article_body(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleBodyRequest,
    ) -> Result<ArticleBodyProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let (operation_id, current_revision, approved_revision, owner_session_id): (
            String,
            i64,
            Option<i64>,
            String,
        ) = connection
            .query_row(
                "SELECT article.operation_id, article.revision, article.approved_revision,
                        operation.created_by_session_id
                 FROM geo_articles article
                 JOIN geo_article_operations operation
                   ON operation.operation_id=article.operation_id
                 WHERE article.id=?1",
                [&request.article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| format!("read article body identity: {error}"))?
            .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if operation_id != request.operation_id {
            return Err("article_generation_operation_mismatch".to_string());
        }
        let is_owner = owner_session_id == session_id;
        if !is_owner && !request.approved {
            return Err("article_draft_session_mismatch".to_string());
        }
        let revision = if request.approved {
            approved_revision.ok_or_else(|| "article_approved_version_missing".to_string())?
        } else {
            request.revision.unwrap_or(current_revision)
        };
        let (title, path, approved_at): (String, String, Option<String>) = connection
            .query_row(
                "SELECT title, CASE WHEN ?3 THEN COALESCE(approved_body_path, body_path) ELSE body_path END,
                        approved_at
                 FROM geo_article_versions WHERE article_id=?1 AND revision=?2",
                params![request.article_id, revision, request.approved],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read article version body: {error}"))?
            .ok_or_else(|| "article_version_not_found".to_string())?;
        if request.approved && approved_at.is_none() {
            return Err("article_approved_version_missing".to_string());
        }
        let body = read_bounded_body(&workspace.root_path.join(path))?;
        Ok(ArticleBodyProjection {
            article_id: request.article_id,
            revision,
            title,
            body,
            approved: approved_at.is_some(),
        })
    }

    pub fn claim_article_review(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleReviewClaimRequest,
    ) -> Result<(ArticleGenerationContext, ArticleBodyProjection), String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article review claim: {error}"))?;
        let (operation_id, revision, status): (String, i64, String) = transaction
            .query_row(
                "SELECT operation_id, revision, status FROM geo_articles WHERE id=?1",
                [&request.article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| format!("read article review claim: {error}"))?
            .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if operation_id != request.operation_id {
            return Err("article_generation_operation_mismatch".to_string());
        }
        require_article_operation_visibility(&transaction, &operation_id, session_id, false)?;
        if revision != request.expected_revision {
            return Err("article_generation_revision_conflict".to_string());
        }
        if status != "draft_ready" || revision == 0 {
            return Err("article_review_status_invalid".to_string());
        }
        let claim_token = Uuid::new_v4().to_string();
        let attempt_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE geo_articles SET status='reviewing', review_claim_token=?2,
                     updated_at=?3 WHERE id=?1 AND revision=?4 AND status=?5",
                params![request.article_id, claim_token, now, revision, status],
            )
            .map_err(|error| format!("claim article review: {error}"))?;
        if changed != 1 {
            return Err("article_generation_revision_conflict".to_string());
        }
        transaction
            .execute(
                "INSERT INTO geo_article_review_attempts
                    (id, article_id, revision, outcome, created_at)
                 VALUES (?1, ?2, ?3, 'running', ?4)",
                params![attempt_id, request.article_id, revision, now],
            )
            .map_err(|error| format!("audit article review claim: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit article review claim: {error}"))?;
        let article = read_article(&connection, workspace_id, &request.article_id)?;
        let (brand_name, product_line, target_region): (String, String, String) = connection
            .query_row(
                "SELECT workspace.name, operation.product_line, operation.target_region
                 FROM geo_articles article
                 JOIN geo_article_operations operation ON operation.operation_id=article.operation_id
                 CROSS JOIN brand_workspace workspace
                 WHERE article.id=?1 AND workspace.singleton=1",
                [&request.article_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| format!("read article review context: {error}"))?;
        let (title, body_path) = {
            let version = article
                .current_version
                .as_ref()
                .ok_or_else(|| "article_version_not_found".to_string())?;
            (version.title.clone(), version.body_path.clone())
        };
        let body = read_bounded_body(&workspace.root_path.join(body_path))?;
        Ok((
            ArticleGenerationContext {
                article,
                brand_name,
                product_line,
                target_region,
                claim_token,
            },
            ArticleBodyProjection {
                article_id: request.article_id,
                revision,
                title,
                body,
                approved: false,
            },
        ))
    }

    pub fn finish_article_review(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: ArticleReviewFinishRequest,
    ) -> Result<ArticleProjection, String> {
        if !request.review.is_object()
            || request.review.get("passed").and_then(Value::as_bool) != Some(request.passed)
        {
            return Err("article_review_result_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_article_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("start article review finish: {error}"))?;
        let (operation_id, revision, status, claim): (String, i64, String, Option<String>) =
            transaction
                .query_row(
                    "SELECT operation_id, revision, status, review_claim_token
                     FROM geo_articles WHERE id=?1",
                    [&request.article_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(|error| format!("read article review finish: {error}"))?
                .ok_or_else(|| "article_generation_article_not_found".to_string())?;
        if revision != request.expected_revision
            || operation_id != request.operation_id
            || status != "reviewing"
            || claim.as_deref() != Some(request.claim_token.as_str())
        {
            return Err("article_review_claim_conflict".to_string());
        }
        require_article_operation_visibility(&transaction, &operation_id, session_id, false)?;
        let now = Utc::now().to_rfc3339();
        let review_json = canonical_article_json(&request.review)?;
        if request.passed {
            let (body_path, hash): (String, String) = transaction
                .query_row(
                    "SELECT body_path, body_sha256 FROM geo_article_versions
                     WHERE article_id=?1 AND revision=?2 AND approved_at IS NULL",
                    params![request.article_id, revision],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("read article approval source: {error}"))?
                .ok_or_else(|| "article_version_not_approvable".to_string())?;
            let source_body = read_bounded_body(&workspace.root_path.join(body_path))?;
            let approved_relative =
                format!("articles/approved/{}/v{revision}.md", request.article_id);
            let approved_path = workspace.root_path.join(&approved_relative);
            atomic_write_immutable(&approved_path, source_body.as_bytes())?;
            let approved_hash = format!("{:x}", Sha256::digest(source_body.as_bytes()));
            if approved_hash != hash {
                return Err("article_approval_digest_mismatch".to_string());
            }
            transaction
                .execute(
                    "UPDATE geo_article_versions SET review_json=?3, approved_body_path=?4,
                         approved_at=?5 WHERE article_id=?1 AND revision=?2 AND approved_at IS NULL",
                    params![request.article_id, revision, review_json, approved_relative, now],
                )
                .map_err(|error| format!("approve article version: {error}"))?;
            transaction
                .execute(
                    "UPDATE geo_articles SET status='approved', approved_revision=?2,
                         review_claim_token=NULL, failure_reason=NULL, updated_at=?3
                     WHERE id=?1 AND revision=?2 AND review_claim_token=?4",
                    params![request.article_id, revision, now, request.claim_token],
                )
                .map_err(|error| format!("mark article approved: {error}"))?;
            let artifact_id = format!("article-{}-v{revision}", request.article_id);
            transaction
                .execute(
                    "INSERT INTO geo_artifacts
                        (id, operation_id, session_id, kind, knowledge_version, created_at)
                     SELECT ?1, operation_id, ?2, 'approved-article', knowledge_version, ?3
                     FROM geo_articles WHERE id=?4",
                    params![artifact_id, session_id, now, request.article_id],
                )
                .map_err(|error| format!("persist approved article artifact: {error}"))?;
        } else {
            transaction
                .execute(
                    "UPDATE geo_article_versions SET review_json=?3
                     WHERE article_id=?1 AND revision=?2 AND approved_at IS NULL",
                    params![request.article_id, revision, review_json],
                )
                .map_err(|error| format!("persist failed article review: {error}"))?;
            transaction
                .execute(
                    "UPDATE geo_articles SET status='rejected', review_claim_token=NULL,
                         failure_reason='article_review_blocked', updated_at=?3
                     WHERE id=?1 AND revision=?2 AND review_claim_token=?4",
                    params![request.article_id, revision, now, request.claim_token],
                )
                .map_err(|error| format!("park failed article review: {error}"))?;
        }
        transaction
            .execute(
                "UPDATE geo_article_review_attempts SET outcome=?3, review_json=?4, finished_at=?5
                 WHERE id=(SELECT id FROM geo_article_review_attempts
                           WHERE article_id=?1 AND revision=?2 AND outcome='running'
                           ORDER BY created_at DESC LIMIT 1)",
                params![
                    request.article_id,
                    revision,
                    if request.passed { "passed" } else { "failed" },
                    review_json,
                    now
                ],
            )
            .map_err(|error| format!("finish article review audit: {error}"))?;
        refresh_article_operation_status(&transaction, &operation_id, &now)?;
        transaction
            .commit()
            .map_err(|error| format!("commit article review: {error}"))?;
        read_article(&connection, workspace_id, &request.article_id)
    }
}

type PreparedArticleSeeds = (
    i64,
    String,
    String,
    Option<String>,
    Option<i64>,
    Value,
    Vec<ArticleSeed>,
);

fn prepare_plan_article_seeds(
    connection: &Connection,
    workspace: &BrandWorkspace,
    requested_plan_id: Option<&str>,
) -> Result<PreparedArticleSeeds, String> {
    let plan_id = if let Some(id) = requested_plan_id {
        validate_short_text(id, 160, "article_generation_plan_id_invalid")?
    } else {
        connection
            .query_row(
                "SELECT id FROM geo_topic_plans WHERE status='confirmed'
                 ORDER BY updated_at DESC, id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read confirmed topic plan: {error}"))?
            .ok_or_else(|| "article_generation_confirmed_plan_required".to_string())?
    };
    let (
        revision,
        knowledge_version,
        product_line,
        target_region,
        status,
        topics_json,
        items_json,
        selected_json,
    ): (i64, i64, String, String, String, String, String, String) = connection
        .query_row(
            "SELECT revision, knowledge_version, product_line, target_region, status,
                        topics_json, items_json, selected_item_ids_json
                 FROM geo_topic_plans WHERE id=?1",
            [&plan_id],
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
        .map_err(|error| format!("read article source topic plan: {error}"))?
        .ok_or_else(|| "article_generation_plan_not_found".to_string())?;
    if status != "confirmed" {
        return Err("article_generation_confirmed_plan_required".to_string());
    }
    let topics: Vec<Value> = serde_json::from_str(&topics_json)
        .map_err(|error| format!("parse article source topics: {error}"))?;
    let items: Vec<Value> = serde_json::from_str(&items_json)
        .map_err(|error| format!("parse article source items: {error}"))?;
    let selected: Vec<String> = serde_json::from_str(&selected_json)
        .map_err(|error| format!("parse article source selection: {error}"))?;
    let selected_set = selected.iter().collect::<HashSet<_>>();
    let topic_summaries = topics
        .iter()
        .filter_map(|topic| {
            Some((
                topic.get("id")?.as_str()?.to_string(),
                topic
                    .get("summary")
                    .and_then(Value::as_str)
                    .or_else(|| topic.get("name").and_then(Value::as_str))?
                    .to_string(),
            ))
        })
        .collect::<HashMap<_, _>>();
    let by_id = items
        .iter()
        .filter_map(|item| Some((item.get("id")?.as_str()?.to_string(), item)))
        .collect::<HashMap<_, _>>();
    if selected.is_empty() || selected.len() > MAX_ARTICLES || selected_set.len() != selected.len()
    {
        return Err("article_generation_plan_selection_invalid".to_string());
    }
    let selected_has_ranking = selected.iter().any(|item_id| {
        by_id
            .get(item_id)
            .and_then(|item| item.get("contentType"))
            .and_then(Value::as_str)
            == Some("ranking")
    });
    // 排行榜允许用户在已确认选题之后用自然语言补足竞品。文章开始时把
    // 最新权威快照中的 roster 输入（身份/关联主体/竞品）覆盖进 ranking
    // item；其余 plannedFacts 仍须在该快照中逐项同值。
    let effective_knowledge_version = if selected_has_ranking {
        connection
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM knowledge_versions",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("read ranking knowledge version: {error}"))?
            .max(knowledge_version)
    } else {
        knowledge_version
    };
    let effective_snapshot = if selected_has_ranking {
        Some(read_snapshot_facts(
            connection,
            effective_knowledge_version,
        )?)
    } else {
        None
    };
    let mut seeds = Vec::with_capacity(selected.len());
    for item_id in &selected {
        let item = by_id
            .get(item_id)
            .ok_or_else(|| "article_generation_plan_selection_invalid".to_string())?;
        if item.get("approvalStatus").and_then(Value::as_str) != Some("approved") {
            return Err("article_generation_plan_item_not_approved".to_string());
        }
        let topic_id = required_article_string(item, "topicId", 100)?;
        let content_type = required_article_string(item, "contentType", 40)?;
        validate_content_type(content_type)?;
        let title = required_article_string(item, "title", 200)?.to_string();
        let mut facts = item
            .get("plannedFacts")
            .filter(|facts| facts.as_array().is_some_and(|facts| !facts.is_empty()))
            .cloned()
            .ok_or_else(|| "article_generation_plan_facts_invalid".to_string())?;
        if content_type == "ranking" {
            facts = replace_ranking_roster_facts(
                &facts,
                effective_snapshot
                    .as_ref()
                    .ok_or_else(|| "article_generation_knowledge_snapshot_empty".to_string())?,
            )?;
            validate_ranking_competitors(&facts, &workspace.name)?;
        }
        validate_snapshot_facts(connection, effective_knowledge_version, &facts)?;
        seeds.push(ArticleSeed {
            source_plan_item_id: Some(item_id.clone()),
            content_type: content_type.to_string(),
            topic: topic_summaries
                .get(topic_id)
                .cloned()
                .ok_or_else(|| "article_generation_plan_topic_invalid".to_string())?,
            requested_title: title,
            constraints: item
                .get("typeSelectionReason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            planned_facts: facts,
        });
    }
    let spec = json!({
        "kind": "confirmed-topic-plan",
        "planId": plan_id,
        "planRevision": revision,
        "selectedItemIds": selected,
    });
    Ok((
        effective_knowledge_version,
        product_line,
        target_region,
        Some(plan_id),
        Some(revision),
        spec,
        seeds,
    ))
}

fn prepare_direct_article_seeds(
    connection: &Connection,
    workspace: &BrandWorkspace,
    spec: Option<&ArticleDirectSpec>,
) -> Result<PreparedArticleSeeds, String> {
    let spec = spec.ok_or_else(|| "article_generation_direct_spec_required".to_string())?;
    if spec.count == 0 || spec.count > MAX_ARTICLES {
        return Err("article_generation_article_count_invalid".to_string());
    }
    validate_content_type(&spec.content_type)?;
    if spec.themes.is_empty() || spec.themes.len() > spec.count {
        return Err("article_generation_direct_themes_invalid".to_string());
    }
    let themes = spec
        .themes
        .iter()
        .map(|theme| validate_short_text(theme, 200, "article_generation_direct_theme_invalid"))
        .collect::<Result<Vec<_>, _>>()?;
    if themes.iter().collect::<HashSet<_>>().len() != themes.len() {
        return Err("article_generation_direct_themes_invalid".to_string());
    }
    if spec.constraints.chars().count() > 2_000 {
        return Err("article_generation_constraints_invalid".to_string());
    }
    let knowledge_version: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM knowledge_versions",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("read direct article knowledge version: {error}"))?;
    if knowledge_version <= 0 {
        return Err("article_generation_knowledge_required".to_string());
    }
    let facts = read_snapshot_facts(connection, knowledge_version)?;
    if facts.as_array().is_none_or(Vec::is_empty) {
        return Err("article_generation_knowledge_snapshot_empty".to_string());
    }
    if spec.content_type == "ranking" {
        validate_ranking_competitors(&facts, &workspace.name)?;
    }
    let seeds = (0..spec.count)
        .map(|index| {
            let theme = themes[index % themes.len()].clone();
            ArticleSeed {
                source_plan_item_id: None,
                content_type: spec.content_type.clone(),
                topic: theme.clone(),
                requested_title: theme,
                constraints: spec.constraints.trim().to_string(),
                planned_facts: facts.clone(),
            }
        })
        .collect::<Vec<_>>();
    let operation_spec = serde_json::to_value(spec)
        .map_err(|error| format!("serialize direct article spec: {error}"))?;
    Ok((
        knowledge_version,
        workspace
            .product_lines
            .first()
            .cloned()
            .unwrap_or_else(|| "默认产品线".to_string()),
        "中国".to_string(),
        None,
        None,
        operation_spec,
        seeds,
    ))
}

fn fact_predicate_matches(fact: &Value, suffix: &str) -> bool {
    fact.get("predicate")
        .and_then(Value::as_str)
        .is_some_and(|predicate| predicate.to_lowercase().ends_with(suffix))
}

fn fact_string_values(facts: &Value, suffix: &str) -> Vec<String> {
    facts
        .as_array()
        .into_iter()
        .flatten()
        .filter(|fact| fact_predicate_matches(fact, suffix))
        .flat_map(|fact| {
            let parsed = fact
                .get("normalizedValueJson")
                .and_then(Value::as_str)
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
            match parsed {
                Some(Value::String(value)) => vec![value],
                Some(Value::Array(values)) => values
                    .into_iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect(),
                _ => Vec::new(),
            }
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

fn normalize_ranking_entity_name(value: &str) -> String {
    value
        .chars()
        .filter_map(|character| {
            let code = character as u32;
            if character.is_whitespace() {
                None
            } else if (0xff01..=0xff5e).contains(&code) {
                char::from_u32(code - 0xfee0).map(|value| value.to_ascii_lowercase())
            } else {
                Some(character.to_ascii_lowercase())
            }
        })
        .collect()
}

fn ranking_roster_predicate(fact: &Value) -> bool {
    [
        ".fullname",
        ".shortnames",
        ".relatedbrands",
        ".competitors",
        ".potentialcompetitors",
    ]
    .iter()
    .any(|suffix| fact_predicate_matches(fact, suffix))
}

/// 与 Node 侧 `mergeRankingCompetitorTiers` 同构（ADR-0007 两层名单）：
/// 直接层（.competitors）优先，潜在层（.potentialcompetitors）补位——
/// 跨层按归一名互斥去重，排除身份/关联主体规则两层共用。
fn valid_ranking_competitors(facts: &Value, workspace_name: &str) -> HashSet<String> {
    let excluded_names = std::iter::once(workspace_name.to_string())
        .chain(fact_string_values(facts, ".fullname"))
        .chain(fact_string_values(facts, ".shortnames"))
        .chain(fact_string_values(facts, ".relatedbrands"))
        .map(|name| normalize_ranking_entity_name(&name))
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    let valid = |name: String| {
        let normalized = normalize_ranking_entity_name(&name);
        !normalized.is_empty()
            && !excluded_names.iter().any(|blocked| {
                blocked == &normalized
                    || blocked.contains(normalized.as_str())
                    || normalized.contains(blocked.as_str())
            })
    };
    let nested_overlap = |left: &str, kept: &[String]| {
        kept.iter()
            .any(|kept| kept == left || kept.contains(left) || left.contains(kept.as_str()))
    };
    let direct = fact_string_values(facts, ".competitors")
        .into_iter()
        .filter(|name| valid(name.clone()))
        .map(|name| normalize_ranking_entity_name(&name))
        .collect::<Vec<_>>();
    let potential = fact_string_values(facts, ".potentialcompetitors")
        .into_iter()
        .filter(|name| valid(name.clone()))
        .map(|name| normalize_ranking_entity_name(&name))
        .filter(|name| !nested_overlap(name, &direct))
        .collect::<Vec<_>>();
    direct.into_iter().chain(potential).collect::<HashSet<_>>()
}

fn validate_ranking_competitors(facts: &Value, workspace_name: &str) -> Result<(), String> {
    let competitors = valid_ranking_competitors(facts, workspace_name);
    if competitors.len() < 5 {
        return Err(format!(
            "article_generation_ranking_competitors_insufficient:{}",
            competitors.len()
        ));
    }
    Ok(())
}

fn replace_ranking_roster_facts(planned: &Value, snapshot: &Value) -> Result<Value, String> {
    let roster_facts = snapshot
        .as_array()
        .into_iter()
        .flatten()
        .filter(|fact| ranking_roster_predicate(fact))
        .cloned()
        .collect::<Vec<_>>();
    let mut facts = planned
        .as_array()
        .ok_or_else(|| "article_generation_plan_facts_invalid".to_string())?
        .iter()
        .filter(|fact| !ranking_roster_predicate(fact))
        .cloned()
        .collect::<Vec<_>>();
    facts.extend(roster_facts);
    Ok(Value::Array(facts))
}

fn read_snapshot_facts(connection: &Connection, knowledge_version: i64) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "SELECT snapshot.fact_key, current.predicate, snapshot.normalized_value_json
             FROM knowledge_version_facts snapshot
             JOIN knowledge_current_facts current ON current.fact_key=snapshot.fact_key
             WHERE snapshot.knowledge_version=?1 ORDER BY snapshot.fact_key",
        )
        .map_err(|error| format!("prepare article knowledge snapshot: {error}"))?;
    let facts = statement
        .query_map([knowledge_version], |row| {
            Ok(json!({
                "factKey": row.get::<_, String>(0)?,
                "predicate": row.get::<_, String>(1)?,
                "normalizedValueJson": row.get::<_, String>(2)?,
            }))
        })
        .map_err(|error| format!("query article knowledge snapshot: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read article knowledge snapshot: {error}"))?;
    Ok(Value::Array(facts))
}

fn validate_snapshot_facts(
    connection: &Connection,
    knowledge_version: i64,
    facts: &Value,
) -> Result<(), String> {
    let allowed = read_snapshot_facts(connection, knowledge_version)?;
    // Node topic-plan items carry richer fact projections (subject/scopeJson)
    // with source-order keys, so identity is (factKey, normalizedValueJson)
    // rather than a whole-object string comparison.
    let allowed_by_key: HashMap<&str, &str> = allowed
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|fact| {
            let key = fact.get("factKey").and_then(Value::as_str)?;
            let value = fact.get("normalizedValueJson").and_then(Value::as_str)?;
            Some((key, value))
        })
        .collect();
    for fact in facts.as_array().into_iter().flatten() {
        let key = fact
            .get("factKey")
            .and_then(Value::as_str)
            .ok_or_else(|| "article_generation_plan_facts_invalid".to_string())?;
        let value = fact
            .get("normalizedValueJson")
            .and_then(Value::as_str)
            .ok_or_else(|| "article_generation_plan_facts_invalid".to_string())?;
        if allowed_by_key
            .get(key)
            .map(|allowed_value| *allowed_value != value)
            .unwrap_or(true)
        {
            return Err("article_generation_fact_not_in_snapshot".to_string());
        }
    }
    Ok(())
}

fn require_article_operation_visibility(
    connection: &Connection,
    operation_id: &str,
    session_id: &str,
    allow_approved_cross_session: bool,
) -> Result<bool, String> {
    let owner = connection
        .query_row(
            "SELECT created_by_session_id FROM geo_article_operations WHERE operation_id=?1",
            [operation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("read article operation owner: {error}"))?
        .ok_or_else(|| "article_generation_operation_not_found".to_string())?;
    if owner == session_id {
        return Ok(true);
    }
    if !allow_approved_cross_session {
        return Err("article_draft_session_mismatch".to_string());
    }
    let unapproved: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM geo_articles
             WHERE operation_id=?1 AND approved_revision IS NULL",
            [operation_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("validate approved article visibility: {error}"))?;
    if unapproved > 0 {
        Err("article_draft_session_mismatch".to_string())
    } else {
        Ok(false)
    }
}

fn approved_only_article(mut article: ArticleProjection) -> Result<ArticleProjection, String> {
    let approved_revision = article
        .approved_revision
        .ok_or_else(|| "article_draft_session_mismatch".to_string())?;
    let approved_version = article
        .approved_version
        .clone()
        .ok_or_else(|| "article_approved_version_missing".to_string())?;
    article.status = "approved".to_string();
    article.revision = approved_revision;
    article.current_version = Some(approved_version);
    article.failure_reason = None;
    Ok(article)
}

fn approved_only_operation(
    mut operation: ArticleOperationProjection,
) -> Result<ArticleOperationProjection, String> {
    operation.articles = operation
        .articles
        .into_iter()
        .map(approved_only_article)
        .collect::<Result<Vec<_>, _>>()?;
    operation.status = "completed".to_string();
    Ok(operation)
}

fn read_article_operation(
    connection: &Connection,
    workspace_id: &str,
    operation_id: &str,
) -> Result<ArticleOperationProjection, String> {
    let mut projection = connection
        .query_row(
            "SELECT operation_id, created_by_session_id, source_kind, topic_plan_id,
                    topic_plan_revision, knowledge_version, policy_version, status,
                    created_at, updated_at
             FROM geo_article_operations WHERE operation_id=?1",
            [operation_id],
            |row| {
                Ok(ArticleOperationProjection {
                    id: row.get(0)?,
                    workspace_id: workspace_id.to_string(),
                    created_by_session_id: row.get(1)?,
                    source_kind: row.get(2)?,
                    topic_plan_id: row.get(3)?,
                    topic_plan_revision: row.get(4)?,
                    knowledge_version: row.get(5)?,
                    policy_version: row.get(6)?,
                    status: row.get(7)?,
                    articles: Vec::new(),
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read article operation: {error}"))?
        .ok_or_else(|| "article_generation_operation_not_found".to_string())?;
    let mut statement = connection
        .prepare("SELECT id FROM geo_articles WHERE operation_id=?1 ORDER BY created_at, id")
        .map_err(|error| format!("prepare article operation items: {error}"))?;
    let ids = statement
        .query_map([operation_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("query article operation items: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read article operation items: {error}"))?;
    projection.articles = ids
        .iter()
        .map(|id| read_article(connection, workspace_id, id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(projection)
}

fn read_article(
    connection: &Connection,
    workspace_id: &str,
    article_id: &str,
) -> Result<ArticleProjection, String> {
    let mut projection = connection
        .query_row(
            "SELECT id, operation_id, source_plan_item_id, knowledge_version,
                    content_type, topic, requested_title, constraints, planned_facts_json,
                    status, revision, approved_revision, failure_reason, generation_attempt,
                    created_at, updated_at
             FROM geo_articles WHERE id=?1",
            [article_id],
            |row| {
                let facts: String = row.get(8)?;
                Ok(ArticleProjection {
                    id: row.get(0)?,
                    operation_id: row.get(1)?,
                    workspace_id: workspace_id.to_string(),
                    source_plan_item_id: row.get(2)?,
                    knowledge_version: row.get(3)?,
                    content_type: row.get(4)?,
                    topic: row.get(5)?,
                    requested_title: row.get(6)?,
                    constraints: row.get(7)?,
                    planned_facts: serde_json::from_str(&facts).unwrap_or(Value::Array(vec![])),
                    status: row.get(9)?,
                    revision: row.get(10)?,
                    approved_revision: row.get(11)?,
                    failure_reason: row.get(12)?,
                    generation_attempt: row.get(13)?,
                    current_version: None,
                    approved_version: None,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read article: {error}"))?
        .ok_or_else(|| "article_generation_article_not_found".to_string())?;
    if projection.revision > 0 {
        projection.current_version = Some(read_article_version(
            connection,
            article_id,
            projection.revision,
            false,
        )?);
    }
    if let Some(revision) = projection.approved_revision {
        projection.approved_version = Some(read_article_version(
            connection, article_id, revision, true,
        )?);
    }
    Ok(projection)
}

fn read_article_version(
    connection: &Connection,
    article_id: &str,
    revision: i64,
    approved_path: bool,
) -> Result<ArticleVersionProjection, String> {
    connection
        .query_row(
            "SELECT revision, title,
                    CASE WHEN ?3 THEN COALESCE(approved_body_path, body_path) ELSE body_path END,
                    body_sha256, origin, based_on_revision, review_json, created_at, approved_at
             FROM geo_article_versions WHERE article_id=?1 AND revision=?2",
            params![article_id, revision, approved_path],
            |row| {
                let review: Option<String> = row.get(6)?;
                Ok(ArticleVersionProjection {
                    revision: row.get(0)?,
                    title: row.get(1)?,
                    body_path: row.get(2)?,
                    body_sha256: row.get(3)?,
                    origin: row.get(4)?,
                    based_on_revision: row.get(5)?,
                    review: review.and_then(|value| serde_json::from_str(&value).ok()),
                    created_at: row.get(7)?,
                    approved_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("read article version: {error}"))?
        .ok_or_else(|| "article_version_not_found".to_string())
}

fn refresh_article_operation_status(
    connection: &Connection,
    operation_id: &str,
    now: &str,
) -> Result<(), String> {
    let statuses = {
        let mut statement = connection
            .prepare("SELECT status FROM geo_articles WHERE operation_id=?1")
            .map_err(|error| format!("prepare article operation status: {error}"))?;
        let statuses = statement
            .query_map([operation_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("query article operation status: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read article operation status: {error}"))?;
        statuses
    };
    let status = if statuses.iter().all(|status| status == "approved") {
        "completed"
    } else if statuses
        .iter()
        .all(|status| matches!(status.as_str(), "approved" | "generation_failed"))
    {
        "completed-with-failures"
    } else {
        "running"
    };
    connection
        .execute(
            "UPDATE geo_article_operations SET status=?2, updated_at=?3 WHERE operation_id=?1",
            params![operation_id, status, now],
        )
        .map_err(|error| format!("update article operation status: {error}"))?;
    connection
        .execute(
            "UPDATE geo_operations SET state=?2 WHERE id=?1",
            params![operation_id, format!("article-generation-{status}")],
        )
        .map_err(|error| format!("update article operation state: {error}"))?;
    Ok(())
}

fn validate_article_title_body(title: &str, body: &str) -> Result<(), String> {
    validate_short_text(title, 200, "article_title_invalid")?;
    if body.trim().is_empty() || body.len() > MAX_BODY_BYTES {
        return Err("article_body_invalid".to_string());
    }
    if body.contains('【') || body.contains('】') {
        return Err("article_body_unresolved_placeholder".to_string());
    }
    Ok(())
}

fn validate_content_type(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "guide" | "showcase" | "ranking" | "news" | "news_light"
    ) {
        Ok(())
    } else {
        Err("article_generation_content_type_invalid".to_string())
    }
}

fn validate_short_text(value: &str, max: usize, error: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        Err(error.to_string())
    } else {
        Ok(value.to_string())
    }
}

fn required_article_string<'a>(value: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.chars().count() <= max)
        .ok_or_else(|| "article_generation_plan_item_invalid".to_string())
}

fn require_article_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM brand_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("validate article session: {error}"))?;
    if exists == 1 {
        Ok(())
    } else {
        Err("article_generation_session_not_committed".to_string())
    }
}

fn canonical_article_json<T: ?Sized + Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("serialize article JSON: {error}"))
}

fn atomic_write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BODY_BYTES {
        return Err("article_body_too_large".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "article_body_path_invalid".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create article body directory: {error}"))?;
    let temp_path = parent.join(format!(".{}.part", Uuid::new_v4()));
    let mut temp = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| format!("create article body temp file: {error}"))?;
    if let Err(error) = temp.write_all(bytes).and_then(|_| temp.sync_all()) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("write article body: {error}"));
    }
    drop(temp);
    fs::hard_link(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "article_version_already_exists".to_string()
        } else {
            format!("publish article body: {error}")
        }
    })?;
    fs::remove_file(&temp_path)
        .map_err(|error| format!("remove article body temp file: {error}"))?;
    Ok(())
}

fn atomic_write_immutable(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match immutable_body_matches(path, bytes)? {
        Some(true) => return Ok(()),
        Some(false) => return Err("article_approved_copy_conflict".to_string()),
        None => {}
    }
    match atomic_write_new(path, bytes) {
        Ok(()) => Ok(()),
        Err(error) if error == "article_version_already_exists" => {
            if immutable_body_matches(path, bytes)? == Some(true) {
                Ok(())
            } else {
                Err("article_approved_copy_conflict".to_string())
            }
        }
        Err(error) => Err(error),
    }
}

fn immutable_body_matches(path: &Path, expected: &[u8]) -> Result<Option<bool>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect immutable article body: {error}")),
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_BODY_BYTES as u64 {
        return Ok(Some(false));
    }
    let existing =
        fs::read(path).map_err(|error| format!("read immutable article body: {error}"))?;
    Ok(Some(existing == expected))
}

fn read_bounded_body(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|error| format!("open article body: {error}"))?;
    let mut bytes = Vec::new();
    file.take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read article body: {error}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("article_body_too_large".to_string());
    }
    String::from_utf8(bytes).map_err(|error| format!("decode article body: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_store() -> (tempfile::TempDir, BrandWorkspaceStore, BrandWorkspace) {
        let root = tempfile::tempdir().expect("temp root");
        let store = BrandWorkspaceStore::at(root.path().to_path_buf());
        let workspace = store
            .create_workspace("文章测试品牌", vec!["知识服务".to_string()])
            .expect("workspace");
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-article".to_string(),
                    title: "文章".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .expect("session");
        let connection = open_database(&workspace).expect("db");
        connection
            .execute_batch(
                r#"INSERT INTO knowledge_raw_inputs
                    (id, session_id, input_text, origin, intent, created_at)
                 VALUES ('raw-article', 'session-article', '成立10年', 'user-stated',
                         'knowledge-update', '2026-01-01T00:00:00Z');
                 INSERT INTO knowledge_fact_candidates
                    (id, raw_input_id, session_id, subject, predicate, scope_json, fact_key,
                     value_json, normalized_value_json, excerpt, confidence, profile_provenance,
                     origin, intent, status, base_version, proposed_at, resolved_at)
                 VALUES ('candidate-article', 'raw-article', 'session-article', '品牌',
                         'profile.history', '{}', 'fact-1', '"成立10年"', '"成立10年"',
                         '成立10年', 1.0, 'asked', 'user-stated', 'knowledge-update', 'adopted',
                         0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 INSERT INTO knowledge_decisions
                    (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
                     before_json, after_json, reason, decided_at)
                 VALUES ('decision-article', 'candidate-article', 'adopt-new', 'desktop-user',
                         'session-article', 0, NULL, '"成立10年"', 'article fixture',
                         '2026-01-01T00:00:00Z');
                 INSERT INTO knowledge_current_facts
                    (fact_key, subject, predicate, scope_json, normalized_value_json, unit,
                     version, confirmed_by,
                     confirmed_at, updated_at)
                 VALUES ('fact-1', '品牌', 'profile.history', '{}', '"成立10年"',
                         NULL, 1, 'desktop-user',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
                 INSERT INTO knowledge_versions
                    (version, decision_id, actor_session_id, snapshot_hash, created_at)
                 VALUES (1, 'decision-article', 'session-article', 'hash-v1',
                         '2026-01-01T00:00:00Z');
                 INSERT INTO knowledge_version_facts
                    (knowledge_version, fact_key, fact_version, normalized_value_json,
                     unit, sources_json)
                 VALUES (1, 'fact-1', 1, '"成立10年"', NULL, '[]');"#,
            )
            .expect("knowledge snapshot");
        (root, store, workspace)
    }

    fn body(title: &str) -> String {
        format!("# {title}\n\n## 定义\n品牌成立10年。\n\n## 清单\n- 核对事实\n- 固定版本")
    }

    fn append_competitor_snapshot(connection: &Connection, names: &[&str]) {
        let competitors = serde_json::to_string(names).expect("competitor JSON");
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable fixture foreign keys");
        connection
            .execute(
                "INSERT INTO knowledge_current_facts
                    (fact_key, subject, predicate, scope_json, normalized_value_json, unit,
                     version, confirmed_by, confirmed_at, updated_at)
                 VALUES ('fact-competitors', '品牌', 'enterprise-profile.competitors', '{}', ?1,
                         NULL, 1, 'desktop-user', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
                [&competitors],
            )
            .expect("competitor current fact");
        connection
            .execute(
                "INSERT INTO knowledge_versions
                    (version, decision_id, actor_session_id, snapshot_hash, created_at)
                 VALUES (2, 'decision-competitors', 'session-article', 'hash-v2',
                         '2026-01-02T00:00:00Z')",
                [],
            )
            .expect("competitor knowledge version");
        connection
            .execute(
                "INSERT INTO knowledge_version_facts
                    (knowledge_version, fact_key, fact_version, normalized_value_json, unit, sources_json)
                 VALUES (2, 'fact-1', 1, '\"成立10年\"', NULL, '[]'),
                        (2, 'fact-competitors', 1, ?1, NULL, '[]')",
                [&competitors],
            )
            .expect("competitor snapshot facts");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("restore fixture foreign keys");
    }

    #[test]
    fn ranking_competitor_contract_excludes_workspace_identity_and_related_brands() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/geo/rankingCompetitorContractCases.json"
        )))
        .expect("shared ranking competitor contract cases");
        for contract_case in cases {
            let values = |key: &str| {
                contract_case
                    .get(key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
            };
            let facts = {
                let mut fact_list = vec![
                    json!({
                        "predicate": "enterprise-profile.fullName",
                        "normalizedValueJson": serde_json::to_string(&values("fullNames")).unwrap()
                    }),
                    json!({
                        "predicate": "enterprise-profile.shortNames",
                        "normalizedValueJson": serde_json::to_string(&values("shortNames")).unwrap()
                    }),
                    json!({
                        "predicate": "enterprise-profile.relatedBrands",
                        "normalizedValueJson": serde_json::to_string(&values("relatedBrands")).unwrap()
                    }),
                    json!({
                        "predicate": "enterprise-profile.competitors",
                        "normalizedValueJson": serde_json::to_string(&values("competitors")).unwrap()
                    }),
                ];
                let potential = values("potentialCompetitors");
                if !potential.is_empty() {
                    fact_list.push(json!({
                        "predicate": "enterprise-profile.potentialCompetitors",
                        "normalizedValueJson": serde_json::to_string(&potential).unwrap()
                    }));
                }
                Value::Array(fact_list)
            };
            let workspace_name = contract_case
                .get("workspaceBrandName")
                .and_then(Value::as_str)
                .unwrap();
            let actual = valid_ranking_competitors(&facts, workspace_name);
            let expected = values("expected")
                .into_iter()
                .filter_map(|value| value.as_str().map(normalize_ranking_entity_name))
                .collect::<HashSet<_>>();
            assert_eq!(actual, expected, "case: {}", contract_case["name"]);
            let expected_count = expected.len();
            let validation = validate_ranking_competitors(&facts, workspace_name);
            if expected_count >= 5 {
                validation.expect("five valid competitors");
            } else {
                assert_eq!(
                    validation.unwrap_err(),
                    format!("article_generation_ranking_competitors_insufficient:{expected_count}")
                );
            }
        }
    }

    #[test]
    fn ranking_requires_five_confirmed_competitors_before_creating_an_operation() {
        let (_root, store, workspace) = seeded_store();
        let error = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "direct".to_string(),
                    topic_plan_id: None,
                    direct_spec: Some(ArticleDirectSpec {
                        count: 1,
                        themes: vec!["本地服务六家对比".to_string()],
                        content_type: "ranking".to_string(),
                        constraints: String::new(),
                    }),
                },
            )
            .expect_err("ranking without competitors must fail before persistence");
        assert_eq!(
            error,
            "article_generation_ranking_competitors_insufficient:0"
        );

        let connection = open_database(&workspace).expect("db");
        append_competitor_snapshot(
            &connection,
            &["竞品甲", "竞品乙", "竞品丙", "竞品丁", "竞品戊"],
        );
        drop(connection);
        let operation = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "direct".to_string(),
                    topic_plan_id: None,
                    direct_spec: Some(ArticleDirectSpec {
                        count: 1,
                        themes: vec!["本地服务六家对比".to_string()],
                        content_type: "ranking".to_string(),
                        constraints: String::new(),
                    }),
                },
            )
            .expect("ranking with five confirmed competitors");
        assert_eq!(operation.knowledge_version, 2);
    }

    #[test]
    fn confirmed_ranking_plan_overlays_a_later_natural_language_competitor_snapshot() {
        let (_root, store, workspace) = seeded_store();
        let connection = open_database(&workspace).expect("db");
        let topics = json!([{
            "id": "topic-ranking",
            "name": "本地服务对比",
            "summary": "本地服务六家客观对比"
        }]);
        let items = json!([{
            "id": "selected-ranking",
            "topicId": "topic-ranking",
            "contentType": "ranking",
            "typeSelectionReason": "适合并列清单",
            "title": "2026 年本地服务六家对比",
            "plannedFacts": [{
                "factKey": "fact-1",
                "predicate": "profile.history",
                "normalizedValueJson": "\"成立10年\""
            }],
            "approvalStatus": "approved"
        }]);
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable fixture foreign keys");
        connection
            .execute(
                "INSERT INTO geo_topic_plans
                    (id, operation_id, created_by_session_id, question_pool_id,
                     question_pool_revision, knowledge_version, product_line, target_region,
                     policy_version, status, revision, topics_json, items_json,
                     selected_item_ids_json, model_audit_json, provider_snapshot_json,
                     model_attempts_json, created_at, updated_at)
                 VALUES ('plan-ranking', 'plan-operation-ranking', 'session-article', 'pool-ranking',
                         1, 1, '知识服务', '中国', 'topic-policy', 'confirmed', 1,
                         ?1, ?2, '[\"selected-ranking\"]', '{}', '{}', '[]',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                params![topics.to_string(), items.to_string()],
            )
            .expect("ranking plan fixture");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("restore fixture foreign keys");
        append_competitor_snapshot(
            &connection,
            &["竞品甲", "竞品乙", "竞品丙", "竞品丁", "竞品戊"],
        );
        drop(connection);

        let operation = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "confirmed-topic-plan".to_string(),
                    topic_plan_id: Some("plan-ranking".to_string()),
                    direct_spec: None,
                },
            )
            .expect("ranking plan resumes after natural-language supplement");
        assert_eq!(operation.knowledge_version, 2);
        assert!(operation.articles[0]
            .planned_facts
            .as_array()
            .into_iter()
            .flatten()
            .any(|fact| fact
                .get("predicate")
                .and_then(Value::as_str)
                .is_some_and(|predicate| predicate.to_lowercase().ends_with(".competitors"))));
    }

    #[test]
    fn direct_spec_versions_retry_and_approved_copy_are_stable() {
        let (_root, store, workspace) = seeded_store();
        let operation = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "direct".to_string(),
                    topic_plan_id: None,
                    direct_spec: Some(ArticleDirectSpec {
                        count: 2,
                        themes: vec!["知识库指南".to_string()],
                        content_type: "guide".to_string(),
                        constraints: "面向企业".to_string(),
                    }),
                },
            )
            .expect("operation");
        assert_eq!(operation.articles.len(), 2);
        assert!(operation
            .articles
            .iter()
            .all(|article| article.knowledge_version == 1));
        let connection = open_database(&workspace).expect("db");
        let operation_spec: String = connection
            .query_row(
                "SELECT operation_spec_json FROM geo_article_operations WHERE operation_id=?1",
                [&operation.id],
                |row| row.get(0),
            )
            .expect("direct operation spec");
        assert_eq!(
            serde_json::from_str::<Value>(&operation_spec).expect("direct operation spec JSON"),
            json!({
                "count": 2,
                "themes": ["知识库指南"],
                "contentType": "guide",
                "constraints": "面向企业"
            })
        );
        let first = &operation.articles[0];
        let claim = store
            .claim_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationClaimRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    expected_revision: 0,
                    mode: "initial".to_string(),
                },
            )
            .expect("claim");
        let generated_body = body("知识库指南");
        let interrupted_path = workspace.root_path.join(format!(
            "operations/{}/articles/{}/v1.md",
            operation.id, first.id
        ));
        atomic_write_new(&interrupted_path, generated_body.as_bytes())
            .expect("simulate body write before interrupted metadata transaction");
        let draft = store
            .finish_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationFinishRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    expected_revision: 0,
                    claim_token: claim.claim_token,
                    title: "知识库指南".to_string(),
                    body: generated_body,
                    model_audit: json!({"model":"mock-generation"}),
                },
            )
            .expect("draft");
        assert_eq!(draft.revision, 1);
        let review = store
            .claim_article_review(
                &workspace.id,
                "session-article",
                ArticleReviewClaimRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    expected_revision: 1,
                },
            )
            .expect("review claim");
        assert_eq!(
            store
                .claim_article_review(
                    &workspace.id,
                    "session-article",
                    ArticleReviewClaimRequest {
                        operation_id: operation.id.clone(),
                        article_id: first.id.clone(),
                        expected_revision: 1,
                    },
                )
                .expect_err("review claim is mutually exclusive"),
            "article_review_status_invalid"
        );
        assert_eq!(
            store
                .claim_article_generation(
                    &workspace.id,
                    "session-article",
                    ArticleGenerationClaimRequest {
                        operation_id: operation.id.clone(),
                        article_id: first.id.clone(),
                        expected_revision: 1,
                        mode: "regenerate".to_string(),
                    },
                )
                .expect_err("generation cannot race active review"),
            "article_generation_status_invalid"
        );
        let approved = store
            .finish_article_review(
                &workspace.id,
                "session-article",
                ArticleReviewFinishRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    expected_revision: 1,
                    claim_token: review.0.claim_token,
                    review: json!({"passed":true,"issues":[]}),
                    passed: true,
                },
            )
            .expect("approve");
        assert_eq!(approved.approved_revision, Some(1));
        assert_ne!(
            approved
                .current_version
                .as_ref()
                .expect("draft version")
                .body_path,
            approved
                .approved_version
                .as_ref()
                .expect("approved version")
                .body_path
        );
        assert_eq!(
            approved
                .current_version
                .as_ref()
                .expect("draft version")
                .body_sha256,
            approved
                .approved_version
                .as_ref()
                .expect("approved version")
                .body_sha256
        );
        let approved_body_before = store
            .read_article_body(
                &workspace.id,
                "session-article",
                ArticleBodyRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    revision: None,
                    approved: true,
                },
            )
            .expect("approved body");
        let regeneration = store
            .claim_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationClaimRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    expected_revision: 1,
                    mode: "regenerate".to_string(),
                },
            )
            .expect("regenerate claim");
        let regenerated = store
            .finish_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationFinishRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    expected_revision: 1,
                    claim_token: regeneration.claim_token,
                    title: "知识库指南".to_string(),
                    body: format!("{}\n\n新版表达。", body("知识库指南")),
                    model_audit: json!({"model":"mock-generation"}),
                },
            )
            .expect("regenerated");
        assert_eq!(regenerated.revision, 2);
        assert_eq!(regenerated.approved_revision, Some(1));
        let approved_body_after = store
            .read_article_body(
                &workspace.id,
                "session-article",
                ArticleBodyRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    revision: None,
                    approved: true,
                },
            )
            .expect("approved body after regeneration");
        assert_eq!(approved_body_before.body, approved_body_after.body);
        assert_eq!(approved_body_after.revision, 1);
        let connection = open_database(&workspace).expect("db");
        let approved_artifact_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM geo_artifacts WHERE operation_id=?1 AND kind='approved-article'",
                [&operation.id],
                |row| row.get(0),
            )
            .expect("approved artifact count");
        assert_eq!(approved_artifact_count, 1);

        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-article-other".to_string(),
                    title: "另一个文章会话".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .expect("other session");
        let newer_operation = store
            .start_article_operation(
                &workspace.id,
                "session-article-other",
                ArticleOperationStartRequest {
                    source_kind: "direct".to_string(),
                    topic_plan_id: None,
                    direct_spec: Some(ArticleDirectSpec {
                        count: 1,
                        themes: vec!["另一个会话的新任务".to_string()],
                        content_type: "guide".to_string(),
                        constraints: String::new(),
                    }),
                },
            )
            .expect("newer cross-session operation");
        let cross_session_latest = store
            .latest_article_operation(
                &workspace.id,
                "session-article-other",
                ArticleLatestRequest {},
            )
            .expect("cross-session latest")
            .expect("cross-session operation");
        assert_eq!(cross_session_latest.id, newer_operation.id);
        assert_eq!(
            store
                .get_article_operation(
                    &workspace.id,
                    "session-article-other",
                    ArticleOperationGetRequest {
                        operation_id: operation.id.clone(),
                    },
                )
                .unwrap_err(),
            "article_draft_session_mismatch"
        );
        let cross_session_projection = store
            .get_article(
                &workspace.id,
                "session-article-other",
                ArticleGetRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                },
            )
            .expect("cross-session approved article projection");
        assert_eq!(cross_session_projection.status, "approved");
        assert_eq!(cross_session_projection.revision, 1);
        assert_eq!(
            cross_session_projection.current_version,
            cross_session_projection.approved_version
        );
        let cross_session_approved = store
            .read_article_body(
                &workspace.id,
                "session-article-other",
                ArticleBodyRequest {
                    operation_id: operation.id.clone(),
                    article_id: first.id.clone(),
                    revision: None,
                    approved: true,
                },
            )
            .expect("cross-session approved body");
        assert_eq!(cross_session_approved.body, approved_body_before.body);
    }

    #[test]
    fn one_generation_failure_is_retryable_without_touching_siblings() {
        let (_root, store, workspace) = seeded_store();
        let operation = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "direct".to_string(),
                    topic_plan_id: None,
                    direct_spec: Some(ArticleDirectSpec {
                        count: 2,
                        themes: vec!["主题".to_string()],
                        content_type: "guide".to_string(),
                        constraints: String::new(),
                    }),
                },
            )
            .expect("operation");
        let failed_id = operation.articles[0].id.clone();
        let sibling_id = operation.articles[1].id.clone();
        let claim = store
            .claim_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationClaimRequest {
                    operation_id: operation.id.clone(),
                    article_id: failed_id.clone(),
                    expected_revision: 0,
                    mode: "initial".to_string(),
                },
            )
            .expect("claim");
        store
            .fail_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationFailRequest {
                    operation_id: operation.id.clone(),
                    article_id: failed_id.clone(),
                    expected_revision: 0,
                    claim_token: claim.claim_token,
                    failure_reason: "provider unavailable".to_string(),
                },
            )
            .expect("fail");
        let retry = store
            .claim_article_generation(
                &workspace.id,
                "session-article",
                ArticleGenerationClaimRequest {
                    operation_id: operation.id.clone(),
                    article_id: failed_id,
                    expected_revision: 0,
                    mode: "regenerate".to_string(),
                },
            )
            .expect("retry exact article");
        assert_eq!(retry.article.generation_attempt, 2);
        let sibling = store
            .latest_article_operation(&workspace.id, "session-article", ArticleLatestRequest {})
            .expect("latest")
            .expect("operation")
            .articles
            .into_iter()
            .find(|article| article.id == sibling_id)
            .expect("sibling");
        assert_eq!(sibling.status, "planned");
        assert_eq!(sibling.generation_attempt, 0);
    }

    #[test]
    fn unapproved_article_drafts_and_mutations_stay_in_the_creating_session() {
        let (_root, store, workspace) = seeded_store();
        let operation = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "direct".to_string(),
                    topic_plan_id: None,
                    direct_spec: Some(ArticleDirectSpec {
                        count: 1,
                        themes: vec!["Session A 私有草稿".to_string()],
                        content_type: "guide".to_string(),
                        constraints: String::new(),
                    }),
                },
            )
            .unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-article-other".to_string(),
                    title: "另一个会话".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        assert!(store
            .latest_article_operation(
                &workspace.id,
                "session-article-other",
                ArticleLatestRequest {},
            )
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .get_article_operation(
                    &workspace.id,
                    "session-article-other",
                    ArticleOperationGetRequest {
                        operation_id: operation.id.clone(),
                    },
                )
                .unwrap_err(),
            "article_draft_session_mismatch"
        );
        let article = &operation.articles[0];
        assert_eq!(
            store
                .claim_article_generation(
                    &workspace.id,
                    "session-article-other",
                    ArticleGenerationClaimRequest {
                        operation_id: operation.id,
                        article_id: article.id.clone(),
                        expected_revision: article.revision,
                        mode: "initial".to_string(),
                    },
                )
                .unwrap_err(),
            "article_draft_session_mismatch"
        );
    }

    #[test]
    fn confirmed_plan_uses_only_selected_approved_items_and_fixed_revision() {
        let (_root, store, workspace) = seeded_store();
        let connection = open_database(&workspace).expect("db");
        let topics = json!([{
            "id": "topic-1",
            "name": "知识库选型",
            "summary": "解释企业知识库选型标准"
        }]);
        let fact = json!({
            "factKey": "fact-1",
            "predicate": "profile.history",
            "normalizedValueJson": "\"成立10年\""
        });
        let items = json!([
            {
                "id": "selected-item",
                "topicId": "topic-1",
                "contentType": "guide",
                "typeSelectionReason": "适合指南",
                "title": "企业知识库选型指南",
                "plannedFacts": [fact.clone()],
                "approvalStatus": "approved"
            },
            {
                "id": "unselected-item",
                "topicId": "topic-1",
                "contentType": "news",
                "typeSelectionReason": "未选择",
                "title": "不应生成的标题",
                "plannedFacts": [fact],
                "approvalStatus": "approved"
            }
        ]);
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .expect("disable fixture foreign keys");
        connection
            .execute(
                "INSERT INTO geo_topic_plans
                    (id, operation_id, created_by_session_id, question_pool_id,
                     question_pool_revision, knowledge_version, product_line, target_region,
                     policy_version, status, revision, topics_json, items_json,
                     selected_item_ids_json, model_audit_json, provider_snapshot_json,
                     model_attempts_json, created_at, updated_at)
                 VALUES ('plan-article', 'plan-operation', 'session-article', 'pool-article',
                         3, 1, '知识服务', '中国', 'topic-policy', 'confirmed', 7,
                         ?1, ?2, '[\"selected-item\"]', '{}', '{}', '[]',
                         '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                params![topics.to_string(), items.to_string()],
            )
            .expect("confirmed topic plan fixture");
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .expect("restore fixture foreign keys");
        drop(connection);

        let operation = store
            .start_article_operation(
                &workspace.id,
                "session-article",
                ArticleOperationStartRequest {
                    source_kind: "confirmed-topic-plan".to_string(),
                    topic_plan_id: Some("plan-article".to_string()),
                    direct_spec: None,
                },
            )
            .expect("start from confirmed plan");
        assert_eq!(operation.topic_plan_revision, Some(7));
        assert_eq!(operation.knowledge_version, 1);
        assert_eq!(operation.articles.len(), 1);
        assert_eq!(
            operation.articles[0].source_plan_item_id.as_deref(),
            Some("selected-item")
        );
        assert_eq!(operation.articles[0].requested_title, "企业知识库选型指南");
        assert_eq!(
            operation.articles[0]
                .planned_facts
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let connection = open_database(&workspace).expect("db");
        let spec: String = connection
            .query_row(
                "SELECT operation_spec_json FROM geo_article_operations WHERE operation_id=?1",
                [&operation.id],
                |row| row.get(0),
            )
            .expect("fixed operation spec");
        assert_eq!(
            serde_json::from_str::<Value>(&spec).expect("operation spec JSON"),
            json!({
                "kind": "confirmed-topic-plan",
                "planId": "plan-article",
                "planRevision": 7,
                "selectedItemIds": ["selected-item"]
            })
        );
    }
}
