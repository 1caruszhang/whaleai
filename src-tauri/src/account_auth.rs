//! Rust owner for the commercial-beta account login state (票 06).
//!
//! 登录凭证（access/refresh token）只写入 OS 凭据库与本进程内存；
//! `config.json` 仅保存非密钥投影（手机号、点数、首登改密标记、协议勾选、
//! 宽限锚点）。renderer 只能通过 `cmd_account_state` 拿到不含 token 的
//! 投影。Sidecar admission 注入网关地址 + 账号 access token，替代旧
//! Provider 凭据注入路径。
//!
//! token 与网关凭证不得进入 renderer、日志、数据库或构建产物。

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Sidecar admission 传输名：运营网关根地址与账号 access token。
pub const GATEWAY_BASE_URL_ENV: &str = "XIAOJING_GATEWAY_BASE_URL";
pub const ACCOUNT_ACCESS_TOKEN_ENV: &str = "XIAOJING_ACCOUNT_ACCESS_TOKEN";
const DEFAULT_GATEWAY_BASE_URL: &str = "https://api.jingshanai.com";
/// Debug 构建从 `.env`/启动环境读取的网关地址覆盖名（本地联调后端用）。
#[cfg(debug_assertions)]
pub(crate) const DEVELOPMENT_GATEWAY_BASE_URL_ENV: &str = "GATEWAY_BASE_URL";
/// 断网宽限：自最后一次成功接触服务器起算（票 12 决策）。
pub(crate) const OFFLINE_GRACE_SECS: i64 = 7 * 24 * 60 * 60;

/// 旧 DeepSeek 凭据 admission 的传输名与开发来源名。注入路径已被账号
/// admission 替代，仅保留子进程环境清洗用途。
const LEGACY_DEEPSEEK_ENV_NAMES: &[&str] = &[
    "XIAOJING_DEEPSEEK_API_KEY",
    "XIAOJING_DEEPSEEK_ANTHROPIC_BASE_URL",
    "XIAOJING_DEEPSEEK_OPENAI_BASE_URL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_MAIN_AGENT_BASE_URL",
    "DEEPSEEK_API_BASE_URL",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AccountSessionSecret {
    access_token: String,
    refresh_token: String,
}

/// `config.json` 的 `account` 段：全部是非密钥事实，tokens 永不进入。
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct AccountConfig {
    phone: Option<String>,
    points: Option<i64>,
    status: Option<String>,
    must_change_password: bool,
    agreement_accepted_at: Option<i64>,
    last_server_contact_at: Option<i64>,
}

/// renderer 可见的账号投影。任何 token 字段都不允许出现在这里。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    logged_in: bool,
    phone: Option<String>,
    points: Option<i64>,
    status: Option<String>,
    must_change_password: bool,
    agreement_accepted: bool,
    offline_grace: OfflineGrace,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineGrace {
    within: bool,
    last_server_contact_at: Option<i64>,
    deadline_at: Option<i64>,
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn valid_phone(phone: &str) -> bool {
    let bytes = phone.as_bytes();
    bytes.len() == 11
        && bytes[0] == b'1'
        && (b'3'..=b'9').contains(&bytes[1])
        && bytes[2..].iter().all(u8::is_ascii_digit)
}

fn compute_state(config: &AccountConfig, has_secret: bool, now: i64) -> AccountState {
    let deadline_at = config
        .last_server_contact_at
        .map(|anchor| anchor + OFFLINE_GRACE_SECS);
    let within = has_secret && deadline_at.is_some_and(|deadline| now <= deadline);
    AccountState {
        logged_in: has_secret,
        phone: config.phone.clone(),
        points: config.points,
        status: config.status.clone(),
        must_change_password: config.must_change_password,
        agreement_accepted: config.agreement_accepted_at.is_some(),
        offline_grace: OfflineGrace {
            within,
            last_server_contact_at: config.last_server_contact_at,
            deadline_at,
        },
    }
}

/// 把后端错误码映射为用户可读的中文反馈；网络层失败由调用方另行映射。
fn auth_failure_message(code: &str) -> &'static str {
    match code {
        "invalid_credentials" => "手机号或密码不正确",
        "account_disabled" => "账号已停用，请联系运营",
        "same_password" => "新密码不能与当前密码相同",
        "token_expired" | "stale_token" | "invalid_token" => "登录状态已失效，请重新登录",
        "refresh_reuse_detected" | "refresh_expired" | "invalid_refresh" => {
            "登录状态已失效，请重新登录"
        }
        "validation_error" | "invalid_json" => "输入内容不符合要求，请检查后重试",
        _ => "服务器返回了未预期的错误，请稍后重试",
    }
}

/// 这些错误码意味着本地会话已不可恢复，必须清库并重新登录。
fn session_dead_code(code: &str) -> bool {
    matches!(
        code,
        "refresh_reuse_detected" | "refresh_expired" | "invalid_refresh" | "account_disabled"
    )
}

fn network_failure_message() -> &'static str {
    "无法连接服务器，请检查网络后重试"
}

