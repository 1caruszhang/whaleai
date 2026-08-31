//! Internal Xiaojing Sidecar → Rust control plane.
//!
//! This is intentionally a small interface: GEO persistence, provider admission,
//! app-config invalidation, and the SDK child launch guard. It is bound only to
//! loopback and every Session-scoped mutation validates the current Sidecar
//! generation before touching a BrandWorkspace.

use axum::{
    body::Body,
    extract::DefaultBodyLimit,
    http::{
        header::{CACHE_CONTROL, CONTENT_TYPE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;
use tauri::Emitter;
use tokio::net::TcpListener;

use crate::{ulog_error, ulog_info, ulog_warn};

/// Global management API port (set once at startup)
static MANAGEMENT_PORT: OnceLock<u16> = OnceLock::new();

/// Get the management API port (returns 0 if not started)
pub fn get_management_port() -> u16 {
    MANAGEMENT_PORT.get().copied().unwrap_or(0)
}

/// Session Sidecar manager state (set once at startup).
static SIDECAR_STATE: OnceLock<crate::sidecar::ManagedSidecarManager> = OnceLock::new();

/// Set the SidecarManager state for the management API (called once at startup)
pub fn set_sidecar_state(state: crate::sidecar::ManagedSidecarManager) {
    let _ = SIDECAR_STATE.set(state);
}

fn get_sidecar_state() -> Option<&'static crate::sidecar::ManagedSidecarManager> {
    SIDECAR_STATE.get()
}

fn request_sidecar_generation(headers: &HeaderMap) -> Result<u64, Json<serde_json::Value>> {
    let generation = headers
        .get("x-xiaojing-sidecar-generation")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    generation.ok_or_else(|| {
        Json(serde_json::json!({
            "ok": false,
            "code": "invalid_request",
            "error": "A valid Sidecar generation is required",
        }))
    })
}

/// Start the internal management API server on a random port
/// Returns the port number for injection into Sidecar env vars
pub async fn start_management_api() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind management API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get management API address: {}", e))?
        .port();

    MANAGEMENT_PORT
        .set(port)
        .map_err(|_| "Management API already started".to_string())?;

    let app = Router::new()
        .route("/api/app/config-changed", post(app_config_changed_handler))
        .route(
            "/api/app/distribution-spend-limits",
            post(app_distribution_spend_limits_handler),
        )
        .route(
            "/api/brand-knowledge/current",
            post(brand_knowledge_current_handler),
        )
        .route(
            "/api/brand-knowledge/candidate/submit",
            post(brand_knowledge_candidate_submit_handler),
        )
        .route(
            "/api/brand-knowledge/candidate/get",
            post(brand_knowledge_candidate_get_handler),
        )
        .route(
            "/api/brand-knowledge/candidate/decide",
            post(brand_knowledge_candidate_decide_handler),
        )
        .route(
            "/api/brand-knowledge/candidate/revise",
            post(brand_knowledge_candidate_revise_handler),
        )
        .route(
            "/api/brand-geo-operations/create",
            post(brand_geo_operation_create_handler),
        )
        .route(
            "/api/brand-geo-operations/get",
            post(brand_geo_operation_get_handler),
        )
        .route(
            "/api/brand-geo-operations/list",
            post(brand_geo_operation_list_handler),
        )
        .route(
            "/api/brand-geo-operations/mutate",
            post(brand_geo_operation_mutate_handler),
        )
        .route(
            "/api/geo-provider-permits/acquire",
            post(geo_provider_permit_acquire_handler),
        )
        .route(
            "/api/geo-provider-permits/status",
            post(geo_provider_permit_status_handler),
        )
        .route(
            "/api/geo-provider-permits/release",
            post(geo_provider_permit_release_handler),
        )
        .route(
            "/api/geo-provider-permits/cancel",
            post(geo_provider_permit_cancel_handler),
        )
        .route(
            "/api/brand-materials/context",
            post(brand_material_context_handler),
        )
        .route(
            "/api/brand-materials/import-file",
            post(brand_material_import_file_handler),
        )
        .route(
            "/api/brand-materials/import-text",
            post(brand_material_import_text_handler),
        )
        .route("/api/brand-materials/get", post(brand_material_get_handler))
        .route(
            "/api/brand-materials/delete",
            post(brand_material_delete_handler),
        )
        .route(
            "/api/brand-materials/list",
            post(brand_material_list_handler),
        )
        .route(
            "/api/brand-materials/content",
            post(brand_material_content_handler),
        )
        .route(
            "/api/workspace-files/read-session-file",
            post(workspace_read_session_file_handler),
        )
        .route(
            "/api/brand-workspace/info",
            post(brand_workspace_info_handler),
        )
        .route(
            "/api/brand-materials/processing/start",
            post(brand_material_processing_start_handler),
        )
        .route(
            "/api/brand-materials/processing/finish",
            post(brand_material_processing_finish_handler),
        )
        .route(
            "/api/brand-materials/images/save",
            post(brand_material_image_save_handler),
        )
        .route(
            "/api/brand-materials/images/list",
            post(brand_material_image_list_handler),
        )
        .route(
            "/api/brand-materials/images/content",
            post(brand_material_image_content_handler),
        )
        .route(
            "/api/brand-materials/documents/list",
            post(brand_material_document_list_handler),
        )
        .route(
            "/api/brand-question-pools/latest",
            post(brand_question_pool_latest_handler),
        )
        .route(
            "/api/brand-question-pools/prepare",
            post(brand_question_pool_prepare_handler),
        )
        .route(
            "/api/brand-question-pools/step/claim",
            post(brand_question_pool_step_claim_handler),
        )
        .route(
            "/api/brand-question-pools/step/finish",
            post(brand_question_pool_step_finish_handler),
        )
        .route(
            "/api/brand-question-pools/persist",
            post(brand_question_pool_persist_handler),
        )
        .route(
            "/api/brand-question-pools/cancel",
            post(brand_question_pool_cancel_handler),
        )
        .route(
            "/api/brand-question-pools/decide",
            post(brand_question_pool_decide_handler),
        )
        .route(
            "/api/brand-question-pools/revise",
            post(brand_question_pool_revise_handler),
        )
        .route(
            "/api/brand-topic-plans/latest",
            post(brand_topic_plan_latest_handler),
        )
        .route(
            "/api/brand-topic-plans/get",
            post(brand_topic_plan_get_handler),
        )
        .route(
            "/api/brand-topic-plans/prepare",
            post(brand_topic_plan_prepare_handler),
        )
        .route(
            "/api/brand-topic-plans/create",
            post(brand_topic_plan_create_handler),
        )
        .route(
            "/api/brand-topic-plans/mutate",
            post(brand_topic_plan_mutate_handler),
        )
        .route(
            "/api/brand-topic-plans/confirm",
            post(brand_topic_plan_confirm_handler),
        )
        .route(
            "/api/brand-articles/latest",
            post(brand_article_latest_handler),
        )
        .route(
            "/api/brand-articles/operation/get",
            post(brand_article_operation_get_handler),
        )
        .route(
            "/api/brand-articles/start",
            post(brand_article_start_handler),
        )
        .route("/api/brand-articles/get", post(brand_article_get_handler))
        .route(
            "/api/brand-articles/generation/claim",
            post(brand_article_generation_claim_handler),
        )
        .route(
            "/api/brand-articles/generation/finish",
            post(brand_article_generation_finish_handler),
        )
        .route(
            "/api/brand-articles/generation/fail",
            post(brand_article_generation_fail_handler),
        )
        .route("/api/brand-articles/edit", post(brand_article_edit_handler))
        .route("/api/brand-articles/body", post(brand_article_body_handler))
        .route(
            "/api/brand-articles/review/claim",
            post(brand_article_review_claim_handler),
        )
        .route(
            "/api/brand-articles/review/finish",
            post(brand_article_review_finish_handler),
        )
        .route(
            "/api/brand-articles/review/stats",
            post(brand_article_review_stats_handler),
        )
        .route(
            "/api/brand-distribution-plans/context",
            post(brand_distribution_plan_context_handler),
        )
        .route(
            "/api/brand-distribution-plans/preferences/get",
            post(brand_channel_preferences_get_handler),
        )
        .route(
            "/api/brand-distribution-plans/preferences/set",
            post(brand_channel_preferences_set_handler),
        )
        .route(
            "/api/brand-distribution-plans/latest",
            post(brand_distribution_plan_latest_handler),
        )
        .route(
            "/api/brand-distribution-plans/get",
            post(brand_distribution_plan_get_handler),
        )
        .route(
            "/api/brand-distribution-plans/prepare",
            post(brand_distribution_plan_prepare_handler),
        )
        .route(
            "/api/brand-distribution-plans/discovery/finish",
            post(brand_distribution_plan_discovery_finish_handler),
        )
        .route(
            "/api/brand-distribution-plans/edit",
            post(brand_distribution_plan_edit_handler),
        )
        .route(
            "/api/brand-distribution-plans/confirm",
            post(brand_distribution_plan_confirm_handler),
        )
        .route(
            "/api/brand-publish-scheduler/latest",
            post(brand_publish_latest_handler),
        )
        .route(
            "/api/brand-publish-scheduler/get",
            post(brand_publish_get_handler),
        )
        .route(
            "/api/brand-publish-scheduler/preview",
            post(brand_publish_preview_handler),
        )
        .route(
            "/api/brand-publish-scheduler/revise",
            post(brand_publish_scheduler_revise_handler),
        )
        .route(
            "/api/brand-geo-baselines/latest",
            post(brand_geo_baseline_latest_handler),
        )
        .route(
            "/api/brand-geo-baselines/get",
            post(brand_geo_baseline_get_handler),
        )
        .route(
            "/api/brand-geo-baselines/prepare",
            post(brand_geo_baseline_prepare_handler),
        )
        .route(
            "/api/brand-geo-baselines/unit/claim",
            post(brand_geo_baseline_unit_claim_handler),
        )
        .route(
            "/api/brand-geo-baselines/unit/finish",
            post(brand_geo_baseline_unit_finish_handler),
        )
        .route(
            "/api/brand-geo-dashboard/get",
            post(brand_geo_dashboard_get_handler),
        )
        .route(
            "/api/brand-geo-dashboard/drilldown",
            post(brand_geo_dashboard_drilldown_handler),
        )
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

    if let Ok(store) = crate::brand_workspace::production_store() {
        crate::brand_workspace::start_publish_scheduler_background(store.clone());
        crate::brand_workspace::start_post_publish_monitor_scheduler_background(store);
    }

    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            ulog_error!("[management-api] Server error: {}", e);
        }
    });

    ulog_info!("[management-api] Started on http://127.0.0.1:{}", port);
    Ok(port)
}

