//! 品牌集服务端镜像上报（票 50，ADR 0007）。
//!
//! ## Owner 定死（ARCHITECTURE.md 核心 owner 表）
//!
//! 品牌事实的权威 owner 是 Rust `BrandWorkspaceStore`（持久化在品牌目录
//! `brands.json`）；服务端 `account_brands` 只是它的只读镜像。因此上报由
//! Rust 发起：每次触发都从 `list_workspaces()` **现读权威目录**构造全量
//! 快照 `[{workspaceId, name}]`，绝不经 renderer 转发品牌数据（不另立第
//! 二事实源），renderer 对上报全程无感。账号 token 复用 account owner
//! 的既有通道（`account_auth::fresh_account_access_token`，OS 凭据库 +
//! 单飞轮换），不新造凭据通道。
//!
//! ## 触发点（全部钉在真实写路径/生命周期上）
//!
//! - 品牌工作区新建成功：`cmd_brand_workspace_create`；
//! - 品牌工作区删除成功：`cmd_brand_workspace_delete`（catalog 移除后）；
//! - 账号登录成功：`cmd_account_login`；
//! - 应用启动：`lib.rs` setup（未登录自动跳过）。
//!
//! 品牌工作区改名目前产品无写路径（名称只在创建时写入 catalog）。改名
//! 功能落地时，必须在写成功处接同一
//! `report_brand_mirror_now(BrandMirrorTrigger::WorkspaceRenamed)`——此处
//! 预留该触发枚举，避免届时再造一套上报路径。
//!
//! ## 失败语义
//!
//! 全部 fire-and-forget：未登录/目录读取/网络/后端拒绝一律静默（debug
//! 日志），不打扰用户；下一次任一触发自然补报。后端 PUT 是全量快照整组
//! 替换（幂等），多设备同账号后写覆盖。

use serde::{Deserialize, Serialize};

use crate::brand_workspace::BrandWorkspace;

/// 上报触发来源：仅用于日志与后续排查，不改变上报语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrandMirrorTrigger {
    WorkspaceCreated,
    /// 预留：产品尚无品牌工作区改名写路径，落地时在此接线。
    #[allow(dead_code)]
    WorkspaceRenamed,
    WorkspaceDeleted,
    AccountLogin,
    AppStartup,
}

impl BrandMirrorTrigger {
    fn label(self) -> &'static str {
        match self {
            Self::WorkspaceCreated => "workspace-created",
            Self::WorkspaceRenamed => "workspace-renamed",
            Self::WorkspaceDeleted => "workspace-deleted",
            Self::AccountLogin => "account-login",
            Self::AppStartup => "app-startup",
        }
    }
}

/// 快照单条：与后端 PUT /auth/me/brands 契约同形（camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrandMirrorEntry {
    workspace_id: String,
    name: String,
}

/// 从权威目录投影出上报 payload。只投影 id 与 name（镜像契约所需），
/// 排序钉死为 name 字节序（与运营台 GET /admin/accounts 的展示顺序同口
/// 径），同 name 再按 id 决胜，保证快照在触发之间确定性稳定。
fn brand_snapshot_payload(workspaces: &[BrandWorkspace]) -> Vec<BrandMirrorEntry> {
    let mut entries: Vec<BrandMirrorEntry> = workspaces
        .iter()
        .map(|workspace| BrandMirrorEntry {
            workspace_id: workspace.id.clone(),
            name: workspace.name.clone(),
        })
        .collect();
    entries.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.workspace_id.cmp(&right.workspace_id))
    });
    entries
}

/// PUT 快照到运营网关。非 2xx（含停用账号 403）一律 Err，由调用方静默。
/// 成功返回 Ok；`entries` 已按确定顺序排列。
async fn push_brand_snapshot(
    client: &reqwest::Client,
    base_url: &str,
    access_token: &str,
    entries: &[BrandMirrorEntry],
) -> Result<(), String> {
    let response = client
        .put(format!("{base_url}/auth/me/brands"))
        .bearer_auth(access_token)
        .json(entries)
        .send()
        .await
        .map_err(|error| format!("send brand snapshot: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "brand snapshot rejected with status {}",
            response.status()
        ));
    }
    Ok(())
}

