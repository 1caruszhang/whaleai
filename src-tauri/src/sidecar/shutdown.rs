use super::*;

static APP_SHUTDOWN_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static LIFECYCLE_GATE: std::sync::LazyLock<Arc<LifecycleGate>> =
    std::sync::LazyLock::new(|| Arc::new(LifecycleGate::default()));

#[derive(Default)]
struct LifecycleGate {
    state: std::sync::Mutex<LifecycleState>,
    idle: std::sync::Condvar,
}

#[derive(Default)]
struct LifecycleState {
    accepting_creations: bool,
    initialized: bool,
    active_creations: usize,
}

pub struct LifecycleSpawnPermit {
    gate: Arc<LifecycleGate>,
    active: bool,
}

impl Drop for LifecycleSpawnPermit {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut state) = self.gate.state.lock() {
            state.active_creations = state.active_creations.saturating_sub(1);
            if state.active_creations == 0 {
                self.gate.idle.notify_all();
            }
        }
    }
}

impl LifecycleGate {
    fn begin_spawn(self: &Arc<Self>) -> Result<LifecycleSpawnPermit, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if !state.initialized {
            state.initialized = true;
            state.accepting_creations = true;
        }
        if !state.accepting_creations {
            return Err("APP_SHUTDOWN_IN_PROGRESS".to_string());
        }
        state.active_creations += 1;
        Ok(LifecycleSpawnPermit {
            gate: Arc::clone(self),
            active: true,
        })
    }

    fn begin_app_exit(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.initialized = true;
        state.accepting_creations = false;
        APP_SHUTDOWN_IN_PROGRESS.store(true, std::sync::atomic::Ordering::SeqCst);
        while state.active_creations > 0 {
            state = self
                .idle
                .wait(state)
                .map_err(|_| "APP_EXIT_CREATION_GATE_POISONED".to_string())?;
        }
        Ok(())
    }
}

pub fn begin_lifecycle_spawn_permit() -> Result<LifecycleSpawnPermit, String> {
    LIFECYCLE_GATE.begin_spawn()
}

pub fn begin_app_exit_shutdown() -> Result<(), String> {
    LIFECYCLE_GATE.begin_app_exit()
}

pub fn is_app_shutdown_in_progress() -> bool {
    APP_SHUTDOWN_IN_PROGRESS.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn stop_all_sidecars(manager: &ManagedSidecarManager, reason: &str) -> Result<(), String> {
    ulog_info!(
        "[sidecar] stop_all action=begin reason={} scope=application",
        reason
    );
    let mut manager_guard = manager.lock().map_err(|error| error.to_string())?;
    let retirement = manager_guard.stop_all();
    drop(manager_guard);
    retirement.finish();
    ulog_info!(
        "[sidecar] stop_all action=complete reason={} scope=application",
        reason
    );
    Ok(())
}
