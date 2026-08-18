// OS notification with reliable click-to-foreground + navigation deep-link.
//
// Architectural rationale (see CLAUDE.md "结构保证优于流程约束"):
//
// `tauri-plugin-notification` on desktop is fire-and-forget — its JS shim
// replaces `window.Notification` with a pure invoke proxy that returns no
// handle, and its desktop backend (`notify-rust`) doesn't surface any click
// callback. Relying on `window.onFocusChanged` to detect "user clicked toast"
// works on macOS by accident (OS auto-activates the app) but silently fails
// on Windows — toast clicks go through WinRT's in-process Activated event,
// not a fresh process spawn, so single-instance and focus-changed handlers
// never fire.
//
// This module owns the OS notification surface end-to-end with **two
// platform-exclusive paths** that don't share state:
//
//   ┌──────────────┬─────────────────────────────────────────────────────┐
//   │ Windows      │ `tauri-winrt-notification::Toast::on_activated`     │
//   │              │ closure captures the navigation target directly. No │
//   │              │ global queue, no focus-edge consumption. The click  │
//   │              │ handler is in-process and deterministic.            │
//   ├──────────────┼─────────────────────────────────────────────────────┤
//   │ macOS/Linux  │ Three-state global latch                            │
//   │              │ (Empty/Single/Ambiguous). `Single` is consumed when │
//   │              │ the front-end signals window-activation; `Ambiguous`│
//   │              │ (≥2 unconsumed notifications stacked up) raises the │
//   │              │ window but **refuses to deep-link** — wrong-tab     │
//   │              │ navigation is a worse UX than no-deep-link.         │
//   └──────────────┴─────────────────────────────────────────────────────┘
//
// What this REPLACES:
//   - `pendingNavigation` Map + 2-second time window in
//     `notificationService.ts` (fragile; could miss clicks past the window).
//   - renderer-local visibility flags (broke when the window lost focus
//     without being hidden).
//   - `notification:show` Tauri event hop (Rust → JS → plugin-notification);
//     now Rust calls plugin-notification directly via builder API.
//
// Why mutually exclusive paths matter (review-time finding): an earlier
// draft populated the global latch on Windows too "as a fallback". That
// caused a double-emit bug — the WinRT closure emitted `notification:click`
// directly, then `onFocusChanged(true)` invoked `cmd_consume_notification_click`
// which drained the same entry and emitted a *second* identical event. The
// strict cfg-split below makes the bug structurally unrepresentable.

use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, Mutex, OnceLock};
#[cfg(not(target_os = "windows"))]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
// `NotificationExt` powers `show_via_plugin` (the macOS / Linux toast
// path). Windows goes through `tauri_winrt_notification::Toast` directly.
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;

use crate::brand_workspace::{
    GeoNotificationArtifactLocator, GeoNotificationCard, GeoNotificationCategory,
    GeoNotificationEvent, GeoNotificationLocator, GeoNotificationResolution,
};
use crate::notification_badge::NotificationBadgeIncrement;
#[cfg(target_os = "windows")]
use crate::ulog_error;
use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_info, ulog_warn};

/// How long an unconsumed deep-link target stays valid on macOS / Linux.
///
/// Only relevant for the non-Windows fallback path. Windows consumes
/// synchronously inside the WinRT `on_activated` callback, so this constant
/// is unused there.
///
/// 30 seconds bounds "user notices toast → finishes current task → clicks"
/// without letting truly stale entries linger.
#[cfg(not(target_os = "windows"))]
const PENDING_CLICK_TTL: Duration = Duration::from_secs(30);

#[cfg(not(target_os = "windows"))]
struct PendingClick {
    navigation: NotificationNavigation,
    queued_at: Instant,
}

/// Three-state latch for the macOS/Linux fallback path.
///
/// `Ambiguous` is the load-bearing piece: when two notifications stack up
/// without an intervening focus-regain, we can't tell *which* one the user
/// clicked, so we refuse to deep-link. The user still gets the window raised
/// (`notification:click` is simply not emitted), which is the no-data-loss
/// degradation.
#[cfg(not(target_os = "windows"))]
enum PendingState {
    Empty,
    Single(Box<PendingClick>),
    /// Two-or-more notifications stacked unconsumed. Tracked timestamp is
    /// the *earliest* queue entry's `queued_at` so TTL still expires the
    /// state.
    Ambiguous {
        queued_at: Instant,
    },
}

#[cfg(not(target_os = "windows"))]
static PENDING_CLICK: Mutex<PendingState> = Mutex::new(PendingState::Empty);

/// AppHandle used by Rust-owned background GEO executors which do not have a
/// Renderer or Tauri command frame. This does not own business state; it only
/// reaches the existing notification surface and Tauri event bus.
static NOTIFICATION_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

const GEO_DELIVERY_DEDUPE_LIMIT: usize = 2_048;

#[derive(Default)]
struct GeoDeliveryDedupe {
    ids: HashSet<String>,
    order: VecDeque<String>,
}

static GEO_DELIVERY_DEDUPE: LazyLock<Mutex<GeoDeliveryDedupe>> =
    LazyLock::new(|| Mutex::new(GeoDeliveryDedupe::default()));

/// The WebView listener is not installed during native cold start. Keep at
/// most one exact click until Renderer acknowledges readiness. Repeated clicks
/// with the same stable notification id remain one click; two different clicks
/// are ambiguous and deliberately do not deep-link.
#[derive(Default)]
struct RendererClickIngress {
    ready: bool,
    pending: Option<NotificationClickPayload>,
    ambiguous: bool,
    handled_notification_ids: HashSet<String>,
    handled_notification_order: VecDeque<String>,
}

static RENDERER_CLICK_INGRESS: LazyLock<Mutex<RendererClickIngress>> =
    LazyLock::new(|| Mutex::new(RendererClickIngress::default()));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationNavigation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geo_locator: Option<GeoNotificationLocator>,
}

