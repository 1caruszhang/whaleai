// Sidecar process management module
// Handles spawning, monitoring, and shutting down one Node Sidecar per Session.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
#[cfg(unix)]
use std::sync::Once;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::perf_trace::{elapsed_ms, emit_perf_trace, trace_start, PerfTrace, PerfTraceName};
use crate::process_cmd::ChildTree;
use crate::proxy_config;

pub(crate) mod background;
pub(crate) mod cleanup;
pub(crate) mod commands;
pub(crate) mod health;
pub(crate) mod instances;
pub(crate) mod manager;
pub(crate) mod session_lifecycle;
pub(crate) mod shutdown;
pub(crate) mod spawn;
pub(crate) mod stdio;
pub(crate) mod types;

use background::check_sidecar_session_state;
#[allow(unused_imports)]
pub use background::{
    cancel_background_completion, cmd_cancel_background_completion, cmd_get_background_sessions,
    cmd_start_background_completion, start_background_completion, BackgroundCompletionResult,
};
pub use cleanup::{
    cleanup_stale_sidecars, init_startup_cleanup_barrier, mark_startup_cleanup_done,
    recover_proxy_spills_after_startup_cleanup, wait_for_startup_cleanup,
};
#[allow(unused_imports)]
pub use commands::cmd_reconcile_session_tab_activation;
use health::{check_sidecar_http_health, wait_for_health, wait_for_readiness};
pub use instances::{
    forward_terminal_events_to_renderer, monitor_session_sidecars, monitor_turn_wake_lock,
};
#[allow(unused_imports)]
pub use manager::create_sidecar_manager;
pub(crate) use manager::FrontendSidecarBinding;
pub use manager::{ManagedSidecarManager, SidecarManager};
pub(crate) use session_lifecycle::{
    acquire_session_lifecycle, ensure_session_sidecar, ensure_session_sidecar_with_lifecycle,
    finish_session_owner_release,
};
#[allow(unused_imports)]
pub use session_lifecycle::{
    cmd_delete_session_if_unowned, cmd_ensure_session_sidecar, cmd_release_tab_session,
    cmd_session_has_persistent_owners, release_session_sidecar, EnsureSidecarResult,
};
pub use shutdown::{
    begin_app_exit_shutdown, begin_lifecycle_spawn_permit, is_app_shutdown_in_progress,
    stop_all_sidecars,
};
pub(crate) use spawn::normalize_external_path;
use spawn::{
    diagnose_immediate_exit, diagnose_node_not_found, find_node_executable, find_server_script,
    is_port_available,
};
pub(crate) use stdio::{classify_sidecar_stderr, SidecarStderrLevel};
#[allow(unused_imports)]
pub use types::SidecarInfo;
use types::{sidecar_removal_event_policy, ExistingSidecarReuse};

/// Probe the next process-wide Sidecar port without retaining lifecycle state.
/// Callers clone the allocator handle while the manager is locked, then perform
/// the bounded socket probes after releasing that lock.
pub(crate) fn allocate_sidecar_port(counter: &AtomicU16) -> Result<u16, String> {
    const MAX_ATTEMPTS: u32 = 200;

    for _ in 0..MAX_ATTEMPTS {
        let port = next_sidecar_port_candidate(counter);
        if is_port_available(port) {
            return Ok(port);
        }
    }

    Err(format!(
        "No available port found after {} attempts",
        MAX_ATTEMPTS
    ))
}

fn next_sidecar_port_candidate(counter: &AtomicU16) -> u16 {
    let mut observed = counter.load(Ordering::SeqCst);
    loop {
        let candidate = if (BASE_PORT..=BASE_PORT + PORT_RANGE).contains(&observed) {
            observed
        } else {
            BASE_PORT
        };
        let next = if candidate == BASE_PORT + PORT_RANGE {
            BASE_PORT
        } else {
            candidate + 1
        };
        match counter.compare_exchange(observed, next, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return candidate,
            Err(actual) => observed = actual,
        }
    }
}
pub(crate) use types::{
    DispatchDrain, DispatchGate, DispatchLease, SessionCompletionClaim, SessionGenerationDrain,
    SidecarRetirement,
};
pub use types::{SessionSidecar, SidecarOwner, SidecarState};

// Ensure file descriptor limit is increased only once (unix only)
#[cfg(unix)]
static RLIMIT_INIT: Once = Once::new();

/// Increase the file descriptor limit for the long-lived Node Sidecar.
/// This is especially important on macOS where the default soft limit is often 2560
#[cfg(unix)]
fn ensure_high_file_descriptor_limit() {
    RLIMIT_INIT.call_once(|| {
        use libc::{getrlimit, setrlimit, rlimit, RLIMIT_NOFILE};

        unsafe {
            let mut rlim = rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };

            // Get current limits
            if getrlimit(RLIMIT_NOFILE, &mut rlim) == 0 {
                let old_soft = rlim.rlim_cur;
                let hard_limit = rlim.rlim_max;

                // Only increase if current soft limit is below a reasonable threshold
                // Target: at least 65536, or hard limit if lower
                let target = std::cmp::min(65536, hard_limit);

                if old_soft < target {
                    rlim.rlim_cur = target;

                    if setrlimit(RLIMIT_NOFILE, &rlim) == 0 {
                        ulog_info!(
                            "[sidecar] Increased file descriptor limit: {} -> {} (hard limit: {})",
                            old_soft, target, hard_limit
                        );
                    } else {
                        ulog_warn!(
                            "[sidecar] Failed to increase file descriptor limit (current: {}, target: {})",
                            old_soft, target
                        );
                    }
                } else {
                    ulog_info!(
                        "[sidecar] File descriptor limit already sufficient: {} (hard: {})",
                        old_soft, hard_limit
                    );
                }
            } else {
                ulog_warn!("[sidecar] Failed to get current file descriptor limit");
            }
        }
    });
}

