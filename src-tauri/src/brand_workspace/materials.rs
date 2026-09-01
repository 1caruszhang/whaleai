use super::*;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::TransactionBehavior;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Component;

const MAX_MATERIAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_MATERIAL_BYTES: usize = 2 * 1024 * 1024;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "json", "html", "htm", "xml", "log", "pdf", "docx", "xlsx",
    "pptx", "png", "jpg", "jpeg", "webp", "gif",
];

/// 材料图片（ADR-0008）：可直传入池的图片扩展名。emf/wmf/tiff 不放行
/// （浏览器渲染不了，转换显式延后）。
const MATERIAL_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];

/// 入池分类白名单。图标装饰（icon-decoration）在导入管线就被过滤，因此
/// 不在存储白名单里——数据库层与代码层共享同一纪律。
const MATERIAL_IMAGE_CATEGORIES: &[&str] =
    &["product-photo", "scene", "people", "chart", "screenshot"];

/// 打标描述的入库上限（与 Node 侧截断边界一致）。
const MATERIAL_IMAGE_DESCRIPTION_MAX_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandMaterial {
    pub id: String,
    pub workspace_id: String,
    pub imported_by_session_id: String,
    pub input_kind: String,
    pub display_name: String,
    pub file_ext: String,
    pub media_type: String,
    pub relative_path: String,
    pub byte_size: u64,
    pub sha256: String,
    pub source: serde_json::Value,
    pub status: String,
    pub attempt_count: u32,
    pub last_error_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandMaterialContext {
    pub workspace_id: String,
    pub brand_name: String,
    pub product_lines: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBrandFileRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub source_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportBrandTextRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub input_kind: String,
    pub display_name: String,
    pub text: String,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialProcessingAttempt {
    pub id: String,
    pub material_id: String,
    pub attempt_number: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialProcessingFinish {
    pub attempt_id: String,
    pub material_id: String,
    pub status: String,
    pub candidate_ids: Vec<String>,
    pub error_code: Option<String>,
}

/// Session 材料列表项：材料投影 + 本 Session 最近一次 attempt 提交的候选
/// ID。候选归属提出它的 Session（裁决也只属于该 Session），因此跨
/// Session 的 attempt 不进入本列表。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrandMaterialListItem {
    pub material: BrandMaterial,
    pub candidate_ids: Vec<String>,
}

/// 材料图片资产（ADR-0008 候选池条目）：sha256 为跨来源全局唯一键，原始
/// 字节按内容寻址存 media/images/<sha256>.<ext>，随来源材料级联删除。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialImage {
    pub id: String,
    pub workspace_id: String,
    pub sha256: String,
    pub file_ext: String,
    pub media_type: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub description: String,
    pub category: String,
    pub source_material_id: String,
    pub source_material_name: String,
    pub relative_path: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 入池写入请求：byte_size 是与实际字节的一致性校验值（实际入库以落盘
/// 字节为准）。独立图片材料不带字节（Rust 从来源材料本体读回并比对材料
/// 存储哈希）；文档内嵌图（ADR-0008 T3）带 `embedded_image_b64`——字节与
/// 来源材料本体无关，按声明 sha256 校验后内容寻址落盘。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialImageSave {
    pub source_material_id: String,
    pub sha256: String,
    pub file_ext: String,
    pub media_type: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub embedded_image_b64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialImageSaveResult {
    pub id: String,
    pub deduplicated: bool,
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS brand_materials (
                id TEXT PRIMARY KEY,
                imported_by_session_id TEXT NOT NULL,
                input_kind TEXT NOT NULL CHECK(input_kind IN ('file', 'pasted-text', 'website-url')),
                display_name TEXT NOT NULL,
                file_ext TEXT NOT NULL,
                media_type TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE,
                byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
                sha256 TEXT NOT NULL,
                source_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('stored', 'processing', 'awaiting-confirmation', 'processed', 'failed')),
                attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
                last_error_code TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS brand_materials_status
                ON brand_materials(status, updated_at DESC);
             CREATE TABLE IF NOT EXISTS brand_material_processing (
                id TEXT PRIMARY KEY,
                material_id TEXT NOT NULL REFERENCES brand_materials(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL,
                attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
                status TEXT NOT NULL CHECK(status IN ('processing', 'awaiting-confirmation', 'processed', 'failed')),
                candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                error_code TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(material_id, attempt_number)
             );
             CREATE TABLE IF NOT EXISTS brand_material_images (
                id TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL UNIQUE,
                file_ext TEXT NOT NULL,
                media_type TEXT NOT NULL,
                byte_size INTEGER NOT NULL CHECK(byte_size > 0),
                width INTEGER NOT NULL CHECK(width > 0),
                height INTEGER NOT NULL CHECK(height > 0),
                description TEXT NOT NULL,
                category TEXT NOT NULL CHECK(category IN ('product-photo', 'scene', 'people', 'chart', 'screenshot')),
                source_material_id TEXT NOT NULL REFERENCES brand_materials(id) ON DELETE CASCADE,
                source_material_name TEXT NOT NULL,
                relative_path TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS brand_material_images_created
                ON brand_material_images(created_at DESC);",
        )
        .map_err(|error| format!("initialize brand material schema: {error}"))?;
    widen_material_processing_status_check(connection)?;
    Ok(())
}

/// ADR-0008 T2 为 attempt 终态加入 `processed`（独立图片材料零候选直接
/// 完成）。既有数据库的 CHECK 约束不含该值，SQLite 无法就地修改 CHECK——
/// 沿用监测计划的表重建迁移（foreign_keys=OFF 包裹；索引随 DROP TABLE
/// 消失，按 sqlite_master 原文重建）。已含 `processed` 或尚未建表的库是
/// 幂等 no-op。
fn widen_material_processing_status_check(connection: &Connection) -> Result<(), String> {
    const LEGACY_STATUS_CHECK: &str = "('processing', 'awaiting-confirmation', 'failed')";
    const WIDENED_STATUS_CHECK: &str =
        "('processing', 'awaiting-confirmation', 'processed', 'failed')";
    let table = "brand_material_processing";
    let existing: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect {table} status check: {error}"))?;
    let Some(existing_sql) = existing else {
        return Ok(());
    };
    if !existing_sql.contains(LEGACY_STATUS_CHECK) {
        return Ok(());
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
    let rebuilt_sql = existing_sql.replace(LEGACY_STATUS_CHECK, WIDENED_STATUS_CHECK);
    let renamed_sql =
        super::rename_table_in_ddl(&rebuilt_sql, table, &format!("{table}__status_widened"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| format!("unlock {table} status check rebuild: {error}"))?;
    let rebuild = connection.execute_batch(&format!(
        "BEGIN IMMEDIATE;
         {renamed_sql};
         INSERT INTO {table}__status_widened SELECT * FROM {table};
         DROP TABLE {table};
         ALTER TABLE {table}__status_widened RENAME TO {table};
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
            rebuild.map_err(|error| format!("rebuild {table} with widened status check: {error}"))
        }
    }
}

impl BrandWorkspaceStore {
    pub fn material_context(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<BrandMaterialContext, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        Ok(BrandMaterialContext {
            workspace_id: workspace.id,
            brand_name: workspace.name,
            product_lines: workspace.product_lines,
        })
    }

    pub fn import_brand_file(
        &self,
        request: ImportBrandFileRequest,
    ) -> Result<BrandMaterial, String> {
        validate_session_id(&request.session_id)?;
        let workspace = self.workspace(&request.workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, &request.session_id)?;

        let lexical =
            crate::workspace_files::path_safety::validate_external_read_path(&request.source_path)
                .map_err(|_| "material_source_rejected".to_string())?;
        let display_name = lexical
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "material_filename_invalid".to_string())?;
        let display_name = validate_display_name(display_name)?;
        let file_ext = supported_extension(&display_name)?;
        let mut source = crate::workspace_files::path_safety::open_regular_file_no_follow(
            &lexical,
            "brand material",
        )
        .map_err(|_| "material_source_rejected".to_string())?;
        let source_len = source
            .metadata()
            .map_err(|_| "material_source_unreadable".to_string())?
            .len();
        if source_len > MAX_MATERIAL_BYTES {
            return Err("material_too_large".to_string());
        }

        let id = Uuid::new_v4().to_string();
        let relative_path = format!("materials/{id}.{file_ext}");
        let final_path = workspace.root_path.join(&relative_path);
        let part_path = workspace
            .root_path
            .join("materials")
            .join(format!(".{id}.part"));
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|_| "material_store_failed".to_string())?;
        let (byte_size, sha256) = match copy_and_hash(&mut source, &mut target) {
            Ok(result) => result,
            Err(error) => {
                drop(target);
                let _ = fs::remove_file(&part_path);
                return Err(error);
            }
        };
        if target.sync_all().is_err() {
            drop(target);
            let _ = fs::remove_file(&part_path);
            return Err("material_store_failed".to_string());
        }
        drop(target);
        fs::rename(&part_path, &final_path).map_err(|_| {
            let _ = fs::remove_file(&part_path);
            "material_store_failed".to_string()
        })?;

        let source_json = serde_json::json!({ "type": "file", "originalName": display_name });
        if let Err(error) = insert_material(
            &connection,
            &id,
            &request.session_id,
            "file",
            &display_name,
            &file_ext,
            media_type_for_extension(&file_ext),
            &relative_path,
            byte_size,
            &sha256,
            &source_json,
        ) {
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
        read_material(&connection, &workspace.id, &id)
    }

    pub fn import_brand_text(
        &self,
        request: ImportBrandTextRequest,
    ) -> Result<BrandMaterial, String> {
        validate_session_id(&request.session_id)?;
        if !matches!(request.input_kind.as_str(), "pasted-text" | "website-url") {
            return Err("material_input_kind_invalid".to_string());
        }
        if request.text.trim().is_empty() || request.text.len() > MAX_TEXT_MATERIAL_BYTES {
            return Err("material_text_size_invalid".to_string());
        }
        let workspace = self.workspace(&request.workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, &request.session_id)?;
        let display_name = validate_display_name(&request.display_name)?;
        let file_ext = if request.input_kind == "website-url" {
            "html"
        } else {
            "txt"
        };
        let id = Uuid::new_v4().to_string();
        let relative_path = format!("materials/{id}.{file_ext}");
        let final_path = workspace.root_path.join(&relative_path);
        let part_path = workspace
            .root_path
            .join("materials")
            .join(format!(".{id}.part"));
        let bytes = request.text.as_bytes();
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|_| "material_store_failed".to_string())?;
        if target
            .write_all(bytes)
            .and_then(|_| target.sync_all())
            .is_err()
        {
            drop(target);
            let _ = fs::remove_file(&part_path);
            return Err("material_store_failed".to_string());
        }
        drop(target);
        fs::rename(&part_path, &final_path).map_err(|_| {
            let _ = fs::remove_file(&part_path);
            "material_store_failed".to_string()
        })?;
        let source_json = if request.input_kind == "website-url" {
            serde_json::json!({
                "type": "website-url",
                "url": request.source_url.as_deref().map(sanitize_source_url).transpose()?
            })
        } else {
            serde_json::json!({ "type": "pasted-text" })
        };
        if let Err(error) = insert_material(
            &connection,
            &id,
            &request.session_id,
            &request.input_kind,
            &display_name,
            file_ext,
            media_type_for_extension(file_ext),
            &relative_path,
            bytes.len() as u64,
            &sha256,
            &source_json,
        ) {
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
        read_material(&connection, &workspace.id, &id)
    }

    pub fn brand_material(
        &self,
        workspace_id: &str,
        session_id: &str,
        material_id: &str,
    ) -> Result<BrandMaterial, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        read_material(&connection, &workspace.id, material_id)
    }

    pub fn read_brand_material_bytes(
        &self,
        workspace_id: &str,
        session_id: &str,
        material_id: &str,
    ) -> Result<(BrandMaterial, Vec<u8>), String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let material = read_material(&connection, &workspace.id, material_id)?;
        let bytes = read_material_bytes(&workspace, &material)?;
        Ok((material, bytes))
    }

    pub fn begin_material_processing(
        &self,
        workspace_id: &str,
        session_id: &str,
        material_id: &str,
    ) -> Result<MaterialProcessingAttempt, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "material_processing_unavailable".to_string())?;
        let current_attempt: i64 = transaction
            .query_row(
                "SELECT attempt_count FROM brand_materials WHERE id = ?1",
                [material_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "material_processing_unavailable".to_string())?
            .ok_or_else(|| "material_not_found".to_string())?;
        let attempt_number = current_attempt + 1;
        let attempt_id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        transaction
            .execute(
                "UPDATE brand_materials
                 SET status='processing', attempt_count=?2, last_error_code=NULL, updated_at=?3
                 WHERE id=?1",
                params![material_id, attempt_number, now],
            )
            .map_err(|_| "material_processing_unavailable".to_string())?;
        transaction
            .execute(
                "INSERT INTO brand_material_processing
                    (id, material_id, session_id, attempt_number, status, candidate_ids_json,
                     error_code, started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, 'processing', '[]', NULL, ?5, NULL)",
                params![attempt_id, material_id, session_id, attempt_number, now],
            )
            .map_err(|_| "material_processing_unavailable".to_string())?;
        transaction
            .commit()
            .map_err(|_| "material_processing_unavailable".to_string())?;
        Ok(MaterialProcessingAttempt {
            id: attempt_id,
            material_id: material_id.to_string(),
            attempt_number: attempt_number as u32,
        })
    }

    pub fn finish_material_processing(
        &self,
        workspace_id: &str,
        session_id: &str,
        finish: MaterialProcessingFinish,
    ) -> Result<BrandMaterial, String> {
        validate_session_id(session_id)?;
        if !matches!(
            finish.status.as_str(),
            "awaiting-confirmation" | "processed" | "failed"
        ) {
            return Err("material_processing_status_invalid".to_string());
        }
        if finish.status == "failed" {
            let code = finish
                .error_code
                .as_deref()
                .ok_or_else(|| "material_error_code_required".to_string())?;
            validate_error_code(code)?;
        } else if finish.error_code.is_some() {
            return Err("material_error_code_unexpected".to_string());
        }
        if finish.candidate_ids.len() > 100
            || finish
                .candidate_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 128)
        {
            return Err("material_candidate_ids_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "material_processing_unavailable".to_string())?;
        let now = Utc::now().to_rfc3339();
        let changed = transaction
            .execute(
                "UPDATE brand_material_processing
                 SET status=?1, candidate_ids_json=?2, error_code=?3, finished_at=?4
                 WHERE id=?5 AND material_id=?6 AND session_id=?7 AND status='processing'",
                params![
                    &finish.status,
                    serde_json::to_string(&finish.candidate_ids)
                        .map_err(|_| "material_candidate_ids_invalid".to_string())?,
                    &finish.error_code,
                    &now,
                    &finish.attempt_id,
                    &finish.material_id,
                    session_id
                ],
            )
            .map_err(|_| "material_processing_unavailable".to_string())?;
        if changed != 1 {
            return Err("material_processing_attempt_stale".to_string());
        }
        transaction
            .execute(
                "UPDATE brand_materials SET status=?1, last_error_code=?2, updated_at=?3 WHERE id=?4",
                params![&finish.status, &finish.error_code, &now, &finish.material_id],
            )
            .map_err(|_| "material_processing_unavailable".to_string())?;
        transaction
            .commit()
            .map_err(|_| "material_processing_unavailable".to_string())?;
        read_material(&connection, &workspace.id, &finish.material_id)
    }

    /// 删除材料本体：行（processing attempts 随 FK 级联）、未决候选
    /// （awaiting-confirmation/conflict/rejected）与磁盘文件一并清除；
    /// 已被采纳进确认知识的候选（adopted/kept-current/split-scope）作为裁决
    /// 历史保留，确认知识不动。processing 中的材料拒绝删除（抽取队列还在
    /// 持有它）；文件缺失不阻断删除（行与候选仍清除）。
    pub fn delete_brand_material(
        &self,
        workspace_id: &str,
        session_id: &str,
        material_id: &str,
    ) -> Result<(), String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "material_delete_failed".to_string())?;
        let material = read_material(&transaction, &workspace.id, material_id)?;
        if material.status == "processing" {
            return Err("material_processing_active".to_string());
        }
        // 未决候选先摘掉引用它们的裁决记录与修改历史（两张表都是无级联的
        // 外键），再删候选本体；knowledge_fact_sources 的 candidate_id 是
        // 无约束文本，已采纳事实的证据链不动。
        transaction
            .execute(
                "DELETE FROM knowledge_candidate_revisions
                 WHERE candidate_id IN (
                     SELECT id FROM knowledge_fact_candidates
                     WHERE material_id=?1 AND status IN ('awaiting-confirmation','conflict','rejected'))",
                [material_id],
            )
            .map_err(|_| "material_delete_failed".to_string())?;
        transaction
            .execute(
                "DELETE FROM knowledge_decisions
                 WHERE candidate_id IN (
                     SELECT id FROM knowledge_fact_candidates
                     WHERE material_id=?1 AND status IN ('awaiting-confirmation','conflict','rejected'))",
                [material_id],
            )
            .map_err(|_| "material_delete_failed".to_string())?;
        transaction
            .execute(
                "DELETE FROM knowledge_fact_candidates
                 WHERE material_id=?1 AND status IN ('awaiting-confirmation','conflict','rejected')",
                [material_id],
            )
            .map_err(|_| "material_delete_failed".to_string())?;
        // 该材料贡献的候选池图片行随 FK 级联删除；磁盘文件路径先取回，
        // 事务提交后一并清掉。
        let image_relative_paths: Vec<String> = {
            let mut statement = transaction
                .prepare(
                    "SELECT relative_path FROM brand_material_images WHERE source_material_id=?1",
                )
                .map_err(|_| "material_delete_failed".to_string())?;
            let rows = statement
                .query_map([material_id], |row| row.get::<_, String>(0))
                .map_err(|_| "material_delete_failed".to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        transaction
            .execute("DELETE FROM brand_materials WHERE id=?1", [material_id])
            .map_err(|_| "material_delete_failed".to_string())?;
        transaction
            .commit()
            .map_err(|_| "material_delete_failed".to_string())?;
        // 文件在事务提交后删：与导入方向相反（导入是 DB 失败删文件）；文件
        // 缺失视为已删，幂等收尾。
        if let Ok(path) = resolve_material_path(&workspace, &material.relative_path) {
            let _ = fs::remove_file(path);
        }
        for relative in image_relative_paths {
            if let Ok(path) = resolve_media_image_path(&workspace, &relative) {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    /// 本 Session 导入的材料及其候选 ID：供 Sidecar 状态轮询与前端会话
    /// 恢复重建确认卡。`material_ids` 提供时按请求顺序返回存在的材料
    /// （仍限定本 Session 导入）；否则按 `updated_at` 倒序取最近 `limit`
    /// 条。`limit` 与 `material_ids` 数量都有界，防止无界响应。
    pub fn list_session_materials(
        &self,
        workspace_id: &str,
        session_id: &str,
        material_ids: Option<&[String]>,
        limit: usize,
    ) -> Result<Vec<BrandMaterialListItem>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let limit = limit.clamp(1, 20);
        let mut materials: Vec<BrandMaterial> = Vec::new();
        match material_ids {
            Some(ids) => {
                if ids.is_empty() || ids.len() > 50 {
                    return Err("material_ids_invalid".to_string());
                }
                for id in ids {
                    if let Ok(material) = read_material(&connection, &workspace.id, id) {
                        if material.imported_by_session_id == session_id {
                            materials.push(material);
                        }
                    }
                }
            }
            None => {
                let mut statement = connection
                    .prepare(
                        "SELECT id FROM brand_materials
                         WHERE imported_by_session_id=?1
                         ORDER BY updated_at DESC, id
                         LIMIT ?2",
                    )
                    .map_err(|_| "material_processing_unavailable".to_string())?;
                let ids: Vec<String> = statement
                    .query_map(params![session_id, limit as i64], |row| row.get(0))
                    .map_err(|_| "material_processing_unavailable".to_string())?
                    .filter_map(|row| row.ok())
                    .collect();
                for id in ids {
                    if let Ok(material) = read_material(&connection, &workspace.id, &id) {
                        materials.push(material);
                    }
                }
            }
        }
        // 本 Session 每个 material 最近一次 attempt 的候选 ID；一次分组
        // 查询后在内存里按 material 匹配，材料数已有界。
        let mut candidate_ids: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let mut statement = connection
            .prepare(
                "SELECT p.material_id, p.candidate_ids_json
                 FROM brand_material_processing p
                 JOIN (
                     SELECT material_id, MAX(attempt_number) AS max_attempt
                     FROM brand_material_processing
                     WHERE session_id = ?1
                     GROUP BY material_id
                 ) latest ON p.material_id = latest.material_id
                          AND p.attempt_number = latest.max_attempt
                 WHERE p.session_id = ?1",
            )
            .map_err(|_| "material_processing_unavailable".to_string())?;
        let rows = statement
            .query_map([session_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "material_processing_unavailable".to_string())?;
        for row in rows {
            let (material_id, ids_json) =
                row.map_err(|_| "material_processing_unavailable".to_string())?;
            if let Ok(parsed) = serde_json::from_str::<Vec<String>>(&ids_json) {
                candidate_ids.insert(material_id, parsed);
            }
        }
        Ok(materials
            .into_iter()
            .map(|material| {
                let ids = candidate_ids.remove(&material.id).unwrap_or_default();
                BrandMaterialListItem {
                    material,
                    candidate_ids: ids,
                }
            })
            .collect())
    }

    /// 存量重扫候选清单（ADR-0008 T7）：workspace 全部 docx/pptx 材料，
    /// 不限导入 Session（存量旧材料正是重扫对象）；processing 中的除外
    /// （其导入腿本就会提取内嵌图）。按 `updated_at` 升序（最旧的存量最先
    /// 补扫），limit 有界。只读投影，不含材料正文或本机路径。
    pub fn list_workspace_document_materials(
        &self,
        workspace_id: &str,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<BrandMaterial>, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let limit = limit.clamp(1, 100);
        let mut statement = connection
            .prepare(
                "SELECT id FROM brand_materials
                 WHERE file_ext IN ('docx', 'pptx') AND status != 'processing'
                 ORDER BY updated_at ASC, id
                 LIMIT ?1",
            )
            .map_err(|_| "material_read_failed".to_string())?;
        let ids: Vec<String> = statement
            .query_map(params![limit as i64], |row| row.get(0))
            .map_err(|_| "material_read_failed".to_string())?
            .filter_map(|row| row.ok())
            .collect();
        Ok(ids
            .into_iter()
            .filter_map(|id| read_material(&connection, &workspace.id, &id).ok())
            .collect())
    }

    /// 材料图片入池（ADR-0008 T2/T3）：sha256 全局唯一——已在池时幂等返回
    /// 既有条目（跨来源只入池一次）。独立图片材料的字节从来源材料本体读回
    /// 并按存储哈希校验；文档内嵌图的字节经 `embedded_image_b64` 载荷直送
    /// 并按声明 sha256 校验。内容寻址落 media/images/<sha256>.<ext>；一切
    /// 校验失败给固定码，由 Node 侧按「该图不入池、不阻塞导入」降级。
    pub fn save_material_image(
        &self,
        workspace_id: &str,
        session_id: &str,
        input: MaterialImageSave,
    ) -> Result<MaterialImageSaveResult, String> {
        validate_session_id(session_id)?;
        let sha256 = validate_image_sha256(&input.sha256)?;
        if !MATERIAL_IMAGE_EXTENSIONS.contains(&input.file_ext.as_str())
            || input.media_type != media_type_for_extension(&input.file_ext)
            || input.width == 0
            || input.height == 0
            || input.width > 100_000
            || input.height > 100_000
            || !MATERIAL_IMAGE_CATEGORIES.contains(&input.category.as_str())
        {
            return Err("material_image_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        if let Some(existing) = read_material_image_by_sha256(&connection, &workspace.id, &sha256)?
        {
            return Ok(MaterialImageSaveResult {
                id: existing.id,
                deduplicated: true,
            });
        }
        // 描述按 Unicode 码点截断保图（与 Node 侧同口径），只拒绝空描述。
        let description: String = input
            .description
            .trim()
            .chars()
            .take(MATERIAL_IMAGE_DESCRIPTION_MAX_CHARS)
            .collect();
        if description.is_empty() {
            return Err("material_image_invalid".to_string());
        }
        let material = read_material(&connection, &workspace.id, &input.source_material_id)?;
        // 字节来源两路（ADR-0008 T3）：内嵌图经载荷直送（哈希按声明值校验，
        // 与来源材料本体无关）；独立图片材料从材料本体读回（哈希与材料
        // 存储值互校）。两条路汇入同一内容寻址落盘与 sha256 唯一键。
        let bytes: Vec<u8> = match input.embedded_image_b64 {
            Some(encoded) => {
                let decoded = BASE64
                    .decode(encoded.trim())
                    .map_err(|_| "material_image_invalid".to_string())?;
                if decoded.len() as u64 > MAX_MATERIAL_BYTES {
                    return Err("material_too_large".to_string());
                }
                if format!("{:x}", Sha256::digest(&decoded)) != sha256 {
                    return Err("material_hash_mismatch".to_string());
                }
                decoded
            }
            None => {
                if material.sha256 != sha256 {
                    return Err("material_hash_mismatch".to_string());
                }
                read_material_bytes(&workspace, &material)?
            }
        };
        if input.byte_size != bytes.len() as u64 {
            return Err("material_image_invalid".to_string());
        }
        let relative_path = format!("media/images/{sha256}.{}", input.file_ext);
        let media_root = workspace.root_path.join("media").join("images");
        fs::create_dir_all(&media_root).map_err(|_| "material_store_failed".to_string())?;
        let target = workspace.root_path.join(&relative_path);
        // 内容寻址：目标已在盘上（历史写入/竞态先行者）即跳过复制，字节
        // 相同由 sha256 命名保证。
        if !target.exists() {
            let part_path = media_root.join(format!(".{sha256}.part"));
            let write = (|| -> std::io::Result<()> {
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&part_path)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                drop(file);
                fs::rename(&part_path, &target)?;
                Ok(())
            })();
            if write.is_err() {
                let _ = fs::remove_file(&part_path);
                return Err("material_store_failed".to_string());
            }
        }
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let inserted = connection.execute(
            "INSERT INTO brand_material_images
                (id, sha256, file_ext, media_type, byte_size, width, height, description,
                 category, source_material_id, source_material_name, relative_path,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            params![
                id,
                sha256,
                input.file_ext,
                input.media_type,
                bytes.len() as u64,
                input.width,
                input.height,
                description,
                input.category,
                material.id,
                material.display_name,
                relative_path,
                now
            ],
        );
        match inserted {
            Ok(_) => Ok(MaterialImageSaveResult {
                id,
                deduplicated: false,
            }),
            Err(_) => {
                // 并发同键竞态：唯一约束冲突读回既有条目，按去重收场。
                if let Some(existing) =
                    read_material_image_by_sha256(&connection, &workspace.id, &sha256)?
                {
                    return Ok(MaterialImageSaveResult {
                        id: existing.id,
                        deduplicated: true,
                    });
                }
                let _ = fs::remove_file(&target);
                Err("material_store_failed".to_string())
            }
        }
    }

    /// 候选清单（生成注入与预览取回的消费面）：按入池时间倒序，limit 有界。
    pub fn list_material_images(
        &self,
        workspace_id: &str,
        session_id: &str,
        limit: Option<usize>,
    ) -> Result<Vec<MaterialImage>, String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let limit = limit.unwrap_or(100).clamp(1, 200);
        let mut statement = connection
            .prepare(&format!(
                "SELECT {MATERIAL_IMAGE_COLUMNS}
                 FROM brand_material_images
                 ORDER BY created_at DESC, id
                 LIMIT ?1"
            ))
            .map_err(|_| "material_read_failed".to_string())?;
        let rows = statement
            .query_map(params![limit as i64], |row| {
                material_image_from_row(row, &workspace.id)
            })
            .map_err(|_| "material_read_failed".to_string())?;
        Ok(rows.filter_map(|row| row.ok()).collect())
    }

    /// 候选图片内容取回：路径闸 + 字节上限 + 存储哈希校验，与材料本体
    /// 读取同款纪律。
    pub fn read_material_image_bytes(
        &self,
        workspace_id: &str,
        session_id: &str,
        image_id: &str,
    ) -> Result<(MaterialImage, Vec<u8>), String> {
        validate_session_id(session_id)?;
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_committed_session(&connection, session_id)?;
        let image = read_material_image_by_id(&connection, &workspace.id, image_id)?;
        let path = resolve_media_image_path(&workspace, &image.relative_path)?;
        let mut file = crate::workspace_files::path_safety::open_regular_file_no_follow(
            &path,
            "stored material image",
        )
        .map_err(|_| "material_content_unavailable".to_string())?;
        let mut bytes = Vec::with_capacity((image.byte_size as usize).min(64 * 1024));
        Read::by_ref(&mut file)
            .take(MAX_MATERIAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "material_content_unavailable".to_string())?;
        if bytes.len() as u64 > MAX_MATERIAL_BYTES {
            return Err("material_too_large".to_string());
        }
        let actual_hash = format!("{:x}", Sha256::digest(&bytes));
        if actual_hash != image.sha256 {
            return Err("material_hash_mismatch".to_string());
        }
        Ok((image, bytes))
    }
}

fn require_committed_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    validate_session_id(session_id)?;
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM brand_sessions WHERE id=?1",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|_| "brand_session_unavailable".to_string())?;
    if count != 1 {
        return Err("brand_session_not_committed".to_string());
    }
    Ok(())
}

fn validate_display_name(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > 180
        || trimmed
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err("material_filename_invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn supported_extension(display_name: &str) -> Result<String, String> {
    let extension = Path::new(display_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("material_type_unsupported".to_string());
    }
    Ok(extension)
}

fn media_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "csv" => "text/csv",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "text/plain",
    }
}

fn copy_and_hash(source: &mut fs::File, target: &mut fs::File) -> Result<(u64, String), String> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| "material_source_unreadable".to_string())?;
        if read == 0 {
            break;
        }
        size = size.saturating_add(read as u64);
        if size > MAX_MATERIAL_BYTES {
            return Err("material_too_large".to_string());
        }
        hasher.update(&buffer[..read]);
        target
            .write_all(&buffer[..read])
            .map_err(|_| "material_store_failed".to_string())?;
    }
    Ok((size, format!("{:x}", hasher.finalize())))
}

#[allow(clippy::too_many_arguments)]
fn insert_material(
    connection: &Connection,
    id: &str,
    session_id: &str,
    input_kind: &str,
    display_name: &str,
    file_ext: &str,
    media_type: &str,
    relative_path: &str,
    byte_size: u64,
    sha256: &str,
    source: &serde_json::Value,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO brand_materials
                (id, imported_by_session_id, input_kind, display_name, file_ext, media_type,
                 relative_path, byte_size, sha256, source_json, status, attempt_count,
                 last_error_code, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'stored', 0, NULL, ?11, ?11)",
            params![
                id,
                session_id,
                input_kind,
                display_name,
                file_ext,
                media_type,
                relative_path,
                byte_size,
                sha256,
                serde_json::to_string(source).map_err(|_| "material_source_invalid".to_string())?,
                now
            ],
        )
        .map_err(|_| "material_metadata_store_failed".to_string())?;
    Ok(())
}