impl NotificationNavigation {
    pub fn new(
        tab_id: Option<String>,
        session_id: Option<String>,
        workspace_path: Option<String>,
    ) -> Option<Self> {
        let navigation = Self {
            notification_id: None,
            tab_id: clean_optional_string(tab_id),
            session_id: clean_optional_string(session_id),
            workspace_path: clean_optional_string(workspace_path),
            geo_locator: None,
        };
        if navigation.tab_id.is_none()
            && (navigation.session_id.is_none() || navigation.workspace_path.is_none())
        {
            None
        } else {
            Some(navigation)
        }
    }

    pub fn from_tab_id(tab_id: Option<String>) -> Option<Self> {
        Self::new(tab_id, None, None)
    }

    pub fn for_session(
        tab_id: Option<String>,
        session_id: String,
        workspace_path: String,
    ) -> Option<Self> {
        Self::new(tab_id, Some(session_id), Some(workspace_path))
    }

    pub fn for_geo(event: &GeoNotificationEvent) -> Self {
        Self {
            notification_id: Some(event.delivery_id()),
            tab_id: None,
            session_id: Some(event.locator.session_id.clone()),
            workspace_path: None,
            geo_locator: Some(event.locator.clone()),
        }
    }

    fn describe(&self) -> String {
        if let Some(locator) = self.geo_locator.as_ref() {
            return format!(
                "geo workspace_id={} session_id={} operation_id={} card={:?} artifact_kind={}",
                locator.workspace_id,
                locator.session_id,
                locator.operation_id,
                locator.card,
                locator.artifact.kind,
            );
        }
        format!("tab_id={:?} session_id={:?}", self.tab_id, self.session_id)
    }
}

fn clean_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClickPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geo_locator: Option<GeoNotificationLocator>,
}