/// 上报一次快照的核心流水（依赖注入测试缝，语义与 `resolve_fresh_token`
/// 同类）：
/// - `token: None`（未登录）→ 直接 Err，不读目录、不发请求；
/// - 目录读取/网络/后端失败 → Err 原样返回，绝不 panic、绝不向外抛。
async fn report_snapshot_core<Push, PushFut>(
    token: Option<String>,
    read_workspaces: impl std::future::Future<Output = Result<Vec<BrandWorkspace>, String>>,
    push: Push,
) -> Result<(), String>
where
    Push: FnOnce(String, Vec<BrandMirrorEntry>) -> PushFut,
    PushFut: std::future::Future<Output = Result<(), String>>,
{
    let token = token.ok_or_else(|| "not logged in".to_string())?;
    let workspaces = read_workspaces.await?;
    let snapshot = brand_snapshot_payload(&workspaces);
    push(token, snapshot).await
}

/// fire-and-forget 触发上报：未登录/失败一律静默（debug 日志），下一次
/// 触发自然补报。可在任意上下文调用（内部用 `tauri::async_runtime::spawn`）。
pub(crate) fn report_brand_mirror_now(trigger: BrandMirrorTrigger) {
    tauri::async_runtime::spawn(async move {
        let outcome = report_snapshot_core(
            crate::account_auth::fresh_account_access_token().await,
            async {
                tauri::async_runtime::spawn_blocking(|| {
                    crate::brand_workspace::production_store()?.list_workspaces()
                })
                .await
                .map_err(|error| format!("read brand catalog: {error}"))?
            },
            |token, snapshot| async move {
                let client = crate::account_auth::gateway_client()?;
                push_brand_snapshot(
                    &client,
                    &crate::account_auth::gateway_base_url(),
                    &token,
                    &snapshot,
                )
                .await
            },
        )
        .await;
        if let Err(error) = outcome {
            crate::ulog_debug!(
                "[brand-mirror] trigger={} skipped or failed: {error}",
                trigger.label()
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn workspace(id: &str, name: &str) -> BrandWorkspace {
        BrandWorkspace {
            id: id.to_string(),
            name: name.to_string(),
            product_lines: vec![],
            root_path: PathBuf::from(format!("/tmp/{id}")),
            created_at: "2026-09-01T00:00:00.000Z".to_string(),
            updated_at: "2026-09-01T00:00:00.000Z".to_string(),
        }
    }

    fn entry(workspace_id: &str, name: &str) -> BrandMirrorEntry {
        BrandMirrorEntry {
            workspace_id: workspace_id.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn snapshot_payload_projects_id_and_name_only_sorted_by_name() {
        let payload = brand_snapshot_payload(&[
            workspace("ws-b", "品牌二"),
            workspace("ws-a", "品牌一"),
            workspace("ws-a2", "品牌一"),
        ]);
        assert_eq!(
            payload,
            vec![
                entry("ws-a", "品牌一"),
                entry("ws-a2", "品牌一"),
                entry("ws-b", "品牌二"),
            ]
        );
        // 序列化形状即后端契约 [{workspaceId, name}]（camelCase）。
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json[0]["workspaceId"], "ws-a");
        assert_eq!(json[0]["name"], "品牌一");
        assert!(json[0].get("rootPath").is_none(), "不得外泄目录内其他字段");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn core_skips_entirely_when_logged_out() {
        // 未登录：不读目录、不发请求。
        let outcome = report_snapshot_core(
            None,
            async { panic!("logged out must not read the brand catalog") },
            |_, _| async { panic!("logged out must not push") },
        )
        .await;
        assert_eq!(outcome, Err("not logged in".to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn core_propagates_catalog_read_failure_without_pushing() {
        let outcome = report_snapshot_core(
            Some("fresh-jwt-1".to_string()),
            async { Err("read brand catalog: permission denied".to_string()) },
            |_, _| async { panic!("catalog failure must not push") },
        )
        .await;
        assert!(outcome
            .unwrap_err()
            .contains("read brand catalog: permission denied"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn core_pushes_payload_built_from_authoritative_catalog() {
        let outcome = report_snapshot_core(
            Some("fresh-jwt-1".to_string()),
            async {
                Ok(vec![
                    workspace("ws-b", "品牌二"),
                    workspace("ws-a", "品牌一"),
                ])
            },
            |token, snapshot| async move {
                assert_eq!(token, "fresh-jwt-1");
                assert_eq!(
                    snapshot,
                    vec![entry("ws-a", "品牌一"), entry("ws-b", "品牌二")]
                );
                Ok(())
            },
        )
        .await;
        assert_eq!(outcome, Ok(()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn core_returns_push_failure_instead_of_panicking() {
        let outcome = report_snapshot_core(
            Some("fresh-jwt-1".to_string()),
            async { Ok(vec![workspace("ws-a", "品牌一")]) },
            |_, _| async { Err("brand snapshot rejected with status 403".to_string()) },
        )
        .await;
        assert!(outcome.unwrap_err().contains("403"));
    }

    /// 读取一条完整 HTTP 请求（头 + content-length 定长 body）。
    async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut scratch = [0_u8; 4096];
        loop {
            tokio::time::timeout(std::time::Duration::from_secs(5), stream.readable())
                .await
                .expect("request readable timed out")
                .expect("connection closed while reading request");
            match stream.try_read(&mut scratch) {
                Ok(0) => break,
                Ok(read) => {
                    buffer.extend_from_slice(&scratch[..read]);
                    if let Some(header_end) = find_subsequence(&buffer, b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buffer[..header_end]);
                        let content_length = head
                            .lines()
                            .find_map(|line| {
                                let lower = line.to_ascii_lowercase();
                                lower
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if buffer.len() >= header_end + 4 + content_length {
                            break;
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("read request failed: {error}"),
            }
        }
        buffer
    }

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn push_puts_authoritative_snapshot_with_bearer_token() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (captured_tx, mut captured_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(1);
        // 测试进程内 mock 网关：tokio 测试运行时有自己的 runtime，与既有
        // publish_scheduler 测试同款豁免。
        #[allow(clippy::disallowed_methods)]
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut stream).await;
            let _ = captured_tx.send(request).await;
            let _ = stream.try_write(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 12\r\n\r\n{\"ok\":true}",
            );
        });

        let client = crate::local_http::json_client(std::time::Duration::from_secs(5));
        let entries = [entry("ws-a", "品牌一"), entry("ws-b", "品牌二")];
        push_brand_snapshot(
            &client,
            &format!("http://127.0.0.1:{port}"),
            "fresh-jwt-1",
            &entries,
        )
        .await
        .unwrap();
        server.await.unwrap();

        let raw = captured_rx.recv().await.unwrap();
        let head_end = find_subsequence(&raw, b"\r\n\r\n").expect("request head terminator");
        let head = String::from_utf8_lossy(&raw[..head_end]);
        let body = &raw[head_end + 4..];
        assert!(
            head.starts_with("PUT /auth/me/brands HTTP/1.1"),
            "unexpected request head: {head}"
        );
        assert!(
            head.to_ascii_lowercase()
                .contains("authorization: bearer fresh-jwt-1"),
            "missing bearer token header: {head}"
        );
        let parsed: Vec<BrandMirrorEntry> = serde_json::from_slice(body).unwrap();
        assert_eq!(
            parsed, entries,
            "body must be the exact {{workspaceId, name}} snapshot"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn push_reports_non_success_status_as_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        #[allow(clippy::disallowed_methods)]
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut stream).await;
            let _ = stream.try_write(
                b"HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
            );
        });

        let client = crate::local_http::json_client(std::time::Duration::from_secs(5));
        let error = push_brand_snapshot(
            &client,
            &format!("http://127.0.0.1:{port}"),
            "stale-jwt",
            &[entry("ws-a", "品牌一")],
        )
        .await
        .unwrap_err();
        assert!(error.contains("403"), "unexpected error: {error}");
        server.await.unwrap();
    }
}
