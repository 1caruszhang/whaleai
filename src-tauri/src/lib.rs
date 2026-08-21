//! Xiaojing desktop shell.

pub mod account_auth;
pub mod app_dirs;
pub mod attachment_protocol;
pub mod brand_workspace;
mod commands;
pub mod config_io;
mod crash_artifact_retention;
#[cfg(debug_assertions)]
pub(crate) mod dev_env;
pub mod distribution_spend_limits;
pub mod geo_autonomy;
pub mod geo_provider_credentials;
pub mod geo_provider_runtime;
pub mod i18n;
mod keyed_lifecycle;
pub mod local_http;
pub mod logger;
#[cfg(target_os = "macos")]
mod macos_arrow_filter;
#[cfg(target_os = "macos")]
mod macos_traffic_light;
pub mod management_api;
pub mod notification;
pub mod notification_badge;
pub mod perf_trace;
pub mod process_cleanup;
pub mod process_cmd;
mod proxy_config;
mod proxy_spill;
pub mod session_metadata;
pub mod session_visibility;
mod sidecar;
mod sse_proxy;
pub mod system_binary;
pub mod utils;
pub mod wake_lock;
mod webview_policy;
pub mod workspace_files;
mod workspace_path;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use sidecar::{
    begin_app_exit_shutdown, cleanup_stale_sidecars, create_sidecar_manager,
    init_startup_cleanup_barrier, recover_proxy_spills_after_startup_cleanup, stop_all_sidecars,
};
use tauri::{
    utils::config::Color, Emitter, Listener, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Debug, PartialEq, Eq)]
enum NavigationDecision {
    Allow,
    Block,
}

fn classify_navigation(url: &Url) -> NavigationDecision {
    match url.scheme() {
        "tauri" | "ipc" | "asset" | "xiaojing" | "xiaojing-internal" | "about" => {
            NavigationDecision::Allow
        }
        "http" | "https"
            if matches!(
                url.host_str().unwrap_or(""),
                "localhost" | "127.0.0.1" | "tauri.localhost" | "ipc.localhost"
            ) =>
        {
            NavigationDecision::Allow
        }
        _ => NavigationDecision::Block,
    }
}