impl From<NotificationNavigation> for NotificationClickPayload {
    fn from(navigation: NotificationNavigation) -> Self {
        Self {
            notification_id: navigation.notification_id,
            tab_id: navigation.tab_id,
            session_id: navigation.session_id,
            workspace_path: navigation.workspace_path,
            geo_locator: navigation.geo_locator,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionCompletionStatus {
    Complete,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompletionTerminal {
    pub session_id: String,
    pub workspace_path: String,
    pub turn_id: String,
    pub status: SessionCompletionStatus,
}

fn should_show_session_completion<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|window| {
            !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false)
        })
        .unwrap_or(true)
}

pub fn completion_terminal_from_sse_data(data: &str) -> Option<SessionCompletionTerminal> {
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let payload = value.get("payload").unwrap_or(&value);
    serde_json::from_value(payload.get("completionTerminal")?.clone()).ok()
}

pub(crate) fn submit_session_completion<R: Runtime>(
    app: &AppHandle<R>,
    terminal: SessionCompletionTerminal,
    _claim: crate::sidecar::SessionCompletionClaim,
) {
    if !should_show_session_completion(app) {
        ulog_debug!(
            "[Notification] Session completion toast suppressed while main window is focused: session={} turn={}",
            terminal.session_id,
            terminal.turn_id,
        );
        return;
    }

    let locale = crate::i18n::current_locale();
    let (title_key, body_key) = match terminal.status {
        SessionCompletionStatus::Complete => (
            "notification.sessionCompleteTitle",
            "notification.sessionCompleteBody",
        ),
        SessionCompletionStatus::Stopped => (
            "notification.sessionStoppedTitle",
            "notification.sessionStoppedBody",
        ),
        SessionCompletionStatus::Error => (
            "notification.sessionErrorTitle",
            "notification.sessionErrorBody",
        ),
    };
    let navigation = NotificationNavigation::for_session(
        None,
        terminal.session_id.clone(),
        terminal.workspace_path.clone(),
    );
    show_with_navigation_target_and_badge(
        app,
        crate::i18n::t(title_key, locale),
        crate::i18n::t(body_key, locale),
        navigation,
        Some(NotificationBadgeIncrement {
            id: format!(
                "session-completion:{}:{}",
                terminal.session_id, terminal.turn_id
            ),
            source: "session-completion".to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            target: crate::notification_badge::NotificationBadgeTarget::Session {
                session_id: terminal.session_id,
                workspace_path: terminal.workspace_path,
            },
        }),
    );
}

pub fn init_app_handle(app: AppHandle) {
    let _ = NOTIFICATION_APP_HANDLE.set(app);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeoStatusChangedPayload {
    workspace_id: String,
    session_id: String,
}

/// Project every structured Operation mutation into the sidebar and, for the
/// two generic GEO notification categories, submit a privacy-safe toast. This
/// runs only after the BrandWorkspace transaction commits; it never changes
/// Operation execution, persistence, retry, or recovery.
pub fn submit_geo_operation_projection(operation: &crate::brand_workspace::GeoOperationProjection) {
    let category = match operation.status.as_str() {
        "awaiting-confirmation" => GeoNotificationCategory::AwaitingConfirmation,
        "failed" => GeoNotificationCategory::OperationFailed,
        _ => {
            emit_geo_status_changed(&operation.workspace_id, &operation.session_id);
            return;
        }
    };
    let step_id = operation.steps.iter().find_map(|step| {
        let relevant = match category {
            GeoNotificationCategory::AwaitingConfirmation => step.status == "awaiting-confirmation",
            GeoNotificationCategory::OperationFailed => step.status == "failed",
            _ => false,
        };
        relevant.then(|| step.id.clone())
    });
    submit_geo_notification(GeoNotificationEvent {
        category,
        revision: operation.revision,
        locator: GeoNotificationLocator {
            workspace_id: operation.workspace_id.clone(),
            session_id: operation.session_id.clone(),
            operation_id: operation.id.clone(),
            card: GeoNotificationCard::GeoOperation,
            step_id,
            artifact: GeoNotificationArtifactLocator {
                kind: "operation".to_string(),
                id: operation.id.clone(),
                revision: Some(operation.revision),
            },
        },
    });
}

pub fn submit_article_batch_completion(
    workspace_id: &str,
    session_id: &str,
    operation_id: &str,
    revision: i64,
) {
    submit_geo_notification(GeoNotificationEvent {
        category: GeoNotificationCategory::BatchCompleted,
        revision,
        locator: GeoNotificationLocator {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            card: GeoNotificationCard::ArticleGeneration,
            step_id: None,
            artifact: GeoNotificationArtifactLocator {
                kind: "article-operation".to_string(),
                id: operation_id.to_string(),
                revision: Some(revision),
            },
        },
    });
}

pub fn submit_publish_failure(
    workspace_id: &str,
    session_id: &str,
    operation_id: &str,
    execution_id: &str,
    revision: i64,
) {
    submit_geo_notification(GeoNotificationEvent {
        category: GeoNotificationCategory::PublishFailed,
        revision,
        locator: GeoNotificationLocator {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            card: GeoNotificationCard::PublishExecution,
            step_id: None,
            artifact: GeoNotificationArtifactLocator {
                kind: "publish-execution".to_string(),
                id: execution_id.to_string(),
                revision: Some(revision),
            },
        },
    });
}

pub fn submit_publish_confirmation_required(
    workspace_id: &str,
    session_id: &str,
    operation_id: &str,
    execution_id: &str,
    revision: i64,
) {
    submit_geo_notification(GeoNotificationEvent {
        category: GeoNotificationCategory::AwaitingConfirmation,
        revision,
        locator: GeoNotificationLocator {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            card: GeoNotificationCard::PublishExecution,
            step_id: None,
            artifact: GeoNotificationArtifactLocator {
                kind: "publish-execution".to_string(),
                id: execution_id.to_string(),
                revision: Some(revision),
            },
        },
    });
}

pub fn submit_monitoring_completion(
    workspace_id: &str,
    session_id: &str,
    operation_id: &str,
    plan_id: &str,
    revision: i64,
) {
    submit_geo_notification(GeoNotificationEvent {
        category: GeoNotificationCategory::MonitoringCompleted,
        revision,
        locator: GeoNotificationLocator {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
            operation_id: operation_id.to_string(),
            card: GeoNotificationCard::PostPublishMonitoring,
            step_id: None,
            artifact: GeoNotificationArtifactLocator {
                kind: "monitor-plan".to_string(),
                id: plan_id.to_string(),
                revision: Some(revision),
            },
        },
    });
}

fn emit_geo_status_changed(workspace_id: &str, session_id: &str) {
    let Some(app) = NOTIFICATION_APP_HANDLE.get() else {
        return;
    };
    if let Err(error) = app.emit(
        "geo:status-changed",
        GeoStatusChangedPayload {
            workspace_id: workspace_id.to_string(),
            session_id: session_id.to_string(),
        },
    ) {
        ulog_warn!(
            "[Notification] Failed to emit GEO status projection: {}",
            error
        );
    }
}

pub fn submit_geo_status_projection(workspace_id: &str, session_id: &str) {
    emit_geo_status_changed(workspace_id, session_id);
}

fn submit_geo_notification(event: GeoNotificationEvent) {
    emit_geo_status_changed(&event.locator.workspace_id, &event.locator.session_id);
    let Some(app) = NOTIFICATION_APP_HANDLE.get() else {
        ulog_warn!("[Notification] GEO notification skipped before AppHandle initialization");
        return;
    };
    let prefs = read_notification_prefs();
    if !prefs.os_notifications || !prefs.geo_category_enabled(event.category) {
        ulog_debug!(
            "[Notification] GEO category suppressed by preference category={}",
            event.category.preference_key()
        );
        return;
    }
    if !should_show_session_completion(app) {
        ulog_debug!(
            "[Notification] GEO toast suppressed while main window is focused category={}",
            event.category.preference_key()
        );
        return;
    }
    let delivery_id = event.delivery_id();
    if !admit_geo_delivery(&delivery_id) {
        ulog_debug!(
            "[Notification] Duplicate GEO toast suppressed category={}",
            event.category.preference_key()
        );
        return;
    }
    let locale = crate::i18n::current_locale();
    let (title_key, body_key) = geo_notification_text_keys(event.category);
    show_with_navigation_target_inner(
        app,
        crate::i18n::t(title_key, locale),
        crate::i18n::t(body_key, locale),
        Some(NotificationNavigation::for_geo(&event)),
        None,
    );
}

fn geo_notification_text_keys(category: GeoNotificationCategory) -> (&'static str, &'static str) {
    match category {
        GeoNotificationCategory::AwaitingConfirmation => (
            "notification.geoAwaitingConfirmationTitle",
            "notification.geoAwaitingConfirmationBody",
        ),
        GeoNotificationCategory::OperationFailed => (
            "notification.geoOperationFailedTitle",
            "notification.geoOperationFailedBody",
        ),
        GeoNotificationCategory::BatchCompleted => (
            "notification.geoBatchCompletedTitle",
            "notification.geoBatchCompletedBody",
        ),
        GeoNotificationCategory::PublishFailed => (
            "notification.geoPublishFailedTitle",
            "notification.geoPublishFailedBody",
        ),
        GeoNotificationCategory::MonitoringCompleted => (
            "notification.geoMonitoringCompletedTitle",
            "notification.geoMonitoringCompletedBody",
        ),
    }
}

fn admit_geo_delivery(delivery_id: &str) -> bool {
    let mut guard = GEO_DELIVERY_DEDUPE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !guard.ids.insert(delivery_id.to_string()) {
        return false;
    }
    guard.order.push_back(delivery_id.to_string());
    while guard.order.len() > GEO_DELIVERY_DEDUPE_LIMIT {
        if let Some(expired) = guard.order.pop_front() {
            guard.ids.remove(&expired);
        }
    }
    true
}

/// Send an OS notification.
///
/// `tab_id` (when supplied) is an exact live-Tab deep-link target. Use
/// `show_with_navigation_target` when the target may need to open a Session
/// that has no live Tab yet.
///
/// Sound is gated by the `notificationSound` user preference, read disk-first
/// from Xiaojing's local-data `config.json` (defaults to enabled if missing). The
/// preference flows through to the platform-specific sound API:
///   - Windows: `Toast::sound(None)` for silent, `Sound::Default` for default.
///   - macOS: `NSUserNotificationDefaultSoundName` (default mac chime).
///   - Linux: `message-new-instant` (XDG sound theme; widely supported).
///
/// Best-effort: any OS-level failure is logged but never propagated to the
/// caller — a silent notification is strictly better than failing the GEO
/// operation or chat turn that triggered it.
pub fn show_with_navigation<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    tab_id: Option<String>,
) {
    show_with_navigation_target(
        app,
        title,
        body,
        NotificationNavigation::from_tab_id(tab_id),
    );
}

/// Send an OS notification with an optional navigation target.
///
/// Prefer this for background GEO surfaces where the target
/// may not have a live Tab yet. A tab-only target can only switch an existing
/// tab; a session target lets the renderer open the corresponding chat session
/// through its exact Session locator.
pub fn show_with_navigation_target<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
) {
    show_with_navigation_target_inner(app, title, body, navigation, None);
}

