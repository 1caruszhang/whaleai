use super::manager::SessionOwnerRelease;
use super::*;

pub(crate) type SessionLifecycleGuard = crate::keyed_lifecycle::KeyedLifecycleGuard;

static SESSION_LIFECYCLE_LOCKS: std::sync::OnceLock<
    crate::keyed_lifecycle::KeyedLifecycleRegistry,
> = std::sync::OnceLock::new();

pub(crate) async fn acquire_session_lifecycle(session_ids: &[&str]) -> SessionLifecycleGuard {
    SESSION_LIFECYCLE_LOCKS
        .get_or_init(crate::keyed_lifecycle::KeyedLifecycleRegistry::new)
        .acquire(session_ids)
        .await
}

/// Close one active generation under the manager lock, wait without that
/// lock, then move the exact process into manager-owned recovery state.
fn replace_session_sidecar_after_drain<'a>(
    manager: &'a ManagedSidecarManager,
    mut manager_guard: std::sync::MutexGuard<'a, SidecarManager>,
    session_id: &str,
) -> Result<std::sync::MutexGuard<'a, SidecarManager>, String> {
    let drain = manager_guard.prepare_session_sidecar_replacement(session_id);
    drop(manager_guard);
    if let Some(drain) = drain {
        drain.wait();
        manager_guard = manager.lock().map_err(|error| error.to_string())?;
        manager_guard.finish_session_sidecar_replacement(&drain);
        Ok(manager_guard)
    } else {
        manager.lock().map_err(|error| error.to_string())
    }
}

/// A concurrent last-owner release may leave a closed, ownerless entry visible
/// while its admitted request finishes. Ensure callers can help complete that
/// exact retirement before retrying, without inventing a second state owner.
fn finish_unowned_session_after_drain(
    manager: &ManagedSidecarManager,
    session_id: &str,
    drain: DispatchDrain,
) -> Result<(), String> {
    drain.wait();
    let retirement = {
        let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
        manager_guard.prepare_unowned_session_retirement(session_id)
    };
    if let Some(retirement) = retirement {
        retirement.wait();
        let retired = {
            let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
            manager_guard.finish_unowned_session_retirement(&retirement)
        };
        drop(retired);
    }
    Ok(())
}

pub(crate) async fn has_persisted_session_owner(session_id: &str) -> Result<bool, String> {
    crate::brand_workspace::has_active_post_publish_monitor_for_session(session_id)
}

// ============= Session-Centric Sidecar API =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
    /// Internal process identity used to commit replacement work. This is not
    /// part of the renderer/Tauri wire contract.
    #[serde(skip)]
    pub(crate) generation: u64,
}

/// Upper bound on ensure re-entry. The ensure path re-runs itself on
/// generation-change and concurrent-create (it must re-wait for `/health/ready`
/// rather than return a replacement port directly). This caps that re-entry so
/// a thrashing health monitor that keeps bumping the generation can't recurse
/// without a depth bound. Each attempt costs ≥2s (HTTP/readiness window), so 8
/// is generous — real churn settles in 1–2 (cross-review: all three reviewers
/// flagged the prior unbounded self-recursion).
const MAX_ENSURE_ATTEMPTS: u32 = 8;
const RECOVERY_ATTEMPT_STALE: &str = "RECOVERY_ATTEMPT_STALE";

/// Blocking ensure kernel. Callers must normally use the lifecycle-fenced
/// async wrapper below. The health monitor is the sole direct caller because
/// it already holds the lifecycle guard while preserving the dead owner object
/// across restart failure.
pub(crate) fn ensure_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    let _lifecycle_spawn_permit = begin_lifecycle_spawn_permit()?;
    let attempt_result = ensure_session_sidecar_attempt(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        0,
        expected_recovery_epoch,
    );
    let mut result = match attempt_result {
        Ok(result) => result,
        Err(error) => {
            if let Ok(mut manager_guard) = manager.lock() {
                if error != RECOVERY_ATTEMPT_STALE {
                    if let Some(failure) = manager_guard.record_session_recovery_failure(
                        session_id,
                        expected_recovery_epoch,
                        std::time::Instant::now(),
                    ) {
                        ulog_error!(
                            "[sidecar-recovery] action=retry-scheduled session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={} error={}",
                            session_id,
                            failure.epoch,
                            failure.dead_generation,
                            failure.candidate_generation,
                            failure.failed_attempts,
                            failure.retry_after.as_millis(),
                            error
                        );
                    }
                }
            }
            return Err(error);
        }
    };
    let should_commit = result.is_new
        || manager
            .lock()
            .map_err(|error| error.to_string())?
            .has_session_recovery(session_id);
    if should_commit {
        let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
        let Some(commit) = manager_guard.commit_ready_session_sidecar(session_id) else {
            let error = format!(
                "Session {} replacement on port {} lost lifecycle authority before commit",
                session_id, result.port
            );
            if let Some(failure) = manager_guard.record_session_recovery_failure(
                session_id,
                expected_recovery_epoch,
                std::time::Instant::now(),
            ) {
                ulog_error!(
                    "[sidecar-recovery] action=commit-rejected session={} epoch={} dead_generation={} candidate_generation={:?} attempt={} next_retry_ms={} error={}",
                    session_id,
                    failure.epoch,
                    failure.dead_generation,
                    failure.candidate_generation,
                    failure.failed_attempts,
                    failure.retry_after.as_millis(),
                    error
                );
            }
            return Err(error);
        };
        if commit.generation != result.generation || commit.port != result.port {
            result.port = commit.port;
            result.generation = commit.generation;
            result.is_new = false;
        }
    }
    Ok(result)
}

