use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use uuid::Uuid;

pub const DEFAULT_GEO_PROVIDER_CONCURRENCY: usize = 5;
pub const MIN_GEO_PROVIDER_CONCURRENCY: usize = 1;
pub const MAX_GEO_PROVIDER_CONCURRENCY: usize = 16;
const MAX_GEO_PROVIDER_QUEUE: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeoProviderCaller {
    pub sidecar_id: String,
    pub sidecar_generation: u64,
    pub workspace_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoProviderPermitProjection {
    pub state: String,
    pub request_id: String,
    pub permit_token: Option<String>,
    pub queue_reason: Option<String>,
    pub queue_position: Option<usize>,
    pub concurrency_limit: usize,
    pub active_count: usize,
}

#[derive(Debug, Clone)]
struct PermitRequest {
    request_id: String,
    caller: GeoProviderCaller,
    _slot: String,
    _unit_kind: String,
    _unit_id: String,
}

#[derive(Debug, Clone)]
struct ActivePermit {
    request: PermitRequest,
    token: String,
}

#[derive(Debug)]
struct LimiterState {
    limit: usize,
    active: HashMap<String, ActivePermit>,
    request_tokens: HashMap<String, String>,
    queue: VecDeque<PermitRequest>,
}

impl LimiterState {
    fn new(limit: usize) -> Self {
        Self {
            limit: clamp_geo_provider_concurrency(limit),
            active: HashMap::new(),
            request_tokens: HashMap::new(),
            queue: VecDeque::new(),
        }
    }

    fn projection_for_request(&self, request_id: &str) -> Option<GeoProviderPermitProjection> {
        if let Some(token) = self.request_tokens.get(request_id) {
            return Some(GeoProviderPermitProjection {
                state: "acquired".to_string(),
                request_id: request_id.to_string(),
                permit_token: Some(token.clone()),
                queue_reason: None,
                queue_position: None,
                concurrency_limit: self.limit,
                active_count: self.active.len(),
            });
        }
        self.queue
            .iter()
            .position(|request| request.request_id == request_id)
            .map(|index| GeoProviderPermitProjection {
                state: "queued".to_string(),
                request_id: request_id.to_string(),
                permit_token: None,
                queue_reason: Some(format!("全局重型 Provider 并发已达上限（{}）", self.limit)),
                queue_position: Some(index + 1),
                concurrency_limit: self.limit,
                active_count: self.active.len(),
            })
    }

    fn grant(&mut self, request: PermitRequest) -> GeoProviderPermitProjection {
        let request_id = request.request_id.clone();
        let token = Uuid::new_v4().to_string();
        self.request_tokens
            .insert(request_id.clone(), token.clone());
        self.active.insert(
            token.clone(),
            ActivePermit {
                request,
                token: token.clone(),
            },
        );
        GeoProviderPermitProjection {
            state: "acquired".to_string(),
            request_id,
            permit_token: Some(token),
            queue_reason: None,
            queue_position: None,
            concurrency_limit: self.limit,
            active_count: self.active.len(),
        }
    }

    fn promote(&mut self) {
        while self.active.len() < self.limit {
            let Some(request) = self.queue.pop_front() else {
                break;
            };
            self.grant(request);
        }
    }

    fn remove_active_token(&mut self, token: &str) -> bool {
        let Some(active) = self.active.remove(token) else {
            return false;
        };
        self.request_tokens.remove(&active.request.request_id);
        true
    }
}

#[derive(Debug)]
pub struct GeoProviderLimiter {
    state: Mutex<LimiterState>,
}

impl Default for GeoProviderLimiter {
    fn default() -> Self {
        Self::new(DEFAULT_GEO_PROVIDER_CONCURRENCY)
    }
}

impl GeoProviderLimiter {
    pub fn new(limit: usize) -> Self {
        Self {
            state: Mutex::new(LimiterState::new(limit)),
        }
    }

    pub fn set_limit(&self, limit: usize) -> Result<usize, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.limit = clamp_geo_provider_concurrency(limit);
        state.promote();
        Ok(state.limit)
    }

    pub fn acquire(
        &self,
        request_id: String,
        caller: GeoProviderCaller,
        slot: String,
        unit_kind: String,
        unit_id: String,
    ) -> Result<GeoProviderPermitProjection, String> {
        validate_permit_identity(&request_id, &slot, &unit_kind, &unit_id)?;
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = state.projection_for_request(&request_id) {
            let same_caller = state
                .request_tokens
                .get(&request_id)
                .and_then(|token| state.active.get(token))
                .map(|active| active.request.caller == caller)
                .or_else(|| {
                    state
                        .queue
                        .iter()
                        .find(|request| request.request_id == request_id)
                        .map(|request| request.caller == caller)
                })
                .unwrap_or(false);
            return same_caller
                .then_some(existing)
                .ok_or_else(|| "geo_provider_permit_identity_conflict".to_string());
        }
        let request = PermitRequest {
            request_id,
            caller,
            _slot: slot,
            _unit_kind: unit_kind,
            _unit_id: unit_id,
        };
        if state.active.len() < state.limit {
            return Ok(state.grant(request));
        }
        if state.queue.len() >= MAX_GEO_PROVIDER_QUEUE {
            return Err("geo_provider_queue_capacity_exhausted".to_string());
        }
        let request_id = request.request_id.clone();
        state.queue.push_back(request);
        state
            .projection_for_request(&request_id)
            .ok_or_else(|| "geo_provider_permit_queue_failed".to_string())
    }

    pub fn status(
        &self,
        request_id: &str,
        caller: &GeoProviderCaller,
    ) -> Result<GeoProviderPermitProjection, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let matches = state
            .request_tokens
            .get(request_id)
            .and_then(|token| state.active.get(token))
            .map(|active| &active.request.caller == caller)
            .or_else(|| {
                state
                    .queue
                    .iter()
                    .find(|request| request.request_id == request_id)
                    .map(|request| &request.caller == caller)
            })
            .unwrap_or(false);
        if !matches {
            return Err("geo_provider_permit_not_found".to_string());
        }
        state
            .projection_for_request(request_id)
            .ok_or_else(|| "geo_provider_permit_not_found".to_string())
    }

    pub fn release(&self, permit_token: &str, caller: &GeoProviderCaller) -> Result<bool, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let Some(active) = state.active.get(permit_token) else {
            return Ok(false);
        };
        if &active.request.caller != caller || active.token != permit_token {
            return Err("geo_provider_permit_identity_conflict".to_string());
        }
        let removed = state.remove_active_token(permit_token);
        state.promote();
        Ok(removed)
    }

    pub fn cancel(&self, request_id: &str, caller: &GeoProviderCaller) -> Result<bool, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if let Some(index) = state
            .queue
            .iter()
            .position(|request| request.request_id == request_id && &request.caller == caller)
        {
            state.queue.remove(index);
            return Ok(true);
        }
        let token = state.request_tokens.get(request_id).cloned();
        let Some(token) = token else {
            return Ok(false);
        };
        let matches = state
            .active
            .get(&token)
            .is_some_and(|active| &active.request.caller == caller);
        if !matches {
            return Err("geo_provider_permit_identity_conflict".to_string());
        }
        let removed = state.remove_active_token(&token);
        state.promote();
        Ok(removed)
    }

    pub fn retire_generation(
        &self,
        workspace_id: &str,
        session_id: &str,
        generation: u64,
    ) -> Result<usize, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let active_tokens = state
            .active
            .iter()
            .filter(|(_, active)| {
                active.request.caller.workspace_id == workspace_id
                    && active.request.caller.session_id == session_id
                    && active.request.caller.sidecar_generation == generation
            })
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        let mut removed = 0;
        for token in active_tokens {
            removed += usize::from(state.remove_active_token(&token));
        }
        let before = state.queue.len();
        state.queue.retain(|request| {
            request.caller.workspace_id != workspace_id
                || request.caller.session_id != session_id
                || request.caller.sidecar_generation != generation
        });
        removed += before - state.queue.len();
        state.promote();
        Ok(removed)
    }

    pub fn clear(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.active.clear();
        state.request_tokens.clear();
        state.queue.clear();
        Ok(())
    }

    #[cfg(test)]
    fn snapshot(&self) -> (usize, usize, usize) {
        let state = self.state.lock().expect("limiter");
        (state.limit, state.active.len(), state.queue.len())
    }
}