pub fn show_with_navigation_target_and_badge<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    badge_increment: Option<NotificationBadgeIncrement>,
) {
    show_with_navigation_target_inner(app, title, body, navigation, badge_increment);
}

fn show_with_navigation_target_inner<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    badge_increment: Option<NotificationBadgeIncrement>,
) {
    let prefs = read_notification_prefs();
    if !prefs.os_notifications {
        ulog_debug!(
            "[Notification] Suppressed by user preference (osNotifications=false): title='{}'",
            title
        );
        return;
    }
    let silent = !prefs.notification_sound;
    ulog_info!(
        "[Notification] Showing toast title='{}' navigation={:?} silent={}",
        title,
        navigation.as_ref().map(NotificationNavigation::describe),
        silent
    );

    if prefs.notification_badge {
        if let Some(increment) = badge_increment {
            crate::notification_badge::emit_badge_increment(app, increment);
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Pure closure-capture path — no global state, no consumer command.
        if let Err(e) = show_windows_toast(app, title, body, navigation, silent) {
            ulog_error!(
                "[Notification] WinRT toast rendering failed entirely: {}. \
                 Notification will not be displayed; click activation \
                 unavailable. Likely cause: AUMID mismatch or missing \
                 Start Menu shortcut.",
                e
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Render first; only stash on success. Stashing eagerly would let
        // failed renders pollute the latch for 30s.
        if let Err(e) = show_via_plugin(app, title, body, silent) {
            ulog_warn!("[Notification] plugin-notification show failed: {}", e);
            return;
        }
        if let Some(target) = navigation {
            queue_pending_click(target);
        }
    }
}

/// Render via the cross-platform `tauri-plugin-notification` builder API.
///
/// `plugin-notification`'s desktop backend (`notify-rust`) routes the `sound`
/// field through to `mac-notification-sys` on macOS and the freedesktop
/// notification spec's `sound-name` hint on Linux. Not calling `.sound()` at
/// all on these platforms means notify-rust never sets the sound key, which
/// produces a *silent* notification — that's why the silent path takes the
/// no-op branch and the audible path needs an explicit name.
#[cfg(not(target_os = "windows"))]
fn show_via_plugin<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    silent: bool,
) -> tauri_plugin_notification::Result<()> {
    let mut builder = app.notification().builder().title(title).body(body);
    if !silent {
        if let Some(sound_name) = default_sound_name() {
            builder = builder.sound(sound_name);
        }
    }
    builder.show()
}

/// Per-platform default sound identifier passed to `notify-rust`.
///
/// macOS: `NSUserNotificationDefaultSoundName` is the documented sentinel for
/// "play the system's default notification chime" (see Apple's
/// NSUserNotification docs). `mac-notification-sys` recognizes any other
/// string as a custom sound name (e.g. "Ping", "Blow") in `/System/Library/Sounds/`.
///
/// Linux: `message-new-instant` is part of the freedesktop sound theme spec
/// and is supported by GNOME / KDE / XFCE / Cinnamon notification daemons.
/// Notification daemons that don't understand it fall back to no sound.
#[cfg(target_os = "macos")]
fn default_sound_name() -> Option<&'static str> {
    Some("NSUserNotificationDefaultSoundName")
}

#[cfg(target_os = "linux")]
fn default_sound_name() -> Option<&'static str> {
    Some("message-new-instant")
}

/// User notification preferences read from Xiaojing's local-data `config.json`.
///
/// Both fields default to `true` (fail-open) when the config file is missing
/// or unparseable — silently disabling notifications because we couldn't read
/// a JSON file would look like a regression. Read overhead is negligible:
/// notifications are low-frequency events, and the file is small.
#[derive(Debug)]
struct NotificationPrefs {
    /// Master switch: when false, no OS notification is rendered at all
    /// (covers all 6 trigger sites — cron / task / message complete /
    /// permission request / ask-user-question / plan-mode review).
    os_notifications: bool,
    /// Sound flag: when true, the platform default chime plays alongside
    /// the toast.
    notification_sound: bool,
    /// Badge flag: when true, native app icon badges mirror unseen notification
    /// work. Defaults off while the feature is still being validated.
    notification_badge: bool,
    geo_notifications: GeoNotificationPrefs,
}

#[derive(Debug, Clone, Copy)]
struct GeoNotificationPrefs {
    awaiting_confirmation: bool,
    operation_failed: bool,
    batch_completed: bool,
    publish_failed: bool,
    monitoring_completed: bool,
}

impl Default for GeoNotificationPrefs {
    fn default() -> Self {
        Self {
            awaiting_confirmation: true,
            operation_failed: true,
            batch_completed: true,
            publish_failed: true,
            monitoring_completed: true,
        }
    }
}

impl NotificationPrefs {
    fn geo_category_enabled(&self, category: GeoNotificationCategory) -> bool {
        match category {
            GeoNotificationCategory::AwaitingConfirmation => {
                self.geo_notifications.awaiting_confirmation
            }
            GeoNotificationCategory::OperationFailed => self.geo_notifications.operation_failed,
            GeoNotificationCategory::BatchCompleted => self.geo_notifications.batch_completed,
            GeoNotificationCategory::PublishFailed => self.geo_notifications.publish_failed,
            GeoNotificationCategory::MonitoringCompleted => {
                self.geo_notifications.monitoring_completed
            }
        }
    }
}

