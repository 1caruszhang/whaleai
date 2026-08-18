use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_warn};

static UI_LANGUAGE_MIRROR_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SupportedLocale {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

impl SupportedLocale {
    pub fn as_str(self) -> &'static str {
        match self {
            SupportedLocale::ZhCn => "zh-CN",
            SupportedLocale::EnUs => "en-US",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UiLanguage {
    System,
    ZhCn,
    EnUs,
}

impl UiLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            UiLanguage::System => "system",
            UiLanguage::ZhCn => "zh-CN",
            UiLanguage::EnUs => "en-US",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLanguageChangedPayload {
    pub ui_language: String,
    pub locale: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialI18nConfig {
    ui_language: Option<String>,
}

pub fn normalize_ui_language(value: &str) -> UiLanguage {
    match value {
        "zh-CN" => UiLanguage::ZhCn,
        "en-US" => UiLanguage::EnUs,
        "system" => UiLanguage::System,
        _ => UiLanguage::System,
    }
}

fn resolve_supported_locale(locale: Option<&str>) -> SupportedLocale {
    let Some(value) = locale else {
        return SupportedLocale::EnUs;
    };
    let normalized = value.trim().replace('_', "-").to_lowercase();
    if normalized == "zh" || normalized.starts_with("zh-") {
        SupportedLocale::ZhCn
    } else {
        SupportedLocale::EnUs
    }
}

fn system_locale() -> Option<String> {
    sys_locale::get_locale().or_else(|| {
        std::env::var("LC_ALL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("LC_MESSAGES").ok().filter(|s| !s.is_empty()))
            .or_else(|| std::env::var("LANG").ok().filter(|s| !s.is_empty()))
    })
}

fn lock_language_mirrors() -> MutexGuard<'static, ()> {
    UI_LANGUAGE_MIRROR_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn effective_locale(ui_language: UiLanguage) -> SupportedLocale {
    match ui_language {
        UiLanguage::ZhCn => SupportedLocale::ZhCn,
        UiLanguage::EnUs => SupportedLocale::EnUs,
        UiLanguage::System => resolve_supported_locale(system_locale().as_deref()),
    }
}

fn read_ui_language_from(config_path: &std::path::Path) -> UiLanguage {
    let content = match std::fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return UiLanguage::System,
        Err(_) => return UiLanguage::ZhCn,
    };
    let cfg: PartialI18nConfig = match serde_json::from_str(strip_bom(&content)) {
        Ok(c) => c,
        Err(_) => return UiLanguage::ZhCn,
    };
    match cfg.ui_language {
        Some(value) => normalize_ui_language(&value),
        None => UiLanguage::ZhCn,
    }
}

pub fn current_ui_language() -> UiLanguage {
    if let Some(dir) = crate::app_dirs::xiaojing_data_dir() {
        let value = read_ui_language_from(&dir.join("config.json"));
        ulog_debug!("[i18n] disk: uiLanguage={}", value.as_str());
        return value;
    }
    UiLanguage::System
}

pub fn current_locale() -> SupportedLocale {
    effective_locale(current_ui_language())
}

/// 写盘缝：测试以临时目录驱动，不触碰真实用户数据目录。
fn persist_to_disk_in(dir: &std::path::Path, value: UiLanguage) -> Result<(), String> {
    let config_path = dir.join("config.json");
    crate::config_io::with_config_lock(&config_path, false, |cfg| {
        if !cfg.is_object() {
            *cfg = serde_json::json!({});
        }
        let obj = cfg
            .as_object_mut()
            .expect("just normalized to object above");
        obj.insert(
            "uiLanguage".to_string(),
            serde_json::Value::String(value.as_str().to_string()),
        );
        Ok(())
    })
    .map(|_| ())
}

pub fn t(key: &str, locale: SupportedLocale) -> &str {
    match (locale, key) {
        (SupportedLocale::ZhCn, "notification.sessionCompleteTitle") => "Xiaojing - 任务完成",
        (SupportedLocale::ZhCn, "notification.sessionCompleteBody") => "请您查看结果",
        (SupportedLocale::ZhCn, "notification.sessionStoppedTitle") => "Xiaojing - 任务已停止",
        (SupportedLocale::ZhCn, "notification.sessionStoppedBody") => "请您查看当前结果",
        (SupportedLocale::ZhCn, "notification.sessionErrorTitle") => "Xiaojing - 任务失败",
        (SupportedLocale::ZhCn, "notification.sessionErrorBody") => "请您查看错误详情",
        (SupportedLocale::ZhCn, "notification.geoAwaitingConfirmationTitle") => {
            "小鲸同学 - 等待确认"
        }
        (SupportedLocale::ZhCn, "notification.geoAwaitingConfirmationBody") => {
            "一个 GEO 操作正在等待您的结构化确认。"
        }
        (SupportedLocale::ZhCn, "notification.geoOperationFailedTitle") => {
            "小鲸同学 - GEO 操作失败"
        }
        (SupportedLocale::ZhCn, "notification.geoOperationFailedBody") => {
            "一个 GEO 操作需要您查看失败状态。"
        }
        (SupportedLocale::ZhCn, "notification.geoBatchCompletedTitle") => "小鲸同学 - 批次已完成",
        (SupportedLocale::ZhCn, "notification.geoBatchCompletedBody") => {
            "一批 GEO 内容已完成处理，可打开工作台查看。"
        }
        (SupportedLocale::ZhCn, "notification.geoPublishFailedTitle") => "小鲸同学 - 发布失败",
        (SupportedLocale::ZhCn, "notification.geoPublishFailedBody") => {
            "一个确定性发布执行需要人工查看。"
        }
        (SupportedLocale::ZhCn, "notification.geoMonitoringCompletedTitle") => {
            "小鲸同学 - 监测完成"
        }
        (SupportedLocale::ZhCn, "notification.geoMonitoringCompletedBody") => {
            "一项发布后监测已完成，可打开工作台查看证据。"
        }
        (SupportedLocale::EnUs, "notification.sessionCompleteTitle") => "Xiaojing - Task complete",
        (SupportedLocale::EnUs, "notification.sessionCompleteBody") => "Please review the result",
        (SupportedLocale::EnUs, "notification.sessionStoppedTitle") => "Xiaojing - Task stopped",
        (SupportedLocale::EnUs, "notification.sessionStoppedBody") => {
            "Please review the current result"
        }
        (SupportedLocale::EnUs, "notification.sessionErrorTitle") => "Xiaojing - Task failed",
        (SupportedLocale::EnUs, "notification.sessionErrorBody") => {
            "Please review the error details"
        }
        (SupportedLocale::EnUs, "notification.geoAwaitingConfirmationTitle") => {
            "Xiaojing - Confirmation needed"
        }
        (SupportedLocale::EnUs, "notification.geoAwaitingConfirmationBody") => {
            "A GEO operation is waiting for structured confirmation."
        }
        (SupportedLocale::EnUs, "notification.geoOperationFailedTitle") => {
            "Xiaojing - GEO operation failed"
        }
        (SupportedLocale::EnUs, "notification.geoOperationFailedBody") => {
            "A GEO operation needs you to review its failure state."
        }
        (SupportedLocale::EnUs, "notification.geoBatchCompletedTitle") => {
            "Xiaojing - Batch completed"
        }
        (SupportedLocale::EnUs, "notification.geoBatchCompletedBody") => {
            "A GEO content batch finished. Open the workbench to review it."
        }
        (SupportedLocale::EnUs, "notification.geoPublishFailedTitle") => {
            "Xiaojing - Publishing failed"
        }
        (SupportedLocale::EnUs, "notification.geoPublishFailedBody") => {
            "A deterministic publishing execution needs manual review."
        }
        (SupportedLocale::EnUs, "notification.geoMonitoringCompletedTitle") => {
            "Xiaojing - Monitoring completed"
        }
        (SupportedLocale::EnUs, "notification.geoMonitoringCompletedBody") => {
            "A post-publish monitoring plan finished. Open the workbench for evidence."
        }
        _ => key,
    }
}

pub fn ui_language_payload(value: UiLanguage) -> UiLanguageChangedPayload {
    let locale = effective_locale(value);
    UiLanguageChangedPayload {
        ui_language: value.as_str().to_string(),
        locale: locale.as_str().to_string(),
    }
}

pub fn apply_ui_language(
    app: &AppHandle,
    value: UiLanguage,
) -> Result<UiLanguageChangedPayload, String> {
    let dir = crate::app_dirs::xiaojing_data_dir()
        .ok_or_else(|| "[i18n] cannot resolve data dir".to_string())?;
    apply_ui_language_in(&dir, app, value)
}

/// 广播缝：写盘 + emit 的组合路径，测试以临时目录与 mock runtime 驱动（GD-6③）。
fn apply_ui_language_in<R: tauri::Runtime>(
    dir: &std::path::Path,
    app: &tauri::AppHandle<R>,
    value: UiLanguage,
) -> Result<UiLanguageChangedPayload, String> {
    let _guard = lock_language_mirrors();
    persist_to_disk_in(dir, value)?;
    let payload = ui_language_payload(value);
    if let Err(e) = app.emit("ui-language-changed", &payload) {
        ulog_warn!("[i18n] emit failed: {e}");
    }
    Ok(payload)
}

pub fn sync_ui_language_from_config(app: &AppHandle) -> UiLanguageChangedPayload {
    let _guard = lock_language_mirrors();
    let value = current_ui_language();
    let payload = ui_language_payload(value);
    if let Err(e) = app.emit("ui-language-changed", &payload) {
        ulog_warn!("[i18n] emit failed: {e}");
    }
    payload
}

#[tauri::command]
pub async fn cmd_get_ui_language_state() -> Result<UiLanguageChangedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || ui_language_payload(current_ui_language()))
        .await
        .map_err(|e| format!("[i18n] state task join: {e}"))
}

#[tauri::command]
pub async fn cmd_sync_ui_language_from_config(
    app: AppHandle,
) -> Result<UiLanguageChangedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || sync_ui_language_from_config(&app))
        .await
        .map_err(|e| format!("[i18n] sync task join: {e}"))
}

