use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod articles;
mod brand_history;
mod distribution_plans;
mod geo_baselines;
mod geo_dashboard;
mod geo_operations;
mod knowledge;
mod materials;
mod notifications;
mod post_publish_monitoring;
mod publish_scheduler;
mod question_pools;
mod topic_plans;
pub use articles::*;
pub use brand_history::*;
pub use distribution_plans::*;
pub use geo_baselines::*;
pub use geo_dashboard::*;
pub use geo_operations::*;
pub use knowledge::*;
pub use materials::*;
pub use notifications::*;
pub use post_publish_monitoring::*;
pub use publish_scheduler::*;
pub use question_pools::*;
pub use topic_plans::*;

const CATALOG_FILE: &str = "brands.json";
const SESSION_DELETION_ADMISSION_STALE_SECONDS: i64 = 60;
const BRAND_DIRS: [&str; 5] = [
    "materials",
    "operations",
    "articles/approved",
    "media",
    "exports",
];

pub(crate) fn is_brand_workspace_path(path: &Path) -> bool {
    crate::app_dirs::xiaojing_data_dir().is_some_and(|root| path.starts_with(root.join("brands")))
}

fn catalog_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandWorkspace {
    pub id: String,
    pub name: String,
    pub product_lines: Vec<String>,
    pub root_path: PathBuf,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BrandCatalog {
    current_workspace_id: Option<String>,
    workspaces: Vec<BrandWorkspace>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionTitleSource {
    Default,
    Auto,
    User,
}

impl SessionTitleSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Auto => "auto",
            Self::User => "user",
        }
    }

    fn parse(value: &str) -> Self {
        match value {
            "auto" => Self::Auto,
            "user" => Self::User,
            _ => Self::Default,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommit {
    pub id: String,
    pub title: String,
    pub title_source: SessionTitleSource,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandSession {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub title_source: SessionTitleSource,
    pub created_at: String,
    pub last_active_at: String,
    pub archived_at: Option<String>,
    /// Non-sensitive projection of the latest GEO work owned by this Session.
    /// The underlying Operation remains authoritative in BrandWorkspace SQLite.
    pub geo_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionScope {
    pub session_records: u64,
    pub chat_transcripts: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetainedBrandDataScope {
    pub knowledge_facts: u64,
    pub operations: u64,
    pub artifacts: u64,
    pub publish_orders: u64,
    pub observations: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeletionPreview {
    pub workspace_id: String,
    pub session_id: String,
    pub title: String,
    pub scope: SessionDeletionScope,
    pub retained: RetainedBrandDataScope,
    pub confirmation_token: String,
}

/// 品牌删除是全量删除：会话记录与 transcript、品牌库内全部领域数据、
/// 以及工作区目录本身都会消失，没有"保留"分支。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeletionScope {
    pub sessions: u64,
    pub chat_transcripts: u64,
    pub knowledge_facts: u64,
    pub operations: u64,
    pub articles: u64,
    pub materials: u64,
    pub monitor_plans: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeletionPreview {
    pub workspace_id: String,
    pub name: String,
    /// App 需要 Session 清单来计算可释放 Tab 与卸载范围。
    pub session_ids: Vec<String>,
    pub scope: WorkspaceDeletionScope,
    pub confirmation_token: String,
}

#[derive(Debug, Clone)]
pub struct BrandWorkspaceStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandWorkspaceBootstrap {
    pub data_root: PathBuf,
    pub workspaces: Vec<BrandWorkspace>,
    pub current_workspace: Option<BrandWorkspace>,
}

impl BrandWorkspaceStore {
    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn list_workspaces(&self) -> Result<Vec<BrandWorkspace>, String> {
        Ok(self.with_healed_catalog()?.workspaces)
    }

    pub fn current_workspace(&self) -> Result<Option<BrandWorkspace>, String> {
        let catalog = self.with_healed_catalog()?;
        Ok(catalog.current_workspace_id.as_deref().and_then(|id| {
            catalog
                .workspaces
                .into_iter()
                .find(|workspace| workspace.id == id)
        }))
    }

    pub fn create_workspace(
        &self,
        name: &str,
        product_lines: Vec<String>,
    ) -> Result<BrandWorkspace, String> {
        let name = normalized_name(name)?;
        let product_lines = normalized_product_lines(product_lines)?;
        let _guard = catalog_lock().lock().map_err(|error| error.to_string())?;
        fs::create_dir_all(&self.root)
            .map_err(|error| format!("create Xiaojing data root: {error}"))?;
        let mut catalog = self.read_catalog_unlocked()?;
        if catalog
            .workspaces
            .iter()
            .any(|workspace| workspace.name == name)
        {
            return Err("品牌名称已存在".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let workspace_root = self.root.join("brands").join(&id);
        for relative in BRAND_DIRS {
            fs::create_dir_all(workspace_root.join(relative))
                .map_err(|error| format!("create brand directory {relative}: {error}"))?;
        }
        let now = Utc::now().to_rfc3339();
        let workspace = BrandWorkspace {
            id: id.clone(),
            name,
            product_lines,
            root_path: workspace_root,
            created_at: now.clone(),
            updated_at: now,
        };
        initialize_database(&workspace)?;
        catalog.workspaces.push(workspace.clone());
        catalog.current_workspace_id = Some(id);
        self.write_catalog_unlocked(&catalog)?;
        Ok(workspace)
    }

    pub fn switch_workspace(&self, workspace_id: &str) -> Result<BrandWorkspace, String> {
        let _guard = catalog_lock().lock().map_err(|error| error.to_string())?;
        let mut catalog = self.read_catalog_unlocked()?;
        let workspace = catalog
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .cloned()
            .ok_or_else(|| "品牌工作区不存在".to_string())?;
        catalog.current_workspace_id = Some(workspace.id.clone());
        self.write_catalog_unlocked(&catalog)?;
        Ok(workspace)
    }

    pub fn commit_session(
        &self,
        workspace_id: &str,
        session: SessionCommit,
    ) -> Result<BrandSession, String> {
        validate_session_id(&session.id)?;
        let workspace = self.workspace(workspace_id)?;
        let now = Utc::now().to_rfc3339();
        let connection = open_database(&workspace)?;
        connection
            .execute(
                "INSERT INTO brand_sessions
                    (id, title, title_source, created_at, last_active_at, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?4, NULL)
                 ON CONFLICT(id) DO UPDATE SET
                    title = CASE
                        WHEN brand_sessions.title_source = 'user' THEN brand_sessions.title
                        ELSE excluded.title
                    END,
                    title_source = CASE
                        WHEN brand_sessions.title_source = 'user' THEN brand_sessions.title_source
                        ELSE excluded.title_source
                    END,
                    last_active_at = excluded.last_active_at",
                params![
                    session.id,
                    session.title.trim(),
                    session.title_source.as_str(),
                    now
                ],
            )
            .map_err(|error| format!("commit brand session: {error}"))?;
        self.session(&workspace, &session.id)?
            .ok_or_else(|| "会话提交后无法读取".to_string())
    }

    pub fn list_sessions(
        &self,
        workspace_id: &str,
        include_archived: bool,
    ) -> Result<Vec<BrandSession>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let sql = if include_archived {
            "SELECT id, title, title_source, created_at, last_active_at, archived_at
             FROM brand_sessions ORDER BY last_active_at DESC"
        } else {
            "SELECT id, title, title_source, created_at, last_active_at, archived_at
             FROM brand_sessions WHERE archived_at IS NULL ORDER BY last_active_at DESC"
        };
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("prepare brand session list: {error}"))?;
        let rows = statement
            .query_map([], |row| session_from_row(row, workspace_id))
            .map_err(|error| format!("query brand sessions: {error}"))?;
        let mut sessions = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("read brand sessions: {error}"))?;
        for session in &mut sessions {
            session.geo_status =
                notifications::project_session_geo_status(&connection, &session.id)?;
        }
        Ok(sessions)
    }

    pub fn rename_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        title: &str,
    ) -> Result<BrandSession, String> {
        validate_session_id(session_id)?;
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 120 {
            return Err("会话标题须为 1–120 个字符".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let changed = connection
            .execute(
                "UPDATE brand_sessions
                 SET title = ?1, title_source = 'user', last_active_at = ?2
                 WHERE id = ?3",
                params![title, Utc::now().to_rfc3339(), session_id],
            )
            .map_err(|error| format!("rename brand session: {error}"))?;
        if changed != 1 {
            return Err("会话不存在".to_string());
        }
        self.session(&workspace, session_id)?
            .ok_or_else(|| "会话重命名后无法读取".to_string())
    }

    pub fn archive_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        archived: bool,
    ) -> Result<BrandSession, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let archived_at = archived.then(|| Utc::now().to_rfc3339());
        let changed = connection
            .execute(
                "UPDATE brand_sessions SET archived_at = ?1 WHERE id = ?2",
                params![archived_at, session_id],
            )
            .map_err(|error| format!("archive brand session: {error}"))?;
        if changed != 1 {
            return Err("会话不存在".to_string());
        }
        self.session(&workspace, session_id)?
            .ok_or_else(|| "会话归档后无法读取".to_string())
    }

    pub fn preview_session_deletion(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<SessionDeletionPreview, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        let session = self
            .session(&workspace, session_id)?
            .ok_or_else(|| "会话不存在".to_string())?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("start deletion preview: {error}"))?;
        let token = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        let expires_at = now + 300;
        transaction
            .execute(
                "DELETE FROM session_deletion_intents
                 WHERE (admitted_at IS NULL AND expires_at < ?1)
                    OR admitted_at < ?2",
                params![now, now - SESSION_DELETION_ADMISSION_STALE_SECONDS],
            )
            .map_err(|error| format!("clear stale deletion preview: {error}"))?;
        let in_progress: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM session_deletion_intents
                 WHERE session_id = ?1 AND admitted_at IS NOT NULL",
                [session_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("check deletion admission: {error}"))?;
        if in_progress > 0 {
            return Err("会话删除正在进行中".to_string());
        }
        transaction
            .execute(
                "DELETE FROM session_deletion_intents
                 WHERE session_id = ?1 AND admitted_at IS NULL",
                [session_id],
            )
            .map_err(|error| format!("replace deletion preview: {error}"))?;
        transaction
            .execute(
                "INSERT INTO session_deletion_intents (token, session_id, expires_at)
                 VALUES (?1, ?2, ?3)",
                params![token, session_id, expires_at],
            )
            .map_err(|error| format!("write deletion preview: {error}"))?;
        let retained = retained_scope(&transaction, session_id)?;
        transaction
            .commit()
            .map_err(|error| format!("commit deletion preview: {error}"))?;
        Ok(SessionDeletionPreview {
            workspace_id: workspace.id,
            session_id: session.id,
            title: session.title,
            scope: SessionDeletionScope {
                session_records: 1,
                chat_transcripts: 1,
            },
            retained,
            confirmation_token: token,
        })
    }

    #[cfg(test)]
    fn delete_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        self.admit_session_deletion(workspace_id, session_id, confirmation_token)?;
        self.mark_session_transcript_deleted(workspace_id, session_id, confirmation_token)?;
        self.finalize_session_deletion(workspace_id, session_id, confirmation_token)
    }

    /// Persist a one-use deletion admission without holding a database lock
    /// across the transcript mutation owned by the Session lifecycle fence.
    pub(crate) fn admit_session_deletion(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let admitted = connection
            .execute(
                "UPDATE session_deletion_intents
                 SET admitted_at = ?3, transcript_deleted_at = NULL
                 WHERE token = ?1 AND session_id = ?2 AND expires_at >= ?3
                   AND admitted_at IS NULL",
                params![confirmation_token, session_id, Utc::now().timestamp()],
            )
            .map_err(|error| format!("verify deletion confirmation: {error}"))?;
        if admitted != 1 {
            return Err("删除确认已失效，请重新确认关联范围".to_string());
        }
        Ok(())
    }

    pub(crate) fn cancel_session_deletion_admission(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        connection
            .execute(
                "DELETE FROM session_deletion_intents
                 WHERE token = ?1 AND session_id = ?2 AND transcript_deleted_at IS NULL",
                params![confirmation_token, session_id],
            )
            .map_err(|error| format!("cancel deletion admission: {error}"))?;
        Ok(())
    }

    pub(crate) fn mark_session_transcript_deleted(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let changed = connection
            .execute(
                "UPDATE session_deletion_intents
                 SET transcript_deleted_at = ?3
                 WHERE token = ?1 AND session_id = ?2 AND admitted_at IS NOT NULL",
                params![confirmation_token, session_id, Utc::now().timestamp()],
            )
            .map_err(|error| format!("mark transcript deletion: {error}"))?;
        if changed != 1 {
            return Err("删除 admission 不存在".to_string());
        }
        Ok(())
    }

    pub(crate) fn finalize_session_deletion(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("start brand deletion finalize: {error}"))?;
        let ready: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM session_deletion_intents
                 WHERE token = ?1 AND session_id = ?2 AND transcript_deleted_at IS NOT NULL",
                params![confirmation_token, session_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("verify transcript deletion: {error}"))?;
        if ready != 1 {
            return Err("聊天记录删除尚未完成".to_string());
        }
        let deleted = transaction
            .execute("DELETE FROM brand_sessions WHERE id = ?1", [session_id])
            .map_err(|error| format!("delete brand session: {error}"))?;
        if deleted != 1 {
            return Err("会话不存在".to_string());
        }
        transaction
            .commit()
            .map_err(|error| format!("commit brand session deletion: {error}"))
    }

    const WORKSPACE_DELETION_EXPIRY_SECONDS: i64 = 300;

    /// 品牌删除 intent 存放在即将被删除的品牌库内：admission 只需活到
    /// finalize 时刻，目录删除后 intent 随之消失，不产生跨品牌残留。
    fn ensure_workspace_deletion_intents(connection: &Connection) -> Result<(), String> {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS brand_deletion_intents (
                token TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                admitted_at INTEGER
             );",
            )
            .map_err(|error| format!("initialize brand deletion intents: {error}"))
    }

    pub fn workspace_session_ids(&self, workspace_id: &str) -> Result<Vec<String>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let mut statement = connection
            .prepare("SELECT id FROM brand_sessions")
            .map_err(|error| format!("list brand sessions for deletion: {error}"))?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("read brand sessions for deletion: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect brand sessions for deletion: {error}"))?;
        Ok(ids)
    }

    pub fn preview_workspace_deletion(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceDeletionPreview, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        Self::ensure_workspace_deletion_intents(&connection)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("start brand deletion preview: {error}"))?;
        let token = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        transaction
            .execute(
                "DELETE FROM brand_deletion_intents
                 WHERE workspace_id = ?1 AND admitted_at IS NULL",
                [workspace_id],
            )
            .map_err(|error| format!("replace brand deletion preview: {error}"))?;
        transaction
            .execute(
                "INSERT INTO brand_deletion_intents (token, workspace_id, expires_at)
                 VALUES (?1, ?2, ?3)",
                params![
                    token,
                    workspace_id,
                    now + Self::WORKSPACE_DELETION_EXPIRY_SECONDS
                ],
            )
            .map_err(|error| format!("write brand deletion preview: {error}"))?;
        let count = |transaction: &rusqlite::Transaction<'_>, sql: &str| -> Result<u64, String> {
            let value: i64 = transaction
                .query_row(sql, [], |row| row.get(0))
                .map_err(|error| format!("count brand deletion scope: {error}"))?;
            Ok(value.max(0) as u64)
        };
        let sessions = count(&transaction, "SELECT COUNT(*) FROM brand_sessions")?;
        let scope = WorkspaceDeletionScope {
            sessions,
            chat_transcripts: sessions,
            knowledge_facts: count(&transaction, "SELECT COUNT(*) FROM knowledge_facts")?,
            operations: count(&transaction, "SELECT COUNT(*) FROM geo_operations")?,
            articles: count(&transaction, "SELECT COUNT(*) FROM geo_articles")?,
            materials: count(&transaction, "SELECT COUNT(*) FROM brand_materials")?,
            monitor_plans: count(
                &transaction,
                "SELECT COUNT(*) FROM geo_post_publish_monitor_plans WHERE status = 'active'",
            )?,
        };
        let session_ids = {
            let mut statement = transaction
                .prepare("SELECT id FROM brand_sessions")
                .map_err(|error| format!("list brand sessions for preview: {error}"))?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| format!("read brand sessions for preview: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("collect brand sessions for preview: {error}"))?;
            ids
        };
        transaction
            .commit()
            .map_err(|error| format!("commit brand deletion preview: {error}"))?;
        Ok(WorkspaceDeletionPreview {
            workspace_id: workspace.id,
            name: workspace.name,
            session_ids,
            scope,
            confirmation_token: token,
        })
    }

    /// Persist a one-use brand deletion admission; execute must follow before
    /// the token expires, mirroring the session deletion contract.
    pub(crate) fn admit_workspace_deletion(
        &self,
        workspace_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        Self::ensure_workspace_deletion_intents(&connection)?;
        let admitted = connection
            .execute(
                "UPDATE brand_deletion_intents
                 SET admitted_at = ?3
                 WHERE token = ?1 AND workspace_id = ?2 AND expires_at >= ?3
                   AND admitted_at IS NULL",
                params![confirmation_token, workspace_id, Utc::now().timestamp()],
            )
            .map_err(|error| format!("verify brand deletion confirmation: {error}"))?;
        if admitted != 1 {
            return Err("删除确认已失效，请重新确认删除范围".to_string());
        }
        Ok(())
    }

    pub(crate) fn cancel_workspace_deletion_admission(
        &self,
        workspace_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        Self::ensure_workspace_deletion_intents(&connection)?;
        connection
            .execute(
                "DELETE FROM brand_deletion_intents
                 WHERE token = ?1 AND workspace_id = ?2 AND admitted_at IS NOT NULL",
                params![confirmation_token, workspace_id],
            )
            .map_err(|error| format!("cancel brand deletion admission: {error}"))?;
        Ok(())
    }

    /// Remove the brand from the catalog, then delete the whole workspace
    /// directory. Catalog-first keeps a failed directory removal recoverable:
    /// the orphaned directory no longer matches any catalog entry.
    pub(crate) fn finalize_workspace_deletion(
        &self,
        workspace_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        let _guard = catalog_lock().lock().map_err(|error| error.to_string())?;
        let mut catalog = self.read_catalog_unlocked()?;
        let index = catalog
            .workspaces
            .iter()
            .position(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| "品牌工作区不存在".to_string())?;
        let workspace = catalog.workspaces.remove(index);
        {
            let connection = open_database(&workspace)?;
            Self::ensure_workspace_deletion_intents(&connection)?;
            let admitted: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM brand_deletion_intents
                     WHERE token = ?1 AND workspace_id = ?2 AND admitted_at IS NOT NULL",
                    params![confirmation_token, workspace_id],
                    |row| row.get(0),
                )
                .map_err(|error| format!("verify brand deletion admission: {error}"))?;
            if admitted != 1 {
                return Err("删除确认已失效，请重新确认删除范围".to_string());
            }
        }
        if catalog.current_workspace_id.as_deref() == Some(workspace_id) {
            catalog.current_workspace_id = catalog.workspaces.first().map(|next| next.id.clone());
        }
        self.write_catalog_unlocked(&catalog)?;
        fs::remove_dir_all(&workspace.root_path)
            .map_err(|error| format!("delete brand workspace directory: {error}"))
    }

    fn session(
        &self,
        workspace: &BrandWorkspace,
        session_id: &str,
    ) -> Result<Option<BrandSession>, String> {
        let connection = open_database(workspace)?;
        let mut session = connection
            .query_row(
                "SELECT id, title, title_source, created_at, last_active_at, archived_at
                 FROM brand_sessions WHERE id = ?1",
                [session_id],
                |row| session_from_row(row, &workspace.id),
            )
            .optional()
            .map_err(|error| format!("read brand session: {error}"))?;
        if let Some(value) = session.as_mut() {
            value.geo_status = notifications::project_session_geo_status(&connection, &value.id)?;
        }
        Ok(session)
    }

    fn workspace(&self, workspace_id: &str) -> Result<BrandWorkspace, String> {
        self.with_healed_catalog()?
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| "品牌工作区不存在".to_string())
    }

    /// 读路径统一经过这里（用户裁决 2026-09-01「就用叶子名」）：目录里
    /// 存在非叶子名产品线时先治愈再返回。是否需要治愈与治愈改写共用
    /// healed_product_lines——幂等性保证收敛，最多一跳「检查 → 锁内改
    /// 写 → 重读」，不存在递归。
    fn with_healed_catalog(&self) -> Result<BrandCatalog, String> {
        let catalog = self.read_catalog()?;
        if catalog.workspaces.iter().any(|workspace| {
            healed_product_lines(&workspace.product_lines) != workspace.product_lines
        }) {
            self.heal_catalog_product_lines()?;
            return self.read_catalog();
        }
        Ok(catalog)
    }

    /// 历史同步进目录的两级复合值在锁内整目录一趟改写为叶子名；合并语
    /// 义只增不删，无法经合并自愈，故由读路径惰性触发。
    fn heal_catalog_product_lines(&self) -> Result<(), String> {
        let _guard = catalog_lock().lock().map_err(|error| error.to_string())?;
        let mut catalog = self.read_catalog_unlocked()?;
        let mut changed = false;
        for workspace in &mut catalog.workspaces {
            let healed = healed_product_lines(&workspace.product_lines);
            if healed != workspace.product_lines {
                workspace.product_lines = healed;
                workspace.updated_at = Utc::now().to_rfc3339();
                changed = true;
            }
        }
        if changed {
            self.write_catalog_unlocked(&catalog)?;
        }
        Ok(())
    }

    /// 方案 D（GD-11）：知识确认采纳「行业」事实后，把领域合并进品牌的
    /// 产品线（只增不删、去重、跳过超长值）。目录是产品线的唯一权威，
    /// 题库等下游闸门都读这里。
    pub(super) fn merge_workspace_product_lines(
        &self,
        workspace_id: &str,
        lines: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let _guard = catalog_lock().lock().map_err(|error| error.to_string())?;
        let mut catalog = self.read_catalog_unlocked()?;
        let workspace = catalog
            .workspaces
            .iter_mut()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| "品牌工作区不存在".to_string())?;
        let mut added = Vec::new();
        for raw in lines {
            // 行业事实同步进来的两级「大类/细分」值取叶子名落目录；口径
            //（叶子 + 80 上限）与创建入口、存量治愈共用 normalize_product_line。
            let Some(line) = normalize_product_line(&raw) else {
                continue;
            };
            if !workspace
                .product_lines
                .iter()
                .any(|existing| existing == &line)
            {
                workspace.product_lines.push(line.clone());
                added.push(line);
            }
        }
        if !added.is_empty() {
            workspace.updated_at = Utc::now().to_rfc3339();
            self.write_catalog_unlocked(&catalog)?;
        }
        Ok(added)
    }

    fn read_catalog(&self) -> Result<BrandCatalog, String> {
        let _guard = catalog_lock().lock().map_err(|error| error.to_string())?;
        self.read_catalog_unlocked()
    }

    fn read_catalog_unlocked(&self) -> Result<BrandCatalog, String> {
        let path = self.root.join(CATALOG_FILE);
        match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content)
                .map_err(|error| format!("parse {}: {error}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(BrandCatalog::default())
            }
            Err(error) => Err(format!("read {}: {error}", path.display())),
        }
    }

    fn write_catalog_unlocked(&self, catalog: &BrandCatalog) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(catalog)
            .map_err(|error| format!("serialize brand catalog: {error}"))?;
        crate::workspace_files::path_safety::atomic_write_file(
            &self.root.join(CATALOG_FILE),
            &bytes,
        )
    }
}

