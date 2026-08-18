use super::*;

const WAKE_LOCK_POLL_INTERVAL_SECS: u64 = 10;

/// Holds one system wake-lock while any Session Sidecar has an active turn.
///
/// The SDK keeps a long-lived HTTPS stream; if the host
/// idle-sleeps mid-turn that socket dies and the SDK never notices, so the turn
/// stalls. The monitor reads the existing `/api/session-state` endpoint.
///
/// One assertion is enough system-wide, so we hold/release a single RAII
/// `WakeLock` based on whether any sidecar is currently active. This complements
/// the suspension-aware inactivity watchdog: the wake-lock *prevents* idle sleep
/// during active turns; the watchdog handles the sleep we cannot prevent
/// (lid close / forced sleep) by not counting suspended time as inactivity.
pub async fn monitor_turn_wake_lock(
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    // RAII: dropping this releases the OS assertion (also on loop break / task drop).
    let mut wake_lock: Option<crate::wake_lock::WakeLock> = None;

    loop {
        tokio::time::sleep(Duration::from_secs(WAKE_LOCK_POLL_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break; // wake_lock drops here → assertion released
        }

        // Snapshot live sidecar ports under the lock; never hold the mutex
        // across the (blocking) HTTP poll below.
        let ports: Vec<u16> = match manager.lock() {
            Ok(guard) => guard
                .sidecars
                .values()
                .filter(|sc| sc.is_reusable())
                .map(|sc| sc.port)
                .collect(),
            // A poisoned lock is permanent — if we kept `continue`-ing we'd hold
            // the wake-lock (block idle sleep) forever. Release it and retry.
            Err(_) => {
                wake_lock = None;
                continue;
            }
        };

        // Poll session-state off the async runtime (check_sidecar_session_state
        // is blocking). A dead/unreachable sidecar returns None → not active.
        let any_active = tokio::task::spawn_blocking(move || {
            ports.iter().any(|&port| {
                matches!(
                    check_sidecar_session_state(port).as_deref(),
                    Some("running") | Some("starting")
                )
            })
        })
        .await
        .unwrap_or(false);

        match (any_active, wake_lock.is_some()) {
            (true, false) => {
                wake_lock = crate::wake_lock::WakeLock::acquire("active AI turn")
                    .map_err(|e| {
                        ulog_warn!("[wake-lock] turn wake-lock acquire failed: {} — continuing without protection", e);
                        e
                    })
                    .ok();
                if wake_lock.is_some() {
                    ulog_debug!("[wake-lock] acquired — an AI turn is active");
                }
            }
            (false, true) => {
                wake_lock = None; // drop releases the OS assertion
                ulog_debug!("[wake-lock] released — no active AI turns");
            }
            _ => {}
        }
    }
}

pub async fn forward_terminal_events_to_renderer(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
    mut rx: tokio::sync::broadcast::Receiver<(String, u64)>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    ulog_info!("[sidecar] Terminal-event forwarder started");

    loop {
        if shutdown.load(Relaxed) {
            break;
        }
        match rx.recv().await {
            Ok((session_id, generation)) => {
                let _ = app_handle.emit(
                    "session:sidecar-terminal",
                    serde_json::json!({
                        "sessionId": session_id,
                        "generation": generation,
                    }),
                );
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                ulog_warn!(
                    "[sidecar] Terminal-event forwarder lagged by {} — emitting reconcile",
                    n
                );
                // On lock poison we cannot snapshot the live set safely.
                // Fall through with `Skip` (don't emit at all) rather than
                // emitting an empty list — an empty list would tell the
                // renderer "no sessions are live, clear every tab", which is
                // a destructive fallback exactly when our state is most
                // uncertain. The renderer's defensive `hasSessionSidecar` check
                // in `handleLaunchProject` jump-to-tab still saves the user
                // if they do click into a stale binding before our next
                // event arrives.
                let live: Option<Vec<String>> = match manager.lock() {
                    Ok(g) => Some(
                        g.live_sidecar_set()
                            .into_iter()
                            .map(|(sid, _)| sid)
                            .collect(),
                    ),
                    Err(e) => {
                        ulog_error!(
                            "[sidecar] Terminal-event reconcile skipped — manager lock poisoned: {}",
                            e
                        );
                        None
                    }
                };
                if let Some(live) = live {
                    let _ = app_handle.emit(
                        "session:sidecar-terminal-reconcile",
                        serde_json::json!({ "liveSessionIds": live }),
                    );
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                ulog_info!("[sidecar] Terminal-event forwarder channel closed");
                break;
            }
        }
    }
}

/// Monitor all session sidecars and auto-restart dead ones that still have owners.
/// Recovery identity, retained owners, and retry clock all remain manager-owned;
/// this task is only a periodic dispatcher.
fn recovery_dispatch_candidates(
    manager: &mut SidecarManager,
    now: std::time::Instant,
    app_is_exiting: bool,
) -> Vec<String> {
    if app_is_exiting {
        Vec::new()
    } else {
        manager.due_session_recoveries(now)
    }
}

async fn begin_dead_session_recovery(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<(), String> {
    let drain = {
        let mut guard = manager.lock().map_err(|error| error.to_string())?;
        guard.prepare_session_sidecar_replacement(session_id)
    };
    let Some(drain) = drain else {
        return Ok(());
    };
    let drain = tauri::async_runtime::spawn_blocking(move || {
        drain.wait();
        drain
    })
    .await
    .map_err(|error| format!("Session recovery drain task failed: {error:?}"))?;
    let mut guard = manager.lock().map_err(|error| error.to_string())?;
    guard.finish_session_sidecar_replacement(&drain);
    Ok(())
}

/// Replace every live Xiaojing Session generation after a native credential
/// mutation. Owners stay attached to the logical Session while the old
/// generation is dispatch-closed and a child with the new secret is born.
#[cfg(windows)]
pub(crate) async fn restart_xiaojing_session_sidecars<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<usize, String> {
    let session_ids = {
        let guard = manager.lock().map_err(|error| error.to_string())?;
        let mut ids = guard
            .sidecars
            .iter()
            .filter(|(_, sidecar)| {
                crate::brand_workspace::is_brand_workspace_path(&sidecar.workspace_path)
            })
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        ids
    };

    let mut restarted = 0usize;
    for session_id in session_ids {
        let _lifecycle = acquire_session_lifecycle(&[&session_id]).await;
        begin_dead_session_recovery(manager, &session_id).await?;
        let restart_identity = {
            let guard = manager.lock().map_err(|error| error.to_string())?;
            guard.recovery_restart_identity(&session_id, std::time::Instant::now())
        };
        let Some(restart_identity) = restart_identity else {
            continue;
        };

        let recovery_epoch = restart_identity.epoch;
        let first_owner = restart_identity.owner;
        let workspace = restart_identity.workspace_path;
        let mgr = manager.clone();
        let app = app_handle.clone();
        let sid = session_id.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            ensure_session_sidecar(
                &app,
                &mgr,
                &sid,
                &workspace,
                first_owner,
                Some(recovery_epoch),
            )
        })
        .await
        .map_err(|error| format!("小鲸 Session 重启任务失败: {error}"))??;

        let installed = manager.lock().ok().is_some_and(|guard| {
            guard.is_live(&session_id, result.generation)
                && !guard.has_session_recovery(&session_id)
        });
        if !installed {
            return Err(format!("小鲸 Session {session_id} 的新凭据进程未能提交"));
        }
        restarted += 1;
        let _ = app_handle.emit(
            "session-sidecar:restarted",
            serde_json::json!({
                "sessionId": session_id,
                "port": result.port,
            }),
        );
    }
    Ok(restarted)
}

pub async fn monitor_session_sidecars(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 15;

    // Initial delay: let app fully start before monitoring
    tokio::time::sleep(Duration::from_secs(20)).await;
    ulog_info!("[sidecar] Session sidecar health monitor started");

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }
        let app_is_exiting = is_app_shutdown_in_progress();
        let session_ids = match manager.lock() {
            Ok(mut guard) => {
                recovery_dispatch_candidates(&mut guard, std::time::Instant::now(), app_is_exiting)
            }
            Err(_) => continue,
        };
        for session_id in session_ids {
            if shutdown.load(Relaxed) {
                break;
            }
            if is_app_shutdown_in_progress() {
                continue;
            }

            // Deletion and every owner-acquiring ensure use this same guard.
            // Keep it across take → blocking restart → install/restore so no
            // delete can observe the deliberate manager gap.
            let _lifecycle = acquire_session_lifecycle(&[&session_id]).await;

            if let Err(error) = begin_dead_session_recovery(&manager, &session_id).await {
                ulog_warn!(
                    "[sidecar-recovery] action=drain-failed session={} error={}",
                    session_id,
                    error
                );
                continue;
            }

            let restart_identity = {
                let guard = match manager.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                guard.recovery_restart_identity(&session_id, std::time::Instant::now())
            };
            let Some(restart_identity) = restart_identity else {
                continue;
            };
            ulog_info!(
                "[sidecar-recovery] action=dispatch session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms=0",
                session_id,
                restart_identity.epoch,
                restart_identity.dead_generation,
                restart_identity.prior_candidate_generation,
                restart_identity.attempt
            );
            // Retain the manager-owned recovery identity across replacement.
            let recovery_epoch = restart_identity.epoch;
            let dead_generation = restart_identity.dead_generation;
            let attempt = restart_identity.attempt;
            let first_owner = restart_identity.owner;
            let workspace = restart_identity.workspace_path;
            if crate::brand_workspace::is_brand_workspace_path(&workspace) {
                if let Some(workspace_id) = workspace.file_name().and_then(|value| value.to_str()) {
                    if let Err(error) = crate::geo_provider_runtime::global_geo_provider_limiter()
                        .retire_generation(workspace_id, &session_id, dead_generation)
                    {
                        ulog_warn!(
                            "[geo-provider] stale generation cleanup failed workspace={} session={} generation={} error={}",
                            workspace_id,
                            session_id,
                            dead_generation,
                            error
                        );
                    }
                    match crate::brand_workspace::production_store().and_then(|store| {
                        store.recover_geo_operations_for_sidecar_generation(
                            workspace_id,
                            &session_id,
                            dead_generation,
                        )
                    }) {
                        Ok(operations) if !operations.is_empty() => ulog_info!(
                            "[geo-recovery] sidecar_crash session={} dead_generation={} checkpointed_operations={}",
                            session_id,
                            dead_generation,
                            operations.len()
                        ),
                        Ok(_) => {}
                        Err(error) => ulog_warn!(
                            "[geo-recovery] sidecar_crash checkpoint failed session={} dead_generation={} error={}",
                            session_id,
                            dead_generation,
                            error
                        ),
                    }
                }
            }
            let mgr = manager.clone();
            let app = app_handle.clone();
            let sid = session_id.clone();

            let restart = tauri::async_runtime::spawn_blocking(move || {
                ensure_session_sidecar(
                    &app,
                    &mgr,
                    &sid,
                    &workspace,
                    first_owner,
                    Some(recovery_epoch),
                )
            })
            .await;

            match restart {
                Ok(Ok(result)) => {
                    let installed = manager.lock().ok().is_some_and(|guard| {
                        guard.is_live(&session_id, result.generation)
                            && !guard.has_session_recovery(&session_id)
                    });
                    if !installed {
                        continue;
                    }
                    ulog_info!(
                        "[sidecar-recovery] action=settled session={} epoch={} dead_generation={} candidate_generation={} attempt={} port={}",
                        session_id,
                        recovery_epoch,
                        dead_generation,
                        result.generation,
                        attempt,
                        result.port
                    );
                    let _ = app_handle.emit(
                        "session-sidecar:restarted",
                        serde_json::json!({
                            "sessionId": session_id,
                            "port": result.port,
                        }),
                    );
                }
                Ok(Err(e)) => {
                    ulog_error!(
                        "[sidecar-recovery] action=attempt-failed session={} epoch={} dead_generation={} attempt={} error={}",
                        session_id, recovery_epoch, dead_generation, attempt, e
                    );
                }
                Err(e) => {
                    let failure = manager.lock().ok().and_then(|mut guard| {
                        guard.record_session_recovery_failure(
                            &session_id,
                            Some(recovery_epoch),
                            std::time::Instant::now(),
                        )
                    });
                    ulog_error!(
                        "[sidecar-recovery] action=worker-failed session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={:?} error={}",
                        session_id,
                        recovery_epoch,
                        dead_generation,
                        failure.and_then(|value| value.candidate_generation),
                        attempt,
                        failure.map(|value| value.retry_after.as_millis()),
                        e
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod session_recovery_dispatch_tests {
    use super::recovery_dispatch_candidates;
    use crate::sidecar::{SidecarManager, SidecarOwner, SidecarState};

    #[test]
    fn app_exit_pauses_without_losing_active_or_recovering_work() {
        let mut manager = SidecarManager::new();
        manager.insert_test_ready_frontend_sidecar(
            "session-a",
            32001,
            SidecarOwner::Tab("tab-a".to_string()),
        );
        manager
            .get_session_sidecar_mut("session-a")
            .expect("sidecar")
            .state = SidecarState::Dead;
        let now = std::time::Instant::now();

        assert!(recovery_dispatch_candidates(&mut manager, now, true).is_empty());
        assert!(manager.sidecars.contains_key("session-a"));
        assert!(!manager.has_session_recovery("session-a"));

        assert_eq!(
            recovery_dispatch_candidates(&mut manager, now, false),
            vec!["session-a".to_string()]
        );
        manager.begin_session_sidecar_replacement("session-a");
        let epoch = manager
            .recovering_sidecars
            .get("session-a")
            .expect("manager-owned recovery")
            .epoch;
        let failure = manager
            .record_session_recovery_failure("session-a", Some(epoch), now)
            .expect("retry state");
        let retry_at = now + failure.retry_after;

        assert!(recovery_dispatch_candidates(&mut manager, retry_at, true).is_empty());
        assert!(manager.has_session_recovery("session-a"));
        assert_eq!(
            recovery_dispatch_candidates(&mut manager, retry_at, false),
            vec!["session-a".to_string()]
        );
    }
}
