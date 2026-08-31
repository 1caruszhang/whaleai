use super::*;

// ============= Core Functions =============

/// Check if a port is available
pub(super) fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Normalize a path for use with external processes.
///
/// On Windows, Tauri's `resource_dir()` and Rust's `current_exe()` / `canonicalize()`
/// return paths with the `\\?\` extended-length prefix. Node and npm cannot
/// reliably handle this prefix — they may silently hang or fail.
///
/// This function strips the prefix on Windows; on other platforms it's a no-op.
pub(crate) fn normalize_external_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

/// Env name carrying the proxy spill refs directory to the Session Sidecar.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) const SIDECAR_PROXY_REFS_DIR_ENV: &str = "XIAOJING_PROXY_REFS_DIR";

/// The refs directory whose TTL-owned body/meta pairs the Session Sidecar
/// serves back over `GET /refs/:id`. Must stay same-rooted with the
/// `ProxySpillManager::new(data_root.join("refs"))` construction in `lib.rs`.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) fn proxy_refs_dir(data_root: &std::path::Path) -> PathBuf {
    normalize_external_path(data_root.join("refs"))
}

/// Admit the proxy refs directory to a Sidecar command. A `None` data root
/// leaves the env unset; the Node side then degrades `/refs/:id` to 404.
#[cfg(any(target_os = "windows", target_os = "macos", test))]
pub(super) fn apply_proxy_refs_dir(command: &mut std::process::Command, refs_dir: Option<PathBuf>) {
    if let Some(dir) = refs_dir {
        command.env(SIDECAR_PROXY_REFS_DIR_ENV, dir);
    }
}