/// Async pit-of-success entrypoint for every owner-acquiring ensure.
///
/// The per-session lifecycle guard is held across the entire blocking ensure,
/// including readiness waits. Session deletion takes the same guard, so it
/// cannot validate an ownerless identity and then have this path recreate that
/// fixed identity immediately after deletion.
pub(crate) async fn ensure_session_sidecar_with_lifecycle<R: Runtime>(
    app_handle: AppHandle<R>,
    manager: ManagedSidecarManager,
    session_id: String,
    workspace_path: PathBuf,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    let lifecycle = Arc::new(acquire_session_lifecycle(&[&session_id]).await);
    let _lifecycle = lifecycle;
    let ensure_app_handle = app_handle.clone();
    let event_session_id = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        ensure_session_sidecar(
            &ensure_app_handle,
            &manager,
            &session_id,
            &workspace_path,
            owner,
            None,
        )
    })
    .await
    .map_err(|error| format!("ensure_session_sidecar blocking task failed: {error:?}"))??;

    // Every newly-created process starts a fresh liveRevision epoch. Renderer
    // consumers filter the event by their currently attached Session.
    if result.is_new {
        let _ = app_handle.emit(
            "session-sidecar:restarted",
            serde_json::json!({
                "sessionId": event_session_id,
                "port": result.port,
            }),
        );
    }
    Ok(result)
}

