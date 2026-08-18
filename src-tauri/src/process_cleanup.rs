//! Recovery-only cleanup for Xiaojing-owned Sidecar process trees.
//!
//! Normal shutdown uses birth-time `ChildTree` handles. Whole-machine process
//! enumeration is allowed only after the single-instance lock proves the prior
//! app owner is gone.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

#[derive(Debug, Clone, Copy)]
pub struct ProcessPattern {
    pub name: &'static str,
    pub pattern: &'static str,
}

impl ProcessPattern {
    pub const fn new(name: &'static str, pattern: &'static str) -> Self {
        Self { name, pattern }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CleanupReport {
    pub matched_roots: usize,
    pub descendants: usize,
    pub killed: usize,
    pub residual: usize,
    pub residual_pids: Vec<u32>,
    pub elapsed: Duration,
}

impl CleanupReport {
    pub fn total_targets(&self) -> usize {
        self.matched_roots + self.descendants
    }
}

#[derive(Debug, Clone)]
pub struct ProcessMatch {
    pub pid: u32,
    pub name: String,
    pub exe: Option<String>,
    pub cmd: String,
}

fn normalize(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

fn command_line(process: &sysinfo::Process) -> String {
    process
        .cmd()
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn kill_stale_processes(patterns: &[ProcessPattern]) -> CleanupReport {
    let started = Instant::now();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    let current = Pid::from_u32(std::process::id());
    let patterns = patterns
        .iter()
        .map(|pattern| normalize(pattern.pattern))
        .collect::<Vec<_>>();

    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children.entry(parent).or_default().push(*pid);
        }
    }

    let roots = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if *pid == current {
                return None;
            }
            let command = normalize(&command_line(process));
            patterns
                .iter()
                .any(|pattern| command.contains(pattern))
                .then_some(*pid)
        })
        .collect::<HashSet<_>>();
    let matched_roots = roots.len();
    let mut targets = roots.clone();
    let mut queue = roots.into_iter().collect::<Vec<_>>();
    while let Some(parent) = queue.pop() {
        if let Some(descendants) = children.get(&parent) {
            for child in descendants {
                if *child != current && targets.insert(*child) {
                    queue.push(*child);
                }
            }
        }
    }
    let descendants = targets.len().saturating_sub(matched_roots);
    let mut killed = 0;
    for pid in &targets {
        if system.process(*pid).is_some_and(|process| process.kill()) {
            killed += 1;
        }
    }

    let target_list = targets.into_iter().collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(3);
    let residual_pids = loop {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&target_list),
            true,
            ProcessRefreshKind::nothing(),
        );
        let alive = target_list
            .iter()
            .filter(|pid| {
                system
                    .process(**pid)
                    .is_some_and(|process| process.status() != ProcessStatus::Zombie)
            })
            .map(|pid| pid.as_u32())
            .collect::<Vec<_>>();
        if alive.is_empty() || Instant::now() >= deadline {
            break alive;
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    CleanupReport {
        matched_roots,
        descendants,
        killed,
        residual: residual_pids.len(),
        residual_pids,
        elapsed: started.elapsed(),
    }
}

pub fn find_live_processes_by_pid(pids: &[u32]) -> Vec<ProcessMatch> {
    let requested = pids.iter().copied().map(Pid::from_u32).collect::<Vec<_>>();
    if requested.is_empty() {
        return Vec::new();
    }
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&requested),
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(sysinfo::UpdateKind::Always)
            .with_exe(sysinfo::UpdateKind::Always),
    );
    requested
        .into_iter()
        .filter_map(|pid| {
            system
                .process(pid)
                .filter(|process| process.status() != ProcessStatus::Zombie)
                .map(|process| ProcessMatch {
                    pid: pid.as_u32(),
                    name: process.name().to_string_lossy().into_owned(),
                    exe: process
                        .exe()
                        .map(|path| path.to_string_lossy().into_owned()),
                    cmd: command_line(process),
                })
        })
        .collect()
}

pub fn is_xiaojing_pid(pid: u32) -> bool {
    let mut system = System::new();
    let requested = [Pid::from_u32(pid)];
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&requested),
        true,
        ProcessRefreshKind::nothing().with_exe(sysinfo::UpdateKind::Always),
    );
    system.process(requested[0]).is_some_and(|process| {
        process
            .exe()
            .map(|path| {
                path.to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("xiaojing")
            })
            .unwrap_or_else(|| {
                process
                    .name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("xiaojing")
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_command_lines_for_marker_matching() {
        assert_eq!(
            normalize(r"C:\Xiaojing\node.exe --XIAOJING-SIDECAR"),
            "c:/xiaojing/node.exe --xiaojing-sidecar"
        );
    }

    #[test]
    fn empty_cleanup_is_a_noop() {
        let report = kill_stale_processes(&[]);
        assert_eq!(report.total_targets(), 0);
        assert!(report.residual_pids.is_empty());
    }
}