/// Fan a disk-backed AppConfig invalidation out to every renderer window.
/// The payload intentionally contains no config fields because config.json may
/// contain credentials; renderers re-read the authorities after this signal.
async fn app_config_changed_handler() -> Json<serde_json::Value> {
    let Some(app_handle) = crate::logger::get_app_handle() else {
        return Json(serde_json::json!({
            "ok": false,
            "error": "App handle is not initialized",
        }));
    };
    match app_handle.emit("app:config-changed", ()) {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(error) => {
            ulog_warn!("[management] Failed to emit app:config-changed: {}", error);
            Json(serde_json::json!({
                "ok": false,
                "error": error.to_string(),
            }))
        }
    }
}

/// Session Sidecars read the current user preference immediately before a new
/// plan is created. The plan then freezes these values in its Rust-owned
/// projection, so later setting changes cannot mutate pending/confirmed work.
async fn app_distribution_spend_limits_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<Value>>,
) -> Json<serde_json::Value> {
    if let Err(error) = validate_brand_knowledge_request(&headers, &request) {
        return Json(error);
    }
    Json(serde_json::json!({
        "ok": true,
        "limits": crate::distribution_spend_limits::read_distribution_spend_limits(),
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandKnowledgeEnvelope<T> {
    sidecar_id: String,
    workspace_id: String,
    session_id: String,
    payload: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandKnowledgeCurrentPayload {
    fact_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandKnowledgeCandidatePayload {
    candidate_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandMaterialPayload {
    material_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandMaterialListPayload {
    /// 提供时按给定顺序返回这些材料（状态轮询）；缺省返回最近的本 Session
    /// 材料（会话恢复重建确认卡）。
    material_ids: Option<Vec<String>>,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialImageListPayload {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialImageContentPayload {
    image_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialDocumentListPayload {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandWorkspaceInfoPayload {}

// Sidecar 只读品牌摘要：产品线（领域）权威在目录，知识确认采纳行业事实后
// 写回；agent 工具据此为题库等闸门选择默认产品线。
async fn brand_workspace_info_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandWorkspaceInfoPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let workspace = match store
        .list_workspaces()
        .map_err(|error| serde_json::json!({ "ok": false, "error": error }))
        .and_then(|workspaces| {
            workspaces
                .into_iter()
                .find(|workspace| workspace.id == request.workspace_id)
                .ok_or_else(|| {
                    serde_json::json!({ "ok": false, "code": "invalid_workspace", "error": "Brand workspace does not exist" })
                })
        }) {
        Ok(workspace) => workspace,
        Err(error) => return Json(error),
    };
    Json(serde_json::json!({
        "ok": true,
        "workspace": {
            "id": workspace.id,
            "name": workspace.name,
            "productLines": workspace.product_lines,
        }
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoProviderPermitAcquirePayload {
    request_id: String,
    slot: String,
    unit_kind: String,
    unit_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoProviderPermitStatusPayload {
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeoProviderPermitReleasePayload {
    permit_token: String,
}

fn geo_provider_caller<T>(
    headers: &HeaderMap,
    request: &BrandKnowledgeEnvelope<T>,
) -> Result<crate::geo_provider_runtime::GeoProviderCaller, serde_json::Value> {
    validate_brand_knowledge_request(headers, request)?;
    let sidecar_generation = request_sidecar_generation(headers).map_err(|Json(value)| value)?;
    Ok(crate::geo_provider_runtime::GeoProviderCaller {
        sidecar_id: request.sidecar_id.clone(),
        sidecar_generation,
        workspace_id: request.workspace_id.clone(),
        session_id: request.session_id.clone(),
    })
}

fn validate_brand_knowledge_request<T>(
    headers: &HeaderMap,
    request: &BrandKnowledgeEnvelope<T>,
) -> Result<crate::brand_workspace::BrandWorkspaceStore, serde_json::Value> {
    let generation = request_sidecar_generation(headers).map_err(|Json(value)| value)?;
    let store = crate::brand_workspace::production_store().map_err(|error| {
        serde_json::json!({ "ok": false, "code": "management_unavailable", "error": error })
    })?;
    let workspace = store
        .list_workspaces()
        .map_err(|error| serde_json::json!({ "ok": false, "error": error }))?
        .into_iter()
        .find(|workspace| workspace.id == request.workspace_id)
        .ok_or_else(|| serde_json::json!({ "ok": false, "code": "invalid_workspace", "error": "Brand workspace does not exist" }))?;
    let Some(sidecars) = get_sidecar_state() else {
        return Err(serde_json::json!({
            "ok": false,
            "code": "management_unavailable",
            "error": "Sidecar manager is not initialized",
        }));
    };
    let matches = sidecars
        .lock()
        .map(|manager| {
            manager.is_live_brand_process(
                &request.sidecar_id,
                generation,
                &request.session_id,
                &workspace.root_path,
            )
        })
        .map_err(|error| {
            serde_json::json!({
                "ok": false,
                "code": "management_unavailable",
                "error": format!("Sidecar lock poisoned: {error}"),
            })
        })?;
    if !matches {
        return Err(serde_json::json!({
            "ok": false,
            "code": "stale_or_mismatched_brand_sidecar",
            "error": "Brand knowledge caller identity does not match the current Session generation and workspace",
        }));
    }
    Ok(store)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadSessionFilePayload {
    relative_path: String,
    offset_chars: Option<usize>,
    max_chars: Option<usize>,
}

/// 会话文件读取硬上限：整文件字节上限与单窗字符上限（分页由 offset 承担）。
const READ_SESSION_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
const READ_SESSION_FILE_MAX_CHARS: usize = 50_000;
const READ_SESSION_FILE_MAX_OFFSET_CHARS: usize = 2_000_000;

/// 会话文件相对路径只允许 `xiaojing_files/<sessionId>/<name>` 三段形态。
/// 通过时返回归一化（`\`→`/`）后的路径供读取端复用，避免校验与读取口径不一。
fn validate_session_file_relative_path(
    relative: &str,
    session_id: &str,
) -> Result<String, &'static str> {
    let normalized = relative.trim().replace('\\', "/");
    let mut segments = normalized.split('/');
    match (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) {
        (Some("xiaojing_files"), Some(sid), Some(name), None)
            if sid == session_id && !name.is_empty() && name != "." && name != ".." =>
        {
            Ok(normalized)
        }
        _ => Err("invalid_session_file_reference"),
    }
}

/// 返回 (窗口内容, 生效 offset, 总字符数, 是否还有更多)。UTF-8 字符边界安全。
fn session_file_read_window(
    content: &str,
    offset_chars: usize,
    max_chars: usize,
) -> (String, usize, usize, bool) {
    let total_chars = content.chars().count();
    let offset = offset_chars
        .min(READ_SESSION_FILE_MAX_OFFSET_CHARS)
        .min(total_chars);
    let max_chars = max_chars.clamp(1, READ_SESSION_FILE_MAX_CHARS);
    let window: String = content.chars().skip(offset).take(max_chars).collect();
    let returned = window.chars().count();
    (window, offset, total_chars, offset + returned < total_chars)
}

/// 会话附件的受限读取（ADR-0001）：仅当前会话 `xiaojing_files/<sessionId>/`
/// 下的文件、有界字节、no-follow 打开。调用方必须通过 Sidecar 身份校验。
async fn workspace_read_session_file_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<ReadSessionFilePayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let relative_path = match validate_session_file_relative_path(
        &request.payload.relative_path,
        &request.session_id,
    ) {
        Ok(path) => path,
        Err(code) => {
            return Json(serde_json::json!({
                "ok": false,
                "code": code,
                "error": "Session file reference must be xiaojing_files/<sessionId>/<name>",
            }))
        }
    };
    let workspace = store
        .list_workspaces()
        .unwrap_or_default()
        .into_iter()
        .find(|workspace| workspace.id == request.workspace_id);
    let Some(workspace) = workspace else {
        return Json(serde_json::json!({
            "ok": false,
            "code": "invalid_workspace",
            "error": "Brand workspace does not exist",
        }));
    };
    match crate::workspace_files::path_safety::read_workspace_file_no_follow(
        std::path::Path::new(&workspace.root_path),
        &relative_path,
        READ_SESSION_FILE_MAX_BYTES,
    ) {
        Ok((_canonical, bytes)) => {
            let content = String::from_utf8_lossy(&bytes);
            let (window, offset, total_chars, truncated) = session_file_read_window(
                &content,
                request.payload.offset_chars.unwrap_or(0),
                request.payload.max_chars.unwrap_or(10_000),
            );
            Json(serde_json::json!({
                "ok": true,
                "content": window,
                "offsetChars": offset,
                "totalChars": total_chars,
                "truncated": truncated,
            }))
        }
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "code": "session_file_read_failed",
            "error": error,
        })),
    }
}

async fn brand_knowledge_current_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandKnowledgeCurrentPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.knowledge_current(
        &request.workspace_id,
        &request.session_id,
        &request.payload.fact_key,
    ) {
        Ok(current) => Json(serde_json::json!({ "ok": true, "current": current })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_knowledge_candidate_submit_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::KnowledgeCandidateSubmission>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Knowledge payload identity must match its authenticated envelope",
        }));
    }
    match store.submit_knowledge_candidate(request.payload) {
        Ok(candidate) => Json(serde_json::json!({ "ok": true, "candidate": candidate })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_knowledge_candidate_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandKnowledgeCandidatePayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.knowledge_candidate(
        &request.workspace_id,
        &request.session_id,
        &request.payload.candidate_id,
    ) {
        Ok(candidate) => Json(serde_json::json!({ "ok": true, "candidate": candidate })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_knowledge_candidate_decide_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::KnowledgeDecisionRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Knowledge decision identity must match its authenticated envelope",
        }));
    }
    match store.decide_knowledge_candidate(request.payload) {
        Ok(result) => Json(serde_json::json!({ "ok": true, "result": result })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

/// 聊天修订（ADR 0003）：Sidecar 经通用闸门修订工具转发用户显式改/删/增
/// 指令，只作用于本 Session 的未决候选；信封身份校验与 decide 同构。
async fn brand_knowledge_candidate_revise_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::KnowledgeRevisionRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Knowledge revision identity must match its authenticated envelope",
        }));
    }
    if let Some(submission) = request.payload.submission.as_ref() {
        if submission.workspace_id != request.workspace_id
            || submission.session_id != request.session_id
        {
            return Json(serde_json::json!({
                "ok": false,
                "code": "identity_mismatch",
                "error": "Knowledge revision submission identity must match its authenticated envelope",
            }));
        }
    }
    match store.revise_knowledge_candidate(request.payload) {
        Ok(candidate) => Json(serde_json::json!({ "ok": true, "candidate": candidate })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_operation_create_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoOperationCreateRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "GeoOperation payload identity must match its authenticated envelope",
        }));
    }
    match store.create_geo_operation(request.payload) {
        Ok(operation) => {
            crate::notification::submit_geo_operation_projection(&operation);
            Json(serde_json::json!({ "ok": true, "operation": operation }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_operation_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoOperationGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_geo_operation(&request.workspace_id, &request.payload.operation_id) {
        Ok(operation) if operation.session_id == request.session_id => {
            Json(serde_json::json!({ "ok": true, "operation": operation }))
        }
        Ok(_) => Json(serde_json::json!({
            "ok": false,
            "error": "geo_operation_session_mismatch",
        })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_operation_list_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoOperationListRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.list_geo_operations(&request.workspace_id, &request.session_id, request.payload) {
        Ok(operations) => Json(serde_json::json!({ "ok": true, "operations": operations })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_operation_mutate_handler(
    headers: HeaderMap,
    Json(mut request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::GeoOperationMutationRequest>,
    >,
) -> Json<serde_json::Value> {
    if request.payload.action == "attest-external-gate" {
        return Json(serde_json::json!({
            "ok": false,
            "code": "ui_authority_required",
            "error": "External GEO gates require verified PublishScheduler or PostPublishMonitor UI evidence",
        }));
    }
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let sidecar_generation = match request_sidecar_generation(&headers) {
        Ok(generation) => generation,
        Err(error) => return error,
    };
    // The immutable process header is the only generation authority. Never
    // trust a JSON field supplied by Node or Renderer for this fence.
    request.payload.sidecar_generation = Some(sidecar_generation);
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "GeoOperation mutation identity must match its authenticated envelope",
        }));
    }
    match store.mutate_geo_operation(request.payload) {
        Ok(operation) => {
            crate::notification::submit_geo_operation_projection(&operation);
            Json(serde_json::json!({ "ok": true, "operation": operation }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn geo_provider_permit_acquire_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<GeoProviderPermitAcquirePayload>>,
) -> Json<serde_json::Value> {
    let caller = match geo_provider_caller(&headers, &request) {
        Ok(caller) => caller,
        Err(error) => return Json(error),
    };
    let limiter = crate::geo_provider_runtime::global_geo_provider_limiter();
    if let Err(error) =
        limiter.set_limit(crate::geo_provider_runtime::configured_geo_provider_concurrency())
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "geo_provider_limiter_unavailable",
            "error": error,
        }));
    }
    match limiter.acquire(
        request.payload.request_id,
        caller,
        request.payload.slot,
        request.payload.unit_kind,
        request.payload.unit_id,
    ) {
        Ok(permit) => {
            emit_geo_provider_queue_projection(&request.workspace_id, &request.session_id, &permit);
            Json(serde_json::json!({ "ok": true, "permit": permit }))
        }
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "code": if error == "geo_provider_queue_capacity_exhausted" {
                "resource_exhausted"
            } else {
                "geo_provider_permit_rejected"
            },
            "error": error,
        })),
    }
}

async fn geo_provider_permit_status_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<GeoProviderPermitStatusPayload>>,
) -> Json<serde_json::Value> {
    let caller = match geo_provider_caller(&headers, &request) {
        Ok(caller) => caller,
        Err(error) => return Json(error),
    };
    match crate::geo_provider_runtime::global_geo_provider_limiter()
        .status(&request.payload.request_id, &caller)
    {
        Ok(permit) => {
            emit_geo_provider_queue_projection(&request.workspace_id, &request.session_id, &permit);
            Json(serde_json::json!({ "ok": true, "permit": permit }))
        }
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "code": "geo_provider_permit_not_found",
            "error": error,
        })),
    }
}

async fn geo_provider_permit_release_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<GeoProviderPermitReleasePayload>>,
) -> Json<serde_json::Value> {
    let caller = match geo_provider_caller(&headers, &request) {
        Ok(caller) => caller,
        Err(error) => return Json(error),
    };
    match crate::geo_provider_runtime::global_geo_provider_limiter()
        .release(&request.payload.permit_token, &caller)
    {
        Ok(released) => Json(serde_json::json!({ "ok": true, "released": released })),
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "code": "geo_provider_permit_release_rejected",
            "error": error,
        })),
    }
}

async fn geo_provider_permit_cancel_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<GeoProviderPermitStatusPayload>>,
) -> Json<serde_json::Value> {
    let caller = match geo_provider_caller(&headers, &request) {
        Ok(caller) => caller,
        Err(error) => return Json(error),
    };
    match crate::geo_provider_runtime::global_geo_provider_limiter()
        .cancel(&request.payload.request_id, &caller)
    {
        Ok(cancelled) => Json(serde_json::json!({ "ok": true, "cancelled": cancelled })),
        Err(error) => Json(serde_json::json!({
            "ok": false,
            "code": "geo_provider_permit_cancel_rejected",
            "error": error,
        })),
    }
}

