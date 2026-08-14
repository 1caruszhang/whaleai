use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const CATALOG_FILE: &str = "brands.json";
const BRAND_DIRS: [&str; 5] = [
    "materials",
    "operations",
    "articles/approved",
    "media",
    "exports",
];

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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionDraft {
    pub id: String,
    pub workspace_id: String,
    pub workspace_path: PathBuf,
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
        Ok(self.read_catalog()?.workspaces)
    }

    pub fn current_workspace(&self) -> Result<Option<BrandWorkspace>, String> {
        let catalog = self.read_catalog()?;
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

    pub fn new_session_draft(&self, workspace_id: &str) -> Result<SessionDraft, String> {
        let workspace = self.workspace(workspace_id)?;
        Ok(SessionDraft {
            id: format!("pending-{}", Uuid::new_v4()),
            workspace_id: workspace.id,
            workspace_path: workspace.root_path,
        })
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| format!("read brand sessions: {error}"))
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
        let expires_at = Utc::now().timestamp() + 300;
        transaction
            .execute(
                "DELETE FROM session_deletion_intents WHERE session_id = ?1 OR expires_at < ?2",
                params![session_id, Utc::now().timestamp()],
            )
            .map_err(|error| format!("clear stale deletion preview: {error}"))?;
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

    pub fn delete_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
    ) -> Result<(), String> {
        self.with_confirmed_session_deletion(workspace_id, session_id, confirmation_token, || {
            Ok(((), true))
        })
        .map(|_| ())
    }

    /// Run transcript deletion and brand-index deletion under one admission.
    /// A refused or failed transcript mutation rolls the SQLite transaction
    /// back, so callers can never consume the confirmation or remove the
    /// BrandSession projection before the lifecycle owner accepts deletion.
    pub(crate) fn with_confirmed_session_deletion<T, F>(
        &self,
        workspace_id: &str,
        session_id: &str,
        confirmation_token: &str,
        operation: F,
    ) -> Result<(T, bool), String>
    where
        F: FnOnce() -> Result<(T, bool), String>,
    {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        let transaction = connection
            .transaction()
            .map_err(|error| format!("start brand session deletion: {error}"))?;
        let admitted = transaction
            .execute(
                "DELETE FROM session_deletion_intents
                 WHERE token = ?1 AND session_id = ?2 AND expires_at >= ?3",
                params![confirmation_token, session_id, Utc::now().timestamp()],
            )
            .map_err(|error| format!("verify deletion confirmation: {error}"))?;
        if admitted != 1 {
            return Err("删除确认已失效，请重新确认关联范围".to_string());
        }
        let deleted = transaction
            .execute("DELETE FROM brand_sessions WHERE id = ?1", [session_id])
            .map_err(|error| format!("delete brand session: {error}"))?;
        if deleted != 1 {
            return Err("会话不存在".to_string());
        }
        let (result, accepted) = operation()?;
        if accepted {
            transaction
                .commit()
                .map_err(|error| format!("commit brand session deletion: {error}"))?;
        } else {
            transaction
                .rollback()
                .map_err(|error| format!("rollback refused brand session deletion: {error}"))?;
        }
        Ok((result, accepted))
    }

    fn session(
        &self,
        workspace: &BrandWorkspace,
        session_id: &str,
    ) -> Result<Option<BrandSession>, String> {
        let connection = open_database(workspace)?;
        connection
            .query_row(
                "SELECT id, title, title_source, created_at, last_active_at, archived_at
                 FROM brand_sessions WHERE id = ?1",
                [session_id],
                |row| session_from_row(row, &workspace.id),
            )
            .optional()
            .map_err(|error| format!("read brand session: {error}"))
    }

    fn workspace(&self, workspace_id: &str) -> Result<BrandWorkspace, String> {
        self.read_catalog()?
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| "品牌工作区不存在".to_string())
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
        if value.chars().count() > 80 {
            return Err("产品线名称不能超过 80 个字符".to_string());
        }
        if !normalized.iter().any(|existing| existing == value) {
            normalized.push(value.to_string());
        }
    }
    Ok(normalized)
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
                expires_at INTEGER NOT NULL
             );",
        )
        .map_err(|error| format!("initialize brand database: {error}"))?;
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

fn open_database(workspace: &BrandWorkspace) -> Result<Connection, String> {
    let connection = Connection::open(workspace.root_path.join("project.sqlite"))
        .map_err(|error| format!("open brand database: {error}"))?;
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("configure brand database timeout: {error}"))?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|error| format!("configure brand database: {error}"))?;
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
        .ok_or_else(|| "无法定位小鲸同学本地数据目录".to_string())
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
pub async fn cmd_brand_session_draft(workspaceId: String) -> Result<SessionDraft, String> {
    tauri::async_runtime::spawn_blocking(move || {
        production_store()?.new_session_draft(&workspaceId)
    })
    .await
    .map_err(|error| format!("brand session draft task failed: {error}"))?
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
    fn empty_session_drafts_never_touch_durable_storage() {
        let root = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let brand = store.create_workspace("品牌甲", vec![]).unwrap();

        let draft = store.new_session_draft(&brand.id).unwrap();

        assert!(draft.id.starts_with("pending-"));
        assert!(store.list_sessions(&brand.id, false).unwrap().is_empty());
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

        let refused = store
            .with_confirmed_session_deletion(
                &brand.id,
                "session-a",
                &preview.confirmation_token,
                || Ok(("refused", false)),
            )
            .unwrap();
        assert_eq!(refused, ("refused", false));
        assert_eq!(store.list_sessions(&brand.id, true).unwrap().len(), 1);

        store
            .delete_session(&brand.id, "session-a", &preview.confirmation_token)
            .unwrap();

        assert!(store.list_sessions(&brand.id, true).unwrap().is_empty());
        assert_eq!(shared_row_counts(&brand), [1, 1, 1, 1, 1]);
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
