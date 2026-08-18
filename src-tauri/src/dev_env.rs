//! Debug-build convenience: materialize the documented development `.env`
//! variables into the process environment at startup, so the credential
//! owners read them through `std::env` exactly like an exported shell
//! variable.
//!
//! Release builds never read the environment for service secrets and this
//! module is compiled out entirely. Only the whitelisted development source
//! variables are loaded; a variable already present in the environment always
//! wins, so exported shell values override `.env`. Values are never logged
//! and never copied into config, databases, transcripts, or the bundle.

/// Repo-root `.env`, resolved at compile time next to the crate manifest.
const REPO_DEV_ENV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../.env");

fn development_env_whitelist() -> Vec<&'static str> {
    let mut names: Vec<&'static str> =
        crate::geo_provider_credentials::DEVELOPMENT_SOURCE_ENV_NAMES.to_vec();
    names.push(crate::deepseek_credentials::DEVELOPMENT_SECRET_ENV);
    names
}

pub(crate) fn is_allowed_dev_env_key(key: &str) -> bool {
    development_env_whitelist().contains(&key)
}

/// Load whitelisted development variables from the repo-root `.env` into the
/// process environment. Returns how many were materialized; the count is the
/// only thing ever logged.
pub(crate) fn load_repo_dev_env() -> usize {
    let content = match std::fs::read_to_string(REPO_DEV_ENV_PATH) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            crate::ulog_debug!("[dev-env] 仓库根目录没有 .env，跳过开发凭据加载");
            return 0;
        }
        Err(error) => {
            crate::ulog_warn!("[dev-env] 读取 .env 失败，跳过开发凭据加载：{}", error);
            return 0;
        }
    };

    let mut loaded = 0;
    for (key, value) in parse_dev_env_content(&content) {
        if !is_allowed_dev_env_key(&key) || value.is_empty() {
            continue;
        }
        if std::env::var_os(&key).is_some() {
            continue;
        }
        std::env::set_var(&key, &value);
        loaded += 1;
    }
    if loaded > 0 {
        crate::ulog_info!(
            "[dev-env] 已从仓库 .env 加载 {} 个开发凭据变量；已存在的环境变量未被覆盖",
            loaded
        );
    }
    loaded
}

/// Parse `.env` content into raw KEY/VALUE pairs. Tolerates a leading BOM,
/// blank lines, `#` full-line comments, surrounding whitespace, and one pair
/// of matching surrounding quotes. Malformed lines are skipped; inline
/// comments are deliberately NOT stripped (values may legitimately contain
/// `#`). Splitting happens on the first `=`, so values may contain `=`.
pub(crate) fn parse_dev_env_content(content: &str) -> Vec<(String, String)> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut pairs = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !is_env_key_name(key) {
            continue;
        }
        pairs.push((
            key.to_string(),
            strip_matching_quotes(value.trim()).to_string(),
        ));
    }
    pairs
}

fn is_env_key_name(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|char| char.is_ascii_alphanumeric() || char == '_')
}

fn strip_matching_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &value[1..value.len() - 1];
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_and_bare_values_and_splits_on_first_equals() {
        let content = "\u{feff}DEEPSEEK_API_KEY=\"sk-plain\"\nARK_API_KEY='sk-single'\n\
                       ALI_OSS_BUCKET=my-bucket\nCHAOJIMEIJIE_SECRET=abc=def==\n";
        assert_eq!(
            parse_dev_env_content(content),
            vec![
                ("DEEPSEEK_API_KEY".to_string(), "sk-plain".to_string()),
                ("ARK_API_KEY".to_string(), "sk-single".to_string()),
                ("ALI_OSS_BUCKET".to_string(), "my-bucket".to_string()),
                ("CHAOJIMEIJIE_SECRET".to_string(), "abc=def==".to_string()),
            ]
        );
    }

    #[test]
    fn skips_comments_blanks_malformed_and_inline_hash_kept() {
        let content = "# full-line comment\n\nINVALID NO EQUALS\n1STARTS_WITH_DIGIT=x\n\
                       BAD-KEY=y\nARK_API_KEY=sk#not-a-comment\n";
        assert_eq!(
            parse_dev_env_content(content),
            vec![("ARK_API_KEY".to_string(), "sk#not-a-comment".to_string())]
        );
    }

    #[test]
    fn whitelist_covers_exactly_the_documented_development_variables() {
        let expected = [
            "ARK_API_KEY",
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
            "DEEPSEEK_API_KEY",
        ];
        for name in expected {
            assert!(is_allowed_dev_env_key(name), "{name} 应在白名单内");
        }
        for name in [
            "OPENAI_API_KEY",
            "DEEPSEEK_MODEL",
            "ARK_BASE_URL",
            "DOUBAO_API_KEY",
        ] {
            assert!(!is_allowed_dev_env_key(name), "{name} 不应进入白名单");
        }
    }
}
