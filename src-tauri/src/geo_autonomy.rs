//! GEO autonomy profile — the workspace-wide dial deciding which zero-cost,
//! reversible confirmation gates a Sidecar may confirm without the user.
//!
//! Persisted in `config.json::geoAutonomyProfile`, read at Session-Sidecar
//! spawn, and injected as `XIAOJING_GEO_AUTONOMY_PROFILE` (brand-workspace
//! sessions only). The Node side keeps the actual gate policy in
//! `src/shared/geo/autonomy.ts`; Rust only transports the dial value.
//! Unknown, missing, or malformed values always resolve to `manual`, so an
//! edited config file can never widen gates by accident.

use serde::Deserialize;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    geo_autonomy_profile: Option<String>,
}

fn profile_from_config_content(content: &str) -> &'static str {
    let content = crate::utils::bom::strip_bom(content);
    let config: PartialAppConfig = serde_json::from_str(content).unwrap_or_default();
    match config.geo_autonomy_profile.as_deref() {
        Some("auto") => "auto",
        _ => "manual",
    }
}

pub fn read_geo_autonomy_profile() -> &'static str {
    match crate::app_dirs::xiaojing_data_dir() {
        Some(data_dir) => match std::fs::read_to_string(data_dir.join("config.json")) {
            Ok(content) => profile_from_config_content(&content),
            // A missing or unreadable config keeps every gate user-owned.
            Err(_) => "manual",
        },
        None => "manual",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_is_opt_in_and_everything_else_stays_manual() {
        assert_eq!(
            profile_from_config_content(r#"{"geoAutonomyProfile":"auto"}"#),
            "auto"
        );
        assert_eq!(
            profile_from_config_content(r#"{"geoAutonomyProfile":"manual"}"#),
            "manual"
        );
        assert_eq!(
            profile_from_config_content(r#"{"geoAutonomyProfile":"full"}"#),
            "manual"
        );
        assert_eq!(profile_from_config_content("{}"), "manual");
        assert_eq!(profile_from_config_content("not json"), "manual");
        assert_eq!(
            profile_from_config_content("\u{feff}{\"geoAutonomyProfile\":\"auto\"}"),
            "auto"
        );
    }
}
