// 产物血缘（Artifact Lineage）唯一写入者（ADR-0013 / spec 2026-09-04）。
//
// geo_operations 一表两聚合：主链 GeoOperation 状态机（geo_operations.rs，
// kind!='artifact-lineage'）与各域产物血缘行（kind='artifact-lineage'，
// 行 id 即该域操作 id）。血缘的全部写（INSERT 四列＋UPDATE state 单列）
// 只允许发生在本模块与主链模块——vitest 守卫棘轮（见
// src/shared/crossLanguageContractGuard.test.ts）按此 allowlist 扫描生产段
// SQL，现存 7 域 27 处直写登记在豁免表、逐域清零、终态零豁免。
//
// 本模块是等价搬家的第一站：31 态词表首次单源，数据库值一字不改；
// 各域清零票把写点迁到 open_lineage/set_lineage_state 上，并逐族补
// from-state 迁移规则（错误码约定：artifact_lineage_transition_invalid:{from}，
// 镜像主链 geo_operation_transition_invalid:{current} 风格）。baseline 族
// 已随票 02 清零（写点迁移＋from 规则钉死），其余 6 域 25 处直写仍在豁免表。
use std::fmt;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

/// 血缘状态词表：7 域 31 态单源枚举（域前缀 PascalCase 变体），kebab 串
/// 与现状逐字相同（数据库值一字不改——ADR-0013 等价搬家红线，词表钉测试
/// 在同文件 #[cfg(test)] 断言 ALL 恰 31 态且映射不漂）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtifactLineageState {
    BaselineRunning,
    BaselineSucceeded,
    BaselinePartial,
    BaselineFailed,
    QuestionPoolGenerating,
    QuestionPoolAwaitingSelection,
    QuestionPoolConfirmed,
    TopicPlanAwaitingConfirmation,
    TopicPlanConfirmed,
    ArticleGenerationRunning,
    ArticleGenerationCompleted,
    ArticleGenerationCompletedWithFailures,
    DistributionDiscovering,
    DistributionUnavailable,
    DistributionPlanDraft,
    DistributionPlanConfirmed,
    PublishAwaitingConfirmation,
    PublishConfirmed,
    PublishExecuting,
    PublishScheduled,
    PublishCancelled,
    PublishPreviewSuperseded,
    PublishReconciliationRequired,
    PublishSucceeded,
    PublishPartiallySucceeded,
    PublishFailed,
    PublishRunning,
    MonitorDraft,
    MonitorActive,
    MonitorPaused,
    MonitorCompleted,
}

impl ArtifactLineageState {
    /// 全词表常量表（镜像主链 OPERATION_STATUSES 的单源风格）。
    pub const ALL: [Self; 31] = [
        Self::BaselineRunning,
        Self::BaselineSucceeded,
        Self::BaselinePartial,
        Self::BaselineFailed,
        Self::QuestionPoolGenerating,
        Self::QuestionPoolAwaitingSelection,
        Self::QuestionPoolConfirmed,
        Self::TopicPlanAwaitingConfirmation,
        Self::TopicPlanConfirmed,
        Self::ArticleGenerationRunning,
        Self::ArticleGenerationCompleted,
        Self::ArticleGenerationCompletedWithFailures,
        Self::DistributionDiscovering,
        Self::DistributionUnavailable,
        Self::DistributionPlanDraft,
        Self::DistributionPlanConfirmed,
        Self::PublishAwaitingConfirmation,
        Self::PublishConfirmed,
        Self::PublishExecuting,
        Self::PublishScheduled,
        Self::PublishCancelled,
        Self::PublishPreviewSuperseded,
        Self::PublishReconciliationRequired,
        Self::PublishSucceeded,
        Self::PublishPartiallySucceeded,
        Self::PublishFailed,
        Self::PublishRunning,
        Self::MonitorDraft,
        Self::MonitorActive,
        Self::MonitorPaused,
        Self::MonitorCompleted,
    ];