/// Runtime resources owned by one packaged Windows x64 Session Sidecar.
///
/// This is deliberately a resource layout, not a new Tauri `externalBin` or a
/// second process owner. The existing Session lifecycle still owns Node and
/// Node launches the exact Claude Agent SDK executable declared here.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg(any(target_os = "windows", test))]
pub(super) struct WindowsBundledRuntimeLayout {
    pub claude_executable: PathBuf,
    pub sharp_node_modules: PathBuf,
    pub git_bash: PathBuf,
    pub git_path_prefixes: [PathBuf; 3],
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn windows_bundled_runtime_layout(
    resources: &std::path::Path,
) -> WindowsBundledRuntimeLayout {
    let portable_git = resources.join("portable-git");
    WindowsBundledRuntimeLayout {
        claude_executable: resources.join("claude-agent-sdk").join("claude.exe"),
        sharp_node_modules: resources.join("sharp-runtime").join("node_modules"),
        git_bash: portable_git.join("bin").join("bash.exe"),
        git_path_prefixes: [
            portable_git.join("cmd"),
            portable_git.join("bin"),
            portable_git.join("mingw64").join("bin"),
        ],
    }
}

#[cfg(any(target_os = "windows", test))]
fn validate_windows_bundled_runtime_layout(
    layout: &WindowsBundledRuntimeLayout,
) -> Result<(), String> {
    let required = [
        (
            "claude-agent-sdk/claude.exe",
            layout.claude_executable.as_path(),
        ),
        (
            "sharp-runtime/node_modules",
            layout.sharp_node_modules.as_path(),
        ),
        ("portable-git/bin/bash.exe", layout.git_bash.as_path()),
        ("portable-git/cmd", layout.git_path_prefixes[0].as_path()),
        ("portable-git/bin", layout.git_path_prefixes[1].as_path()),
        (
            "portable-git/mingw64/bin",
            layout.git_path_prefixes[2].as_path(),
        ),
    ];
    for (relative, path) in required {
        if !path.exists() {
            return Err(format!(
                "Windows x64 runtime resource missing: {relative}. Reinstall the application."
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn apply_windows_bundled_runtime<R: Runtime>(
    app_handle: &AppHandle<R>,
    command: &mut std::process::Command,
) -> Result<(), String> {
    let resources = app_handle
        .path()
        .resource_dir()
        .map_err(|_| "Windows x64 runtime resource directory is unavailable".to_string())?;
    let mut layout = windows_bundled_runtime_layout(&resources);
    validate_windows_bundled_runtime_layout(&layout)?;

    layout.claude_executable = normalize_external_path(layout.claude_executable);
    layout.sharp_node_modules = normalize_external_path(layout.sharp_node_modules);
    layout.git_bash = normalize_external_path(layout.git_bash);
    layout.git_path_prefixes = layout.git_path_prefixes.map(normalize_external_path);

    let mut path_entries = layout.git_path_prefixes.to_vec();
    if let Some(inherited) = std::env::var_os("PATH") {
        path_entries.extend(std::env::split_paths(&inherited));
    }
    let joined_path = std::env::join_paths(path_entries)
        .map_err(|_| "Windows x64 bundled PATH contains an invalid entry".to_string())?;

    command.env("XIAOJING_CLAUDE_CODE_EXECUTABLE", layout.claude_executable);
    command.env("CLAUDE_CODE_GIT_BASH_PATH", layout.git_bash);
    command.env("NODE_PATH", layout.sharp_node_modules);
    command.env("PATH", joined_path);
    apply_proxy_refs_dir(
        command,
        crate::app_dirs::xiaojing_data_dir().map(|root| proxy_refs_dir(&root)),
    );
    Ok(())
}

/// Runtime resources owned by one packaged macOS arm64 Session Sidecar.
///
/// macOS ships git via the system (/usr/bin/git) and needs no PortableGit or
/// CLAUDE_CODE_GIT_BASH_PATH equivalent; only the Claude native executable and
/// the sharp runtime are admitted from the app bundle's Contents/Resources.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg(any(target_os = "macos", test))]
pub(super) struct MacosBundledRuntimeLayout {
    pub claude_executable: PathBuf,
    pub sharp_node_modules: PathBuf,
}

#[cfg(any(target_os = "macos", test))]
pub(super) fn macos_bundled_runtime_layout(
    resources: &std::path::Path,
) -> MacosBundledRuntimeLayout {
    MacosBundledRuntimeLayout {
        claude_executable: resources.join("claude-agent-sdk").join("claude"),
        sharp_node_modules: resources.join("sharp-runtime").join("node_modules"),
    }
}

#[cfg(any(target_os = "macos", test))]
fn validate_macos_bundled_runtime_layout(layout: &MacosBundledRuntimeLayout) -> Result<(), String> {
    let required = [
        (
            "claude-agent-sdk/claude",
            layout.claude_executable.as_path(),
        ),
        (
            "sharp-runtime/node_modules",
            layout.sharp_node_modules.as_path(),
        ),
    ];
    for (relative, path) in required {
        if !path.exists() {
            return Err(format!(
                "macOS arm64 runtime resource missing: {relative}. Reinstall the application."
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn apply_macos_bundled_runtime<R: Runtime>(
    app_handle: &AppHandle<R>,
    command: &mut std::process::Command,
) -> Result<(), String> {
    let resources = app_handle
        .path()
        .resource_dir()
        .map_err(|_| "macOS arm64 runtime resource directory is unavailable".to_string())?;
    let layout = macos_bundled_runtime_layout(&resources);
    validate_macos_bundled_runtime_layout(&layout)?;

    command.env("XIAOJING_CLAUDE_CODE_EXECUTABLE", layout.claude_executable);
    command.env("NODE_PATH", layout.sharp_node_modules);
    apply_proxy_refs_dir(
        command,
        crate::app_dirs::xiaojing_data_dir().map(|root| proxy_refs_dir(&root)),
    );
    Ok(())
}

/// Diagnose why Node executable was not found and return a user-friendly error message.
pub(super) fn diagnose_node_not_found<R: Runtime>(app_handle: &AppHandle<R>) -> String {
    let mut details = Vec::new();

    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            details.push(format!("resource_dir: {:?}", resource_dir));
            let expected = node_path_in_resources(&resource_dir);
            if !expected.exists() {
                details.push(format!(
                    "bundled Node.js missing at {:?} — build scripts may not have run scripts/download_nodejs.sh",
                    expected
                ));
            }
        }
        Err(e) => {
            details.push(format!("resource_dir() failed: {}", e));
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        details.push(format!("current_exe: {:?}", exe_path));
    }

    let diag = details.join("; ");
    let msg = format!(
        "Node.js runtime not found. {} | \
         Possible causes: (1) Bundled Node not downloaded — run scripts/download_nodejs.sh. \
         (2) Antivirus quarantined node.exe on Windows — check Windows Security > Protection History. \
         (3) Installation is corrupted — reinstall the application.",
        diag
    );
    ulog_error!("[sidecar] {}", msg);
    msg
}

/// Diagnose why the bundled Node process exited immediately.
pub(super) fn diagnose_immediate_exit(
    status: &std::process::ExitStatus,
    node_path: &std::path::Path,
) -> String {
    let status_str = format!("{:?}", status);

    #[cfg(target_os = "windows")]
    {
        // On Windows, ExitStatus wraps the process exit code.
        // 0xc0000135 (STATUS_DLL_NOT_FOUND) = missing DLL (e.g., VCRUNTIME140.dll)
        // 0xc0000142 (STATUS_DLL_INIT_FAILED) = DLL initialization failed
        let code = status.code().unwrap_or(0) as u32;
        let hint = match code {
            0xc0000135 => "A required DLL is missing. The packaged Windows x64 import closure is incomplete; reinstall the application and collect diagnostics if the error persists.",
            0xc0000142 => {
                "A packaged DLL failed to initialize. Reinstall the application and collect diagnostics if the error persists."
            }
            0xc0000005 => {
                "STATUS_ACCESS_VIOLATION — bundled node.exe crashed. \
                 Check Windows Security > Protection History and verify the installation."
            }
            0xc0000022 => {
                "Access denied — antivirus may be blocking node.exe. \
                 Check Windows Security > Protection History, or add the install directory to exclusions."
            }
            1 => "Node exited with code 1. The bundled Claude Agent SDK or PortableGit runtime may be incomplete; reinstall the application.",
            _ => "",
        };

        let msg = if hint.is_empty() {
            format!(
                "Node process exited immediately (status: {}, code: 0x{:08x}). node_path: {:?}",
                status_str, code, node_path
            )
        } else {
            format!(
                "Node process exited immediately (status: {}, code: 0x{:08x}). {} | node_path: {:?}",
                status_str, code, hint, node_path
            )
        };
        ulog_error!("[sidecar] {}", msg);
        msg
    }

    #[cfg(not(target_os = "windows"))]
    {
        let msg = format!(
            "Node process exited immediately with status: {}. node_path: {:?}",
            status_str, node_path
        );
        ulog_error!("[sidecar] {}", msg);
        msg
    }
}

/// Find the Node.js executable path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
pub(super) fn find_node_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_node_executable_inner(app_handle).map(normalize_external_path)
}

/// Build the canonical Node.js path relative to a given resources directory.
/// macOS/Linux: <resources>/nodejs/bin/node
/// Windows:     <resources>\nodejs\node.exe
pub(super) fn node_path_in_resources(resources: &std::path::Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        resources.join("nodejs").join("node.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        resources.join("nodejs").join("bin").join("node")
    }
}

pub(super) fn find_node_executable_inner<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // Bundled Node.js lives under resource_dir/nodejs/ and is staged by
    // scripts/download_nodejs.sh as a plain Tauri resource tree.
    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            ulog_info!("[sidecar] resource_dir resolved to: {:?}", resource_dir);

            let bundled = node_path_in_resources(&resource_dir);
            if bundled.exists() {
                if is_node_crashed(&bundled) {
                    ulog_warn!("Skipping crashed bundled node: {:?}", bundled);
                } else {
                    ulog_info!("Using bundled node: {:?}", bundled);
                    return Some(bundled);
                }
            }
        }
        Err(e) => {
            ulog_warn!(
                "[sidecar] resource_dir() failed: {}, will try exe-relative fallback",
                e
            );
        }
    }

    // Fallback: find node relative to the current executable (most reliable on Windows
    // installer layouts where resource_dir returns something unexpected).
    if let Ok(exe_path) = std::env::current_exe() {
        ulog_info!("[sidecar] current_exe: {:?}", exe_path);
        if let Some(exe_dir) = exe_path.parent() {
            #[cfg(target_os = "macos")]
            let layouts: [PathBuf; 2] = [
                // Inside the .app bundle: Contents/Resources/nodejs/bin/node
                exe_dir
                    .parent()
                    .map(|p| p.join("Resources").join("nodejs").join("bin").join("node"))
                    .unwrap_or_else(|| {
                        exe_dir
                            .join("Resources")
                            .join("nodejs")
                            .join("bin")
                            .join("node")
                    }),
                exe_dir.join("nodejs").join("bin").join("node"),
            ];
            #[cfg(target_os = "windows")]
            let layouts: [PathBuf; 2] = [
                exe_dir.join("resources").join("nodejs").join("node.exe"),
                exe_dir.join("nodejs").join("node.exe"),
            ];
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            let layouts: [PathBuf; 2] = [
                exe_dir
                    .join("resources")
                    .join("nodejs")
                    .join("bin")
                    .join("node"),
                exe_dir.join("nodejs").join("bin").join("node"),
            ];

            for candidate in &layouts {
                if candidate.exists() {
                    ulog_info!("Using bundled node (exe-relative): {:?}", candidate);
                    return Some(candidate.clone());
                }
            }
        }
    }

    ulog_error!(
        "[sidecar] Bundled Node executable not found in resource or executable-relative locations"
    );
    None
}

/// Find the server script path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
pub(super) fn find_server_script<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_server_script_inner(app_handle).map(normalize_external_path)
}

pub(super) fn find_server_script_inner<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // 1. First check for bundled server-dist.js (Production)
    // Modified: Only check bundled script in Release mode, so Dev mode uses source
    #[cfg(debug_assertions)]
    ulog_info!(
        "[sidecar] Debug mode detected, SKIPPING bundled script check (forcing source usage)"
    );

    #[cfg(not(debug_assertions))]
    {
        match _app_handle.path().resource_dir() {
            Ok(resource_dir) => {
                let bundled_script = resource_dir.join("server-dist.js");
                if bundled_script.exists() {
                    ulog_info!(
                        "Using bundled server script (bundled): {:?}",
                        bundled_script
                    );
                    return Some(bundled_script);
                }
            }
            Err(e) => {
                ulog_warn!("[sidecar] resource_dir() failed for script search: {}", e);
            }
        }

        // Fallback: find server-dist.js relative to current executable
        #[cfg(target_os = "windows")]
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let script = exe_dir.join("server-dist.js");
                if script.exists() {
                    ulog_info!("[sidecar] Using server script from exe_dir: {:?}", script);
                    return Some(script);
                }
            }
        }
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("server").join("index.ts"));

        if let Some(ref path) = dev_path {
            if path.exists() {
                ulog_info!("Using development server script: {:?}", path);
                return dev_path;
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("src").join("server").join("index.ts");
            if cwd_path.exists() {
                ulog_info!("Using cwd server script: {:?}", cwd_path);
                return Some(cwd_path);
            }
        }
    }

    ulog_error!("[sidecar] Server script not found in any location");
    None
}

#[cfg(test)]
mod proxy_refs_env_tests {
    use super::{apply_proxy_refs_dir, proxy_refs_dir, SIDECAR_PROXY_REFS_DIR_ENV};

    fn env_map(
        command: &std::process::Command,
    ) -> std::collections::HashMap<String, Option<String>> {
        command
            .get_envs()
            .filter_map(|(key, value)| {
                let key = key.to_str()?.to_string();
                let value = value.map(|value| value.to_string_lossy().to_string());
                Some((key, value))
            })
            .collect()
    }

    #[test]
    fn proxy_refs_dir_keeps_the_spill_root_suffix() {
        let root = tempfile::tempdir().expect("temp data root");
        let refs_dir = proxy_refs_dir(root.path());
        assert_eq!(refs_dir.parent(), Some(root.path()));
        assert_eq!(
            refs_dir.file_name().and_then(|name| name.to_str()),
            Some("refs")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn proxy_refs_dir_strips_the_extended_length_prefix_for_node() {
        assert_eq!(
            proxy_refs_dir(std::path::Path::new(r"\\?\C:\Xiaojing")),
            std::path::PathBuf::from(r"C:\Xiaojing\refs")
        );
    }

    #[test]
    fn sidecar_command_carries_the_proxy_refs_dir_env() {
        let temp = tempfile::tempdir().expect("temp refs");
        let refs_dir = temp.path().join("refs");
        let mut command = crate::process_cmd::new("node");
        apply_proxy_refs_dir(&mut command, Some(refs_dir.clone()));
        assert_eq!(
            env_map(&command).get(SIDECAR_PROXY_REFS_DIR_ENV),
            Some(&Some(refs_dir.to_string_lossy().to_string()))
        );

        // 数据根未知时不得注入空值：Node 侧按 env 缺失降级 404。
        let mut bare = crate::process_cmd::new("node");
        apply_proxy_refs_dir(&mut bare, None);
        assert!(!env_map(&bare).contains_key(SIDECAR_PROXY_REFS_DIR_ENV));
    }
}

#[cfg(test)]
mod windows_runtime_layout_tests {
    use super::{validate_windows_bundled_runtime_layout, windows_bundled_runtime_layout};

    #[test]
    fn layout_preserves_unicode_spaces_percent_and_long_segments() {
        let long_segment = "长路径".repeat(48);
        let root = std::path::PathBuf::from("C:\\Users\\测试 用户%25")
            .join(long_segment)
            .join("resources");
        let layout = windows_bundled_runtime_layout(&root);

        assert_eq!(
            layout.claude_executable,
            root.join("claude-agent-sdk").join("claude.exe")
        );
        assert_eq!(
            layout.sharp_node_modules,
            root.join("sharp-runtime").join("node_modules")
        );
        assert_eq!(
            layout.git_bash,
            root.join("portable-git").join("bin").join("bash.exe")
        );
    }

    #[test]
    fn validation_fails_closed_without_every_required_resource() {
        let temp = tempfile::tempdir().unwrap();
        let layout = windows_bundled_runtime_layout(temp.path());
        let error = validate_windows_bundled_runtime_layout(&layout).unwrap_err();
        assert!(error.contains("claude-agent-sdk/claude.exe"));
        assert!(!error.contains(&temp.path().to_string_lossy().to_string()));
    }
}

#[cfg(test)]
mod macos_runtime_layout_tests {
    use super::{macos_bundled_runtime_layout, validate_macos_bundled_runtime_layout};

    #[test]
    fn layout_preserves_unicode_spaces_and_long_segments() {
        let long_segment = "长路径".repeat(48);
        let root = std::path::PathBuf::from("/Applications/鲸杉 geo 测试.app/Contents")
            .join(long_segment)
            .join("Resources");
        let layout = macos_bundled_runtime_layout(&root);

        assert_eq!(
            layout.claude_executable,
            root.join("claude-agent-sdk").join("claude")
        );
        assert_eq!(
            layout.sharp_node_modules,
            root.join("sharp-runtime").join("node_modules")
        );
    }

    #[test]
    fn validation_fails_closed_without_every_required_resource() {
        let temp = tempfile::tempdir().unwrap();
        let layout = macos_bundled_runtime_layout(temp.path());
        let error = validate_macos_bundled_runtime_layout(&layout).unwrap_err();
        assert!(error.contains("claude-agent-sdk/claude"));
        assert!(!error.contains(&temp.path().to_string_lossy().to_string()));
    }
}