fn read_material(
    connection: &Connection,
    workspace_id: &str,
    material_id: &str,
) -> Result<BrandMaterial, String> {
    connection
        .query_row(
            "SELECT imported_by_session_id, input_kind, display_name, file_ext, media_type,
                    relative_path, byte_size, sha256, source_json, status, attempt_count,
                    last_error_code, created_at, updated_at
             FROM brand_materials WHERE id=?1",
            [material_id],
            |row| {
                let source_json: String = row.get(8)?;
                Ok(BrandMaterial {
                    id: material_id.to_string(),
                    workspace_id: workspace_id.to_string(),
                    imported_by_session_id: row.get(0)?,
                    input_kind: row.get(1)?,
                    display_name: row.get(2)?,
                    file_ext: row.get(3)?,
                    media_type: row.get(4)?,
                    relative_path: row.get(5)?,
                    byte_size: row.get::<_, i64>(6)?.max(0) as u64,
                    sha256: row.get(7)?,
                    source: serde_json::from_str(&source_json).unwrap_or(serde_json::Value::Null),
                    status: row.get(9)?,
                    attempt_count: row.get::<_, i64>(10)?.max(0) as u32,
                    last_error_code: row.get(11)?,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(|_| "material_read_failed".to_string())?
        .ok_or_else(|| "material_not_found".to_string())
}

fn resolve_material_path(workspace: &BrandWorkspace, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    let mut components = path.components();
    if components.next() != Some(Component::Normal("materials".as_ref()))
        || components
            .clone()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("material_path_invalid".to_string());
    }
    let resolved = workspace.root_path.join(path);
    let canonical_root = fs::canonicalize(workspace.root_path.join("materials"))
        .map_err(|_| "material_content_unavailable".to_string())?;
    let canonical =
        fs::canonicalize(&resolved).map_err(|_| "material_content_unavailable".to_string())?;
    if !canonical.starts_with(canonical_root) {
        return Err("material_path_invalid".to_string());
    }
    Ok(resolved)
}

/// 候选池图片路径闸：只接受 media/images/<name> 形态且 canonical 后仍在
/// media/images 根内（与材料本体路径闸同款纪律）。
fn resolve_media_image_path(workspace: &BrandWorkspace, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    let mut components = path.components();
    if components.next() != Some(Component::Normal("media".as_ref()))
        || components.next() != Some(Component::Normal("images".as_ref()))
        || components
            .clone()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("material_path_invalid".to_string());
    }
    let resolved = workspace.root_path.join(path);
    let canonical_root = fs::canonicalize(workspace.root_path.join("media").join("images"))
        .map_err(|_| "material_content_unavailable".to_string())?;
    let canonical =
        fs::canonicalize(&resolved).map_err(|_| "material_content_unavailable".to_string())?;
    if !canonical.starts_with(canonical_root) {
        return Err("material_path_invalid".to_string());
    }
    Ok(resolved)
}

/// 读材料本体字节并按存储哈希校验（内容完整性闸）。
fn read_material_bytes(
    workspace: &BrandWorkspace,
    material: &BrandMaterial,
) -> Result<Vec<u8>, String> {
    let path = resolve_material_path(workspace, &material.relative_path)?;
    let mut file = crate::workspace_files::path_safety::open_regular_file_no_follow(
        &path,
        "stored brand material",
    )
    .map_err(|_| "material_content_unavailable".to_string())?;
    let mut bytes = Vec::with_capacity((material.byte_size as usize).min(64 * 1024));
    Read::by_ref(&mut file)
        .take(MAX_MATERIAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "material_content_unavailable".to_string())?;
    if bytes.len() as u64 > MAX_MATERIAL_BYTES {
        return Err("material_too_large".to_string());
    }
    let actual_hash = format!("{:x}", Sha256::digest(&bytes));
    if actual_hash != material.sha256 {
        return Err("material_hash_mismatch".to_string());
    }
    Ok(bytes)
}

const MATERIAL_IMAGE_COLUMNS: &str = "id, sha256, file_ext, media_type, byte_size, width, height, \
     description, category, source_material_id, source_material_name, relative_path, \
     created_at, updated_at";

fn material_image_from_row(
    row: &rusqlite::Row<'_>,
    workspace_id: &str,
) -> rusqlite::Result<MaterialImage> {
    Ok(MaterialImage {
        id: row.get(0)?,
        workspace_id: workspace_id.to_string(),
        sha256: row.get(1)?,
        file_ext: row.get(2)?,
        media_type: row.get(3)?,
        byte_size: row.get::<_, i64>(4)?.max(0) as u64,
        width: row.get::<_, i64>(5)?.max(0) as u32,
        height: row.get::<_, i64>(6)?.max(0) as u32,
        description: row.get(7)?,
        category: row.get(8)?,
        source_material_id: row.get(9)?,
        source_material_name: row.get(10)?,
        relative_path: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

fn read_material_image_by_id(
    connection: &Connection,
    workspace_id: &str,
    image_id: &str,
) -> Result<MaterialImage, String> {
    connection
        .query_row(
            &format!("SELECT {MATERIAL_IMAGE_COLUMNS} FROM brand_material_images WHERE id=?1"),
            [image_id],
            |row| material_image_from_row(row, workspace_id),
        )
        .optional()
        .map_err(|_| "material_read_failed".to_string())?
        .ok_or_else(|| "material_not_found".to_string())
}

fn read_material_image_by_sha256(
    connection: &Connection,
    workspace_id: &str,
    sha256: &str,
) -> Result<Option<MaterialImage>, String> {
    connection
        .query_row(
            &format!("SELECT {MATERIAL_IMAGE_COLUMNS} FROM brand_material_images WHERE sha256=?1"),
            [sha256],
            |row| material_image_from_row(row, workspace_id),
        )
        .optional()
        .map_err(|_| "material_read_failed".to_string())
}

fn validate_image_sha256(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() != 64
        || !trimmed
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("material_image_invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn sanitize_source_url(raw: &str) -> Result<String, String> {
    let mut parsed = url::Url::parse(raw).map_err(|_| "material_source_url_invalid".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("material_source_url_invalid".to_string());
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

fn validate_error_code(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
    {
        return Err("material_error_code_invalid".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn fixture() -> (
        tempfile::TempDir,
        BrandWorkspaceStore,
        BrandWorkspace,
        String,
    ) {
        let root = tempfile::tempdir().expect("root");
        let store = BrandWorkspaceStore::at(root.path().join("Xiaojing"));
        let workspace = store
            .create_workspace("鲸跃科技", vec!["旗舰产品".to_string()])
            .expect("workspace");
        let session_id = "session-07".to_string();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: session_id.clone(),
                    title: "材料导入".to_string(),
                    title_source: SessionTitleSource::Default,
                },
            )
            .expect("session");
        (root, store, workspace, session_id)
    }

    fn external_source_dir() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::current_dir().expect("current dir"))
            .expect("external source dir")
    }

    #[test]
    fn imports_file_to_brand_materials_with_relative_path_and_hash() {
        let (root, store, workspace, session_id) = fixture();
        let source_dir = external_source_dir();
        let source = source_dir.path().join("profile.md");
        fs::write(&source, "公司全称：鲸跃科技").expect("source");
        let material = store
            .import_brand_file(ImportBrandFileRequest {
                workspace_id: workspace.id.clone(),
                session_id,
                source_path: source.to_string_lossy().into_owned(),
            })
            .expect("import");
        assert!(material.relative_path.starts_with("materials/"));
        assert!(!material
            .relative_path
            .contains(root.path().to_string_lossy().as_ref()));
        assert_eq!(material.sha256.len(), 64);
        assert_eq!(
            material.source,
            serde_json::json!({"type":"file","originalName":"profile.md"})
        );
        let mut body = String::new();
        fs::File::open(workspace.root_path.join(&material.relative_path))
            .expect("stored")
            .read_to_string(&mut body)
            .expect("body");
        assert_eq!(body, "公司全称：鲸跃科技");
    }

    #[test]
    fn keeps_brand_materials_isolated_and_rejects_unsupported_or_symlink_files() {
        let (_root, store, workspace, session_id) = fixture();
        let second = store.create_workspace("蓝鲸科技", vec![]).expect("second");
        let second_session = "session-07b";
        store
            .commit_session(
                &second.id,
                SessionCommit {
                    id: second_session.to_string(),
                    title: "材料".to_string(),
                    title_source: SessionTitleSource::Default,
                },
            )
            .expect("session");
        let source_dir = external_source_dir();
        let source = source_dir.path().join("profile.txt");
        fs::write(&source, "brand-a").expect("source");
        let material = store
            .import_brand_file(ImportBrandFileRequest {
                workspace_id: workspace.id.clone(),
                session_id,
                source_path: source.to_string_lossy().into_owned(),
            })
            .expect("import");
        assert!(store
            .brand_material(&second.id, second_session, &material.id)
            .is_err());

        let unsupported = source_dir.path().join("profile.exe");
        fs::write(&unsupported, "no").expect("unsupported");
        assert_eq!(
            store
                .import_brand_file(ImportBrandFileRequest {
                    workspace_id: workspace.id.clone(),
                    session_id: "session-07".to_string(),
                    source_path: unsupported.to_string_lossy().into_owned(),
                })
                .expect_err("unsupported"),
            "material_type_unsupported"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = source_dir.path().join("profile-link.txt");
            symlink(&source, &link).expect("link");
            assert_eq!(
                store
                    .import_brand_file(ImportBrandFileRequest {
                        workspace_id: workspace.id,
                        session_id: "session-07".to_string(),
                        source_path: link.to_string_lossy().into_owned(),
                    })
                    .expect_err("symlink"),
                "material_source_rejected"
            );
        }
    }

    #[test]
    fn records_only_the_retried_material_attempt() {
        let (_root, store, workspace, session_id) = fixture();
        let material = store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.clone(),
                input_kind: "pasted-text".to_string(),
                display_name: "粘贴资料.txt".to_string(),
                text: "鲸跃科技资料".to_string(),
                source_url: None,
            })
            .expect("text import");
        let first = store
            .begin_material_processing(&workspace.id, &session_id, &material.id)
            .expect("first");
        store
            .finish_material_processing(
                &workspace.id,
                &session_id,
                MaterialProcessingFinish {
                    attempt_id: first.id,
                    material_id: material.id.clone(),
                    status: "failed".to_string(),
                    candidate_ids: vec![],
                    error_code: Some("model_failed".to_string()),
                },
            )
            .expect("fail");
        let second = store
            .begin_material_processing(&workspace.id, &session_id, &material.id)
            .expect("retry");
        assert_eq!(second.attempt_number, 2);
        assert_eq!(
            store
                .brand_material(&workspace.id, &session_id, &material.id)
                .expect("material")
                .attempt_count,
            2
        );
    }

    #[test]
    fn website_material_keeps_only_a_sanitized_source_url() {
        let (_root, store, workspace, session_id) = fixture();
        let material = store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id,
                input_kind: "website-url".to_string(),
                display_name: "官网资料.html".to_string(),
                text: "<main>公开企业资料</main>".to_string(),
                source_url: Some(
                    "https://brand.example/about?private=customer#contact".to_string(),
                ),
            })
            .expect("website import");

        assert_eq!(
            material.source,
            serde_json::json!({
                "type": "website-url",
                "url": "https://brand.example/about"
            })
        );
        assert!(!material.source.to_string().contains("private"));
        assert!(!material.source.to_string().contains("contact"));
    }

    #[test]
    fn lists_session_materials_with_latest_attempt_candidate_ids() {
        let (_root, store, workspace, session_id) = fixture();
        let other_session = "session-07b".to_string();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: other_session.clone(),
                    title: "另一会话".to_string(),
                    title_source: SessionTitleSource::Default,
                },
            )
            .expect("other session");
        let first = store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.clone(),
                input_kind: "pasted-text".to_string(),
                display_name: "粘贴资料.txt".to_string(),
                text: "鲸跃科技资料".to_string(),
                source_url: None,
            })
            .expect("first import");
        let second = store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.clone(),
                input_kind: "pasted-text".to_string(),
                display_name: "补充资料.txt".to_string(),
                text: "补充事实".to_string(),
                source_url: None,
            })
            .expect("second import");
        // 另一 Session 的材料不得进入本 Session 的恢复列表。
        store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id: other_session,
                input_kind: "pasted-text".to_string(),
                display_name: "别的会话.txt".to_string(),
                text: "隔离".to_string(),
                source_url: None,
            })
            .expect("other import");

        // 首次 attempt 提交候选后失败重试：列表必须取最近一次 attempt 的候选。
        let failed_attempt = store
            .begin_material_processing(&workspace.id, &session_id, &first.id)
            .expect("begin");
        store
            .finish_material_processing(
                &workspace.id,
                &session_id,
                MaterialProcessingFinish {
                    attempt_id: failed_attempt.id,
                    material_id: first.id.clone(),
                    status: "failed".to_string(),
                    candidate_ids: vec![],
                    error_code: Some("model_failed".to_string()),
                },
            )
            .expect("failed finish");
        let retried = store
            .begin_material_processing(&workspace.id, &session_id, &first.id)
            .expect("retry begin");
        store
            .finish_material_processing(
                &workspace.id,
                &session_id,
                MaterialProcessingFinish {
                    attempt_id: retried.id,
                    material_id: first.id.clone(),
                    status: "awaiting-confirmation".to_string(),
                    candidate_ids: vec!["candidate-1".to_string()],
                    error_code: None,
                },
            )
            .expect("retry finish");

        let listed = store
            .list_session_materials(&workspace.id, &session_id, None, 10)
            .expect("list");
        assert_eq!(listed.len(), 2);
        let by_id: std::collections::HashMap<String, BrandMaterialListItem> = listed
            .into_iter()
            .map(|item| (item.material.id.clone(), item))
            .collect();
        assert_eq!(
            by_id.get(&first.id).expect("first").candidate_ids,
            vec!["candidate-1".to_string()]
        );
        assert_eq!(
            by_id.get(&first.id).expect("first").material.status,
            "awaiting-confirmation"
        );
        assert_eq!(
            by_id.get(&second.id).expect("second").candidate_ids,
            Vec::<String>::new()
        );

        // 指定 material_ids 轮询时：只返回存在的本 Session 材料，未知 id 忽略。
        let polled = store
            .list_session_materials(
                &workspace.id,
                &session_id,
                Some(&[first.id.clone(), "missing".to_string()]),
                10,
            )
            .expect("poll list");
        assert_eq!(polled.len(), 1);
        assert_eq!(polled[0].material.id, first.id);
        assert_eq!(polled[0].candidate_ids, vec!["candidate-1".to_string()]);
    }

    #[test]
    fn delete_removes_material_file_and_pending_candidates_but_keeps_adopted() {
        let (_root, store, workspace, session_id) = fixture();
        let material = store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.clone(),
                input_kind: "pasted-text".to_string(),
                display_name: "粘贴资料.txt".to_string(),
                text: "鲸跃科技资料".to_string(),
                source_url: None,
            })
            .expect("import");
        let file_path = workspace.root_path.join(&material.relative_path);
        assert!(file_path.exists());

        // 一条未决候选 + 一条已采纳候选（裁决历史）。
        let connection = open_database(&workspace).expect("db");
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO knowledge_raw_inputs (id, session_id, input_text, origin, intent, created_at)
                 VALUES ('raw-del-1', ?1, 'material:test', 'model-inferred', 'knowledge-update', ?2)",
                params![session_id, now],
            )
            .unwrap();
        for (id, status) in [
            ("cand-pending", "awaiting-confirmation"),
            ("cand-adopted", "adopted"),
        ] {
            connection
                .execute(
                    "INSERT INTO knowledge_fact_candidates
                        (id,raw_input_id,session_id,subject,predicate,scope_json,fact_key,
                         value_json,normalized_value_json,material_id,excerpt,confidence,
                         profile_provenance,origin,intent,status,base_version,proposed_at,resolved_at)
                     VALUES (?1,'raw-del-1',?2,'鲸跃','enterprise-profile.industry','{}',?1,
                             '\"汽车\"','\"汽车\"',?3,'摘录',1.0,'extracted','model-inferred',
                             'knowledge-update',?4,0,?5,?5)",
                    params![id, session_id, material.id, status, now],
                )
                .unwrap();
        }

        store
            .delete_brand_material(&workspace.id, &session_id, &material.id)
            .expect("delete");

        assert_eq!(
            store
                .brand_material(&workspace.id, &session_id, &material.id)
                .expect_err("gone"),
            "material_not_found"
        );
        assert!(!file_path.exists());
        // 已采纳候选（裁决历史）保留，未决候选清除。
        let kept: Vec<String> = connection
            .prepare("SELECT status FROM knowledge_fact_candidates WHERE material_id=?1")
            .unwrap()
            .query_map([&material.id], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap();
        assert_eq!(kept, vec!["adopted".to_string()]);
        // processing attempts 随 FK 级联清零。
        let attempts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM brand_material_processing WHERE material_id=?1",
                [&material.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 0);
    }

    #[test]
    fn delete_rejects_inflight_processing_and_unknown_material() {
        let (_root, store, workspace, session_id) = fixture();
        let material = store
            .import_brand_text(ImportBrandTextRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.clone(),
                input_kind: "pasted-text".to_string(),
                display_name: "粘贴资料.txt".to_string(),
                text: "鲸跃科技资料".to_string(),
                source_url: None,
            })
            .expect("import");
        assert_eq!(
            store
                .delete_brand_material(&workspace.id, &session_id, "missing")
                .expect_err("unknown"),
            "material_not_found"
        );
        store
            .begin_material_processing(&workspace.id, &session_id, &material.id)
            .expect("begin");
        assert_eq!(
            store
                .delete_brand_material(&workspace.id, &session_id, &material.id)
                .expect_err("processing"),
            "material_processing_active"
        );
        // 处理中的材料未被误删。
        assert_eq!(
            store
                .brand_material(&workspace.id, &session_id, &material.id)
                .expect("material")
                .status,
            "processing"
        );
    }

    /// 最小 PNG 头（签名 + IHDR 宽高）：材料存储只按字节收档，不解码像素。
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[0_u8; 9]);
        bytes
    }

    fn import_material_file(
        store: &BrandWorkspaceStore,
        workspace: &BrandWorkspace,
        session_id: &str,
        name: &str,
        bytes: &[u8],
    ) -> BrandMaterial {
        let source_dir = external_source_dir();
        let source = source_dir.path().join(name);
        fs::write(&source, bytes).expect("source");
        store
            .import_brand_file(ImportBrandFileRequest {
                workspace_id: workspace.id.clone(),
                session_id: session_id.to_string(),
                source_path: source.to_string_lossy().into_owned(),
            })
            .expect("import")
    }

    fn image_save(material: &BrandMaterial, bytes: &[u8]) -> MaterialImageSave {
        MaterialImageSave {
            source_material_id: material.id.clone(),
            sha256: material.sha256.clone(),
            file_ext: "png".to_string(),
            media_type: "image/png".to_string(),
            byte_size: bytes.len() as u64,
            width: 800,
            height: 600,
            description: "门店前台的智能音箱展台实拍".to_string(),
            category: "product-photo".to_string(),
            embedded_image_b64: None,
        }
    }

    /// 文档内嵌图入池请求（ADR-0008 T3）：字节与来源文档材料本体无关，
    /// sha256 按内嵌图自身内容计算，经 base64 载荷直送。
    fn embedded_image_save(material: &BrandMaterial, bytes: &[u8]) -> MaterialImageSave {
        MaterialImageSave {
            source_material_id: material.id.clone(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            file_ext: "png".to_string(),
            media_type: "image/png".to_string(),
            byte_size: bytes.len() as u64,
            width: 800,
            height: 600,
            description: "文档内嵌的门店前台展台实拍".to_string(),
            category: "product-photo".to_string(),
            embedded_image_b64: Some(BASE64.encode(bytes)),
        }
    }

    #[test]
    fn accepts_standalone_image_files_as_brand_materials() {
        let (_root, store, workspace, session_id) = fixture();
        let material = import_material_file(
            &store,
            &workspace,
            &session_id,
            "展拍.png",
            &png_bytes(800, 600),
        );
        assert_eq!(material.file_ext, "png");
        assert_eq!(material.media_type, "image/png");
        assert!(material.relative_path.ends_with(".png"));
    }

    #[test]
    fn saves_tagged_image_to_candidate_pool_with_content_addressed_bytes() {
        let (_root, store, workspace, session_id) = fixture();
        let bytes = png_bytes(800, 600);
        let material = import_material_file(&store, &workspace, &session_id, "展拍.png", &bytes);

        let saved = store
            .save_material_image(&workspace.id, &session_id, image_save(&material, &bytes))
            .expect("save");
        assert!(!saved.deduplicated);

        let expected_path = workspace
            .root_path
            .join(format!("media/images/{}.png", material.sha256));
        assert!(expected_path.exists(), "content-addressed file missing");

        let (image, read_back) = store
            .read_material_image_bytes(&workspace.id, &session_id, &saved.id)
            .expect("content");
        assert_eq!(read_back, bytes);
        assert_eq!(image.description, "门店前台的智能音箱展台实拍");
        assert_eq!(image.category, "product-photo");
        assert_eq!(image.width, 800);
        assert_eq!(image.height, 600);
        assert_eq!(image.source_material_id, material.id);
        assert_eq!(image.source_material_name, "展拍.png");

        let listed = store
            .list_material_images(&workspace.id, &session_id, None)
            .expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, saved.id);
    }

    #[test]
    fn deduplicates_pool_entries_by_sha256_across_source_materials() {
        let (_root, store, workspace, session_id) = fixture();
        let bytes = png_bytes(800, 600);
        let first = import_material_file(&store, &workspace, &session_id, "first.png", &bytes);
        let second = import_material_file(&store, &workspace, &session_id, "second.png", &bytes);

        let first_save = store
            .save_material_image(&workspace.id, &session_id, image_save(&first, &bytes))
            .expect("first save");
        let second_save = store
            .save_material_image(&workspace.id, &session_id, image_save(&second, &bytes))
            .expect("second save");
        assert!(!first_save.deduplicated);
        assert!(second_save.deduplicated);
        assert_eq!(first_save.id, second_save.id);

        let listed = store
            .list_material_images(&workspace.id, &session_id, None)
            .expect("list");
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn saves_embedded_image_bytes_from_document_materials() {
        let (_root, store, workspace, session_id) = fixture();
        // 来源材料是 docx 文档本体（字节与内嵌图无关）。
        let document = import_material_file(
            &store,
            &workspace,
            &session_id,
            "品牌介绍.docx",
            b"docx-bytes",
        );
        let image_bytes = png_bytes(800, 600);
        let image_hash = format!("{:x}", Sha256::digest(&image_bytes));
        assert_ne!(document.sha256, image_hash);

        let saved = store
            .save_material_image(
                &workspace.id,
                &session_id,
                embedded_image_save(&document, &image_bytes),
            )
            .expect("save");
        assert!(!saved.deduplicated);

        // 内容寻址按内嵌图自身哈希落盘（不是文档材料的哈希）。
        let expected_path = workspace
            .root_path
            .join(format!("media/images/{image_hash}.png"));
        assert!(expected_path.exists(), "content-addressed file missing");

        let (image, read_back) = store
            .read_material_image_bytes(&workspace.id, &session_id, &saved.id)
            .expect("content");
        assert_eq!(read_back, image_bytes);
        assert_eq!(image.sha256, image_hash);
        assert_eq!(image.byte_size, image_bytes.len() as u64);
        assert_eq!(image.source_material_id, document.id);
        assert_eq!(image.source_material_name, "品牌介绍.docx");
    }

    #[test]
    fn deduplicates_embedded_and_standalone_sources_of_the_same_image() {
        let (_root, store, workspace, session_id) = fixture();
        let image_bytes = png_bytes(800, 600);
        // 先独立上传同图入池（字节从材料本体读回的路径）。
        let standalone =
            import_material_file(&store, &workspace, &session_id, "展拍.png", &image_bytes);
        let first = store
            .save_material_image(
                &workspace.id,
                &session_id,
                image_save(&standalone, &image_bytes),
            )
            .expect("standalone save");
        assert!(!first.deduplicated);

        // 再从文档提取同一张图（字节经载荷直送的路径）→ 合一为一个候选。
        let document = import_material_file(
            &store,
            &workspace,
            &session_id,
            "品牌介绍.docx",
            b"docx-bytes",
        );
        let second = store
            .save_material_image(
                &workspace.id,
                &session_id,
                embedded_image_save(&document, &image_bytes),
            )
            .expect("embedded save");
        assert!(second.deduplicated);
        assert_eq!(first.id, second.id);

        let listed = store
            .list_material_images(&workspace.id, &session_id, None)
            .expect("list");
        assert_eq!(listed.len(), 1);
    }

    #[test]
    fn rejects_embedded_images_whose_payload_does_not_match_the_declared_hash() {
        let (_root, store, workspace, session_id) = fixture();
        let document = import_material_file(
            &store,
            &workspace,
            &session_id,
            "品牌介绍.docx",
            b"docx-bytes",
        );
        let image_bytes = png_bytes(800, 600);

        // 声明哈希与载荷字节不符。
        let mut wrong_hash = embedded_image_save(&document, &image_bytes);
        wrong_hash.sha256 = "f".repeat(64);
        assert_eq!(
            store.save_material_image(&workspace.id, &session_id, wrong_hash),
            Err("material_hash_mismatch".to_string())
        );

        // 声明字节数与载荷不符。
        let mut wrong_size = embedded_image_save(&document, &image_bytes);
        wrong_size.byte_size += 1;
        assert_eq!(
            store.save_material_image(&workspace.id, &session_id, wrong_size),
            Err("material_image_invalid".to_string())
        );

        // 非 base64 载荷。
        let mut bad_payload = embedded_image_save(&document, &image_bytes);
        bad_payload.embedded_image_b64 = Some("not-base64!!".to_string());
        assert_eq!(
            store.save_material_image(&workspace.id, &session_id, bad_payload),
            Err("material_image_invalid".to_string())
        );

        // 一切被拒的写入不落盘、不进池。
        assert!(store
            .list_material_images(&workspace.id, &session_id, None)
            .expect("list")
            .is_empty());
        assert!(!workspace
            .root_path
            .join("media")
            .join(format!("{}.png", "f".repeat(64)))
            .exists());
    }

    #[test]
    fn truncates_over_long_descriptions_by_code_points_instead_of_rejecting() {
        let (_root, store, workspace, session_id) = fixture();
        let bytes = png_bytes(800, 600);
        let material = import_material_file(&store, &workspace, &session_id, "展拍.png", &bytes);
        let mut input = image_save(&material, &bytes);
        // 400 码点（其中含代理对）超长描述：截断保图，不整图拒绝。
        input.description = format!("{}长", "🌊".repeat(320));

        let saved = store
            .save_material_image(&workspace.id, &session_id, input)
            .expect("save");
        let (image, _bytes) = store
            .read_material_image_bytes(&workspace.id, &session_id, &saved.id)
            .expect("content");
        assert_eq!(image.description.chars().count(), 300);
    }

    #[test]
    fn rejects_invalid_image_metadata_and_hash_mismatch() {
        let (_root, store, workspace, session_id) = fixture();
        let bytes = png_bytes(800, 600);
        let material = import_material_file(&store, &workspace, &session_id, "展拍.png", &bytes);

        let mut icon = image_save(&material, &bytes);
        icon.category = "icon-decoration".to_string();
        assert_eq!(
            store.save_material_image(&workspace.id, &session_id, icon),
            Err("material_image_invalid".to_string())
        );

        let mut wrong_hash = image_save(&material, &bytes);
        wrong_hash.sha256 = "f".repeat(64);
        assert_eq!(
            store.save_material_image(&workspace.id, &session_id, wrong_hash),
            Err("material_hash_mismatch".to_string())
        );

        let mut wrong_size = image_save(&material, &bytes);
        wrong_size.byte_size += 1;
        assert_eq!(
            store.save_material_image(&workspace.id, &session_id, wrong_size),
            Err("material_image_invalid".to_string())
        );
    }

    #[test]
    fn deleting_source_material_cascades_pool_rows_and_files() {
        let (_root, store, workspace, session_id) = fixture();
        let bytes = png_bytes(800, 600);
        let material = import_material_file(&store, &workspace, &session_id, "展拍.png", &bytes);
        let saved = store
            .save_material_image(&workspace.id, &session_id, image_save(&material, &bytes))
            .expect("save");
        let image_path = workspace
            .root_path
            .join(format!("media/images/{}.png", material.sha256));

        store
            .delete_brand_material(&workspace.id, &session_id, &material.id)
            .expect("delete");

        assert!(!image_path.exists(), "pool file should follow the material");
        assert!(store
            .list_material_images(&workspace.id, &session_id, None)
            .expect("list")
            .is_empty());
        assert_eq!(
            store.read_material_image_bytes(&workspace.id, &session_id, &saved.id),
            Err("material_not_found".to_string())
        );
    }

    #[test]
    fn finishes_image_material_attempt_with_processed_status() {
        let (_root, store, workspace, session_id) = fixture();
        let material = import_material_file(
            &store,
            &workspace,
            &session_id,
            "展拍.png",
            &png_bytes(800, 600),
        );
        let attempt = store
            .begin_material_processing(&workspace.id, &session_id, &material.id)
            .expect("begin");
        let finished = store
            .finish_material_processing(
                &workspace.id,
                &session_id,
                MaterialProcessingFinish {
                    attempt_id: attempt.id,
                    material_id: material.id.clone(),
                    status: "processed".to_string(),
                    candidate_ids: vec![],
                    error_code: None,
                },
            )
            .expect("finish");
        assert_eq!(finished.status, "processed");
        assert_eq!(finished.last_error_code, None);
    }

    #[test]
    fn lists_workspace_documents_for_legacy_rescan_across_sessions() {
        let (_root, store, workspace, session_id) = fixture();
        let other_session = "session-07c".to_string();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: other_session.clone(),
                    title: "旧会话".to_string(),
                    title_source: SessionTitleSource::Default,
                },
            )
            .expect("other session");
        // 旧会话导入的存量 docx/pptx + 不参与重扫的 txt/png 材料。
        let legacy_doc = import_material_file(
            &store,
            &workspace,
            &other_session,
            "旧品牌介绍.docx",
            b"docx",
        );
        let legacy_deck =
            import_material_file(&store, &workspace, &other_session, "旧路演.pptx", b"pptx");
        import_material_file(&store, &workspace, &other_session, "旧资料.txt", b"text");
        import_material_file(
            &store,
            &workspace,
            &other_session,
            "旧实拍.png",
            &png_bytes(800, 600),
        );

        let listed = store
            .list_workspace_document_materials(&workspace.id, &session_id, 100)
            .expect("list");
        let ids: Vec<String> = listed.iter().map(|item| item.id.clone()).collect();
        assert_eq!(ids, vec![legacy_doc.id.clone(), legacy_deck.id.clone()]);
        // 跨 Session 可见：新会话也能枚举旧会话导入的存量文档。
        assert_eq!(listed[0].imported_by_session_id, other_session);

        // processing 中的文档不进清单（其导入腿本就会提取内嵌图）。
        store
            .begin_material_processing(&workspace.id, &session_id, &legacy_deck.id)
            .expect("begin");
        let filtered = store
            .list_workspace_document_materials(&workspace.id, &session_id, 100)
            .expect("filtered");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, legacy_doc.id);

        // 另一品牌的文档不可见（workspace 隔离：本 Session 未提交到该品牌）。
        let second = store.create_workspace("蓝鲸科技", vec![]).expect("second");
        assert!(store
            .list_workspace_document_materials(&second.id, &session_id, 100)
            .is_err());
    }

    #[test]
    fn widens_legacy_processing_status_check_in_existing_databases() {
        let (_root, store, workspace, session_id) = fixture();
        let material = import_material_file(
            &store,
            &workspace,
            &session_id,
            "展拍.png",
            &png_bytes(800, 600),
        );

        // 把 attempt 表降级成迁移前的旧版 CHECK 形态，模拟存量库。
        {
            let connection =
                Connection::open(workspace.root_path.join("project.sqlite")).expect("open");
            connection
                .execute_batch("PRAGMA foreign_keys = OFF;")
                .expect("unlock");
            connection
                .execute_batch("DROP TABLE brand_material_processing;")
                .expect("drop");
            connection
                .execute_batch(
                    "CREATE TABLE brand_material_processing (
                        id TEXT PRIMARY KEY,
                        material_id TEXT NOT NULL REFERENCES brand_materials(id) ON DELETE CASCADE,
                        session_id TEXT NOT NULL,
                        attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
                        status TEXT NOT NULL CHECK(status IN ('processing', 'awaiting-confirmation', 'failed')),
                        candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                        error_code TEXT,
                        started_at TEXT NOT NULL,
                        finished_at TEXT,
                        UNIQUE(material_id, attempt_number)
                     );",
                )
                .expect("legacy schema");
            connection
                .execute_batch("PRAGMA foreign_keys = ON;")
                .expect("restore");
        }

        // 下一次 store 调用经 open_database 重走 ensure_schema：迁移把
        // 'processed' 放进 CHECK，随后旧库也能落 processed 终态。
        let attempt = store
            .begin_material_processing(&workspace.id, &session_id, &material.id)
            .expect("begin");
        let finished = store
            .finish_material_processing(
                &workspace.id,
                &session_id,
                MaterialProcessingFinish {
                    attempt_id: attempt.id,
                    material_id: material.id.clone(),
                    status: "processed".to_string(),
                    candidate_ids: vec![],
                    error_code: None,
                },
            )
            .expect("finish after migration");
        assert_eq!(finished.status, "processed");

        let connection = open_database(&workspace).expect("reopen");
        let sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'table' AND name = 'brand_material_processing'",
                [],
                |row| row.get(0),
            )
            .expect("schema");
        assert!(sql.contains("'processed'"));
    }
}
