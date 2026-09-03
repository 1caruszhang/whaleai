use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::{open_database, BrandWorkspace, BrandWorkspaceStore};

/// 发布后监测策略版本戳（裁判：src/shared/geo/postPublishMonitoringContract.json，
/// ADR-0012 双侧 pin）：只钉当前值等值。WAKE_SCHEMA 是 Rust 单源常量，不入契约。
const POLICY_VERSION: &str = "xiaojing-post-publish-monitor-v1";
const WAKE_SCHEMA: &str = "xiaojing-geo-monitor-wake-v1";
const CLAIM_LEASE_MS: i64 = 5 * 60 * 1_000;
const RETRY_BACKOFF_MS: [i64; 3] = [60_000, 300_000, 900_000];
const MIN_INTERVAL_MINUTES: i64 = 15;
const MAX_INTERVAL_MINUTES: i64 = 30 * 24 * 60;
const RECENT_RUN_LIMIT: usize = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorPrepareRequest {
    pub publish_execution_id: String,
    pub baseline_id: String,
    pub engine_ids: Vec<String>,
    pub interval_minutes: i64,
    #[serde(default)]
    pub end_conditions: PostPublishMonitorEndConditions,
    #[serde(default)]
    pub plan_id: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorEndConditions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorActivateRequest {
    pub plan_id: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorRetryRequest {
    pub plan_id: String,
    pub unit_id: String,
    pub expected_unit_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorGetRequest {
    pub plan_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorWakeReference {
    pub schema: String,
    pub workspace_id: String,
    pub plan_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorAttemptProjection {
    attempt_number: i64,
    status: String,
    started_at: String,
    finished_at: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorUnitProjection {
    id: String,
    revision: i64,
    kind: String,
    status: String,
    attempt_number: i64,
    publish_item_id: Option<String>,
    baseline_unit_id: Option<String>,
    question_id: Option<String>,
    engine_id: Option<String>,
    observed_at: Option<String>,
    next_attempt_at: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    evidence: Option<Value>,
    attempts: Vec<PostPublishMonitorAttemptProjection>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorRunProjection {
    id: String,
    ordinal: i64,
    scheduled_for: String,
    status: String,
    units: Vec<PostPublishMonitorUnitProjection>,
    created_at: String,
    finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PostPublishMonitorPlanProjection {
    id: String,
    operation_id: String,
    source_operation_id: String,
    workspace_id: String,
    created_by_session_id: String,
    publish_execution_id: String,
    publish_item_ids: Vec<String>,
    baseline_id: String,
    baseline_policy_version: String,
    baseline_question_pool_id: String,
    baseline_question_pool_revision: i64,
    engine_ids: Vec<String>,
    interval_minutes: i64,
    end_conditions: PostPublishMonitorEndConditions,
    policy_version: &'static str,
    revision: i64,
    status: String,
    schedule_id: Option<String>,
    run_count: i64,
    next_run_at: Option<String>,
    recovery_state: String,
    latest_run: Option<PostPublishMonitorRunProjection>,
    recent_runs: Vec<PostPublishMonitorRunProjection>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct MonitorPlanContext {
    workspace_id: String,
    plan_id: String,
    source_session_id: String,
    schedule_id: String,
}

#[derive(Debug, Clone)]
struct ClaimedMonitorUnit {
    id: String,
    run_id: String,
    plan_id: String,
    kind: String,
    claim_token: String,
    source_session_id: String,
    schedule_id: String,
    payload: Value,
}

#[derive(Debug, Clone)]
struct MonitorProviderFailure {
    code: String,
    message: String,
    retryable: bool,
}

type MonitorFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, MonitorProviderFailure>> + Send + 'a>>;

trait PostPublishMonitorProvider: Send + Sync {
    fn observe<'a>(
        &'a self,
        workspace: &'a BrandWorkspace,
        unit: &'a ClaimedMonitorUnit,
    ) -> MonitorFuture<'a>;
}

type MonitorCompletionFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

trait PostPublishMonitorScheduleCompletion: Send + Sync {
    fn complete<'a>(&'a self, schedule_id: &'a str) -> MonitorCompletionFuture<'a>;
}

type MonitorPassHookFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

trait PostPublishMonitorPassHook: Send + Sync {
    fn after_pass<'a>(&'a self) -> MonitorPassHookFuture<'a>;
}

struct NoopPostPublishMonitorPassHook;

impl PostPublishMonitorPassHook for NoopPostPublishMonitorPassHook {
    fn after_pass<'a>(&'a self) -> MonitorPassHookFuture<'a> {
        Box::pin(async {})
    }
}

type MonitorBalanceProbeFuture<'a> =
    Pin<Box<dyn Future<Output = Result<bool, String>> + Send + 'a>>;

/// paused 计划的只读余额探测（票 14）：可用余额 ≥ 单问巡检价时返回
/// true（恢复巡检）；不可判定（余额不足、直连模式未配置、Sidecar 不可
/// 达）一律 false——保持暂停，绝不申请 permit、不扣点。
trait PostPublishMonitorBalanceProbe: Send + Sync {
    fn sufficient_for_patrol<'a>(
        &'a self,
        workspace: &'a BrandWorkspace,
        context: &'a MonitorPlanContext,
    ) -> MonitorBalanceProbeFuture<'a>;
}

struct ProductionPostPublishMonitorBalanceProbe;

impl PostPublishMonitorBalanceProbe for ProductionPostPublishMonitorBalanceProbe {
    fn sufficient_for_patrol<'a>(
        &'a self,
        workspace: &'a BrandWorkspace,
        context: &'a MonitorPlanContext,
    ) -> MonitorBalanceProbeFuture<'a> {
        Box::pin(async move {
            let result = monitor_sidecar_control_plane(
                workspace,
                &context.source_session_id,
                &context.schedule_id,
                "/api/xiaojing/post-publish-monitor/balance",
                json!({}),
            )
            .await
            .map_err(|failure| failure.message)?;
            Ok(result.get("sufficient").and_then(Value::as_bool) == Some(true))
        })
    }
}

struct ProductionPostPublishMonitorScheduleCompletion;

impl PostPublishMonitorScheduleCompletion for ProductionPostPublishMonitorScheduleCompletion {
    fn complete<'a>(&'a self, _schedule_id: &'a str) -> MonitorCompletionFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

#[derive(Debug, Clone)]
struct SupermediaOrderObservation {
    status_code: i64,
    status: &'static str,
    published_url: Option<String>,
    record: Value,
}

fn map_platform_status(code: i64) -> Option<&'static str> {
    match code {
        1 | 3 | 6 | 8 => Some("submitted"),
        4 | 10 | 11 => Some("published"),
        12 => Some("indexed"),
        2 | 5 | 7 | 9 => Some("rejected"),
        _ => None,
    }
}

fn indexing_state_from_platform(
    status_code: i64,
    published_at: Option<&str>,
    now_ms: i64,
) -> &'static str {
    if status_code == 12 {
        return "indexed";
    }
    if !matches!(status_code, 4 | 10 | 11) {
        return "unknown";
    }
    let Some(published_ms) = published_at
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
    else {
        return "unknown";
    };
    if now_ms.saturating_sub(published_ms) >= 12 * 60 * 60 * 1_000 {
        "not-indexed"
    } else {
        "unknown"
    }
}

fn real_published_page_target(
    status: &str,
    published_url: Option<&str>,
) -> Result<url::Url, MonitorProviderFailure> {
    if status == "rejected" {
        return Err(MonitorProviderFailure {
            code: "published-page-rejected".to_string(),
            message: "平台已明确拒绝该发布项，无法检查发布页".to_string(),
            retryable: false,
        });
    }
    if !matches!(status, "published" | "indexed") {
        return Err(MonitorProviderFailure {
            code: "published-page-pending".to_string(),
            message: "平台尚未发布该产物，真实发布页暂不可用".to_string(),
            retryable: true,
        });
    }
    let value = published_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| MonitorProviderFailure {
            code: "published-page-url-unavailable".to_string(),
            message: "平台已进入发布态但尚未返回真实发布页 URL".to_string(),
            retryable: true,
        })?;
    let parsed = url::Url::parse(value).map_err(|_| MonitorProviderFailure {
        code: "published-page-url-invalid".to_string(),
        message: "平台返回的真实发布页 URL 无效".to_string(),
        retryable: true,
    })?;
    if parsed.scheme() != "https" {
        return Err(MonitorProviderFailure {
            code: "published-page-url-insecure".to_string(),
            message: "平台返回的发布页不是 HTTPS URL".to_string(),
            retryable: false,
        });
    }
    Ok(parsed)
}

/// 监测查单（票 14 切网关）：Rust 经 Sidecar 控制面路由 → 网关
/// `/gw/distribution/{kind}/order/query` 重签查单（网关按查单对账驱动结转/
/// 退点）。sn 由 Sidecar 按 `distributionOrderSn(publishExecutionId,
/// publishItemId)` 派生——与票 08 下单同口径，冻结的 `externalRequestSn`
/// 只作审计引用，不参与查询；直连超级媒介凭据路径已随本票整体移除。
async fn query_gateway_supermedia_order(
    workspace: &BrandWorkspace,
    unit: &ClaimedMonitorUnit,
) -> Result<SupermediaOrderObservation, MonitorProviderFailure> {
    let channel_kind = unit
        .payload
        .get("channelKind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "media" | "we-media"))
        .ok_or_else(|| MonitorProviderFailure {
            code: "publish-channel-invalid".to_string(),
            message: "冻结的发布渠道类型无效".to_string(),
            retryable: false,
        })?
        .to_string();
    let publish_item_id = unit
        .payload
        .get("publishItemId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| MonitorProviderFailure {
            code: "publish-item-reference-missing".to_string(),
            message: "冻结的发布项编号缺失".to_string(),
            retryable: false,
        })?
        .to_string();
    let execution_id = monitor_publish_execution_id(workspace, &unit.plan_id)?;
    let result = call_monitor_sidecar(
        workspace,
        unit,
        "/api/xiaojing/post-publish-monitor/order-query",
        json!({
            "executionId": execution_id,
            "itemId": publish_item_id,
            "kind": channel_kind,
        }),
    )
    .await?;
    parse_gateway_order_observation(&result)
}

/// 计划冻结的发布执行 id 是网关 sn 派生口径的一半，权威在计划行而非
/// 单元 payload。
fn monitor_publish_execution_id(
    workspace: &BrandWorkspace,
    plan_id: &str,
) -> Result<String, MonitorProviderFailure> {
    let connection = open_database(workspace).map_err(|error| MonitorProviderFailure {
        code: "monitor-evidence-store-unavailable".to_string(),
        message: bounded_error(error),
        retryable: true,
    })?;
    connection
        .query_row(
            "SELECT publish_execution_id FROM geo_post_publish_monitor_plans WHERE id=?1",
            [plan_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| MonitorProviderFailure {
            code: "monitor-evidence-read-failed".to_string(),
            message: bounded_error(error),
            retryable: true,
        })?
        .ok_or_else(|| MonitorProviderFailure {
            code: "monitor-plan-reference-missing".to_string(),
            message: "监测计划已不存在，无法派生查单 sn".to_string(),
            retryable: false,
        })
}

/// 把查单路由的 typed 结果映射为监测观察。record 为 null 表示网关尚未
/// 观察到该 sn（可重试）；状态码缺失/未知沿用直连时代的错误语义。
fn parse_gateway_order_observation(
    result: &Value,
) -> Result<SupermediaOrderObservation, MonitorProviderFailure> {
    let record = result.get("record").cloned().unwrap_or(Value::Null);
    let status_code = record
        .get("status")
        .and_then(Value::as_i64)
        .ok_or_else(|| MonitorProviderFailure {
            code: "distribution-order-unavailable".to_string(),
            message: "超级媒介尚未返回该稳定发布项".to_string(),
            retryable: true,
        })?;
    let status = map_platform_status(status_code).ok_or_else(|| MonitorProviderFailure {
        code: "distribution-order-status-unknown".to_string(),
        message: format!("超级媒介返回未知订单状态 {status_code}"),
        retryable: true,
    })?;
    let published_url = record
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Ok(SupermediaOrderObservation {
        status_code,
        status,
        published_url,
        record,
    })
}

struct ProductionPostPublishMonitorProvider;

impl PostPublishMonitorProvider for ProductionPostPublishMonitorProvider {
    fn observe<'a>(
        &'a self,
        workspace: &'a BrandWorkspace,
        unit: &'a ClaimedMonitorUnit,
    ) -> MonitorFuture<'a> {
        Box::pin(async move {
            match unit.kind.as_str() {
                "publish-status" => {
                    let observed = query_gateway_supermedia_order(workspace, unit).await?;
                    Ok(json!({
                        "platformStatusCode": observed.status_code,
                        "platformStatus": observed.status,
                        "externalOrderId": unit.payload.get("externalOrderId"),
                        "externalRequestSn": unit.payload.get("externalRequestSn"),
                        "publishedUrl": observed.published_url,
                        "rawEvidence": observed.record,
                    }))
                }
                "access-indexing" => {
                    let observed = query_gateway_supermedia_order(workspace, unit).await?;
                    let parsed = real_published_page_target(
                        observed.status,
                        observed.published_url.as_deref(),
                    )?;
                    let page = call_monitor_sidecar(
                        workspace,
                        unit,
                        "/api/xiaojing/post-publish-monitor/access-check",
                        json!({"url": parsed.as_str()}),
                    )
                    .await?;
                    let published_url =
                        page.get("url").and_then(Value::as_str).ok_or_else(|| {
                            MonitorProviderFailure {
                                code: "published-page-evidence-missing".to_string(),
                                message: "真实发布页检查未返回最终 URL".to_string(),
                                retryable: true,
                            }
                        })?;
                    let http_status =
                        page.get("httpStatus")
                            .and_then(Value::as_u64)
                            .ok_or_else(|| MonitorProviderFailure {
                                code: "published-page-evidence-missing".to_string(),
                                message: "真实发布页检查未返回 HTTP 状态".to_string(),
                                retryable: true,
                            })?;
                    Ok(json!({
                        "url": published_url,
                        "httpStatus": http_status,
                        "accessible": true,
                        "indexingState": indexing_state_from_platform(
                            observed.status_code,
                            observed.record.get("publishedAt").and_then(Value::as_str),
                            Utc::now().timestamp_millis(),
                        ),
                        "platformStatusCode": observed.status_code,
                        "rawEvidence": { "platform": observed.record, "access": page },
                    }))
                }
                "baseline-probe" => observe_baseline_probe(workspace, unit).await,
                _ => Err(MonitorProviderFailure {
                    code: "monitor-unit-kind-invalid".to_string(),
                    message: "未知监测单元类型".to_string(),
                    retryable: false,
                }),
            }
        })
    }
}