#[tauri::command]
pub async fn cmd_set_ui_language(
    app: AppHandle,
    value: String,
) -> Result<UiLanguageChangedPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ui_language = normalize_ui_language(&value);
        apply_ui_language(&app, ui_language)
    })
    .await
    .map_err(|e| format!("[i18n] task join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_ui_language_values() {
        assert_eq!(normalize_ui_language("zh-CN"), UiLanguage::ZhCn);
        assert_eq!(normalize_ui_language("en-US"), UiLanguage::EnUs);
        assert_eq!(normalize_ui_language("system"), UiLanguage::System);
        assert_eq!(normalize_ui_language("fr-FR"), UiLanguage::System);
    }

    #[test]
    fn resolves_effective_locale_from_system_locale() {
        assert_eq!(
            resolve_supported_locale(Some("zh_CN.UTF-8")),
            SupportedLocale::ZhCn
        );
        assert_eq!(
            resolve_supported_locale(Some("en_GB.UTF-8")),
            SupportedLocale::EnUs
        );
        assert_eq!(resolve_supported_locale(None), SupportedLocale::EnUs);
    }

    #[test]
    fn translates_native_session_completion_notifications() {
        assert_eq!(
            t("notification.sessionCompleteTitle", SupportedLocale::ZhCn),
            "Xiaojing - 任务完成"
        );
        assert_eq!(
            t("notification.sessionErrorBody", SupportedLocale::EnUs),
            "Please review the error details"
        );
    }

    // GD-6③：apply_ui_language 的写盘 + 广播组合路径，用临时目录与 mock
    // AppHandle 驱动，不触碰真实用户数据目录。
    #[test]
    fn apply_ui_language_persists_under_config_lock_and_emits_payload() {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().unwrap();
        let payload = apply_ui_language_in(dir.path(), app.handle(), UiLanguage::EnUs).unwrap();
        assert_eq!(payload.ui_language, "en-US");
        assert_eq!(payload.locale, "en-US");
        // 写盘可回读：经同一 normalize 管道还原为已设语言。
        assert_eq!(
            read_ui_language_from(&dir.path().join("config.json")),
            UiLanguage::EnUs
        );
        // 既有配置字段保留，不整文件覆写。
        let raw = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        let cfg: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(cfg["uiLanguage"], serde_json::json!("en-US"));
    }

    #[test]
    fn apply_ui_language_write_failure_returns_before_emit() {
        // 用一个文件充当 config 目录 → with_config_lock 无法创建锁文件，
        // 写盘失败必须先于广播返回错误。
        let app = tauri::test::mock_app();
        let blocker = tempfile::tempdir().unwrap();
        let file = blocker.path().join("not-a-dir");
        std::fs::write(&file, b"occupied").unwrap();
        let error = apply_ui_language_in(&file, app.handle(), UiLanguage::ZhCn)
            .unwrap_err();
        assert!(error.contains("[i18n]") || error.contains("config"), "{error}");
    }
}
