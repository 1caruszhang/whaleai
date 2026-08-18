//! Workspace file IO commands.
//!
//! This module is the canonical home for "operations against a workspace path"
//! required by the chat and GEO workbench. They live in Rust so file authority
//! remains independent from the lifetime of a conversation sidecar.
//!
//! Workspace files are an OS resource, not an AI runtime resource. Renderer
//! access therefore goes through the `cmd_workspace_*` commands registered by
//! the Tauri owner rather than depending on a sidecar HTTP endpoint.

pub mod check_paths;
pub mod crud;
pub mod download;
pub mod files_b64;
pub mod gitignore;
pub mod path_safety;
pub mod read_preview;
pub mod save_file;
pub mod system_open;
#[cfg(test)]
pub(crate) mod test_support;
pub mod transfer;
pub mod user_attachments;
pub mod watcher;

// `lib.rs` registers each command with the FULL submodule path
// (e.g. `workspace_files::files_b64::cmd_workspace_import_files_b64`) because
// `tauri::generate_handler!` looks up auto-generated `__cmd__<name>` wrappers
// in the same module that defined the command. Re-exporting at this level
// would NOT bring the wrapper along, so we deliberately don't.
