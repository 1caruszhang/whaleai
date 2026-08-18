//! Narrow system-binary discovery for platform infrastructure.
//!
//! Session Sidecars never use this module: they must start with the bundled
//! Node runtime. The only current caller is Linux wake-lock acquisition.

use std::path::PathBuf;

#[cfg(not(target_os = "windows"))]
const EXTRA_SEARCH_DIRS: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
];

pub fn find(binary_name: &str) -> Option<PathBuf> {
    #[cfg_attr(target_os = "windows", allow(unused_mut))]
    let mut directories = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    for directory in EXTRA_SEARCH_DIRS {
        let candidate = PathBuf::from(directory);
        if !directories.contains(&candidate) {
            directories.push(candidate);
        }
    }
    let search_path = std::env::join_paths(directories).ok()?;
    which::which_in(binary_name, Some(search_path), ".").ok()
}