    /// 所属域（豁免表按域登记、清零票按域消项的分组轴）。
    pub fn family(self) -> &'static str {
        match self {
            Self::BaselineRunning
            | Self::BaselineSucceeded
            | Self::BaselinePartial
            | Self::BaselineFailed => "baseline",
            Self::QuestionPoolGenerating
            | Self::QuestionPoolAwaitingSelection
            | Self::QuestionPoolConfirmed => "question-pool",
            Self::TopicPlanAwaitingConfirmation | Self::TopicPlanConfirmed => "topic-plan",
            Self::ArticleGenerationRunning
            | Self::ArticleGenerationCompleted
            | Self::ArticleGenerationCompletedWithFailures => "article-generation",
            Self::DistributionDiscovering
            | Self::DistributionUnavailable
            | Self::DistributionPlanDraft
            | Self::DistributionPlanConfirmed => "distribution",
            Self::PublishAwaitingConfirmation
            | Self::PublishConfirmed
            | Self::PublishExecuting
            | Self::PublishScheduled
            | Self::PublishCancelled
            | Self::PublishPreviewSuperseded
            | Self::PublishReconciliationRequired
            | Self::PublishSucceeded
            | Self::PublishPartiallySucceeded
            | Self::PublishFailed
            | Self::PublishRunning => "publish",
            Self::MonitorDraft
            | Self::MonitorActive
            | Self::MonitorPaused
            | Self::MonitorCompleted => "monitor",
        }
    }

    /// 数据库存储串（现状 kebab 值，搬家不改一字）。
    pub fn kebab(self) -> &'static str {
        match self {
            Self::BaselineRunning => "baseline-running",
            Self::BaselineSucceeded => "baseline-succeeded",
            Self::BaselinePartial => "baseline-partial",
            Self::BaselineFailed => "baseline-failed",
            Self::QuestionPoolGenerating => "question-pool-generating",
            Self::QuestionPoolAwaitingSelection => "question-pool-awaiting-selection",
            Self::QuestionPoolConfirmed => "question-pool-confirmed",
            Self::TopicPlanAwaitingConfirmation => "topic-plan-awaiting-confirmation",
            Self::TopicPlanConfirmed => "topic-plan-confirmed",
            Self::ArticleGenerationRunning => "article-generation-running",
            Self::ArticleGenerationCompleted => "article-generation-completed",
            Self::ArticleGenerationCompletedWithFailures => {
                "article-generation-completed-with-failures"
            }
            Self::DistributionDiscovering => "distribution-discovering",
            Self::DistributionUnavailable => "distribution-unavailable",
            Self::DistributionPlanDraft => "distribution-plan-draft",
            Self::DistributionPlanConfirmed => "distribution-plan-confirmed",
            Self::PublishAwaitingConfirmation => "publish-awaiting-confirmation",
            Self::PublishConfirmed => "publish-confirmed",
            Self::PublishExecuting => "publish-executing",
            Self::PublishScheduled => "publish-scheduled",
            Self::PublishCancelled => "publish-cancelled",
            Self::PublishPreviewSuperseded => "publish-preview-superseded",
            Self::PublishReconciliationRequired => "publish-reconciliation-required",
            Self::PublishSucceeded => "publish-succeeded",
            Self::PublishPartiallySucceeded => "publish-partially-succeeded",
            Self::PublishFailed => "publish-failed",
            Self::PublishRunning => "publish-running",
            Self::MonitorDraft => "monitor-draft",
            Self::MonitorActive => "monitor-active",
            Self::MonitorPaused => "monitor-paused",
            Self::MonitorCompleted => "monitor-completed",
        }
    }

    /// 解析数据库串为词表成员；非成员返回 None（写入方据此拒绝）。
    pub fn from_kebab(value: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|state| state.kebab() == value)
    }

    /// 目标态的合法 from 集：已钉 from-state 规则的族返回 Some，未登记族
    /// 返回 None＝暂无 from 校验（spec 决策 6：谁迁移谁钉，规则来自真实
    /// 代码；None 族随各自清零票转 Some，不预先编规则）。
    ///
    /// baseline 族（票 02，按 geo_baselines.rs 真实代码钉）：
    /// - running/succeeded/partial 的 from 集＝{running, partial, failed}
    ///   ——claim 不写血缘行，retry 期间行仍留 partial/failed，下一次
    ///   finish 聚合直接覆盖（partial→succeeded 真实存在：唯一失败单元
    ///   重试成功即全成；partial/failed→running 来自多失败单元并行重试）；
    /// - failed 额外排除 from partial——partial 蕴含 ≥1 单元已 succeeded
    ///   且不可复活，聚合回不到全败；
    /// - succeeded 是终态，不在任何目标态的 from 集里——全成后所有
    ///   claim 均 cached，无 finish 可再迁移。
    fn allowed_from(target: Self) -> Option<&'static [Self]> {
        const RUNNING_PARTIAL_FAILED: &[ArtifactLineageState] = &[
            ArtifactLineageState::BaselineRunning,
            ArtifactLineageState::BaselinePartial,
            ArtifactLineageState::BaselineFailed,
        ];
        match target {
            Self::BaselineRunning | Self::BaselineSucceeded | Self::BaselinePartial => {
                Some(RUNNING_PARTIAL_FAILED)
            }
            Self::BaselineFailed => Some(&[
                ArtifactLineageState::BaselineRunning,
                ArtifactLineageState::BaselineFailed,
            ]),
            _ => None,
        }
    }
}