fn normalized_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 {
        return Err("品牌名称须为 1–80 个字符".to_string());
    }
    Ok(value.to_string())
}

fn normalized_product_lines(values: Vec<String>) -> Result<Vec<String>, String> {
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        // 创建入口与知识同步同口径：两级「大类/细分」值取叶子名，长度
        // 上限按叶子判（产品线即叶子）；尾斜杠等同只写大类。纯分隔符取
        // 不出叶子的值显式报错而不是静默丢弃——用户输入需要反馈。
        let Some(line) = product_line_leaf(value) else {
            return Err(format!("产品线名称无效：{value}"));
        };
        if line.chars().count() > 80 {
            return Err("产品线名称不能超过 80 个字符".to_string());
        }
        if !normalized.iter().any(|existing| existing == &line) {
            normalized.push(line);
        }
    }
    Ok(normalized)
}

/// 产品线叶子名：两级「大类/细分」行业值取最后一段非空细分（兼容全角
/// 斜杠）；空串/纯分隔符返回 None，由调用方跳过。
fn product_line_leaf(line: &str) -> Option<String> {
    let leaf = line
        .split(['/', '／'])
        .map(str::trim)
        .rfind(|segment| !segment.is_empty())?
        .to_string();
    Some(leaf)
}

/// 单条产品线规范化：叶子化并施加 80 字符上限，三条写路径（创建/知识
/// 同步/存量治愈）共用同一口径。
fn normalize_product_line(value: &str) -> Option<String> {
    let leaf = product_line_leaf(value)?;
    (leaf.chars().count() <= 80).then_some(leaf)
}

