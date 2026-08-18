use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{open_database, BrandWorkspace, BrandWorkspaceStore};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum GeoNotificationCategory {
    AwaitingConfirmation,
    OperationFailed,
    BatchCompleted,
    PublishFailed,
    MonitoringCompleted,
}

impl GeoNotificationCategory {
    pub fn preference_key(self) -> &'static str {
        match self {
            Self::AwaitingConfirmation => "awaitingConfirmation",
            Self::OperationFailed => "operationFailed",
            Self::BatchCompleted => "batchCompleted",
            Self::PublishFailed => "publishFailed",
            Self::MonitoringCompleted => "monitoringCompleted",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum GeoNotificationCard {
    GeoOperation,
    ArticleGeneration,
    PublishExecution,
    PostPublishMonitoring,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct GeoNotificationArtifactLocator {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct GeoNotificationLocator {
    pub workspace_id: String,
    pub session_id: String,
    pub operation_id: String,
    pub card: GeoNotificationCard,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    pub artifact: GeoNotificationArtifactLocator,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoNotificationEvent {
    pub category: GeoNotificationCategory,
    pub locator: GeoNotificationLocator,
    /// Stable mutation revision. Terminal artifact categories deduplicate by
    /// artifact identity, while repeatable confirmation/failure categories
    /// include this revision in their delivery key.
    pub revision: i64,
}

impl GeoNotificationEvent {
    pub fn delivery_id(&self) -> String {
        let terminal_once = matches!(
            self.category,
            GeoNotificationCategory::BatchCompleted
                | GeoNotificationCategory::PublishFailed
                | GeoNotificationCategory::MonitoringCompleted
        );
        format!(
            "geo:{}:{}:{}:{}:{}{}",
            self.category.preference_key(),
            self.locator.workspace_id,
            self.locator.session_id,
            self.locator.operation_id,
            self.locator.artifact.id,
            if terminal_once {
                String::new()
            } else {
                format!(":{}", self.revision)
            }
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GeoNotificationResolution {
    Exact {
        locator: GeoNotificationLocator,
        workspace: BrandWorkspace,
        #[serde(rename = "sessionTitle")]
        session_title: String,
    },
    Fallback {
        code: String,
        message: String,
        workspace: Option<BrandWorkspace>,
    },
}

fn valid_locator_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn fallback(
    code: &str,
    message: &str,
    workspace: Option<BrandWorkspace>,
) -> GeoNotificationResolution {
    GeoNotificationResolution::Fallback {
        code: code.to_string(),
        message: message.to_string(),
        workspace,
    }
}

impl BrandWorkspaceStore {
    /// Resolve the complete locator at click time. A notification is only a
    /// hint; the BrandWorkspace database remains authoritative and every
    /// identity is revalidated so a deleted target can never drift to a
    /// different recent Operation or artifact.
    pub fn resolve_geo_notification_locator(
        &self,
        locator: GeoNotificationLocator,
    ) -> Result<GeoNotificationResolution, String> {
        if !valid_locator_id(&locator.workspace_id)
            || !valid_locator_id(&locator.session_id)
            || !valid_locator_id(&locator.operation_id)
            || !valid_locator_id(&locator.artifact.kind)
            || !valid_locator_id(&locator.artifact.id)
            || locator
                .step_id
                .as_deref()
                .is_some_and(|value| !valid_locator_id(value))
        {
            return Ok(fallback(
                "invalid-locator",
                "通知定位信息无效，已返回安全的 GEO 入口。",
                None,
            ));
        }

        let workspace = match self.workspace(&locator.workspace_id) {
            Ok(workspace) => workspace,
            Err(_) => {
                return Ok(fallback(
                    "workspace-missing",
                    "通知对应的品牌已不存在，未打开其它品牌或会话。",
                    None,
                ));
            }
        };
        let session = match self.session(&workspace, &locator.session_id)? {
            Some(session) => session,
            None => {
                return Ok(fallback(
                    "session-missing",
                    "通知对应的会话已不存在，已返回该品牌的新会话入口。",
                    Some(workspace),
                ));
            }
        };
        let connection = open_database(&workspace)?;
        let operation_session: Option<Option<String>> = connection
            .query_row(
                "SELECT session_id FROM geo_operations WHERE id=?1",
                [&locator.operation_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("resolve notification Operation: {error}"))?;
        if operation_session.flatten().as_deref() != Some(locator.session_id.as_str()) {
            return Ok(fallback(
                "operation-missing",
                "通知对应的 GEO Operation 已不存在，已返回该品牌的新会话入口。",
                Some(workspace),
            ));
        }

        if !artifact_matches(&connection, &locator)? {
            return Ok(fallback(
                "artifact-missing",
                "通知对应的结构化卡片或产物已不存在，已返回该品牌的新会话入口。",
                Some(workspace),
            ));
        }

        Ok(GeoNotificationResolution::Exact {
            session_title: session.title,
            workspace,
            locator,
        })
    }
}

fn artifact_matches(
    connection: &Connection,
    locator: &GeoNotificationLocator,
) -> Result<bool, String> {
    let expected_kind = match locator.card {
        GeoNotificationCard::GeoOperation => "operation",
        GeoNotificationCard::ArticleGeneration => "article-operation",
        GeoNotificationCard::PublishExecution => "publish-execution",
        GeoNotificationCard::PostPublishMonitoring => "monitor-plan",
    };
    if locator.artifact.kind != expected_kind {
        return Ok(false);
    }
    match locator.card {
        GeoNotificationCard::GeoOperation => {
            if locator.artifact.id != locator.operation_id {
                return Ok(false);
            }
            let Some(step_id) = locator.step_id.as_deref() else {
                return Ok(true);
            };
            let steps_json: Option<String> = connection
                .query_row(
                    "SELECT steps_json FROM geo_operations WHERE id=?1 AND kind!='artifact-lineage'",
                    [&locator.operation_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| format!("resolve notification Operation card: {error}"))?;
            Ok(steps_json
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .and_then(|value| value.as_array().cloned())
                .is_some_and(|steps| {
                    steps.iter().any(|step| {
                        step.get("id").and_then(serde_json::Value::as_str) == Some(step_id)
                    })
                }))
        }
        GeoNotificationCard::ArticleGeneration => connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM geo_article_operations
                 WHERE operation_id=?1 AND operation_id=?2)",
                [&locator.artifact.id, &locator.operation_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("resolve article notification artifact: {error}")),
        GeoNotificationCard::PublishExecution => connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM geo_publish_executions
                 WHERE id=?1 AND operation_id=?2)",
                [&locator.artifact.id, &locator.operation_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("resolve publish notification artifact: {error}")),
        GeoNotificationCard::PostPublishMonitoring => connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM geo_post_publish_monitor_plans
                 WHERE id=?1 AND operation_id=?2)",
                [&locator.artifact.id, &locator.operation_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("resolve monitoring notification artifact: {error}")),
    }
}

pub(super) fn project_session_geo_status(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    let row: Option<(String, String, String)> = connection
        .query_row(
            "SELECT kind,status,state FROM geo_operations
             WHERE session_id=?1
             ORDER BY COALESCE(updated_at,created_at) DESC,id DESC LIMIT 1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| format!("project Session GEO status: {error}"))?;
    Ok(row.and_then(|(kind, status, state)| {
        classify_geo_status(if kind == "artifact-lineage" {
            &state
        } else {
            &status
        })
        .map(str::to_string)
    }))
}

fn classify_geo_status(value: &str) -> Option<&'static str> {
    let value = value.to_ascii_lowercase();
    if value.contains("awaiting") || value.contains("confirmation") || value.contains("selection") {
        Some("awaiting-confirmation")
    } else if value.contains("fail")
        || value.contains("partially-succeeded")
        || value.contains("reject")
        || value.contains("reconciliation")
    {
        Some("failed")
    } else if value.contains("queue") || value.contains("scheduled") || value.contains("pending") {
        Some("queued")
    } else if value.contains("running")
        || value.contains("executing")
        || value.contains("active")
        || value.contains("generating")
        || value.contains("drafting")
        || value.contains("reviewing")
        || value.contains("recovering")
        || value.contains("uploading")
        || value.contains("submitting")
    {
        Some("running")
    } else if value.contains("succeed")
        || value.contains("complete")
        || value.contains("confirmed")
        || value.contains("approved")
        || value.contains("submitted")
    {
        Some("completed")
    } else if value == "ready" {
        Some("ready")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::{SessionCommit, SessionTitleSource};
    use super::*;
    use rusqlite::params;
    use tempfile::tempdir;

    fn locator(workspace_id: &str) -> GeoNotificationLocator {
        GeoNotificationLocator {
            workspace_id: workspace_id.to_string(),
            session_id: "session-19".to_string(),
            operation_id: "operation-19".to_string(),
            card: GeoNotificationCard::GeoOperation,
            step_id: Some("confirm-19".to_string()),
            artifact: GeoNotificationArtifactLocator {
                kind: "operation".to_string(),
                id: "operation-19".to_string(),
                revision: Some(4),
            },
        }
    }

    #[test]
    fn resolves_exact_locator_and_never_substitutes_deleted_targets() {
        let temp = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(temp.path().join("xiaojing"));
        let workspace = store
            .create_workspace("精确品牌", vec!["产品".into()])
            .unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-19".into(),
                    title: "精确会话".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let connection = open_database(&workspace).unwrap();
        connection
            .execute(
                "INSERT INTO geo_operations
                 (id,session_id,state,created_at,kind,status,steps_json,updated_at)
                 VALUES (?1,?2,'awaiting-confirmation',?3,'article-generation',
                         'awaiting-confirmation',?4,?3)",
                params![
                    "operation-19",
                    "session-19",
                    "2026-08-15T00:00:00Z",
                    r#"[{"id":"confirm-19"}]"#
                ],
            )
            .unwrap();

        let exact = store
            .resolve_geo_notification_locator(locator(&workspace.id))
            .unwrap();
        assert!(matches!(
            exact,
            GeoNotificationResolution::Exact {
                locator: resolved,
                workspace: resolved_workspace,
                session_title,
            } if resolved == locator(&workspace.id)
                && resolved_workspace.id == workspace.id
                && session_title == "精确会话"
        ));

        let mut mismatched = locator(&workspace.id);
        mismatched.card = GeoNotificationCard::PublishExecution;
        mismatched.artifact.kind = "publish-execution".to_string();
        mismatched.artifact.id = "missing-execution".to_string();
        let mismatch = store.resolve_geo_notification_locator(mismatched).unwrap();
        assert!(matches!(
            mismatch,
            GeoNotificationResolution::Fallback { code, workspace: Some(_), .. }
                if code == "artifact-missing"
        ));

        connection
            .execute("DELETE FROM brand_sessions WHERE id='session-19'", [])
            .unwrap();
        let deleted = store
            .resolve_geo_notification_locator(locator(&workspace.id))
            .unwrap();
        assert!(matches!(
            deleted,
            GeoNotificationResolution::Fallback { code, workspace: Some(_), .. }
                if code == "session-missing"
        ));

        let missing_brand = store
            .resolve_geo_notification_locator(locator("deleted-brand"))
            .unwrap();
        assert!(matches!(
            missing_brand,
            GeoNotificationResolution::Fallback { code, workspace: None, .. }
                if code == "workspace-missing"
        ));
    }

    #[test]
    fn projects_safe_sidebar_statuses() {
        assert_eq!(
            classify_geo_status("question-pool-awaiting-selection"),
            Some("awaiting-confirmation")
        );
        assert_eq!(
            classify_geo_status("publish-reconciliation-required"),
            Some("failed")
        );
        assert_eq!(
            classify_geo_status("publish-partially-succeeded"),
            Some("failed")
        );
        assert_eq!(classify_geo_status("monitor-completed"), Some("completed"));
        assert_eq!(classify_geo_status("running"), Some("running"));
        assert_eq!(classify_geo_status("queued"), Some("queued"));
    }

    #[test]
    fn terminal_delivery_ids_dedupe_but_new_confirmation_revisions_do_not() {
        let base = GeoNotificationEvent {
            category: GeoNotificationCategory::BatchCompleted,
            locator: locator("brand-19"),
            revision: 1,
        };
        let mut later = base.clone();
        later.revision = 2;
        assert_eq!(base.delivery_id(), later.delivery_id());

        let mut confirmation = base.clone();
        confirmation.category = GeoNotificationCategory::AwaitingConfirmation;
        let mut confirmation_later = confirmation.clone();
        confirmation_later.revision = 2;
        assert_ne!(confirmation.delivery_id(), confirmation_later.delivery_id());
    }
}