// ---------------------------------------------------------------------------
// OS credential store
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::AccountSessionSecret;
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME},
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };

    const CREDENTIAL_TARGET: &str = "Xiaojing/Account/session";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read() -> Result<Option<AccountSessionSecret>, String> {
        let target = wide(CREDENTIAL_TARGET);
        let mut raw: *mut CREDENTIALW = ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("读取账号凭据失败（系统错误 {code}）"));
        }
        let result = unsafe {
            let credential = &*raw;
            let bytes = slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            );
            serde_json::from_slice::<AccountSessionSecret>(bytes)
                .map(Some)
                .map_err(|_| "账号凭据内容格式无效".to_string())
        };
        unsafe { CredFree(raw.cast()) };
        result
    }

    pub fn write(secret: &AccountSessionSecret) -> Result<(), String> {
        let mut target = wide(CREDENTIAL_TARGET);
        let mut username = wide("Xiaojing");
        let mut blob = serde_json::to_vec(secret).map_err(|_| "账号凭据序列化失败".to_string())?;
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
            return Err(format!("写入账号凭据失败（系统错误 {code}）"));
        }
        Ok(())
    }

    pub fn delete() -> Result<(), String> {
        let target = wide(CREDENTIAL_TARGET);
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_NOT_FOUND {
                return Err(format!("删除账号凭据失败（系统错误 {code}）"));
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::AccountSessionSecret;
    use security_framework::passwords;

    const SERVICE: &str = "com.xiaojing.geo";
    const ACCOUNT: &str = "account-session";
    // errSecItemNotFound：首次启动尚未登录属正常态，不是错误。
    const ITEM_NOT_FOUND: i32 = -25300;

    fn decode(bytes: Vec<u8>) -> Result<AccountSessionSecret, String> {
        serde_json::from_slice(&bytes).map_err(|_| "账号凭据内容格式无效".to_string())
    }

    pub fn read() -> Result<Option<AccountSessionSecret>, String> {
        match passwords::get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => decode(bytes).map(Some),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(error) => Err(format!("读取 macOS 钥匙串失败：{error}")),
        }
    }

    pub fn write(secret: &AccountSessionSecret) -> Result<(), String> {
        let blob = serde_json::to_vec(secret).map_err(|_| "账号凭据序列化失败".to_string())?;
        passwords::set_generic_password(SERVICE, ACCOUNT, &blob)
            .map_err(|error| format!("写入 macOS 钥匙串失败：{error}"))
    }

    pub fn delete() -> Result<(), String> {
        match passwords::delete_generic_password(SERVICE, ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(format!("删除 macOS 钥匙串失败：{error}")),
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::AccountSessionSecret;

    pub fn read() -> Result<Option<AccountSessionSecret>, String> {
        Err("当前平台不支持账号凭据存储".to_string())
    }

    pub fn write(_secret: &AccountSessionSecret) -> Result<(), String> {
        Err("当前平台不支持账号凭据存储".to_string())
    }

    pub fn delete() -> Result<(), String> {
        Err("当前平台不支持账号凭据存储".to_string())
    }
}

// ---------------------------------------------------------------------------
// config.json projection persistence
// ---------------------------------------------------------------------------

fn account_config_path(base: &std::path::Path) -> std::path::PathBuf {
    base.join("config.json")
}

fn read_account_config_at(config_path: &std::path::Path) -> AccountConfig {
    let content = match std::fs::read_to_string(config_path) {
        Ok(content) => content,
        Err(_) => return AccountConfig::default(),
    };
    let parsed: serde_json::Value = serde_json::from_str(crate::utils::bom::strip_bom(&content))
        .unwrap_or_else(|_| serde_json::json!({}));
    let account_section = parsed
        .get("account")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    serde_json::from_value(account_section).unwrap_or_default()
}

/// 写盘缝：测试以临时目录驱动，不触碰真实用户数据目录。
fn mutate_account_config_at<F>(config_path: &std::path::Path, mutator: F) -> Result<(), String>
where
    F: FnOnce(&mut AccountConfig),
{
    crate::config_io::with_config_lock(config_path, false, |config| {
        if !config.is_object() {
            *config = serde_json::json!({});
        }
        let mut account: AccountConfig = serde_json::from_value(
            config
                .get("account")
                .cloned()
                .unwrap_or(serde_json::json!({})),
        )
        .unwrap_or_default();
        mutator(&mut account);
        config["account"] = serde_json::to_value(&account)
            .map_err(|error| format!("账号配置序列化失败：{error}"))?;
        Ok(())
    })
    .map(|_| ())
}

fn read_account_config() -> AccountConfig {
    crate::app_dirs::xiaojing_data_dir()
        .map(|base| read_account_config_at(&account_config_path(&base)))
        .unwrap_or_default()
}

fn mutate_account_config<F>(mutator: F) -> Result<(), String>
where
    F: FnOnce(&mut AccountConfig),
{
    let Some(base) = crate::app_dirs::xiaojing_data_dir() else {
        return Err("无法定位应用数据目录".to_string());
    };
    mutate_account_config_at(&account_config_path(&base), mutator)
}

/// 清除本地会话（退出登录 / 会话不可恢复）。协议勾选是设备级事实，保留。
fn clear_local_session() -> Result<(), String> {
    platform::delete()?;
    mutate_account_config(|account| {
        account.phone = None;
        account.points = None;
        account.status = None;
        account.must_change_password = false;
        account.last_server_contact_at = None;
    })
}

// ---------------------------------------------------------------------------
// Gateway HTTP surface (backend/src/http/auth-routes.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountWire {
    phone: String,
    status: String,
    must_change_password: bool,
    points: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenPairWire {
    access_token: String,
    refresh_token: String,
    account: AccountWire,
}

fn gateway_client() -> Result<reqwest::Client, String> {
    // 账号网关是外部 HTTPS 目标；localhost 控制面仍必须走 crate::local_http。
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(20));
    crate::proxy_config::build_client_with_proxy(builder)
}

fn gateway_base_url() -> String {
    #[cfg(debug_assertions)]
    if let Some(value) = crate::geo_provider_credentials::normalize_endpoint_override(
        std::env::var(DEVELOPMENT_GATEWAY_BASE_URL_ENV).ok(),
    ) {
        return value.trim_end_matches('/').to_string();
    }
    DEFAULT_GATEWAY_BASE_URL.to_string()
}

/// 读取错误响应体中的 `error` 码。消耗 response——只在错误分支调用。
async fn parse_error_code(response: reqwest::Response) -> Option<String> {
    let body = response.json::<serde_json::Value>().await.ok()?;
    body.get("error")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

enum AuthedError {
    /// 本地会话已不可恢复，`clear_local_session` 已执行。
    SessionDead,
    /// 网络层失败：服务器不可达。
    Network,
    /// 后端返回的业务错误码（`{error, message}` 响应）。
    Code(String),
    /// 本地校验或系统层错误，已是用户可读文本。
    Message(String),
}

impl AuthedError {
    fn message(&self) -> String {
        match self {
            Self::SessionDead => auth_failure_message("invalid_refresh").to_string(),
            Self::Network => network_failure_message().to_string(),
            Self::Code(code) => auth_failure_message(code).to_string(),
            Self::Message(message) => message.clone(),
        }
    }
}

/// 把响应归一为「2xx 成功 / 后端错误码」两分支。
async fn classify_response(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let code = parse_error_code(response)
        .await
        .unwrap_or_else(|| "unknown".to_string());
    Err(code)
}

/// 用当前 access token 调用需要鉴权的端点；token 过期时先走一次 refresh
/// 轮换再重试。成功时返回 2xx Response。
async fn call_authenticated(
    client: &reqwest::Client,
    method: reqwest::Method,
    path: &str,
    body: serde_json::Value,
) -> Result<reqwest::Response, AuthedError> {
    let mut secret = platform::read()
        .map_err(AuthedError::Message)?
        .ok_or_else(|| AuthedError::Message("请先登录".to_string()))?;

    for attempt in 0..2 {
        let mut request = client
            .request(method.clone(), format!("{}{path}", gateway_base_url()))
            .bearer_auth(&secret.access_token);
        if method != reqwest::Method::GET {
            // GET 不带请求体：部分反代会拒绝带 body 的 GET。
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| AuthedError::Network)?;
        match classify_response(response).await {
            Ok(success) => return Ok(success),
            Err(code) => {
                if attempt == 0
                    && matches!(
                        code.as_str(),
                        "token_expired" | "stale_token" | "invalid_token"
                    )
                {
                    secret = refresh_tokens(client, &secret.refresh_token).await?;
                    continue;
                }
                if session_dead_code(&code) {
                    let _ = clear_local_session();
                    return Err(AuthedError::SessionDead);
                }
                return Err(AuthedError::Code(code));
            }
        }
    }
    unreachable!("auth retry loop returns from every branch")
}

/// POST /auth/refresh：轮换并落库。会话死亡码触发本地清除。
async fn refresh_tokens(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<AccountSessionSecret, AuthedError> {
    let response = client
        .post(format!("{}/auth/refresh", gateway_base_url()))
        .json(&serde_json::json!({ "refreshToken": refresh_token }))
        .send()
        .await
        .map_err(|_| AuthedError::Network)?;
    match classify_response(response).await {
        Ok(success) => {
            let pair: TokenPairWire = success
                .json()
                .await
                .map_err(|_| AuthedError::Message("服务器响应格式无效".to_string()))?;
            let secret = AccountSessionSecret {
                access_token: pair.access_token,
                refresh_token: pair.refresh_token,
            };
            platform::write(&secret).map_err(AuthedError::Message)?;
            record_contact_and_projection(&pair.account).map_err(AuthedError::Message)?;
            Ok(secret)
        }
        Err(code) => {
            if session_dead_code(&code) {
                let _ = clear_local_session();
                return Err(AuthedError::SessionDead);
            }
            Err(AuthedError::Code(code))
        }
    }
}

/// 任一成功鉴权接触都推进宽限锚点并同步非密钥投影。
fn record_contact_and_projection(account: &AccountWire) -> Result<(), String> {
    mutate_account_config(|config| {
        config.phone = Some(account.phone.clone());
        config.points = Some(account.points);
        config.status = Some(account.status.clone());
        config.must_change_password = account.must_change_password;
        config.last_server_contact_at = Some(now_epoch());
    })
}

// ---------------------------------------------------------------------------
// Sidecar admission
// ---------------------------------------------------------------------------

/// 清除全部旧 Provider 凭据传输名与来源名（账号 admission 取代了它们的
/// 注入路径；清洗保留为纵深防御）。
fn scrub_legacy_provider_envs(command: &mut std::process::Command) {
    for name in crate::geo_provider_credentials::SIDECAR_ENV_NAMES {
        command.env_remove(name);
    }
    for name in crate::geo_provider_credentials::DEVELOPMENT_SOURCE_ENV_NAMES {
        command.env_remove(name);
    }
    for name in LEGACY_DEEPSEEK_ENV_NAMES {
        command.env_remove(name);
    }
}

/// 账号 admission 的纯核心：清掉旧传输名，再注入网关地址与账号 access
/// token。测试直接驱动该函数，不启动子进程。
pub(crate) fn apply_account_admission(
    command: &mut std::process::Command,
    gateway_base_url: &str,
    access_token: Option<&str>,
) {
    scrub_legacy_provider_envs(command);
    command.env(GATEWAY_BASE_URL_ENV, gateway_base_url);
    if let Some(token) = access_token {
        command.env(ACCOUNT_ACCESS_TOKEN_ENV, token);
    } else {
        command.env_remove(ACCOUNT_ACCESS_TOKEN_ENV);
    }
}

/// 未通过品牌根校验的 Session：清除账号 admission 传输名，不注入任何值。
pub(crate) fn scrub_account_admission(command: &mut std::process::Command) {
    scrub_legacy_provider_envs(command);
    command.env_remove(GATEWAY_BASE_URL_ENV);
    command.env_remove(ACCOUNT_ACCESS_TOKEN_ENV);
}

pub(crate) fn inject_into_sidecar(command: &mut std::process::Command) -> Result<(), String> {
    let access_token = platform::read()?.map(|secret| secret.access_token);
    apply_account_admission(command, &gateway_base_url(), access_token.as_deref());
    Ok(())
}

/// 发布执行器的网关 egress 身份（票 08 闭环）：账号会话在位（OS 凭据库
/// 有 token，可注入网关模式 Sidecar）时返回非密钥的网关基地址，供
/// `PublishScheduler` 冻结网关传输快照与指纹；未登录返回 None。绝不
/// 返回 token 本体。
pub(crate) fn publish_egress_gateway_base_url() -> Option<String> {
    let has_session = platform::read().map(|secret| secret.is_some()).ok()?;
    has_session.then(gateway_base_url)
}

// ---------------------------------------------------------------------------
// Tauri commands（返回值一律是无 token 投影）
// ---------------------------------------------------------------------------

fn current_state() -> Result<AccountState, String> {
    let has_secret = platform::read()?.is_some();
    Ok(compute_state(
        &read_account_config(),
        has_secret,
        now_epoch(),
    ))
}

#[tauri::command]
pub async fn cmd_account_state() -> Result<AccountState, String> {
    current_state()
}

#[tauri::command]
pub async fn cmd_account_login(
    phone: String,
    password: String,
    accepted_agreement: bool,
) -> Result<AccountState, String> {
    if !valid_phone(phone.trim()) {
        return Err("请输入正确的手机号".to_string());
    }
    if password.is_empty() || password.len() > 128 {
        return Err("请输入密码".to_string());
    }
    if !accepted_agreement {
        return Err("请先阅读并同意《用户协议》与《隐私政策》".to_string());
    }
    let client = gateway_client()?;
    let response = client
        .post(format!("{}/auth/login", gateway_base_url()))
        .json(&serde_json::json!({ "phone": phone.trim(), "password": password }))
        .send()
        .await
        .map_err(|_| network_failure_message().to_string())?;
    let response = classify_response(response)
        .await
        .map_err(|code| auth_failure_message(&code).to_string())?;
    let pair: TokenPairWire = response
        .json()
        .await
        .map_err(|_| "服务器响应格式无效".to_string())?;
    let secret = AccountSessionSecret {
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
    };
    platform::write(&secret)?;
    mutate_account_config(|config| {
        if config.agreement_accepted_at.is_none() {
            config.agreement_accepted_at = Some(now_epoch());
        }
    })?;
    record_contact_and_projection(&pair.account)?;
    crate::ulog_info!(
        "[account] login ok points={} mustChangePassword={}",
        pair.account.points,
        pair.account.must_change_password
    );
    current_state()
}

#[tauri::command]
pub async fn cmd_account_change_password(
    current_password: String,
    new_password: String,
) -> Result<AccountState, String> {
    if current_password.is_empty() {
        return Err("请输入当前密码".to_string());
    }
    let new_password = new_password.trim();
    if new_password.len() < 8 || new_password.len() > 128 {
        return Err("新密码长度需为 8–128 位".to_string());
    }
    if new_password == current_password {
        return Err(auth_failure_message("same_password").to_string());
    }
    let client = gateway_client()?;
    let response = call_authenticated(
        &client,
        reqwest::Method::POST,
        "/auth/change-password",
        serde_json::json!({
            "currentPassword": current_password,
            "newPassword": new_password,
        }),
    )
    .await
    .map_err(|error| match error {
        AuthedError::Code(code) if code == "invalid_credentials" => "当前密码不正确".to_string(),
        other => other.message(),
    })?;
    let pair: TokenPairWire = response
        .json()
        .await
        .map_err(|_| "服务器响应格式无效".to_string())?;
    let secret = AccountSessionSecret {
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
    };
    platform::write(&secret)?;
    record_contact_and_projection(&pair.account)?;
    crate::ulog_info!("[account] password changed");
    current_state()
}

#[tauri::command]
pub async fn cmd_account_refresh() -> Result<AccountState, String> {
    if platform::read()?.is_none() {
        return current_state();
    }
    let client = gateway_client()?;
    let response = call_authenticated(
        &client,
        reqwest::Method::GET,
        "/auth/me",
        serde_json::json!({}),
    )
    .await
    .map_err(|error| error.message())?;
    #[derive(Debug, Deserialize)]
    struct MeWire {
        account: AccountWire,
    }
    let me: MeWire = response
        .json()
        .await
        .map_err(|_| "服务器响应格式无效".to_string())?;
    record_contact_and_projection(&me.account)?;
    current_state()
}

#[tauri::command]
pub async fn cmd_account_logout() -> Result<AccountState, String> {
    if let Ok(Some(secret)) = platform::read() {
        if let Ok(client) = gateway_client() {
            // 通知服务器吊销会话；失败不阻塞本地登出。
            let _ = client
                .post(format!("{}/auth/logout", gateway_base_url()))
                .bearer_auth(&secret.access_token)
                .json(&serde_json::json!({ "refreshToken": secret.refresh_token }))
                .send()
                .await;
        }
    }
    clear_local_session()?;
    crate::ulog_info!("[account] logout");
    current_state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_validation_accepts_mainland_mobile_shape_only() {
        assert!(valid_phone("13800001234"));
        assert!(valid_phone("19912345678"));
        assert!(!valid_phone("1380000123"));
        assert!(!valid_phone("12800001234"));
        assert!(!valid_phone("23800001234"));
        assert!(!valid_phone("1380000123x"));
        assert!(!valid_phone(""));
    }

    #[test]
    fn grace_window_anchors_to_last_server_contact() {
        let mut config = AccountConfig::default();
        // 从未接触服务器：即使存在 token 也不在宽限内。
        assert!(!compute_state(&config, true, 1_000).offline_grace.within);

        config.last_server_contact_at = Some(1_000);
        let state = compute_state(&config, true, 1_000 + OFFLINE_GRACE_SECS);
        assert!(state.offline_grace.within);
        assert_eq!(
            state.offline_grace.deadline_at,
            Some(1_000 + OFFLINE_GRACE_SECS)
        );
        // 超过锚点 7 天即失效，必须重新联网登录。
        let expired = compute_state(&config, true, 1_000 + OFFLINE_GRACE_SECS + 1);
        assert!(!expired.offline_grace.within);
        // token 缺失时无论锚点如何都视为未登录。
        let logged_out = compute_state(&config, false, 1_000);
        assert!(!logged_out.logged_in);
        assert!(!logged_out.offline_grace.within);
    }

    #[test]
    fn state_projection_never_carries_token_material() {
        let config = AccountConfig {
            phone: Some("13800001234".to_string()),
            points: Some(500),
            status: Some("active".to_string()),
            must_change_password: true,
            agreement_accepted_at: Some(1),
            last_server_contact_at: Some(2),
        };
        let value = serde_json::to_value(compute_state(&config, true, 2)).unwrap();
        assert_eq!(value["loggedIn"], true);
        assert_eq!(value["phone"], "13800001234");
        assert_eq!(value["points"], 500);
        assert_eq!(value["mustChangePassword"], true);
        assert_eq!(value["agreementAccepted"], true);
        assert_eq!(value["offlineGrace"]["within"], true);
        for forbidden in [
            "accessToken",
            "access_token",
            "refreshToken",
            "refresh_token",
        ] {
            assert!(
                value.get(forbidden).is_none(),
                "projection must not carry {forbidden}"
            );
        }
    }

    #[test]
    fn backend_error_codes_map_to_actionable_chinese_feedback() {
        assert_eq!(
            auth_failure_message("invalid_credentials"),
            "手机号或密码不正确"
        );
        assert_eq!(
            auth_failure_message("account_disabled"),
            "账号已停用，请联系运营"
        );
        assert_eq!(
            auth_failure_message("same_password"),
            "新密码不能与当前密码相同"
        );
        assert_eq!(
            auth_failure_message("refresh_reuse_detected"),
            "登录状态已失效，请重新登录"
        );
        assert!(session_dead_code("refresh_expired"));
        assert!(session_dead_code("account_disabled"));
        assert!(!session_dead_code("token_expired"));
    }

    #[test]
    fn account_config_roundtrips_inside_config_json() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config_path = account_config_path(dir.path());
        let anchor = AccountConfig {
            phone: Some("13800001234".to_string()),
            points: Some(500),
            last_server_contact_at: Some(42),
            ..AccountConfig::default()
        };
        mutate_account_config_at(&config_path, |config| {
            *config = anchor.clone();
        })
        .expect("write account config");
        assert_eq!(read_account_config_at(&config_path).phone, anchor.phone);
        // 其他配置键不被账号段写入破坏。
        crate::config_io::with_config_lock(&config_path, false, |config| {
            config["uiLanguage"] = serde_json::json!("zh-CN");
            Ok(())
        })
        .expect("unrelated key survives");
        let mut updated = read_account_config_at(&config_path);
        updated.points = Some(480);
        mutate_account_config_at(&config_path, |config| {
            config.points = Some(480);
        })
        .expect("partial update");
        let final_config = read_account_config_at(&config_path);
        assert_eq!(final_config.points, Some(480));
        assert_eq!(final_config.last_server_contact_at, Some(42));
        assert_eq!(final_config.phone, Some("13800001234".to_string()));
    }

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
    fn admission_replaces_provider_credentials_with_gateway_and_account_token() {
        let mut command = crate::process_cmd::new("node");
        // 伪造父环境带入全部旧传输名与新传输名，admission 必须逐一清洗。
        for name in crate::geo_provider_credentials::SIDECAR_ENV_NAMES {
            command.env(name, "legacy");
        }
        for name in LEGACY_DEEPSEEK_ENV_NAMES {
            command.env(name, "legacy");
        }
        command.env(ACCOUNT_ACCESS_TOKEN_ENV, "stale-token");
        apply_account_admission(&mut command, "https://api.jingshanai.com", Some("jwt-1"));
        let env = env_map(&command);
        assert_eq!(
            env.get(GATEWAY_BASE_URL_ENV),
            Some(&Some("https://api.jingshanai.com".to_string()))
        );
        assert_eq!(
            env.get(ACCOUNT_ACCESS_TOKEN_ENV),
            Some(&Some("jwt-1".to_string()))
        );
        for name in crate::geo_provider_credentials::SIDECAR_ENV_NAMES {
            assert_eq!(env.get(*name), Some(&None), "{name} 应被清除");
        }
        for name in LEGACY_DEEPSEEK_ENV_NAMES {
            assert_eq!(env.get(*name), Some(&None), "{name} 应被清除");
        }

        // 未登录：token 传输名必须移除而不是留空。
        let mut logged_out = crate::process_cmd::new("node");
        logged_out.env(ACCOUNT_ACCESS_TOKEN_ENV, "stale-token");
        apply_account_admission(&mut logged_out, "https://api.jingshanai.com", None);
        assert_eq!(
            env_map(&logged_out).get(ACCOUNT_ACCESS_TOKEN_ENV),
            Some(&None)
        );
    }

    #[test]
    fn non_brand_scrub_removes_every_admission_transport_name() {
        let mut command = crate::process_cmd::new("node");
        for name in [GATEWAY_BASE_URL_ENV, ACCOUNT_ACCESS_TOKEN_ENV] {
            command.env(name, "leak");
        }
        scrub_account_admission(&mut command);
        let env = env_map(&command);
        assert_eq!(env.get(GATEWAY_BASE_URL_ENV), Some(&None));
        assert_eq!(env.get(ACCOUNT_ACCESS_TOKEN_ENV), Some(&None));
    }
}