fn published_articles_for_run(
    workspace: &BrandWorkspace,
    run_id: &str,
) -> Result<Vec<Value>, MonitorProviderFailure> {
    let connection = open_database(workspace).map_err(|error| MonitorProviderFailure {
        code: "monitor-evidence-store-unavailable".to_string(),
        message: bounded_error(error),
        retryable: true,
    })?;
    let mut statement = connection
        .prepare(
            "SELECT item.article_id,unit.evidence_json
             FROM geo_post_publish_monitor_units unit
             JOIN geo_post_publish_monitor_items item
               ON item.plan_id=unit.plan_id AND item.publish_item_id=unit.publish_item_id
             WHERE unit.run_id=?1 AND unit.kind='publish-status' AND unit.status='succeeded'
             ORDER BY item.article_id,unit.id",
        )
        .map_err(|error| MonitorProviderFailure {
            code: "monitor-evidence-read-failed".to_string(),
            message: bounded_error(error),
            retryable: true,
        })?;
    let rows = statement
        .query_map([run_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| MonitorProviderFailure {
            code: "monitor-evidence-read-failed".to_string(),
            message: bounded_error(error),
            retryable: true,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| MonitorProviderFailure {
            code: "monitor-evidence-read-failed".to_string(),
            message: bounded_error(error),
            retryable: true,
        })?;
    Ok(rows
        .into_iter()
        .filter_map(|(article_id, evidence)| {
            serde_json::from_str::<Value>(&evidence)
                .ok()
                .and_then(|value| {
                    value
                        .get("publishedUrl")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .and_then(|url| {
                    url::Url::parse(&url)
                        .ok()
                        .filter(|parsed| parsed.scheme() == "https")
                        .map(|_| json!({"articleId": article_id, "url": url}))
                })
        })
        .collect())
}

async fn observe_baseline_probe(
    workspace: &BrandWorkspace,
    unit: &ClaimedMonitorUnit,
) -> Result<Value, MonitorProviderFailure> {
    let mut input = unit.payload.clone();
    let published_articles = published_articles_for_run(workspace, &unit.run_id)?;
    input["publishedArticles"] = Value::Array(published_articles);
    let source_provider_snapshot =
        input
            .get("sourceProviderSnapshot")
            .cloned()
            .ok_or_else(|| MonitorProviderFailure {
                code: "monitor-source-provider-snapshot-missing".to_string(),
                message: "Ticket 09 baseline Provider snapshot 缺失".to_string(),
                retryable: false,
            })?;
    let result = call_monitor_sidecar(
        workspace,
        unit,
        "/api/xiaojing/post-publish-monitor/baseline-probe",
        json!({"input": input}),
    )
    .await?;
    let mut evidence = result
        .get("evidence")
        .cloned()
        .ok_or_else(|| MonitorProviderFailure {
            code: "monitor-probe-evidence-missing".to_string(),
            message: "baseline 复测未返回 typed evidence".to_string(),
            retryable: true,
        })?;
    let actual_provider_snapshot =
        result
            .get("providerSnapshot")
            .cloned()
            .ok_or_else(|| MonitorProviderFailure {
                code: "monitor-probe-provider-snapshot-missing".to_string(),
                message: "baseline 复测未返回实际 Provider snapshot".to_string(),
                retryable: true,
            })?;
    evidence["sourceProviderSnapshot"] = source_provider_snapshot;
    evidence["providerSnapshot"] = actual_provider_snapshot;
    Ok(evidence)
}

async fn call_monitor_sidecar(
    workspace: &BrandWorkspace,
    unit: &ClaimedMonitorUnit,
    endpoint: &str,
    payload: Value,
) -> Result<Value, MonitorProviderFailure> {
    monitor_sidecar_control_plane(
        workspace,
        &unit.source_session_id,
        &unit.schedule_id,
        endpoint,
        payload,
    )
    .await
}

/// 附着 `GeoMonitor(schedule_id)` owner 的 Session Sidecar 控制面调用：
/// 单元观察（baseline-probe/access-check/order-query）与 paused 计划的
/// 只读余额探测共用。请求体统一注入 workspaceId/sessionId 身份。
async fn monitor_sidecar_control_plane(
    workspace: &BrandWorkspace,
    source_session_id: &str,
    schedule_id: &str,
    endpoint: &str,
    payload: Value,
) -> Result<Value, MonitorProviderFailure> {
    let app = crate::logger::get_app_handle()
        .cloned()
        .ok_or_else(|| MonitorProviderFailure {
            code: "monitor-app-owner-unavailable".to_string(),
            message: "应用生命周期 owner 尚未就绪".to_string(),
            retryable: true,
        })?;
    let manager = app
        .try_state::<crate::sidecar::ManagedSidecarManager>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| MonitorProviderFailure {
            code: "monitor-sidecar-manager-unavailable".to_string(),
            message: "Session Sidecar 管理器不可用".to_string(),
            retryable: true,
        })?;
    let owner = crate::sidecar::SidecarOwner::GeoMonitor(schedule_id.to_string());
    let ensure = crate::sidecar::ensure_session_sidecar_with_lifecycle(
        app.clone(),
        manager.clone(),
        source_session_id.to_string(),
        workspace.root_path.clone(),
        owner.clone(),
    )
    .await
    .map_err(|error| MonitorProviderFailure {
        code: "monitor-sidecar-unavailable".to_string(),
        message: bounded_error(error),
        retryable: true,
    })?;
    let request_result = async {
        let mut body = payload.as_object().cloned().unwrap_or_default();
        body.insert(
            "workspaceId".to_string(),
            Value::String(workspace.id.clone()),
        );
        body.insert(
            "sessionId".to_string(),
            Value::String(source_session_id.to_string()),
        );
        let client = crate::local_http::builder()
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|error| MonitorProviderFailure {
                code: "monitor-probe-client-unavailable".to_string(),
                message: bounded_error(error),
                retryable: true,
            })?;
        // 监测单元可能在计划排期数小时后才执行：附当前新鲜账号 token
        // （临期自动 refresh），Sidecar 调网关优先于 admission env；未登录
        // 不附头，Sidecar 回退 env。
        let request = crate::account_auth::with_fresh_account_token(
            client
                .post(format!("http://127.0.0.1:{}{}", ensure.port, endpoint))
                .json(&Value::Object(body)),
        )
        .await;
        let response = request
            .send()
            .await
            .map_err(|error| MonitorProviderFailure {
                code: "monitor-sidecar-transport".to_string(),
                message: bounded_error(error),
                retryable: true,
            })?;
        let status = response.status();
        let envelope = response
            .json::<Value>()
            .await
            .map_err(|error| MonitorProviderFailure {
                code: "monitor-sidecar-response-invalid".to_string(),
                message: bounded_error(error),
                retryable: true,
            })?;
        if !status.is_success() || envelope.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(MonitorProviderFailure {
                code: envelope
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("monitor-sidecar-request-failed")
                    .to_string(),
                message: envelope
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("monitor Sidecar request failed")
                    .to_string(),
                retryable: status.is_server_error() || status.as_u16() == 429,
            });
        }
        envelope
            .get("result")
            .cloned()
            .ok_or_else(|| MonitorProviderFailure {
                code: "monitor-sidecar-result-missing".to_string(),
                message: "monitor Sidecar response result 缺失".to_string(),
                retryable: true,
            })
    }
    .await;
    if let Err(error) = crate::sidecar::release_session_sidecar(&manager, source_session_id, &owner)
    {
        crate::ulog_warn!(
            "[post-publish-monitor] release probe Sidecar owner schedule={}: {}",
            schedule_id,
            bounded_error(error)
        );
    }
    request_result
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS geo_post_publish_monitor_plans (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL UNIQUE REFERENCES geo_operations(id),
                source_operation_id TEXT NOT NULL REFERENCES geo_operations(id),
                created_by_session_id TEXT NOT NULL,
                publish_execution_id TEXT NOT NULL REFERENCES geo_publish_executions(id),
                baseline_id TEXT NOT NULL REFERENCES geo_baselines(id),
                baseline_policy_version TEXT NOT NULL,
                baseline_question_pool_id TEXT NOT NULL,
                baseline_question_pool_revision INTEGER NOT NULL,
                engine_ids_json TEXT NOT NULL,
                interval_minutes INTEGER NOT NULL,
                end_conditions_json TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                revision INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('draft','active','paused','completed','provisioning-failed')),
                schedule_id TEXT,
                run_count INTEGER NOT NULL DEFAULT 0,
                next_run_at_ms INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                activated_at TEXT,
                completed_at TEXT
             );
             CREATE INDEX IF NOT EXISTS geo_monitor_plan_latest
                ON geo_post_publish_monitor_plans(updated_at DESC, id DESC);
             CREATE TABLE IF NOT EXISTS geo_post_publish_monitor_items (
                plan_id TEXT NOT NULL REFERENCES geo_post_publish_monitor_plans(id),
                publish_item_id TEXT NOT NULL REFERENCES geo_publish_items(id),
                article_id TEXT NOT NULL,
                channel_kind TEXT NOT NULL,
                external_request_sn TEXT NOT NULL,
                external_order_id TEXT NOT NULL,
                external_content_id TEXT,
                idempotency_key TEXT NOT NULL,
                object_url TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                PRIMARY KEY(plan_id, publish_item_id)
             );
             CREATE TABLE IF NOT EXISTS geo_post_publish_monitor_questions (
                plan_id TEXT NOT NULL REFERENCES geo_post_publish_monitor_plans(id),
                baseline_unit_id TEXT NOT NULL,
                question_id TEXT NOT NULL,
                question_text TEXT NOT NULL,
                engine_id TEXT NOT NULL,
                provider_snapshot_json TEXT NOT NULL,
                PRIMARY KEY(plan_id, baseline_unit_id)
             );
             CREATE TABLE IF NOT EXISTS geo_post_publish_monitor_runs (
                id TEXT PRIMARY KEY,
                plan_id TEXT NOT NULL REFERENCES geo_post_publish_monitor_plans(id),
                ordinal INTEGER NOT NULL,
                scheduled_for_ms INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('running','succeeded','partial','failed')),
                created_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(plan_id, scheduled_for_ms),
                UNIQUE(plan_id, ordinal)
             );
             CREATE TABLE IF NOT EXISTS geo_post_publish_monitor_units (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES geo_post_publish_monitor_runs(id),
                plan_id TEXT NOT NULL REFERENCES geo_post_publish_monitor_plans(id),
                kind TEXT NOT NULL CHECK(kind IN ('publish-status','access-indexing','baseline-probe')),
                publish_item_id TEXT,
                baseline_unit_id TEXT,
                question_id TEXT,
                engine_id TEXT,
                payload_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','running','succeeded','failed')),
                revision INTEGER NOT NULL DEFAULT 1,
                attempt_number INTEGER NOT NULL DEFAULT 0,
                claim_token TEXT,
                lease_until_ms INTEGER,
                next_attempt_at_ms INTEGER,
                evidence_json TEXT,
                observed_at TEXT,
                error_code TEXT,
                error_message TEXT,
                UNIQUE(run_id, kind, publish_item_id, baseline_unit_id)
             );
             CREATE INDEX IF NOT EXISTS geo_monitor_due_units
                ON geo_post_publish_monitor_units(plan_id, status, next_attempt_at_ms, lease_until_ms);
             CREATE TABLE IF NOT EXISTS geo_post_publish_monitor_attempts (
                unit_id TEXT NOT NULL REFERENCES geo_post_publish_monitor_units(id),
                attempt_number INTEGER NOT NULL,
                claim_token TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
                started_at TEXT NOT NULL,
                finished_at TEXT,
                error_code TEXT,
                error_message TEXT,
                PRIMARY KEY(unit_id, attempt_number)
             );",
        )
        .map_err(|error| format!("initialize post-publish monitoring schema: {error}"))?;
    widen_monitor_plan_status_check(connection)?;
    super::drop_brand_sessions_foreign_keys(connection, &["geo_post_publish_monitor_plans"])
}

/// 票 14 为监测计划状态机加入 `paused`（余额不足自动暂停）。既有数据库
/// 的 CHECK 约束不含该值，SQLite 无法就地修改 CHECK——沿用 brand_workspace
/// 的表重建迁移（foreign_keys=OFF 包裹；索引随 DROP TABLE 消失，按
/// sqlite_master 原文重建）。已含 `paused` 或尚未建表的库是幂等 no-op。
fn widen_monitor_plan_status_check(connection: &Connection) -> Result<(), String> {
    const LEGACY_STATUS_CHECK: &str = "('draft','active','completed','provisioning-failed')";
    const WIDENED_STATUS_CHECK: &str =
        "('draft','active','paused','completed','provisioning-failed')";
    let table = "geo_post_publish_monitor_plans";
    let existing: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .map_err(|error| format!("inspect {table} status check: {error}"))?;
    let Some(existing_sql) = existing else {
        return Ok(());
    };
    if !existing_sql.contains(LEGACY_STATUS_CHECK) {
        return Ok(());
    }
    let mut index_ddls: Vec<String> = Vec::new();
    {
        let mut statement = connection
            .prepare(
                "SELECT sql FROM sqlite_master
                 WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL",
            )
            .map_err(|error| format!("list {table} indexes: {error}"))?;
        let mut rows = statement
            .query([table])
            .map_err(|error| format!("read {table} indexes: {error}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("advance {table} index cursor: {error}"))?
        {
            index_ddls.push(
                row.get(0)
                    .map_err(|error| format!("read {table} index ddl: {error}"))?,
            );
        }
    }
    let rebuilt_sql = existing_sql.replace(LEGACY_STATUS_CHECK, WIDENED_STATUS_CHECK);
    let renamed_sql =
        super::rename_table_in_ddl(&rebuilt_sql, table, &format!("{table}__status_widened"))?;
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .map_err(|error| format!("unlock {table} status check rebuild: {error}"))?;
    let rebuild = connection.execute_batch(&format!(
        "BEGIN IMMEDIATE;
         {renamed_sql};
         INSERT INTO {table}__status_widened SELECT * FROM {table};
         DROP TABLE {table};
         ALTER TABLE {table}__status_widened RENAME TO {table};
         {}
         COMMIT;",
        index_ddls
            .iter()
            .map(|ddl| format!("{ddl};"))
            .collect::<Vec<_>>()
            .join("\n")
    ));
    let restored = connection.execute_batch("PRAGMA foreign_keys = ON;");
    match (rebuild, restored) {
        (Ok(()), Ok(())) => Ok(()),
        (rebuild, _) => {
            let _ = connection.execute_batch("ROLLBACK;");
            rebuild.map_err(|error| format!("rebuild {table} with widened status check: {error}"))
        }
    }
}

fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

fn stable_id(prefix: &str, value: &str) -> String {
    format!("{prefix}-{}", &digest(value)[..32])
}

fn now_iso(now_ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn iso_from_ms(value: Option<i64>) -> Option<String> {
    value.map(now_iso)
}

fn bounded_error(value: impl ToString) -> String {
    value
        .to_string()
        .replace("Bearer ", "Bearer [REDACTED] ")
        .chars()
        .take(500)
        .collect()
}

fn validate_prepare(request: &PostPublishMonitorPrepareRequest, now_ms: i64) -> Result<(), String> {
    if request.publish_execution_id.trim().is_empty() || request.baseline_id.trim().is_empty() {
        return Err("post_publish_monitor_exact_source_required".to_string());
    }
    if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&request.interval_minutes) {
        return Err("post_publish_monitor_interval_invalid".to_string());
    }
    if request.engine_ids.is_empty()
        || request
            .engine_ids
            .iter()
            .any(|engine| engine.as_str() != "doubao")
    {
        return Err("post_publish_monitor_engine_invalid".to_string());
    }
    if request
        .end_conditions
        .deadline
        .is_some_and(|deadline| deadline <= now_ms)
        || request
            .end_conditions
            .max_runs
            .is_some_and(|runs| runs <= 0 || runs > 10_000)
    {
        return Err("post_publish_monitor_end_condition_invalid".to_string());
    }
    if request.end_conditions.deadline.is_none() && request.end_conditions.max_runs.is_none() {
        return Err("post_publish_monitor_end_condition_required".to_string());
    }
    Ok(())
}

fn require_monitor_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM brand_sessions WHERE id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("verify monitoring session: {error}"))?;
    exists
        .then_some(())
        .ok_or_else(|| "post_publish_monitor_session_not_found".to_string())
}

