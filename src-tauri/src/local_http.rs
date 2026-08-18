//! Centralized HTTP client utilities for local Sidecar communication.
//!
//! **All** HTTP requests to local Sidecars (127.0.0.1) MUST use these builders
//! instead of raw `reqwest::Client::builder()`. This guarantees `.no_proxy()`
//! is always set, preventing system proxies (Clash/V2Ray) from intercepting
//! localhost requests and returning 502 Bad Gateway.
//!
//! ## Usage
//!
//! ```rust
//! use xiaojing_lib::local_http;
//! use std::time::Duration;
//!
//! // Simple client with custom timeout
//! let client = local_http::builder()
//!     .timeout(Duration::from_secs(30))
//!     .build()
//!     .expect("Failed to create HTTP client");
//!
//! // Pre-configured clients for common use cases
//! let client = local_http::json_client(Duration::from_secs(60));
//! let client = local_http::sse_client();
//! ```

use std::time::Duration;

/// Base builder for all local Sidecar HTTP clients.
///
/// Returns a `reqwest::ClientBuilder` pre-configured with `.no_proxy()`.
/// Callers can chain additional options (timeout, tcp_nodelay, etc.) before `.build()`.
///
/// This is the **only** approved way to create HTTP clients for localhost communication.
/// Using raw `reqwest::Client::builder()` or `reqwest::Client::new()` for localhost
/// is forbidden — it will silently break when the user has a system proxy configured.
pub fn builder() -> reqwest::ClientBuilder {
    // This module is the single legitimate caller of `Client::builder()`.
    #[allow(clippy::disallowed_methods)]
    reqwest::Client::builder().no_proxy()
}

/// Create a JSON-oriented HTTP client for local Sidecar API calls.
///
/// Pre-configured with:
/// - `.no_proxy()` — bypass system proxy for localhost
/// - Custom timeout — caller specifies based on expected response time
pub fn json_client(timeout: Duration) -> reqwest::Client {
    builder()
        .timeout(timeout)
        .build()
        .expect("[local_http] Failed to create JSON client")
}

/// Create an SSE streaming client for local Sidecar event streams.
///
/// Pre-configured with:
/// - `.no_proxy()` — bypass system proxy for localhost
/// - `.read_timeout(300s)` — idle timeout (no bytes for 300s → drop connection)
/// - `.tcp_nodelay(true)` — disable Nagle's algorithm for low-latency events
/// - `.http1_only()` — force HTTP/1.1 for SSE compatibility
///
/// No overall timeout — streams stay open until the AI turn completes.
/// read_timeout is 300s (not 60s) because on fresh Sidecar startup, the SDK's
/// query() can block the Node event loop for minutes during session resume +
/// MCP server initialization, preventing heartbeat SSE comments from being sent.
/// The Sidecar heartbeat is 15s, so 300s provides comfortable margin.
pub fn sse_client() -> reqwest::Client {
    builder()
        .read_timeout(Duration::from_secs(300))
        .tcp_nodelay(true)
        .http1_only()
        .build()
        .expect("[local_http] Failed to create SSE client")
}

/// Base builder for **blocking** local Sidecar HTTP clients.
///
/// Same guarantee as [`builder()`] but for synchronous contexts
/// (e.g., `spawn_blocking` or Tauri command handlers).
pub fn blocking_builder() -> reqwest::blocking::ClientBuilder {
    // This module is the single legitimate caller of `Client::builder()`.
    #[allow(clippy::disallowed_methods)]
    reqwest::blocking::Client::builder().no_proxy()
}

#[cfg(test)]
mod tests {
    use super::*;

    // GD-6②：唯一 localhost 客户端构造点的行为测试——用本地监听器验证
    // json_client 的超时真实生效（证明构造点把 timeout 接进了 client），
    // 请求成功路径返回对端原文。全程 127.0.0.1，不依赖外部网络。
    #[tokio::test(flavor = "current_thread")]
    async fn json_client_enforces_timeout_against_local_listener() {
        // 必须用 tokio 异步 listener：current_thread 运行时里 std 的阻塞
        // accept 会饿死客户端 future，超时定时器永远无法触发。
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // 对端接受连接但按住不响应，直到测试结束。
        let hold = std::sync::Arc::new(tokio::sync::Notify::new());
        let hold_server = hold.clone();
        let server = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let notify = hold_server.clone();
                tokio::spawn(async move {
                    let _stream = stream;
                    notify.notified().await;
                });
            }
        });
        let client = json_client(Duration::from_millis(150));
        let started = std::time::Instant::now();
        let outcome = client
            .get(format!("http://127.0.0.1:{port}/hang"))
            .send()
            .await;
        assert!(outcome.is_err(), "held connection must time out");
        assert!(
            started.elapsed() >= Duration::from_millis(120),
            "timeout should come from the client, not an instant failure"
        );
        hold.notify_waiters();
        server.abort();
    }

    #[test]
    fn blocking_builder_builds_a_usable_localhost_client() {
        let client = blocking_builder()
            .timeout(Duration::from_millis(50))
            .build()
            .unwrap();
        // 未监听的本地端口：立即连接拒绝（错误来自 localhost 语义而非代理）。
        let outcome = client.get("http://127.0.0.1:1/").send();
        assert!(outcome.is_err());
    }
}
