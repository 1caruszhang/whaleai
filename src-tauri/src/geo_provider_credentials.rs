//! 旧 GEO Provider 凭据体系的环境清洗残留（票 06–08 演进，票 14 收口）。
//!
//! 票 06 起客户端不再管理 Provider 凭据：配置 UI、Windows 凭据管理器写入
//! 和 Sidecar admission 注入均已移除，账号态 admission 见 `account_auth.rs`。
//! 票 08 把发布执行器、票 14 把发布后监测查单先后切到网关 port
//! （Rust 经 Sidecar egress 路由 → 网关重签计费）后，直连超级媒介凭据
//! 读取与 HMAC-SHA256 签名 helper 已无调用方，随票 14 整体移除。
//!
//! 本模块现只承载子进程环境清洗名单（`SIDECAR_ENV_NAMES` /
//! `DEVELOPMENT_SOURCE_ENV_NAMES`，纵深防御：伪造的父环境不能把旧
//! 传输名重新注入 Sidecar）与 `account_auth` 复用的网关地址覆盖校验。

/// 旧 Provider 凭据 admission 的传输名。注入路径已被账号 admission 替代，
/// 仅保留给 `account_auth` 做子进程环境清洗。
pub(crate) const SIDECAR_ENV_NAMES: &[&str] = &[
    "XIAOJING_ARK_API_KEY",
    "XIAOJING_DOUBAO_SEARCH_API_KEY",
    "XIAOJING_ARK_CONFIGURATION_FINGERPRINT",
    "XIAOJING_ARK_EMBEDDING_API_KEY",
    "XIAOJING_ARK_EMBEDDING_ENDPOINT_ID",
    "XIAOJING_OSS_ACCESS_KEY_ID",
    "XIAOJING_OSS_ACCESS_KEY_SECRET",
    "XIAOJING_OSS_BUCKET",
    "XIAOJING_OSS_REGION",
    "XIAOJING_OSS_PUBLIC_BASE_URL",
    "XIAOJING_DISTRIBUTION_APP_ID",
    "XIAOJING_DISTRIBUTION_SECRET",
    "XIAOJING_DISTRIBUTION_BASE_URL",
    "XIAOJING_ARK_PAYGO_BASE_URL",
    "XIAOJING_DOUBAO_SEARCH_BASE_URL",
];

pub(crate) const DEVELOPMENT_SOURCE_ENV_NAMES: &[&str] = &[
    "ARK_API_KEY",
    "DOUBAO_SEARCH_API_KEY",
    "ARK_EMBEDDING_API_KEY",
    "ARK_EMBEDDING_MODEL",
    "ALI_OSS_ACCESS_KEY_ID",
    "ALI_OSS_ACCESS_KEY_SECRET",
    "ALI_OSS_BUCKET",
    "ALI_OSS_REGION",
    "ALI_OSS_PUBLIC_BASE_URL",
    "CHAOJIMEIJIE_APPID",
    "CHAOJIMEIJIE_SECRET",
    "CHAOJIMEIJIE_API_BASE_URL",
    "ARK_PAYGO_BASE_URL",
    "DOUBAO_SEARCH_BASE_URL",
];

/// 端点覆盖校验（票 06 起由 account_auth 的网关地址覆盖复用）：只接受
/// 绝对 http(s) URL；release 构建不读环境，伪造的父环境不能重定向流量。
pub(crate) fn normalize_endpoint_override(raw: Option<String>) -> Option<String> {
    raw.filter(|value| {
        url::Url::parse(value)
            .map(|parsed| {
                (parsed.scheme() == "http" || parsed.scheme() == "https")
                    && parsed.host_str().is_some()
            })
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_overrides_require_absolute_http_urls() {
        assert_eq!(
            normalize_endpoint_override(Some("https://gateway.example.test/api".to_string())),
            Some("https://gateway.example.test/api".to_string())
        );
        // 本地网关冒烟允许 http，但协议外方案与残缺值一律拒绝。
        assert_eq!(
            normalize_endpoint_override(Some("http://127.0.0.1:8787".to_string())),
            Some("http://127.0.0.1:8787".to_string())
        );
        assert_eq!(
            normalize_endpoint_override(Some("ftp://gateway.example.test".to_string())),
            None
        );
        assert_eq!(
            normalize_endpoint_override(Some("not-a-url".to_string())),
            None
        );
        assert_eq!(normalize_endpoint_override(None), None);
    }
}