impl fmt::Display for ArtifactLineageState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.kebab())
    }
}

fn parse_lineage_state(state: &str) -> Result<ArtifactLineageState, String> {
    ArtifactLineageState::from_kebab(state)
        .ok_or_else(|| format!("artifact_lineage_state_invalid:{state}"))
}

/// 开一行血缘（INSERT 四列，kind 走列默认 'artifact-lineage'）。
/// 等价搬家语义：重复 id 报错（现主键冲突行为），不做幂等化收紧——
/// 收紧与否属各域清零票按调用方真实期望裁决。
pub fn open_lineage(
    connection: &Connection,
    id: &str,
    session_id: &str,
    state: &str,
) -> Result<(), String> {
    let state = parse_lineage_state(state)?;
    connection
        .execute(
            "INSERT INTO geo_operations (id, session_id, state, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, session_id, state.kebab(), Utc::now().to_rfc3339()],
        )
        .map_err(|error| format!("open artifact lineage: {error}"))?;
    Ok(())
}

/// 迁移一行血缘的 state（UPDATE 单列）。
/// 等价搬家语义：缺失行 no-op（现 UPDATE 影响 0 行被忽略的行为，如
/// retry 复活分支）；状态串必须是词表成员，否则
/// `artifact_lineage_state_invalid:{state}`。from-state 规则随各域清零票
/// 逐族补齐（谁迁移谁钉，规则来自真实代码）；已钉族迁错方向报
/// `artifact_lineage_transition_invalid:{current}`，未钉族保持无 from 校验。
pub fn set_lineage_state(connection: &Connection, id: &str, state: &str) -> Result<(), String> {
    let target = parse_lineage_state(state)?;
    if let Some(allowed) = ArtifactLineageState::allowed_from(target) {
        // 缺失行 no-op 先于 from 校验（保持 UPDATE 0 行被忽略的行为）；
        // 现态非词表成员（含跨族串）自然落出 from 集 → transition_invalid。
        let current: Option<String> = connection
            .query_row(
                "SELECT state FROM geo_operations WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| format!("read artifact lineage state: {error}"))?;
        let Some(current) = current else {
            return Ok(());
        };
        if !allowed.iter().any(|from| from.kebab() == current) {
            return Err(format!("artifact_lineage_transition_invalid:{current}"));
        }
    }
    connection
        .execute(
            "UPDATE geo_operations SET state=?2 WHERE id=?1",
            params![id, target.kebab()],
        )
        .map_err(|error| format!("set artifact lineage state: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand_workspace::{
        open_database, BrandWorkspace, BrandWorkspaceStore, SessionCommit, SessionTitleSource,
    };
    use tempfile::tempdir;

    // 现状 31 态逐字清单（2026-09-04 全仓盘点）：词表钉的第一面——枚举
    // 搬家不得改名任何数据库串；第二面（ALL 恰 31、族划分）在下方断言。
    const CURRENT_DB_VALUES: [&str; 31] = [
        "baseline-running",
        "baseline-succeeded",
        "baseline-partial",
        "baseline-failed",
        "question-pool-generating",
        "question-pool-awaiting-selection",
        "question-pool-confirmed",
        "topic-plan-awaiting-confirmation",
        "topic-plan-confirmed",
        "article-generation-running",
        "article-generation-completed",
        "article-generation-completed-with-failures",
        "distribution-discovering",
        "distribution-unavailable",
        "distribution-plan-draft",
        "distribution-plan-confirmed",
        "publish-awaiting-confirmation",
        "publish-confirmed",
        "publish-executing",
        "publish-scheduled",
        "publish-cancelled",
        "publish-preview-superseded",
        "publish-reconciliation-required",
        "publish-succeeded",
        "publish-partially-succeeded",
        "publish-failed",
        "publish-running",
        "monitor-draft",
        "monitor-active",
        "monitor-paused",
        "monitor-completed",
    ];

    const FAMILY_SIZES: [(&str, usize); 7] = [
        ("baseline", 4),
        ("question-pool", 3),
        ("topic-plan", 2),
        ("article-generation", 3),
        ("distribution", 4),
        ("publish", 11),
        ("monitor", 4),
    ];

    #[test]
    fn vocabulary_is_exactly_the_31_current_db_values() {
        assert_eq!(ArtifactLineageState::ALL.len(), 31);
        let actual = ArtifactLineageState::ALL
            .iter()
            .map(|state| state.kebab())
            .collect::<Vec<_>>();
        assert_eq!(actual, CURRENT_DB_VALUES, "词表搬家不得改名任何数据库串");
        for value in CURRENT_DB_VALUES {
            assert_eq!(
                ArtifactLineageState::from_kebab(value)
                    .map(|state| state.to_string())
                    .as_deref(),
                Some(value),
                "from_kebab 与 kebab 必须逐值往返"
            );
        }
    }

    #[test]
    fn families_partition_the_vocabulary() {
        let mut sizes = std::collections::BTreeMap::new();
        for state in ArtifactLineageState::ALL {
            *sizes.entry(state.family()).or_insert(0usize) += 1;
        }
        assert_eq!(
            sizes,
            FAMILY_SIZES
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>(),
            "7 域族划分按盘点钉死：新态必须先登记族，孤儿态直接红灯"
        );
    }

    fn connection() -> (BrandWorkspaceStore, BrandWorkspace, Connection) {
        let root = tempdir().unwrap().keep();
        let store = BrandWorkspaceStore::at(root.join("Xiaojing"));
        let workspace = store.create_workspace("血缘测试品牌", vec![]).unwrap();
        store
            .commit_session(
                &workspace.id,
                SessionCommit {
                    id: "session-lineage".into(),
                    title: "血缘".into(),
                    title_source: SessionTitleSource::User,
                },
            )
            .unwrap();
        let connection = open_database(&workspace).unwrap();
        (store, workspace, connection)
    }

    fn lineage_row(connection: &Connection, id: &str) -> (String, String) {
        connection
            .query_row(
                "SELECT state, kind FROM geo_operations WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    #[test]
    fn open_lineage_inserts_a_default_kind_row_and_rejects_duplicate_ids() {
        let (_store, _workspace, connection) = connection();
        open_lineage(&connection, "op-1", "session-lineage", "baseline-running").unwrap();
        assert_eq!(
            lineage_row(&connection, "op-1"),
            ("baseline-running".into(), "artifact-lineage".into())
        );
        assert!(
            open_lineage(&connection, "op-1", "session-lineage", "baseline-succeeded").is_err(),
            "重复 id 必须报错（现主键冲突行为，不做幂等化收紧）"
        );
        assert_eq!(
            lineage_row(&connection, "op-1"),
            ("baseline-running".into(), "artifact-lineage".into()),
            "失败的重复开行不得改写既有行"
        );
    }

    #[test]
    fn open_lineage_rejects_states_outside_the_vocabulary() {
        let (_store, _workspace, connection) = connection();
        let error =
            open_lineage(&connection, "op-2", "session-lineage", "baseline-wip").unwrap_err();
        assert!(
            error.starts_with("artifact_lineage_state_invalid:"),
            "错误码镜像 geo_operation_transition_invalid 风格，实际：{error}"
        );
        assert!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM geo_operations WHERE id='op-2'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
                == 0,
            "非法串必须在写入前被拒"
        );
    }

    #[test]
    fn set_lineage_state_updates_noop_on_missing_rows_and_rejects_invalid_states() {
        let (_store, _workspace, connection) = connection();
        open_lineage(&connection, "op-3", "session-lineage", "monitor-draft").unwrap();
        set_lineage_state(&connection, "op-3", "monitor-active").unwrap();
        assert_eq!(lineage_row(&connection, "op-3").0, "monitor-active");
        // 缺失行 no-op（现 UPDATE 0 行被忽略的行为，如 retry 复活分支）。
        set_lineage_state(&connection, "missing-op", "monitor-paused").unwrap();
        assert!(
            set_lineage_state(&connection, "op-3", "monitor-zombie")
                .unwrap_err()
                .starts_with("artifact_lineage_state_invalid:"),
            "非法状态串必须以词表错误码拒绝"
        );
        assert_eq!(
            lineage_row(&connection, "op-3").0,
            "monitor-active",
            "非法串不得半途写入"
        );
    }

    // baseline 族 4×4 迁移矩阵（票 02 按 geo_baselines.rs 真实代码钉，不编
    // 规则）：行先经 open 落在 from 态，再 set 目标态——聚合驱动的 finish
    // 不看现态，合法性完全由 claim/finish 动力学决定（见 allowed_from 注）。
    #[test]
    fn baseline_family_transitions_follow_the_real_code_matrix() {
        const FAMILY: [&str; 4] = [
            "baseline-running",
            "baseline-succeeded",
            "baseline-partial",
            "baseline-failed",
        ];
        let matrix: &[(&str, &[&str])] = &[
            (
                "baseline-running",
                &["baseline-running", "baseline-partial", "baseline-failed"],
            ),
            (
                "baseline-succeeded",
                &["baseline-running", "baseline-partial", "baseline-failed"],
            ),
            (
                "baseline-partial",
                &["baseline-running", "baseline-partial", "baseline-failed"],
            ),
            ("baseline-failed", &["baseline-running", "baseline-failed"]),
        ];
        let (_store, _workspace, connection) = connection();
        for &(target, allowed) in matrix {
            for from in FAMILY {
                let id = format!("op-{from}-{target}");
                open_lineage(&connection, &id, "session-lineage", from).unwrap();
                let result = set_lineage_state(&connection, &id, target);
                if allowed.contains(&from) {
                    result.unwrap();
                    assert_eq!(
                        lineage_row(&connection, &id).0,
                        target,
                        "{from} → {target} 是真实可达迁移，必须放行"
                    );
                } else {
                    assert_eq!(
                        result.unwrap_err(),
                        format!("artifact_lineage_transition_invalid:{from}"),
                        "{from} → {target} 按真实代码不可达，错误码须串明现态"
                    );
                    assert_eq!(
                        lineage_row(&connection, &id).0,
                        from,
                        "被拒迁移不得改写现态"
                    );
                }
            }
        }
    }

    // 未钉规则的族保持立项票的等价搬家语义（无 from 校验），不被 baseline
    // 规则误伤——monitor 逆向 set 亦放行，其 from 规则属票 07 职权。
    #[test]
    fn families_without_pinned_rules_stay_unchecked_until_their_clearing_ticket() {
        let (_store, _workspace, connection) = connection();
        open_lineage(
            &connection,
            "op-unpinned",
            "session-lineage",
            "monitor-active",
        )
        .unwrap();
        set_lineage_state(&connection, "op-unpinned", "monitor-draft").unwrap();
        assert_eq!(lineage_row(&connection, "op-unpinned").0, "monitor-draft");
    }

    #[test]
    fn baseline_rules_reject_cross_family_currents_and_missing_rows_stay_noop() {
        let (_store, _workspace, connection) = connection();
        open_lineage(&connection, "op-cross", "session-lineage", "monitor-active").unwrap();
        assert_eq!(
            set_lineage_state(&connection, "op-cross", "baseline-succeeded").unwrap_err(),
            "artifact_lineage_transition_invalid:monitor-active",
            "跨族现态自然落出 from 集，错误码串明现态"
        );
        assert_eq!(lineage_row(&connection, "op-cross").0, "monitor-active");
        // 缺失行 no-op 对已钉规则的族同样成立，且先于 from 校验。
        set_lineage_state(&connection, "missing-op", "baseline-succeeded").unwrap();
    }
}
