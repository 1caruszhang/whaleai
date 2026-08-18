//! Application-scoped GEO provider credential owner.
//!
//! Windows release builds persist one JSON credential per service in Windows
//! Credential Manager. Debug builds may materialize the documented `.env`
//! variables, but never copy them into config, brand databases, transcripts,
//! logs, or the application bundle.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::AppHandle;

const MAX_CREDENTIAL_BYTES: usize = 2_560;
const ARK_BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";
const ARK_KEYWORD_MODEL: &str = "doubao-seed-2-0-lite-260428";
const ARK_GENERATION_MODEL: &str = "doubao-seed-2-0-pro-260215";
const DISTRIBUTION_BASE_URL: &str = "https://vip.chaojimeijie.com/api";

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoProviderCapabilityStatus {
    slot: &'static str,
    state: &'static str,
    source: &'static str,
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoProviderCapabilityVerifyResult {
    slot: String,
    state: &'static str,
    source: &'static str,
    detail: Option<String>,
}

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
        Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME},
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
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

    pub fn write(service: GeoProviderServiceId, value: &ServiceCredential) -> Result<(), String> {
        let mut target = wide(&target(service));
        let mut username = wide("Xiaojing");
        let mut blob = serde_json::to_vec(value).map_err(|_| "服务配置序列化失败".to_string())?;
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: ptr::null_mut(),
            LastWritten: FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: ptr::null_mut(),
            UserName: username.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&credential, 0) };
        blob.fill(0);
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!("写入 Windows GEO 服务凭据失败（系统错误 {code}）"));
        }
        Ok(())
    }

    pub fn delete(service: GeoProviderServiceId) -> Result<(), String> {
        let target = wide(&target(service));
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_NOT_FOUND {
                return Err(format!("删除 Windows GEO 服务凭据失败（系统错误 {code}）"));
            }
        }
        Ok(())
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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
                (
                    "doubaoSearchApiKey",
                    env_value("DOUBAO_SEARCH_API_KEY"),
                ),
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

pub(crate) fn inject_into_sidecar(command: &mut std::process::Command) -> Result<(), String> {
    for name in SIDECAR_ENV_NAMES {
        command.env_remove(name);
    }
    let (ark, _) = load_service(GeoProviderServiceId::Ark)?;
    let (embedding, _) = load_service(GeoProviderServiceId::Embedding)?;
    let (oss, _) = load_service(GeoProviderServiceId::ObjectStorage)?;
    let (distribution, _) = load_service(GeoProviderServiceId::Distribution)?;

    if let Some(value) = ark.as_ref().and_then(|value| config_value(value, "apiKey")) {
        command.env("XIAOJING_ARK_API_KEY", value);
    }
    if let Some(value) = ark
        .as_ref()
        .and_then(|value| config_value(value, "doubaoSearchApiKey"))
    {
        command.env("XIAOJING_DOUBAO_SEARCH_API_KEY", value);
    }
    if let Some(value) = ark.as_ref() {
        let encoded =
            serde_json::to_vec(value).map_err(|_| "GEO Provider 配置指纹生成失败".to_string())?;
        command.env(
            "XIAOJING_ARK_CONFIGURATION_FINGERPRINT",
            format!("{:x}", Sha256::digest(encoded)),
        );
    }
    if let Some(value) = embedding
        .as_ref()
        .and_then(|value| config_value(value, "apiKey"))
    {
        command.env("XIAOJING_ARK_EMBEDDING_API_KEY", value);
    }
    if let Some(value) = embedding
        .as_ref()
        .and_then(|value| config_value(value, "endpointId"))
    {
        command.env("XIAOJING_ARK_EMBEDDING_ENDPOINT_ID", value);
    }
    if let Some(value) = oss.as_ref() {
        for (field, env) in [
            ("accessKeyId", "XIAOJING_OSS_ACCESS_KEY_ID"),
            ("accessKeySecret", "XIAOJING_OSS_ACCESS_KEY_SECRET"),
            ("bucket", "XIAOJING_OSS_BUCKET"),
            ("region", "XIAOJING_OSS_REGION"),
            ("publicBaseUrl", "XIAOJING_OSS_PUBLIC_BASE_URL"),
        ] {
            if let Some(value) = config_value(value, field) {
                command.env(env, value);
            }
        }
    }
    if let Some(value) = distribution.as_ref() {
        for (field, env) in [
            ("appId", "XIAOJING_DISTRIBUTION_APP_ID"),
            ("secret", "XIAOJING_DISTRIBUTION_SECRET"),
            ("baseUrl", "XIAOJING_DISTRIBUTION_BASE_URL"),
        ] {
            if let Some(value) = config_value(value, field) {
                command.env(env, value);
            }
        }
    }
    for name in DEVELOPMENT_SOURCE_ENV_NAMES {
        command.env_remove(name);
    }
    Ok(())
}

