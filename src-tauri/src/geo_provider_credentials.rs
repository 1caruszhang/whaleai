//! GEO provider credential projection for the Rust-side publish path.
//!
//! 票 06 起客户端不再管理 Provider 凭据：配置 UI、Windows 凭据管理器写
//! 入和 Sidecar admission 注入均已移除，账号态 admission 见
//! `account_auth.rs`。本模块只保留确定性 PublishScheduler 与发布后监测
//! 仍需要的直连凭据读取（Windows 既有凭据 + debug `.env` 兜底）与签名
//! helper；票 08 把发布切到网关 port 后可整体移除。

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::collections::BTreeMap;

const MAX_CREDENTIAL_BYTES: usize = 2_560;
const DISTRIBUTION_BASE_URL: &str = "https://vip.chaojimeijie.com/api";

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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GeoProviderServiceId {
    Ark,
    Embedding,
    ObjectStorage,
    Distribution,
}

impl GeoProviderServiceId {
    #[cfg(windows)]
    fn target_suffix(self) -> &'static str {
        match self {
            Self::Ark => "ark",
            Self::Embedding => "embedding",
            Self::ObjectStorage => "object-storage",
            Self::Distribution => "distribution",
        }
    }

    fn allowed_fields(self) -> &'static [&'static str] {
        match self {
            Self::Ark => &["apiKey", "doubaoSearchApiKey"],
            Self::Embedding => &["apiKey", "endpointId"],
            Self::ObjectStorage => &[
                "accessKeyId",
                "accessKeySecret",
                "bucket",
                "region",
                "publicBaseUrl",
            ],
            Self::Distribution => &["appId", "secret", "baseUrl"],
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(transparent)]
struct ServiceCredential(BTreeMap<String, String>);

fn validate_service_credential(
    service: GeoProviderServiceId,
    fields: BTreeMap<String, String>,
) -> Result<ServiceCredential, String> {
    if fields
        .keys()
        .any(|key| !service.allowed_fields().contains(&key.as_str()))
    {
        return Err("凭据字段不属于固定 GEO 服务配置".to_string());
    }
    let mut normalized = BTreeMap::new();
    for (key, value) in fields {
        let value = value.trim();
        if !value.is_empty() {
            normalized.insert(key, value.to_string());
        }
    }
    let required: &[&str] = match service {
        GeoProviderServiceId::Ark => &["apiKey"],
        GeoProviderServiceId::Embedding => &["endpointId"],
        GeoProviderServiceId::ObjectStorage => &["accessKeyId", "accessKeySecret", "bucket"],
        GeoProviderServiceId::Distribution => &["appId", "secret"],
    };
    if required
        .iter()
        .any(|field| !normalized.contains_key(*field))
    {
        return Err("请填写该服务的全部必填配置".to_string());
    }
    if let Some(endpoint_id) = normalized.get("endpointId") {
        if endpoint_id.len() > 128
            || !endpoint_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("ARK Embedding 接入点 ID 格式无效".to_string());
        }
    }
    if let Some(bucket) = normalized.get("bucket") {
        if bucket.len() > 63
            || bucket.len() < 3
            || !bucket
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("OSS Bucket 名称格式无效".to_string());
        }
    }
    for field in ["baseUrl", "publicBaseUrl"] {
        if let Some(url) = normalized.get(field) {
            let parsed = url::Url::parse(url).map_err(|_| format!("{field} 不是有效 URL"))?;
            if parsed.scheme() != "https" || parsed.host_str().is_none() {
                return Err(format!("{field} 必须是 HTTPS URL"));
            }
        }
    }
    let encoded = serde_json::to_vec(&ServiceCredential(normalized.clone()))
        .map_err(|_| "服务配置序列化失败".to_string())?;
    if encoded.len() > MAX_CREDENTIAL_BYTES {
        return Err("服务配置长度超出 Windows 凭据限制".to_string());
    }
    Ok(ServiceCredential(normalized))
}