fn read_notification_prefs() -> NotificationPrefs {
    // Use the project-canonical data-dir helper rather than `dirs::home_dir()`
    // so future dev/prod isolation in `app_dirs.rs` reaches us automatically.
    let content = crate::app_dirs::xiaojing_data_dir()
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .unwrap_or_default();
    parse_notification_prefs((!content.is_empty()).then_some(content.as_str()))
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    os_notifications: Option<bool>,
    /// Pre-0.2.14 master toggle retained as a disk-first fallback.
    cron_notifications: Option<bool>,
    notification_sound: Option<bool>,
    notification_badge: Option<bool>,
    geo_notification_preferences: Option<PartialGeoNotificationPrefs>,
}

#[derive(Debug, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialGeoNotificationPrefs {
    awaiting_confirmation: Option<bool>,
    operation_failed: Option<bool>,
    batch_completed: Option<bool>,
    publish_failed: Option<bool>,
    monitoring_completed: Option<bool>,
}

fn parse_notification_prefs(content: Option<&str>) -> NotificationPrefs {
    let parsed: Option<PartialAppConfig> =
        content.and_then(|value| serde_json::from_str(strip_bom(value)).ok());

    let geo = parsed
        .as_ref()
        .and_then(|config| config.geo_notification_preferences.as_ref());
    NotificationPrefs {
        os_notifications: parsed
            .as_ref()
            .and_then(|c| c.os_notifications.or(c.cron_notifications))
            .unwrap_or(true),
        notification_sound: parsed
            .as_ref()
            .and_then(|c| c.notification_sound)
            .unwrap_or(true),
        notification_badge: parsed
            .as_ref()
            .and_then(|c| c.notification_badge)
            .unwrap_or(false),
        geo_notifications: GeoNotificationPrefs {
            awaiting_confirmation: geo
                .and_then(|prefs| prefs.awaiting_confirmation)
                .unwrap_or(true),
            operation_failed: geo.and_then(|prefs| prefs.operation_failed).unwrap_or(true),
            batch_completed: geo.and_then(|prefs| prefs.batch_completed).unwrap_or(true),
            publish_failed: geo.and_then(|prefs| prefs.publish_failed).unwrap_or(true),
            monitoring_completed: geo
                .and_then(|prefs| prefs.monitoring_completed)
                .unwrap_or(true),
        },
    }
}

/// Direct WinRT toast with `on_activated` click handler. Compiled only on
/// Windows.
///
/// Two-tier rendering: try the bundle identifier (matches NSIS Start-Menu
/// shortcut AUMID); on failure (portable EXE, custom install, missing
/// shortcut) retry with PowerShell's well-known AUMID. The retry preserves
/// `on_activated`, so click activation still works — the only visible
/// difference is the toast sender label ("PowerShell" instead of "Xiaojing").
/// This beats falling back to plugin-notification, which would render a toast
/// with *no* click handler at all.
#[cfg(target_os = "windows")]
fn show_windows_toast<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::Toast;

    let primary_app_id = resolve_windows_app_id(app);
    let primary_is_powershell = primary_app_id == Toast::POWERSHELL_APP_ID;

    match build_and_show_toast(
        app,
        &primary_app_id,
        title,
        body,
        navigation.clone(),
        silent,
    ) {
        Ok(()) => Ok(()),
        Err(e) if primary_is_powershell => Err(e),
        Err(e) => {
            ulog_warn!(
                "[Notification] WinRT toast with AUMID '{}' failed: {}; \
                 retrying with PowerShell AUMID (click handler preserved).",
                primary_app_id,
                e
            );
            build_and_show_toast(
                app,
                Toast::POWERSHELL_APP_ID,
                title,
                body,
                navigation,
                silent,
            )
        }
    }
}

#[cfg(target_os = "windows")]
fn build_and_show_toast<R: Runtime>(
    app: &AppHandle<R>,
    app_id: &str,
    title: &str,
    body: &str,
    navigation: Option<NotificationNavigation>,
    silent: bool,
) -> tauri_winrt_notification::Result<()> {
    use tauri_winrt_notification::{Duration as ToastDuration, Sound, Toast};

    let app_handle = app.clone();
    // `Sound::Default` produces an empty `<audio>` element — WinRT then plays
    // the toast template's default chime. `None` injects `<audio silent="true"/>`,
    // suppressing sound entirely.
    let sound = if silent { None } else { Some(Sound::Default) };
    Toast::new(app_id)
        .title(title)
        .text1(body)
        .duration(ToastDuration::Short)
        .sound(sound)
        .on_activated(move |_action| {
            // _action is non-empty only when an action button is clicked;
            // we don't render buttons, so any activation is the toast body.
            // navigation is closure-captured per-toast — no global queue lookup.
            handle_toast_click(&app_handle, navigation.clone());
            Ok(())
        })
        .show()
}

