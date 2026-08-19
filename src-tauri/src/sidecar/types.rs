use super::*;

// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, shared by their live owners.

#[derive(Default)]
struct DispatchGateState {
    accepting: bool,
    in_flight: usize,
}

/// Per-process admission fence for renderer control requests.
///
/// Admission happens while `SidecarManager` still owns endpoint selection;
/// the returned lease then crosses the network await without retaining the
/// manager mutex. Process replacement closes the gate and waits for the exact
/// generation's admitted requests to finish before terminating it.
pub(crate) struct DispatchGate {
    state: Mutex<DispatchGateState>,
    drained: Condvar,
}

impl DispatchGate {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(DispatchGateState {
                accepting: true,
                in_flight: 0,
            }),
            drained: Condvar::new(),
        })
    }

    pub(crate) fn try_acquire(gate: &Arc<Self>) -> Option<DispatchLease> {
        let mut state = gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state.accepting {
            return None;
        }
        state.in_flight += 1;
        Some(DispatchLease { gate: gate.clone() })
    }

    pub(crate) fn is_accepting(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .accepting
    }

    /// Stop admitting requests without waiting for already-admitted work.
    ///
    /// This is the only operation that may run while `SidecarManager` is
    /// locked. The returned drain is waited only after the manager lock has
    /// been released.
    pub(crate) fn close(gate: &Arc<Self>) -> DispatchDrain {
        let mut state = gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.accepting = false;
        DispatchDrain { gate: gate.clone() }
    }

    fn wait_until_in_flight_at_most(&self, maximum: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while state.in_flight > maximum {
            state = self
                .drained
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    pub(crate) fn close_and_wait(gate: &Arc<Self>) {
        Self::close(gate).wait();
    }
}

/// A transient handoff proving that request admission was closed while the
/// process generation was still manager-owned.
pub(crate) struct DispatchDrain {
    gate: Arc<DispatchGate>,
}

impl DispatchDrain {
    pub(crate) fn wait(&self) {
        self.gate.wait_until_in_flight_at_most(0);
    }

    pub(crate) fn matches(&self, gate: &Arc<DispatchGate>) -> bool {
        Arc::ptr_eq(&self.gate, gate)
    }
}

/// Exact process gates closed by one Session lifecycle transition.
///
/// The manager keeps the corresponding entries authoritative while these
/// drains are waited outside its mutex. Pointer identity prevents a stale
/// completion from removing a newer generation.
#[must_use = "wait for the closed generation outside SidecarManager, then finalize it"]
pub(crate) struct SessionGenerationDrain {
    pub(super) session_id: String,
    pub(super) active: Option<DispatchDrain>,
    pub(super) recovering: Option<DispatchDrain>,
}

/// Process objects detached from manager authority. Dropping this value waits
/// their already-closed gates and terminates the exact process trees; callers
/// must therefore carry it outside the manager mutex first.
#[must_use = "drop detached Sidecars only after releasing SidecarManager"]
pub(crate) struct SidecarRetirement {
    pub(crate) sessions: Vec<SessionSidecar>,
}

impl SidecarRetirement {
    pub(crate) fn finish(self) {
        let Self { sessions } = self;
        drop(sessions);
    }
}

impl SessionGenerationDrain {
    pub(crate) fn wait(&self) {
        if let Some(drain) = &self.active {
            drain.wait();
        }
        if let Some(drain) = &self.recovering {
            drain.wait();
        }
    }
}

pub(crate) struct DispatchLease {
    gate: Arc<DispatchGate>,
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        let mut state = self
            .gate
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        debug_assert!(state.in_flight > 0);
        state.in_flight = state.in_flight.saturating_sub(1);
        // Ordinary drains wait for zero; replacement drains retain one private
        // lifecycle lease and wait for all other requests to leave. Wake both
        // predicates on every decrement.
        self.gate.drained.notify_all();
    }
}

/// Owner of a Sidecar.
/// When all owners release, the Sidecar is stopped.
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID that owns part of this Sidecar
    Tab(String),
    /// Background completion owner - keeps Sidecar alive while AI finishes responding
    /// String is the session ID for identification
    BackgroundCompletion(String),
    /// Hidden GEO monitoring pass owned by BrandWorkspace.
    GeoMonitor(String),
    /// Deterministic publish executor egress lease owned by the Rust
    /// `PublishScheduler` (ticket 08 gateway port). String is the publish
    /// execution ID; mirrors `GeoMonitor` — a hidden scheduler attaching to the
    /// execution's source Session Sidecar to reach the gateway provider ports.
    PublishExecutor(String),
}

/// Explicit three-state lifecycle for a SessionSidecar.
///
/// Replaces the previous `healthy: bool` which conflated Starting (process alive,
/// not yet healthy) with Dead (process exited), causing race conditions where
/// health monitors would kill Starting sidecars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    /// Process spawned, `wait_for_health` in progress — do not kill.
    Starting,
    /// TCP health check passed (`wait_for_health`), ready to serve requests.
    Healthy,
    /// Process exited or health check permanently failed.
    Dead,
}