#[cfg(windows)]
mod platform {
    use super::{GeoProviderServiceId, ServiceCredential};
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND},
        Security::Credentials::{CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC},
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn target(service: GeoProviderServiceId) -> String {
        format!("Xiaojing/GEO/{}", service.target_suffix())
    }

    pub fn read(service: GeoProviderServiceId) -> Result<Option<ServiceCredential>, String> {
        let target = wide(&target(service));
        let mut raw: *mut CREDENTIALW = ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return if code == ERROR_NOT_FOUND {
                Ok(None)
            } else {
                Err(format!("读取 Windows GEO 服务凭据失败（系统错误 {code}）"))
            };
        }
        let result = unsafe {
            let credential = &*raw;
            let bytes = slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            );
            serde_json::from_slice::<ServiceCredential>(bytes)
                .map(Some)
                .map_err(|_| "Windows GEO 服务凭据格式无效".to_string())
        };
        unsafe { CredFree(raw.cast()) };
        result
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

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

fn development_credential(service: GeoProviderServiceId) -> Option<ServiceCredential> {
    #[cfg(not(debug_assertions))]
    {
        let _ = service;
        None
    }
    #[cfg(debug_assertions)]
    {
        let pairs: &[(&str, Option<String>)] = match service {
            GeoProviderServiceId::Ark => &[
                ("apiKey", env_value("ARK_API_KEY")),
                ("doubaoSearchApiKey", env_value("DOUBAO_SEARCH_API_KEY")),
            ],
            GeoProviderServiceId::Embedding => &[
                (
                    "apiKey",
                    env_value("ARK_EMBEDDING_API_KEY").or_else(|| env_value("ARK_API_KEY")),
                ),
                ("endpointId", env_value("ARK_EMBEDDING_MODEL")),
            ],
            GeoProviderServiceId::ObjectStorage => &[
                ("accessKeyId", env_value("ALI_OSS_ACCESS_KEY_ID")),
                ("accessKeySecret", env_value("ALI_OSS_ACCESS_KEY_SECRET")),
                ("bucket", env_value("ALI_OSS_BUCKET")),
                ("region", env_value("ALI_OSS_REGION")),
                ("publicBaseUrl", env_value("ALI_OSS_PUBLIC_BASE_URL")),
            ],
            GeoProviderServiceId::Distribution => &[
                ("appId", env_value("CHAOJIMEIJIE_APPID")),
                ("secret", env_value("CHAOJIMEIJIE_SECRET")),
                ("baseUrl", env_value("CHAOJIMEIJIE_API_BASE_URL")),
            ],
        };
        let fields = pairs
            .iter()
            .filter_map(|(key, value)| value.clone().map(|value| ((*key).to_string(), value)))
            .collect::<BTreeMap<_, _>>();
        validate_service_credential(service, fields).ok()
    }
}

fn load_service(
    service: GeoProviderServiceId,
) -> Result<(Option<ServiceCredential>, &'static str), String> {
    #[cfg(windows)]
    if let Some(credential) = platform::read(service)? {
        return Ok((Some(credential), "windows-credential-manager"));
    }
    if let Some(credential) = development_credential(service) {
        return Ok((Some(credential), "development-env"));
    }
    Ok((None, "missing"))
}