fn emit_geo_provider_queue_projection(
    workspace_id: &str,
    session_id: &str,
    permit: &crate::geo_provider_runtime::GeoProviderPermitProjection,
) {
    let Some(app_handle) = crate::logger::get_app_handle() else {
        return;
    };
    if let Err(error) = app_handle.emit(
        "geo-provider-queue-updated",
        serde_json::json!({
            "workspaceId": workspace_id,
            "sessionId": session_id,
            "permit": permit,
        }),
    ) {
        ulog_warn!("[geo-provider] queue projection emit failed: {}", error);
    }
}

async fn brand_material_context_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<serde_json::Value>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.material_context(&request.workspace_id, &request.session_id) {
        Ok(context) => Json(serde_json::json!({ "ok": true, "context": context })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_material_import_file_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ImportBrandFileRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Material payload identity must match its authenticated envelope",
        }));
    }
    match store.import_brand_file(request.payload) {
        Ok(material) => Json(serde_json::json!({ "ok": true, "material": material })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_material_import_text_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ImportBrandTextRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Material payload identity must match its authenticated envelope",
        }));
    }
    match store.import_brand_text(request.payload) {
        Ok(material) => Json(serde_json::json!({ "ok": true, "material": material })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_material_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandMaterialPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.brand_material(
        &request.workspace_id,
        &request.session_id,
        &request.payload.material_id,
    ) {
        Ok(material) => Json(serde_json::json!({ "ok": true, "material": material })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

// 删除材料本体（行 + 文件 + 未决候选）；已被采纳的候选与确认知识不动。
async fn brand_material_delete_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandMaterialPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.delete_brand_material(
        &request.workspace_id,
        &request.session_id,
        &request.payload.material_id,
    ) {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

// Sidecar 状态轮询/会话恢复入口：返回本 Session 材料与最近一次 attempt 的
// 候选 ID；材料正文与本地路径不出现在响应里。
async fn brand_material_list_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandMaterialListPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.list_session_materials(
        &request.workspace_id,
        &request.session_id,
        request.payload.material_ids.as_deref(),
        request.payload.limit.unwrap_or(10),
    ) {
        Ok(materials) => Json(serde_json::json!({ "ok": true, "materials": materials })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

// Internal Node→Rust material data plane. The request is a small authenticated
// control envelope; Rust performs the only filesystem read and streams bounded
// app-owned bytes back to the GEO parser. No local path crosses the response.
async fn brand_material_content_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandMaterialPayload>>,
) -> Response {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return (StatusCode::FORBIDDEN, Json(error)).into_response(),
    };
    match store.read_brand_material_bytes(
        &request.workspace_id,
        &request.session_id,
        &request.payload.material_id,
    ) {
        Ok((material, bytes)) => {
            let mut response_headers = HeaderMap::new();
            response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            if let Ok(value) = HeaderValue::from_str(&material.media_type) {
                response_headers.insert(CONTENT_TYPE, value);
            }
            (response_headers, Body::from(bytes)).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

async fn brand_material_processing_start_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<BrandMaterialPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.begin_material_processing(
        &request.workspace_id,
        &request.session_id,
        &request.payload.material_id,
    ) {
        Ok(attempt) => Json(serde_json::json!({ "ok": true, "attempt": attempt })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_material_processing_finish_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::MaterialProcessingFinish>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.finish_material_processing(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(material) => Json(serde_json::json!({ "ok": true, "material": material })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

// 材料图片候选池（ADR-0008 T2）：入池写入 / 候选清单 / 内容取回三条
// Session 作用域端点，鉴权与既有材料端点同款（sidecar 代 + 品牌会话）。
async fn brand_material_image_save_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::MaterialImageSave>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.save_material_image(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(image) => Json(serde_json::json!({ "ok": true, "image": image })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_material_image_list_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<MaterialImageListPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.list_material_images(
        &request.workspace_id,
        &request.session_id,
        request.payload.limit,
    ) {
        Ok(images) => Json(serde_json::json!({ "ok": true, "images": images })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_material_image_content_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<MaterialImageContentPayload>>,
) -> Response {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return (StatusCode::FORBIDDEN, Json(error)).into_response(),
    };
    match store.read_material_image_bytes(
        &request.workspace_id,
        &request.session_id,
        &request.payload.image_id,
    ) {
        Ok((image, bytes)) => {
            let mut response_headers = HeaderMap::new();
            response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            if let Ok(value) = HeaderValue::from_str(&image.media_type) {
                response_headers.insert(CONTENT_TYPE, value);
            }
            (response_headers, Body::from(bytes)).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

// 存量重扫候选清单（ADR-0008 T7）：workspace 全部 docx/pptx 材料（不限
// 导入 Session），供 Sidecar 对存量旧材料手动重扫内嵌图片。只读投影。
async fn brand_material_document_list_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<MaterialDocumentListPayload>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.list_workspace_document_materials(
        &request.workspace_id,
        &request.session_id,
        request.payload.limit.unwrap_or(100),
    ) {
        Ok(materials) => Json(serde_json::json!({ "ok": true, "materials": materials })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_prepare_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolPrepareRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Question pool payload identity must match its authenticated envelope",
        }));
    }
    match store.prepare_question_pool(request.payload) {
        Ok(preparation) => Json(serde_json::json!({ "ok": true, "preparation": preparation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_latest_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolLatestRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.latest_valid_question_pool(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(pool) => Json(serde_json::json!({ "ok": true, "pool": pool })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_step_claim_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolStepClaimRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.claim_question_pool_step(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(claim) => Json(serde_json::json!({ "ok": true, "claim": claim })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_step_finish_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolStepFinishRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.finish_question_pool_step(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(checkpoint) => Json(serde_json::json!({ "ok": true, "checkpoint": checkpoint })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_persist_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolPersistRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.persist_question_pool(&request.workspace_id, &request.session_id, request.payload) {
        Ok(pool) => Json(serde_json::json!({ "ok": true, "pool": pool })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_cancel_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolCancelRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.cancel_question_pool_attempt(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(pool) => Json(serde_json::json!({ "ok": true, "pool": pool })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_question_pool_decide_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolDecisionRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Question pool decision identity must match its authenticated envelope",
        }));
    }
    match store.decide_question_pool(request.payload) {
        Ok(result) => Json(serde_json::json!({ "ok": true, "result": result })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

/// 聊天修订（ADR 0003，票 38）：问题池闸门的待决词库/候选问题改删增；
/// 信封身份校验与 decide 同构，只作用于本 Session 的 awaiting-selection 池。
async fn brand_question_pool_revise_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::QuestionPoolRevisionRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "Question pool revision identity must match its authenticated envelope",
        }));
    }
    match store.revise_question_pool(request.payload) {
        Ok(pool) => Json(serde_json::json!({ "ok": true, "pool": pool })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_topic_plan_latest_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::TopicPlanLatestRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.latest_topic_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_topic_plan_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::TopicPlanGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_topic_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_topic_plan_prepare_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::TopicPlanPrepareRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.prepare_topic_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(preparation) => Json(serde_json::json!({ "ok": true, "preparation": preparation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_topic_plan_create_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::TopicPlanCreateRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.create_topic_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_topic_plan_mutate_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::TopicPlanMutationRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.mutate_topic_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(result) => Json(serde_json::json!({ "ok": true, "result": result })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_topic_plan_confirm_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::TopicPlanConfirmRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.confirm_topic_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(result) => Json(serde_json::json!({ "ok": true, "result": result })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_latest_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleLatestRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.latest_article_operation(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(operation) => Json(serde_json::json!({ "ok": true, "operation": operation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_operation_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleOperationGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_article_operation(&request.workspace_id, &request.session_id, request.payload) {
        Ok(operation) => Json(serde_json::json!({ "ok": true, "operation": operation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_start_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::ArticleOperationStartRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.start_article_operation(&request.workspace_id, &request.session_id, request.payload)
    {
        Ok(operation) => Json(serde_json::json!({ "ok": true, "operation": operation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_article(&request.workspace_id, &request.session_id, request.payload) {
        Ok(article) => Json(serde_json::json!({ "ok": true, "article": article })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_generation_claim_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::ArticleGenerationClaimRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.claim_article_generation(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(context) => Json(serde_json::json!({ "ok": true, "context": context })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_generation_finish_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::ArticleGenerationFinishRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let operation_id = request.payload.operation_id.clone();
    match store.finish_article_generation(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(article) => {
            submit_article_batch_completion_if_terminal(
                &store,
                &request.workspace_id,
                &request.session_id,
                &operation_id,
            );
            Json(serde_json::json!({ "ok": true, "article": article }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_generation_fail_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::ArticleGenerationFailRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let operation_id = request.payload.operation_id.clone();
    match store.fail_article_generation(&request.workspace_id, &request.session_id, request.payload)
    {
        Ok(article) => {
            submit_article_batch_completion_if_terminal(
                &store,
                &request.workspace_id,
                &request.session_id,
                &operation_id,
            );
            Json(serde_json::json!({ "ok": true, "article": article }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_edit_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleEditRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.edit_article(&request.workspace_id, &request.session_id, request.payload) {
        Ok(article) => Json(serde_json::json!({ "ok": true, "article": article })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_body_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleBodyRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.read_article_body(&request.workspace_id, &request.session_id, request.payload) {
        Ok(body) => Json(serde_json::json!({ "ok": true, "body": body })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_review_claim_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleReviewClaimRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.claim_article_review(&request.workspace_id, &request.session_id, request.payload) {
        Ok((context, body)) => {
            Json(serde_json::json!({ "ok": true, "context": context, "body": body }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_article_review_finish_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleReviewFinishRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let operation_id = request.payload.operation_id.clone();
    match store.finish_article_review(&request.workspace_id, &request.session_id, request.payload) {
        Ok(article) => {
            submit_article_batch_completion_if_terminal(
                &store,
                &request.workspace_id,
                &request.session_id,
                &operation_id,
            );
            Json(serde_json::json!({ "ok": true, "article": article }))
        }
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

/// 审核失败遥测（ADR-0009 Decision 7）：聚合本工作区历次审核的
/// 通过率与按规则的问题计数，供规则调优决策取数。
async fn brand_article_review_stats_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::ArticleReviewStatsRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.article_review_stats(&request.workspace_id, &request.session_id, request.payload) {
        Ok(stats) => Json(serde_json::json!({ "ok": true, "stats": stats })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

fn submit_article_batch_completion_if_terminal(
    store: &crate::brand_workspace::BrandWorkspaceStore,
    workspace_id: &str,
    session_id: &str,
    operation_id: &str,
) {
    let Ok(operation) = store.get_article_operation(
        workspace_id,
        session_id,
        crate::brand_workspace::ArticleOperationGetRequest {
            operation_id: operation_id.to_string(),
        },
    ) else {
        return;
    };
    if matches!(
        operation.status.as_str(),
        "completed" | "completed-with-failures"
    ) {
        let revision = operation
            .articles
            .iter()
            .map(|article| article.revision)
            .max()
            .unwrap_or(0);
        crate::notification::submit_article_batch_completion(
            workspace_id,
            session_id,
            operation_id,
            revision,
        );
    }
}

async fn brand_distribution_plan_context_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanningContextRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.distribution_planning_context(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(context) => Json(serde_json::json!({ "ok": true, "context": context })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_distribution_plan_latest_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanLatestRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.latest_distribution_plan(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_channel_preferences_get_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::ChannelPreferencesGetRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_channel_preferences(&request.workspace_id, &request.session_id, request.payload)
    {
        Ok(preferences) => Json(serde_json::json!({ "ok": true, "preferences": preferences })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_channel_preferences_set_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::ChannelPreferencesSetRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.set_channel_preferences(&request.workspace_id, &request.session_id, request.payload)
    {
        Ok(preferences) => Json(serde_json::json!({ "ok": true, "preferences": preferences })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_distribution_plan_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_distribution_plan(&request.workspace_id, &request.session_id, request.payload) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_distribution_plan_prepare_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanPrepareRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.prepare_distribution_plan(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(preparation) => Json(serde_json::json!({ "ok": true, "preparation": preparation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_distribution_plan_discovery_finish_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanDiscoveryFinishRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.finish_distribution_plan_discovery(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_distribution_plan_edit_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanEditRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.edit_distribution_plan(&request.workspace_id, &request.session_id, request.payload)
    {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_distribution_plan_confirm_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::DistributionPlanConfirmRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.confirm_distribution_plan(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(plan) => Json(serde_json::json!({ "ok": true, "plan": plan })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_publish_latest_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<Value>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.latest_publish_execution(&request.workspace_id, &request.session_id) {
        Ok(execution) => Json(serde_json::json!({ "ok": true, "execution": execution })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_publish_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<Value>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    let Some(execution_id) = request.payload.get("executionId").and_then(Value::as_str) else {
        return Json(serde_json::json!({ "ok": false, "error": "publish_execution_id_invalid" }));
    };
    match store.get_publish_execution(&request.workspace_id, &request.session_id, execution_id) {
        Ok(execution) => Json(serde_json::json!({ "ok": true, "execution": execution })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_publish_preview_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::PublishPreviewRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.prepare_publish_execution(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(execution) => Json(serde_json::json!({ "ok": true, "execution": execution })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

/// 聊天修订（ADR 0003，票 38）：发布准备闸门的待决内容（预算/开始时间/
/// 逐项排期）。确认、开始与重试仍 exclusively 走 Rust UI 权威入口，本路由
/// 只重算摘要并审计，不触碰不可逆动作。
async fn brand_publish_scheduler_revise_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::PublishRevisionRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.revise_publish_execution(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(execution) => Json(serde_json::json!({ "ok": true, "execution": execution })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_baseline_latest_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoBaselineLatestRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.latest_geo_baseline(&request.workspace_id, &request.session_id, request.payload) {
        Ok(baseline) => Json(serde_json::json!({ "ok": true, "baseline": baseline })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_baseline_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoBaselineGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_geo_baseline(&request.workspace_id, &request.session_id, request.payload) {
        Ok(baseline) => Json(serde_json::json!({ "ok": true, "baseline": baseline })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_baseline_prepare_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoBaselinePrepareRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    if request.payload.workspace_id != request.workspace_id
        || request.payload.session_id != request.session_id
    {
        return Json(serde_json::json!({
            "ok": false,
            "code": "identity_mismatch",
            "error": "GEO baseline payload identity must match its authenticated envelope",
        }));
    }
    match store.prepare_geo_baseline(request.payload) {
        Ok(preparation) => Json(serde_json::json!({ "ok": true, "preparation": preparation })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_baseline_unit_claim_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::GeoBaselineUnitClaimRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.claim_geo_baseline_unit(&request.workspace_id, &request.session_id, request.payload)
    {
        Ok(claim) => Json(serde_json::json!({ "ok": true, "claim": claim })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_baseline_unit_finish_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::GeoBaselineUnitFinishRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.finish_geo_baseline_unit(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(unit) => Json(serde_json::json!({ "ok": true, "unit": unit })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_dashboard_get_handler(
    headers: HeaderMap,
    Json(request): Json<BrandKnowledgeEnvelope<crate::brand_workspace::GeoDashboardGetRequest>>,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_geo_dashboard(&request.workspace_id, &request.session_id, request.payload) {
        Ok(dashboard) => Json(serde_json::json!({ "ok": true, "dashboard": dashboard })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

async fn brand_geo_dashboard_drilldown_handler(
    headers: HeaderMap,
    Json(request): Json<
        BrandKnowledgeEnvelope<crate::brand_workspace::GeoDashboardDrilldownRequest>,
    >,
) -> Json<serde_json::Value> {
    let store = match validate_brand_knowledge_request(&headers, &request) {
        Ok(store) => store,
        Err(error) => return Json(error),
    };
    match store.get_geo_dashboard_drilldown(
        &request.workspace_id,
        &request.session_id,
        request.payload,
    ) {
        Ok(drilldown) => Json(serde_json::json!({ "ok": true, "drilldown": drilldown })),
        Err(error) => Json(serde_json::json!({ "ok": false, "error": error })),
    }
}

#[cfg(test)]
mod session_file_tests {
    use super::{session_file_read_window, validate_session_file_relative_path};

    #[test]
    fn session_file_path_accepts_only_three_segment_session_scope() {
        assert!(validate_session_file_relative_path("xiaojing_files/s1/notes.md", "s1").is_ok());
        assert!(validate_session_file_relative_path(" xiaojing_files/s1/notes.md ", "s1").is_ok());
        // 其他会话、目录逃逸、嵌套子路径全部拒绝；Windows 反斜杠形态归一化后放行。
        assert!(validate_session_file_relative_path("xiaojing_files/s2/x.md", "s1").is_err());
        assert!(validate_session_file_relative_path("xiaojing_files/s1/..", "s1").is_err());
        assert!(validate_session_file_relative_path("xiaojing_files/s1/a/b.md", "s1").is_err());
        assert!(validate_session_file_relative_path("materials/s1/a.md", "s1").is_err());
        assert!(validate_session_file_relative_path("../xiaojing_files/s1/a.md", "s1").is_err());
        assert_eq!(
            validate_session_file_relative_path("xiaojing_files\\s1\\a.md", "s1").as_deref(),
            Ok("xiaojing_files/s1/a.md")
        );
    }

    #[test]
    fn read_window_pages_on_char_boundaries_and_flags_truncation() {
        // 每遍 10 个字符（小鲸同学Geo工作台），共 30 个字符。
        let content = "小鲸同学Geo工作台".repeat(3);
        let (head, offset, total, truncated) = session_file_read_window(&content, 0, 5);
        assert_eq!(head, "小鲸同学G");
        assert_eq!(offset, 0);
        assert_eq!(total, 30);
        assert!(truncated);

        let (next, offset, _, truncated) = session_file_read_window(&content, 5, 5);
        assert_eq!(next, "eo工作台");
        assert_eq!(offset, 5);
        assert!(truncated);

        let (tail, _, _, truncated) = session_file_read_window(&content, 25, 5);
        assert_eq!(tail, "eo工作台");
        assert!(!truncated);

        // 越界 offset 归位到文件末尾，返回空窗口而非报错。
        let (beyond, offset, _, truncated) = session_file_read_window(&content, 9_999, 5);
        assert_eq!(beyond, "");
        assert_eq!(offset, content.chars().count());
        assert!(!truncated);
    }
}
