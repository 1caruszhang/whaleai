use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{open_database, BrandWorkspaceStore};

const POLICY_VERSION: &str = "xiaojing-real-geo-dashboard-v1";
const EVIDENCE_LIMIT: usize = 8;
const MATRIX_LIMIT: usize = 50;
const LOG_LIMIT: usize = 30;
const TREND_LIMIT: usize = 20;
const RUN_DRILLDOWN_UNIT_LIMIT: i64 = 50;
const SUFFICIENT_SAMPLE_COUNT: i64 = 3;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_exclusive: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardGetRequest {
    #[serde(default)]
    pub filters: GeoDashboardFilter,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardDrilldownRequest {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardCompleteness {
    successful: i64,
    failed: i64,
    pending: i64,
    total: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardEvidenceAnchor {
    kind: String,
    id: String,
    parent_id: String,
    label: String,
    occurred_at: String,
    operation_id: String,
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardMetric {
    key: String,
    numerator: Option<i64>,
    denominator: Option<i64>,
    value: Option<i64>,
    sample_time: Option<String>,
    sample_count: i64,
    completeness: GeoDashboardCompleteness,
    availability: String,
    sample_sufficiency: String,
    data_notes: Vec<String>,
    methodology: String,
    engine_filter_applies: bool,
    evidence: Vec<GeoDashboardEvidenceAnchor>,
    delta: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardSessionDimension {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardOperationDimension {
    id: String,
    kind: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardEngineDimension {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardDimensions {
    sessions: Vec<GeoDashboardSessionDimension>,
    operations: Vec<GeoDashboardOperationDimension>,
    engines: Vec<GeoDashboardEngineDimension>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardTrendPoint {
    run_id: String,
    plan_id: String,
    ordinal: i64,
    sampled_at: String,
    mention_rate: Option<i64>,
    recommendation_rate: Option<i64>,
    citation_rate: Option<i64>,
    successful: i64,
    failed: i64,
    pending: i64,
    evidence: GeoDashboardEvidenceAnchor,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardQuestionEngineRow {
    question_id: String,
    question: String,
    engine_id: String,
    observations: i64,
    successful: i64,
    failed: i64,
    pending: i64,
    mentioned: i64,
    recommended: i64,
    cited: i64,
    last_observed_at: String,
    evidence: GeoDashboardEvidenceAnchor,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardObservationLogEntry {
    anchor: GeoDashboardEvidenceAnchor,
    status: String,
    summary: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardContentPublishBreakdown {
    articles: BTreeMap<String, i64>,
    articles_with_approved_revision: i64,
    publish_executions: BTreeMap<String, i64>,
    publish_items: BTreeMap<String, i64>,
    submitted_items: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardFilterSemantics {
    time_interval: &'static str,
    timezone: &'static str,
    monitor_operation_lineage: &'static str,
    observation_policy: &'static str,
    engine_applicability: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeoDashboardProjection {
    workspace_id: String,
    workspace_name: String,
    policy_version: &'static str,
    generated_at: String,
    filters: GeoDashboardFilter,
    filter_semantics: GeoDashboardFilterSemantics,
    dimensions: GeoDashboardDimensions,
    metrics: Vec<GeoDashboardMetric>,
    trend: Vec<GeoDashboardTrendPoint>,
    question_engine_matrix: Vec<GeoDashboardQuestionEngineRow>,
    observation_log: Vec<GeoDashboardObservationLogEntry>,
    content_publish: GeoDashboardContentPublishBreakdown,
}

#[derive(Debug, Clone)]
struct NormalizedFilter {
    session_id: Option<String>,
    operation_id: Option<String>,
    from_ms: Option<i64>,
    to_exclusive_ms: Option<i64>,
    engine_id: Option<String>,
}

#[derive(Debug, Clone)]
struct Observation {
    anchor: GeoDashboardEvidenceAnchor,
    baseline_id: String,
    run_id: Option<String>,
    plan_id: Option<String>,
    run_ordinal: Option<i64>,
    question_id: String,
    question: String,
    engine_id: String,
    state: ObservationState,
    mentioned: bool,
    recommended: bool,
    cited: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObservationState {
    Succeeded,
    Failed,
    Pending,
}

#[derive(Debug, Clone)]
struct ContentRecord {
    anchor: GeoDashboardEvidenceAnchor,
    status: String,
    state: ObservationState,
    approved_revision: Option<i64>,
}

#[derive(Debug, Clone)]
struct RunAggregate {
    run_id: String,
    plan_id: String,
    ordinal: i64,
    sampled_at: String,
    anchor: GeoDashboardEvidenceAnchor,
    successful: i64,
    failed: i64,
    pending: i64,
    mentioned: i64,
    recommended: i64,
    cited: i64,
}

fn parse_timestamp(value: &str) -> Option<(i64, String)> {
    DateTime::parse_from_rfc3339(value).ok().map(|date| {
        let utc = date.with_timezone(&Utc);
        (
            utc.timestamp_millis(),
            utc.to_rfc3339_opts(SecondsFormat::Millis, true),
        )
    })
}

fn normalize_optional_id(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn normalized_filter(
    filter: GeoDashboardFilter,
) -> Result<(NormalizedFilter, GeoDashboardFilter), String> {
    let session_id = normalize_optional_id(filter.session_id);
    let operation_id = normalize_optional_id(filter.operation_id);
    let engine_id = normalize_optional_id(filter.engine_id);
    let from = normalize_optional_id(filter.from);
    let to_exclusive = normalize_optional_id(filter.to_exclusive);
    let parsed_from = match from.as_deref() {
        Some(value) => Some(
            parse_timestamp(value)
                .ok_or_else(|| "geo_dashboard_filter_time_invalid".to_string())?,
        ),
        None => None,
    };
    let parsed_to = match to_exclusive.as_deref() {
        Some(value) => Some(
            parse_timestamp(value)
                .ok_or_else(|| "geo_dashboard_filter_time_invalid".to_string())?,
        ),
        None => None,
    };
    if parsed_from
        .as_ref()
        .map(|value| value.0)
        .unwrap_or(i64::MIN)
        >= parsed_to.as_ref().map(|value| value.0).unwrap_or(i64::MAX)
    {
        return Err("geo_dashboard_filter_time_range_invalid".to_string());
    }
    let echo = GeoDashboardFilter {
        session_id: session_id.clone(),
        operation_id: operation_id.clone(),
        from: parsed_from.as_ref().map(|value| value.1.clone()),
        to_exclusive: parsed_to.as_ref().map(|value| value.1.clone()),
        engine_id: engine_id.clone(),
    };
    Ok((
        NormalizedFilter {
            session_id,
            operation_id,
            from_ms: parsed_from.map(|value| value.0),
            to_exclusive_ms: parsed_to.map(|value| value.0),
            engine_id,
        },
        echo,
    ))
}

fn in_time(filter: &NormalizedFilter, value: &str, fallback: &str) -> Option<String> {
    let (timestamp, normalized) = parse_timestamp(value).or_else(|| parse_timestamp(fallback))?;
    if filter.from_ms.is_some_and(|from| timestamp < from)
        || filter
            .to_exclusive_ms
            .is_some_and(|to_exclusive| timestamp >= to_exclusive)
    {
        return None;
    }
    Some(normalized)
}

fn rate(numerator: i64, denominator: i64) -> Option<i64> {
    (denominator > 0).then(|| ((numerator as f64 / denominator as f64) * 100.0).round() as i64)
}

fn completeness(observations: &[Observation]) -> GeoDashboardCompleteness {
    let successful = observations
        .iter()
        .filter(|item| item.state == ObservationState::Succeeded)
        .count() as i64;
    let failed = observations
        .iter()
        .filter(|item| item.state == ObservationState::Failed)
        .count() as i64;
    let pending = observations.len() as i64 - successful - failed;
    GeoDashboardCompleteness {
        successful,
        failed,
        pending,
        total: observations.len() as i64,
    }
}

fn availability(value: &GeoDashboardCompleteness) -> String {
    if value.total == 0 {
        "empty"
    } else if value.successful > 0 && value.failed == 0 && value.pending == 0 {
        "available"
    } else {
        "partial"
    }
    .to_string()
}

fn sample_sufficiency(completeness: &GeoDashboardCompleteness) -> String {
    if completeness.total == 0 {
        "none"
    } else if completeness.successful < SUFFICIENT_SAMPLE_COUNT {
        "insufficient"
    } else {
        "sufficient"
    }
    .to_string()
}

fn data_notes(completeness: &GeoDashboardCompleteness) -> Vec<String> {
    let mut notes = Vec::new();
    if completeness.total > 0 && completeness.successful < SUFFICIENT_SAMPLE_COUNT {
        notes.push(format!(
            "成功样本少于 {SUFFICIENT_SAMPLE_COUNT} 条，仅供参考"
        ));
    }
    if completeness.failed > 0 {
        notes.push(format!(
            "存在 {} 条失败 observation，比例只以成功样本为分母",
            completeness.failed
        ));
    }
    if completeness.pending > 0 {
        notes.push(format!(
            "仍有 {} 条 observation 尚未完成",
            completeness.pending
        ));
    }
    notes
}

fn json_bool(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn parse_json(value: Option<String>) -> Option<Value> {
    value.and_then(|value| serde_json::from_str::<Value>(&value).ok())
}

fn provider_success(
    status: &str,
    raw_answer: Option<&str>,
    raw_evidence: Option<&Value>,
    citations: Option<&Value>,
    analysis: Option<&Value>,
) -> (ObservationState, bool, bool, bool) {
    if matches!(status, "pending" | "running") {
        return (ObservationState::Pending, false, false, false);
    }
    let valid_citations = citations.is_some_and(Value::is_array);
    let valid = status == "succeeded"
        && raw_answer.is_some_and(|answer| !answer.trim().is_empty())
        && raw_evidence.is_some_and(|value| !value.is_null())
        && valid_citations
        && analysis.is_some_and(|value| value.is_object())
        && analysis
            .and_then(|value| json_bool(value, "brandMentioned"))
            .is_some()
        && analysis
            .and_then(|value| json_bool(value, "brandRecommended"))
            .is_some()
        && analysis
            .and_then(|value| json_bool(value, "hasCitationEvidence"))
            .is_some();
    if !valid {
        return (ObservationState::Failed, false, false, false);
    }
    let analysis = analysis.expect("validated analysis");
    (
        ObservationState::Succeeded,
        json_bool(analysis, "brandMentioned").unwrap_or(false),
        json_bool(analysis, "brandRecommended").unwrap_or(false),
        json_bool(analysis, "hasCitationEvidence").unwrap_or(false),
    )
}

fn source_matches(filter: &NormalizedFilter, session_id: &str, operation_id: &str) -> bool {
    filter
        .session_id
        .as_deref()
        .is_none_or(|selected| selected == session_id)
        && filter
            .operation_id
            .as_deref()
            .is_none_or(|selected| selected == operation_id)
}

fn monitor_source_matches(
    filter: &NormalizedFilter,
    session_id: &str,
    operation_id: &str,
    source_operation_id: &str,
) -> bool {
    filter
        .session_id
        .as_deref()
        .is_none_or(|selected| selected == session_id)
        && filter
            .operation_id
            .as_deref()
            .is_none_or(|selected| selected == operation_id || selected == source_operation_id)
}

fn bounded_anchors(mut values: Vec<GeoDashboardEvidenceAnchor>) -> Vec<GeoDashboardEvidenceAnchor> {
    values.sort_by(|left, right| {
        right
            .occurred_at
            .cmp(&left.occurred_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    values.dedup_by(|left, right| left.kind == right.kind && left.id == right.id);
    values.truncate(EVIDENCE_LIMIT);
    values
}

fn read_dimensions(connection: &Connection) -> Result<GeoDashboardDimensions, String> {
    let mut session_statement = connection
        .prepare(
            "SELECT session.id, session.title
             FROM brand_sessions session
             WHERE session.id IN (
                SELECT created_by_session_id FROM geo_baselines
                UNION SELECT created_by_session_id FROM geo_article_operations
                UNION SELECT created_by_session_id FROM geo_publish_executions
                UNION SELECT created_by_session_id FROM geo_post_publish_monitor_plans
             )
             ORDER BY session.title, session.id",
        )
        .map_err(|error| format!("prepare dashboard session dimensions: {error}"))?;
    let sessions = session_statement
        .query_map([], |row| {
            Ok(GeoDashboardSessionDimension {
                id: row.get(0)?,
                label: row.get(1)?,
            })
        })
        .map_err(|error| format!("read dashboard session dimensions: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("collect dashboard session dimensions: {error}"))?;

    let mut operations = BTreeMap::<String, GeoDashboardOperationDimension>::new();
    let mut add_operations = |sql: &str, kind: &str, monitor: bool| -> Result<(), String> {
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("prepare dashboard operation dimensions: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    if monitor {
                        row.get::<_, Option<String>>(2)?
                    } else {
                        None
                    },
                ))
            })
            .map_err(|error| format!("read dashboard operation dimensions: {error}"))?;
        for row in rows {
            let (id, created_at, source_operation_id) =
                row.map_err(|error| format!("collect dashboard operation dimension: {error}"))?;
            operations.insert(
                id.clone(),
                GeoDashboardOperationDimension {
                    id,
                    kind: kind.to_string(),
                    created_at,
                    source_operation_id,
                },
            );
        }
        Ok(())
    };
    add_operations(
        "SELECT baseline.operation_id, operation.created_at, NULL
         FROM geo_baselines baseline JOIN geo_operations operation ON operation.id=baseline.operation_id",
        "baseline",
        false,
    )?;
    add_operations(
        "SELECT article.operation_id, operation.created_at, NULL
         FROM geo_article_operations article JOIN geo_operations operation ON operation.id=article.operation_id",
        "article",
        false,
    )?;
    add_operations(
        "SELECT publish.operation_id, operation.created_at, NULL
         FROM geo_publish_executions publish JOIN geo_operations operation ON operation.id=publish.operation_id",
        "publish",
        false,
    )?;
    add_operations(
        "SELECT monitor.operation_id, operation.created_at, monitor.source_operation_id
         FROM geo_post_publish_monitor_plans monitor
         JOIN geo_operations operation ON operation.id=monitor.operation_id",
        "monitor",
        true,
    )?;
    let mut operations = operations.into_values().collect::<Vec<_>>();
    operations.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut engine_statement = connection
        .prepare(
            "SELECT engine_id FROM geo_baseline_units
             UNION SELECT engine_id FROM geo_post_publish_monitor_units WHERE engine_id IS NOT NULL
             ORDER BY engine_id",
        )
        .map_err(|error| format!("prepare dashboard engine dimensions: {error}"))?;
    let historical_engines = engine_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("read dashboard engine dimensions: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("collect dashboard engine dimensions: {error}"))?
        .into_iter()
        .collect::<BTreeSet<_>>();
    // Product capability allowlist is a valid filter dimension even before
    // the first observation exists. Historical engine ids remain readable so
    // old real evidence is not orphaned by a later product capability change.
    let engines = historical_engines
        .into_iter()
        .chain(std::iter::once("doubao".to_string()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|id| GeoDashboardEngineDimension {
            label: if id == "doubao" {
                "豆包 AI 搜索".to_string()
            } else {
                id.clone()
            },
            id,
        })
        .collect();
    Ok(GeoDashboardDimensions {
        sessions,
        operations,
        engines,
    })
}

fn validate_filter_dimensions(
    filter: &NormalizedFilter,
    dimensions: &GeoDashboardDimensions,
) -> Result<(), String> {
    if filter.session_id.as_ref().is_some_and(|selected| {
        !dimensions
            .sessions
            .iter()
            .any(|candidate| candidate.id == *selected)
    }) {
        return Err("geo_dashboard_filter_session_unknown".to_string());
    }
    if filter.operation_id.as_ref().is_some_and(|selected| {
        !dimensions.operations.iter().any(|candidate| {
            candidate.id == *selected
                || candidate.source_operation_id.as_deref() == Some(selected.as_str())
        })
    }) {
        return Err("geo_dashboard_filter_operation_unknown".to_string());
    }
    if filter.engine_id.as_ref().is_some_and(|selected| {
        !dimensions
            .engines
            .iter()
            .any(|candidate| candidate.id == *selected)
    }) {
        return Err("geo_dashboard_filter_engine_unknown".to_string());
    }
    Ok(())
}

fn read_baseline_observations(
    connection: &Connection,
    filter: &NormalizedFilter,
) -> Result<Vec<Observation>, String> {
    let mut statement = connection
        .prepare(
            "SELECT baseline.id, baseline.operation_id, baseline.created_by_session_id,
                    baseline.created_at, unit.id, unit.question_id, unit.question_text,
                    unit.engine_id, unit.status, unit.raw_answer, unit.raw_evidence_json,
                    unit.citations_json, unit.analysis_json,
                    COALESCE(unit.finished_at, unit.started_at, baseline.created_at)
             FROM geo_baseline_units unit
             JOIN geo_baselines baseline ON baseline.id=unit.baseline_id",
        )
        .map_err(|error| format!("prepare dashboard baseline observations: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, String>(13)?,
            ))
        })
        .map_err(|error| format!("read dashboard baseline observations: {error}"))?;
    let mut observations = Vec::new();
    for row in rows {
        let (
            baseline_id,
            operation_id,
            session_id,
            created_at,
            unit_id,
            question_id,
            question,
            engine_id,
            status,
            raw_answer,
            raw_evidence_json,
            citations_json,
            analysis_json,
            occurred_at,
        ) = row.map_err(|error| format!("collect dashboard baseline observation: {error}"))?;
        if !source_matches(filter, &session_id, &operation_id)
            || filter
                .engine_id
                .as_deref()
                .is_some_and(|selected| selected != engine_id)
        {
            continue;
        }
        let Some(occurred_at) = in_time(filter, &occurred_at, &created_at) else {
            continue;
        };
        let raw_evidence = parse_json(raw_evidence_json);
        let citations = parse_json(citations_json);
        let analysis = parse_json(analysis_json);
        let (state, mentioned, recommended, cited) = provider_success(
            &status,
            raw_answer.as_deref(),
            raw_evidence.as_ref(),
            citations.as_ref(),
            analysis.as_ref(),
        );
        observations.push(Observation {
            anchor: GeoDashboardEvidenceAnchor {
                kind: "baseline-unit".to_string(),
                id: unit_id,
                parent_id: baseline_id.clone(),
                label: question.clone(),
                occurred_at,
                operation_id,
                session_id,
                engine_id: Some(engine_id.clone()),
            },
            baseline_id,
            run_id: None,
            plan_id: None,
            run_ordinal: None,
            question_id,
            question,
            engine_id,
            state,
            mentioned,
            recommended,
            cited,
        });
    }
    Ok(observations)
}

fn read_monitor_probe_observations(
    connection: &Connection,
    filter: &NormalizedFilter,
) -> Result<Vec<Observation>, String> {
    let mut statement = connection
        .prepare(
            "SELECT plan.id, plan.operation_id, plan.source_operation_id,
                    plan.created_by_session_id, plan.baseline_id,
                    run.id, run.ordinal, run.created_at,
                    unit.id, unit.question_id, question.question_text, unit.engine_id,
                    unit.status, unit.evidence_json,
                    COALESCE(unit.observed_at,
                      (SELECT MAX(attempt.finished_at) FROM geo_post_publish_monitor_attempts attempt
                       WHERE attempt.unit_id=unit.id),
                      run.finished_at, run.created_at)
             FROM geo_post_publish_monitor_units unit
             JOIN geo_post_publish_monitor_runs run ON run.id=unit.run_id
             JOIN geo_post_publish_monitor_plans plan ON plan.id=unit.plan_id
             LEFT JOIN geo_post_publish_monitor_questions question
               ON question.plan_id=plan.id AND question.baseline_unit_id=unit.baseline_unit_id
             WHERE unit.kind='baseline-probe'",
        )
        .map_err(|error| format!("prepare dashboard monitor observations: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, String>(14)?,
            ))
        })
        .map_err(|error| format!("read dashboard monitor observations: {error}"))?;
    let mut observations = Vec::new();
    for row in rows {
        let (
            plan_id,
            operation_id,
            source_operation_id,
            session_id,
            baseline_id,
            run_id,
            ordinal,
            run_created_at,
            unit_id,
            question_id,
            question,
            engine_id,
            status,
            evidence_json,
            occurred_at,
        ) = row.map_err(|error| format!("collect dashboard monitor observation: {error}"))?;
        let (Some(question_id), Some(question), Some(engine_id)) =
            (question_id, question, engine_id)
        else {
            continue;
        };
        if !monitor_source_matches(filter, &session_id, &operation_id, &source_operation_id)
            || filter
                .engine_id
                .as_deref()
                .is_some_and(|selected| selected != engine_id)
        {
            continue;
        }
        let Some(occurred_at) = in_time(filter, &occurred_at, &run_created_at) else {
            continue;
        };
        let evidence = parse_json(evidence_json);
        let raw_answer = evidence
            .as_ref()
            .and_then(|value| value.get("rawAnswer"))
            .and_then(Value::as_str);
        let raw_evidence = evidence.as_ref().and_then(|value| value.get("rawEvidence"));
        let citations = evidence.as_ref().and_then(|value| value.get("citations"));
        let analysis = evidence.as_ref().and_then(|value| value.get("analysis"));
        let (state, mentioned, recommended, cited) =
            provider_success(&status, raw_answer, raw_evidence, citations, analysis);
        observations.push(Observation {
            anchor: GeoDashboardEvidenceAnchor {
                kind: "monitor-unit".to_string(),
                id: unit_id,
                parent_id: run_id.clone(),
                label: question.clone(),
                occurred_at,
                operation_id,
                session_id,
                engine_id: Some(engine_id.clone()),
            },
            baseline_id,
            run_id: Some(run_id),
            plan_id: Some(plan_id),
            run_ordinal: Some(ordinal),
            question_id,
            question,
            engine_id,
            state,
            mentioned,
            recommended,
            cited,
        });
    }
    Ok(observations)
}

fn read_article_records(
    connection: &Connection,
    filter: &NormalizedFilter,
    caller_session_id: &str,
) -> Result<Vec<ContentRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT article.id, article.operation_id, operation.created_by_session_id,
                    article.requested_title, article.status, article.approved_revision,
                    article.created_at, article.updated_at,
                    (SELECT version.title FROM geo_article_versions version
                     WHERE version.article_id=article.id
                       AND version.revision=article.approved_revision),
                    (SELECT version.approved_at FROM geo_article_versions version
                     WHERE version.article_id=article.id
                       AND version.revision=article.approved_revision)
             FROM geo_articles article
             JOIN geo_article_operations operation ON operation.operation_id=article.operation_id",
        )
        .map_err(|error| format!("prepare dashboard article records: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
            ))
        })
        .map_err(|error| format!("read dashboard article records: {error}"))?;
    let mut records = Vec::new();
    for row in rows {
        let (
            id,
            operation_id,
            session_id,
            title,
            status,
            approved_revision,
            created_at,
            updated_at,
            approved_title,
            approved_at,
        ) = row.map_err(|error| format!("collect dashboard article record: {error}"))?;
        if session_id != caller_session_id && approved_revision.is_none() {
            continue;
        }
        if !source_matches(filter, &session_id, &operation_id) {
            continue;
        }
        let cross_session = session_id != caller_session_id;
        let visible_title = if cross_session {
            approved_title.unwrap_or(title)
        } else {
            title
        };
        let visible_status = if cross_session {
            "approved".to_string()
        } else {
            status
        };
        let visible_updated_at = if cross_session {
            approved_at.as_deref().unwrap_or(&created_at)
        } else {
            &updated_at
        };
        let Some(occurred_at) = in_time(filter, visible_updated_at, &created_at) else {
            continue;
        };
        let state = if visible_status == "approved" && approved_revision.is_some() {
            ObservationState::Succeeded
        } else if matches!(visible_status.as_str(), "generation_failed" | "rejected") {
            ObservationState::Failed
        } else {
            ObservationState::Pending
        };
        records.push(ContentRecord {
            anchor: GeoDashboardEvidenceAnchor {
                kind: "article".to_string(),
                id,
                parent_id: operation_id.clone(),
                label: visible_title,
                occurred_at,
                operation_id,
                session_id,
                engine_id: None,
            },
            status: visible_status,
            state,
            approved_revision,
        });
    }
    Ok(records)
}

fn read_publish_item_records(
    connection: &Connection,
    filter: &NormalizedFilter,
) -> Result<Vec<ContentRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT item.id, execution.id, execution.operation_id,
                    execution.created_by_session_id, item.article_json, item.channel_json,
                    item.status, execution.created_at,
                    COALESCE(item.finished_at,item.started_at,item.scheduled_at,execution.created_at)
             FROM geo_publish_items item
             JOIN geo_publish_executions execution ON execution.id=item.execution_id",
        )
        .map_err(|error| format!("prepare dashboard publish items: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })
        .map_err(|error| format!("read dashboard publish items: {error}"))?;
    let mut records = Vec::new();
    for row in rows {
        let (
            id,
            execution_id,
            operation_id,
            session_id,
            article_json,
            channel_json,
            status,
            created_at,
            occurred_at,
        ) = row.map_err(|error| format!("collect dashboard publish item: {error}"))?;
        if !source_matches(filter, &session_id, &operation_id) {
            continue;
        }
        let Some(occurred_at) = in_time(filter, &occurred_at, &created_at) else {
            continue;
        };
        let article = serde_json::from_str::<Value>(&article_json).ok();
        let channel = serde_json::from_str::<Value>(&channel_json).ok();
        let title = article
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("文章");
        let channel_name = channel
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("渠道");
        let state = if status == "submitted" {
            ObservationState::Succeeded
        } else if matches!(
            status.as_str(),
            "failed-retryable" | "failed-nonretryable" | "reconciliation-required"
        ) {
            ObservationState::Failed
        } else {
            ObservationState::Pending
        };
        records.push(ContentRecord {
            anchor: GeoDashboardEvidenceAnchor {
                kind: "publish-item".to_string(),
                id,
                parent_id: execution_id,
                label: format!("{title} · {channel_name}"),
                occurred_at,
                operation_id,
                session_id,
                engine_id: None,
            },
            status,
            state,
            approved_revision: None,
        });
    }
    Ok(records)
}

fn read_publish_execution_breakdown(
    connection: &Connection,
    filter: &NormalizedFilter,
) -> Result<BTreeMap<String, i64>, String> {
    let mut statement = connection
        .prepare(
            "SELECT operation_id, created_by_session_id, status, created_at, updated_at
             FROM geo_publish_executions",
        )
        .map_err(|error| format!("prepare dashboard publish executions: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| format!("read dashboard publish executions: {error}"))?;
    let mut counts = BTreeMap::new();
    for row in rows {
        let (operation_id, session_id, status, created_at, updated_at) =
            row.map_err(|error| format!("collect dashboard publish execution: {error}"))?;
        if source_matches(filter, &session_id, &operation_id)
            && in_time(filter, &updated_at, &created_at).is_some()
        {
            *counts.entry(status).or_insert(0) += 1;
        }
    }
    Ok(counts)
}

fn read_non_probe_monitor_logs(
    connection: &Connection,
    filter: &NormalizedFilter,
) -> Result<Vec<GeoDashboardObservationLogEntry>, String> {
    let mut statement = connection
        .prepare(
            "SELECT plan.id, plan.operation_id, plan.source_operation_id,
                    plan.created_by_session_id, run.id, run.created_at,
                    unit.id, unit.kind, unit.status,
                    COALESCE(unit.observed_at,
                      (SELECT MAX(attempt.finished_at) FROM geo_post_publish_monitor_attempts attempt
                       WHERE attempt.unit_id=unit.id),
                      run.finished_at,run.created_at)
             FROM geo_post_publish_monitor_units unit
             JOIN geo_post_publish_monitor_runs run ON run.id=unit.run_id
             JOIN geo_post_publish_monitor_plans plan ON plan.id=unit.plan_id
             WHERE unit.kind!='baseline-probe'",
        )
        .map_err(|error| format!("prepare dashboard monitor log: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|error| format!("read dashboard monitor log: {error}"))?;
    let mut logs = Vec::new();
    for row in rows {
        let (
            plan_id,
            operation_id,
            source_operation_id,
            session_id,
            run_id,
            run_created_at,
            unit_id,
            kind,
            status,
            occurred_at,
        ) = row.map_err(|error| format!("collect dashboard monitor log: {error}"))?;
        if !monitor_source_matches(filter, &session_id, &operation_id, &source_operation_id) {
            continue;
        }
        let Some(occurred_at) = in_time(filter, &occurred_at, &run_created_at) else {
            continue;
        };
        let normalized_status = if status == "succeeded" {
            "succeeded"
        } else if status == "failed" {
            "failed"
        } else {
            "pending"
        };
        let kind_label = if kind == "publish-status" {
            "渠道发布状态"
        } else {
            "页面可访问与收录状态"
        };
        logs.push(GeoDashboardObservationLogEntry {
            anchor: GeoDashboardEvidenceAnchor {
                kind: "monitor-unit".to_string(),
                id: unit_id,
                parent_id: run_id,
                label: kind_label.to_string(),
                occurred_at,
                operation_id,
                session_id,
                engine_id: None,
            },
            status: normalized_status.to_string(),
            summary: format!("{kind_label} · {normalized_status} · plan {plan_id}"),
        });
    }
    Ok(logs)
}

fn denominator_questions(
    connection: &Connection,
    baseline_ids: &HashSet<String>,
    engine_id: Option<&str>,
) -> Result<HashSet<String>, String> {
    if baseline_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let mut statement = connection
        .prepare("SELECT baseline_id,question_id,engine_id FROM geo_baseline_units")
        .map_err(|error| format!("prepare dashboard question denominator: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("read dashboard question denominator: {error}"))?;
    let mut questions = HashSet::new();
    for row in rows {
        let (baseline_id, question_id, candidate_engine) =
            row.map_err(|error| format!("collect dashboard question denominator: {error}"))?;
        if baseline_ids.contains(&baseline_id)
            && engine_id.is_none_or(|selected| selected == candidate_engine)
        {
            questions.insert(question_id);
        }
    }
    Ok(questions)
}

fn build_rate_metric(
    key: &str,
    observations: &[Observation],
    predicate: impl Fn(&Observation) -> bool,
    methodology: &str,
) -> GeoDashboardMetric {
    let completeness = completeness(observations);
    let numerator = observations
        .iter()
        .filter(|item| item.state == ObservationState::Succeeded && predicate(item))
        .count() as i64;
    let successful = completeness.successful;
    let positives = observations
        .iter()
        .filter(|item| item.state == ObservationState::Succeeded && predicate(item))
        .map(|item| item.anchor.clone())
        .collect::<Vec<_>>();
    let fallback = observations
        .iter()
        .filter(|item| item.state != ObservationState::Pending)
        .map(|item| item.anchor.clone())
        .collect::<Vec<_>>();
    GeoDashboardMetric {
        key: key.to_string(),
        numerator: (successful > 0).then_some(numerator),
        denominator: (successful > 0).then_some(successful),
        value: rate(numerator, successful),
        sample_time: observations
            .iter()
            .map(|item| item.anchor.occurred_at.clone())
            .max(),
        sample_count: successful,
        availability: availability(&completeness),
        sample_sufficiency: sample_sufficiency(&completeness),
        data_notes: data_notes(&completeness),
        completeness,
        methodology: methodology.to_string(),
        engine_filter_applies: true,
        evidence: bounded_anchors(if positives.is_empty() {
            fallback
        } else {
            positives
        }),
        delta: None,
    }
}

fn build_question_coverage_metric(
    observations: &[Observation],
    denominator_questions: &HashSet<String>,
) -> GeoDashboardMetric {
    let completeness = completeness(observations);
    let covered = observations
        .iter()
        .filter(|item| item.state == ObservationState::Succeeded)
        .map(|item| item.question_id.clone())
        .collect::<HashSet<_>>();
    let denominator = denominator_questions.len() as i64;
    let numerator = covered.len() as i64;
    GeoDashboardMetric {
        key: "question-coverage".to_string(),
        numerator: (denominator > 0).then_some(numerator),
        denominator: (denominator > 0).then_some(denominator),
        value: rate(numerator, denominator),
        sample_time: observations
            .iter()
            .map(|item| item.anchor.occurred_at.clone())
            .max(),
        sample_count: covered.len() as i64,
        availability: if denominator == 0 {
            "empty".to_string()
        } else {
            availability(&completeness)
        },
        sample_sufficiency: sample_sufficiency(&completeness),
        data_notes: data_notes(&completeness),
        completeness,
        methodology: "筛选范围内 distinct 已成功真实探测问题 / 对应 exact baseline 已确认问题池的 distinct 问题；同 question×engine 跨 run 只增加 observation 样本，不扩大问题分母".to_string(),
        engine_filter_applies: true,
        evidence: bounded_anchors(
            observations
                .iter()
                .filter(|item| item.state == ObservationState::Succeeded)
                .map(|item| item.anchor.clone())
                .collect(),
        ),
        delta: None,
    }
}

fn content_completeness(records: &[ContentRecord]) -> GeoDashboardCompleteness {
    let successful = records
        .iter()
        .filter(|item| item.state == ObservationState::Succeeded)
        .count() as i64;
    let failed = records
        .iter()
        .filter(|item| item.state == ObservationState::Failed)
        .count() as i64;
    GeoDashboardCompleteness {
        successful,
        failed,
        pending: records.len() as i64 - successful - failed,
        total: records.len() as i64,
    }
}

fn build_content_metric(
    articles: &[ContentRecord],
    publish_items: &[ContentRecord],
) -> GeoDashboardMetric {
    let completeness = content_completeness(articles);
    let approved = articles
        .iter()
        .filter(|item| item.state == ObservationState::Succeeded)
        .count() as i64;
    let denominator = articles.len() as i64;
    let total_visible = denominator + publish_items.len() as i64;
    let mut notes = data_notes(&completeness);
    if publish_items.iter().any(|item| item.status == "submitted") {
        notes.push("submitted 只表示渠道已受理，不等于已发布或已收录".to_string());
    }
    GeoDashboardMetric {
        key: "content-publish".to_string(),
        numerator: (denominator > 0).then_some(approved),
        denominator: (denominator > 0).then_some(denominator),
        value: rate(approved, denominator),
        sample_time: articles
            .iter()
            .chain(publish_items.iter())
            .map(|item| item.anchor.occurred_at.clone())
            .max(),
        sample_count: denominator,
        availability: if total_visible == 0 {
            "empty".to_string()
        } else if completeness.failed > 0 || completeness.pending > 0 {
            "partial".to_string()
        } else {
            "available".to_string()
        },
        sample_sufficiency: if denominator == 0 {
            "none".to_string()
        } else {
            "sufficient".to_string()
        },
        data_notes: notes,
        completeness,
        methodology: "批准文章数 / 全部 Ticket 11 文章；Ticket 13 execution/item 仅展示真实 durable 状态分布，submitted 不计作 published/indexed".to_string(),
        engine_filter_applies: false,
        evidence: bounded_anchors(
            articles
                .iter()
                .chain(publish_items.iter())
                .map(|item| item.anchor.clone())
                .collect(),
        ),
        delta: None,
    }
}

fn build_trend(observations: &[Observation]) -> (Vec<GeoDashboardTrendPoint>, Vec<RunAggregate>) {
    let mut runs = HashMap::<String, RunAggregate>::new();
    for item in observations.iter().filter(|item| item.run_id.is_some()) {
        let run_id = item.run_id.as_ref().expect("filtered run id");
        let entry = runs.entry(run_id.clone()).or_insert_with(|| RunAggregate {
            run_id: run_id.clone(),
            plan_id: item.plan_id.clone().unwrap_or_default(),
            ordinal: item.run_ordinal.unwrap_or_default(),
            sampled_at: item.anchor.occurred_at.clone(),
            anchor: GeoDashboardEvidenceAnchor {
                kind: "monitor-run".to_string(),
                id: run_id.clone(),
                parent_id: item.plan_id.clone().unwrap_or_default(),
                label: format!("监测第 {} 次", item.run_ordinal.unwrap_or_default()),
                occurred_at: item.anchor.occurred_at.clone(),
                operation_id: item.anchor.operation_id.clone(),
                session_id: item.anchor.session_id.clone(),
                engine_id: item.anchor.engine_id.clone(),
            },
            successful: 0,
            failed: 0,
            pending: 0,
            mentioned: 0,
            recommended: 0,
            cited: 0,
        });
        if item.anchor.occurred_at > entry.sampled_at {
            entry.sampled_at = item.anchor.occurred_at.clone();
            entry.anchor.occurred_at = item.anchor.occurred_at.clone();
        }
        match item.state {
            ObservationState::Succeeded => {
                entry.successful += 1;
                entry.mentioned += i64::from(item.mentioned);
                entry.recommended += i64::from(item.recommended);
                entry.cited += i64::from(item.cited);
            }
            ObservationState::Failed => entry.failed += 1,
            ObservationState::Pending => entry.pending += 1,
        }
    }
    let mut aggregates = runs.into_values().collect::<Vec<_>>();
    aggregates.sort_by(|left, right| {
        left.sampled_at
            .cmp(&right.sampled_at)
            .then_with(|| left.ordinal.cmp(&right.ordinal))
            .then_with(|| left.run_id.cmp(&right.run_id))
    });
    if aggregates.len() > TREND_LIMIT {
        aggregates.drain(0..aggregates.len() - TREND_LIMIT);
    }
    let trend = aggregates
        .iter()
        .map(|run| GeoDashboardTrendPoint {
            run_id: run.run_id.clone(),
            plan_id: run.plan_id.clone(),
            ordinal: run.ordinal,
            sampled_at: run.sampled_at.clone(),
            mention_rate: rate(run.mentioned, run.successful),
            recommendation_rate: rate(run.recommended, run.successful),
            citation_rate: rate(run.cited, run.successful),
            successful: run.successful,
            failed: run.failed,
            pending: run.pending,
            evidence: run.anchor.clone(),
        })
        .collect();
    (trend, aggregates)
}

fn build_monitor_metric(runs: &[RunAggregate]) -> GeoDashboardMetric {
    let latest = runs.last();
    let previous = latest.and_then(|_| runs.iter().rev().nth(1));
    let completeness = latest.map_or(
        GeoDashboardCompleteness {
            successful: 0,
            failed: 0,
            pending: 0,
            total: 0,
        },
        |run| GeoDashboardCompleteness {
            successful: run.successful,
            failed: run.failed,
            pending: run.pending,
            total: run.successful + run.failed + run.pending,
        },
    );
    let latest_rate = latest.and_then(|run| rate(run.mentioned, run.successful));
    let previous_rate = previous.and_then(|run| rate(run.mentioned, run.successful));
    let mut notes = data_notes(&completeness);
    if previous_rate.is_none() || latest_rate.is_none() {
        notes.push("没有前后两个可比较的真实成功 run，不计算变化值".to_string());
    }
    GeoDashboardMetric {
        key: "monitor-change".to_string(),
        numerator: latest.and_then(|run| (run.successful > 0).then_some(run.mentioned)),
        denominator: latest.and_then(|run| (run.successful > 0).then_some(run.successful)),
        value: latest_rate,
        sample_time: latest.map(|run| run.sampled_at.clone()),
        sample_count: latest.map_or(0, |run| run.successful),
        availability: availability(&completeness),
        sample_sufficiency: sample_sufficiency(&completeness),
        data_notes: notes,
        completeness,
        methodology: "最新 Ticket 14 run 成功 baseline-probe 中品牌提及 / 该 run 成功 probe；变化值只比较最近两个都有成功样本的真实 run".to_string(),
        engine_filter_applies: true,
        evidence: latest
            .map(|run| vec![run.anchor.clone()])
            .unwrap_or_default(),
        delta: latest_rate.zip(previous_rate).map(|(latest, previous)| latest - previous),
    }
}

fn build_matrix(observations: &[Observation]) -> Vec<GeoDashboardQuestionEngineRow> {
    #[derive(Default)]
    struct Acc {
        question: String,
        successful: i64,
        failed: i64,
        pending: i64,
        mentioned: i64,
        recommended: i64,
        cited: i64,
        latest: Option<GeoDashboardEvidenceAnchor>,
    }
    let mut values = BTreeMap::<(String, String), Acc>::new();
    for item in observations {
        let value = values
            .entry((item.question_id.clone(), item.engine_id.clone()))
            .or_default();
        value.question = item.question.clone();
        match item.state {
            ObservationState::Succeeded => {
                value.successful += 1;
                value.mentioned += i64::from(item.mentioned);
                value.recommended += i64::from(item.recommended);
                value.cited += i64::from(item.cited);
            }
            ObservationState::Failed => value.failed += 1,
            ObservationState::Pending => value.pending += 1,
        }
        if value
            .latest
            .as_ref()
            .is_none_or(|current| item.anchor.occurred_at > current.occurred_at)
        {
            value.latest = Some(item.anchor.clone());
        }
    }
    let mut rows = values
        .into_iter()
        .filter_map(|((question_id, engine_id), value)| {
            let evidence = value.latest?;
            Some(GeoDashboardQuestionEngineRow {
                question_id,
                question: value.question,
                engine_id,
                observations: value.successful + value.failed + value.pending,
                successful: value.successful,
                failed: value.failed,
                pending: value.pending,
                mentioned: value.mentioned,
                recommended: value.recommended,
                cited: value.cited,
                last_observed_at: evidence.occurred_at.clone(),
                evidence,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .last_observed_at
            .cmp(&left.last_observed_at)
            .then_with(|| left.question_id.cmp(&right.question_id))
            .then_with(|| left.engine_id.cmp(&right.engine_id))
    });
    rows.truncate(MATRIX_LIMIT);
    rows
}

fn build_observation_log(
    observations: &[Observation],
    mut non_probe: Vec<GeoDashboardObservationLogEntry>,
) -> Vec<GeoDashboardObservationLogEntry> {
    non_probe.extend(observations.iter().map(|item| {
        let (status, summary) = match item.state {
            ObservationState::Succeeded => (
                "succeeded",
                format!(
                    "{} · {} · 提及{} / 推荐{} / 引用{}",
                    item.engine_id,
                    if item.run_id.is_some() {
                        "监测复测"
                    } else {
                        "优化前基线"
                    },
                    if item.mentioned { "是" } else { "否" },
                    if item.recommended { "是" } else { "否" },
                    if item.cited { "是" } else { "否" },
                ),
            ),
            ObservationState::Failed => (
                "failed",
                format!("{} · observation 失败或证据解析失败", item.engine_id),
            ),
            ObservationState::Pending => (
                "pending",
                format!("{} · observation 尚未完成", item.engine_id),
            ),
        };
        GeoDashboardObservationLogEntry {
            anchor: item.anchor.clone(),
            status: status.to_string(),
            summary,
        }
    }));
    non_probe.sort_by(|left, right| {
        right
            .anchor
            .occurred_at
            .cmp(&left.anchor.occurred_at)
            .then_with(|| left.anchor.id.cmp(&right.anchor.id))
    });
    non_probe.truncate(LOG_LIMIT);
    non_probe
}

fn require_dashboard_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM brand_sessions WHERE id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("verify dashboard session: {error}"))?;
    exists
        .then_some(())
        .ok_or_else(|| "geo_dashboard_session_not_found".to_string())
}

fn build_projection(
    connection: &Connection,
    workspace_id: &str,
    workspace_name: &str,
    caller_session_id: &str,
    request: GeoDashboardGetRequest,
    generated_at: String,
) -> Result<GeoDashboardProjection, String> {
    let (filter, echoed_filter) = normalized_filter(request.filters)?;
    let dimensions = read_dimensions(connection)?;
    validate_filter_dimensions(&filter, &dimensions)?;

    let mut baseline_observations = read_baseline_observations(connection, &filter)?;
    let monitor_observations = read_monitor_probe_observations(connection, &filter)?;
    let mut observations =
        Vec::with_capacity(baseline_observations.len() + monitor_observations.len());
    observations.append(&mut baseline_observations);
    observations.extend(monitor_observations);
    observations.sort_by(|left, right| {
        left.anchor
            .occurred_at
            .cmp(&right.anchor.occurred_at)
            .then_with(|| left.anchor.id.cmp(&right.anchor.id))
    });

    let baseline_ids = observations
        .iter()
        .map(|item| item.baseline_id.clone())
        .collect::<HashSet<_>>();
    let question_denominator =
        denominator_questions(connection, &baseline_ids, filter.engine_id.as_deref())?;
    let articles = read_article_records(connection, &filter, caller_session_id)?;
    let publish_items = read_publish_item_records(connection, &filter)?;
    let publish_executions = read_publish_execution_breakdown(connection, &filter)?;
    let non_probe_logs = read_non_probe_monitor_logs(connection, &filter)?;
    let (trend, run_aggregates) = build_trend(&observations);

    let metrics = vec![
        build_rate_metric(
            "brand-mention",
            &observations,
            |item| item.mentioned,
            "筛选后所有成功真实 observation 中 brandMentioned=true / 成功 observation；baseline 与每次 monitor 复测均为独立样本",
        ),
        build_rate_metric(
            "recommendation",
            &observations,
            |item| item.recommended,
            "筛选后所有成功真实 observation 中 brandRecommended=true / 成功 observation；失败、未知和解析失败不进成功分母",
        ),
        build_rate_metric(
            "citation-coverage",
            &observations,
            |item| item.cited,
            "筛选后所有成功真实 observation 中 hasCitationEvidence=true / 成功 observation；只接受已持久化的真实 citation evidence",
        ),
        build_question_coverage_metric(&observations, &question_denominator),
        build_content_metric(&articles, &publish_items),
        build_monitor_metric(&run_aggregates),
    ];

    let mut article_counts = BTreeMap::new();
    for article in &articles {
        *article_counts.entry(article.status.clone()).or_insert(0) += 1;
    }
    let mut publish_item_counts = BTreeMap::new();
    for item in &publish_items {
        *publish_item_counts.entry(item.status.clone()).or_insert(0) += 1;
    }
    let content_publish = GeoDashboardContentPublishBreakdown {
        articles_with_approved_revision: articles
            .iter()
            .filter(|item| item.approved_revision.is_some())
            .count() as i64,
        submitted_items: publish_items
            .iter()
            .filter(|item| item.status == "submitted")
            .count() as i64,
        articles: article_counts,
        publish_executions,
        publish_items: publish_item_counts,
    };

    Ok(GeoDashboardProjection {
        workspace_id: workspace_id.to_string(),
        workspace_name: workspace_name.to_string(),
        policy_version: POLICY_VERSION,
        generated_at,
        filters: echoed_filter,
        filter_semantics: GeoDashboardFilterSemantics {
            time_interval: "[from,toExclusive)",
            timezone: "UTC",
            monitor_operation_lineage: "monitor-or-source-operation",
            observation_policy: "all-observations",
            engine_applicability: "engine-metrics-only",
        },
        dimensions,
        metrics,
        trend,
        question_engine_matrix: build_matrix(&observations),
        observation_log: build_observation_log(&observations, non_probe_logs),
        content_publish,
    })
}

fn json_or_parse_error(value: Option<String>) -> Value {
    match value {
        Some(raw) => {
            serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "parseError": true, "raw": raw }))
        }
        None => Value::Null,
    }
}

impl BrandWorkspaceStore {
    pub fn get_geo_dashboard(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoDashboardGetRequest,
    ) -> Result<GeoDashboardProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_dashboard_session(&connection, session_id)?;
        build_projection(
            &connection,
            workspace_id,
            &workspace.name,
            session_id,
            request,
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        )
    }

    pub fn get_geo_dashboard_drilldown(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: GeoDashboardDrilldownRequest,
    ) -> Result<Value, String> {
        if request.id.trim().is_empty() {
            return Err("geo_dashboard_drilldown_id_invalid".to_string());
        }
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_dashboard_session(&connection, session_id)?;
        match request.kind.as_str() {
            "baseline-unit" => {
                let row = connection
                    .query_row(
                        "SELECT baseline.id,baseline.operation_id,baseline.created_by_session_id,
                                unit.question_id,unit.question_text,unit.engine_id,unit.status,
                                unit.raw_answer,unit.raw_evidence_json,unit.citations_json,
                                unit.analysis_json,unit.started_at,unit.finished_at,
                                unit.error_code,unit.error_message
                         FROM geo_baseline_units unit
                         JOIN geo_baselines baseline ON baseline.id=unit.baseline_id
                         WHERE unit.id=?1",
                        [&request.id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, Option<String>>(7)?,
                                row.get::<_, Option<String>>(8)?,
                                row.get::<_, Option<String>>(9)?,
                                row.get::<_, Option<String>>(10)?,
                                row.get::<_, Option<String>>(11)?,
                                row.get::<_, Option<String>>(12)?,
                                row.get::<_, Option<String>>(13)?,
                                row.get::<_, Option<String>>(14)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("read dashboard baseline drilldown: {error}"))?
                    .ok_or_else(|| "geo_dashboard_drilldown_not_found".to_string())?;
                Ok(json!({
                    "kind":"baseline-unit","baselineId":row.0,"operationId":row.1,
                    "sessionId":row.2,"unit":{
                        "id":request.id,"questionId":row.3,"question":row.4,"engineId":row.5,
                        "status":row.6,"rawAnswer":row.7,
                        "rawEvidence":json_or_parse_error(row.8),
                        "citations":json_or_parse_error(row.9),
                        "analysis":json_or_parse_error(row.10),
                        "startedAt":row.11,"finishedAt":row.12,
                        "errorCode":row.13,"errorMessage":row.14
                    }
                }))
            }
            "monitor-unit" => {
                let row = connection
                    .query_row(
                        "SELECT plan.id,plan.operation_id,plan.source_operation_id,
                                plan.created_by_session_id,unit.run_id,unit.kind,unit.status,
                                unit.question_id,unit.engine_id,unit.evidence_json,
                                unit.observed_at,unit.error_code,unit.error_message
                         FROM geo_post_publish_monitor_units unit
                         JOIN geo_post_publish_monitor_plans plan ON plan.id=unit.plan_id
                         WHERE unit.id=?1",
                        [&request.id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, String>(4)?,
                                row.get::<_, String>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, Option<String>>(7)?,
                                row.get::<_, Option<String>>(8)?,
                                row.get::<_, Option<String>>(9)?,
                                row.get::<_, Option<String>>(10)?,
                                row.get::<_, Option<String>>(11)?,
                                row.get::<_, Option<String>>(12)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("read dashboard monitor drilldown: {error}"))?
                    .ok_or_else(|| "geo_dashboard_drilldown_not_found".to_string())?;
                Ok(json!({
                    "kind":"monitor-unit","planId":row.0,"operationId":row.1,
                    "sourceOperationId":row.2,"sessionId":row.3,"runId":row.4,
                    "unit":{"id":request.id,"kind":row.5,"status":row.6,
                      "questionId":row.7,"engineId":row.8,
                      "evidence":json_or_parse_error(row.9),"observedAt":row.10,
                      "errorCode":row.11,"errorMessage":row.12}
                }))
            }
            "article" => {
                let row = connection
                    .query_row(
                        "SELECT article.operation_id,operation.created_by_session_id,
                                article.requested_title,article.status,article.revision,
                                article.approved_revision,version.approved_body_path,
                                version.body_sha256,article.created_at,article.updated_at,
                                version.title,version.approved_at
                         FROM geo_articles article
                         JOIN geo_article_operations operation ON operation.operation_id=article.operation_id
                         LEFT JOIN geo_article_versions version
                           ON version.article_id=article.id AND version.revision=article.approved_revision
                         WHERE article.id=?1",
                        [&request.id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, i64>(4)?,
                                row.get::<_, Option<i64>>(5)?,
                                row.get::<_, Option<String>>(6)?,
                                row.get::<_, Option<String>>(7)?,
                                row.get::<_, String>(8)?,
                                row.get::<_, String>(9)?,
                                row.get::<_, Option<String>>(10)?,
                                row.get::<_, Option<String>>(11)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("read dashboard article drilldown: {error}"))?
                    .ok_or_else(|| "geo_dashboard_drilldown_not_found".to_string())?;
                let cross_session = row.1 != session_id;
                if cross_session && row.5.is_none() {
                    return Err("geo_dashboard_drilldown_not_found".to_string());
                }
                let visible_title = if cross_session {
                    row.10.as_deref().unwrap_or(&row.2)
                } else {
                    &row.2
                };
                let visible_status = if cross_session { "approved" } else { &row.3 };
                let visible_revision = if cross_session {
                    row.5.unwrap_or(row.4)
                } else {
                    row.4
                };
                let visible_updated_at = if cross_session {
                    row.11.as_deref().unwrap_or(&row.8)
                } else {
                    &row.9
                };
                Ok(json!({
                    "kind":"article","operationId":row.0,"sessionId":row.1,
                    "article":{"id":request.id,"title":visible_title,"status":visible_status,
                      "revision":visible_revision,"approvedRevision":row.5,
                      "approvedBodyPath":row.6,"approvedBodySha256":row.7,
                      "createdAt":row.8,"updatedAt":visible_updated_at}
                }))
            }
            "publish-item" => {
                let row = connection
                    .query_row(
                        "SELECT execution.id,execution.operation_id,execution.created_by_session_id,
                                item.status,item.article_json,item.channel_json,item.scheduled_at,
                                item.external_request_sn,item.object_url,item.external_order_id,
                                item.external_content_id,item.request_summary_json,
                                item.started_at,item.finished_at,item.failure_code,item.failure_reason
                         FROM geo_publish_items item
                         JOIN geo_publish_executions execution ON execution.id=item.execution_id
                         WHERE item.id=?1",
                        [&request.id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?, row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?, row.get::<_, String>(3)?,
                                row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?,
                                row.get::<_, String>(6)?, row.get::<_, String>(7)?,
                                row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?,
                                row.get::<_, Option<String>>(10)?, row.get::<_, Option<String>>(11)?,
                                row.get::<_, Option<String>>(12)?, row.get::<_, Option<String>>(13)?,
                                row.get::<_, Option<String>>(14)?, row.get::<_, Option<String>>(15)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("read dashboard publish drilldown: {error}"))?
                    .ok_or_else(|| "geo_dashboard_drilldown_not_found".to_string())?;
                Ok(json!({
                    "kind":"publish-item","executionId":row.0,"operationId":row.1,
                    "sessionId":row.2,"item":{"id":request.id,"status":row.3,
                      "article":json_or_parse_error(row.4),"channel":json_or_parse_error(row.5),
                      "scheduledAt":row.6,"externalRequestSn":row.7,"objectUrl":row.8,
                      "externalOrderId":row.9,"externalContentId":row.10,
                      "requestSummary":json_or_parse_error(row.11),"startedAt":row.12,
                      "finishedAt":row.13,"failureCode":row.14,"failureReason":row.15}
                }))
            }
            "monitor-run" => {
                let run = connection
                    .query_row(
                        "SELECT plan.id,plan.operation_id,plan.source_operation_id,
                                plan.created_by_session_id,run.ordinal,run.scheduled_for_ms,
                                run.status,run.created_at,run.finished_at
                         FROM geo_post_publish_monitor_runs run
                         JOIN geo_post_publish_monitor_plans plan ON plan.id=run.plan_id
                         WHERE run.id=?1",
                        [&request.id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, String>(3)?,
                                row.get::<_, i64>(4)?,
                                row.get::<_, i64>(5)?,
                                row.get::<_, String>(6)?,
                                row.get::<_, String>(7)?,
                                row.get::<_, Option<String>>(8)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| format!("read dashboard monitor run: {error}"))?
                    .ok_or_else(|| "geo_dashboard_drilldown_not_found".to_string())?;
                let unit_count: i64 = connection
                    .query_row(
                        "SELECT COUNT(*) FROM geo_post_publish_monitor_units WHERE run_id=?1",
                        [&request.id],
                        |row| row.get(0),
                    )
                    .map_err(|error| format!("count dashboard run units: {error}"))?;
                let mut statement = connection
                    .prepare(
                        "SELECT id,kind,status,question_id,engine_id,
                                observed_at,error_code,error_message
                         FROM geo_post_publish_monitor_units WHERE run_id=?1
                         ORDER BY CASE kind WHEN 'publish-status' THEN 1
                                    WHEN 'access-indexing' THEN 2 ELSE 3 END,id
                         LIMIT ?2",
                    )
                    .map_err(|error| format!("prepare dashboard run units: {error}"))?;
                let units = statement
                    .query_map(rusqlite::params![&request.id, RUN_DRILLDOWN_UNIT_LIMIT], |row| {
                        Ok(json!({
                          "id":row.get::<_,String>(0)?,"kind":row.get::<_,String>(1)?,
                          "status":row.get::<_,String>(2)?,"questionId":row.get::<_,Option<String>>(3)?,
                          "engineId":row.get::<_,Option<String>>(4)?,
                          "observedAt":row.get::<_,Option<String>>(5)?,
                          "errorCode":row.get::<_,Option<String>>(6)?,
                          "errorMessage":row.get::<_,Option<String>>(7)?
                        }))
                    })
                    .map_err(|error| format!("read dashboard run units: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("collect dashboard run units: {error}"))?;
                Ok(json!({
                    "kind":"monitor-run","planId":run.0,"operationId":run.1,
                    "sourceOperationId":run.2,"sessionId":run.3,
                    "run":{"id":request.id,"ordinal":run.4,"scheduledFor":run.5,
                      "status":run.6,"createdAt":run.7,"finishedAt":run.8,
                      "unitCount":unit_count,"truncated":unit_count>RUN_DRILLDOWN_UNIT_LIMIT,
                      "units":units}
                }))
            }
            _ => Err("geo_dashboard_drilldown_kind_invalid".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{BrandWorkspace, SessionCommit, SessionTitleSource};
    use super::*;
    use rusqlite::params;
    use tempfile::tempdir;

    const T0: &str = "2026-01-01T00:00:00.000Z";
    const T1: &str = "2026-01-01T01:00:00.000Z";
    const T2: &str = "2026-01-01T02:00:00.000Z";

    struct Fixture {
        _temp: tempfile::TempDir,
        store: BrandWorkspaceStore,
        workspace: BrandWorkspace,
    }

    fn fixture(name: &str) -> Fixture {
        let temp = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(temp.path().join("xiaojing"));
        let workspace = store
            .create_workspace(name, vec!["产品".to_string()])
            .unwrap();
        for id in ["session-a", "session-b"] {
            store
                .commit_session(
                    &workspace.id,
                    SessionCommit {
                        id: id.to_string(),
                        title: id.to_string(),
                        title_source: SessionTitleSource::User,
                    },
                )
                .unwrap();
        }
        Fixture {
            _temp: temp,
            store,
            workspace,
        }
    }

    fn insert_operation(
        connection: &Connection,
        id: &str,
        session_id: &str,
        state: &str,
        created_at: &str,
    ) {
        connection
            .execute(
                "INSERT INTO geo_operations(id,session_id,state,created_at)
                 VALUES (?1,?2,?3,?4)",
                params![id, session_id, state, created_at],
            )
            .unwrap();
    }

    fn seed_baseline(connection: &Connection, baseline_mentioned: bool) {
        insert_operation(
            connection,
            "baseline-op",
            "session-a",
            "baseline-complete",
            T0,
        );
        connection
            .execute(
                "INSERT INTO geo_baselines(
                    id,operation_id,created_by_session_id,question_pool_id,
                    question_pool_revision,knowledge_version,brand_names_json,
                    provider_snapshots_json,policy_version,status,idempotency_key,
                    created_at,updated_at)
                 VALUES ('baseline','baseline-op','session-a','pool',1,1,
                    '[\"真实品牌\"]','[]','baseline-policy','succeeded','baseline-key',?1,?1)",
                [T0],
            )
            .unwrap();
        let analysis = json!({
            "brandMentioned": baseline_mentioned,
            "brandRecommended": false,
            "hasCitationEvidence": false
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO geo_baseline_units(
                    id,baseline_id,question_id,question_text,engine_id,
                    provider_snapshot_json,status,attempt_number,raw_answer,
                    raw_evidence_json,citations_json,analysis_json,finished_at)
                 VALUES ('baseline-unit','baseline','question-1','问题一','doubao',
                    '{\"engineId\":\"doubao\"}','succeeded',1,'BASELINE_BODY',
                    '{\"provider\":\"real-record\"}','[]',?1,?2)",
                params![analysis, T0],
            )
            .unwrap();
        // A nominal `succeeded` row with missing provider evidence is a parse/
        // integrity failure. It must be visible in completeness.failed and
        // must never enter a percentage denominator.
        connection
            .execute(
                "INSERT INTO geo_baseline_units(
                    id,baseline_id,question_id,question_text,engine_id,
                    provider_snapshot_json,status,attempt_number,raw_answer,
                    raw_evidence_json,citations_json,analysis_json,finished_at)
                 VALUES ('baseline-unit-invalid','baseline','question-2','问题二','doubao',
                    '{\"engineId\":\"doubao\"}','succeeded',1,'INVALID_BODY',
                    NULL,'[]','{\"brandMentioned\":true,\"brandRecommended\":true,
                    \"hasCitationEvidence\":true}',?1)",
                [T0],
            )
            .unwrap();
    }

    fn monitor_evidence(mentioned: bool, recommended: bool) -> String {
        json!({
            "rawAnswer": "MONITOR_BODY",
            "rawEvidence": {"provider": "real-record"},
            "citations": [{"url": "https://example.test/evidence"}],
            "analysis": {
                "brandMentioned": mentioned,
                "brandRecommended": recommended,
                "hasCitationEvidence": true
            }
        })
        .to_string()
    }

    fn seed_monitor(connection: &Connection) {
        insert_operation(connection, "monitor-op", "session-b", "monitor-active", T1);
        connection
            .execute(
                "INSERT INTO geo_post_publish_monitor_plans(
                    id,operation_id,source_operation_id,created_by_session_id,
                    publish_execution_id,baseline_id,baseline_policy_version,
                    baseline_question_pool_id,baseline_question_pool_revision,
                    engine_ids_json,interval_minutes,end_conditions_json,policy_version,
                    revision,status,schedule_id,run_count,created_at,updated_at,activated_at)
                 VALUES ('plan','monitor-op','baseline-op','session-b','publish-execution',
                    'baseline','baseline-policy','pool',1,'[\"doubao\"]',60,'{}',
                    'monitor-policy',1,'active','task',2,?1,?1,?1)",
                [T1],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_post_publish_monitor_questions(
                    plan_id,baseline_unit_id,question_id,question_text,engine_id,
                    provider_snapshot_json)
                 VALUES ('plan','baseline-unit','question-1','问题一','doubao','{}')",
                [],
            )
            .unwrap();
        for (run_id, ordinal, timestamp, recommended) in
            [("run-1", 1_i64, T1, true), ("run-2", 2_i64, T2, false)]
        {
            connection
                .execute(
                    "INSERT INTO geo_post_publish_monitor_runs(
                        id,plan_id,ordinal,scheduled_for_ms,status,created_at,finished_at)
                     VALUES (?1,'plan',?2,?3,'succeeded',?4,?4)",
                    params![run_id, ordinal, ordinal * 1_000, timestamp],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO geo_post_publish_monitor_units(
                        id,run_id,plan_id,kind,baseline_unit_id,question_id,engine_id,
                        payload_json,status,evidence_json,observed_at)
                     VALUES (?1,?2,'plan','baseline-probe','baseline-unit','question-1',
                        'doubao','{}','succeeded',?3,?4)",
                    params![
                        format!("monitor-unit-{ordinal}"),
                        run_id,
                        monitor_evidence(true, recommended),
                        timestamp
                    ],
                )
                .unwrap();
        }
    }

    fn seed_content(connection: &Connection) {
        insert_operation(
            connection,
            "article-op",
            "session-a",
            "article-generation-completed",
            T0,
        );
        connection
            .execute(
                "INSERT INTO geo_article_operations(
                    operation_id,created_by_session_id,source_kind,knowledge_version,
                    product_line,target_region,policy_version,operation_spec_json,status,
                    created_at,updated_at)
                 VALUES ('article-op','session-a','direct',1,'产品','中国','article-policy',
                    '{}','completed',?1,?1)",
                [T0],
            )
            .unwrap();
        for (id, title, status, approved_revision) in [
            ("article-approved", "已批准文章", "approved", Some(1_i64)),
            ("article-draft", "草稿文章", "draft_ready", None),
        ] {
            connection
                .execute(
                    "INSERT INTO geo_articles(
                        id,operation_id,knowledge_version,content_type,topic,requested_title,
                        constraints,planned_facts_json,status,revision,approved_revision,
                        generation_attempt,created_at,updated_at)
                     VALUES (?1,'article-op',1,'guide','真实主题',?2,'','[]',?3,1,?4,1,?5,?5)",
                    params![id, title, status, approved_revision, T0],
                )
                .unwrap();
        }
        insert_operation(
            connection,
            "publish-op",
            "session-a",
            "publish-submitted",
            T0,
        );
        connection
            .execute(
                "INSERT INTO geo_publish_executions(
                    id,operation_id,created_by_session_id,distribution_plan_id,
                    distribution_plan_revision,status,revision,budget_cny,estimated_spend_cny,
                    publish_start_at,confirmation_digest,provider_snapshot_json,created_at,updated_at)
                 VALUES ('publish-execution','publish-op','session-a','distribution',1,
                    'succeeded',1,10,5,?1,'digest','{}',?1,?1)",
                [T0],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_publish_items(
                    id,execution_id,sequence,revision,article_id,approved_revision,
                    approved_body_sha256,approved_body_path,article_json,channel_json,
                    scheduled_at,scheduled_at_ms,status,idempotency_key,external_request_sn,
                    payload_hash,object_key,object_url,external_order_id,request_summary_json)
                 VALUES ('publish-item','publish-execution',1,1,'article-approved',1,
                    'body-hash','articles/approved/article-approved/v1.md',
                    '{\"title\":\"已批准文章\"}','{\"name\":\"真实渠道\"}',?1,1,
                    'submitted','publish-key','request-sn','payload-hash','object-key',
                    'https://example.test/object','external-order','{}')",
                [T0],
            )
            .unwrap();
    }

    fn seed_full(fixture: &Fixture, baseline_mentioned: bool) {
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        seed_baseline(&connection, baseline_mentioned);
        seed_content(&connection);
        seed_monitor(&connection);
    }

    fn metric<'a>(projection: &'a GeoDashboardProjection, key: &str) -> &'a GeoDashboardMetric {
        projection
            .metrics
            .iter()
            .find(|metric| metric.key == key)
            .unwrap()
    }

    #[test]
    fn empty_workspace_accepts_product_engine_but_rejects_unknown_dimensions() {
        let fixture = fixture("空品牌");
        let projection = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-a",
                GeoDashboardGetRequest {
                    filters: GeoDashboardFilter {
                        engine_id: Some("doubao".to_string()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        assert_eq!(
            projection
                .dimensions
                .engines
                .iter()
                .map(|engine| engine.id.as_str())
                .collect::<Vec<_>>(),
            vec!["doubao"]
        );
        let mention = metric(&projection, "brand-mention");
        assert_eq!(mention.value, None);
        assert_eq!(mention.availability, "empty");
        assert_eq!(mention.sample_sufficiency, "none");
        assert_eq!(
            serde_json::to_value(mention).unwrap().get("delta"),
            Some(&Value::Null)
        );

        for (filters, expected) in [
            (
                GeoDashboardFilter {
                    engine_id: Some("qwen".to_string()),
                    ..Default::default()
                },
                "geo_dashboard_filter_engine_unknown",
            ),
            (
                GeoDashboardFilter {
                    session_id: Some("cross-brand-session".to_string()),
                    ..Default::default()
                },
                "geo_dashboard_filter_session_unknown",
            ),
            (
                GeoDashboardFilter {
                    operation_id: Some("cross-brand-operation".to_string()),
                    ..Default::default()
                },
                "geo_dashboard_filter_operation_unknown",
            ),
        ] {
            assert_eq!(
                fixture
                    .store
                    .get_geo_dashboard(
                        &fixture.workspace.id,
                        "session-a",
                        GeoDashboardGetRequest { filters },
                    )
                    .unwrap_err(),
                expected
            );
        }
    }

    #[test]
    fn aggregates_real_observations_with_stable_denominators_and_independent_quality_signals() {
        let fixture = fixture("聚合品牌");
        seed_full(&fixture, false);
        let projection = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardGetRequest::default(),
            )
            .unwrap();
        let mention = metric(&projection, "brand-mention");
        assert_eq!(
            (mention.numerator, mention.denominator, mention.value),
            (Some(2), Some(3), Some(67))
        );
        assert_eq!(
            mention.completeness,
            GeoDashboardCompleteness {
                successful: 3,
                failed: 1,
                pending: 0,
                total: 4
            }
        );
        assert_eq!(mention.availability, "partial");
        assert_eq!(mention.sample_sufficiency, "sufficient");
        assert!(mention.data_notes.iter().any(|note| note.contains("失败")));

        let question_coverage = metric(&projection, "question-coverage");
        assert_eq!(
            (
                question_coverage.numerator,
                question_coverage.denominator,
                question_coverage.value
            ),
            (Some(1), Some(2), Some(50))
        );
        assert_eq!(projection.trend.len(), 2);
        assert_eq!(metric(&projection, "monitor-change").delta, Some(0));

        let content = metric(&projection, "content-publish");
        assert_eq!(
            (content.numerator, content.denominator, content.value),
            (Some(1), Some(1), Some(100))
        );
        assert!(!content.engine_filter_applies);
        assert_eq!(
            projection.content_publish.articles_with_approved_revision,
            1
        );
        assert_eq!(projection.content_publish.submitted_items, 1);
        assert!(content
            .data_notes
            .iter()
            .any(|note| note.contains("不等于已发布")));

        let doubao = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardGetRequest {
                    filters: GeoDashboardFilter {
                        engine_id: Some("doubao".to_string()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        assert_eq!(metric(&doubao, "content-publish").value, Some(100));

        assert_eq!(
            fixture
                .store
                .get_geo_dashboard_drilldown(
                    &fixture.workspace.id,
                    "session-b",
                    GeoDashboardDrilldownRequest {
                        kind: "article".to_string(),
                        id: "article-draft".to_string(),
                    },
                )
                .unwrap_err(),
            "geo_dashboard_drilldown_not_found"
        );
        let shared_approved = fixture
            .store
            .get_geo_dashboard_drilldown(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardDrilldownRequest {
                    kind: "article".to_string(),
                    id: "article-approved".to_string(),
                },
            )
            .unwrap();
        assert_eq!(shared_approved["article"]["status"], "approved");
    }

    #[test]
    fn applies_half_open_utc_and_session_operation_lineage_filters() {
        let fixture = fixture("筛选品牌");
        seed_full(&fixture, false);
        let at_baseline_only = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardGetRequest {
                    filters: GeoDashboardFilter {
                        from: Some(T0.to_string()),
                        to_exclusive: Some(T1.to_string()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        let mention = metric(&at_baseline_only, "brand-mention");
        assert_eq!(
            (mention.numerator, mention.denominator, mention.value),
            (Some(0), Some(1), Some(0))
        );
        assert_eq!(mention.sample_sufficiency, "insufficient");
        assert_eq!(mention.availability, "partial");
        assert!(mention
            .data_notes
            .iter()
            .any(|note| note.contains("少于 3")));
        assert!(mention.data_notes.iter().any(|note| note.contains("失败")));

        let source_operation = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardGetRequest {
                    filters: GeoDashboardFilter {
                        operation_id: Some("baseline-op".to_string()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        // The source operation includes its baseline plus monitor plans whose
        // explicit source_operation_id points at it.
        assert_eq!(
            metric(&source_operation, "brand-mention")
                .completeness
                .total,
            4
        );
        assert_eq!(source_operation.trend.len(), 2);

        let session_a = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardGetRequest {
                    filters: GeoDashboardFilter {
                        session_id: Some("session-a".to_string()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        let session_b = fixture
            .store
            .get_geo_dashboard(
                &fixture.workspace.id,
                "session-a",
                GeoDashboardGetRequest {
                    filters: GeoDashboardFilter {
                        session_id: Some("session-b".to_string()),
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        assert_eq!(metric(&session_a, "brand-mention").completeness.total, 2);
        assert_eq!(metric(&session_b, "brand-mention").completeness.total, 2);
        // Session B can read Session A's approved artifact, but its draft is
        // excluded from both the denominator and drilldown surface.
        assert_eq!(metric(&session_a, "content-publish").value, Some(100));
    }

    #[test]
    fn exact_workspace_scope_isolates_identical_ids_across_two_brands() {
        let brand_a = fixture("品牌 A");
        let brand_b = fixture("品牌 B");
        seed_full(&brand_a, false);
        let connection_b = open_database(&brand_b.workspace).unwrap();
        connection_b
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        seed_baseline(&connection_b, true);

        let projection_a = brand_a
            .store
            .get_geo_dashboard(
                &brand_a.workspace.id,
                "session-a",
                GeoDashboardGetRequest::default(),
            )
            .unwrap();
        let projection_b = brand_b
            .store
            .get_geo_dashboard(
                &brand_b.workspace.id,
                "session-b",
                GeoDashboardGetRequest::default(),
            )
            .unwrap();
        assert_eq!(metric(&projection_a, "brand-mention").value, Some(67));
        assert_eq!(metric(&projection_b, "brand-mention").value, Some(100));
        assert_eq!(metric(&projection_b, "brand-mention").completeness.total, 2);

        let drilldown = brand_b
            .store
            .get_geo_dashboard_drilldown(
                &brand_b.workspace.id,
                "session-b",
                GeoDashboardDrilldownRequest {
                    kind: "baseline-unit".to_string(),
                    id: "baseline-unit".to_string(),
                },
            )
            .unwrap();
        assert_eq!(drilldown["unit"]["analysis"]["brandMentioned"], true);
    }

    #[test]
    fn monitor_run_drilldown_is_bounded_and_raw_evidence_requires_exact_unit() {
        let fixture = fixture("下钻品牌");
        seed_full(&fixture, false);
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection
            .execute(
                "INSERT INTO geo_post_publish_monitor_runs(
                    id,plan_id,ordinal,scheduled_for_ms,status,created_at,finished_at)
                 VALUES ('run-large','plan',3,3000,'succeeded',?1,?1)",
                [T2],
            )
            .unwrap();
        for index in 0..55_i64 {
            connection
                .execute(
                    "INSERT INTO geo_post_publish_monitor_units(
                        id,run_id,plan_id,kind,publish_item_id,payload_json,status,
                        evidence_json,observed_at)
                     VALUES (?1,'run-large','plan','access-indexing',?2,'{}','succeeded',?3,?4)",
                    params![
                        format!("large-unit-{index:02}"),
                        format!("publish-item-{index:02}"),
                        json!({"rawProviderResponse": format!("SECRET_RAW_{index:02}")})
                            .to_string(),
                        T2
                    ],
                )
                .unwrap();
        }
        drop(connection);

        let run = fixture
            .store
            .get_geo_dashboard_drilldown(
                &fixture.workspace.id,
                "session-a",
                GeoDashboardDrilldownRequest {
                    kind: "monitor-run".to_string(),
                    id: "run-large".to_string(),
                },
            )
            .unwrap();
        assert_eq!(run["run"]["unitCount"], 55);
        assert_eq!(run["run"]["truncated"], true);
        assert_eq!(run["run"]["units"].as_array().unwrap().len(), 50);
        assert!(!run.to_string().contains("SECRET_RAW"));

        let unit = fixture
            .store
            .get_geo_dashboard_drilldown(
                &fixture.workspace.id,
                "session-b",
                GeoDashboardDrilldownRequest {
                    kind: "monitor-unit".to_string(),
                    id: "large-unit-00".to_string(),
                },
            )
            .unwrap();
        assert_eq!(
            unit["unit"]["evidence"]["rawProviderResponse"],
            "SECRET_RAW_00"
        );
    }
}
