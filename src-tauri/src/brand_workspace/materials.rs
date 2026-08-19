use super::*;

use rusqlite::TransactionBehavior;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Component;

const MAX_MATERIAL_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TEXT_MATERIAL_BYTES: usize = 2 * 1024 * 1024;
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "json", "html", "htm", "xml", "log", "pdf", "docx", "xlsx",
    "pptx",
];

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
                status TEXT NOT NULL CHECK(status IN ('processing', 'awaiting-confirmation', 'failed')),
                candidate_ids_json TEXT NOT NULL DEFAULT '[]',
                error_code TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(material_id, attempt_number)
             );",
        )
        .map_err(|error| format!("initialize brand material schema: {error}"))
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
        let path = resolve_material_path(&workspace, &material.relative_path)?;
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
        if !matches!(finish.status.as_str(), "awaiting-confirmation" | "failed") {
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
        for (id, status) in [("cand-pending", "awaiting-confirmation"), ("cand-adopted", "adopted")]
        {
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
}
