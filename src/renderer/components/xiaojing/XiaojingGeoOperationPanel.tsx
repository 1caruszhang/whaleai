import { ChevronDown, CircleDashed, Loader2, RefreshCcw } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { loadGeoOperation, loadGeoOperations } from "@/api/geoOperationClient";
import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import CustomSelect from "@/components/CustomSelect";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  GEO_OPERATION_PHASES,
  geoOperationPhaseStatus,
} from "../../../shared/geo/operation";
import type {
  GeoOperationProjection,
  GeoOperationStatus,
  GeoOperationStep,
  GeoOperationStepStatus,
} from "../../../shared/geo/operation";
import type { GeoNavigationTarget } from "../../../shared/geo/notification";
import XiaojingArticleGenerationPanel from "./XiaojingArticleGenerationPanel";
import XiaojingDistributionPlanPanel from "./XiaojingDistributionPlanPanel";
import XiaojingGeoBaselinePanel from "./XiaojingGeoBaselinePanel";
import XiaojingPostPublishMonitoringPanel from "./XiaojingPostPublishMonitoringPanel";
import XiaojingPublishSchedulerPanel from "./XiaojingPublishSchedulerPanel";
import XiaojingQuestionPoolPanel from "./XiaojingQuestionPoolPanel";
import XiaojingRealGeoDashboard from "./XiaojingRealGeoDashboard";
import XiaojingTopicPlanPanel from "./XiaojingTopicPlanPanel";

interface Props {
  workspace: BrandWorkspace;
  navigationTarget?: GeoNavigationTarget | null;
  /**
   * 夹在多操作切换器与阶段骨架之间的品牌级面板（工作台注入当前已确认
   * 品牌知识），保持「切换器 → 知识 → 骨架」的三段结构。
   */
  children?: ReactNode;
}

const STATUS_LABEL: Record<GeoOperationStatus, string> = {
  ready: "待开始",
  queued: "排队中",
  running: "进行中",
  "awaiting-confirmation": "待确认",
  paused: "已暂停",
  recovering: "恢复中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const STEP_STATUS_LABEL: Record<GeoOperationStepStatus, string> = {
  pending: "等待",
  ready: "就绪",
  running: "进行中",
  "awaiting-confirmation": "待确认",
  succeeded: "完成",
  failed: "失败",
  skipped: "已跳过",
};

const PHASE_ROW_STATUS_LABEL: Record<
  GeoOperationStepStatus | "paused",
  string
> = {
  ...STEP_STATUS_LABEL,
  paused: "已暂停",
};

const PHASE_ROW_STATUS_DOT: Record<GeoOperationStepStatus | "paused", string> =
  {
    pending: "bg-[var(--ink-subtle)]",
    ready: "bg-[var(--accent)]",
    running: "bg-[var(--accent)] animate-pulse",
    "awaiting-confirmation": "bg-[var(--warning)]",
    succeeded: "bg-[var(--success)]",
    failed: "bg-[var(--error)]",
    skipped: "bg-[var(--success)]",
    paused: "bg-[var(--info)]",
  };

const TERMINAL = new Set<GeoOperationStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

/** 通知深链的产物卡落到骨架的哪个阶段。 */
const NAVIGATION_CARD_PHASE: Partial<
  Record<GeoNavigationTarget["card"], string>
> = {
  "article-generation": "content",
  "publish-execution": "publishing",
  "post-publish-monitoring": "monitoring",
};

function activeStep(
  operation: GeoOperationProjection,
): GeoOperationStep | null {
  return (
    operation.steps.find(
      (step) =>
        step.status === "running" ||
        step.status === "awaiting-confirmation" ||
        step.status === "ready" ||
        step.status === "failed",
    ) ??
    operation.steps.find((step) => step.status === "pending") ??
    null
  );
}

/**
 * 阶段行状态：无步骤的阶段标「已跳过」；任一步骤失败即失败；操作整体
 * 暂停时活跃阶段显示「已暂停」。过程细节（失败原因、排队位置、
 * checkpoint）只呈现在聊天进度卡。
 */