pub fn clamp_geo_provider_concurrency(limit: usize) -> usize {
    limit.clamp(MIN_GEO_PROVIDER_CONCURRENCY, MAX_GEO_PROVIDER_CONCURRENCY)
}

pub fn configured_geo_provider_concurrency() -> usize {
    crate::app_dirs::xiaojing_data_dir()
        .and_then(|root| std::fs::read_to_string(root.join("config.json")).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(|config| geo_provider_concurrency_from_config(&config))
        .unwrap_or(DEFAULT_GEO_PROVIDER_CONCURRENCY)
}

fn geo_provider_concurrency_from_config(config: &serde_json::Value) -> usize {
    let configured = config
        .get("geoProviderConcurrencyLimit")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(DEFAULT_GEO_PROVIDER_CONCURRENCY);
    clamp_geo_provider_concurrency(configured)
}

pub fn global_geo_provider_limiter() -> &'static GeoProviderLimiter {
    static LIMITER: OnceLock<GeoProviderLimiter> = OnceLock::new();
    LIMITER.get_or_init(|| GeoProviderLimiter::new(configured_geo_provider_concurrency()))
}

fn validate_permit_identity(
    request_id: &str,
    slot: &str,
    unit_kind: &str,
    unit_id: &str,
) -> Result<(), String> {
    for value in [request_id, slot, unit_kind, unit_id] {
        if value.is_empty()
            || value.len() > 200
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("geo_provider_permit_identity_invalid".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caller(session: &str, generation: u64) -> GeoProviderCaller {
        GeoProviderCaller {
            sidecar_id: format!("sidecar-{session}-{generation}"),
            sidecar_generation: generation,
            workspace_id: format!("brand-{session}"),
            session_id: session.to_string(),
        }
    }

    fn acquire(
        limiter: &GeoProviderLimiter,
        request_id: &str,
        caller: GeoProviderCaller,
    ) -> GeoProviderPermitProjection {
        limiter
            .acquire(
                request_id.to_string(),
                caller,
                "generation".to_string(),
                "article".to_string(),
                request_id.to_string(),
            )
            .expect("acquire")
    }

    #[test]
    fn globally_limits_different_sessions_and_promotes_fifo() {
        let limiter = GeoProviderLimiter::new(2);
        let first = acquire(&limiter, "request-1", caller("session-a", 1));
        let second = acquire(&limiter, "request-2", caller("session-b", 2));
        let third_caller = caller("session-c", 3);
        let third = acquire(&limiter, "request-3", third_caller.clone());
        let fourth_caller = caller("session-d", 4);
        let fourth = acquire(&limiter, "request-4", fourth_caller.clone());

        assert_eq!(first.state, "acquired");
        assert_eq!(second.state, "acquired");
        assert_eq!(third.queue_position, Some(1));
        assert_eq!(fourth.queue_position, Some(2));

        limiter
            .release(
                first.permit_token.as_deref().expect("token"),
                &caller("session-a", 1),
            )
            .expect("release");
        assert_eq!(
            limiter
                .status("request-3", &third_caller)
                .expect("third status")
                .state,
            "acquired"
        );
        assert_eq!(
            limiter
                .status("request-4", &fourth_caller)
                .expect("fourth status")
                .queue_position,
            Some(1)
        );
    }

    #[test]
    fn retiring_a_dead_generation_releases_active_and_queued_work() {
        let limiter = GeoProviderLimiter::new(1);
        let stale = caller("session-a", 7);
        let live = caller("session-b", 8);
        acquire(&limiter, "stale-active", stale.clone());
        acquire(&limiter, "stale-queued", stale);
        acquire(&limiter, "live-queued", live.clone());
        let mut other_workspace = caller("session-a", 7);
        other_workspace.workspace_id = "brand-other".to_string();
        acquire(&limiter, "other-workspace-queued", other_workspace.clone());

        assert_eq!(
            limiter
                .retire_generation("brand-session-a", "session-a", 7)
                .unwrap(),
            2
        );
        assert_eq!(
            limiter
                .status("live-queued", &live)
                .expect("live promoted")
                .state,
            "acquired"
        );
        assert_eq!(
            limiter
                .status("other-workspace-queued", &other_workspace)
                .expect("other workspace remains queued")
                .queue_position,
            Some(1)
        );
        assert_eq!(limiter.snapshot(), (1, 1, 1));
    }

    #[test]
    fn configuration_is_safely_bounded_and_queue_capacity_is_visible() {
        assert_eq!(clamp_geo_provider_concurrency(0), 1);
        assert_eq!(clamp_geo_provider_concurrency(5), 5);
        assert_eq!(clamp_geo_provider_concurrency(usize::MAX), 16);
        assert_eq!(
            geo_provider_concurrency_from_config(&serde_json::json!({})),
            5
        );
        assert_eq!(
            geo_provider_concurrency_from_config(&serde_json::json!({
                "geoProviderConcurrencyLimit": 0,
            })),
            1
        );
        assert_eq!(
            geo_provider_concurrency_from_config(&serde_json::json!({
                "geoProviderConcurrencyLimit": 99,
            })),
            16
        );
        assert_eq!(
            geo_provider_concurrency_from_config(&serde_json::json!({
                "geoProviderConcurrencyLimit": "unsafe",
            })),
            5
        );

        let limiter = GeoProviderLimiter::new(0);
        assert_eq!(limiter.snapshot().0, 1);
        acquire(&limiter, "active", caller("session-active", 1));
        for index in 0..MAX_GEO_PROVIDER_QUEUE {
            let queued = acquire(
                &limiter,
                &format!("queued-{index}"),
                caller(&format!("session-{index}"), 1),
            );
            assert_eq!(queued.queue_position, Some(index + 1));
        }
        assert_eq!(limiter.snapshot(), (1, 1, MAX_GEO_PROVIDER_QUEUE));
        assert_eq!(
            limiter
                .acquire(
                    "overflow".to_string(),
                    caller("session-overflow", 1),
                    "generation".to_string(),
                    "article".to_string(),
                    "overflow".to_string(),
                )
                .unwrap_err(),
            "geo_provider_queue_capacity_exhausted"
        );

        assert_eq!(limiter.set_limit(usize::MAX).unwrap(), 16);
        assert_eq!(limiter.snapshot().0, 16);
    }
}