fn ensure_session_sidecar_attempt<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    attempt: u32,
    expected_recovery_epoch: Option<u64>,
) -> Result<EnsureSidecarResult, String> {
    if attempt >= MAX_ENSURE_ATTEMPTS {
        return Err(format!(
            "Session {} ensure exceeded {} attempts (sidecar generation churn not settling)",
            session_id, MAX_ENSURE_ATTEMPTS
        ));
    }
    if !crate::brand_workspace::is_brand_workspace_path(workspace_path) {
        return Err("Session workspace is outside Xiaojing BrandWorkspace".to_string());
    }
    ulog_info!(
        "[sidecar] ensure_session_sidecar called for session: {}, owner: {:?} (attempt {})",
        session_id,
        owner,
        attempt
    );
    let ensure_started = trace_start();
    let owner_for_trace = format!("{:?}", owner);
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_start")
            .session_id(Some(session_id))
            .detail("owner", &owner_for_trace),
    );

    // Ensure the file descriptor limit is high enough for the Node Sidecar.
    ensure_high_file_descriptor_limit();

    // Do not spawn while prior-instance cleanup still owns process authority.
    wait_for_startup_cleanup(Duration::from_secs(15))?;

    ulog_debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        ulog_error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    ulog_debug!("[sidecar] Manager lock acquired");
    if expected_recovery_epoch.is_some_and(|epoch| {
        !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
    }) {
        return Err(RECOVERY_ATTEMPT_STALE.to_string());
    }

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    let mut replace_existing = false;
    let existing_sidecar_info: Option<ExistingSidecarReuse> = {
        let generation = manager_guard.current_generation(session_id);
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_dead() {
                // Process exited, clean up
                ulog_info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                replace_existing = true;
                None
            } else if sidecar.is_reusable() {
                Some(ExistingSidecarReuse::Healthy {
                    port: sidecar.port,
                    generation,
                })
            } else if sidecar.is_starting() {
                // Starting — another thread is doing wait_for_health/readiness.
                // Add the owner now, then wait for /health/ready outside the lock.
                ulog_info!(
                    "[sidecar] Session {} Sidecar still starting on port {}, adding owner {:?}",
                    session_id,
                    sidecar.port,
                    owner
                );
                let owner_added = sidecar.add_owner(owner.clone());
                Some(ExistingSidecarReuse::Starting {
                    port: sidecar.port,
                    generation,
                    owner_added,
                })
            } else {
                Some(ExistingSidecarReuse::Draining(DispatchGate::close(
                    &sidecar.dispatch_gate,
                )))
            }
        } else {
            None
        }
    };
    if replace_existing {
        manager_guard = replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
    }

    // If we found a running sidecar, verify HTTP health (with lock released).
    // CRITICAL: The lock is dropped during the 2s HTTP check. Another thread (health monitor)
    // can replace the sidecar during this window. We use a generation counter to detect this
    // and avoid accidentally killing the healthy replacement.
    if let Some(existing) = existing_sidecar_info {
        let (port, pre_gen, wait_for_starting, joined_owner_added) = match existing {
            ExistingSidecarReuse::Healthy { port, generation } => (port, generation, false, false),
            ExistingSidecarReuse::Starting {
                port,
                generation,
                owner_added,
            } => (port, generation, true, owner_added),
            ExistingSidecarReuse::Draining(drain) => {
                drop(manager_guard);
                finish_unowned_session_after_drain(manager, session_id, drain)?;
                return ensure_session_sidecar_attempt(
                    app_handle,
                    manager,
                    session_id,
                    workspace_path,
                    owner,
                    attempt + 1,
                    expected_recovery_epoch,
                );
            }
        };
        drop(manager_guard);

        let check_started = trace_start();
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_start")
                .session_id(Some(session_id))
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );
        let http_healthy = if wait_for_starting {
            wait_for_readiness(port, 30).is_ok()
        } else {
            // Verify HTTP server is actually responsive (not just process alive)
            check_sidecar_http_health(port)
        };
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "reuse_check_end")
                .duration_ms(elapsed_ms(check_started))
                .session_id(Some(session_id))
                .status(if http_healthy { "ok" } else { "error" })
                .detail("port", port)
                .detail("starting", wait_for_starting),
        );

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if expected_recovery_epoch.is_some_and(|epoch| {
            !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
        }) {
            return Err(RECOVERY_ATTEMPT_STALE.to_string());
        }
        let post_gen = manager_guard.current_generation(session_id);

        if post_gen != pre_gen {
            // Generation changed: another thread replaced the sidecar during our HTTP check.
            // Re-enter the normal ensure path for the replacement instead of returning its
            // port directly. The replacement may still be Starting; the normal path knows
            // how to wait for /health/ready and also re-verifies Healthy sidecars over HTTP.
            ulog_info!(
                "[sidecar] Session {} generation changed ({} → {}) during HTTP check on port {}, checking replacement",
                session_id, pre_gen, post_gen, port
            );
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if !sidecar.is_dead() {
                    ulog_info!(
                        "[sidecar] Session {} replacement on port {} is {:?}, retrying ensure",
                        session_id,
                        sidecar.port,
                        sidecar.state
                    );
                    drop(manager_guard);
                    return ensure_session_sidecar_attempt(
                        app_handle,
                        manager,
                        session_id,
                        workspace_path,
                        owner,
                        attempt + 1,
                        expected_recovery_epoch,
                    );
                }
            }
            // Replacement sidecar process also dead — fall through to create
        } else if http_healthy {
            // Same generation, HTTP healthy — try to reuse
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port && sidecar.is_reusable() {
                    ulog_info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id,
                        port,
                        owner
                    );
                    sidecar.add_owner(owner.clone());
                    emit_perf_trace(
                        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                            .duration_ms(elapsed_ms(ensure_started))
                            .session_id(Some(session_id))
                            .status("ok")
                            .detail("port", port)
                            .detail("is_new", false)
                            .detail(
                                "reuse",
                                if wait_for_starting {
                                    "starting-ready"
                                } else {
                                    "healthy"
                                },
                            ),
                    );
                    return Ok(EnsureSidecarResult {
                        port,
                        is_new: false,
                        generation: pre_gen,
                    });
                } else if sidecar.port == port && wait_for_starting {
                    ulog_info!(
                        "[sidecar] Session {} starting Sidecar reached readiness on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    sidecar.state = SidecarState::Healthy;
                    sidecar.add_owner(owner.clone());
                    emit_perf_trace(
                        PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                            .duration_ms(elapsed_ms(ensure_started))
                            .session_id(Some(session_id))
                            .status("ok")
                            .detail("port", port)
                            .detail("is_new", false)
                            .detail("reuse", "starting-ready"),
                    );
                    return Ok(EnsureSidecarResult {
                        port,
                        is_new: false,
                        generation: pre_gen,
                    });
                }
            }
            // Sidecar gone but generation unchanged (removed without replacement)
            ulog_info!(
                "[sidecar] Session {} Sidecar removed during HTTP check, will create new",
                session_id
            );
        } else {
            if wait_for_starting {
                // We joined a sidecar that another owner was already starting.
                // Our independent readiness timeout must not kill or replace
                // that startup; the original creator may still be inside its
                // longer TCP+ready boot window. Detach only the owner we added.
                ulog_warn!(
                    "[sidecar] Session {} starting Sidecar on port {} did not become ready for joining owner {:?}; preserving original startup",
                    session_id, port, owner
                );
                // Only detach the owner if THIS call actually added it. When the
                // owner was already present (a same-owner concurrent ensure joined
                // the same Starting sidecar), `add_owner` returned false; removing
                // it here would empty the shared owner set and tear down a sidecar
                // the other caller is still legitimately starting (cross-review
                // security review Critical #2). Leave teardown to whoever truly owns it.
                let should_stop = if joined_owner_added {
                    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                        let (removed, last_owner_removed) = sidecar.remove_owner(&owner);
                        sidecar.port == port && removed && last_owner_removed
                    } else {
                        false
                    }
                } else {
                    false
                };
                if should_stop {
                    let retired = manager_guard.remove_sidecar(session_id);
                    manager_guard.clear_generation(session_id);
                    drop(manager_guard);
                    drop(retired);
                }
                return Err(format!(
                    "Session {} sidecar on port {} is still starting",
                    session_id, port
                ));
            }
            // Same generation, HTTP unhealthy — safe to remove (no one replaced it)
            ulog_warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard =
                replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
        }

        let result = create_new_session_sidecar(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            manager_guard,
            CreationAttempt {
                attempt,
                expected_recovery_epoch,
            },
        );
        if let Ok(ensure_result) = &result {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                    .duration_ms(elapsed_ms(ensure_started))
                    .session_id(Some(session_id))
                    .status("ok")
                    .detail("port", ensure_result.port)
                    .detail("is_new", ensure_result.is_new),
            );
        }
        return result;
    }

    // No existing sidecar found, create a new one with the original guard
    let result = create_new_session_sidecar(
        app_handle,
        manager,
        session_id,
        workspace_path,
        owner,
        manager_guard,
        CreationAttempt {
            attempt,
            expected_recovery_epoch,
        },
    );
    if let Ok(ensure_result) = &result {
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "ensure_done")
                .duration_ms(elapsed_ms(ensure_started))
                .session_id(Some(session_id))
                .status("ok")
                .detail("port", ensure_result.port)
                .detail("is_new", ensure_result.is_new),
        );
    }
    result
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
struct CreationAttempt {
    attempt: u32,
    expected_recovery_epoch: Option<u64>,
}

