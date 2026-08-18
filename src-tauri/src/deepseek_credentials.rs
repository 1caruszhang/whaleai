//! Native owner for the Xiaojing DeepSeek credential.
//!
//! Installed builds use Windows Credential Manager. The only non-Windows
//! source is an explicitly supplied development environment variable; it is
//! never copied into config.json, workspace metadata, transcripts, or logs.

use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;

pub const SIDECAR_SECRET_ENV: &str = "XIAOJING_DEEPSEEK_API_KEY";
pub(crate) const DEVELOPMENT_SECRET_ENV: &str = "DEEPSEEK_API_KEY";
#[cfg(windows)]
const CREDENTIAL_TARGET: &str = "Xiaojing/DeepSeek/main-agent";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekCredentialStatus {
    pub(crate) configured: bool,
    pub(crate) source: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepseekCredentialVerifyResult {
    pub success: bool,
    pub error: Option<String>,
}

fn validate_secret(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("DeepSeek API Key 不能为空".to_string());
    }
    if value.len() > 2_560 {
        return Err("DeepSeek API Key 长度超出系统凭据限制".to_string());
    }
    Ok(value)
}

#[cfg(windows)]
mod platform {
    use super::{validate_secret, CREDENTIAL_TARGET};
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

    pub fn read() -> Result<Option<String>, String> {
        let target = wide(CREDENTIAL_TARGET);
        let mut raw: *mut CREDENTIALW = ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut raw) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("读取 Windows 凭据失败（系统错误 {code}）"));
        }

        let result = unsafe {
            let credential = &*raw;
            let bytes = slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            );
            String::from_utf8(bytes.to_vec())
                .map(Some)
                .map_err(|_| "Windows 凭据内容格式无效".to_string())
        };
        unsafe { CredFree(raw.cast()) };
        result
    }

    pub fn write(value: &str) -> Result<(), String> {
        let value = validate_secret(value)?;
        let mut target = wide(CREDENTIAL_TARGET);
        let mut username = wide("Xiaojing");
        let mut blob = value.as_bytes().to_vec();
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
            return Err(format!("写入 Windows 凭据失败（系统错误 {code}）"));
        }
        Ok(())
    }

    pub fn delete() -> Result<(), String> {
        let target = wide(CREDENTIAL_TARGET);
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_NOT_FOUND {
                return Err(format!("删除 Windows 凭据失败（系统错误 {code}）"));
            }
        }
        Ok(())
    }
}

/// Process-local secret materialization. Never expose this from a Tauri command.
pub(crate) fn load_for_sidecar() -> Result<Option<String>, String> {
    #[cfg(windows)]
    if let Some(value) = platform::read()? {
        return Ok(Some(value));
    }

    #[cfg(debug_assertions)]
    {
        Ok(std::env::var(DEVELOPMENT_SECRET_ENV)
            .ok()
            .and_then(|value| validate_secret(&value).ok().map(str::to_owned)))
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(None)
    }
}

pub(crate) fn inject_into_sidecar(command: &mut std::process::Command) -> Result<(), String> {
    if let Some(secret) = load_for_sidecar()? {
        command.env(SIDECAR_SECRET_ENV, secret);
    } else {
        command.env_remove(SIDECAR_SECRET_ENV);
    }
    command.env_remove(DEVELOPMENT_SECRET_ENV);
    Ok(())
}

#[tauri::command]
pub async fn cmd_deepseek_credential_status() -> Result<DeepseekCredentialStatus, String> {
    #[cfg(windows)]
    if platform::read()?.is_some() {
        return Ok(DeepseekCredentialStatus {
            configured: true,
            source: "windows-credential-manager",
        });
    }

    #[cfg(debug_assertions)]
    let configured = std::env::var(DEVELOPMENT_SECRET_ENV)
        .ok()
        .is_some_and(|value| validate_secret(&value).is_ok());
    #[cfg(not(debug_assertions))]
    let configured = false;
    Ok(DeepseekCredentialStatus {
        configured,
        source: if configured {
            "development-env"
        } else {
            "missing"
        },
    })
}

#[tauri::command]
pub async fn cmd_deepseek_credential_save(
    app_handle: AppHandle,
    sidecars: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
    api_key: String,
) -> Result<DeepseekCredentialStatus, String> {
    validate_secret(&api_key)?;
    #[cfg(windows)]
    {
        platform::write(&api_key)?;
        crate::sidecar::restart_xiaojing_session_sidecars(&app_handle, sidecars.inner()).await?;
        return Ok(DeepseekCredentialStatus {
            configured: true,
            source: "windows-credential-manager",
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, sidecars, api_key);
        Err("开发环境请在启动进程中设置 DEEPSEEK_API_KEY；应用不会把密钥写入明文文件".to_string())
    }
}

#[tauri::command]
pub async fn cmd_deepseek_credential_delete(
    app_handle: AppHandle,
    sidecars: tauri::State<'_, crate::sidecar::ManagedSidecarManager>,
) -> Result<DeepseekCredentialStatus, String> {
    #[cfg(windows)]
    {
        platform::delete()?;
        crate::sidecar::restart_xiaojing_session_sidecars(&app_handle, sidecars.inner()).await?;
        cmd_deepseek_credential_status().await
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, sidecars);
        Err("开发环境凭据来自启动进程 DEEPSEEK_API_KEY，请在外部环境中移除后重启应用".to_string())
    }
}

#[tauri::command]
pub async fn cmd_deepseek_credential_verify() -> Result<DeepseekCredentialVerifyResult, String> {
    let Some(secret) = load_for_sidecar()? else {
        return Ok(DeepseekCredentialVerifyResult {
            success: false,
            error: Some("尚未配置 DeepSeek API Key".to_string()),
        });
    };
    // This client intentionally targets the external DeepSeek host. Localhost
    // control-plane callers must continue through crate::local_http::builder().
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(20));
    let client = crate::proxy_config::build_client_with_proxy_for_provider(builder, "deepseek")?;
    let response = client
        .post("https://api.deepseek.com/anthropic/v1/messages")
        .header("x-api-key", secret)
        .header("anthropic-version", "2023-06-01")
        .json(&serde_json::json!({
            "model": "deepseek-v4-pro",
            "max_tokens": 1,
            "thinking": { "type": "disabled" },
            "messages": [{ "role": "user", "content": "OK" }]
        }))
        .send()
        .await
        .map_err(|error| format!("DeepSeek 连接失败: {error}"))?;

    if response.status().is_success() {
        return Ok(DeepseekCredentialVerifyResult {
            success: true,
            error: None,
        });
    }
    let status = response.status();
    Ok(DeepseekCredentialVerifyResult {
        success: false,
        error: Some(match status.as_u16() {
            401 | 403 => "DeepSeek API Key 无效或无权访问".to_string(),
            402 => "DeepSeek 账户余额不足".to_string(),
            429 => "DeepSeek 请求过于频繁，请稍后重试".to_string(),
            _ => format!("DeepSeek 返回 HTTP {status}"),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_validation_rejects_blank_and_oversized_values() {
        assert!(validate_secret("   ").is_err());
        assert!(validate_secret(&"x".repeat(2_561)).is_err());
        assert_eq!(validate_secret("  sk-test  ").unwrap(), "sk-test");
    }

    #[test]
    fn status_serialization_never_has_a_secret_field() {
        let value = serde_json::to_value(DeepseekCredentialStatus {
            configured: true,
            source: "windows-credential-manager",
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "configured": true,
                "source": "windows-credential-manager",
            })
        );
    }
}