function phaseRowStatus(
  operation: GeoOperationProjection,
  steps: readonly GeoOperationStep[],
): GeoOperationStepStatus | "paused" {
  if (steps.length === 0) return "skipped";
  const status = geoOperationPhaseStatus(steps);
  if (status === "failed") return "failed";
  if (
    operation.status === "paused" &&
    (status === "running" ||
      status === "ready" ||
      status === "awaiting-confirmation")
  ) {
    return "paused";
  }
  return status;
}

export default memo(function XiaojingGeoOperationPanel({
  workspace,
  navigationTarget = null,
  children,
}: Props) {
  const { apiPost } = useTabApi();
  const { sessionId, toolCompleteCount = 0 } = useTabState();
  const identity = useMemo(
    () =>
      sessionId && !isPendingSessionId(sessionId)
        ? { workspaceId: workspace.id, sessionId }
        : null,
    [sessionId, workspace.id],
  );
  const [operations, setOperations] = useState<GeoOperationProjection[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questionPoolRevision, setQuestionPoolRevision] = useState(0);
  const [topicPlanRevision, setTopicPlanRevision] = useState(0);
  const [articleApprovalRevision, setArticleApprovalRevision] = useState(0);
  const [distributionPlanRevision, setDistributionPlanRevision] = useState(0);
  const [distributionPlanEditRequest, setDistributionPlanEditRequest] =
    useState(0);
  // 深链聚焦 pin：每次 nonce 只消费一次，之后的手动切换不被轮询刷新抢回。
  const focusPinRef = useRef<string | null>(null);

  const applyOperations = useCallback((next: GeoOperationProjection[]) => {
    setOperations(next);
    const pinnedId = focusPinRef.current;
    const pinPresent =
      pinnedId !== null && next.some((operation) => operation.id === pinnedId);
    if (pinPresent) focusPinRef.current = null;
    setFocusedId((current) => {
      if (pinPresent && pinnedId) return pinnedId;
      // A focused operation that reached a terminal state (cancelled /
      // failed) must not keep the workbench pinned to it when another
      // operation is still active — otherwise the phase skeleton keeps
      // describing a dead operation.
      const focusedStillActive =
        current !== null &&
        next.some(
          (operation) =>
            operation.id === current && !TERMINAL.has(operation.status),
        );
      if (focusedStillActive) return current;
      return (
        next.find((operation) => !TERMINAL.has(operation.status))?.id ??
        next.find((operation) => operation.id === current)?.id ??
        next[0]?.id ??
        null
      );
    });
  }, []);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!identity) {
        applyOperations([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await loadGeoOperations(
          apiPost,
          identity,
          { limit: 50 },
          signal,
        );
        if (
          navigationTarget?.operationId &&
          !next.some(
            (operation) => operation.id === navigationTarget.operationId,
          )
        ) {
          next.unshift(
            await loadGeoOperation(
              apiPost,
              identity,
              navigationTarget.operationId,
              signal,
            ),
          );
        }
        applyOperations(next);
      } catch (cause) {
        if (!signal?.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiPost, applyOperations, identity, navigationTarget?.operationId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh, toolCompleteCount]);

  const hasLiveOperation = operations.some(
    (operation) => !TERMINAL.has(operation.status),
  );
  useEffect(() => {
    if (!identity || !hasLiveOperation) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        await refresh(controller.signal);
      } finally {
        inFlight = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasLiveOperation, identity, refresh]);

  const focused =
    operations.find((operation) => operation.id === focusedId) ?? null;
  // 骨架恒定渲染共享六阶段行（直接意图未覆盖的阶段标「已跳过」），
  // 未匹配任何阶段的残缺步骤兜底进「其他」组，不静默丢弃。
  const groups = useMemo(() => {
    if (!focused) return [];
    const phaseGroups = GEO_OPERATION_PHASES.map((phase) => ({
      id: phase.id,
      title: phase.title,
      steps: focused.steps.filter((step) =>
        phase.capabilities.includes(step.capability),
      ),
    }));
    const groupedStepIds = new Set(
      phaseGroups.flatMap((group) => group.steps.map((step) => step.id)),
    );
    const leftovers = focused.steps.filter(
      (step) => !groupedStepIds.has(step.id),
    );
    return leftovers.length > 0
      ? [...phaseGroups, { id: "other", title: "其他", steps: leftovers }]
      : phaseGroups;
  }, [focused]);
  const activeStepId = focused ? (activeStep(focused)?.id ?? null) : null;
  const currentPhaseId =
    groups.find((group) => group.steps.some((step) => step.id === activeStepId))
      ?.id ??
    groups[0]?.id ??
    null;
  const navigationPhaseId =
    navigationTarget && focused && navigationTarget.operationId === focused.id
      ? (NAVIGATION_CARD_PHASE[navigationTarget.card] ?? null)
      : null;

  // 手动展开（回看/深链固定）只在聚焦操作与其当前阶段不变期间有效；
  // 操作推进或切换聚焦后自动回到跟随当前阶段，无需 effect 对账。
  const followAnchor = focused ? `${focused.id}:${currentPhaseId ?? ""}` : "";
  const [manualExpansion, setManualExpansion] = useState<{
    phaseId: string;
    anchor: string;
  } | null>(null);
  const activeManualPhaseId =
    manualExpansion && manualExpansion.anchor === followAnchor
      ? manualExpansion.phaseId
      : null;
  // 深链落点在渲染期固定（同工作台深链展开模式），保证单次提交内可见；
  // 每个 nonce 只消费一次，不与用户后续的手动选择竞争。聚焦 pin 在渲染
  // 期即可消费，阶段展开 pin 要等聚焦操作载入后才可消费。
  const [seenNavigationNonces, setSeenNavigationNonces] = useState({
    focus: 0,
    expansion: 0,
  });
  if (navigationTarget && seenNavigationNonces.focus !== navigationTarget.nonce) {
    setSeenNavigationNonces((seen) => ({ ...seen, focus: navigationTarget.nonce }));
    focusPinRef.current = navigationTarget.operationId;
  }
  if (
    navigationTarget &&
    navigationPhaseId &&
    seenNavigationNonces.expansion !== navigationTarget.nonce
  ) {
    setSeenNavigationNonces((seen) => ({
      ...seen,
      expansion: navigationTarget.nonce,
    }));
    setManualExpansion({
      phaseId: navigationPhaseId,
      anchor: followAnchor,
    });
  }

  const expanded = activeManualPhaseId ?? currentPhaseId;
  const togglePhase = useCallback(
    (phaseId: string) => {
      setManualExpansion((current) =>
        current?.phaseId === phaseId && current.anchor === followAnchor
          ? null
          : { phaseId, anchor: followAnchor },
      );
    },
    [followAnchor],
  );

  const operationOptions = operations.map((operation) => ({
    value: operation.id,
    label: `${STATUS_LABEL[operation.status]} · ${operation.goal}`,
  }));

  /** 阶段产物面板：产物按阶段能力归属渲染，全部只读。 */
  const renderPhaseBody = useCallback(
    (phaseId: string): ReactNode => {
      const target =
        navigationPhaseId === phaseId &&
        navigationTarget?.operationId === focused?.id
          ? navigationTarget
          : null;
      if (target?.card === "article-generation") {
        return (
          <XiaojingArticleGenerationPanel
            workspaceId={workspace.id}
            operationId={target.artifact.id}
            refreshKey={topicPlanRevision}
            onApproved={() => setArticleApprovalRevision((value) => value + 1)}
            readOnly
          />
        );
      }
      if (target?.card === "publish-execution") {
        return (
          <XiaojingPublishSchedulerPanel
            workspaceId={workspace.id}
            executionId={target.artifact.id}
            refreshKey={distributionPlanRevision}
            onRequestPlanEdit={() =>
              setDistributionPlanEditRequest((value) => value + 1)
            }
            readOnly
          />
        );
      }
      if (target?.card === "post-publish-monitoring") {
        return (
          <XiaojingPostPublishMonitoringPanel
            workspaceId={workspace.id}
            planId={target.artifact.id}
            readOnly
          />
        );
      }
      switch (phaseId) {
        case "knowledge":
          // 票 27：材料导入与知识确认在聊天卡片上完成；工作台不挂面板，
          // 已确认事实由上方品牌知识面板承载。
          return (
            <p className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
              材料导入与知识确认在聊天中的卡片上完成；已确认的品牌事实见上方品牌知识面板。
            </p>
          );
        case "questions":
          return (
            <XiaojingQuestionPoolPanel
              workspaceId={workspace.id}
              productLines={workspace.productLines}
              onConfirmed={() => setQuestionPoolRevision((value) => value + 1)}
              readOnly
            />
          );
        case "content":
          return (
            <>
              <XiaojingTopicPlanPanel
                workspaceId={workspace.id}
                refreshKey={questionPoolRevision}
                onConfirmed={() => setTopicPlanRevision((value) => value + 1)}
                readOnly
              />
              <XiaojingArticleGenerationPanel
                workspaceId={workspace.id}
                refreshKey={topicPlanRevision}
                onApproved={() =>
                  setArticleApprovalRevision((value) => value + 1)
                }
                readOnly
              />
            </>
          );
        case "distribution":
          return (
            <XiaojingDistributionPlanPanel
              workspaceId={workspace.id}
              refreshKey={articleApprovalRevision}
              editRequestKey={distributionPlanEditRequest}
              onConfirmed={() =>
                setDistributionPlanRevision((value) => value + 1)
              }
              readOnly
            />
          );
        case "publishing":
          return (
            <XiaojingPublishSchedulerPanel
              workspaceId={workspace.id}
              refreshKey={distributionPlanRevision}
              onRequestPlanEdit={() =>
                setDistributionPlanEditRequest((value) => value + 1)
              }
              readOnly
            />
          );
        case "monitoring":
          return (
            <>
              <XiaojingPostPublishMonitoringPanel
                workspaceId={workspace.id}
                readOnly
              />
              <XiaojingRealGeoDashboard workspaceId={workspace.id} />
            </>
          );
        default:
          // 残缺投影的「其他」组兜底（如 geo-observation 步骤）。
          return (
            <XiaojingGeoBaselinePanel
              workspaceId={workspace.id}
              refreshKey={questionPoolRevision}
              readOnly
            />
          );
      }
    },
    [
      articleApprovalRevision,
      distributionPlanEditRequest,
      distributionPlanRevision,
      focused?.id,
      navigationPhaseId,
      navigationTarget,
      questionPoolRevision,
      topicPlanRevision,
      workspace.id,
      workspace.productLines,
    ],
  );

  return (
    <div className="mt-4 space-y-3" data-geo-operation-workbench>
      {!identity ? (
        <section className="rounded-xl bg-[var(--paper-inset)] p-3 text-xs leading-5 text-[var(--ink-muted)]">
          正在建立真实 Session。Operation 工作台会在会话身份固化后启用。
        </section>
      ) : loading && operations.length === 0 ? (
        <section
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl bg-[var(--paper-inset)] p-3 text-xs text-[var(--ink-muted)]"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取当前 GEO
          操作…
        </section>
      ) : focused ? (
        <section
          aria-label="当前 GEO 操作"
          className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
          data-operation-id={focused.id}
          data-operation-revision={focused.revision}
          data-geo-navigation-card={
            navigationTarget?.operationId === focused.id &&
            navigationTarget.card === "geo-operation"
              ? navigationTarget.card
              : undefined
          }
          data-geo-navigation-artifact={
            navigationTarget?.operationId === focused.id &&
            navigationTarget.card === "geo-operation"
              ? navigationTarget.artifact.id
              : undefined
          }
          data-geo-navigation-step={
            navigationTarget?.operationId === focused.id &&
            navigationTarget.card === "geo-operation"
              ? navigationTarget.stepId
              : undefined
          }
        >
          <div className="h-1 bg-[var(--accent)]" />
          <div className="space-y-3 p-4">
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-base font-semibold">
                  {focused.goal}
                </h3>
              </div>
              <span className="shrink-0 rounded-full bg-[var(--accent-warm-subtle)] px-2 py-1 text-xs font-medium text-[var(--accent)]">
                {STATUS_LABEL[focused.status]}
              </span>
              <button
                type="button"
                disabled={loading}
                onClick={() => void refresh()}
                aria-label="刷新当前 GEO 操作"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
              >
                <RefreshCcw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
              </button>
            </div>

            {operations.length > 1 && (
              <div>
                <span className="sr-only" id="geo-operation-selector-label">
                  切换 GEO 操作
                </span>
                <CustomSelect
                  value={focused.id}
                  options={operationOptions}
                  onChange={setFocusedId}
                  ariaLabel="切换 GEO 操作"
                  size="toolbar"
                  className="w-full"
                />
              </div>
            )}

            {focused.kind === "next-round-optimization" &&
              focused.steps.length === 1 &&
              focused.steps[0]?.id === "decide-knowledge-refresh" && (
                <p className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
                  「是否更新品牌知识」由小鲸在聊天里向你提问；请回到聊天作答后继续。
                </p>
              )}
          </div>
        </section>
      ) : (
        <section
          aria-label="GEO 操作空状态"
          className="rounded-xl border border-dashed border-[var(--line)] p-4 text-center"
        >
          <CircleDashed className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <p className="mt-2 text-sm font-medium">还没有结构化 GEO 操作</p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
            在聊天中说明你的 GEO
            目标即可发起；各阶段确认在聊天卡片上完成，这里的阶段面板会展示已生成的产物。
          </p>
        </section>
      )}

      {/* 品牌级面板（当前已确认品牌知识）常驻于切换器与阶段骨架之间。 */}
      {children}

      {focused && (
        <section
          aria-label="GEO 阶段骨架"
          data-geo-phase-skeleton={focused.id}
          className="space-y-2"
        >
          {groups.map((group) => {
            const isExpanded = group.id === expanded;
            const status = phaseRowStatus(focused, group.steps);
            const bodyId = `${focused.id}:${group.id}:body`;
            return (
              <div
                key={group.id}
                data-geo-phase={group.id}
                className={`overflow-hidden rounded-xl border bg-[var(--paper-elevated)] transition-colors ${
                  isExpanded
                    ? "border-[var(--accent)]/45"
                    : "border-[var(--line)]"
                }`}
              >
                <h3>
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-controls={bodyId}
                    onClick={() => togglePhase(group.id)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-[var(--paper-inset)]"
                  >
                    <span
                      aria-hidden="true"
                      className={`h-2 w-2 shrink-0 rounded-full ${PHASE_ROW_STATUS_DOT[status]}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {group.title}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--ink-muted)]">
                      {PHASE_ROW_STATUS_LABEL[status]}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={`h-4 w-4 shrink-0 text-[var(--ink-subtle)] transition-transform ${
                        isExpanded ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                </h3>
                {isExpanded && (
                  <div
                    id={bodyId}
                    role="region"
                    aria-label={`${group.title}产物`}
                    data-geo-phase-body={group.id}
                    data-geo-navigation-card={
                      navigationPhaseId === group.id
                        ? navigationTarget?.card
                        : undefined
                    }
                    data-geo-navigation-artifact={
                      navigationPhaseId === group.id
                        ? navigationTarget?.artifact.id
                        : undefined
                    }
                    className="space-y-3 border-t border-[var(--line-subtle)] p-3"
                  >
                    {renderPhaseBody(group.id)}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {error && (
        <div
          role="alert"
          className="break-words rounded-lg bg-[var(--error-bg)] p-2.5 text-xs text-[var(--error)]"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 font-medium underline"
          >
            重试读取操作
          </button>
        </div>
      )}
    </div>
  );
});