fn create_new_session_sidecar<'a, R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &'a ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'a, SidecarManager>,
    creation: CreationAttempt,
) -> Result<EnsureSidecarResult, String> {
    let boot_started = trace_start();

    // Guard against double-creation: if another thread already created a sidecar for this
    // session (e.g., health monitor raced with frontend), reuse it instead of spawning another.
    let mut replace_dead_existing = false;
    if let Some(existing) = manager_guard.sidecars.get_mut(session_id) {
        if !existing.is_dead() {
            ulog_info!(
                "[sidecar] Session {} already has a {:?} sidecar on port {} (created by another thread), retrying ensure",
                session_id, existing.state, existing.port
            );
            drop(manager_guard);
            return ensure_session_sidecar_attempt(
                app_handle,
                manager,
                session_id,
                workspace_path,
                owner,
                creation.attempt + 1,
                creation.expected_recovery_epoch,
            );
        }
        // Exists but process dead — remove before creating fresh
        replace_dead_existing = true;
    }
    if replace_dead_existing {
        manager_guard = replace_session_sidecar_after_drain(manager, manager_guard, session_id)?;
    }

    // Need to start a new Sidecar
    // First, find executables
    let node_path =
        find_node_executable(app_handle).ok_or_else(|| diagnose_node_not_found(app_handle))?;
    let script_path =
        find_server_script(app_handle).ok_or_else(|| "Server script not found".to_string())?;

    // Port probing has no lifecycle authority and may perform many socket
    // binds. The per-Session lifecycle guard held by the caller serializes
    // this Session while the shared manager lock is released.
    let port_allocator = manager_guard.port_allocator();
    drop(manager_guard);
    let port = allocate_sidecar_port(&port_allocator)?;
    let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
    if creation.expected_recovery_epoch.is_some_and(|epoch| {
        !manager_guard.recovery_attempt_is_authorized(session_id, epoch, &owner)
    }) {
        return Err(RECOVERY_ATTEMPT_STALE.to_string());
    }
    if manager_guard.sidecars.contains_key(session_id) {
        drop(manager_guard);
        return ensure_session_sidecar_attempt(
            app_handle,
            manager,
            session_id,
            workspace_path,
            owner,
            creation.attempt + 1,
            creation.expected_recovery_epoch,
        );
    }

    ulog_info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id,
        port,
        owner
    );

    // Build command (see sibling SessionSidecar path for the tsx-loader rationale)
    let mut cmd = crate::process_cmd::new(&node_path);
    append_sidecar_entrypoint_args(&mut cmd, &script_path, port);
    cmd.arg("--workspace-dir").arg(workspace_path);

    // Windows release builds are self-contained. Keep these paths as separate
    // environment values so Unicode, whitespace and percent signs are never
    // interpreted by a shell. Missing resources fail before a Session process
    // is created; there is no fallback to a user-installed Node or Git.
    #[cfg(target_os = "windows")]
    super::spawn::apply_windows_bundled_runtime(app_handle, &mut cmd)?;

    // Pass session_id to Node for real sessions (not pending-xxx)
    // so the Sidecar uses the same UUID as Rust/SDK during crash recovery.
    if !session_id.starts_with("pending-") {
        cmd.arg("--session-id").arg(session_id);
    }

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject the management API port for Sidecar → Rust control-plane IPC.
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("XIAOJING_MANAGEMENT_PORT", mgmt_port.to_string());
    }
    if let Some(data_root) = crate::app_dirs::xiaojing_data_dir() {
        cmd.env("XIAOJING_DATA_ROOT", data_root);
    }
    if crate::brand_workspace::is_brand_workspace_path(workspace_path) {
        // 票 06：admission 注入运营网关地址 + 账号 access token，替代旧
        // Provider 凭据注入路径；旧传输名在注入内逐一清除。
        crate::account_auth::inject_into_sidecar(&mut cmd)?;
        cmd.env("XIAOJING_MAIN_AGENT", "1");
        cmd.env(
            "XIAOJING_GEO_AUTONOMY_PROFILE",
            crate::geo_autonomy::read_geo_autonomy_profile(),
        );
    } else {
        crate::account_auth::scrub_account_admission(&mut cmd);
        cmd.env_remove("XIAOJING_MAIN_AGENT");
        cmd.env_remove("XIAOJING_GEO_AUTONOMY_PROFILE");
    }

    let sidecar_generation = manager_guard.next_generation(session_id);
    cmd.env("XIAOJING_SIDECAR_ID", session_id);
    cmd.env(
        "XIAOJING_SIDECAR_GENERATION",
        sidecar_generation.to_string(),
    );
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Spawn
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_start")
            .session_id(Some(session_id))
            .detail("owner", format!("{:?}", owner)),
    );
    let mut child = crate::process_cmd::spawn_tree(&mut cmd).map_err(|e| {
        manager_guard.clear_generation(session_id);
        ulog_error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_failed")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .status("error")
                .detail("error", e.to_string()),
        );
        format!("Failed to spawn sidecar: {}", e)
    })?;
    emit_perf_trace(
        PerfTrace::new(PerfTraceName::SidecarBoot, "spawned")
            .duration_ms(elapsed_ms(boot_started))
            .session_id(Some(session_id))
            .status("ok")
            .detail("port", port),
    );

    // Capture stdout/stderr → 写入统一日志
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut node_logger_active = false;
            for line in reader.lines().map_while(Result::ok) {
                // Once Node's unified logger is initialized, console output is
                // written directly to the unified log file. Only pre-logger
                // startup lines need to be forwarded from stdout.
                if !node_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        node_logger_active = true;
                    }
                    ulog_info!("[node-out][session:{}] {}", session_id_for_log, line);
                }
                // After logger init, drop stdout to avoid duplicate log entries.
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                match classify_sidecar_stderr(&line) {
                    SidecarStderrLevel::Info => {
                        ulog_info!("[node-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Warn => {
                        ulog_warn!("[node-err][session:{}] {}", session_id_for_log, line)
                    }
                    SidecarStderrLevel::Error => {
                        ulog_error!("[node-err][session:{}] {}", session_id_for_log, line)
                    }
                }
            }
        });
    }

    // Check if the process already exited (non-blocking poll). No pre-sleep;
    // the health-loop's alive_check catches any crash this probe misses.
    if let Ok(Some(status)) = child.try_wait() {
        manager_guard.clear_generation(session_id);
        thread::sleep(Duration::from_millis(100));
        ulog_error!(
            "[sidecar] SessionSidecar exited immediately with status: {:?}",
            status
        );
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_node(&status, &node_path);
        let diag = diagnose_immediate_exit(&status, &node_path);
        emit_perf_trace(
            PerfTrace::new(PerfTraceName::SidecarBoot, "spawn_immediate_exit")
                .duration_ms(elapsed_ms(boot_started))
                .session_id(Some(session_id))
                .status("error")
                .detail("status", format!("{:?}", status)),
        );
        return Err(diag);
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        management_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        state: SidecarState::Starting,
        owners,
        completion_claims: HashSet::new(),
        dispatch_gate: DispatchGate::new(),
        created_at: std::time::Instant::now(),
    };

    manager_guard.insert_sidecar_at_generation(session_id, sidecar_generation, sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure for session sidecar
    let liveness_manager = manager.clone();
    let liveness_session_id = session_id.to_string();
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(sidecar) = guard.sidecars.get_mut(&liveness_session_id) {
                matches!(sidecar.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health (TCP up). Then wait for /health/ready (deferred init
    // complete) so renderer-driven session startup gates on actual readiness,
    // not just liveness. GEO monitoring can acquire its owner only after the
    // same readiness fence has settled.
    let health_started = trace_start();
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .status("ok")
                    .detail("port", port),
            );
            // Pattern 4: tighten the renderer-driven session sidecar startup
            // to wait for /health/ready as well. 30s timeout matches existing
            // long-running migration / SDK init budgets.
            let readiness_started = trace_start();
            if let Err(e) = wait_for_readiness(port, 30) {
                ulog_error!(
                    "[sidecar] Session {} /health/ready failed: {}",
                    session_id,
                    e
                );
                emit_perf_trace(
                    PerfTrace::new(PerfTraceName::SidecarBoot, "ready_failed")
                        .duration_ms(elapsed_ms(readiness_started))
                        .session_id(Some(session_id))
                        .status("error")
                        .detail("port", port)
                        .detail("error", &e),
                );
                let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
                let port_matches = manager_guard
                    .sidecars
                    .get(session_id)
                    .map(|s| s.port == port)
                    .unwrap_or(false);
                let retired = port_matches
                    .then(|| manager_guard.remove_sidecar(session_id))
                    .flatten();
                drop(manager_guard);
                drop(retired);
                return Err(e);
            }
            // Mark as healthy — verify port to avoid mutating a replacement sidecar
            // that was created by another thread (e.g., health monitor) during the wait.
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port {
                    sidecar.state = SidecarState::Healthy;
                } else {
                    ulog_warn!(
                        "[sidecar] Session {} sidecar replaced during wait_for_health (expected port {}, found {}), skipping Healthy transition",
                        session_id, port, sidecar.port
                    );
                }
            }
            ulog_info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id,
                port
            );
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "ready_ok")
                    .duration_ms(elapsed_ms(boot_started))
                    .session_id(Some(session_id))
                    .status("ok")
                    .detail("port", port),
            );
            Ok(EnsureSidecarResult {
                port,
                is_new: true,
                generation: sidecar_generation,
            })
        }
        Err(e) => {
            ulog_error!("[sidecar] SessionSidecar health check failed: {}", e);
            emit_perf_trace(
                PerfTrace::new(PerfTraceName::SidecarBoot, "tcp_live_failed")
                    .duration_ms(elapsed_ms(health_started))
                    .session_id(Some(session_id))
                    .status("error")
                    .detail("port", port)
                    .detail("error", &e),
            );
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            // Verify port before acting — another thread may have replaced the sidecar
            let port_matches = manager_guard
                .sidecars
                .get(session_id)
                .map(|s| s.port == port)
                .unwrap_or(false);
            let retired = if port_matches {
                // Check exit status and fence a repeatedly crashing bundled Node.
                #[cfg(target_os = "windows")]
                if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                    if let Ok(Some(status)) = sidecar.process.try_wait() {
                        maybe_mark_crashed_node(&status, &node_path);
                    }
                }
                // Remove the failed sidecar (ours, not a replacement)
                manager_guard.remove_sidecar(session_id)
            } else {
                ulog_warn!(
                    "[sidecar] Session {} sidecar replaced during wait_for_health (port {}), skipping removal",
                    session_id, port
                );
                None
            };
            drop(manager_guard);
            drop(retired);
            Err(e)
        }
    }
}