/// Resolve the primary AUMID for our toast.
///
/// In production: `app.config().identifier` matches the AUMID NSIS sets on
/// the Start Menu shortcut via `SetLnkAppUserModelId` — required for WinRT
/// to render a toast attributed to Xiaojing.
///
/// In dev (`cargo run`, `tauri dev`): `tauri::is_dev()` is true and we use
/// PowerShell's AUMID — toast still shows but attributed to PowerShell.
///
/// Uses `tauri::is_dev()` (compile-time const) rather than path-suffix
/// heuristics that break under non-standard `CARGO_TARGET_DIR` or monorepo
/// layouts. The `tauri-plugin-notification` desktop backend uses path
/// suffix matching for the same purpose — `is_dev` is the cleaner equivalent
/// (#review-finding-3, CC).
#[cfg(target_os = "windows")]
fn resolve_windows_app_id<R: Runtime>(app: &AppHandle<R>) -> String {
    use tauri_winrt_notification::Toast;

    if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Toast click handler (Windows in-process Activated callback).
///
/// Intentionally **does not** consult the global pending-click latch — that
/// latch is non-Windows only. The closure captures the per-toast navigation
/// target at render time, eliminating multi-toast misroute.
#[cfg(target_os = "windows")]
fn handle_toast_click<R: Runtime>(app: &AppHandle<R>, navigation: Option<NotificationNavigation>) {
    ulog_info!(
        "[Notification] Toast clicked; navigation={:?}",
        navigation.as_ref().map(NotificationNavigation::describe)
    );
    crate::show_main_window(app);
    emit_click(app, navigation);
}

/// macOS / Linux fallback: when the user activates our app via an external
/// trigger (single-instance second launch, focus regain after a banner
/// click), drain the pending latch.
///
/// **Tradeoff (acknowledged)**: any external activation drains the latch,
/// not strictly toast clicks — alt-tab back to Xiaojing within 30s of a
/// notification will navigate to the queued tab even though the user didn't
/// click the toast. Mitigations:
///   - The latch is `Ambiguous` (no-route) when ≥2 notifications stacked
///     up unconsumed, so the worst case is a single-toast wrong-tab nudge.
///   - The `Single`-state path is the most common notification flow (one
///     completion, user reacts to it), where this behavior is what the user
///     wants anyway.
///
/// Real fix on macOS would require an `NSUserNotificationCenterDelegate`
/// hooked through Tauri (not currently exposed); on Linux, dbus action
/// callbacks. Both are out of scope for this fix and tracked separately.
#[cfg(not(target_os = "windows"))]
pub fn on_window_activated_externally<R: Runtime>(app: &AppHandle<R>) -> bool {
    if let Some(navigation) = take_pending_click() {
        ulog_info!(
            "[Notification] External activation consumed pending click {}",
            navigation.describe()
        );
        emit_click(app, Some(navigation));
        return true;
    }
    false
}

/// Windows variant: no global latch, so external activation has nothing to
/// consume. Defined as a no-op so the call site in `lib.rs::single_instance`
/// stays platform-agnostic.
#[cfg(target_os = "windows")]
pub fn on_window_activated_externally<R: Runtime>(_app: &AppHandle<R>) -> bool {
    false
}

fn emit_click<R: Runtime>(app: &AppHandle<R>, navigation: Option<NotificationNavigation>) {
    let Some(navigation) = navigation else {
        return;
    };
    let payload = NotificationClickPayload::from(navigation);
    let should_emit = admit_renderer_click(payload.clone());
    if should_emit {
        if let Err(error) = app.emit("notification:click", payload) {
            ulog_warn!(
                "[Notification] Failed to emit notification:click: {}",
                error
            );
        }
    }
}

fn admit_renderer_click(payload: NotificationClickPayload) -> bool {
    let mut ingress = RENDERER_CLICK_INGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(notification_id) = payload.notification_id.as_ref() {
        if !ingress
            .handled_notification_ids
            .insert(notification_id.clone())
        {
            return false;
        }
        ingress
            .handled_notification_order
            .push_back(notification_id.clone());
        while ingress.handled_notification_order.len() > GEO_DELIVERY_DEDUPE_LIMIT {
            if let Some(expired) = ingress.handled_notification_order.pop_front() {
                ingress.handled_notification_ids.remove(&expired);
            }
        }
    }
    if ingress.ready {
        return true;
    }
    if ingress.pending.is_some() {
        ingress.pending = None;
        ingress.ambiguous = true;
    } else if !ingress.ambiguous {
        ingress.pending = Some(payload);
    }
    false
}

fn renderer_click_listener_ready() -> Option<NotificationClickPayload> {
    let mut ingress = RENDERER_CLICK_INGRESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ingress.ready = true;
    if ingress.ambiguous {
        ingress.ambiguous = false;
        ingress.pending = None;
        return None;
    }
    ingress.pending.take()
}

#[cfg(not(target_os = "windows"))]
fn queue_pending_click(navigation: NotificationNavigation) {
    let described = navigation.describe();
    let mut guard = match PENDING_CLICK.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            ulog_warn!("[Notification] PENDING_CLICK mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    };
    let now = Instant::now();
    *guard = match std::mem::replace(&mut *guard, PendingState::Empty) {
        // First entry — straightforward.
        PendingState::Empty => PendingState::Single(Box::new(PendingClick {
            navigation,
            queued_at: now,
        })),
        // Promote to Ambiguous: we now have ≥2 unconsumed notifications
        // and can't tell which one the user will click. Keep the older
        // queued_at so TTL bounds the ambiguous window correctly.
        //
        // Boundary fix from security review: if the old `Single` is itself
        // already past TTL (notification fired ≥30s ago, never clicked),
        // the user has clearly abandoned it — treat it as Empty for the
        // promotion. Otherwise we'd build an Ambiguous state seeded with
        // an already-expired timestamp, and `take_pending_click` doesn't
        // apply TTL to Ambiguous → the latch stays stuck refusing routes
        // until the next queue flushes it. v0.2.14 dogfood scenario:
        // queue A, leave window unfocused 31s, queue B, click B → gets
        // no deep-link forever.
        PendingState::Single(prev) if prev.queued_at.elapsed() > PENDING_CLICK_TTL => {
            PendingState::Single(Box::new(PendingClick {
                navigation,
                queued_at: now,
            }))
        }
        PendingState::Single(prev) => PendingState::Ambiguous {
            queued_at: prev.queued_at,
        },
        // Same TTL hygiene for an already-Ambiguous entry: if its anchor
        // is past TTL when a new notification arrives, reset to Single on
        // the fresh entry. The user's previous batch is no longer the one
        // being clicked.
        PendingState::Ambiguous { queued_at } if queued_at.elapsed() > PENDING_CLICK_TTL => {
            PendingState::Single(Box::new(PendingClick {
                navigation,
                queued_at: now,
            }))
        }
        PendingState::Ambiguous { queued_at } => PendingState::Ambiguous { queued_at },
    };
    ulog_info!("[Notification] Pending click queued {}", described);
}

#[cfg(not(target_os = "windows"))]
fn take_pending_click() -> Option<NotificationNavigation> {
    let mut guard = match PENDING_CLICK.lock() {
        Ok(g) => g,
        Err(poisoned) => {
            ulog_warn!("[Notification] PENDING_CLICK mutex was poisoned; recovering");
            poisoned.into_inner()
        }
    };
    let state = std::mem::replace(&mut *guard, PendingState::Empty);
    match state {
        PendingState::Empty => None,
        PendingState::Single(entry) => {
            if entry.queued_at.elapsed() > PENDING_CLICK_TTL {
                ulog_debug!(
                    "[Notification] Pending click for {} expired",
                    entry.navigation.describe()
                );
                None
            } else {
                Some(entry.navigation)
            }
        }
        PendingState::Ambiguous { queued_at: _ } => {
            // Refusing to route is the safe choice: deep-linking to the
            // *wrong* tab is worse than leaving the user on the current
            // tab after raising the window.
            ulog_debug!(
                "[Notification] Pending click was Ambiguous; raising window without deep-link"
            );
            None
        }
    }
}

// ============ Tauri Commands ============

/// Front-end entry point. Replaces direct calls to
/// `@tauri-apps/plugin-notification`'s `sendNotification` so that:
///   1. all OS notifications go through one Rust function
///   2. the click handler is always wired (no caller can "forget")
///   3. the deep-link tab routing is structural rather than a JS-side
///      time-window race
#[tauri::command]
pub fn cmd_show_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: Option<String>,
    tab_id: Option<String>,
    session_id: Option<String>,
    workspace_path: Option<String>,
) {
    let body = body.unwrap_or_default();
    ulog_info!(
        "[Notification] cmd_show_notification title='{}' tab_id={:?} session_id={:?} workspace_path={:?}",
        title,
        tab_id,
        session_id,
        workspace_path
    );
    show_with_navigation_target_inner(
        &app,
        &title,
        &body,
        NotificationNavigation::new(tab_id, session_id, workspace_path),
        None,
    );
}

/// Front-end hook for macOS / Linux focus-regain. On Windows this is a
/// no-op — the WinRT in-process callback already handled click routing
/// synchronously, and consulting the (non-existent) global latch would
/// cause a double-emit (#review-finding-1).
#[tauri::command]
pub fn cmd_consume_notification_click<R: Runtime>(app: AppHandle<R>) -> bool {
    let consumed = on_window_activated_externally(&app);
    ulog_info!(
        "[Notification] cmd_consume_notification_click consumed={}",
        consumed
    );
    consumed
}

/// Renderer calls this only after installing its `notification:click`
/// listener. The returned cold-start click is consumed exactly once and is
/// intentionally memory-only; an empty/invalid navigation is never persisted
/// into a future ordinary startup.
#[tauri::command]
pub fn cmd_notification_click_listener_ready() -> Option<NotificationClickPayload> {
    renderer_click_listener_ready()
}

#[tauri::command]
pub async fn cmd_resolve_geo_notification_locator(
    locator: GeoNotificationLocator,
) -> Result<GeoNotificationResolution, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::brand_workspace::production_store()?.resolve_geo_notification_locator(locator)
    })
    .await
    .map_err(|error| format!("resolve GEO notification locator task failed: {error}"))?
}