#[cfg(not(unix))]
fn ensure_high_file_descriptor_limit() {
    // No-op on non-Unix systems
}

// Configuration constants
const BASE_PORT: u16 = 31415;
// Health check: exponential backoff 50ms → 500ms, capped. Wall-clock ceiling ≈ 5 min.
// Node cold start is ~2s (tsx boot + module load), so the first 5 attempts at
// 50/100/200/400/500ms (cumulative 1.25s) usually arrive before listen — cheap,
// no-ops. Attempts 6+ poll at 500ms to accommodate Windows Defender first-run
// scanning (20-30s hold) without burning CPU.
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 600;
const HEALTH_CHECK_DELAY_CAP_MS: u64 = 500;
const HEALTH_CHECK_DELAY_START_MS: u64 = 50;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 100;
// HTTP health check for existing sidecar.
// 2000ms accommodates Windows systems under startup load.
const HTTP_HEALTH_CHECK_TIMEOUT_MS: u64 = 2000;
// Port range: 500 ports (31415-31914)
const PORT_RANGE: u16 = 500;
// Process identification marker (used to identify our sidecar processes)
// This marker is added to all sidecar commands for reliable process identification
const SIDECAR_MARKER: &str = "--xiaojing-sidecar";
/// Append the canonical Session Sidecar entrypoint argv.
fn append_sidecar_entrypoint_args(
    cmd: &mut std::process::Command,
    script_path: &std::path::Path,
    port: u16,
) {
    if script_path.extension().and_then(|s| s.to_str()) == Some("ts") {
        cmd.arg("--import").arg("tsx/esm");
    }
    cmd.arg(script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER);
}

// ===== Crashed Node Tracking =====
// When a bundled Node.js crashes with STATUS_ACCESS_VIOLATION (0xC0000005) on Windows —
// usually a missing VC++ runtime DLL or some AV-injection incompatibility — mark it as
// crashed so subsequent spawn attempts fail closed instead of repeatedly launching it.
static CRASHED_NODE_PATHS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[allow(dead_code)] // Only called from #[cfg(windows)] blocks; harmless on other platforms
fn mark_node_as_crashed(path: &std::path::Path) {
    let normalized = normalize_external_path(path.to_path_buf());
    // unwrap_or_else recovers from Mutex poisoning — the body is trivial (Vec::push),
    // so the data is still consistent even if a previous holder panicked.
    let mut paths = CRASHED_NODE_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    if !paths.iter().any(|p| p == &normalized) {
        paths.push(normalized.clone());
        ulog_warn!(
            "[sidecar] Marked node as crashed (will try system fallback on next attempt): {:?}",
            normalized
        );
    }
}

fn is_node_crashed(path: &std::path::Path) -> bool {
    let normalized = normalize_external_path(path.to_path_buf());
    let paths = CRASHED_NODE_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    paths.iter().any(|x| x == &normalized)
}

/// On Windows, check if the process exited with STATUS_ACCESS_VIOLATION (0xC0000005)
/// and mark the bundled Node binary as crashed for this process lifetime.
#[cfg(target_os = "windows")]
fn maybe_mark_crashed_node(status: &std::process::ExitStatus, node_path: &std::path::Path) {
    let code = status.code().unwrap_or(0) as u32;
    if code == 0xc0000005 {
        mark_node_as_crashed(node_path);
    }
}

// ===== Proxy Configuration =====
// Default values (must match TypeScript PROXY_DEFAULTS in types.ts)
// Proxy configuration is now managed by the shared proxy_config module
// See src/proxy_config.rs for implementation details

#[cfg(test)]
mod sidecar_entrypoint_tests {
    use super::{
        append_sidecar_entrypoint_args, next_sidecar_port_candidate, BASE_PORT, PORT_RANGE,
    };
    use std::path::Path;

    #[test]
    fn concurrent_port_candidate_wrap_never_rolls_the_counter_back() {
        let counter =
            std::sync::Arc::new(std::sync::atomic::AtomicU16::new(BASE_PORT + PORT_RANGE));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
        let threads = (0..16)
            .map(|_| {
                let counter = std::sync::Arc::clone(&counter);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    next_sidecar_port_candidate(&counter)
                })
            })
            .collect::<Vec<_>>();
        let candidates = threads
            .into_iter()
            .map(|thread| thread.join().expect("allocator thread"))
            .collect::<std::collections::HashSet<_>>();

        assert_eq!(candidates.len(), 16);
        assert!(candidates.contains(&(BASE_PORT + PORT_RANGE)));
        assert!(candidates.contains(&BASE_PORT));
    }

    #[test]
    fn production_entrypoint_builder_is_session_only() {
        let mut session = crate::process_cmd::new("node");
        append_sidecar_entrypoint_args(&mut session, Path::new("server.ts"), 31416);
        let session_args: Vec<_> = session
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert!(!session_args.iter().any(|arg| arg == "--sidecar-role"));
        assert!(session_args
            .windows(2)
            .any(|pair| pair == ["--import", "tsx/esm"]));
    }
}
