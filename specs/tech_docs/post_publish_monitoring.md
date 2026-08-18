# Post-publish Monitoring

Post-publish monitoring is a hidden BrandWorkspace scheduler, not a second Agent entry. Scheduling and execution stay hidden; the brand-level 「效果」 entry in the workbench presents the read-only results and the explicit activation gate without creating a new owner or executor.

## Authority

`geo_post_publish_monitor_plans` stores the active schedule, source Session, deadline, cadence and exact publish identity. `post_publish_monitoring.rs` owns wake calculation, claim, unit dispatch, result commit and terminal completion.

The in-process scheduler starts with the Rust management control plane, reloads active plans from SQLite, and claims a due wake using schedule id plus plan revision. A wake receipt only means the deterministic executor accepted or deduplicated it; each monitor unit still records its own outcome.

## Session use

Most monitoring work is deterministic Rust/Node control-plane work. When a baseline probe needs the main Agent's Provider boundary, the scheduler attaches `GeoMonitor(wakeId)` to the source Session Sidecar, validates the current BrandWorkspace identity and releases the owner after terminal settlement.

The scheduler cannot create another Session, invent a workspace, or bypass Provider admission. Missing/deleted source authority fails the unit and preserves evidence.

## Completion

Deadline, maximum runs or explicit user stop marks the plan terminal and removes its durable schedule identity. Restart recovery reads the same SQLite truth; no renderer tick or transient in-memory timer is authoritative.

Tests use temporary SQLite databases and fake clocks/providers. They cover duplicate wake, crash recovery, exact revision fencing, access failures, deadline completion and owner release without real network calls.
