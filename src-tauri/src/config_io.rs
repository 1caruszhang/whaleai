//! Shared Xiaojing local-data `config.json` read-modify-write helper.
//!
//! The renderer, Node sidecar, and Rust commands coordinate on the same
//! `config.json.lock` directory. Directory creation is atomic across processes
//! on supported app filesystems and is available from all three runtimes without
//! adding a platform-specific dependency.
//!
//! Pattern 5 (Single-Writer Invariant) — lock acquisition + stale-recovery now
//! lives in `crate::utils::file_lock`; this module just composes it.

use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::utils::bom::strip_bom;
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};

fn read_config_json(config_path: &Path) -> Result<serde_json::Value, String> {
    if !config_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let content = fs::read_to_string(config_path)
        .map_err(|e| format!("[config-io] Cannot read config.json: {}", e))?;
    // Tolerate UTF-8 BOM (U+FEFF) prepended by Windows editors — without this
    // a manually-edited config.json would fail to parse with "expected value
    // at line 1 column 1" and the caller would fall back to .bak (issue #170 #6).
    serde_json::from_str(strip_bom(&content))
        .map_err(|e| format!("[config-io] Cannot parse config.json: {}", e))
}

fn write_all_synced(path: &Path, content: &str) -> Result<(), String> {
    // Pattern 5 fix #12: explicitly request 0o600 on Unix so cross-process
    // writers (Node sidecar / Rust commands / renderer) all produce config.json
    // files with the same user-private permissions. Without this, Rust
    // inherited the default umask (often 0o644) while Node enforced 0o600
    // directly — leaving the file readable to other users.
    #[cfg(unix)]
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("[config-io] Cannot open tmp config: {}", e))?;
    #[cfg(not(unix))]
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("[config-io] Cannot open tmp config: {}", e))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("[config-io] Cannot write tmp config: {}", e))?;
    file.sync_all()
        .map_err(|e| format!("[config-io] Cannot fsync tmp config: {}", e))?;
    Ok(())
}

/// fsync the directory holding `path` so a fresh tmp+rename is durable across
/// crashes. POSIX-only — Windows' `FlushFileBuffers` on a directory handle is
/// a documented no-op (and would require `FILE_FLAG_BACKUP_SEMANTICS` just to
/// open the handle), so the platform's own NTFS journaling is what we rely on
/// there. Splitting unix/non-unix into two functions instead of cfg-gating the
/// body keeps `path` from being flagged as unused on Windows.
#[cfg(unix)]
fn fsync_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let dir = OpenOptions::new()
            .read(true)
            .open(parent)
            .map_err(|e| format!("[config-io] Cannot open config dir for fsync: {}", e))?;
        dir.sync_all()
            .map_err(|e| format!("[config-io] Cannot fsync config dir: {}", e))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn fsync_parent_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Re-read `config.json` under lock, apply `mutator`, and atomically publish it.