fn configured_status(
    slot: &'static str,
    configured: bool,
    source: &'static str,
) -> GeoProviderCapabilityStatus {
    GeoProviderCapabilityStatus {
        slot,
        state: if configured {
            "available"
        } else {
            "unconfigured"
        },
        source,
        detail: configured.then(|| "服务配置已就绪；可手动验证连接".to_string()),
    }
}

#[tauri::command]
pub async fn cmd_geo_provider_capability_status() -> Result<Vec<GeoProviderCapabilityStatus>, String>
{
    let deepseek_status = crate::deepseek_credentials::cmd_deepseek_credential_status().await?;
    let deepseek = deepseek_status.configured;
    let deepseek_source = deepseek_status.source;
    let (ark, ark_source) = load_service(GeoProviderServiceId::Ark)?;
    let (embedding, embedding_source) = load_service(GeoProviderServiceId::Embedding)?;
    let (oss, oss_source) = load_service(GeoProviderServiceId::ObjectStorage)?;
    let (distribution, distribution_source) = load_service(GeoProviderServiceId::Distribution)?;
    Ok(vec![
        configured_status("main-agent", deepseek, deepseek_source),
        configured_status("extraction", deepseek, deepseek_source),
        configured_status("keyword-search", ark.is_some(), ark_source),
        configured_status("generation", ark.is_some(), ark_source),
        configured_status("reflection", deepseek, deepseek_source),
        configured_status(
            "embedding",
            embedding.as_ref().is_some_and(|value| {
                config_value(value, "endpointId").is_some()
                    && (config_value(value, "apiKey").is_some() || ark.is_some())
            }),
            embedding_source,
        ),
        configured_status("object-storage", oss.is_some(), oss_source),
        configured_status("distribution", distribution.is_some(), distribution_source),
    ])
}

#[tauri::command]
pub async fn cmd_geo_provider_credentials_save(
    app_handle: AppHandle,
    sidecars: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    service_id: GeoProviderServiceId,
    fields: BTreeMap<String, String>,
) -> Result<Vec<GeoProviderCapabilityStatus>, String> {
    let credential = validate_service_credential(service_id, fields)?;
    #[cfg(windows)]
    {
        platform::write(service_id, &credential)?;
        crate::sidecar::restart_xiaojing_session_sidecars(&app_handle, sidecars.inner()).await?;
        return cmd_geo_provider_capability_status().await;
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, sidecars, credential);
        Err("开发环境凭据来自 .env/启动环境；应用不会把密钥写入明文文件".to_string())
    }
}

#[tauri::command]
pub async fn cmd_geo_provider_credentials_delete(
    app_handle: AppHandle,
    sidecars: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    service_id: GeoProviderServiceId,
) -> Result<Vec<GeoProviderCapabilityStatus>, String> {
    #[cfg(windows)]
    {
        platform::delete(service_id)?;
        crate::sidecar::restart_xiaojing_session_sidecars(&app_handle, sidecars.inner()).await?;
        return cmd_geo_provider_capability_status().await;
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, sidecars, service_id);
        Err("开发环境凭据来自 .env/启动环境，请在外部环境移除后重启应用".to_string())
    }
}

fn classify_status(status: reqwest::StatusCode) -> (&'static str, String) {
    match status.as_u16() {
        200..=299 => ("available", "连接验证成功".to_string()),
        429 => ("rate_limited", "服务当前限流，请稍后重试".to_string()),
        401 | 403 => ("failed", "凭据无效或无权访问".to_string()),
        code => ("failed", format!("服务返回 HTTP {code}")),
    }
}

async fn verify_ark(
    client: &reqwest::Client,
    credential: &ServiceCredential,
    keyword: bool,
) -> Result<reqwest::StatusCode, String> {
    let key = config_value(credential, "apiKey").ok_or("ARK API Key 未配置")?;
    let model = if keyword {
        ARK_KEYWORD_MODEL
    } else {
        ARK_GENERATION_MODEL
    };
    let mut body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": "OK" }],
        "stream": false,
        "max_tokens": 1
    });
    if keyword {
        body["enable_search"] = serde_json::Value::Bool(true);
    }
    client
        .post(format!("{ARK_BASE_URL}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map(|response| response.status())
        .map_err(|_| "ARK 连接失败".to_string())
}

async fn verify_embedding(
    client: &reqwest::Client,
    credential: &ServiceCredential,
) -> Result<reqwest::StatusCode, String> {
    let key = config_value(credential, "apiKey")
        .map(str::to_string)
        .or_else(|| {
            load_service(GeoProviderServiceId::Ark)
                .ok()?
                .0?
                .0
                .get("apiKey")
                .cloned()
        })
        .ok_or("ARK Embedding API Key 未配置")?;
    let endpoint = config_value(credential, "endpointId").ok_or("ARK Embedding 接入点未配置")?;
    client
        .post(format!("{ARK_BASE_URL}/embeddings/multimodal"))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": endpoint,
            "input": [{ "type": "text", "text": "连接检查" }]
        }))
        .send()
        .await
        .map(|response| response.status())
        .map_err(|_| "ARK Embedding 连接失败".to_string())
}

