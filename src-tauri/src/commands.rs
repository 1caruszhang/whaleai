//! Narrow Tauri commands owned by the Xiaojing desktop shell.

use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(windows)]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "C:\\Recovery",
    "C:\\$Recycle.Bin",
];
#[cfg(all(not(windows), not(target_os = "macos")))]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "/etc", "/var", "/usr", "/bin", "/sbin", "/boot", "/root", "/sys", "/proc", "/dev",
];
#[cfg(target_os = "macos")]
const FORBIDDEN_SYSTEM_DIRS: &[&str] = &[
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/boot",
    "/root",
    "/sys",
    "/proc",
    "/dev",
    "/private/etc",
    "/private/var",
];
const CREDENTIAL_PATHS: &[&str] = &[".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/op"];
#[cfg(target_os = "macos")]
const PLATFORM_SENSITIVE_SUBDIRS: &[&str] = &[
    "Library/Keychains",
    "Library/Cookies",
    "Library/Mail",
    "Library/Messages",
    "Library/Safari",
];
#[cfg(windows)]
const PLATFORM_SENSITIVE_SUBDIRS: &[&str] = &["AppData/Local/Microsoft"];
#[cfg(all(not(windows), not(target_os = "macos")))]
const PLATFORM_SENSITIVE_SUBDIRS: &[&str] = &[];

#[cfg(windows)]
fn normalize_windows_security_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    let windows = raw.replace('/', r"\");
    let folded = windows.to_lowercase();
    if folded.starts_with(r"\\?\unc\") {
        return PathBuf::from(format!(r"\\{}", &windows[8..]));
    }
    if folded.starts_with(r"\\?\") {
        return PathBuf::from(&windows[4..]);
    }
    path.to_path_buf()
}

pub(crate) fn normalize_security_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        normalize_windows_security_path(&path)
    }
    #[cfg(not(windows))]
    {
        path
    }
}

pub(crate) fn normalize_lexical_security_path(path: PathBuf) -> PathBuf {
    let mut resolved = PathBuf::new();
    for component in normalize_security_path(path).components() {
        match component {
            std::path::Component::ParentDir => {
                resolved.pop();
            }
            std::path::Component::CurDir => {}
            _ => resolved.push(component),
        }
    }
    resolved
}

#[cfg(windows)]
fn normalize_windows_path_identity(path: &Path) -> String {
    normalize_windows_security_path(path)
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

pub(crate) fn path_starts_with_identity(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let candidate = normalize_windows_path_identity(path);
        let root = normalize_windows_path_identity(root);
        candidate == root
            || candidate
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with('/'))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

fn reject_sensitive_path(path: &Path, home: &Path) -> Result<(), String> {
    if FORBIDDEN_SYSTEM_DIRS
        .iter()
        .any(|root| path_starts_with_identity(path, Path::new(root)))
    {
        return Err("Access denied: protected system directory".to_string());
    }
    if !home.as_os_str().is_empty()
        && (CREDENTIAL_PATHS
            .iter()
            .any(|entry| path_starts_with_identity(path, &home.join(entry)))
            || PLATFORM_SENSITIVE_SUBDIRS
                .iter()
                .any(|entry| path_starts_with_identity(path, &home.join(entry))))
    {
        return Err("Access denied: protected private directory".to_string());
    }
    Ok(())
}

fn nearest_existing_identity(path: &Path) -> Option<PathBuf> {
    let mut ancestor = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        if let Ok(canonical) = fs::canonicalize(&ancestor) {
            let mut resolved = normalize_security_path(canonical);
            for component in suffix.iter().rev() {
                resolved.push(component);
            }
            return Some(resolved);
        }
        suffix.push(ancestor.file_name()?.to_os_string());
        ancestor = ancestor.parent()?.to_path_buf();
    }
}

pub(crate) fn validate_file_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = normalize_security_path(PathBuf::from(raw_path));
    if !path.is_absolute() {
        return Err("Path must be absolute".to_string());
    }
    let resolved = normalize_lexical_security_path(path);
    let home = dirs::home_dir().unwrap_or_default();
    reject_sensitive_path(&resolved, &home)?;
    if let Some(identity) = nearest_existing_identity(&resolved) {
        reject_sensitive_path(&identity, &home)?;
    }
    Ok(resolved)
}

#[tauri::command]
pub async fn cmd_read_file_base64(path: String) -> Result<String, String> {
    let resolved = validate_file_path(&path)?;
    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|error| format!("Read metadata failed: {error}"))?;
    if !metadata.is_file() || metadata.len() > 50 * 1024 * 1024 {
        return Err("File is not readable or exceeds 50 MB".to_string());
    }
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|error| format!("Read failed: {error}"))?;
    Ok(BASE64.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_private_paths() {
        assert!(validate_file_path("relative.txt").is_err());
        if let Some(home) = dirs::home_dir() {
            assert!(validate_file_path(&home.join(".ssh/key").to_string_lossy()).is_err());
        }
    }
}