///
/// `keep_backup` preserves existing `.bak` behavior for call sites that already
/// created one before this helper was introduced.
pub fn with_config_lock<F>(
    config_path: &Path,
    keep_backup: bool,
    mutator: F,
) -> Result<serde_json::Value, String>
where
    F: FnOnce(&mut serde_json::Value) -> Result<(), String>,
{
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[config-io] Cannot create config dir: {}", e))?;
    }

    let lock_path = config_path.with_file_name("config.json.lock");
    let config_path_owned: PathBuf = config_path.to_path_buf();

    // Borrow checker: the mutator + post-write logic capture environment by
    // value via the closure passed to `with_file_lock_blocking`. The error
    // helper converts our String errors into FileLockError::Io.
    fn to_io_err(msg: String) -> FileLockError {
        FileLockError::Io(std::io::Error::other(msg))
    }

    let result = with_file_lock_blocking(
        &lock_path,
        FileLockOptions::default(),
        move || -> Result<serde_json::Value, FileLockError> {
            let mut config = read_config_json(&config_path_owned).map_err(to_io_err)?;
            let before = config.clone();
            mutator(&mut config).map_err(to_io_err)?;

            if config == before {
                return Ok(config);
            }

            let content = serde_json::to_string_pretty(&config)
                .map_err(|e| to_io_err(format!("[config-io] Cannot serialize config: {}", e)))?;
            let tmp_path = config_path_owned.with_file_name("config.json.tmp.rust");
            let bak_path = config_path_owned.with_file_name("config.json.bak");

            write_all_synced(&tmp_path, &content).map_err(to_io_err)?;

            if keep_backup && config_path_owned.exists() {
                let _ = fs::copy(&config_path_owned, bak_path);
            }

            // Rust ≥1.81 (our MSRV) documents `fs::rename` as atomic
            // replace-on-existing across all platforms; the previous
            // `atomic_replace` shim that called MoveFileExW directly is no
            // longer needed.
            fs::rename(&tmp_path, &config_path_owned)
                .map_err(|e| to_io_err(format!("[config-io] Cannot rename tmp config: {}", e)))?;
            fsync_parent_dir(&config_path_owned).map_err(to_io_err)?;

            Ok(config)
        },
    );

    result.map_err(|e| match e {
        FileLockError::Busy { .. } => e.to_string(),
        FileLockError::Io(io_err) => format!("[config-io] {}", io_err),
    })
}

#[cfg(test)]
mod with_config_lock_tests {
    use super::with_config_lock;
    use serde_json::json;
    use std::fs;

    fn temp_config(tag: &str, initial: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xiaojing-config-lock-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("config.json");
        fs::write(&path, initial).expect("seed config");
        path
    }

    // GD-8① 回归：锁内重读 → mutator → 同目录临时文件原子替换的组合路径。
    #[test]
    fn rewrites_config_under_lock_and_replaces_atomically() {
        let path = temp_config("rewrite", r#"{"a":1,"lang":"zh-CN"}"#);
        let out = with_config_lock(&path, false, |config| {
            config["lang"] = json!("en-US");
            config["added"] = json!(true);
            Ok(())
        })
        .expect("locked write succeeds");
        assert_eq!(out["lang"], "en-US");
        let disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(disk["lang"], "en-US");
        assert_eq!(disk["added"], true);
        assert_eq!(disk["a"], 1, "unchanged keys survive the merge");
        // 同目录临时文件在成功后被 rename 走，不留残片。
        assert!(!path.with_file_name("config.json.tmp.rust").exists());
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn no_op_mutator_does_not_rewrite_or_keep_backup() {
        let path = temp_config("noop", r#"{"a":1}"#);
        let before = fs::read_to_string(&path).unwrap();
        let out = with_config_lock(&path, true, |config| {
            let _ = config;
            Ok(())
        })
        .expect("no-op under lock");
        assert_eq!(out.to_string(), before.trim().replace("\n", "").replace("  ", ""));
        assert_eq!(fs::read_to_string(&path).unwrap(), before, "file untouched");
        assert!(!path.with_file_name("config.json.bak").exists());
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn keep_backup_preserves_previous_content() {
        let path = temp_config("backup", r#"{"v":1}"#);
        with_config_lock(&path, true, |config| {
            config["v"] = json!(2);
            Ok(())
        })
        .expect("first write");
        with_config_lock(&path, true, |config| {
            config["v"] = json!(3);
            Ok(())
        })
        .expect("second write");
        let bak: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(path.with_file_name("config.json.bak")).unwrap(),
        )
        .unwrap();
        assert_eq!(bak["v"], 2, "backup holds the pre-write content");
        let cur: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(cur["v"], 3);
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn sequential_locks_re_read_latest_disk_state() {
        let path = temp_config("reread", r#"{"counter":0}"#);
        for expected in 1..=2 {
            with_config_lock(&path, false, |config| {
                let n = config["counter"].as_i64().unwrap_or(0);
                config["counter"] = json!(n + 1);
                Ok(())
            })
            .expect("increment");
            let cur: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(cur["counter"].as_i64(), Some(expected));
        }
        fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