/// Session reuse decision made under the manager lock before bounded health IO.
pub(super) enum ExistingSidecarReuse {
    Healthy {
        port: u16,
        generation: u64,
    },
    /// `owner_added` = whether THIS ensure call newly inserted its owner when it
    /// joined the still-starting Sidecar. Only true means a readiness-timeout
    /// detach may safely remove that owner (see `add_owner`).
    Starting {
        port: u16,
        generation: u64,
        owner_added: bool,
    },
    /// Admission was closed by a concurrent last-owner release or
    /// replacement. Wait for that exact generation outside the manager lock,
    /// then retry the normal ensure path.
    Draining(DispatchDrain),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SidecarRemovalEventPolicy {
    pub(super) emit_stop: bool,
    pub(super) emit_terminal: bool,
}

pub(super) fn sidecar_removal_event_policy(
    owners: &HashSet<SidecarOwner>,
) -> SidecarRemovalEventPolicy {
    SidecarRemovalEventPolicy {
        emit_stop: true,
        emit_terminal: owners.is_empty(),
    }
}

pub struct SessionSidecar {
    /// The child process plus exact descendant-containment authority.
    pub(crate) process: ChildTree,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Immutable manager identity injected into `XIAOJING_SIDECAR_ID` when
    /// this process was spawned. Unlike `session_id`, this does not change
    /// when pending/reset/handover flows rekey the logical Session.
    pub management_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Lifecycle state: Starting → Healthy → Dead
    pub state: SidecarState,
    /// Set of owners currently using this Sidecar
    pub owners: HashSet<SidecarOwner>,
    /// Completion identities already consumed by notification delivery for
    /// this exact Sidecar generation. The manager is the only writer; keeping
    /// the set on the generation entry makes teardown reclaim it naturally.
    pub(crate) completion_claims: HashSet<(String, String)>,
    /// Admission fence for control requests bound to this process generation.
    pub(crate) dispatch_gate: Arc<DispatchGate>,
    /// Creation timestamp
    /// Reserved for future use (e.g., TTL-based cleanup)
    #[allow(dead_code)]
    pub created_at: std::time::Instant,
}

/// Proof that one completion identity was claimed from the authoritative
/// Sidecar generation. The private field prevents notification callers from
/// bypassing the manager's generation fence.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionCompletionClaim {
    _private: (),
}

impl SessionCompletionClaim {
    pub(super) fn new() -> Self {
        Self { _private: () }
    }
}

impl SessionSidecar {
    /// Is this sidecar healthy and ready to accept requests?
    pub fn is_reusable(&self) -> bool {
        matches!(self.state, SidecarState::Healthy) && self.dispatch_gate.is_accepting()
    }

    /// Is this sidecar both marked healthy and still alive?
    pub fn is_ready_for_requests(&mut self) -> bool {
        !self.is_dead() && self.is_reusable()
    }

    /// Is this sidecar still starting up? (process alive, `wait_for_health` in progress)
    pub fn is_starting(&self) -> bool {
        matches!(self.state, SidecarState::Starting)
    }

    /// Is this sidecar dead?
    /// Also auto-detects process exit and transitions Starting/Healthy → Dead.
    pub fn is_dead(&mut self) -> bool {
        if self.state == SidecarState::Dead {
            return true;
        }
        // Check if the process actually exited while we thought it was alive
        match self.process.try_wait() {
            Ok(Some(_)) => {
                self.state = SidecarState::Dead;
                true
            }
            Ok(None) => false, // Still running
            Err(_) => {
                self.state = SidecarState::Dead;
                true
            }
        }
    }

    /// Check if this Sidecar has any owners
    /// Reserved for future use (e.g., lifecycle management)
    #[allow(dead_code)]
    pub fn has_owners(&self) -> bool {
        !self.owners.is_empty()
    }

    /// Add an owner to this Sidecar.
    /// Returns true if the owner was newly inserted, false if it already owned
    /// this Sidecar (symmetric with `remove_owner`). The Starting-join path uses
    /// this to decide whether a later readiness-timeout detach is safe: only the
    /// call that actually added a *new* owner may remove it on timeout. A
    /// same-owner concurrent ensure (e.g. two `ensure_session_sidecar(.., Tab(t))`
    /// for one tab) gets `false` here, so it must NOT remove the shared owner —
    /// doing so would empty the owner set and kill a Sidecar another caller is
    /// still starting.
    pub fn add_owner(&mut self, owner: SidecarOwner) -> bool {
        self.owners.insert(owner)
    }

    /// Remove an owner from this Sidecar.
    /// Returns `(removed, last_owner_removed)` so stale cleanup is a true no-op.
    pub fn remove_owner(&mut self, owner: &SidecarOwner) -> (bool, bool) {
        let removed = self.owners.remove(owner);
        (removed, removed && self.owners.is_empty())
    }
}

/// Ensure Sidecar process is killed when SessionSidecar is dropped
impl Drop for SessionSidecar {
    fn drop(&mut self) {
        DispatchGate::close_and_wait(&self.dispatch_gate);
        ulog_info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {} (state: {:?})",
            self.session_id,
            self.port,
            self.state
        );
        let _ = self.process.terminate();
    }
}

/// Sidecar info for external queries
/// Reserved for future use (e.g., admin UI, debugging endpoints)
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub workspace_path: String,
    pub is_healthy: bool,
}