pub(crate) fn finish_session_owner_release(
    manager: &ManagedSidecarManager,
    release: SessionOwnerRelease,
) -> Result<(bool, bool), String> {
    let SessionOwnerRelease {
        removed,
        stopped,
        drain,
    } = release;
    if let Some(drain) = drain {
        drain.wait();
        let retired = {
            let mut manager_guard = manager
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            manager_guard.finish_unowned_session_retirement(&drain)
        };
        drop(retired);
    }
    Ok((removed, stopped))
}

pub fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let release = {
        let mut manager_guard = manager
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        manager_guard.remove_session_owner(session_id, owner)
    };
    let (removed, stopped) = finish_session_owner_release(manager, release)?;
    if removed {
        ulog_info!(
            "[sidecar] Released owner {:?} from session {}; stopped={}",
            owner,
            session_id,
            stopped
        );
        Ok(stopped)
    } else {
        Ok(false)
    }
}

fn is_canonical_session_id(session_id: &str) -> bool {
    (1..=99).contains(&session_id.len())
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_ensure_session_sidecar(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    workspacePath: String,
    ownerType: String,
    ownerId: String,
) -> Result<EnsureSidecarResult, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        _ => return Err(format!("Invalid owner type: {ownerType}")),
    };
    ensure_session_sidecar_with_lifecycle(
        app_handle,
        state.inner().clone(),
        sessionId,
        PathBuf::from(workspacePath),
        owner,
    )
    .await
}

