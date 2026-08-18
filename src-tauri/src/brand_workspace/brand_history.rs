use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::{open_database, BrandWorkspaceStore};

const HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandHistoryReference {
    pub kind: String,
    pub id: String,
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandKnowledgeHistorySource {
    pub material_id: Option<String>,
    pub excerpt: String,
    pub origin: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandKnowledgeHistoryFact {
    pub fact_key: String,
    pub fact_version: i64,
    pub normalized_value_json: String,
    pub unit: Option<String>,
    pub sources: Vec<BrandKnowledgeHistorySource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandKnowledgeHistoryVersion {
    pub version: i64,
    pub actor_session_id: String,
    pub created_at: String,
    pub facts: Vec<BrandKnowledgeHistoryFact>,
    pub used_by: Vec<BrandHistoryReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandArtifactHistoryItem {
    pub id: String,
    pub kind: String,
    pub revision: Option<i64>,
    pub knowledge_version: Option<i64>,
    pub operation_id: String,
    pub session_id: String,
    pub status: String,
    pub source_refs: Vec<BrandHistoryReference>,
    pub used_by: Vec<BrandHistoryReference>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandHistoryProjection {
    pub workspace_id: String,
    pub knowledge_versions: Vec<BrandKnowledgeHistoryVersion>,
    pub artifacts: Vec<BrandArtifactHistoryItem>,
}

fn reference(kind: &str, id: String, revision: Option<i64>) -> BrandHistoryReference {
    BrandHistoryReference {
        kind: kind.to_string(),
        id,
        revision,
    }
}

fn knowledge_reference(version: i64) -> BrandHistoryReference {
    reference("knowledge-version", version.to_string(), Some(version))
}

fn parse_sources(raw: &str) -> Vec<BrandKnowledgeHistorySource> {
    serde_json::from_str::<Vec<serde_json::Value>>(raw)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| {
            let object = value.as_object()?;
            Some(BrandKnowledgeHistorySource {
                material_id: object
                    .get("materialId")
                    .or_else(|| object.get("material_id"))
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned),
                excerpt: object.get("excerpt")?.as_str()?.to_string(),
                origin: object
                    .get("origin")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                created_at: object
                    .get("createdAt")
                    .or_else(|| object.get("created_at"))
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .take(HISTORY_LIMIT)
        .collect()
}

fn knowledge_used_by(
    connection: &Connection,
    version: i64,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, kind FROM geo_artifacts
             WHERE knowledge_version=?1 ORDER BY created_at DESC, id DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare knowledge usage history: {error}"))?;
    let references = statement
        .query_map([version], |row| {
            Ok(reference(&row.get::<_, String>(1)?, row.get(0)?, None))
        })
        .map_err(|error| format!("query knowledge usage history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read knowledge usage history: {error}"))?;
    Ok(references)
}

fn load_knowledge_history(
    connection: &Connection,
) -> Result<Vec<BrandKnowledgeHistoryVersion>, String> {
    let mut statement = connection
        .prepare(
            "SELECT version, actor_session_id, created_at
             FROM knowledge_versions ORDER BY version DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare knowledge version history: {error}"))?;
    let versions = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("query knowledge version history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read knowledge version history: {error}"))?;

    versions
        .into_iter()
        .map(|(version, actor_session_id, created_at)| {
            let mut fact_statement = connection
                .prepare(
                    "SELECT fact_key, fact_version, normalized_value_json, unit, sources_json
                     FROM knowledge_version_facts
                     WHERE knowledge_version=?1 ORDER BY fact_key LIMIT 500",
                )
                .map_err(|error| format!("prepare knowledge facts history: {error}"))?;
            let facts = fact_statement
                .query_map([version], |row| {
                    let sources_json: String = row.get(4)?;
                    Ok(BrandKnowledgeHistoryFact {
                        fact_key: row.get(0)?,
                        fact_version: row.get(1)?,
                        normalized_value_json: row.get(2)?,
                        unit: row.get(3)?,
                        sources: parse_sources(&sources_json),
                    })
                })
                .map_err(|error| format!("query knowledge facts history: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("read knowledge facts history: {error}"))?;
            Ok(BrandKnowledgeHistoryVersion {
                version,
                actor_session_id,
                created_at,
                facts,
                used_by: knowledge_used_by(connection, version)?,
            })
        })
        .collect()
}

fn question_pool_used_by(
    connection: &Connection,
    pool_id: &str,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut references = Vec::new();
    let mut topic_statement = connection
        .prepare(
            "SELECT id, revision FROM geo_topic_plans
             WHERE question_pool_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare question topic usage: {error}"))?;
    references.extend(
        topic_statement
            .query_map([pool_id], |row| {
                Ok(reference("topic-plan", row.get(0)?, Some(row.get(1)?)))
            })
            .map_err(|error| format!("query question topic usage: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read question topic usage: {error}"))?,
    );
    let mut baseline_statement = connection
        .prepare(
            "SELECT id FROM geo_baselines
             WHERE question_pool_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare question baseline usage: {error}"))?;
    references.extend(
        baseline_statement
            .query_map([pool_id], |row| {
                Ok(reference("baseline", row.get(0)?, None))
            })
            .map_err(|error| format!("query question baseline usage: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read question baseline usage: {error}"))?,
    );
    references.truncate(HISTORY_LIMIT);
    Ok(references)
}

fn topic_plan_used_by(
    connection: &Connection,
    plan_id: &str,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id FROM geo_article_operations
             WHERE topic_plan_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare topic article usage: {error}"))?;
    let references = statement
        .query_map([plan_id], |row| {
            Ok(reference("article-operation", row.get(0)?, None))
        })
        .map_err(|error| format!("query topic article usage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read topic article usage: {error}"))?;
    Ok(references)
}

fn baseline_used_by(
    connection: &Connection,
    baseline_id: &str,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, revision FROM geo_post_publish_monitor_plans
             WHERE baseline_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare baseline monitor usage: {error}"))?;
    let references = statement
        .query_map([baseline_id], |row| {
            Ok(reference("monitor-plan", row.get(0)?, Some(row.get(1)?)))
        })
        .map_err(|error| format!("query baseline monitor usage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read baseline monitor usage: {error}"))?;
    Ok(references)
}

fn article_operation_used_by(
    connection: &Connection,
    operation_id: &str,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, revision FROM geo_distribution_plans
             WHERE article_operation_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare article distribution usage: {error}"))?;
    let references = statement
        .query_map([operation_id], |row| {
            Ok(reference(
                "distribution-plan",
                row.get(0)?,
                Some(row.get(1)?),
            ))
        })
        .map_err(|error| format!("query article distribution usage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read article distribution usage: {error}"))?;
    Ok(references)
}

fn distribution_used_by(
    connection: &Connection,
    plan_id: &str,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, revision FROM geo_publish_executions
             WHERE distribution_plan_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare distribution publish usage: {error}"))?;
    let references = statement
        .query_map([plan_id], |row| {
            Ok(reference(
                "publish-execution",
                row.get(0)?,
                Some(row.get(1)?),
            ))
        })
        .map_err(|error| format!("query distribution publish usage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read distribution publish usage: {error}"))?;
    Ok(references)
}

fn publish_used_by(
    connection: &Connection,
    execution_id: &str,
) -> Result<Vec<BrandHistoryReference>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, revision FROM geo_post_publish_monitor_plans
             WHERE publish_execution_id=?1 ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare publish monitor usage: {error}"))?;
    let references = statement
        .query_map([execution_id], |row| {
            Ok(reference("monitor-plan", row.get(0)?, Some(row.get(1)?)))
        })
        .map_err(|error| format!("query publish monitor usage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read publish monitor usage: {error}"))?;
    Ok(references)
}

fn load_artifact_history(connection: &Connection) -> Result<Vec<BrandArtifactHistoryItem>, String> {
    let mut artifacts = Vec::new();

    let mut question_statement = connection
        .prepare(
            "SELECT id, operation_id, created_by_session_id, knowledge_version,
                    revision, status, created_at, derived_from_pool_id
             FROM geo_question_pools WHERE status='confirmed'
             ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare approved question history: {error}"))?;
    let questions = question_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|error| format!("query approved question history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read approved question history: {error}"))?;
    for (id, operation_id, session_id, knowledge_version, revision, status, created_at, derived) in
        questions
    {
        let mut source_refs = vec![knowledge_reference(knowledge_version)];
        if let Some(source) = derived {
            source_refs.push(reference("question-pool", source, None));
        }
        artifacts.push(BrandArtifactHistoryItem {
            used_by: question_pool_used_by(connection, &id)?,
            id,
            kind: "question-pool".to_string(),
            revision: Some(revision),
            knowledge_version: Some(knowledge_version),
            operation_id,
            session_id,
            status,
            source_refs,
            created_at,
        });
    }

    let mut baseline_statement = connection
        .prepare(
            "SELECT id, operation_id, created_by_session_id, knowledge_version,
                    status, created_at, question_pool_id, question_pool_revision
             FROM geo_baselines WHERE status IN ('succeeded','partial')
             ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare baseline history: {error}"))?;
    let baselines = baseline_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|error| format!("query baseline history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read baseline history: {error}"))?;
    for (
        id,
        operation_id,
        session_id,
        knowledge_version,
        status,
        created_at,
        pool_id,
        pool_revision,
    ) in baselines
    {
        artifacts.push(BrandArtifactHistoryItem {
            used_by: baseline_used_by(connection, &id)?,
            id,
            kind: "baseline".to_string(),
            revision: None,
            operation_id,
            session_id,
            knowledge_version: Some(knowledge_version),
            status,
            created_at,
            source_refs: vec![
                knowledge_reference(knowledge_version),
                reference("question-pool", pool_id, Some(pool_revision)),
            ],
        });
    }

    let mut topic_statement = connection
        .prepare(
            "SELECT id, operation_id, created_by_session_id, knowledge_version,
                    revision, status, created_at, question_pool_id, question_pool_revision
             FROM geo_topic_plans WHERE status='confirmed'
             ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare approved topic history: {error}"))?;
    let topics = topic_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|error| format!("query approved topic history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read approved topic history: {error}"))?;
    for (
        id,
        operation_id,
        session_id,
        knowledge_version,
        revision,
        status,
        created_at,
        pool_id,
        pool_revision,
    ) in topics
    {
        artifacts.push(BrandArtifactHistoryItem {
            used_by: topic_plan_used_by(connection, &id)?,
            id,
            kind: "topic-plan".to_string(),
            revision: Some(revision),
            knowledge_version: Some(knowledge_version),
            operation_id,
            session_id,
            status,
            source_refs: vec![
                knowledge_reference(knowledge_version),
                reference("question-pool", pool_id, Some(pool_revision)),
            ],
            created_at,
        });
    }

    let mut article_statement = connection
        .prepare(
            "SELECT 'article-' || article.id || '-v' || article.approved_revision,
                    article.operation_id, version.created_by_session_id,
                    article.knowledge_version, article.approved_revision, article.status,
                    COALESCE(version.approved_at, version.created_at), operation.topic_plan_id,
                    operation.topic_plan_revision
             FROM geo_articles article
             JOIN geo_article_operations operation ON operation.operation_id=article.operation_id
             JOIN geo_article_versions version
               ON version.article_id=article.id AND version.revision=article.approved_revision
             WHERE article.status='approved' AND article.approved_revision IS NOT NULL
             ORDER BY version.approved_at DESC, article.id DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare approved article history: {error}"))?;
    let articles = article_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
            ))
        })
        .map_err(|error| format!("query approved article history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read approved article history: {error}"))?;
    for (
        id,
        operation_id,
        session_id,
        knowledge_version,
        revision,
        status,
        created_at,
        topic_id,
        topic_revision,
    ) in articles
    {
        let mut source_refs = vec![knowledge_reference(knowledge_version)];
        if let Some(topic_id) = topic_id {
            source_refs.push(reference("topic-plan", topic_id, topic_revision));
        }
        artifacts.push(BrandArtifactHistoryItem {
            used_by: article_operation_used_by(connection, &operation_id)?,
            id,
            kind: "approved-article".to_string(),
            revision: Some(revision),
            knowledge_version: Some(knowledge_version),
            operation_id,
            session_id,
            status,
            source_refs,
            created_at,
        });
    }

    let mut distribution_statement = connection
        .prepare(
            "SELECT artifact.id, plan.id, plan.operation_id, plan.created_by_session_id,
                    plan.knowledge_version, plan.revision, plan.status, plan.created_at,
                    plan.article_operation_id
             FROM geo_distribution_plans plan
             JOIN geo_artifacts artifact
               ON artifact.operation_id=plan.operation_id AND artifact.kind='distribution-plan'
             WHERE plan.status='confirmed'
             ORDER BY plan.updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare approved distribution history: {error}"))?;
    let distributions = distribution_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|error| format!("query approved distribution history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read approved distribution history: {error}"))?;
    for (
        artifact_id,
        plan_id,
        operation_id,
        session_id,
        knowledge_version,
        revision,
        status,
        created_at,
        article_operation_id,
    ) in distributions
    {
        artifacts.push(BrandArtifactHistoryItem {
            used_by: distribution_used_by(connection, &plan_id)?,
            id: artifact_id,
            kind: "distribution-plan".to_string(),
            revision: Some(revision),
            knowledge_version: Some(knowledge_version),
            operation_id,
            session_id,
            status,
            source_refs: vec![
                knowledge_reference(knowledge_version),
                reference("article-operation", article_operation_id, None),
            ],
            created_at,
        });
    }

    let mut publish_statement = connection
        .prepare(
            "SELECT id, operation_id, created_by_session_id, revision, status,
                    COALESCE(confirmed_at, created_at), distribution_plan_id,
                    distribution_plan_revision
             FROM geo_publish_executions
             WHERE status NOT IN ('awaiting-confirmation','superseded')
             ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare approved publish history: {error}"))?;
    let publishes = publish_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
            ))
        })
        .map_err(|error| format!("query approved publish history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read approved publish history: {error}"))?;
    for (id, operation_id, session_id, revision, status, created_at, plan_id, plan_revision) in
        publishes
    {
        artifacts.push(BrandArtifactHistoryItem {
            used_by: publish_used_by(connection, &id)?,
            id,
            kind: "publish-execution".to_string(),
            revision: Some(revision),
            knowledge_version: None,
            operation_id,
            session_id,
            status,
            source_refs: vec![reference("distribution-plan", plan_id, Some(plan_revision))],
            created_at,
        });
    }

    let mut monitor_statement = connection
        .prepare(
            "SELECT id, operation_id, created_by_session_id, revision, status,
                    COALESCE(activated_at, created_at), publish_execution_id, baseline_id,
                    source_operation_id
             FROM geo_post_publish_monitor_plans
             WHERE status IN ('active','completed','provisioning-failed')
             ORDER BY updated_at DESC LIMIT 100",
        )
        .map_err(|error| format!("prepare monitor history: {error}"))?;
    let monitors = monitor_statement
        .query_map([], |row| {
            Ok(BrandArtifactHistoryItem {
                id: row.get(0)?,
                kind: "monitor-plan".to_string(),
                revision: Some(row.get(3)?),
                knowledge_version: None,
                operation_id: row.get(1)?,
                session_id: row.get(2)?,
                status: row.get(4)?,
                created_at: row.get(5)?,
                source_refs: vec![
                    reference("publish-execution", row.get(6)?, None),
                    reference("baseline", row.get(7)?, None),
                    reference("operation", row.get(8)?, None),
                ],
                used_by: vec![],
            })
        })
        .map_err(|error| format!("query monitor history: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read monitor history: {error}"))?;
    artifacts.extend(monitors);

    artifacts.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
    artifacts.truncate(HISTORY_LIMIT);
    Ok(artifacts)
}

impl BrandWorkspaceStore {
    pub fn brand_history(&self, workspace_id: &str) -> Result<BrandHistoryProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        Ok(BrandHistoryProjection {
            workspace_id: workspace_id.to_string(),
            knowledge_versions: load_knowledge_history(&connection)?,
            artifacts: load_artifact_history(&connection)?,
        })
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_workspace_history(
    workspaceId: String,
) -> Result<BrandHistoryProjection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.brand_history(&workspaceId)
    })
    .await
    .map_err(|error| format!("brand history task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand_workspace::{BrandWorkspaceStore, SessionCommit, SessionTitleSource};
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn exposes_approved_versions_sources_and_usage_without_draft_artifacts() {
        let root = tempdir().unwrap().keep();
        let store = BrandWorkspaceStore::at(root.join("Xiaojing"));
        let workspace = store.create_workspace("历史品牌", vec![]).unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-history".into(),
                    title: "历史".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let connection = open_database(&workspace).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_versions(version,decision_id,actor_session_id,snapshot_hash,created_at)
                 VALUES (7,'decision-7','session-history','hash-7','2026-08-15T00:00:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_version_facts(
                    knowledge_version,fact_key,fact_version,normalized_value_json,unit,sources_json)
                 VALUES (7,'brand.name',2,'\"鲸跃\"',NULL,?1)",
                [json!([{
                    "materialId": "material-7",
                    "excerpt": "企业名称为鲸跃",
                    "origin": "user-stated",
                    "createdAt": "2026-08-15T00:00:00Z"
                }])
                .to_string()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_operations(id,session_id,state,created_at)
                 VALUES ('lineage-op','session-history','question-pool-confirmed','2026-08-15T00:01:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_artifacts(id,operation_id,session_id,kind,knowledge_version,created_at)
                 VALUES ('pool-7','lineage-op','session-history','question-pool',7,'2026-08-15T00:01:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_question_pools(
                    id,operation_id,created_by_session_id,knowledge_version,product_line,target_region,
                    generation_parameters_json,status,revision,created_at,updated_at)
                 VALUES ('pool-7','lineage-op','session-history',7,'旗舰产品','成都','{}','confirmed',3,
                         '2026-08-15T00:01:00Z','2026-08-15T00:02:00Z')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_artifacts(id,operation_id,session_id,kind,knowledge_version,created_at)
                 VALUES ('draft-7','lineage-op','session-history','article-draft',7,'2026-08-15T00:01:00Z')",
                [],
            )
            .unwrap();
        drop(connection);

        let history = store.brand_history(&workspace.id).unwrap();
        assert_eq!(history.knowledge_versions[0].version, 7);
        assert_eq!(
            history.knowledge_versions[0].facts[0].sources[0].excerpt,
            "企业名称为鲸跃"
        );
        assert!(history.knowledge_versions[0]
            .used_by
            .iter()
            .any(|reference| reference.id == "pool-7"));
        assert_eq!(history.artifacts.len(), 1);
        assert_eq!(history.artifacts[0].id, "pool-7");
        assert_eq!(history.artifacts[0].revision, Some(3));
        assert_eq!(
            history.artifacts[0].source_refs,
            vec![knowledge_reference(7)]
        );
        assert!(!history
            .artifacts
            .iter()
            .any(|artifact| artifact.id == "draft-7"));
    }
}
