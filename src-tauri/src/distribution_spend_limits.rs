//! User-owned distribution spend limits.
//!
//! The non-secret preference lives in Xiaojing's local `config.json`. New
//! distribution plans snapshot the current values; existing plans never read
//! through to mutable settings.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

pub const DEFAULT_PER_ARTICLE_MAX_POINTS: i64 = 3_000;
pub const DEFAULT_PER_EXECUTION_MAX_POINTS: i64 = 20_000;
pub const MAX_DISTRIBUTION_SPEND_LIMIT_POINTS: i64 = 160_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionSpendLimits {
    pub per_article_max_points: i64,
    pub per_execution_max_points: i64,
}

impl Default for DistributionSpendLimits {
    fn default() -> Self {
        Self {
            per_article_max_points: DEFAULT_PER_ARTICLE_MAX_POINTS,
            per_execution_max_points: DEFAULT_PER_EXECUTION_MAX_POINTS,
        }
    }
}

impl DistributionSpendLimits {
    fn validate(self) -> Result<Self, String> {
        if self.per_article_max_points < 1
            || self.per_execution_max_points < 1
            || self.per_article_max_points > MAX_DISTRIBUTION_SPEND_LIMIT_POINTS
            || self.per_execution_max_points > MAX_DISTRIBUTION_SPEND_LIMIT_POINTS
        {
            return Err("distribution_spend_limits_invalid".to_string());
        }
        Ok(self)
    }
}

fn parse_config_value(config: &Value) -> DistributionSpendLimits {
    config
        .get("distributionSpendLimits")
        .cloned()
        .and_then(|value| serde_json::from_value::<DistributionSpendLimits>(value).ok())
        .and_then(|limits| limits.validate().ok())
        .unwrap_or_default()
}

fn read_from_path(config_path: &Path) -> DistributionSpendLimits {
    std::fs::read_to_string(config_path)
        .ok()
        .and_then(|content| {
            serde_json::from_str::<Value>(crate::utils::bom::strip_bom(&content)).ok()
        })
        .map(|config| parse_config_value(&config))
        .unwrap_or_default()
}

pub fn read_distribution_spend_limits() -> DistributionSpendLimits {
    crate::app_dirs::xiaojing_data_dir()
        .map(|dir| read_from_path(&dir.join("config.json")))
        .unwrap_or_default()
}

fn persist_to_path(
    config_path: &Path,
    limits: DistributionSpendLimits,
) -> Result<DistributionSpendLimits, String> {
    let limits = limits.validate()?;
    crate::config_io::with_config_lock(config_path, false, |config| {
        let object = config
            .as_object_mut()
            .ok_or_else(|| "distribution_spend_limits_config_invalid".to_string())?;
        object.insert("distributionSpendLimits".to_string(), json!(limits));
        Ok(())
    })?;
    Ok(limits)
}

#[tauri::command]
pub async fn cmd_get_distribution_spend_limits() -> Result<DistributionSpendLimits, String> {
    tauri::async_runtime::spawn_blocking(read_distribution_spend_limits)
        .await
        .map_err(|error| format!("distribution spend limits task join: {error}"))
}

#[tauri::command]
pub async fn cmd_set_distribution_spend_limits(
    limits: DistributionSpendLimits,
) -> Result<DistributionSpendLimits, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::app_dirs::xiaojing_data_dir()
            .ok_or_else(|| "distribution_spend_limits_data_dir_unavailable".to_string())?;
        persist_to_path(&dir.join("config.json"), limits)
    })
    .await
    .map_err(|error| format!("distribution spend limits task join: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xiaojing-distribution-limits-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn missing_or_invalid_settings_use_product_defaults() {
        let path = config_path("defaults");
        assert_eq!(read_from_path(&path), DistributionSpendLimits::default());
        std::fs::write(
            &path,
            r#"{"distributionSpendLimits":{"perArticleMaxPoints":0,"perExecutionMaxPoints":1000}}"#,
        )
        .unwrap();
        assert_eq!(read_from_path(&path), DistributionSpendLimits::default());
    }

    #[test]
    fn persists_limits_without_overwriting_other_config_sections() {
        let path = config_path("persist");
        std::fs::write(&path, r#"{"account":{"phone":"13800000000"}}"#).unwrap();
        let saved = persist_to_path(
            &path,
            DistributionSpendLimits {
                per_article_max_points: 4_800,
                per_execution_max_points: 24_000,
            },
        )
        .unwrap();
        assert_eq!(saved.per_article_max_points, 4_800);
        let config: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            config.get("account").and_then(|value| value.get("phone")),
            Some(&json!("13800000000"))
        );
        assert_eq!(
            config.pointer("/distributionSpendLimits/perExecutionMaxPoints"),
            Some(&json!(24_000))
        );
    }
}