impl BrandWorkspaceStore {
    pub fn prepare_post_publish_monitor_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PostPublishMonitorPrepareRequest,
        now_ms: i64,
    ) -> Result<PostPublishMonitorPlanProjection, String> {
        validate_prepare(&request, now_ms)?;
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_monitor_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("prepare monitoring plan transaction: {error}"))?;

        if let Some(plan_id) = request.plan_id.as_deref() {
            let (revision, status): (i64, String) = transaction
                .query_row(
                    "SELECT revision,status FROM geo_post_publish_monitor_plans WHERE id=?1",
                    [plan_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| format!("read editable monitoring plan: {error}"))?
                .ok_or_else(|| "post_publish_monitor_plan_not_found".to_string())?;
            if status != "draft" {
                return Err("post_publish_monitor_active_plan_immutable".to_string());
            }
            if request.expected_revision != Some(revision) {
                return Err("post_publish_monitor_revision_conflict".to_string());
            }
            transaction
                .execute(
                    "DELETE FROM geo_post_publish_monitor_items WHERE plan_id=?1",
                    [plan_id],
                )
                .map_err(|error| format!("replace monitoring item snapshot: {error}"))?;
            transaction
                .execute(
                    "DELETE FROM geo_post_publish_monitor_questions WHERE plan_id=?1",
                    [plan_id],
                )
                .map_err(|error| format!("replace monitoring question snapshot: {error}"))?;
        }

        let source_operation_id: String = transaction
            .query_row(
                "SELECT operation_id,created_by_session_id FROM geo_publish_executions WHERE id=?1",
                [&request.publish_execution_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read monitoring publish execution: {error}"))?
            .ok_or_else(|| "post_publish_monitor_publish_execution_not_found".to_string())?;
        let mut item_statement = transaction
            .prepare(
                "SELECT item.id,item.article_id,json_extract(item.channel_json,'$.kind'),
                        item.external_request_sn,item.external_order_id,item.external_content_id,
                        item.idempotency_key,COALESCE(item.object_url,json_extract(item.request_summary_json,'$.plannedObjectUrl')),
                        item.article_json,item.channel_json
                 FROM geo_publish_items item
                 WHERE item.execution_id=?1 AND item.status='submitted'
                   AND item.external_order_id IS NOT NULL
                 ORDER BY item.sequence,item.id",
            )
            .map_err(|error| format!("prepare submitted publish items: {error}"))?;
        let publish_items = item_statement
            .query_map([&request.publish_execution_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|error| format!("read submitted publish items: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect submitted publish items: {error}"))?;
        drop(item_statement);
        if publish_items.is_empty() {
            return Err("post_publish_monitor_submitted_item_required".to_string());
        }
        if publish_items.iter().any(|item| {
            url::Url::parse(&item.7)
                .ok()
                .is_none_or(|url| url.scheme() != "https")
        }) {
            return Err("post_publish_monitor_object_url_invalid".to_string());
        }

        let (baseline_policy, question_pool_id, question_pool_revision, brand_names_json, competitors_json): (
            String,
            String,
            i64,
            String,
            String,
        ) = transaction
            .query_row(
                "SELECT policy_version,question_pool_id,question_pool_revision,brand_names_json,competitors_json
                 FROM geo_baselines WHERE id=?1",
                [&request.baseline_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()
            .map_err(|error| format!("read monitoring baseline: {error}"))?
            .ok_or_else(|| "post_publish_monitor_baseline_not_found".to_string())?;
        let selected_engines = request
            .engine_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let mut question_statement = transaction
            .prepare(
                "SELECT id,question_id,question_text,engine_id,provider_snapshot_json
                 FROM geo_baseline_units
                 WHERE baseline_id=?1 AND status='succeeded'
                 ORDER BY question_id,engine_id,id",
            )
            .map_err(|error| format!("prepare monitoring baseline questions: {error}"))?;
        let questions = question_statement
            .query_map([&request.baseline_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| format!("read monitoring baseline questions: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect monitoring baseline questions: {error}"))?
            .into_iter()
            .filter(|question| selected_engines.contains(question.3.as_str()))
            .collect::<Vec<_>>();
        drop(question_statement);
        if questions.is_empty() {
            return Err("post_publish_monitor_successful_baseline_unit_required".to_string());
        }

        let existing_plan_id = request.plan_id.clone();
        let sequence: i64 = transaction
            .query_row(
                "SELECT COUNT(*)+1 FROM geo_post_publish_monitor_plans",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("allocate monitoring plan sequence: {error}"))?;
        let plan_id = existing_plan_id.unwrap_or_else(|| {
            stable_id(
                "monitor-plan",
                &format!(
                    "{workspace_id}|{}|{}|{sequence}",
                    request.publish_execution_id, request.baseline_id
                ),
            )
        });
        let operation_id = stable_id("geo-operation-monitor", &plan_id);
        let now = now_iso(now_ms);
        let next_run_at_ms = now_ms.saturating_add(request.interval_minutes * 60_000);
        let end_conditions_json = serde_json::to_string(&request.end_conditions)
            .map_err(|error| format!("serialize monitoring end conditions: {error}"))?;
        let engine_ids_json = serde_json::to_string(&request.engine_ids)
            .map_err(|error| format!("serialize monitoring engines: {error}"))?;
        let revision = if request.plan_id.is_some() {
            transaction
                .execute(
                    "UPDATE geo_post_publish_monitor_plans
                     SET source_operation_id=?2,publish_execution_id=?3,baseline_id=?4,
                         baseline_policy_version=?5,baseline_question_pool_id=?6,
                         baseline_question_pool_revision=?7,engine_ids_json=?8,
                         interval_minutes=?9,end_conditions_json=?10,revision=revision+1,
                         next_run_at_ms=?11,updated_at=?12
                     WHERE id=?1 AND status='draft'",
                    params![
                        plan_id,
                        source_operation_id,
                        request.publish_execution_id,
                        request.baseline_id,
                        baseline_policy,
                        question_pool_id,
                        question_pool_revision,
                        engine_ids_json,
                        request.interval_minutes,
                        end_conditions_json,
                        next_run_at_ms,
                        now,
                    ],
                )
                .map_err(|error| format!("update monitoring plan: {error}"))?;
            request.expected_revision.unwrap_or(0) + 1
        } else {
            transaction
                .execute(
                    "INSERT INTO geo_operations(id,session_id,state,created_at)
                     VALUES (?1,?2,'monitor-draft',?3)",
                    params![operation_id, session_id, now],
                )
                .map_err(|error| format!("create monitoring operation: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO geo_post_publish_monitor_plans(
                        id,operation_id,source_operation_id,created_by_session_id,
                        publish_execution_id,baseline_id,baseline_policy_version,
                        baseline_question_pool_id,baseline_question_pool_revision,
                        engine_ids_json,interval_minutes,end_conditions_json,policy_version,
                        revision,status,schedule_id,run_count,next_run_at_ms,
                        created_at,updated_at,activated_at,completed_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,
                             1,'draft',NULL,0,?14,?15,?15,NULL,NULL)",
                    params![
                        plan_id,
                        operation_id,
                        source_operation_id,
                        session_id,
                        request.publish_execution_id,
                        request.baseline_id,
                        baseline_policy,
                        question_pool_id,
                        question_pool_revision,
                        engine_ids_json,
                        request.interval_minutes,
                        end_conditions_json,
                        POLICY_VERSION,
                        next_run_at_ms,
                        now,
                    ],
                )
                .map_err(|error| format!("insert monitoring plan: {error}"))?;
            1
        };

        for item in &publish_items {
            let snapshot = json!({
                "article": serde_json::from_str::<Value>(&item.8).unwrap_or(Value::Null),
                "channel": serde_json::from_str::<Value>(&item.9).unwrap_or(Value::Null),
                "brandNames": serde_json::from_str::<Value>(&brand_names_json).unwrap_or(json!([])),
                "competitorNames": serde_json::from_str::<Value>(&competitors_json).unwrap_or(json!([])),
            });
            transaction
                .execute(
                    "INSERT INTO geo_post_publish_monitor_items(
                        plan_id,publish_item_id,article_id,channel_kind,external_request_sn,
                        external_order_id,external_content_id,idempotency_key,object_url,snapshot_json)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    params![
                        plan_id, item.0, item.1, item.2, item.3, item.4, item.5, item.6,
                        item.7, snapshot.to_string(),
                    ],
                )
                .map_err(|error| format!("freeze monitoring publish item: {error}"))?;
        }
        for question in &questions {
            transaction
                .execute(
                    "INSERT INTO geo_post_publish_monitor_questions(
                        plan_id,baseline_unit_id,question_id,question_text,engine_id,provider_snapshot_json)
                     VALUES (?1,?2,?3,?4,?5,?6)",
                    params![plan_id, question.0, question.1, question.2, question.3, question.4],
                )
                .map_err(|error| format!("freeze monitoring baseline question: {error}"))?;
        }
        transaction
            .commit()
            .map_err(|error| format!("commit monitoring plan: {error}"))?;
        let projection = read_plan(&connection, workspace_id, &plan_id, now_ms)?;
        debug_assert_eq!(projection.revision, revision);
        Ok(projection)
    }

    pub fn latest_post_publish_monitor_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        now_ms: i64,
    ) -> Result<Option<PostPublishMonitorPlanProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_monitor_session(&connection, session_id)?;
        let id = connection
            .query_row(
                "SELECT id FROM geo_post_publish_monitor_plans ORDER BY updated_at DESC,id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest monitoring plan: {error}"))?;
        id.map(|id| read_plan(&connection, workspace_id, &id, now_ms))
            .transpose()
    }

    pub fn get_post_publish_monitor_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PostPublishMonitorGetRequest,
        now_ms: i64,
    ) -> Result<PostPublishMonitorPlanProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        require_monitor_session(&connection, session_id)?;
        read_plan(&connection, workspace_id, &request.plan_id, now_ms)
    }

    /// Session-free projection reads for the WebView's brand-level 「效果」 page.
    /// The latest query is workspace-wide; prepare/activate/retry keep their
    /// brand_sessions existence gate because they record a source session.
    pub fn latest_post_publish_monitor_plan_readonly(
        &self,
        workspace_id: &str,
        now_ms: i64,
    ) -> Result<Option<PostPublishMonitorPlanProjection>, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        let id = connection
            .query_row(
                "SELECT id FROM geo_post_publish_monitor_plans ORDER BY updated_at DESC,id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("read latest monitoring plan: {error}"))?;
        id.map(|id| read_plan(&connection, workspace_id, &id, now_ms))
            .transpose()
    }

    pub fn get_post_publish_monitor_plan_readonly(
        &self,
        workspace_id: &str,
        plan_id: &str,
        now_ms: i64,
    ) -> Result<PostPublishMonitorPlanProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let connection = open_database(&workspace)?;
        read_plan(&connection, workspace_id, plan_id, now_ms)
    }

    /// UI read dispatch: a provided session keeps the brand_sessions gate
    /// (identical to the Sidecar-era behavior), a missing one falls back to
    /// the session-free projection read for the no-open-session effect page.
    pub fn latest_post_publish_monitor_plan_for_ui(
        &self,
        workspace_id: &str,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Result<Option<PostPublishMonitorPlanProjection>, String> {
        match session_id {
            Some(session_id) => {
                self.latest_post_publish_monitor_plan(workspace_id, session_id, now_ms)
            }
            None => self.latest_post_publish_monitor_plan_readonly(workspace_id, now_ms),
        }
    }

    pub fn get_post_publish_monitor_plan_for_ui(
        &self,
        workspace_id: &str,
        session_id: Option<&str>,
        plan_id: &str,
        now_ms: i64,
    ) -> Result<PostPublishMonitorPlanProjection, String> {
        match session_id {
            Some(session_id) => self.get_post_publish_monitor_plan(
                workspace_id,
                session_id,
                PostPublishMonitorGetRequest {
                    plan_id: plan_id.to_string(),
                },
                now_ms,
            ),
            None => self.get_post_publish_monitor_plan_readonly(workspace_id, plan_id, now_ms),
        }
    }

    fn activate_post_publish_monitor_plan(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: &PostPublishMonitorActivateRequest,
        schedule_id: &str,
        now_ms: i64,
    ) -> Result<PostPublishMonitorPlanProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_monitor_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("activate monitoring plan transaction: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_post_publish_monitor_plans
                 SET status='active',schedule_id=?2,revision=revision+1,
                     activated_at=?3,updated_at=?3
                 WHERE id=?1 AND revision=?4 AND status='draft'",
                params![
                    request.plan_id,
                    schedule_id,
                    now_iso(now_ms),
                    request.expected_revision
                ],
            )
            .map_err(|error| format!("activate monitoring plan: {error}"))?;
        if changed != 1 {
            return Err("post_publish_monitor_revision_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_operations SET state='monitor-active' WHERE id=(
                    SELECT operation_id FROM geo_post_publish_monitor_plans WHERE id=?1)",
                [&request.plan_id],
            )
            .map_err(|error| format!("activate monitoring operation: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit monitoring activation: {error}"))?;
        read_plan(&connection, workspace_id, &request.plan_id, now_ms)
    }

    pub fn retry_post_publish_monitor_unit(
        &self,
        workspace_id: &str,
        session_id: &str,
        request: PostPublishMonitorRetryRequest,
        now_ms: i64,
    ) -> Result<PostPublishMonitorPlanProjection, String> {
        let workspace = self.workspace(workspace_id)?;
        let mut connection = open_database(&workspace)?;
        require_monitor_session(&connection, session_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("retry monitoring unit transaction: {error}"))?;
        let changed = transaction
            .execute(
                "UPDATE geo_post_publish_monitor_units
                 SET status='failed',revision=revision+1,next_attempt_at_ms=?4,
                     error_code='manual-retry-requested',error_message='用户仅重试此失败监测单元'
                 WHERE id=?1 AND plan_id=?2 AND revision=?3 AND status='failed'
                   AND EXISTS(SELECT 1 FROM geo_post_publish_monitor_plans
                              WHERE id=?2 AND status='active')",
                params![
                    request.unit_id,
                    request.plan_id,
                    request.expected_unit_revision,
                    now_ms
                ],
            )
            .map_err(|error| format!("retry monitoring unit: {error}"))?;
        if changed != 1 {
            return Err("post_publish_monitor_unit_revision_conflict".to_string());
        }
        transaction
            .execute(
                "UPDATE geo_post_publish_monitor_runs SET status='running',finished_at=NULL
                 WHERE id=(SELECT run_id FROM geo_post_publish_monitor_units WHERE id=?1)",
                [&request.unit_id],
            )
            .map_err(|error| format!("reopen monitoring run for exact retry: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit monitoring unit retry: {error}"))?;
        read_plan(&connection, workspace_id, &request.plan_id, now_ms)
    }

    fn monitor_context_for_schedule(
        &self,
        reference: &PostPublishMonitorWakeReference,
        schedule_id: &str,
    ) -> Result<MonitorPlanContext, String> {
        if reference.schema != WAKE_SCHEMA || schedule_id.trim().is_empty() {
            return Err("post_publish_monitor_wake_reference_mismatch".to_string());
        }
        let workspace = self.workspace(&reference.workspace_id)?;
        let connection = open_database(&workspace)?;
        let (stored_schedule_id, source_session_id, status): (Option<String>, String, String) =
            connection
                .query_row(
                    "SELECT schedule_id,created_by_session_id,status
                 FROM geo_post_publish_monitor_plans WHERE id=?1",
                    [&reference.plan_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|error| format!("read monitoring wake plan: {error}"))?
                .ok_or_else(|| "post_publish_monitor_plan_not_found".to_string())?;
        if status != "active" || stored_schedule_id.as_deref() != Some(schedule_id) {
            return Err("post_publish_monitor_wake_authority_mismatch".to_string());
        }
        Ok(MonitorPlanContext {
            workspace_id: reference.workspace_id.clone(),
            plan_id: reference.plan_id.clone(),
            source_session_id,
            schedule_id: schedule_id.to_string(),
        })
    }

    fn active_post_publish_monitor_contexts(&self) -> Result<Vec<MonitorPlanContext>, String> {
        let mut contexts = Vec::new();
        for workspace in self.list_workspaces()? {
            let connection = open_database(&workspace)?;
            let mut statement = connection
                .prepare(
                    "SELECT id,created_by_session_id,schedule_id
                     FROM geo_post_publish_monitor_plans
                     WHERE status IN ('active','paused') AND schedule_id IS NOT NULL
                     ORDER BY next_run_at_ms,id",
                )
                .map_err(|error| format!("prepare active GEO monitor schedules: {error}"))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(MonitorPlanContext {
                        workspace_id: workspace.id.clone(),
                        plan_id: row.get(0)?,
                        source_session_id: row.get(1)?,
                        schedule_id: row.get(2)?,
                    })
                })
                .map_err(|error| format!("read active GEO monitor schedules: {error}"))?;
            contexts.extend(
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("collect active GEO monitor schedules: {error}"))?,
            );
        }
        Ok(contexts)
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_post_publish_monitor_prepare_ui(
    workspaceId: String,
    sessionId: String,
    input: PostPublishMonitorPrepareRequest,
) -> Result<PostPublishMonitorPlanProjection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.prepare_post_publish_monitor_plan(
            &workspaceId,
            &sessionId,
            input,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("prepare monitoring plan failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_post_publish_monitor_latest_ui(
    workspaceId: String,
    sessionId: Option<String>,
) -> Result<Option<PostPublishMonitorPlanProjection>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.latest_post_publish_monitor_plan_for_ui(
            &workspaceId,
            sessionId.as_deref(),
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("read latest monitoring plan failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_post_publish_monitor_get_ui(
    workspaceId: String,
    sessionId: Option<String>,
    input: PostPublishMonitorGetRequest,
) -> Result<PostPublishMonitorPlanProjection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.get_post_publish_monitor_plan_for_ui(
            &workspaceId,
            sessionId.as_deref(),
            &input.plan_id,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("read monitoring plan failed: {error}"))?
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_post_publish_monitor_activate_ui(
    workspaceId: String,
    sessionId: String,
    input: PostPublishMonitorActivateRequest,
) -> Result<PostPublishMonitorPlanProjection, String> {
    let workspace_id = workspaceId.clone();
    let session_id = sessionId.clone();
    let plan_id = input.plan_id.clone();
    let draft = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.get_post_publish_monitor_plan(
            &workspace_id,
            &session_id,
            PostPublishMonitorGetRequest { plan_id },
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("read monitoring activation source failed: {error}"))??;
    if draft.status != "draft" || draft.revision != input.expected_revision {
        return Err("post_publish_monitor_revision_conflict".to_string());
    }
    let reference = PostPublishMonitorWakeReference {
        schema: WAKE_SCHEMA.to_string(),
        workspace_id: workspaceId.clone(),
        plan_id: input.plan_id.clone(),
    };
    let schedule_id = stable_id(
        "monitor-schedule",
        &format!("{}|{}", workspaceId, input.plan_id),
    );
    let attach_workspace = workspaceId.clone();
    let attach_session = sessionId.clone();
    let attach_input = input.clone();
    let attached_schedule_id = schedule_id.clone();
    let activated = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.activate_post_publish_monitor_plan(
            &attach_workspace,
            &attach_session,
            &attach_input,
            &attached_schedule_id,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("attach monitoring schedule failed: {error}"))??;
    enqueue_post_publish_monitor_schedule(&reference, &schedule_id)?;
    Ok(activated)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_post_publish_monitor_retry_ui(
    workspaceId: String,
    sessionId: String,
    input: PostPublishMonitorRetryRequest,
) -> Result<PostPublishMonitorPlanProjection, String> {
    let retry_workspace = workspaceId.clone();
    let retry_session = sessionId.clone();
    let retried = tauri::async_runtime::spawn_blocking(move || {
        super::production_store()?.retry_post_publish_monitor_unit(
            &retry_workspace,
            &retry_session,
            input,
            Utc::now().timestamp_millis(),
        )
    })
    .await
    .map_err(|error| format!("retry monitoring unit failed: {error}"))??;
    let schedule_id = retried
        .schedule_id
        .as_deref()
        .ok_or_else(|| "post_publish_monitor_schedule_missing".to_string())?;
    let reference = PostPublishMonitorWakeReference {
        schema: WAKE_SCHEMA.to_string(),
        workspace_id: workspaceId,
        plan_id: retried.id.clone(),
    };
    enqueue_post_publish_monitor_schedule(&reference, schedule_id)?;
    Ok(retried)
}

fn read_attempts(
    connection: &Connection,
    unit_id: &str,
) -> Result<Vec<PostPublishMonitorAttemptProjection>, String> {
    let mut statement = connection
        .prepare(
            "SELECT attempt_number,status,started_at,finished_at,error_code,error_message
             FROM geo_post_publish_monitor_attempts
             WHERE unit_id=?1 ORDER BY attempt_number",
        )
        .map_err(|error| format!("prepare monitoring attempts: {error}"))?;
    let attempts = statement
        .query_map([unit_id], |row| {
            Ok(PostPublishMonitorAttemptProjection {
                attempt_number: row.get(0)?,
                status: row.get(1)?,
                started_at: row.get(2)?,
                finished_at: row.get(3)?,
                error_code: row.get(4)?,
                error_message: row.get(5)?,
            })
        })
        .map_err(|error| format!("read monitoring attempts: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("collect monitoring attempts: {error}"))?;
    Ok(attempts)
}

fn read_run(
    connection: &Connection,
    run_id: &str,
) -> Result<PostPublishMonitorRunProjection, String> {
    let (ordinal, scheduled_for_ms, status, created_at, finished_at): (
        i64,
        i64,
        String,
        String,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT ordinal,scheduled_for_ms,status,created_at,finished_at
             FROM geo_post_publish_monitor_runs WHERE id=?1",
            [run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read monitoring run: {error}"))?
        .ok_or_else(|| "post_publish_monitor_run_not_found".to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT id,revision,kind,status,attempt_number,publish_item_id,baseline_unit_id,
                    question_id,engine_id,observed_at,next_attempt_at_ms,error_code,error_message,evidence_json
             FROM geo_post_publish_monitor_units WHERE run_id=?1
             ORDER BY CASE kind WHEN 'publish-status' THEN 1 WHEN 'access-indexing' THEN 2 ELSE 3 END,
                      COALESCE(publish_item_id,baseline_unit_id),id",
        )
        .map_err(|error| format!("prepare monitoring units: {error}"))?;
    let rows = statement
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
            ))
        })
        .map_err(|error| format!("read monitoring units: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("collect monitoring units: {error}"))?;
    drop(statement);
    let mut units = Vec::with_capacity(rows.len());
    for row in rows {
        units.push(PostPublishMonitorUnitProjection {
            id: row.0.clone(),
            revision: row.1,
            kind: row.2,
            status: row.3,
            attempt_number: row.4,
            publish_item_id: row.5,
            baseline_unit_id: row.6,
            question_id: row.7,
            engine_id: row.8,
            observed_at: row.9,
            next_attempt_at: iso_from_ms(row.10),
            error_code: row.11,
            error_message: row.12,
            evidence: row
                .13
                .and_then(|value| serde_json::from_str::<Value>(&value).ok()),
            attempts: read_attempts(connection, &row.0)?,
        });
    }
    Ok(PostPublishMonitorRunProjection {
        id: run_id.to_string(),
        ordinal,
        scheduled_for: now_iso(scheduled_for_ms),
        status,
        units,
        created_at,
        finished_at,
    })
}

fn read_plan(
    connection: &Connection,
    workspace_id: &str,
    plan_id: &str,
    now_ms: i64,
) -> Result<PostPublishMonitorPlanProjection, String> {
    let row = connection
        .query_row(
            "SELECT operation_id,source_operation_id,created_by_session_id,publish_execution_id,
                    baseline_id,baseline_policy_version,baseline_question_pool_id,
                    baseline_question_pool_revision,engine_ids_json,interval_minutes,
                    end_conditions_json,revision,status,schedule_id,run_count,next_run_at_ms,
                    created_at,updated_at
             FROM geo_post_publish_monitor_plans WHERE id=?1",
            [plan_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, Option<String>>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, Option<i64>>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, String>(17)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read monitoring plan: {error}"))?
        .ok_or_else(|| "post_publish_monitor_plan_not_found".to_string())?;
    let publish_item_ids = {
        let mut statement = connection
            .prepare(
                "SELECT publish_item_id FROM geo_post_publish_monitor_items
                 WHERE plan_id=?1 ORDER BY publish_item_id",
            )
            .map_err(|error| format!("prepare monitoring item ids: {error}"))?;
        let ids = statement
            .query_map([plan_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("read monitoring item ids: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect monitoring item ids: {error}"))?;
        ids
    };
    let recent_run_ids = {
        let mut statement = connection
            .prepare(
                "SELECT id FROM geo_post_publish_monitor_runs WHERE plan_id=?1
                 ORDER BY ordinal DESC,id DESC LIMIT ?2",
            )
            .map_err(|error| format!("prepare recent monitoring run ids: {error}"))?;
        let rows = statement
            .query_map(params![plan_id, RECENT_RUN_LIMIT as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| format!("read recent monitoring run ids: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect recent monitoring run ids: {error}"))?
    };
    let recent_runs = recent_run_ids
        .iter()
        .map(|run_id| read_run(connection, run_id))
        .collect::<Result<Vec<_>, _>>()?;
    let latest_run = recent_runs.first().cloned();
    let recovery_state = if row.12 == "completed" {
        "completed"
    } else if row.12 == "paused" {
        "paused"
    } else if latest_run
        .as_ref()
        .is_some_and(|run| run.units.iter().any(|unit| unit.status == "running"))
    {
        "recovering"
    } else if row.12 == "active" && row.15.is_some_and(|next| next <= now_ms) {
        "overdue"
    } else {
        "ready"
    };
    Ok(PostPublishMonitorPlanProjection {
        id: plan_id.to_string(),
        operation_id: row.0,
        source_operation_id: row.1,
        workspace_id: workspace_id.to_string(),
        created_by_session_id: row.2,
        publish_execution_id: row.3,
        publish_item_ids,
        baseline_id: row.4,
        baseline_policy_version: row.5,
        baseline_question_pool_id: row.6,
        baseline_question_pool_revision: row.7,
        engine_ids: serde_json::from_str(&row.8)
            .map_err(|error| format!("parse monitoring engines: {error}"))?,
        interval_minutes: row.9,
        end_conditions: serde_json::from_str(&row.10)
            .map_err(|error| format!("parse monitoring end conditions: {error}"))?,
        policy_version: POLICY_VERSION,
        revision: row.11,
        status: row.12,
        schedule_id: row.13,
        run_count: row.14,
        next_run_at: iso_from_ms(row.15),
        recovery_state: recovery_state.to_string(),
        latest_run,
        recent_runs,
        created_at: row.16,
        updated_at: row.17,
    })
}

fn create_due_run(
    workspace: &BrandWorkspace,
    context: &MonitorPlanContext,
    now_ms: i64,
) -> Result<Option<String>, String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("create monitoring run transaction: {error}"))?;
    let (status, schedule_id, interval_minutes, run_count, next_run_at_ms, end_json): (
        String,
        Option<String>,
        i64,
        i64,
        Option<i64>,
        String,
    ) = transaction
        .query_row(
            "SELECT status,schedule_id,interval_minutes,run_count,next_run_at_ms,end_conditions_json
             FROM geo_post_publish_monitor_plans WHERE id=?1",
            [&context.plan_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .optional()
        .map_err(|error| format!("read due monitoring plan: {error}"))?
        .ok_or_else(|| "post_publish_monitor_plan_not_found".to_string())?;
    if status != "active" || schedule_id.is_none() {
        return Ok(None);
    }
    let end_conditions: PostPublishMonitorEndConditions = serde_json::from_str(&end_json)
        .map_err(|error| format!("parse due monitoring end conditions: {error}"))?;
    let ended = end_conditions
        .deadline
        .is_some_and(|deadline| deadline <= now_ms)
        || end_conditions
            .max_runs
            .is_some_and(|maximum| run_count >= maximum);
    if ended {
        let now = now_iso(now_ms);
        transaction
            .execute(
                "UPDATE geo_post_publish_monitor_plans
                 SET status='completed',revision=revision+1,next_run_at_ms=NULL,
                     completed_at=?2,updated_at=?2 WHERE id=?1 AND status='active'",
                params![context.plan_id, now],
            )
            .map_err(|error| format!("complete ended monitoring plan: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state='monitor-completed' WHERE id=(
                    SELECT operation_id FROM geo_post_publish_monitor_plans WHERE id=?1)",
                [&context.plan_id],
            )
            .map_err(|error| format!("complete monitoring operation: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("commit ended monitoring plan: {error}"))?;
        return Ok(None);
    }
    let Some(scheduled_for_ms) = next_run_at_ms else {
        return Ok(None);
    };
    if scheduled_for_ms > now_ms {
        return Ok(None);
    }
    let ordinal = run_count + 1;
    let run_id = stable_id(
        "monitor-run",
        &format!("{}|{}", context.plan_id, scheduled_for_ms),
    );
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO geo_post_publish_monitor_runs(
                id,plan_id,ordinal,scheduled_for_ms,status,created_at,finished_at)
             VALUES (?1,?2,?3,?4,'running',?5,NULL)",
            params![
                run_id,
                context.plan_id,
                ordinal,
                scheduled_for_ms,
                now_iso(now_ms)
            ],
        )
        .map_err(|error| format!("insert monitoring run: {error}"))?;
    if inserted == 0 {
        transaction
            .commit()
            .map_err(|error| format!("commit duplicate monitoring wake: {error}"))?;
        return Ok(Some(run_id));
    }

    let published_articles = {
        let mut statement = transaction
            .prepare(
                "SELECT publish_item_id,article_id,channel_kind,external_request_sn,
                        external_order_id,external_content_id,idempotency_key,object_url,snapshot_json
                 FROM geo_post_publish_monitor_items WHERE plan_id=?1 ORDER BY publish_item_id",
            )
            .map_err(|error| format!("prepare monitoring item unit input: {error}"))?;
        let rows = statement
            .query_map([&context.plan_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            })
            .map_err(|error| format!("read monitoring item unit input: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect monitoring item unit input: {error}"))?;
        rows
    };
    // Platform URLs are only authoritative once queryOrders observes them.
    // Object-storage URLs remain audit-only and are never accessibility input.
    let article_urls = Vec::<Value>::new();
    let brand_names = published_articles
        .first()
        .and_then(|item| serde_json::from_str::<Value>(&item.8).ok())
        .and_then(|snapshot| snapshot.get("brandNames").cloned())
        .unwrap_or_else(|| json!([]));
    let competitor_names = published_articles
        .first()
        .and_then(|item| serde_json::from_str::<Value>(&item.8).ok())
        .and_then(|snapshot| snapshot.get("competitorNames").cloned())
        .unwrap_or_else(|| json!([]));
    for item in &published_articles {
        let common = json!({
            "publishItemId": item.0,
            "articleId": item.1,
            "channelKind": item.2,
            "externalRequestSn": item.3,
            "externalOrderId": item.4,
            "externalContentId": item.5,
            "idempotencyKey": item.6,
            "objectUrl": item.7,
        });
        for kind in ["publish-status", "access-indexing"] {
            let unit_id = stable_id("monitor-unit", &format!("{run_id}|{kind}|{}", item.0));
            transaction
                .execute(
                    "INSERT INTO geo_post_publish_monitor_units(
                        id,run_id,plan_id,kind,publish_item_id,baseline_unit_id,question_id,engine_id,
                        payload_json,status,revision,attempt_number,claim_token,lease_until_ms,
                        next_attempt_at_ms,evidence_json,observed_at,error_code,error_message)
                     VALUES (?1,?2,?3,?4,?5,NULL,NULL,NULL,?6,'pending',1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
                    params![unit_id, run_id, context.plan_id, kind, item.0, common.to_string()],
                )
                .map_err(|error| format!("insert monitoring publish unit: {error}"))?;
        }
    }
    let questions = {
        let mut statement = transaction
            .prepare(
                "SELECT baseline_unit_id,question_id,question_text,engine_id,provider_snapshot_json
                 FROM geo_post_publish_monitor_questions WHERE plan_id=?1
                 ORDER BY question_id,engine_id,baseline_unit_id",
            )
            .map_err(|error| format!("prepare monitoring probe unit input: {error}"))?;
        let rows = statement
            .query_map([&context.plan_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| format!("read monitoring probe unit input: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("collect monitoring probe unit input: {error}"))?;
        rows
    };
    for question in &questions {
        let unit_id = stable_id(
            "monitor-unit",
            &format!("{run_id}|baseline-probe|{}", question.0),
        );
        let payload = json!({
            "baselineUnitId": question.0,
            "questionId": question.1,
            "question": question.2,
            "engineId": question.3,
            "sourceProviderSnapshot": serde_json::from_str::<Value>(&question.4).unwrap_or(Value::Null),
            "brandNames": brand_names,
            "competitorNames": competitor_names,
            "publishedArticles": article_urls,
        });
        transaction
            .execute(
                "INSERT INTO geo_post_publish_monitor_units(
                    id,run_id,plan_id,kind,publish_item_id,baseline_unit_id,question_id,engine_id,
                    payload_json,status,revision,attempt_number,claim_token,lease_until_ms,
                    next_attempt_at_ms,evidence_json,observed_at,error_code,error_message)
                 VALUES (?1,?2,?3,'baseline-probe',NULL,?4,?5,?6,?7,
                         'pending',1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
                params![
                    unit_id,
                    run_id,
                    context.plan_id,
                    question.0,
                    question.1,
                    question.3,
                    payload.to_string()
                ],
            )
            .map_err(|error| format!("insert monitoring baseline unit: {error}"))?;
    }
    let mut next_anchor = scheduled_for_ms.saturating_add(interval_minutes * 60_000);
    while next_anchor <= now_ms {
        next_anchor = next_anchor.saturating_add(interval_minutes * 60_000);
    }
    transaction
        .execute(
            "UPDATE geo_post_publish_monitor_plans
             SET run_count=?2,next_run_at_ms=?3,revision=revision+1,updated_at=?4
             WHERE id=?1 AND status='active'",
            params![context.plan_id, ordinal, next_anchor, now_iso(now_ms)],
        )
        .map_err(|error| format!("advance monitoring schedule anchor: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit monitoring run: {error}"))?;
    Ok(Some(run_id))
}

fn claim_next_unit(
    workspace: &BrandWorkspace,
    context: &MonitorPlanContext,
    now_ms: i64,
) -> Result<Option<ClaimedMonitorUnit>, String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("claim monitoring unit transaction: {error}"))?;
    let row = transaction
        .query_row(
            "SELECT unit.id,unit.run_id,unit.kind,unit.attempt_number,unit.payload_json
             FROM geo_post_publish_monitor_units unit
             JOIN geo_post_publish_monitor_runs run ON run.id=unit.run_id
             JOIN geo_post_publish_monitor_plans plan ON plan.id=unit.plan_id
             WHERE unit.plan_id=?1 AND plan.status='active' AND run.status='running'
               AND (
                 unit.status='pending'
                 OR (unit.status='failed' AND unit.next_attempt_at_ms IS NOT NULL AND unit.next_attempt_at_ms<=?2)
                 OR (unit.status='running' AND unit.lease_until_ms IS NOT NULL AND unit.lease_until_ms<=?2)
               )
             ORDER BY run.ordinal,
                      CASE unit.kind WHEN 'publish-status' THEN 1 WHEN 'access-indexing' THEN 2 ELSE 3 END,
                      unit.id LIMIT 1",
            params![context.plan_id, now_ms],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read next monitoring unit: {error}"))?;
    let Some((unit_id, run_id, kind, prior_attempt, payload_json)) = row else {
        return Ok(None);
    };
    let attempt_number = prior_attempt + 1;
    let claim_token = digest(format!("{unit_id}|{attempt_number}|{now_ms}"));
    let changed = transaction
        .execute(
            "UPDATE geo_post_publish_monitor_units
             SET status='running',revision=revision+1,attempt_number=?2,claim_token=?3,
                 lease_until_ms=?4,next_attempt_at_ms=NULL,error_code=NULL,error_message=NULL
             WHERE id=?1 AND attempt_number=?5
               AND (status='pending' OR status='failed' OR (status='running' AND lease_until_ms<=?6))",
            params![unit_id, attempt_number, claim_token, now_ms + CLAIM_LEASE_MS, prior_attempt, now_ms],
        )
        .map_err(|error| format!("claim monitoring unit: {error}"))?;
    if changed != 1 {
        return Ok(None);
    }
    transaction
        .execute(
            "INSERT INTO geo_post_publish_monitor_attempts(
                unit_id,attempt_number,claim_token,status,started_at,finished_at,error_code,error_message)
             VALUES (?1,?2,?3,'running',?4,NULL,NULL,NULL)",
            params![unit_id, attempt_number, claim_token, now_iso(now_ms)],
        )
        .map_err(|error| format!("insert monitoring attempt: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit monitoring unit claim: {error}"))?;
    Ok(Some(ClaimedMonitorUnit {
        id: unit_id,
        run_id,
        plan_id: context.plan_id.clone(),
        kind,
        claim_token,
        source_session_id: context.source_session_id.clone(),
        schedule_id: context.schedule_id.clone(),
        payload: serde_json::from_str(&payload_json)
            .map_err(|error| format!("parse monitoring unit payload: {error}"))?,
    }))
}

fn settle_unit_success(
    workspace: &BrandWorkspace,
    claim: &ClaimedMonitorUnit,
    evidence: Value,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("settle monitoring success transaction: {error}"))?;
    let changed = transaction
        .execute(
            "UPDATE geo_post_publish_monitor_units
             SET status='succeeded',revision=revision+1,claim_token=NULL,lease_until_ms=NULL,
                 next_attempt_at_ms=NULL,evidence_json=?3,observed_at=?4,
                 error_code=NULL,error_message=NULL
             WHERE id=?1 AND claim_token=?2 AND status='running'",
            params![
                claim.id,
                claim.claim_token,
                evidence.to_string(),
                now_iso(now_ms)
            ],
        )
        .map_err(|error| format!("settle monitoring success: {error}"))?;
    if changed != 1 {
        return Err("post_publish_monitor_unit_claim_conflict".to_string());
    }
    transaction
        .execute(
            "UPDATE geo_post_publish_monitor_attempts
             SET status='succeeded',finished_at=?3
             WHERE unit_id=?1 AND claim_token=?2 AND status='running'",
            params![claim.id, claim.claim_token, now_iso(now_ms)],
        )
        .map_err(|error| format!("settle monitoring success attempt: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit monitoring success: {error}"))?;
    refresh_run_and_plan(workspace, &claim.run_id, &claim.plan_id, now_ms)
}

fn settle_unit_failure(
    workspace: &BrandWorkspace,
    claim: &ClaimedMonitorUnit,
    failure: MonitorProviderFailure,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("settle monitoring failure transaction: {error}"))?;
    let attempt_number: i64 = transaction
        .query_row(
            "SELECT attempt_number FROM geo_post_publish_monitor_units
             WHERE id=?1 AND claim_token=?2 AND status='running'",
            params![claim.id, claim.claim_token],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read monitoring failed attempt: {error}"))?
        .ok_or_else(|| "post_publish_monitor_unit_claim_conflict".to_string())?;
    let next_attempt_at = if failure.retryable {
        RETRY_BACKOFF_MS
            .get((attempt_number - 1) as usize)
            .map(|delay| now_ms.saturating_add(*delay))
    } else {
        None
    };
    transaction
        .execute(
            "UPDATE geo_post_publish_monitor_units
             SET status='failed',revision=revision+1,claim_token=NULL,lease_until_ms=NULL,
                 next_attempt_at_ms=?3,evidence_json=NULL,observed_at=NULL,
                 error_code=?4,error_message=?5
             WHERE id=?1 AND claim_token=?2 AND status='running'",
            params![
                claim.id,
                claim.claim_token,
                next_attempt_at,
                failure.code,
                bounded_error(&failure.message),
            ],
        )
        .map_err(|error| format!("settle monitoring failure: {error}"))?;
    transaction
        .execute(
            "UPDATE geo_post_publish_monitor_attempts
             SET status='failed',finished_at=?3,error_code=?4,error_message=?5
             WHERE unit_id=?1 AND claim_token=?2 AND status='running'",
            params![
                claim.id,
                claim.claim_token,
                now_iso(now_ms),
                failure.code,
                bounded_error(&failure.message),
            ],
        )
        .map_err(|error| format!("settle monitoring failure attempt: {error}"))?;
    // 票 14 计划级暂停：sidecar 余额预检返回 insufficient_balance（402，
    // 非重试）时整计划落 paused——跳过后续 wake 与全部单元工作，零扣点；
    // 充值/余额恢复后由到期锚点的只读余额探测自动恢复。
    if failure.code == "insufficient_balance" {
        transaction
            .execute(
                "UPDATE geo_post_publish_monitor_plans
                 SET status='paused',revision=revision+1,updated_at=?2
                 WHERE id=?1 AND status='active'",
                params![claim.plan_id, now_iso(now_ms)],
            )
            .map_err(|error| format!("pause monitoring plan: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state='monitor-paused' WHERE id=(
                    SELECT operation_id FROM geo_post_publish_monitor_plans WHERE id=?1)",
                [&claim.plan_id],
            )
            .map_err(|error| format!("pause monitoring operation: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("commit monitoring failure: {error}"))?;
    refresh_run_and_plan(workspace, &claim.run_id, &claim.plan_id, now_ms)
}

fn refresh_run_and_plan(
    workspace: &BrandWorkspace,
    run_id: &str,
    plan_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("refresh monitoring run transaction: {error}"))?;
    let (total, succeeded, active, retryable): (i64, i64, i64, i64) = transaction
        .query_row(
            "SELECT COUNT(*),
                    SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status='failed' AND next_attempt_at_ms IS NOT NULL THEN 1 ELSE 0 END)
             FROM geo_post_publish_monitor_units WHERE run_id=?1",
            [run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|error| format!("read monitoring run totals: {error}"))?;
    if active == 0 && retryable == 0 {
        let status = if total > 0 && succeeded == total {
            "succeeded"
        } else if succeeded > 0 {
            "partial"
        } else {
            "failed"
        };
        transaction
            .execute(
                "UPDATE geo_post_publish_monitor_runs
                 SET status=?2,finished_at=COALESCE(finished_at,?3)
                 WHERE id=?1 AND status='running'",
                params![run_id, status, now_iso(now_ms)],
            )
            .map_err(|error| format!("finalize monitoring run: {error}"))?;
        let (run_count, end_json): (i64, String) = transaction
            .query_row(
                "SELECT run_count,end_conditions_json FROM geo_post_publish_monitor_plans WHERE id=?1",
                [plan_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("read monitoring completion condition: {error}"))?;
        let end: PostPublishMonitorEndConditions = serde_json::from_str(&end_json)
            .map_err(|error| format!("parse monitoring completion condition: {error}"))?;
        if end.deadline.is_some_and(|deadline| deadline <= now_ms)
            || end.max_runs.is_some_and(|maximum| run_count >= maximum)
        {
            let now = now_iso(now_ms);
            transaction
                .execute(
                    "UPDATE geo_post_publish_monitor_plans
                     SET status='completed',revision=revision+1,next_run_at_ms=NULL,
                         completed_at=?2,updated_at=?2 WHERE id=?1 AND status='active'",
                    params![plan_id, now],
                )
                .map_err(|error| format!("complete monitoring plan: {error}"))?;
            transaction
                .execute(
                    "UPDATE geo_operations SET state='monitor-completed' WHERE id=(
                        SELECT operation_id FROM geo_post_publish_monitor_plans WHERE id=?1)",
                    [plan_id],
                )
                .map_err(|error| format!("complete monitoring operation: {error}"))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("commit monitoring run refresh: {error}"))
}

fn recover_expired_units(
    workspace: &BrandWorkspace,
    plan_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("recover stale monitoring leases transaction: {error}"))?;
    transaction
        .execute(
            "UPDATE geo_post_publish_monitor_attempts
             SET status='failed',finished_at=?3,error_code='stale-lease-recovered',
                 error_message='应用退出或进程中断，持久租约已到期'
             WHERE status='running' AND unit_id IN (
                 SELECT id FROM geo_post_publish_monitor_units
                 WHERE plan_id=?1 AND status='running' AND lease_until_ms<=?2
             )",
            params![plan_id, now_ms, now_iso(now_ms)],
        )
        .map_err(|error| format!("recover stale monitoring attempts: {error}"))?;
    transaction
        .execute(
            "UPDATE geo_post_publish_monitor_units
             SET status='failed',revision=revision+1,claim_token=NULL,lease_until_ms=NULL,
                 next_attempt_at_ms=?3,error_code='stale-lease-recovered',
                 error_message='应用退出或进程中断，已从持久租约恢复，仅重试此监测单元'
             WHERE plan_id=?1 AND status='running' AND lease_until_ms<=?2",
            params![plan_id, now_ms, now_ms],
        )
        .map_err(|error| format!("recover stale monitoring leases: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("commit stale monitoring lease recovery: {error}"))
}

fn monitor_plan_completed(workspace: &BrandWorkspace, plan_id: &str) -> Result<bool, String> {
    let connection = open_database(workspace)?;
    connection
        .query_row(
            "SELECT status='completed' FROM geo_post_publish_monitor_plans WHERE id=?1",
            [plan_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("read monitoring completion state: {error}"))?
        .ok_or_else(|| "post_publish_monitor_plan_not_found".to_string())
}

/// paused 计划在到期锚点的处置（票 14）：余额已恢复则整计划回到 active
/// （同一 schedule 继续巡检）；仍不足（或探测不可判定）则把锚点顺延一个
/// 巡检间隔——每个锚点只探测一次，暂停期绝不创建 run、不 claim 单元。
fn resume_or_defer_paused_monitor_plan(
    workspace: &BrandWorkspace,
    context: &MonitorPlanContext,
    balance_sufficient: bool,
    now_ms: i64,
) -> Result<(), String> {
    let mut connection = open_database(workspace)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("resume monitoring plan transaction: {error}"))?;
    let row = transaction
        .query_row(
            "SELECT status,next_run_at_ms,interval_minutes
             FROM geo_post_publish_monitor_plans WHERE id=?1",
            [&context.plan_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("read paused monitoring plan: {error}"))?;
    let Some((status, next_run_at_ms, interval_minutes)) = row else {
        return Ok(());
    };
    if status != "paused" {
        return Ok(());
    }
    let now = now_iso(now_ms);
    if balance_sufficient {
        transaction
            .execute(
                "UPDATE geo_post_publish_monitor_plans
                 SET status='active',revision=revision+1,updated_at=?2
                 WHERE id=?1 AND status='paused'",
                params![context.plan_id, now],
            )
            .map_err(|error| format!("resume monitoring plan: {error}"))?;
        transaction
            .execute(
                "UPDATE geo_operations SET state='monitor-active' WHERE id=(
                    SELECT operation_id FROM geo_post_publish_monitor_plans WHERE id=?1)",
                [&context.plan_id],
            )
            .map_err(|error| format!("resume monitoring operation: {error}"))?;
    } else {
        let mut next_anchor = next_run_at_ms
            .unwrap_or(now_ms)
            .saturating_add(interval_minutes * 60_000);
        while next_anchor <= now_ms {
            next_anchor = next_anchor.saturating_add(interval_minutes * 60_000);
        }
        transaction
            .execute(
                "UPDATE geo_post_publish_monitor_plans
                 SET next_run_at_ms=?2,revision=revision+1,updated_at=?3
                 WHERE id=?1 AND status='paused'",
                params![context.plan_id, next_anchor, now],
            )
            .map_err(|error| format!("defer paused monitoring anchor: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("commit paused monitoring resolution: {error}"))?;
    Ok(())
}

/// Deterministic BrandWorkspace executor. Its private scheduler is the only
/// timer authority and accepts exact persisted plan references.
pub struct PostPublishMonitorExecutor {
    store: BrandWorkspaceStore,
    provider: Arc<dyn PostPublishMonitorProvider>,
    schedule_completion: Arc<dyn PostPublishMonitorScheduleCompletion>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    after_pass: Arc<dyn PostPublishMonitorPassHook>,
    balance_probe: Arc<dyn PostPublishMonitorBalanceProbe>,
    /// key -> another wake arrived while the current pass was active.
    active: Arc<Mutex<HashMap<String, bool>>>,
}

impl PostPublishMonitorExecutor {
    fn new(
        store: BrandWorkspaceStore,
        provider: Arc<dyn PostPublishMonitorProvider>,
        schedule_completion: Arc<dyn PostPublishMonitorScheduleCompletion>,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            store,
            provider,
            schedule_completion,
            now,
            after_pass: Arc::new(NoopPostPublishMonitorPassHook),
            balance_probe: Arc::new(ProductionPostPublishMonitorBalanceProbe),
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    fn with_after_pass_hook(mut self, hook: Arc<dyn PostPublishMonitorPassHook>) -> Self {
        self.after_pass = hook;
        self
    }

    #[cfg(test)]
    fn with_balance_probe(mut self, probe: Arc<dyn PostPublishMonitorBalanceProbe>) -> Self {
        self.balance_probe = probe;
        self
    }

    fn accept(self: &Arc<Self>, context: MonitorPlanContext) -> bool {
        let key = format!("{}:{}", context.workspace_id, context.plan_id);
        {
            let mut active = self
                .active
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(rerun_requested) = active.get_mut(&key) {
                *rerun_requested = true;
                return false;
            }
            active.insert(key.clone(), false);
        }
        let executor = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                if let Err(error) = executor.run_context(&context).await {
                    crate::ulog_warn!(
                        "[post-publish-monitor] deterministic wake failed plan={}: {}",
                        context.plan_id,
                        bounded_error(error)
                    );
                }
                executor.after_pass.after_pass().await;
                let rerun = {
                    let mut active = executor
                        .active
                        .lock()
                        .unwrap_or_else(|error| error.into_inner());
                    match active.get_mut(&key) {
                        Some(rerun_requested) if *rerun_requested => {
                            *rerun_requested = false;
                            true
                        }
                        _ => {
                            active.remove(&key);
                            false
                        }
                    }
                };
                if !rerun {
                    break;
                }
            }
        });
        true
    }

    async fn run_context(&self, context: &MonitorPlanContext) -> Result<(), String> {
        let workspace = self.store.workspace(&context.workspace_id)?;
        let now_ms = (self.now)();
        recover_expired_units(&workspace, &context.plan_id, now_ms)?;
        self.resolve_paused_plan(&workspace, context, now_ms)
            .await?;
        let _ = create_due_run(&workspace, context, now_ms)?;
        loop {
            let current = (self.now)();
            let Some(claim) = claim_next_unit(&workspace, context, current)? else {
                break;
            };
            match self.provider.observe(&workspace, &claim).await {
                Ok(evidence) => settle_unit_success(&workspace, &claim, evidence, (self.now)())?,
                Err(failure) => settle_unit_failure(&workspace, &claim, failure, (self.now)())?,
            }
        }
        if monitor_plan_completed(&workspace, &context.plan_id)? {
            let plan = self.store.get_post_publish_monitor_plan(
                &context.workspace_id,
                &context.source_session_id,
                PostPublishMonitorGetRequest {
                    plan_id: context.plan_id.clone(),
                },
                (self.now)(),
            )?;
            crate::notification::submit_monitoring_completion(
                &plan.workspace_id,
                &plan.created_by_session_id,
                &plan.operation_id,
                &plan.id,
                plan.revision,
            );
            self.schedule_completion
                .complete(&context.schedule_id)
                .await?;
        }
        Ok(())
    }

    /// paused 计划的到期锚点处置：锚点未到直接跳过；到期先做只读余额
    /// 探测，恢复则放行后续 create_due_run/claim，否则顺延锚点后本轮
    /// 结束（计划保持 paused，run/claim 的 active 门挡住全部单元工作）。
    async fn resolve_paused_plan(
        &self,
        workspace: &BrandWorkspace,
        context: &MonitorPlanContext,
        now_ms: i64,
    ) -> Result<(), String> {
        let (status, next_run_at_ms): (String, Option<i64>) = open_database(workspace)?
            .query_row(
                "SELECT status,next_run_at_ms FROM geo_post_publish_monitor_plans WHERE id=?1",
                [&context.plan_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| format!("read paused monitoring wake state: {error}"))?
            .ok_or_else(|| "post_publish_monitor_plan_not_found".to_string())?;
        if status != "paused" || next_run_at_ms.is_none_or(|anchor| anchor > now_ms) {
            return Ok(());
        }
        let sufficient = self
            .balance_probe
            .sufficient_for_patrol(workspace, context)
            .await
            .inspect_err(|error| {
                crate::ulog_warn!(
                    "[post-publish-monitor] paused balance probe failed plan={}: {}",
                    context.plan_id,
                    bounded_error(error)
                )
            })
            .unwrap_or(false);
        resume_or_defer_paused_monitor_plan(workspace, context, sufficient, (self.now)())?;
        Ok(())
    }
}

static PRODUCTION_MONITOR_EXECUTOR: OnceLock<Arc<PostPublishMonitorExecutor>> = OnceLock::new();

pub fn initialize_post_publish_monitor_executor(
    store: BrandWorkspaceStore,
) -> Arc<PostPublishMonitorExecutor> {
    PRODUCTION_MONITOR_EXECUTOR
        .get_or_init(|| {
            Arc::new(PostPublishMonitorExecutor::new(
                store,
                Arc::new(ProductionPostPublishMonitorProvider),
                Arc::new(ProductionPostPublishMonitorScheduleCompletion),
                Arc::new(|| Utc::now().timestamp_millis()),
            ))
        })
        .clone()
}

fn production_post_publish_monitor_executor() -> Option<Arc<PostPublishMonitorExecutor>> {
    PRODUCTION_MONITOR_EXECUTOR.get().cloned()
}

pub fn enqueue_post_publish_monitor_schedule(
    reference: &PostPublishMonitorWakeReference,
    schedule_id: &str,
) -> Result<bool, String> {
    let store = super::production_store()?;
    let context = store.monitor_context_for_schedule(reference, schedule_id)?;
    let executor = production_post_publish_monitor_executor()
        .unwrap_or_else(|| initialize_post_publish_monitor_executor(store));
    Ok(executor.accept(context))
}

pub fn start_post_publish_monitor_scheduler_background(store: BrandWorkspaceStore) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let executor = initialize_post_publish_monitor_executor(store.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            match store.active_post_publish_monitor_contexts() {
                Ok(contexts) => {
                    for context in contexts {
                        executor.accept(context);
                    }
                }
                Err(error) => crate::ulog_warn!(
                    "[post-publish-monitor] schedule scan failed: {}",
                    bounded_error(error)
                ),
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

pub fn has_active_post_publish_monitor_for_session(session_id: &str) -> Result<bool, String> {
    let store = super::production_store()?;
    for workspace in store.list_workspaces()? {
        let connection = open_database(&workspace)?;
        // paused 计划仍持有持久 owner：余额探测与恢复后的巡检都要附着
        // 来源 Session Sidecar，不能因暂停而释放进程。
        let found: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM geo_post_publish_monitor_plans
                 WHERE created_by_session_id=?1 AND status IN ('active','paused'))",
                [session_id],
                |row| row.get(0),
            )
            .map_err(|error| format!("read active GEO monitor ownership: {error}"))?;
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::super::{SessionCommit, SessionTitleSource};
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
    use tempfile::tempdir;

    struct Fixture {
        _temp: tempfile::TempDir,
        store: BrandWorkspaceStore,
        workspace: BrandWorkspace,
        now_ms: i64,
    }

    fn fixture(max_runs: i64) -> (Fixture, PostPublishMonitorPlanProjection) {
        let temp = tempdir().unwrap();
        let store = BrandWorkspaceStore::at(temp.path().join("xiaojing"));
        let workspace = store
            .create_workspace("监测品牌", vec!["产品".to_string()])
            .unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-14".to_string(),
                    title: "监测".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let now_ms = 1_900_000_000_000_i64;
        let now = now_iso(now_ms);
        let connection = Connection::open(workspace.root_path.join("project.sqlite")).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection.execute("INSERT INTO geo_operations(id,session_id,state,created_at) VALUES ('publish-op-14','session-14','publish-submitted',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_publish_executions(id,operation_id,created_by_session_id,distribution_plan_id,distribution_plan_revision,status,revision,budget_cny,estimated_spend_cny,publish_start_at,confirmation_digest,provider_snapshot_json,created_at,updated_at) VALUES ('publish-exec-14','publish-op-14','session-14','distribution-14',7,'succeeded',4,20,10,?1,'digest','{}',?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_publish_items(id,execution_id,sequence,revision,article_id,approved_revision,approved_body_sha256,approved_body_path,article_json,channel_json,scheduled_at,scheduled_at_ms,status,idempotency_key,external_request_sn,payload_hash,object_key,object_url,external_order_id,external_content_id,request_summary_json) VALUES ('publish-item-14','publish-exec-14',1,5,'article-14',2,'body-hash','articles/approved/article-14/v2.md',?1,?2,?3,?4,'submitted','idem-14','request-sn-14','payload-hash','geo/object-14.md','https://oss.example.test/geo/object-14.md','platform-order-14','content-14',?5)", params![json!({"id":"article-14","title":"真实文章"}).to_string(),json!({"kind":"media","resourceId":88,"name":"真实渠道"}).to_string(),now,now_ms,json!({"plannedObjectUrl":"https://oss.example.test/geo/object-14.md"}).to_string()]).unwrap();
        connection.execute("INSERT INTO geo_operations(id,session_id,state,created_at) VALUES ('baseline-op-14','session-14','baseline-complete',?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_baselines(id,operation_id,created_by_session_id,question_pool_id,question_pool_revision,knowledge_version,brand_names_json,competitors_json,provider_snapshots_json,policy_version,status,idempotency_key,created_at,updated_at) VALUES ('baseline-14','baseline-op-14','session-14','pool-14',9,3,'[\"小鲸\"]','[\"声浪坊\"]','[]','xiaojing-geo-baseline-v1','succeeded','baseline-idem-14',?1,?1)", [&now]).unwrap();
        connection.execute("INSERT INTO geo_baseline_units(id,baseline_id,question_id,question_text,engine_id,provider_snapshot_json,status,attempt_number,citations_json) VALUES ('baseline-unit-14','baseline-14','question-14','哪个品牌更好？','doubao','{\"engineId\":\"doubao\"}','succeeded',1,'[]')", []).unwrap();
        drop(connection);
        let plan = store
            .prepare_post_publish_monitor_plan(
                &workspace.id,
                "session-14",
                PostPublishMonitorPrepareRequest {
                    publish_execution_id: "publish-exec-14".to_string(),
                    baseline_id: "baseline-14".to_string(),
                    engine_ids: vec!["doubao".to_string()],
                    interval_minutes: 15,
                    end_conditions: PostPublishMonitorEndConditions {
                        deadline: None,
                        max_runs: Some(max_runs),
                    },
                    plan_id: None,
                    expected_revision: None,
                },
                now_ms,
            )
            .unwrap();
        let plan = store
            .activate_post_publish_monitor_plan(
                &workspace.id,
                "session-14",
                &PostPublishMonitorActivateRequest {
                    plan_id: plan.id.clone(),
                    expected_revision: plan.revision,
                },
                "managed-task-14",
                now_ms,
            )
            .unwrap();
        (
            Fixture {
                _temp: temp,
                store,
                workspace,
                now_ms,
            },
            plan,
        )
    }

    fn context(fixture: &Fixture, plan_id: &str) -> MonitorPlanContext {
        MonitorPlanContext {
            workspace_id: fixture.workspace.id.clone(),
            plan_id: plan_id.to_string(),
            source_session_id: "session-14".to_string(),
            schedule_id: "managed-task-14".to_string(),
        }
    }

    #[test]
    fn ui_plan_reads_fall_back_to_session_free_projection_reads() {
        let (fixture, plan) = fixture(3);
        // A committed session keeps the gate for wrong ids…
        assert_eq!(
            fixture
                .store
                .latest_post_publish_monitor_plan(
                    &fixture.workspace.id,
                    "never-committed-session",
                    fixture.now_ms,
                )
                .unwrap_err(),
            "post_publish_monitor_session_not_found"
        );
        // …while the UI dispatch without a session still reads the projection.
        let latest = fixture
            .store
            .latest_post_publish_monitor_plan_for_ui(&fixture.workspace.id, None, fixture.now_ms)
            .unwrap()
            .unwrap();
        assert_eq!(latest.id, plan.id);
        assert_eq!(latest.status, plan.status);
        let exact = fixture
            .store
            .get_post_publish_monitor_plan_for_ui(
                &fixture.workspace.id,
                None,
                &plan.id,
                fixture.now_ms,
            )
            .unwrap();
        assert_eq!(exact.id, plan.id);
        assert_eq!(
            fixture
                .store
                .latest_post_publish_monitor_plan_for_ui(
                    &fixture.workspace.id,
                    Some("session-14"),
                    fixture.now_ms,
                )
                .unwrap()
                .unwrap()
                .id,
            plan.id
        );
        let empty_brand = fixture.store.create_workspace("空品牌", vec![]).unwrap();
        assert_eq!(
            fixture
                .store
                .latest_post_publish_monitor_plan_readonly(&empty_brand.id, fixture.now_ms)
                .unwrap(),
            None
        );
    }

    #[derive(Default)]
    struct MockProvider {
        calls: Mutex<Vec<String>>,
    }

    impl PostPublishMonitorProvider for MockProvider {
        fn observe<'a>(
            &'a self,
            _workspace: &'a BrandWorkspace,
            unit: &'a ClaimedMonitorUnit,
        ) -> MonitorFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(unit.kind.clone());
                Ok(match unit.kind.as_str() {
                    "publish-status" => json!({
                        "platformStatusCode": 12,
                        "platformStatus": "indexed",
                        "externalOrderId": "platform-order-14",
                        "externalRequestSn": "request-sn-14",
                        "publishedUrl": "https://publisher.example.test/article-14",
                        "rawEvidence": {"status":12},
                    }),
                    "access-indexing" => json!({
                        "url":"https://publisher.example.test/article-14",
                        "httpStatus":200,
                        "accessible":true,
                        "indexingState":"indexed",
                        "platformStatusCode":12,
                        "rawEvidence":{"status":12},
                    }),
                    _ => json!({
                        "questionId":"question-14","engineId":"doubao",
                        "rawAnswer":"TOP 1：小鲸","rawEvidence":{"output":[]},
                        "sourceProviderSnapshot":{"model":"source-model-a","configurationFingerprint":"source-a"},
                        "providerSnapshot":{"model":"actual-model-b","configurationFingerprint":"actual-b"},
                        "citations":[],"analysis":{"brandMentioned":true,"brandRecommended":true,"hasCitationEvidence":false},
                        "rankPosition":1,"citedArticleIds":[],"citedUrls":[],
                    }),
                })
            })
        }
    }

    #[derive(Default)]
    struct MockTaskCompletion {
        completed: Mutex<Vec<String>>,
    }

    impl PostPublishMonitorScheduleCompletion for MockTaskCompletion {
        fn complete<'a>(&'a self, schedule_id: &'a str) -> MonitorCompletionFuture<'a> {
            Box::pin(async move {
                self.completed.lock().unwrap().push(schedule_id.to_string());
                Ok(())
            })
        }
    }

    #[derive(Default)]
    struct BlockingFirstPassHook {
        pass_count: AtomicUsize,
        first_pass_reached: tokio::sync::Notify,
        release_first_pass: tokio::sync::Notify,
        second_pass_finished: tokio::sync::Notify,
    }

    impl PostPublishMonitorPassHook for BlockingFirstPassHook {
        fn after_pass<'a>(&'a self) -> MonitorPassHookFuture<'a> {
            Box::pin(async move {
                let pass = self.pass_count.fetch_add(1, Ordering::SeqCst) + 1;
                if pass == 1 {
                    self.first_pass_reached.notify_one();
                    self.release_first_pass.notified().await;
                } else if pass == 2 {
                    self.second_pass_finished.notify_one();
                }
            })
        }
    }

    #[test]
    fn indexing_advisory_uses_real_platform_time_and_never_http_accessibility() {
        let published = "2030-03-17T00:00:00Z";
        let start = DateTime::parse_from_rfc3339(published)
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            indexing_state_from_platform(
                4,
                Some(published),
                start + 11 * 60 * 60 * 1_000 + 59 * 60 * 1_000
            ),
            "unknown"
        );
        assert_eq!(
            indexing_state_from_platform(4, Some(published), start + 12 * 60 * 60 * 1_000),
            "not-indexed"
        );
        assert_eq!(
            indexing_state_from_platform(11, None, start + 99 * 60 * 60 * 1_000),
            "unknown"
        );
        assert_eq!(
            indexing_state_from_platform(11, Some("invalid"), start + 99 * 60 * 60 * 1_000),
            "unknown"
        );
        assert_eq!(indexing_state_from_platform(12, None, start), "indexed");
        let absent = real_published_page_target("published", None).unwrap_err();
        assert_eq!(absent.code, "published-page-url-unavailable");
        // Even a frozen OSS audit URL or hypothetical OSS HTTP 200 is not an
        // input to this policy; only queryOrders record.url is accepted.
        assert_eq!(
            real_published_page_target("published", Some("https://publisher.example.test/a"))
                .unwrap()
                .host_str(),
            Some("publisher.example.test")
        );
    }

    #[tokio::test]
    async fn duplicate_wake_is_idempotent_and_uses_exact_frozen_references() {
        let (fixture, plan) = fixture(2);
        let due = fixture.now_ms + 15 * 60 * 1_000;
        let clock = Arc::new(AtomicI64::new(due));
        let provider = Arc::new(MockProvider::default());
        let schedule_completion = Arc::new(MockTaskCompletion::default());
        let clock_for_executor = Arc::clone(&clock);
        let executor = PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            provider.clone(),
            schedule_completion,
            Arc::new(move || clock_for_executor.load(Ordering::SeqCst)),
        );
        let monitor_context = context(&fixture, &plan.id);
        executor.run_context(&monitor_context).await.unwrap();
        executor.run_context(&monitor_context).await.unwrap();
        assert_eq!(provider.calls.lock().unwrap().len(), 3);
        let projection = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                due,
            )
            .unwrap();
        assert_eq!(projection.run_count, 1);
        let units = projection.latest_run.unwrap().units;
        assert_eq!(units.len(), 3);
        let baseline_evidence = units
            .iter()
            .find(|unit| unit.kind == "baseline-probe")
            .and_then(|unit| unit.evidence.as_ref())
            .expect("baseline evidence must survive the BrandWorkspace projection");
        assert_eq!(
            baseline_evidence["sourceProviderSnapshot"]["configurationFingerprint"],
            "source-a"
        );
        assert_eq!(
            baseline_evidence["providerSnapshot"]["configurationFingerprint"],
            "actual-b"
        );
        assert_eq!(baseline_evidence["rawEvidence"], json!({"output":[]}));
        let connection = open_database(&fixture.workspace).unwrap();
        let item: (String,String,String,String,String) = connection.query_row(
            "SELECT external_request_sn,external_order_id,idempotency_key,object_url,article_id FROM geo_post_publish_monitor_items WHERE plan_id=?1",
            [&plan.id],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?)),
        ).unwrap();
        assert_eq!(
            item,
            (
                "request-sn-14".into(),
                "platform-order-14".into(),
                "idem-14".into(),
                "https://oss.example.test/geo/object-14.md".into(),
                "article-14".into()
            )
        );
        let access_payload: String = connection.query_row("SELECT payload_json FROM geo_post_publish_monitor_units WHERE plan_id=?1 AND kind='access-indexing'", [&plan.id], |row| row.get(0)).unwrap();
        assert!(access_payload.contains("objectUrl"));
        assert!(!access_payload.contains("publishedUrl"));
        assert!(!access_payload.to_ascii_lowercase().contains("secret"));
        let wake = serde_json::to_value(PostPublishMonitorWakeReference {
            schema: WAKE_SCHEMA.into(),
            workspace_id: fixture.workspace.id,
            plan_id: plan.id,
        })
        .unwrap();
        assert_eq!(wake.as_object().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn frozen_competitor_names_flow_into_item_snapshots_and_probe_payloads() {
        let (fixture, plan) = fixture(2);
        // 监测 item 快照在 prepare 时即从冻结基线带走竞品名单（v1 基线行
        //  competitors_json 走列缺省 '[]'，本 fixture 显式携带一名竞品）。
        let connection = open_database(&fixture.workspace).unwrap();
        let snapshot: String = connection
            .query_row(
                "SELECT snapshot_json FROM geo_post_publish_monitor_items WHERE plan_id=?1",
                [&plan.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&snapshot).unwrap()["competitorNames"],
            json!(["声浪坊"])
        );
        drop(connection);

        let due = fixture.now_ms + 15 * 60 * 1_000;
        let executor = PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            Arc::new(MockProvider::default()),
            Arc::new(MockTaskCompletion::default()),
            Arc::new(move || due),
        );
        executor
            .run_context(&context(&fixture, &plan.id))
            .await
            .unwrap();

        let connection = open_database(&fixture.workspace).unwrap();
        let payload: String = connection
            .query_row(
                "SELECT payload_json FROM geo_post_publish_monitor_units
                 WHERE plan_id=?1 AND kind='baseline-probe'",
                [&plan.id],
                |row| row.get(0),
            )
            .unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["brandNames"], json!(["小鲸"]));
        assert_eq!(payload["competitorNames"], json!(["声浪坊"]));
    }

    #[tokio::test]
    async fn wake_during_idle_exit_is_coalesced_and_retries_only_the_exact_unit() {
        let (fixture, plan) = fixture(3);
        let due = fixture.now_ms + 15 * 60 * 1_000;
        let provider = Arc::new(MockProvider::default());
        let hook = Arc::new(BlockingFirstPassHook::default());
        let executor = Arc::new(
            PostPublishMonitorExecutor::new(
                fixture.store.clone(),
                provider.clone(),
                Arc::new(MockTaskCompletion::default()),
                Arc::new(move || due),
            )
            .with_after_pass_hook(hook.clone()),
        );
        let monitor_context = context(&fixture, &plan.id);
        assert!(executor.accept(monitor_context.clone()));
        hook.first_pass_reached.notified().await;

        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute(
                "UPDATE geo_post_publish_monitor_units
                 SET status='failed',revision=revision+1,evidence_json=NULL,observed_at=NULL,
                     error_code='fixture-retry',error_message='fixture retry race'
                 WHERE plan_id=?1 AND kind='access-indexing'",
                [&plan.id],
            )
            .unwrap();
        let (target_id, target_revision): (String, i64) = connection
            .query_row(
                "SELECT id,revision FROM geo_post_publish_monitor_units
                 WHERE plan_id=?1 AND kind='access-indexing'",
                [&plan.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        drop(connection);
        fixture
            .store
            .retry_post_publish_monitor_unit(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorRetryRequest {
                    plan_id: plan.id.clone(),
                    unit_id: target_id.clone(),
                    expected_unit_revision: target_revision,
                },
                due,
            )
            .unwrap();
        assert!(!executor.accept(monitor_context));
        hook.release_first_pass.notify_one();
        hook.second_pass_finished.notified().await;

        let projection = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                due,
            )
            .unwrap();
        let units = &projection.latest_run.unwrap().units;
        let target = units.iter().find(|unit| unit.id == target_id).unwrap();
        assert_eq!(target.status, "succeeded");
        assert_eq!(target.attempt_number, 2);
        assert!(units
            .iter()
            .filter(|unit| unit.id != target_id)
            .all(|unit| unit.attempt_number == 1));
        assert_eq!(
            provider.calls.lock().unwrap().as_slice(),
            [
                "publish-status",
                "access-indexing",
                "baseline-probe",
                "access-indexing"
            ]
        );
    }

    #[tokio::test]
    async fn another_brand_session_reads_bounded_exact_history_and_source_operation() {
        let (fixture, plan) = fixture(3);
        fixture
            .store
            .commit_session(
                &fixture.workspace.id,
                SessionCommit {
                    id: "session-14-b".to_string(),
                    title: "监测复盘".to_string(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let first_due = fixture.now_ms + 15 * 60 * 1_000;
        let clock = Arc::new(AtomicI64::new(first_due));
        let provider = Arc::new(MockProvider::default());
        let clock_for_executor = Arc::clone(&clock);
        let executor = PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            provider,
            Arc::new(MockTaskCompletion::default()),
            Arc::new(move || clock_for_executor.load(Ordering::SeqCst)),
        );
        let monitor_context = context(&fixture, &plan.id);
        executor.run_context(&monitor_context).await.unwrap();
        clock.store(first_due + 15 * 60 * 1_000, Ordering::SeqCst);
        executor.run_context(&monitor_context).await.unwrap();

        let from_session_b = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14-b",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                clock.load(Ordering::SeqCst),
            )
            .unwrap();
        assert_eq!(from_session_b.created_by_session_id, "session-14");
        assert_eq!(from_session_b.source_operation_id, "publish-op-14");
        assert_eq!(
            from_session_b
                .recent_runs
                .iter()
                .map(|run| run.ordinal)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(
            from_session_b.latest_run.as_ref().map(|run| run.ordinal),
            Some(2)
        );
        assert!(from_session_b.recent_runs.len() <= RECENT_RUN_LIMIT);
    }

    #[test]
    fn stale_lease_recovers_attempt_and_only_reclaims_that_unit() {
        let (fixture, plan) = fixture(2);
        let due = fixture.now_ms + 15 * 60 * 1_000;
        let monitor_context = context(&fixture, &plan.id);
        create_due_run(&fixture.workspace, &monitor_context, due).unwrap();
        let first = claim_next_unit(&fixture.workspace, &monitor_context, due)
            .unwrap()
            .unwrap();
        let restarting_projection = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                due + CLAIM_LEASE_MS,
            )
            .unwrap();
        assert_eq!(restarting_projection.recovery_state, "recovering");
        recover_expired_units(&fixture.workspace, &plan.id, due + CLAIM_LEASE_MS).unwrap();
        let second = claim_next_unit(&fixture.workspace, &monitor_context, due + CLAIM_LEASE_MS)
            .unwrap()
            .unwrap();
        assert_eq!(second.id, first.id);
        let connection = open_database(&fixture.workspace).unwrap();
        let attempts: Vec<String> = {
            let mut statement = connection.prepare("SELECT status FROM geo_post_publish_monitor_attempts WHERE unit_id=?1 ORDER BY attempt_number").unwrap();
            statement
                .query_map([&first.id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(attempts, vec!["failed", "running"]);
    }

    #[test]
    fn exact_unit_retry_cas_leaves_sibling_unchanged_and_is_due_immediately() {
        let (fixture, plan) = fixture(2);
        let due = fixture.now_ms + 15 * 60 * 1_000;
        create_due_run(&fixture.workspace, &context(&fixture, &plan.id), due).unwrap();
        let connection = open_database(&fixture.workspace).unwrap();
        connection.execute("UPDATE geo_post_publish_monitor_units SET status='failed',revision=2,error_code='fixture',error_message='fixture' WHERE kind IN ('publish-status','access-indexing')", []).unwrap();
        let units: Vec<(String, String)> = {
            let mut statement = connection.prepare("SELECT id,kind FROM geo_post_publish_monitor_units WHERE kind IN ('publish-status','access-indexing') ORDER BY kind").unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        drop(connection);
        let target = &units[0];
        let sibling = &units[1];
        fixture
            .store
            .retry_post_publish_monitor_unit(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorRetryRequest {
                    plan_id: plan.id.clone(),
                    unit_id: target.0.clone(),
                    expected_unit_revision: 2,
                },
                due + 1,
            )
            .unwrap();
        let connection = open_database(&fixture.workspace).unwrap();
        let target_state: (i64,Option<i64>) = connection.query_row("SELECT revision,next_attempt_at_ms FROM geo_post_publish_monitor_units WHERE id=?1", [&target.0], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        let sibling_state: (i64,Option<i64>) = connection.query_row("SELECT revision,next_attempt_at_ms FROM geo_post_publish_monitor_units WHERE id=?1", [&sibling.0], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(target_state, (3, Some(due + 1)));
        assert_eq!(sibling_state, (2, None));
        drop(connection);
        let reclaimed = claim_next_unit(&fixture.workspace, &context(&fixture, &plan.id), due + 1)
            .unwrap()
            .unwrap();
        assert_eq!(reclaimed.id, target.0);
    }

    #[tokio::test]
    async fn max_runs_completes_brand_plan_stops_task_and_prevents_future_runs() {
        let (fixture, plan) = fixture(1);
        let due = fixture.now_ms + 15 * 60 * 1_000;
        let monitor_context = context(&fixture, &plan.id);
        let provider = Arc::new(MockProvider::default());
        let schedule_completion = Arc::new(MockTaskCompletion::default());
        let executor = PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            provider.clone(),
            schedule_completion.clone(),
            Arc::new(move || due),
        );
        executor.run_context(&monitor_context).await.unwrap();
        assert!(monitor_plan_completed(&fixture.workspace, &plan.id).unwrap());
        assert_eq!(provider.calls.lock().unwrap().len(), 3);
        assert_eq!(
            schedule_completion.completed.lock().unwrap().as_slice(),
            ["managed-task-14"]
        );
        assert!(create_due_run(
            &fixture.workspace,
            &monitor_context,
            due + 99 * 60 * 60 * 1_000
        )
        .unwrap()
        .is_none());
        let connection = open_database(&fixture.workspace).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM geo_post_publish_monitor_runs WHERE plan_id=?1",
                [&plan.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn deadline_stops_task_without_arming_an_observation_run() {
        let (fixture, plan) = fixture(9);
        let due = fixture.now_ms + 15 * 60 * 1_000;
        let connection = open_database(&fixture.workspace).unwrap();
        connection
            .execute(
                "UPDATE geo_post_publish_monitor_plans SET end_conditions_json=?2 WHERE id=?1",
                params![
                    plan.id,
                    serde_json::to_string(&PostPublishMonitorEndConditions {
                        deadline: Some(due),
                        max_runs: Some(9),
                    })
                    .unwrap()
                ],
            )
            .unwrap();
        drop(connection);
        let provider = Arc::new(MockProvider::default());
        let schedule_completion = Arc::new(MockTaskCompletion::default());
        PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            provider.clone(),
            schedule_completion.clone(),
            Arc::new(move || due),
        )
        .run_context(&context(&fixture, &plan.id))
        .await
        .unwrap();
        assert!(provider.calls.lock().unwrap().is_empty());
        assert_eq!(
            schedule_completion.completed.lock().unwrap().as_slice(),
            ["managed-task-14"]
        );
        let connection = open_database(&fixture.workspace).unwrap();
        let run_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM geo_post_publish_monitor_runs WHERE plan_id=?1",
                [&plan.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(run_count, 0);
    }

    #[test]
    fn gateway_order_observation_maps_typed_gateway_records() {
        // 网关时代订单：查单路由回 typed 条目（sn 为票 08 派生口径），
        // 观察映射沿用平台状态机与发布页 URL 语义。
        let matched = json!({
            "sn": "xj-0123456789abcdef0123456789abcdef",
            "status": 12,
            "url": " https://publisher.example.test/article-14 ",
            "screenshot": null,
            "publishedAt": "2030-01-01T00:00:00Z",
            "feedback": null,
        });
        let observed =
            parse_gateway_order_observation(&json!({"record": matched.clone()})).unwrap();
        assert_eq!(observed.status_code, 12);
        assert_eq!(observed.status, "indexed");
        assert_eq!(
            observed.published_url.as_deref(),
            Some("https://publisher.example.test/article-14")
        );
        assert_eq!(observed.record, matched);
        // 网关尚未观察到该 sn：record 为 null → 可重试的“尚未返回”。
        let missing = parse_gateway_order_observation(&json!({"record": null})).unwrap_err();
        assert_eq!(missing.code, "distribution-order-unavailable");
        assert!(missing.retryable);
        let unknown =
            parse_gateway_order_observation(&json!({"record": {"status": 99}})).unwrap_err();
        assert_eq!(unknown.code, "distribution-order-status-unknown");
    }

    /// 基线巡检按可开关的余额门失败一次（sidecar 402 insufficient_balance
    /// 的 Rust 侧形态：非重试），恢复后成功——用于暂停/恢复流转。
    struct PatrolGatedProvider {
        calls: Mutex<Vec<String>>,
        insufficient: AtomicBool,
    }

    impl PostPublishMonitorProvider for PatrolGatedProvider {
        fn observe<'a>(
            &'a self,
            _workspace: &'a BrandWorkspace,
            unit: &'a ClaimedMonitorUnit,
        ) -> MonitorFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(unit.kind.clone());
                match unit.kind.as_str() {
                    "publish-status" => Ok(json!({
                        "platformStatusCode": 3,
                        "platformStatus": "submitted",
                        "externalOrderId": "platform-order-14",
                        "externalRequestSn": "request-sn-14",
                        "rawEvidence": {"status":3},
                    })),
                    "access-indexing" => Ok(json!({
                        "url":"https://publisher.example.test/article-14",
                        "httpStatus":200,
                        "accessible":true,
                        "indexingState":"unknown",
                        "platformStatusCode":3,
                        "rawEvidence":{"status":3},
                    })),
                    _ => {
                        if self.insufficient.load(Ordering::SeqCst) {
                            Err(MonitorProviderFailure {
                                code: "insufficient_balance".to_string(),
                                message: "点数不足：监测巡检需 5 点，当前可用 2 点".to_string(),
                                retryable: false,
                            })
                        } else {
                            Ok(json!({
                                "questionId":"question-14","engineId":"doubao",
                                "rawAnswer":"TOP 1：小鲸","rawEvidence":{"output":[]},
                                "sourceProviderSnapshot":{"model":"a","configurationFingerprint":"a"},
                                "providerSnapshot":{"model":"b","configurationFingerprint":"b"},
                                "citations":[],"analysis":{"brandMentioned":true,"brandRecommended":true,"hasCitationEvidence":false},
                                "rankPosition":1,"citedArticleIds":[],"citedUrls":[],
                            }))
                        }
                    }
                }
            })
        }
    }

    /// 可切换的余额探测：false = 仍不足/不可判定，true = 已充值恢复。
    struct SwitchableBalanceProbe(AtomicBool);

    impl PostPublishMonitorBalanceProbe for SwitchableBalanceProbe {
        fn sufficient_for_patrol<'a>(
            &'a self,
            _workspace: &'a BrandWorkspace,
            _context: &'a MonitorPlanContext,
        ) -> MonitorBalanceProbeFuture<'a> {
            Box::pin(async move { Ok(self.0.load(Ordering::SeqCst)) })
        }
    }

    #[tokio::test]
    async fn insufficient_balance_pauses_plan_persists_and_skips_later_wakes() {
        let (fixture, plan) = fixture(9);
        let first_due = fixture.now_ms + 15 * 60 * 1_000;
        let clock = Arc::new(AtomicI64::new(first_due));
        let provider = Arc::new(PatrolGatedProvider {
            calls: Mutex::new(Vec::new()),
            insufficient: AtomicBool::new(true),
        });
        let balance = Arc::new(SwitchableBalanceProbe(AtomicBool::new(false)));
        let clock_for_executor = Arc::clone(&clock);
        let executor = PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            provider.clone(),
            Arc::new(MockTaskCompletion::default()),
            Arc::new(move || clock_for_executor.load(Ordering::SeqCst)),
        )
        .with_balance_probe(balance);
        let monitor_context = context(&fixture, &plan.id);

        // 首轮：查单/访问单元成功，巡检预检 402 → 单元非重试失败，计划落 paused。
        executor.run_context(&monitor_context).await.unwrap();
        assert_eq!(
            provider.calls.lock().unwrap().as_slice(),
            ["publish-status", "access-indexing", "baseline-probe"]
        );
        let paused = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                first_due,
            )
            .unwrap();
        assert_eq!(paused.status, "paused");
        assert_eq!(paused.recovery_state, "paused");
        // 中断轮按 partial 收尾，巡检单元恰好一次尝试（暂停后零新尝试）。
        assert_eq!(paused.latest_run.as_ref().unwrap().status, "partial");

        // 暂停中的扫描 tick（锚点未到）：不探测、不 claim、不产生任何调用。
        clock.store(first_due + 60_000, Ordering::SeqCst);
        executor.run_context(&monitor_context).await.unwrap();
        assert_eq!(provider.calls.lock().unwrap().len(), 3);

        // 到期锚点：只读余额预检仍不足 → 保持 paused、锚点顺延、零扣点
        // （无 permit 即无扣费；这里以“零巡检尝试”钉住）。
        clock.store(fixture.now_ms + 30 * 60 * 1_000, Ordering::SeqCst);
        executor.run_context(&monitor_context).await.unwrap();
        assert_eq!(provider.calls.lock().unwrap().len(), 3);
        let still_paused = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                clock.load(Ordering::SeqCst),
            )
            .unwrap();
        assert_eq!(still_paused.status, "paused");
        assert_eq!(still_paused.run_count, 1);
        let connection = open_database(&fixture.workspace).unwrap();
        let patrol_attempts: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM geo_post_publish_monitor_attempts
                 WHERE unit_id IN (SELECT id FROM geo_post_publish_monitor_units
                                   WHERE plan_id=?1 AND kind='baseline-probe')",
                [&plan.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(patrol_attempts, 1);
    }

    #[tokio::test]
    async fn recharged_balance_resumes_the_paused_plan_at_the_next_anchor() {
        let (fixture, plan) = fixture(9);
        let first_due = fixture.now_ms + 15 * 60 * 1_000;
        let clock = Arc::new(AtomicI64::new(first_due));
        let provider = Arc::new(PatrolGatedProvider {
            calls: Mutex::new(Vec::new()),
            insufficient: AtomicBool::new(true),
        });
        let balance = Arc::new(SwitchableBalanceProbe(AtomicBool::new(false)));
        let clock_for_executor = Arc::clone(&clock);
        let executor = PostPublishMonitorExecutor::new(
            fixture.store.clone(),
            provider.clone(),
            Arc::new(MockTaskCompletion::default()),
            Arc::new(move || clock_for_executor.load(Ordering::SeqCst)),
        )
        .with_balance_probe(balance.clone());
        let monitor_context = context(&fixture, &plan.id);
        executor.run_context(&monitor_context).await.unwrap();

        // 锚点顺延到 +30m；充值（余额门恢复）后下一锚点自动恢复巡检。
        clock.store(fixture.now_ms + 30 * 60 * 1_000, Ordering::SeqCst);
        executor.run_context(&monitor_context).await.unwrap();
        assert_eq!(provider.calls.lock().unwrap().len(), 3);

        balance.0.store(true, Ordering::SeqCst);
        provider.insufficient.store(false, Ordering::SeqCst);
        clock.store(fixture.now_ms + 45 * 60 * 1_000 + 1_000, Ordering::SeqCst);
        executor.run_context(&monitor_context).await.unwrap();

        let resumed = fixture
            .store
            .get_post_publish_monitor_plan(
                &fixture.workspace.id,
                "session-14",
                PostPublishMonitorGetRequest {
                    plan_id: plan.id.clone(),
                },
                clock.load(Ordering::SeqCst),
            )
            .unwrap();
        assert_eq!(resumed.status, "active");
        assert_eq!(resumed.recovery_state, "ready");
        assert_eq!(resumed.run_count, 2);
        assert_eq!(provider.calls.lock().unwrap().len(), 6);
        assert_eq!(resumed.latest_run.as_ref().unwrap().status, "succeeded");
        let connection = open_database(&fixture.workspace).unwrap();
        let operation_state: String = connection
            .query_row(
                "SELECT state FROM geo_operations WHERE id=?1",
                [&resumed.operation_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(operation_state, "monitor-active");
    }

    #[test]
    fn legacy_plan_status_check_is_rebuilt_to_accept_paused() {
        let temp = tempdir().unwrap();
        let connection = Connection::open(temp.path().join("legacy-monitor.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE geo_post_publish_monitor_plans (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK(status IN ('draft','active','completed','provisioning-failed')),
                    revision INTEGER NOT NULL,
                    next_run_at_ms INTEGER
                 );
                 CREATE INDEX geo_monitor_plan_latest
                    ON geo_post_publish_monitor_plans(revision, id);
                 INSERT INTO geo_post_publish_monitor_plans VALUES ('plan-legacy','active',3,100);",
            )
            .unwrap();
        ensure_schema(&connection).unwrap();
        // 行与索引在重建后原样保留，且新的 paused 状态可持久写入。
        let (status, revision): (String, i64) = connection
            .query_row(
                "SELECT status,revision FROM geo_post_publish_monitor_plans WHERE id='plan-legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), revision), ("active", 3));
        let index_present: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type='index' AND tbl_name='geo_post_publish_monitor_plans'
                   AND name='geo_monitor_plan_latest'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_present, 1);
        connection
            .execute(
                "UPDATE geo_post_publish_monitor_plans SET status='paused' WHERE id='plan-legacy'",
                [],
            )
            .unwrap();
        // 已含 widened CHECK 的库重复执行迁移是幂等 no-op。
        widen_monitor_plan_status_check(&connection).unwrap();
    }

    // ── postPublishMonitoring 契约（票 #41，ADR-0012）：共享裁判 JSON 的
    // Rust pin（与 TS 侧 postPublishMonitoring.test.ts 的 import pin 同一裁判文件）。

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PostPublishMonitorContract {
        policy_version: String,
    }

    #[test]
    fn post_publish_monitor_contract_pins_constants() {
        let contract: PostPublishMonitorContract = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/geo/postPublishMonitoringContract.json"
        )))
        .expect("shared post publish monitoring contract json");
        assert_eq!(
            contract.policy_version, POLICY_VERSION,
            "发布后监测策略版本戳；ADR-0012 Decision 2 只钉当前值"
        );
    }
}