async fn verify_oss(
    client: &reqwest::Client,
    credential: &ServiceCredential,
) -> Result<reqwest::StatusCode, String> {
    let access_key_id = config_value(credential, "accessKeyId").ok_or("OSS AccessKey ID 未配置")?;
    let access_key_secret =
        config_value(credential, "accessKeySecret").ok_or("OSS AccessKey Secret 未配置")?;
    let bucket = config_value(credential, "bucket").ok_or("OSS Bucket 未配置")?;
    let region = config_value(credential, "region").unwrap_or("oss-cn-beijing");
    let date = chrono::Utc::now().to_rfc2822().replace("+0000", "GMT");
    let string_to_sign = format!("GET\n\n\n{date}\n/{bucket}/");
    let signature = base64::engine::general_purpose::STANDARD.encode(hmac_sha1(
        access_key_secret.as_bytes(),
        string_to_sign.as_bytes(),
    ));
    client
        .get(format!(
            "https://{bucket}.{region}.aliyuncs.com/?max-keys=1"
        ))
        .header("Date", date)
        .header("Authorization", format!("OSS {access_key_id}:{signature}"))
        .send()
        .await
        .map(|response| response.status())
        .map_err(|_| "OSS 连接失败".to_string())
}

async fn verify_distribution(
    client: &reqwest::Client,
    credential: &ServiceCredential,
) -> Result<reqwest::StatusCode, String> {
    let appid = config_value(credential, "appId").ok_or("超级媒介 AppID 未配置")?;
    let secret = config_value(credential, "secret").ok_or("超级媒介 Secret 未配置")?;
    let base_url = config_value(credential, "baseUrl").unwrap_or(DISTRIBUTION_BASE_URL);
    let timestamp = chrono::Utc::now().timestamp();
    let flattened = format!("algorithm=sha256appid={appid}page=1size=1timestamp={timestamp}");
    let signature = hmac_sha256(secret.as_bytes(), flattened.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut url = url::Url::parse(&format!(
        "{}/media/resource",
        base_url.trim_end_matches('/')
    ))
    .map_err(|_| "超级媒介 API 地址无效".to_string())?;
    url.query_pairs_mut()
        .append_pair("appid", appid)
        .append_pair("timestamp", &timestamp.to_string())
        .append_pair("algorithm", "sha256")
        .append_pair("page", "1")
        .append_pair("size", "1")
        .append_pair("signature", &signature);
    client
        .get(url)
        .send()
        .await
        .map(|response| response.status())
        .map_err(|_| "超级媒介连接失败".to_string())
}

#[tauri::command]
pub async fn cmd_geo_provider_capability_verify(
    slot: String,
) -> Result<GeoProviderCapabilityVerifyResult, String> {
    let (service, source) = match slot.as_str() {
        "keyword-search" | "generation" => {
            let (value, source) = load_service(GeoProviderServiceId::Ark)?;
            (value, source)
        }
        "embedding" => {
            let (value, source) = load_service(GeoProviderServiceId::Embedding)?;
            (value, source)
        }
        "object-storage" => {
            let (value, source) = load_service(GeoProviderServiceId::ObjectStorage)?;
            (value, source)
        }
        "distribution" => {
            let (value, source) = load_service(GeoProviderServiceId::Distribution)?;
            (value, source)
        }
        _ => return Err("该能力使用 DeepSeek 主连接验证入口".to_string()),
    };
    let Some(credential) = service else {
        return Ok(GeoProviderCapabilityVerifyResult {
            slot,
            state: "unconfigured",
            source,
            detail: Some("尚未配置服务".to_string()),
        });
    };
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(20));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;
    let result = match slot.as_str() {
        "keyword-search" => verify_ark(&client, &credential, true).await,
        "generation" => verify_ark(&client, &credential, false).await,
        "embedding" => verify_embedding(&client, &credential).await,
        "object-storage" => verify_oss(&client, &credential).await,
        "distribution" => verify_distribution(&client, &credential).await,
        _ => unreachable!(),
    };
    let (state, detail) = match result {
        Ok(status) => classify_status(status),
        Err(detail) => ("failed", detail),
    };
    Ok(GeoProviderCapabilityVerifyResult {
        slot,
        state,
        source,
        detail: Some(detail),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn status_serialization_contains_no_secret_or_provider_dto() {
        let value = serde_json::to_value(configured_status(
            "generation",
            true,
            "windows-credential-manager",
        ))
        .unwrap();
        assert_eq!(value["slot"], "generation");
        assert_eq!(value["state"], "available");
        assert!(value.get("apiKey").is_none());
        assert!(value.get("fields").is_none());
    }

    #[test]
    fn http_statuses_distinguish_rate_limit_without_echoing_upstream_body() {
        assert_eq!(
            classify_status(reqwest::StatusCode::TOO_MANY_REQUESTS).0,
            "rate_limited"
        );
        assert_eq!(
            classify_status(reqwest::StatusCode::UNAUTHORIZED).0,
            "failed"
        );
        assert_eq!(classify_status(reqwest::StatusCode::OK).0, "available");
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