// ============ Tests ============

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;

    /// All tests in this module touch the same global latch. Run them in a
    /// single `#[test]` so they don't race when `cargo test` parallelizes.
    #[test]
    fn pending_click_state_machine() {
        // 0. Reset (tests share the static; reset to Empty between phases).
        let reset = || {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Empty;
        };
        reset();

        // 1. Empty → take returns None.
        assert_eq!(take_pending_click(), None);

        // 2. queue + take returns the value once.
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-1".into())).unwrap());
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::from_tab_id(Some("tab-1".into()))
        );
        assert_eq!(take_pending_click(), None, "single-consumer semantics");

        // 3. Two queues without a take in between → Ambiguous → take None.
        reset();
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-A".into())).unwrap());
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-B".into())).unwrap());
        assert_eq!(
            take_pending_click(),
            None,
            "Ambiguous must refuse to deep-link"
        );

        // 4. Three queues → still Ambiguous → still None.
        reset();
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-A".into())).unwrap());
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-B".into())).unwrap());
        queue_pending_click(NotificationNavigation::from_tab_id(Some("tab-C".into())).unwrap());
        assert_eq!(take_pending_click(), None);

        // 5. After Ambiguous is consumed, state resets and a fresh Single
        //    can route normally.
        queue_pending_click(
            NotificationNavigation::for_session(
                None,
                "session-fresh".into(),
                "/tmp/workspace".into(),
            )
            .unwrap(),
        );
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::for_session(
                None,
                "session-fresh".into(),
                "/tmp/workspace".into(),
            )
        );

        // 6. TTL expiry on Single — synthesize an old entry directly.
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Single(Box::new(PendingClick {
                navigation: NotificationNavigation::from_tab_id(Some("tab-stale".into())).unwrap(),
                queued_at: Instant::now() - Duration::from_secs(31),
            }));
        }
        assert_eq!(take_pending_click(), None, "TTL must drop stale Single");

        // 7. queue → wait past TTL → queue → take must route to the LATER
        //    notification (not stick on Ambiguous-with-stale-anchor). This
        //    is the boundary fix from the v0.2.14 security review.
        reset();
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Single(Box::new(PendingClick {
                navigation: NotificationNavigation::from_tab_id(Some("tab-old".into())).unwrap(),
                queued_at: Instant::now() - Duration::from_secs(31),
            }));
        }
        queue_pending_click(
            NotificationNavigation::from_tab_id(Some("tab-fresh-after-stale".into())).unwrap(),
        );
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::from_tab_id(Some("tab-fresh-after-stale".into())),
            "stale Single must not poison the Ambiguous promotion",
        );

        // 8. Pre-existing Ambiguous past TTL + new queue → resets to Single
        //    on the fresh entry rather than refusing forever.
        reset();
        {
            let mut guard = PENDING_CLICK.lock().unwrap();
            *guard = PendingState::Ambiguous {
                queued_at: Instant::now() - Duration::from_secs(31),
            };
        }
        queue_pending_click(
            NotificationNavigation::from_tab_id(Some("tab-after-ambiguous".into())).unwrap(),
        );
        assert_eq!(
            take_pending_click(),
            NotificationNavigation::from_tab_id(Some("tab-after-ambiguous".into())),
            "stale Ambiguous must not poison subsequent routes",
        );
    }
}

