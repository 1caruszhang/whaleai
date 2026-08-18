use std::path::Path;

use serde_json::Value;

pub fn is_prepared_session(session: &Value) -> bool {
    session
        .get("materializationState")
        .and_then(Value::as_str)
        .is_some_and(|state| state == "prepared")
}

pub fn is_history_visible_session(session: &Value, _sessions_dir: &Path) -> bool {
    !is_prepared_session(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_prepared_session_is_hidden() {
        assert!(is_prepared_session(
            &serde_json::json!({"materializationState":"prepared"})
        ));
        assert!(is_history_visible_session(
            &serde_json::json!({"id":"session-1"}),
            Path::new("/tmp/sessions"),
        ));
    }
}