/// Check whether a session identity must remain stable after a Tab detaches.
/// Includes live background owners and durable GEO monitoring state. The
/// refusal names the user-facing reason (`busy-replying` for live reply
/// activity, `monitor-active` for durable post-publish monitor ownership) so
/// the renderer can route the deletion dialog copy per cause.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPersistentOwnersResult {
    has_persistent_owners: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_session_has_persistent_owners(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<SessionPersistentOwnersResult, String> {
    let sidecars = state.inner().clone();
    let live_reason = {
        let manager = sidecars.lock().unwrap_or_else(|e| e.into_inner());
        manager.session_persistent_owner_reason(&sessionId)
    };
    if let Some(reason) = live_reason {
        return Ok(SessionPersistentOwnersResult {
            has_persistent_owners: true,
            reason: Some(reason),
        });
    }
    if has_persisted_session_owner(&sessionId).await? {
        return Ok(SessionPersistentOwnersResult {
            has_persistent_owners: true,
            reason: Some("monitor-active"),
        });
    }
    Ok(SessionPersistentOwnersResult {
        has_persistent_owners: false,
        reason: None,
    })
}

/// Delete a transcript while releasing only the exact mounted Tab owners named
/// by App. The per-Session lifecycle guard stays held across owner validation,
/// the local DELETE, and successful owner release, so every refusal preserves
/// both storage and the mounted owner set.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeleteCommandResult {
    deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl SessionDeleteCommandResult {
    fn deleted() -> Self {
        Self {
            deleted: true,
            reason: None,
        }
    }

    fn refused(reason: &'static str) -> Self {
        Self {
            deleted: false,
            reason: Some(reason),
        }
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_delete_session_if_unowned(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    releasableTabIds: Vec<String>,
    brandWorkspaceId: Option<String>,
    brandDeletionConfirmationToken: Option<String>,
) -> Result<SessionDeleteCommandResult, String> {
    if !is_canonical_session_id(&sessionId) {
        return Ok(SessionDeleteCommandResult::refused("invalid-session-id"));
    }
    if has_persisted_session_owner(&sessionId).await? {
        return Ok(SessionDeleteCommandResult::refused("monitor-active"));
    }
    let _lifecycle = acquire_session_lifecycle(&[&sessionId]).await;
    if has_persisted_session_owner(&sessionId).await? {
        return Ok(SessionDeleteCommandResult::refused("monitor-active"));
    }
    let sidecars = state.inner().clone();
    let releasable_tab_ids = releasableTabIds.into_iter().collect::<HashSet<_>>();

    tauri::async_runtime::spawn_blocking(move || {
        let session_port = {
            let manager = sidecars.lock().map_err(|error| error.to_string())?;
            if let Some(reason) =
                manager.session_unreleasable_owner_reason(&sessionId, &releasable_tab_ids)
            {
                return Ok(SessionDeleteCommandResult::refused(reason));
            }
            manager
                .get_session_sidecar(&sessionId)
                .filter(|sidecar| sidecar.is_reusable())
                .map(|sidecar| sidecar.port)
        };
        if let Some(port) = session_port {
            match super::background::check_sidecar_is_busy(port) {
                Some(false) => {}
                Some(true) => return Ok(SessionDeleteCommandResult::refused("busy-replying")),
                None => return Ok(SessionDeleteCommandResult::refused("activity-unavailable")),
            }
        }

        // The activity request intentionally runs without the manager lock.
        // Revalidate owners before the storage mutation while the outer
        // per-Session lifecycle fence still excludes new owner acquisition.
        let manager = sidecars.lock().map_err(|error| error.to_string())?;
        if let Some(reason) =
            manager.session_unreleasable_owner_reason(&sessionId, &releasable_tab_ids)
        {
            return Ok(SessionDeleteCommandResult::refused(reason));
        }
        drop(manager);
        let brand_deletion = match (
            brandWorkspaceId.as_deref(),
            brandDeletionConfirmationToken.as_deref(),
        ) {
            (Some(workspace_id), Some(confirmation_token)) => {
                let store = crate::brand_workspace::production_store()?;
                store.admit_session_deletion(workspace_id, &sessionId, confirmation_token)?;
                Some((store, workspace_id, confirmation_token))
            }
            (None, None) => None,
            _ => return Err("Brand deletion requires workspace and confirmation token".into()),
        };
        let cancel_brand_admission = || {
            if let Some((store, workspace_id, confirmation_token)) = &brand_deletion {
                if let Err(error) = store.cancel_session_deletion_admission(
                    workspace_id,
                    &sessionId,
                    confirmation_token,
                ) {
                    ulog_warn!("[brand-workspace] failed to cancel deletion admission: {error}");
                }
            }
        };
        let result = match crate::session_metadata::delete_session_storage(&sessionId) {
            Ok(true) => SessionDeleteCommandResult::deleted(),
            Ok(false) => SessionDeleteCommandResult::refused("not-found"),
            Err(error) => {
                cancel_brand_admission();
                return Err(error);
            }
        };
        if let Some((store, workspace_id, confirmation_token)) = &brand_deletion {
            store.mark_session_transcript_deleted(workspace_id, &sessionId, confirmation_token)?;
            store.finalize_session_deletion(workspace_id, &sessionId, confirmation_token)?;
        }

        // Success and not-found are both terminal/idempotent outcomes. Release
        // only the App-authorized Tab owners after storage has reached that
        // terminal state; every refusal above leaves them untouched.
        let releases = {
            let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
            releasable_tab_ids
                .iter()
                .map(|tab_id| manager.release_tab_session(&sessionId, tab_id, false))
                .collect::<Vec<_>>()
        };
        for release in releases {
            finish_session_owner_release(&sidecars, release)?;
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("Session deletion task failed: {error:?}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandReleasableTab {
    pub session_id: String,
    pub tab_id: String,
}

/// Brand-level deletion: remove every Session transcript of the workspace,
/// stop its Sidecars, drop the catalog entry, and delete the workspace
/// directory. Refusals mirror `cmd_delete_session_if_unowned` — the same
/// persisted-owner, unreleasable-owner and busy-Sidecar predicates — applied
/// to every Session the brand DB lists.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_brand_workspace_delete(
    state: tauri::State<'_, ManagedSidecarManager>,
    workspaceId: String,
    confirmationToken: String,
    releasableTabs: Vec<BrandReleasableTab>,
) -> Result<SessionDeleteCommandResult, String> {
    let store = crate::brand_workspace::production_store()?;
    let session_ids = store.workspace_session_ids(&workspaceId)?;
    if session_ids.iter().any(|id| !is_canonical_session_id(id)) {
        return Ok(SessionDeleteCommandResult::refused("invalid-session-id"));
    }
    // Preflight before the fence only preserves already-mounted state on
    // refusal; every mutation below re-validates under the lifecycle fence.
    for session_id in &session_ids {
        if has_persisted_session_owner(session_id).await? {
            return Ok(SessionDeleteCommandResult::refused("in-use"));
        }
    }
    let session_refs = session_ids.iter().map(String::as_str).collect::<Vec<_>>();
    let _lifecycle = acquire_session_lifecycle(&session_refs).await;
    for session_id in &session_ids {
        if has_persisted_session_owner(session_id).await? {
            return Ok(SessionDeleteCommandResult::refused("in-use"));
        }
    }
    let sidecars = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let releasable_per_session = releasableTabs.into_iter().fold(
            std::collections::HashMap::<String, std::collections::HashSet<String>>::new(),
            |mut map, tab| {
                map.entry(tab.session_id).or_default().insert(tab.tab_id);
                map
            },
        );
        let ports = {
            let manager = sidecars.lock().map_err(|error| error.to_string())?;
            for session_id in &session_ids {
                let releasable = releasable_per_session
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default();
                if manager.session_has_unreleasable_owners(session_id, &releasable) {
                    return Ok(SessionDeleteCommandResult::refused("in-use"));
                }
            }
            session_ids
                .iter()
                .filter_map(|session_id| {
                    manager
                        .get_session_sidecar(session_id)
                        .filter(|sidecar| sidecar.is_reusable())
                        .map(|sidecar| sidecar.port)
                })
                .collect::<Vec<_>>()
        };
        // The activity request intentionally runs without the manager lock.
        for port in ports {
            match super::background::check_sidecar_is_busy(port) {
                Some(false) => {}
                Some(true) => return Ok(SessionDeleteCommandResult::refused("in-use")),
                None => return Ok(SessionDeleteCommandResult::refused("activity-unavailable")),
            }
        }
        // Revalidate owners before the storage mutation while the outer
        // per-Session lifecycle fence still excludes new owner acquisition.
        {
            let manager = sidecars.lock().map_err(|error| error.to_string())?;
            for session_id in &session_ids {
                let releasable = releasable_per_session
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default();
                if manager.session_has_unreleasable_owners(session_id, &releasable) {
                    return Ok(SessionDeleteCommandResult::refused("in-use"));
                }
            }
        }
        store.admit_workspace_deletion(&workspaceId, &confirmationToken)?;
        let cancel_admission = || {
            if let Err(error) =
                store.cancel_workspace_deletion_admission(&workspaceId, &confirmationToken)
            {
                crate::ulog_warn!(
                    "[brand-workspace] failed to cancel brand deletion admission: {error}"
                );
            }
        };
        for session_id in &session_ids {
            if let Err(error) = crate::session_metadata::delete_session_storage(session_id) {
                cancel_admission();
                return Err(error);
            }
        }
        // Release the App-authorized Tab owners before removing the workspace
        // directory so every matching Sidecar process has stopped first.
        let releases = {
            let mut manager = sidecars.lock().map_err(|error| error.to_string())?;
            let mut releases = Vec::new();
            for (session_id, tab_ids) in releasable_per_session {
                for tab_id in tab_ids {
                    releases.push(manager.release_tab_session(&session_id, &tab_id, false));
                }
            }
            releases
        };
        for release in releases {
            finish_session_owner_release(&sidecars, release)?;
        }
        if let Err(error) = store.finalize_workspace_deletion(&workspaceId, &confirmationToken) {
            cancel_admission();
            return Err(error);
        }
        Ok(SessionDeleteCommandResult::deleted())
    })
    .await
    .map_err(|error| format!("Brand workspace deletion task failed: {error:?}"))?
}

/// Release a Tab owner under the Session lifecycle guard. This prevents a
/// newly-created persistent owner from landing between the renderer-side
/// presence check and owner removal.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_release_tab_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: String,
) -> Result<bool, String> {
    let _lifecycle = acquire_session_lifecycle(&[&sessionId]).await;
    let has_persisted_owner = has_persisted_session_owner(&sessionId).await?;
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let release = {
            let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
            manager_guard.release_tab_session(&sessionId, &tabId, has_persisted_owner)
        };
        let (removed, stopped) = finish_session_owner_release(&manager, release)?;
        Ok(removed && stopped)
    })
    .await
    .map_err(|error| format!("Tab Session release task failed: {error:?}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_can_restore_session(sessionId: String, workspacePath: String) -> bool {
    if crate::workspace_files::path_safety::validate_workspace_root(&workspacePath).is_err()
        || !crate::brand_workspace::is_brand_workspace_path(std::path::Path::new(&workspacePath))
    {
        return false;
    }
    let Some(path) = crate::app_dirs::xiaojing_data_dir().map(|root| root.join("sessions.json"))
    else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(sessions) =
        serde_json::from_str::<serde_json::Value>(crate::utils::bom::strip_bom(&content))
    else {
        return false;
    };
    sessions.as_array().is_some_and(|items| {
        items.iter().any(|session| {
            session.get("id").and_then(serde_json::Value::as_str) == Some(&sessionId)
                && session
                    .get("workspacePath")
                    .and_then(serde_json::Value::as_str)
                    == Some(&workspacePath)
        })
    })
}

#[cfg(test)]
mod session_lifecycle_tests {
    use super::{
        acquire_session_lifecycle, is_canonical_session_id, EnsureSidecarResult,
        SessionDeleteCommandResult, SessionPersistentOwnersResult,
    };
    use std::time::Duration;

    #[test]
    fn deletion_accepts_only_one_canonical_session_path_segment() {
        assert!(is_canonical_session_id(
            "11111111-2222-4333-8444-555555555555"
        ));
        assert!(is_canonical_session_id("pending-tab-123"));

        for invalid in [
            "",
            "owned?shadow",
            "owned#shadow",
            "owned/shadow",
            "owned\\shadow",
            "owned_shadow",
            "owned%2Fshadow",
        ] {
            assert!(!is_canonical_session_id(invalid), "accepted {invalid:?}");
        }
        assert!(!is_canonical_session_id(&"a".repeat(100)));
    }

    #[test]
    fn deletion_result_preserves_machine_readable_refusal_reasons() {
        assert_eq!(
            serde_json::to_value(SessionDeleteCommandResult::deleted()).unwrap(),
            serde_json::json!({ "deleted": true })
        );
        for reason in ["in-use", "busy-replying", "monitor-active"] {
            assert_eq!(
                serde_json::to_value(SessionDeleteCommandResult::refused(reason)).unwrap(),
                serde_json::json!({ "deleted": false, "reason": reason })
            );
        }
    }

    #[test]
    fn persistent_owners_result_names_the_blocking_reason() {
        assert_eq!(
            serde_json::to_value(SessionPersistentOwnersResult {
                has_persistent_owners: false,
                reason: None,
            })
            .unwrap(),
            serde_json::json!({ "hasPersistentOwners": false })
        );
        assert_eq!(
            serde_json::to_value(SessionPersistentOwnersResult {
                has_persistent_owners: true,
                reason: Some("monitor-active"),
            })
            .unwrap(),
            serde_json::json!({
                "hasPersistentOwners": true,
                "reason": "monitor-active",
            })
        );
    }

    #[test]
    fn ensure_result_process_generation_is_not_part_of_public_wire_shape() {
        assert_eq!(
            serde_json::to_value(EnsureSidecarResult {
                port: 32001,
                is_new: true,
                generation: 42,
            })
            .unwrap(),
            serde_json::json!({ "port": 32001, "isNew": true })
        );
    }

    #[tokio::test]
    async fn lifecycle_lock_serializes_one_session_without_blocking_another() {
        let suffix = uuid::Uuid::new_v4();
        let first_session = format!("lifecycle-first-{suffix}");
        let other_session = format!("lifecycle-other-{suffix}");
        let first_guard = acquire_session_lifecycle(&[&first_session]).await;

        let (same_tx, same_rx) = tokio::sync::oneshot::channel();
        let same_session = first_session.clone();
        let same_task = tauri::async_runtime::spawn(async move {
            let _guard = acquire_session_lifecycle(&[&same_session]).await;
            let _ = same_tx.send(());
        });
        assert!(tokio::time::timeout(Duration::from_millis(50), same_rx)
            .await
            .is_err());

        let (other_tx, other_rx) = tokio::sync::oneshot::channel();
        let other_task = tauri::async_runtime::spawn(async move {
            let _guard = acquire_session_lifecycle(&[&other_session]).await;
            let _ = other_tx.send(());
        });
        tokio::time::timeout(Duration::from_secs(1), other_rx)
            .await
            .expect("another session must not be blocked")
            .expect("other-session sender must stay alive");

        drop(first_guard);
        tokio::time::timeout(Duration::from_secs(1), same_task)
            .await
            .expect("same-session waiter must proceed after release")
            .expect("same-session task must complete");
        other_task.await.expect("other-session task must complete");
    }
}