#[cfg(test)]
mod session_completion_tests {
    use super::*;

    #[test]
    fn extracts_terminal_from_plain_and_live_payloads() {
        let raw = serde_json::json!({
            "completionTerminal": {
                "sessionId": "session-1",
                "workspacePath": "/tmp/workspace",
                "turnId": "turn-1",
                "status": "complete"
            }
        });
        assert_eq!(
            completion_terminal_from_sse_data(&raw.to_string()).map(|value| value.turn_id),
            Some("turn-1".to_string()),
        );

        let live = serde_json::json!({
            "sessionId": "session-1",
            "liveRevision": 3,
            "payload": raw,
        });
        assert_eq!(
            completion_terminal_from_sse_data(&live.to_string()).map(|value| value.turn_id),
            Some("turn-1".to_string()),
        );
    }
}

#[cfg(test)]
mod geo_notification_tests {
    use super::*;
    use crate::i18n::SupportedLocale;

    fn event(category: GeoNotificationCategory, suffix: &str) -> GeoNotificationEvent {
        GeoNotificationEvent {
            category,
            revision: 7,
            locator: GeoNotificationLocator {
                workspace_id: "brand-19".to_string(),
                session_id: "session-19".to_string(),
                operation_id: "operation-19".to_string(),
                card: GeoNotificationCard::GeoOperation,
                step_id: Some("confirm-19".to_string()),
                artifact: GeoNotificationArtifactLocator {
                    kind: "operation".to_string(),
                    id: format!("operation-19-{suffix}"),
                    revision: Some(7),
                },
            },
        }
    }

    fn reset_ingress(ready: bool) {
        let mut ingress = RENDERER_CLICK_INGRESS.lock().unwrap();
        *ingress = RendererClickIngress {
            ready,
            ..RendererClickIngress::default()
        };
    }

    #[test]
    fn categories_use_short_static_private_copy_and_respect_independent_preferences() {
        let categories = [
            GeoNotificationCategory::AwaitingConfirmation,
            GeoNotificationCategory::OperationFailed,
            GeoNotificationCategory::BatchCompleted,
            GeoNotificationCategory::PublishFailed,
            GeoNotificationCategory::MonitoringCompleted,
        ];
        for category in categories {
            let (title_key, body_key) = geo_notification_text_keys(category);
            for locale in [SupportedLocale::ZhCn, SupportedLocale::EnUs] {
                let title = crate::i18n::t(title_key, locale);
                let body = crate::i18n::t(body_key, locale);
                assert_ne!(title, title_key);
                assert_ne!(body, body_key);
                assert!(body.chars().count() <= 100);
                let lower = body.to_ascii_lowercase();
                for forbidden in ["api key", "prompt", "credential", "secret", "token"] {
                    assert!(!lower.contains(forbidden));
                }
                assert!(!body.contains("brand-19"));
                assert!(!body.contains("operation-19"));
            }
        }

        let prefs = parse_notification_prefs(Some(
            r#"{
              "osNotifications": true,
              "geoNotificationPreferences": {
                "awaitingConfirmation": false,
                "operationFailed": true,
                "batchCompleted": true,
                "publishFailed": true,
                "monitoringCompleted": true
              }
            }"#,
        ));
        assert!(prefs.os_notifications);
        assert!(!prefs.geo_category_enabled(GeoNotificationCategory::AwaitingConfirmation));
        assert!(prefs.geo_category_enabled(GeoNotificationCategory::OperationFailed));
        // Preference evaluation is a projection-only decision: the durable
        // event identity remains complete and deterministic either way.
        assert!(
            event(GeoNotificationCategory::AwaitingConfirmation, "prefs")
                .delivery_id()
                .contains("operation-19")
        );
    }

    #[test]
    fn delivery_and_click_ingress_dedupe_cold_hot_and_ambiguous_clicks() {
        {
            let mut dedupe = GEO_DELIVERY_DEDUPE.lock().unwrap();
            *dedupe = GeoDeliveryDedupe::default();
        }
        let delivery = event(GeoNotificationCategory::BatchCompleted, "dedupe").delivery_id();
        assert!(admit_geo_delivery(&delivery));
        assert!(!admit_geo_delivery(&delivery));

        let cold = NotificationClickPayload::from(NotificationNavigation::for_geo(&event(
            GeoNotificationCategory::OperationFailed,
            "cold",
        )));
        reset_ingress(false);
        assert!(!admit_renderer_click(cold.clone()));
        assert!(
            !admit_renderer_click(cold.clone()),
            "repeat click must be idempotent"
        );
        assert_eq!(
            renderer_click_listener_ready().unwrap().notification_id,
            cold.notification_id
        );
        assert_eq!(
            renderer_click_listener_ready(),
            None,
            "cold click is consumed once"
        );

        reset_ingress(false);
        let other = NotificationClickPayload::from(NotificationNavigation::for_geo(&event(
            GeoNotificationCategory::PublishFailed,
            "other",
        )));
        assert!(!admit_renderer_click(cold.clone()));
        assert!(!admit_renderer_click(other));
        assert_eq!(
            renderer_click_listener_ready(),
            None,
            "different cold clicks are ambiguous"
        );

        reset_ingress(true);
        assert!(admit_renderer_click(cold.clone()));
        assert!(
            !admit_renderer_click(cold),
            "hot repeat click must be idempotent"
        );
        assert_eq!(
            NotificationNavigation::new(None, Some(" ".into()), Some(" ".into())),
            None
        );
    }
}