pub(crate) fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecars = create_sidecar_manager();
    let sidecars_for_exit = sidecars.clone();
    let sidecars_for_session_monitor = sidecars.clone();
    let sidecars_for_wake_monitor = sidecars.clone();
    let sidecars_for_terminal_forwarder = sidecars.clone();
    let sidecars_for_management = sidecars.clone();

    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_for_exit = cleanup_done.clone();
    let cleanup_for_session_monitor = cleanup_done.clone();
    let cleanup_for_wake_monitor = cleanup_done.clone();
    let cleanup_for_terminal_forwarder = cleanup_done.clone();

    let data_root = app_dirs::xiaojing_data_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());
    let proxy_spill_state = Arc::new(proxy_spill::ProxySpillManager::new(data_root.join("refs")));

    let builder = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("xiaojing", attachment_protocol::handle)
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
            notification::on_window_activated_externally(app);
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        crate::ulog_warn!(
            "[webview] content process terminated window={}; reloading",
            webview.label()
        );
        let _ = webview.reload();
    });

    let app = builder
        .manage(sidecars)
        .manage(sse_proxy_state)
        .manage(proxy_spill_state)
        .manage(Arc::new(
            workspace_files::watcher::WorkspaceWatchers::default(),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::cmd_read_file_base64,
            sse_proxy::start_sse_proxy,
            sse_proxy::stop_sse_proxy,
            sse_proxy::stop_all_sse_proxies,
            sse_proxy::session_sidecar_http_request,
            account_auth::cmd_account_state,
            account_auth::cmd_account_login,
            account_auth::cmd_account_change_password,
            account_auth::cmd_account_refresh,
            account_auth::cmd_account_ledger,
            account_auth::cmd_account_logout,
            distribution_spend_limits::cmd_get_distribution_spend_limits,
            distribution_spend_limits::cmd_set_distribution_spend_limits,
            brand_workspace::cmd_brand_workspace_bootstrap,
            brand_workspace::cmd_brand_workspace_create,
            brand_workspace::cmd_brand_workspace_switch,
            brand_workspace::cmd_brand_session_commit,
            brand_workspace::cmd_brand_session_list,
            brand_workspace::cmd_brand_session_rename,
            brand_workspace::cmd_brand_session_archive,
            brand_workspace::cmd_brand_session_delete_preview,
            brand_workspace::cmd_brand_workspace_delete_preview,
            sidecar::session_lifecycle::cmd_brand_workspace_delete,
            brand_workspace::cmd_brand_workspace_history,
            brand_workspace::cmd_geo_operation_attest_external_gate_ui,
            brand_workspace::cmd_publish_execution_confirm_ui,
            brand_workspace::cmd_publish_execution_start_ui,
            brand_workspace::cmd_publish_execution_latest_ui,
            brand_workspace::cmd_publish_item_retry_ui,
            brand_workspace::cmd_publish_execution_resume_ui,
            brand_workspace::cmd_post_publish_monitor_prepare_ui,
            brand_workspace::cmd_post_publish_monitor_latest_ui,
            brand_workspace::cmd_post_publish_monitor_get_ui,
            brand_workspace::cmd_post_publish_monitor_activate_ui,
            brand_workspace::cmd_post_publish_monitor_retry_ui,
            brand_workspace::cmd_geo_baseline_latest_ui,
            brand_workspace::cmd_geo_baseline_get_ui,
            logger::cmd_record_renderer_boot_event,
            i18n::cmd_get_ui_language_state,
            i18n::cmd_sync_ui_language_from_config,
            i18n::cmd_set_ui_language,
            session_metadata::cmd_list_session_metadata,
            session_metadata::cmd_create_session_metadata,
            session_metadata::cmd_update_session_title,
            sidecar::commands::cmd_reconcile_session_tab_activation,
            sidecar::session_lifecycle::cmd_ensure_session_sidecar,
            sidecar::session_lifecycle::cmd_release_tab_session,
            sidecar::session_lifecycle::cmd_session_has_persistent_owners,
            sidecar::session_lifecycle::cmd_delete_session_if_unowned,
            sidecar::session_lifecycle::cmd_can_restore_session,
            sidecar::background::cmd_start_background_completion,
            sidecar::background::cmd_cancel_background_completion,
            sidecar::background::cmd_get_background_sessions,
            notification::cmd_show_notification,
            notification::cmd_consume_notification_click,
            notification::cmd_notification_click_listener_ready,
            notification::cmd_resolve_geo_notification_locator,
            notification_badge::cmd_set_notification_badge,
            workspace_files::files_b64::cmd_workspace_import_files_b64,
            workspace_files::files_b64::cmd_workspace_read_files_b64,
            workspace_files::user_attachments::cmd_prepare_user_image_attachments,
            workspace_files::check_paths::cmd_workspace_check_paths,
            workspace_files::check_paths::cmd_check_local_paths,
            workspace_files::transfer::cmd_workspace_copy_paths,
            workspace_files::transfer::cmd_workspace_copy_internal,
            workspace_files::gitignore::cmd_workspace_add_gitignore,
            workspace_files::read_preview::cmd_workspace_read_preview,
            workspace_files::read_preview::cmd_read_local_preview,
            workspace_files::download::cmd_workspace_download_file,
            workspace_files::download::cmd_workspace_download_bytes,
            workspace_files::download::cmd_download_local_file,
            workspace_files::download::cmd_download_local_bytes,
            workspace_files::save_file::cmd_workspace_save_file,
            workspace_files::crud::cmd_workspace_rename,
            workspace_files::system_open::cmd_workspace_open_in_finder,
            workspace_files::system_open::cmd_workspace_open_with_default,
            workspace_files::system_open::cmd_open_path_external,
            workspace_files::system_open::cmd_open_path_with_default,
            workspace_files::watcher::cmd_workspace_watch_start,
            workspace_files::watcher::cmd_workspace_watch_stop,
        ])
        .setup(move |app| {
            use tauri_plugin_log::{Target, TargetKind};

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(if cfg!(debug_assertions) {
                        log::LevelFilter::Debug
                    } else {
                        log::LevelFilter::Info
                    })
                    .clear_targets()
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;
            logger::init_app_handle(app.handle().clone());
            notification::init_app_handle(app.handle().clone());
            logger::init_buffered_writer();
            // Must precede every credential read: capability status queries,
            // verify calls, and the first Session Sidecar spawn.
            #[cfg(debug_assertions)]
            dev_env::load_repo_dev_env();
            crash_artifact_retention::start_crash_artifact_retention_owner();

            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .scroll_bar_style(crate::webview_policy::scroll_bar_style())
                .title("鲸杉geo")
                .inner_size(1200.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .center()
                .visible(false)
                .background_color(Color(26, 22, 20, 255))
                .on_navigation(|url| match classify_navigation(url) {
                    NavigationDecision::Allow => true,
                    NavigationDecision::Block => {
                        crate::ulog_warn!("[main-window] blocked navigation: {}", url);
                        false
                    }
                });

            #[cfg(target_os = "macos")]
            let builder = builder
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay);

            let window = builder.build()?;
            #[cfg(target_os = "macos")]
            {
                let _ = macos_traffic_light::install_native_layout_owner(&window, 15.0, 20.0);
                macos_arrow_filter::install_arrow_key_filter();
            }
            #[cfg(target_os = "windows")]
            let _ = window.set_decorations(false);
            window.show()?;
            let _ = window.set_focus();

            let lock_state = app_dirs::acquire_lock();
            let spill_manager = app
                .state::<Arc<proxy_spill::ProxySpillManager>>()
                .inner()
                .clone();
            init_startup_cleanup_barrier();
            tauri::async_runtime::spawn(async move {
                let writers_quiesced = tauri::async_runtime::spawn_blocking(move || {
                    cleanup_stale_sidecars(lock_state.had_prior_instance())
                })
                .await
                .unwrap_or(false);
                let _ = recover_proxy_spills_after_startup_cleanup(
                    spill_manager.as_ref(),
                    writers_quiesced,
                )
                .await;
                sidecar::mark_startup_cleanup_done();
            });

            management_api::set_sidecar_state(sidecars_for_management.clone());
            if let Ok(store) = brand_workspace::production_store() {
                if let Err(error) = store.recover_interrupted_geo_operations_on_startup() {
                    crate::ulog_warn!("[geo-recovery] startup failed: {}", error);
                }
            }

            let terminal_events = sidecars_for_terminal_forwarder
                .lock()
                .ok()
                .map(|manager| manager.subscribe_terminal_events());
            session_metadata::spawn_session_metadata_watcher(app.handle().clone());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = management_api::start_management_api().await {
                    crate::ulog_error!("[control-plane] startup failed: {}", error);
                }
            });
            if let Some(events) = terminal_events {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    sidecar::forward_terminal_events_to_renderer(
                        app_handle,
                        sidecars_for_terminal_forwarder,
                        cleanup_for_terminal_forwarder,
                        events,
                    )
                    .await;
                });
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(sidecar::monitor_session_sidecars(
                app_handle,
                sidecars_for_session_monitor,
                cleanup_for_session_monitor,
            ));
            tauri::async_runtime::spawn(sidecar::monitor_turn_wake_lock(
                sidecars_for_wake_monitor,
                cleanup_for_wake_monitor,
            ));

            let exit_handle = app.handle().clone();
            app.listen("window:confirm-exit", move |_| exit_handle.exit(0));
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.emit("window:close-requested", ());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("failed to build Xiaojing desktop shell");

    app.run(move |app_handle, event| {
        #[cfg(not(target_os = "macos"))]
        let _ = &app_handle;
        match event {
            tauri::RunEvent::ExitRequested { .. } => {
                if !cleanup_for_exit.swap(true, Ordering::Relaxed) {
                    let _ = begin_app_exit_shutdown();
                    if let Ok(store) = brand_workspace::production_store() {
                        let _ = store.pause_active_geo_operations_for_shutdown();
                    }
                    let _ = geo_provider_runtime::global_geo_provider_limiter().clear();
                    app_dirs::record_clean_exit();
                    let _ = stop_all_sidecars(&sidecars_for_exit, "app-exit");
                    process_cmd::settle_pending_tree_terminations();
                    app_dirs::release_lock();
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app_handle),
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_inside_xiaojing_origins() {
        for url in [
            "xiaojing://attachment/session/file.png",
            "http://localhost:5173/",
            "http://tauri.localhost/",
            "about:blank",
        ] {
            assert_eq!(
                classify_navigation(&Url::parse(url).unwrap()),
                NavigationDecision::Allow
            );
        }
        assert_eq!(
            classify_navigation(&Url::parse("https://example.com/").unwrap()),
            NavigationDecision::Block
        );
    }
}