fn config_value<'a>(credential: &'a ServiceCredential, key: &str) -> Option<&'a str> {
    credential.0.get(key).map(String::as_str)
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut normalized = [0_u8; BLOCK];
    if key.len() > BLOCK {
        normalized[..20].copy_from_slice(&Sha1::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK];
    let mut outer_pad = [0x5c_u8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha1::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha1::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    outer.finalize().to_vec()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut normalized = [0_u8; BLOCK];
    if key.len() > BLOCK {
        normalized[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        normalized[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; BLOCK];
    let mut outer_pad = [0x5c_u8; BLOCK];
    for index in 0..BLOCK {
        inner_pad[index] ^= normalized[index];
        outer_pad[index] ^= normalized[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    outer.finalize().to_vec()
}

#[derive(Clone, Debug)]
pub(crate) struct PublishObjectStorageCredential {
    pub access_key_id: String,
    pub access_key_secret: String,
    pub bucket: String,
    pub region: String,
    pub public_base_url: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct PublishDistributionCredential {
    pub app_id: String,
    pub secret: String,
    pub base_url: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PublishProviderCredentials {
    pub object_storage: Option<PublishObjectStorageCredential>,
    pub distribution: Option<PublishDistributionCredential>,
}

/// Rust-only credential projection for the deterministic PublishScheduler.
/// Callers must never serialize, log, persist, or send this value to a Sidecar.
pub(crate) fn load_publish_provider_credentials() -> Result<PublishProviderCredentials, String> {
    let (oss, _) = load_service(GeoProviderServiceId::ObjectStorage)?;
    let (distribution, _) = load_service(GeoProviderServiceId::Distribution)?;
    let object_storage = oss
        .as_ref()
        .map(|value| {
            Ok::<PublishObjectStorageCredential, String>(PublishObjectStorageCredential {
                access_key_id: config_value(value, "accessKeyId")
                    .ok_or("OSS AccessKey ID 未配置")?
                    .to_string(),
                access_key_secret: config_value(value, "accessKeySecret")
                    .ok_or("OSS AccessKey Secret 未配置")?
                    .to_string(),
                bucket: config_value(value, "bucket")
                    .ok_or("OSS Bucket 未配置")?
                    .to_string(),
                region: config_value(value, "region")
                    .unwrap_or("oss-cn-beijing")
                    .to_string(),
                public_base_url: config_value(value, "publicBaseUrl").map(str::to_string),
            })
        })
        .transpose()?;
    let distribution = distribution
        .as_ref()
        .map(|value| {
            Ok::<PublishDistributionCredential, String>(PublishDistributionCredential {
                app_id: config_value(value, "appId")
                    .ok_or("超级媒介 AppID 未配置")?
                    .to_string(),
                secret: config_value(value, "secret")
                    .ok_or("超级媒介 Secret 未配置")?
                    .to_string(),
                base_url: config_value(value, "baseUrl")
                    .unwrap_or(DISTRIBUTION_BASE_URL)
                    .to_string(),
            })
        })
        .transpose()?;
    Ok(PublishProviderCredentials {
        object_storage,
        distribution,
    })
}

pub(crate) fn publish_hmac_sha1(key: &[u8], message: &[u8]) -> Vec<u8> {
    hmac_sha1(key, message)
}

pub(crate) fn publish_hmac_sha256(key: &[u8], message: &[u8]) -> Vec<u8> {
    hmac_sha256(key, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn rejects_unknown_fields_and_missing_required_values() {
        let mut fields = BTreeMap::new();
        fields.insert("apiKey".to_string(), "test-value".to_string());
        fields.insert("model".to_string(), "attacker-model".to_string());
        assert!(validate_service_credential(GeoProviderServiceId::Ark, fields).is_err());
        assert!(
            validate_service_credential(GeoProviderServiceId::Embedding, BTreeMap::new()).is_err()
        );
    }

    #[test]
    fn ark_accepts_optional_doubao_search_key() {
        let mut fields = BTreeMap::new();
        fields.insert("apiKey".to_string(), "paygo-key".to_string());
        fields.insert("doubaoSearchApiKey".to_string(), "search-key".to_string());
        assert!(validate_service_credential(GeoProviderServiceId::Ark, fields.clone()).is_ok());
        // 空值在归一化时被剔除：只配 paygo key（走 arkApiKey 兜底）也合法。
        fields.insert("doubaoSearchApiKey".to_string(), "  ".to_string());
        assert!(validate_service_credential(GeoProviderServiceId::Ark, fields).is_ok());
    }

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

    #[test]
    fn hmac_implementations_match_standard_vectors() {
        let message = b"The quick brown fox jumps over the lazy dog";
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(hmac_sha1(b"key", message)),
            "3nybhbi3iqa8ino29wqQcBydtNk="
        );
        assert_eq!(
            hmac_sha256(b"key", message)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }
}