/// 目录产品线批量治愈形态：逐条规范化后去重（保序）。幂等——对自身输
/// 出再跑一次结果不变；「是否需要治愈」判定与治愈改写共用本函数，收敛
/// 由此保证。
fn healed_product_lines(lines: &[String]) -> Vec<String> {
    let mut healed: Vec<String> = Vec::new();
    for line in lines {
        let Some(normalized) = normalize_product_line(line) else {
            continue;
        };
        if !healed.contains(&normalized) {
            healed.push(normalized);
        }
    }
    healed
}

fn validate_session_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || value.starts_with("pending-")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("会话 identity 无效或尚未提交".to_string());
    }
    Ok(())
}

fn initialize_database(workspace: &BrandWorkspace) -> Result<(), String> {
    let connection = open_database(workspace)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS brand_workspace (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                product_lines_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS brand_sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                title_source TEXT NOT NULL CHECK(title_source IN ('default', 'auto', 'user')),
                created_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL,
                archived_at TEXT
             );
             CREATE INDEX IF NOT EXISTS brand_sessions_activity
                ON brand_sessions(archived_at, last_active_at DESC);
             CREATE TABLE IF NOT EXISTS knowledge_facts (
                id TEXT PRIMARY KEY,
                fact_key TEXT NOT NULL,
                version INTEGER NOT NULL,
                value_json TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS geo_operations (
                id TEXT PRIMARY KEY,
                session_id TEXT REFERENCES brand_sessions(id) ON DELETE SET NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS geo_artifacts (
                id TEXT PRIMARY KEY,
                operation_id TEXT REFERENCES geo_operations(id) ON DELETE SET NULL,
                session_id TEXT REFERENCES brand_sessions(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                knowledge_version INTEGER,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS publish_orders (
                id TEXT PRIMARY KEY,
                operation_id TEXT REFERENCES geo_operations(id) ON DELETE SET NULL,
                state TEXT NOT NULL,
                created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS observations (
                id TEXT PRIMARY KEY,
                operation_id TEXT REFERENCES geo_operations(id) ON DELETE SET NULL,
                observed_at TEXT NOT NULL,
                evidence_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS session_deletion_intents (
                token TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES brand_sessions(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                admitted_at INTEGER,
                transcript_deleted_at INTEGER
             );",
        )
        .map_err(|error| format!("initialize brand database: {error}"))?;
    ensure_column(
        &connection,
        "session_deletion_intents",
        "admitted_at",
        "INTEGER",
    )?;
    ensure_column(
        &connection,
        "session_deletion_intents",
        "transcript_deleted_at",
        "INTEGER",
    )?;
    geo_operations::ensure_schema(&connection)?;
    connection
        .execute(
            "INSERT OR REPLACE INTO brand_workspace
                (singleton, id, name, product_lines_json, created_at, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4, ?5)",
            params![
                workspace.id,
                workspace.name,
                serde_json::to_string(&workspace.product_lines).unwrap_or_else(|_| "[]".into()),
                workspace.created_at,
                workspace.updated_at,
            ],
        )
        .map_err(|error| format!("write brand identity: {error}"))?;
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    declaration: &str,
) -> Result<(), String> {
    if column_exists(connection, table, column)? {
        return Ok(());
    }
    if let Err(error) = connection.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {declaration}"
    )) {
        // Another Session process may have completed the same idempotent
        // migration after our PRAGMA read but before ALTER acquired the schema
        // lock. Re-read before surfacing the error.
        if !column_exists(connection, table, column)? {
            return Err(format!("upgrade brand database schema: {error}"));
        }
    }
    Ok(())
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| format!("inspect brand database schema: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("read brand database schema: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("collect brand database schema: {error}"))?;
    Ok(columns.iter().any(|candidate| candidate == column))
}

/// GEO 领域表的历史 schema 把 created_by_session_id / session_id /
/// actor_session_id 写成指向 brand_sessions 的 NOT NULL 外键（无删除动作），
/// 导致任何建过领域行的会话都在 finalize_session_deletion 报
/// FOREIGN KEY constraint failed。provenance 是审计标签而非存活引用——
/// 与 knowledge_decisions.actor_session_id 的既有形态对齐：去掉外键、
/// 保留 NOT NULL 与历史值。SQLite 无法就地修改外键，沿用
/// knowledge_decisions 的重建迁移（foreign_keys=OFF 包裹；索引随 DROP
/// TABLE 消失，按 sqlite_master 原文重建）。
fn drop_brand_sessions_foreign_keys(
    connection: &Connection,
    tables: &[&str],
) -> Result<(), String> {
    for table in tables {
        let existing: Option<String> = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| format!("inspect {table} schema: {error}"))?;
        let Some(existing_sql) = existing else {
            continue;
        };
        if !existing_sql.contains("REFERENCES brand_sessions") {
            continue;
        }

        let mut index_ddls: Vec<String> = Vec::new();
        {
            let mut statement = connection
                .prepare(
                    "SELECT sql FROM sqlite_master
                     WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL",
                )
                .map_err(|error| format!("list {table} indexes: {error}"))?;
            let mut rows = statement
                .query([table])
                .map_err(|error| format!("read {table} indexes: {error}"))?;
            while let Some(row) = rows
                .next()
                .map_err(|error| format!("advance {table} index cursor: {error}"))?
            {
                index_ddls.push(
                    row.get(0)
                        .map_err(|error| format!("read {table} index ddl: {error}"))?,
                );
            }
        }

        let rebuilt_sql = existing_sql.replace(" REFERENCES brand_sessions(id)", "");
        let renamed_sql =
            rename_table_in_ddl(&rebuilt_sql, table, &format!("{table}__session_fk_dropped"))?;

        connection
            .execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(|error| format!("unlock {table} session fk rebuild: {error}"))?;
        let rebuild = connection.execute_batch(&format!(
            "BEGIN IMMEDIATE;
             {renamed_sql};
             INSERT INTO {table}__session_fk_dropped SELECT * FROM {table};
             DROP TABLE {table};
             ALTER TABLE {table}__session_fk_dropped RENAME TO {table};
             {}
             COMMIT;",
            index_ddls
                .iter()
                .map(|ddl| format!("{ddl};"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
        let restored = connection.execute_batch("PRAGMA foreign_keys = ON;");
        match (rebuild, restored) {
            (Ok(()), Ok(())) => Ok(()),
            (rebuild, _) => {
                let _ = connection.execute_batch("ROLLBACK;");
                rebuild.map_err(|error| format!("rebuild {table} without session fk: {error}"))
            }
        }?;
    }
    Ok(())
}

/// sqlite_master 保存的表 DDL 以 `CREATE TABLE <name> ` 开头（IF NOT EXISTS
/// 与引号均不保留），直接替换首个表名为重建期间的临时名。
fn rename_table_in_ddl(ddl: &str, from: &str, to: &str) -> Result<String, String> {
    let header = format!("CREATE TABLE {from}");
    let rest = ddl
        .strip_prefix(&header)
        .ok_or_else(|| format!("unexpected {from} schema header"))?;
    Ok(format!("CREATE TABLE {to}{rest}"))
}

fn open_database(workspace: &BrandWorkspace) -> Result<Connection, String> {
    let connection = Connection::open(workspace.root_path.join("project.sqlite"))
        .map_err(|error| format!("open brand database: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("configure brand database timeout: {error}"))?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("configure brand database: {error}"))?;
    geo_operations::ensure_schema(&connection)?;
    knowledge::ensure_schema(&connection)?;
    materials::ensure_schema(&connection)?;
    question_pools::ensure_schema(&connection)?;
    geo_baselines::ensure_schema(&connection)?;
    topic_plans::ensure_schema(&connection)?;
    articles::ensure_schema(&connection)?;
    distribution_plans::ensure_schema(&connection)?;
    publish_scheduler::ensure_schema(&connection)?;
    post_publish_monitoring::ensure_schema(&connection)?;
    let has_geo_artifacts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='geo_artifacts'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect artifact schema state: {error}"))?;
    if has_geo_artifacts == 1 {
        ensure_column(&connection, "geo_artifacts", "knowledge_version", "INTEGER")?;
    }
    let has_deletion_intents: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'session_deletion_intents'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect brand database migration state: {error}"))?;
    if has_deletion_intents == 1 {
        ensure_column(
            &connection,
            "session_deletion_intents",
            "admitted_at",
            "INTEGER",
        )?;
        ensure_column(
            &connection,
            "session_deletion_intents",
            "transcript_deleted_at",
            "INTEGER",
        )?;
    }
    Ok(connection)
}

fn session_from_row(row: &rusqlite::Row<'_>, workspace_id: &str) -> rusqlite::Result<BrandSession> {
    let title_source: String = row.get(2)?;
    Ok(BrandSession {
        id: row.get(0)?,
        workspace_id: workspace_id.to_string(),
        title: row.get(1)?,
        title_source: SessionTitleSource::parse(&title_source),
        created_at: row.get(3)?,
        last_active_at: row.get(4)?,
        archived_at: row.get(5)?,
        geo_status: None,
    })
}

fn retained_scope(
    connection: &Connection,
    session_id: &str,
) -> Result<RetainedBrandDataScope, String> {
    fn count(connection: &Connection, sql: &str, session_id: Option<&str>) -> Result<u64, String> {
        let result: i64 = match session_id {
            Some(session_id) => connection.query_row(sql, [session_id], |row| row.get(0)),
            None => connection.query_row(sql, [], |row| row.get(0)),
        }
        .map_err(|error| format!("count deletion scope: {error}"))?;
        Ok(result.max(0) as u64)
    }

    Ok(RetainedBrandDataScope {
        knowledge_facts: count(connection, "SELECT COUNT(*) FROM knowledge_facts", None)?,
        operations: count(
            connection,
            "SELECT COUNT(*) FROM geo_operations WHERE session_id = ?1",
            Some(session_id),
        )?,
        artifacts: count(
            connection,
            "SELECT COUNT(*) FROM geo_artifacts
             WHERE session_id = ?1 OR operation_id IN
                (SELECT id FROM geo_operations WHERE session_id = ?1)",
            Some(session_id),
        )?,
        publish_orders: count(
            connection,
            "SELECT COUNT(*) FROM publish_orders WHERE operation_id IN
                (SELECT id FROM geo_operations WHERE session_id = ?1)",
            Some(session_id),
        )?,
        observations: count(
            connection,
            "SELECT COUNT(*) FROM observations WHERE operation_id IN
                (SELECT id FROM geo_operations WHERE session_id = ?1)",
            Some(session_id),
        )?,
    })
}

pub(crate) fn production_store() -> Result<BrandWorkspaceStore, String> {
    crate::app_dirs::xiaojing_data_dir()
        .map(BrandWorkspaceStore::at)
        .ok_or_else(|| "无法定位鲸杉geo本地数据目录".to_string())
}

#[tauri::command]
pub async fn cmd_brand_workspace_bootstrap() -> Result<BrandWorkspaceBootstrap, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let store = production_store()?;
        Ok(BrandWorkspaceBootstrap {
            data_root: store.root().to_path_buf(),
            workspaces: store.list_workspaces()?,
            current_workspace: store.current_workspace()?,
        })
    })
    .await
    .map_err(|error| format!("brand workspace bootstrap task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_workspace_create(
    name: String,
    productLines: Vec<String>,
) -> Result<BrandWorkspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.create_workspace(&name, productLines)
    })
    .await
    .map_err(|error| format!("brand workspace create task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_workspace_switch(workspaceId: String) -> Result<BrandWorkspace, String> {
    tauri::async_runtime::spawn_blocking(move || production_store()?.switch_workspace(&workspaceId))
        .await
        .map_err(|error| format!("brand workspace switch task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_session_commit(
    workspaceId: String,
    sessionId: String,
    title: String,
    titleSource: SessionTitleSource,
) -> Result<BrandSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.commit_session(
            &workspaceId,
            SessionCommit {
                id: sessionId,
                title,
                title_source: titleSource,
            },
        )
    })
    .await
    .map_err(|error| format!("brand session commit task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_session_list(
    workspaceId: String,
    includeArchived: bool,
) -> Result<Vec<BrandSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.list_sessions(&workspaceId, includeArchived)
    })
    .await
    .map_err(|error| format!("brand session list task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_session_rename(
    workspaceId: String,
    sessionId: String,
    title: String,
) -> Result<BrandSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.rename_session(&workspaceId, &sessionId, &title)
    })
    .await
    .map_err(|error| format!("brand session rename task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_session_archive(
    workspaceId: String,
    sessionId: String,
    archived: bool,
) -> Result<BrandSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.archive_session(&workspaceId, &sessionId, archived)
    })
    .await
    .map_err(|error| format!("brand session archive task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_session_delete_preview(
    workspaceId: String,
    sessionId: String,
) -> Result<SessionDeletionPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.preview_session_deletion(&workspaceId, &sessionId)
    })
    .await
    .map_err(|error| format!("brand session deletion preview task failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_workspace_delete_preview(
    workspaceId: String,
) -> Result<WorkspaceDeletionPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.preview_workspace_deletion(&workspaceId)
    })
    .await
    .map_err(|error| format!("brand workspace deletion preview task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn brand_creation_provisions_one_business_boundary() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));

        let brand = store
            .create_workspace("鲸跃科技", vec!["旗舰产品".into(), "企业服务".into()])
            .unwrap();

        assert_eq!(brand.name, "鲸跃科技");
        assert_eq!(brand.product_lines, vec!["旗舰产品", "企业服务"]);
        assert_eq!(store.current_workspace().unwrap().unwrap().id, brand.id);
        for relative in [
            "project.sqlite",
            "materials",
            "operations",
            "articles/approved",
            "media",
            "exports",
        ] {
            assert!(
                brand.root_path.join(relative).exists(),
                "missing {relative}"
            );
        }
    }

    // 产品线叶子名治理（用户裁决 2026-09-01）：历史两级复合值/带空格值
    // 在读路径惰性治愈为叶子名并持久化；workspace() 与 bootstrap 旁路
    //（list_workspaces/current_workspace）同拍治愈，UI 首屏即见叶子名。
    #[test]
    fn legacy_compound_product_lines_heal_on_workspace_read() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store
            .create_workspace("品牌丙", vec!["旗舰产品".into()])
            .unwrap();

        // 模拟裁决之前的存量目录：绕过入口校验直接改写 brands.json，
        // 注入复合值、全角斜杠、带空格值与重复叶子。
        let catalog_path = root.path().join("Xiaojing").join("brands.json");
        let mut catalog: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&catalog_path).unwrap()).unwrap();
        catalog["workspaces"][0]["productLines"] = serde_json::json!([
            "餐饮/食堂干蒸菜档口",
            "汽车服务／音响改装",
            "  教育培训  ",
            "  家电维修  "
        ]);
        std::fs::write(
            &catalog_path,
            serde_json::to_string_pretty(&catalog).unwrap(),
        )
        .unwrap();

        let healed = store.workspace(&brand.id).unwrap();
        assert_eq!(
            healed.product_lines,
            vec![
                "食堂干蒸菜档口".to_string(),
                "音响改装".to_string(),
                "教育培训".to_string(),
                "家电维修".to_string()
            ]
        );
        // 治愈已持久化：bootstrap 旁路与再次读取值稳定，不反复改写目录。
        assert_eq!(
            store.list_workspaces().unwrap()[0].product_lines,
            healed.product_lines
        );
        assert_eq!(
            store.current_workspace().unwrap().unwrap().product_lines,
            healed.product_lines
        );
        assert_eq!(
            store.workspace(&brand.id).unwrap().product_lines,
            healed.product_lines
        );
    }

    // 创建入口同口径：两级值落叶子名；取不出细分的值显式报错而不是静默
    // 丢弃；长度上限按叶子判——复合全长超限但叶子合规的值可入库。
    #[test]
    fn creating_workspace_normalizes_leaf_and_rejects_leafless_values() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));

        let brand = store
            .create_workspace("品牌丁", vec!["餐饮/火锅".into()])
            .unwrap();
        assert_eq!(brand.product_lines, vec!["火锅".to_string()]);

        let long_compound = format!("{}/保洁", "超".repeat(90));
        let long_category = store
            .create_workspace("品牌戊", vec![long_compound])
            .unwrap();
        assert_eq!(long_category.product_lines, vec!["保洁".to_string()]);

        // 尾斜杠等同只写大类（抽取口径允许大类-only）：叶子取大类本身。
        let category_only = store
            .create_workspace("品牌己", vec!["餐饮/".into()])
            .unwrap();
        assert_eq!(category_only.product_lines, vec!["餐饮".to_string()]);

        // 纯分隔符取不出任何叶子：显式报错而不是静默丢弃。
        assert_eq!(
            store
                .create_workspace("品牌庚", vec!["/".into()])
                .unwrap_err(),
            "产品线名称无效：/"
        );
    }

    #[test]
    fn session_reads_and_writes_require_the_workspace_identity() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let first = store.create_workspace("品牌甲", vec![]).unwrap();
        let second = store.create_workspace("品牌乙", vec![]).unwrap();

        store
            .commit_session(
                &first.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "甲的会话".into(),
                    title_source: SessionTitleSource::Auto,
                },
            )
            .unwrap();
        store.switch_workspace(&second.id).unwrap();

        assert_eq!(store.list_sessions(&first.id, false).unwrap().len(), 1);
        assert!(store.list_sessions(&second.id, false).unwrap().is_empty());
        assert_eq!(
            store.list_sessions(&first.id, false).unwrap()[0].title,
            "甲的会话"
        );
    }

    #[test]
    fn rename_and_archive_preserve_shared_brand_data() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store.create_workspace("品牌甲", vec![]).unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "自动标题".into(),
                    title_source: SessionTitleSource::Auto,
                },
            )
            .unwrap();
        seed_shared_data(&brand, "session-a");

        store
            .rename_session(&brand.id, "session-a", "用户标题")
            .unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "迟到的自动标题".into(),
                    title_source: SessionTitleSource::Auto,
                },
            )
            .unwrap();
        store.archive_session(&brand.id, "session-a", true).unwrap();

        assert!(store.list_sessions(&brand.id, false).unwrap().is_empty());
        let archived = store.list_sessions(&brand.id, true).unwrap();
        assert_eq!(archived[0].title, "用户标题");
        assert_eq!(archived[0].title_source, SessionTitleSource::User);
        assert!(archived[0].archived_at.is_some());
        assert_eq!(shared_row_counts(&brand), [1, 1, 1, 1, 1]);
    }

    #[test]
    fn permanent_delete_requires_a_matching_second_confirmation() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store.create_workspace("品牌甲", vec![]).unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "待删除".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        seed_shared_data(&brand, "session-a");

        let preview = store
            .preview_session_deletion(&brand.id, "session-a")
            .unwrap();
        assert_eq!(preview.scope.session_records, 1);
        assert_eq!(preview.scope.chat_transcripts, 1);
        assert_eq!(preview.retained.knowledge_facts, 1);
        assert_eq!(preview.retained.operations, 1);
        assert_eq!(preview.retained.artifacts, 1);
        assert_eq!(preview.retained.publish_orders, 1);
        assert_eq!(preview.retained.observations, 1);
        assert!(store
            .delete_session(&brand.id, "session-a", "wrong-token")
            .is_err());

        store
            .admit_session_deletion(&brand.id, "session-a", &preview.confirmation_token)
            .unwrap();
        assert_eq!(store.list_sessions(&brand.id, true).unwrap().len(), 1);
        store
            .rename_session(&brand.id, "session-a", "并发写仍可提交")
            .unwrap();
        store
            .cancel_session_deletion_admission(&brand.id, "session-a", &preview.confirmation_token)
            .unwrap();
        assert_eq!(store.list_sessions(&brand.id, true).unwrap().len(), 1);

        let preview = store
            .preview_session_deletion(&brand.id, "session-a")
            .unwrap();
        store
            .delete_session(&brand.id, "session-a", &preview.confirmation_token)
            .unwrap();

        assert!(store.list_sessions(&brand.id, true).unwrap().is_empty());
        assert_eq!(shared_row_counts(&brand), [1, 1, 1, 1, 1]);
    }

    /// 回归：GEO 领域表的 session 引用列曾是指向 brand_sessions 的 NOT NULL
    /// 外键（无删除动作），任何建过领域行的会话在 finalize_session_deletion
    /// 报 FOREIGN KEY constraint failed 且重试永远失败。现在 provenance 是
    /// 审计标签：会话删除成功，领域行与其 provenance 值原样保留。
    #[test]
    fn session_deletion_succeeds_with_geo_provenance_rows() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store
            .create_workspace("鲸跃", vec!["汽车音响".into()])
            .unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "建过领域行的会话".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        seed_geo_provenance_rows(&brand, "session-a");

        let preview = store
            .preview_session_deletion(&brand.id, "session-a")
            .unwrap();
        store
            .delete_session(&brand.id, "session-a", &preview.confirmation_token)
            .unwrap();

        assert!(store.list_sessions(&brand.id, true).unwrap().is_empty());
        let connection = open_database(&brand).unwrap();
        let count = |sql: String| {
            connection
                .query_row(&sql, [], |row| row.get::<_, i64>(0))
                .unwrap()
        };
        for (table, column) in [
            ("geo_question_pools", "created_by_session_id"),
            ("geo_question_pool_attempts", "session_id"),
            ("geo_question_pool_decisions", "session_id"),
            ("geo_topic_plans", "created_by_session_id"),
            ("geo_topic_plan_mutations", "session_id"),
            ("geo_topic_plan_decisions", "session_id"),
            ("geo_article_operations", "created_by_session_id"),
            ("geo_article_versions", "created_by_session_id"),
            ("geo_distribution_plans", "created_by_session_id"),
            ("geo_distribution_plan_audit", "actor_session_id"),
            ("geo_publish_executions", "created_by_session_id"),
            ("geo_baselines", "created_by_session_id"),
            ("geo_post_publish_monitor_plans", "created_by_session_id"),
        ] {
            assert_eq!(
                count(format!(
                    "SELECT COUNT(*) FROM {table} WHERE {column} = 'session-a'"
                )),
                1,
                "{table}.{column} provenance row must survive session deletion"
            );
        }
        // geo_operations 仍是 SET NULL 语义：操作保留，会话引用置空。
        assert_eq!(
            count("SELECT COUNT(*) FROM geo_operations WHERE session_id IS NULL".to_string()),
            5
        );
    }

    /// 存量库迁移：带旧外键的表在下次打开时被重建为无 session 外键的形态，
    /// 行与索引原样保留，随后会话删除可以通过。
    #[test]
    fn legacy_session_fk_schema_is_rebuilt_on_open() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store.create_workspace("鲸跃", vec![]).unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "旧库会话".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        seed_knowledge_chain(&brand);

        let legacy = Connection::open(brand.root_path.join("project.sqlite")).unwrap();
        legacy.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        legacy
            .execute_batch(
                "DROP TABLE geo_question_pools;
                 CREATE TABLE geo_question_pools (
                    id TEXT PRIMARY KEY,
                    operation_id TEXT NOT NULL REFERENCES geo_operations(id),
                    created_by_session_id TEXT NOT NULL REFERENCES brand_sessions(id),
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
                 CREATE INDEX geo_question_pool_identity
                    ON geo_question_pools(knowledge_version, product_line, target_region, updated_at DESC);
                 INSERT INTO geo_question_pools
                    (id, operation_id, created_by_session_id, knowledge_version, product_line,
                     target_region, generation_parameters_json, status, created_at, updated_at)
                 VALUES ('pool-legacy', 'operation-pool', 'session-a', 1, '汽车音响', '中国',
                     '{}', 'confirmed', 'now', 'now');",
            )
            .unwrap();
        drop(legacy);

        // 任意一次数据库打开都会执行 ensure_schema 迁移。
        store.list_sessions(&brand.id, false).unwrap();

        let connection = open_database(&brand).unwrap();
        let schema: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'geo_question_pools'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!schema.contains("REFERENCES brand_sessions"));
        let indexes: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = 'geo_question_pools' AND sql IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexes, 1, "identity index must survive the rebuild");
        let provenance: String = connection
            .query_row(
                "SELECT created_by_session_id FROM geo_question_pools WHERE id = 'pool-legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(provenance, "session-a");

        let preview = store
            .preview_session_deletion(&brand.id, "session-a")
            .unwrap();
        store
            .delete_session(&brand.id, "session-a", &preview.confirmation_token)
            .unwrap();
        assert!(store.list_sessions(&brand.id, true).unwrap().is_empty());
    }

    #[test]
    fn workspace_deletion_removes_catalog_entry_and_directory() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store.create_workspace("品牌甲", vec![]).unwrap();
        let other = store.create_workspace("品牌乙", vec![]).unwrap();
        store
            .commit_session(
                &brand.id,
                SessionCommit {
                    id: "session-a".into(),
                    title: "甲的会话".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        seed_shared_data(&brand, "session-a");

        let preview = store.preview_workspace_deletion(&brand.id).unwrap();
        assert_eq!(preview.workspace_id, brand.id);
        assert_eq!(preview.name, "品牌甲");
        assert_eq!(preview.session_ids, vec!["session-a".to_string()]);
        assert_eq!(preview.scope.sessions, 1);
        assert_eq!(preview.scope.chat_transcripts, 1);
        assert_eq!(preview.scope.knowledge_facts, 1);

        // 未 admission 的 token 不能 finalize，品牌保持原样。
        assert!(store
            .finalize_workspace_deletion(&brand.id, &preview.confirmation_token)
            .is_err());
        assert!(store
            .admit_workspace_deletion(&brand.id, "wrong-token")
            .is_err());
        assert!(brand.root_path.exists());

        store
            .admit_workspace_deletion(&brand.id, &preview.confirmation_token)
            .unwrap();
        store
            .finalize_workspace_deletion(&brand.id, &preview.confirmation_token)
            .unwrap();

        assert!(store
            .list_workspaces()
            .unwrap()
            .iter()
            .all(|workspace| { workspace.id != brand.id }));
        assert!(!brand.root_path.exists(), "brand directory must be removed");
        assert_eq!(store.current_workspace().unwrap().unwrap().id, other.id);
        // admission 只能用一次：重复 finalize 找不到品牌。
        assert!(store
            .finalize_workspace_deletion(&brand.id, &preview.confirmation_token)
            .is_err());
    }

    #[test]
    fn deleting_the_last_brand_clears_current_workspace() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store.create_workspace("仅存品牌", vec![]).unwrap();

        let preview = store.preview_workspace_deletion(&brand.id).unwrap();
        assert_eq!(preview.scope.sessions, 0);
        store
            .admit_workspace_deletion(&brand.id, &preview.confirmation_token)
            .unwrap();
        store
            .finalize_workspace_deletion(&brand.id, &preview.confirmation_token)
            .unwrap();

        assert!(store.list_workspaces().unwrap().is_empty());
        assert!(store.current_workspace().unwrap().is_none());
        assert!(!brand.root_path.exists());
    }

    fn seed_knowledge_chain(brand: &BrandWorkspace) {
        let connection = open_database(brand).unwrap();
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO knowledge_raw_inputs (id, session_id, input_text, origin, intent, created_at)
                 VALUES ('raw-1', 'session-a', '汽车行业', 'user-stated', 'knowledge-update', ?1)",
                [&now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_fact_candidates
                    (id, raw_input_id, session_id, subject, predicate, scope_json, fact_key,
                     value_json, normalized_value_json, excerpt, confidence, profile_provenance,
                     origin, intent, status, base_version, proposed_at, resolved_at)
                 VALUES ('candidate-1', 'raw-1', 'session-a', '鲸跃', 'enterprise-profile.industry',
                     '{}', 'industry', '\"汽车\"', '\"汽车\"', '汽车', 1.0, 'asked', 'user-stated',
                     'knowledge-update', 'adopted', 0, ?1, ?1)",
                [&now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_decisions
                    (id, candidate_id, decision, actor_id, actor_session_id, expected_version,
                     before_json, after_json, reason, decided_at)
                 VALUES ('decision-1', 'candidate-1', 'adopt-new', 'desktop-user', 'session-a', 0,
                     NULL, '\"汽车\"', 'test fixture', ?1)",
                [&now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_versions (version, decision_id, actor_session_id, snapshot_hash, created_at)
                 VALUES (1, 'decision-1', 'session-a', 'hash-1', ?1)",
                [&now],
            )
            .unwrap();
    }

    fn seed_geo_provenance_rows(brand: &BrandWorkspace, session_id: &str) {
        seed_knowledge_chain(brand);
        let connection = open_database(brand).unwrap();
        let now = Utc::now().to_rfc3339();
        for (id, state) in [
            ("operation-pool", "question-pool-confirmed"),
            ("operation-art", "article-completed"),
            ("operation-dist", "distribution-confirmed"),
            ("operation-pub", "publish-succeeded"),
            ("operation-monitor", "monitor-active"),
        ] {
            connection
                .execute(
                    "INSERT INTO geo_operations (id, session_id, state, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![id, session_id, state, now],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO geo_question_pools
                    (id, operation_id, created_by_session_id, knowledge_version, product_line,
                     target_region, generation_parameters_json, status, revision, created_at, updated_at)
                 VALUES ('pool-1', 'operation-pool', ?1, 1, '汽车音响', '中国', '{}',
                     'confirmed', 1, ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_question_pool_attempts
                    (id, pool_id, session_id, idempotency_key, state, created_at, updated_at)
                 VALUES ('attempt-1', 'pool-1', ?1, 'attempt-key-1', 'confirmed', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_question_pool_decisions
                    (id, pool_id, session_id, decision, expected_revision, revision,
                     questions_json, selected_question_ids_json, actor_id, decided_at)
                 VALUES ('pool-decision-1', 'pool-1', ?1, 'confirm-selection', 0, 1, '[]', '[]',
                     'desktop-user', ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_topic_plans
                    (id, operation_id, created_by_session_id, question_pool_id, question_pool_revision,
                     knowledge_version, product_line, target_region, policy_version, status, revision,
                     topics_json, items_json, model_audit_json, provider_snapshot_json,
                     created_at, updated_at)
                 VALUES ('topic-plan-1', 'operation-pool', ?1, 'pool-1', 1, 1, '汽车音响', '中国',
                     'policy-1', 'confirmed', 1, '[]', '[]', '{}', '{}', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_topic_plan_mutations
                    (id, plan_id, session_id, kind, expected_revision, revision, items_json,
                     target_item_ids_json, preserved_item_ids_json, actor_id, created_at)
                 VALUES ('topic-mutation-1', 'topic-plan-1', ?1, 'user-edit', 0, 1, '[]', '[]',
                     '[]', 'desktop-user', ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_topic_plan_decisions
                    (id, plan_id, session_id, expected_revision, revision,
                     selected_item_ids_json, actor_id, decided_at)
                 VALUES ('topic-decision-1', 'topic-plan-1', ?1, 0, 1, '[]', 'desktop-user', ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_article_operations
                    (operation_id, created_by_session_id, source_kind, topic_plan_id,
                     topic_plan_revision, knowledge_version, product_line, target_region,
                     policy_version, operation_spec_json, status, created_at, updated_at)
                 VALUES ('operation-art', ?1, 'confirmed-topic-plan', 'topic-plan-1', 1, 1,
                     '汽车音响', '中国', 'policy-1', '{}', 'completed', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_articles
                    (id, operation_id, knowledge_version, content_type, topic, requested_title,
                     constraints, planned_facts_json, status, created_at, updated_at)
                 VALUES ('article-1', 'operation-art', 1, 'guide', '汽车音响怎么选', '选购指南',
                     '{}', '{}', 'draft_ready', ?1, ?1)",
                params![now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_article_versions
                    (article_id, revision, title, body_path, body_sha256, origin,
                     model_audit_json, created_by_session_id, created_at)
                 VALUES ('article-1', 1, '选购指南', 'articles/approved/article-1.md', 'hash',
                     'generated', '{}', ?1, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_distribution_plans
                    (id, operation_id, created_by_session_id, article_operation_id,
                     knowledge_version, policy_version, status, provider_snapshot_json,
                     resource_snapshot_json, projection_json, created_at, updated_at)
                 VALUES ('dist-plan-1', 'operation-dist', ?1, 'operation-art', 1, 'policy-1',
                     'confirmed', '{}', '{}', '{}', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_distribution_plan_audit
                    (id, plan_id, revision, action, actor_session_id, detail_json, created_at)
                 VALUES ('dist-audit-1', 'dist-plan-1', 1, 'prepared', ?1, '{}', ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_publish_executions
                    (id, operation_id, created_by_session_id, distribution_plan_id,
                     distribution_plan_revision, status, revision, budget_cny, estimated_spend_cny,
                     publish_start_at, confirmation_digest, provider_snapshot_json,
                     created_at, updated_at)
                 VALUES ('publish-exec-1', 'operation-pub', ?1, 'dist-plan-1', 1, 'succeeded', 1,
                     100.0, 90.0, ?2, 'digest', '{}', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_baselines
                    (id, operation_id, created_by_session_id, question_pool_id,
                     question_pool_revision, knowledge_version, brand_names_json,
                     provider_snapshots_json, policy_version, status, idempotency_key,
                     created_at, updated_at)
                 VALUES ('baseline-1', 'operation-pool', ?1, 'pool-1', 1, 1, '[]', '{}',
                     'policy-1', 'succeeded', 'baseline-key-1', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_post_publish_monitor_plans
                    (id, operation_id, source_operation_id, created_by_session_id,
                     publish_execution_id, baseline_id, baseline_policy_version,
                     baseline_question_pool_id, baseline_question_pool_revision, engine_ids_json,
                     interval_minutes, end_conditions_json, policy_version, revision, status,
                     created_at, updated_at)
                 VALUES ('monitor-plan-1', 'operation-monitor', 'operation-pub', ?1,
                     'publish-exec-1', 'baseline-1', 'policy-1', 'pool-1', 1, '[\"engine-1\"]',
                     60, '{}', 'policy-1', 1, 'active', ?2, ?2)",
                params![session_id, now],
            )
            .unwrap();
    }

    fn seed_shared_data(brand: &BrandWorkspace, session_id: &str) {
        let connection = open_database(brand).unwrap();
        connection
            .execute(
                "INSERT INTO knowledge_facts (id, fact_key, version, value_json, created_at)
             VALUES ('fact-1', 'brand.name', 1, '{}', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_operations (id, session_id, state, created_at)
             VALUES ('operation-1', ?1, 'done', 'now')",
                [session_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_artifacts (id, operation_id, session_id, kind, created_at)
             VALUES ('artifact-1', 'operation-1', ?1, 'approved-article', 'now')",
                [session_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO publish_orders (id, operation_id, state, created_at)
             VALUES ('order-1', 'operation-1', 'submitted', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO observations (id, operation_id, observed_at, evidence_json)
             VALUES ('observation-1', 'operation-1', 'now', '{}')",
                [],
            )
            .unwrap();
    }

    fn shared_row_counts(brand: &BrandWorkspace) -> [i64; 5] {
        let connection = open_database(brand).unwrap();
        let count = |table: &str| {
            connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        [
            count("knowledge_facts"),
            count("geo_operations"),
            count("geo_artifacts"),
            count("publish_orders"),
            count("observations"),
        ]
    }
}
