import {
  AlertTriangle,
  Check,
  Circle,
  CircleDashed,
  Clock3,
  Loader2,
  RefreshCcw,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  loadGeoOperation,
  loadGeoOperations,
} from "@/api/geoOperationClient";
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
import XiaojingMaterialImportPanel from "./XiaojingMaterialImportPanel";
import XiaojingPostPublishMonitoringPanel from "./XiaojingPostPublishMonitoringPanel";
import XiaojingPublishSchedulerPanel from "./XiaojingPublishSchedulerPanel";
import XiaojingQuestionPoolPanel from "./XiaojingQuestionPoolPanel";
import XiaojingRealGeoDashboard from "./XiaojingRealGeoDashboard";
import XiaojingTopicPlanPanel from "./XiaojingTopicPlanPanel";

interface Props {
  workspace: BrandWorkspace;
  navigationTarget?: GeoNavigationTarget | null;
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

const TERMINAL = new Set<GeoOperationStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

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

function StepIcon({ status }: { status: GeoOperationStepStatus }) {
  if (status === "succeeded" || status === "skipped") {
    return <Check className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (status === "running" || status === "ready") {
    return <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (status === "awaiting-confirmation") {
    return <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (status === "failed")
    return <X className="h-3.5 w-3.5" aria-hidden="true" />;
  return <Circle className="h-3.5 w-3.5" aria-hidden="true" />;
}

function OperationDetails({
  operation,
}: {
  operation: GeoOperationProjection;
}) {
  const showFullPhases =
    operation.kind === "full-optimization" ||
    (operation.kind === "next-round-optimization" &&
      operation.steps.length > 1);

  return (
    <>
      {showFullPhases && (
        <section
          aria-label="GEO 阶段总览"
          className="rounded-xl bg-[var(--paper-inset)] p-3"
        >
          <p className="text-xs font-semibold text-[var(--ink-muted)]">
            GEO 阶段总览
          </p>
          <ol className="mt-2 grid grid-cols-2 gap-2">
            {GEO_OPERATION_PHASES.map((phase, index) => {
              const steps = operation.steps.filter((step) =>
                phase.capabilities.includes(step.capability),
              );
              const status =
                steps.length > 0 ? geoOperationPhaseStatus(steps) : "skipped";
              return (
                <li
                  key={phase.id}
                  className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--paper-elevated)] px-2 py-2 text-xs"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--accent-warm-subtle)] text-[var(--accent)]">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{phase.title}</span>
                  <span className="sr-only">{STEP_STATUS_LABEL[status]}</span>
                  <StepIcon status={status} />
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section
        aria-label="当前操作步骤"
        className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">最小执行步骤</h4>
          <span className="text-xs text-[var(--ink-subtle)]">
            {operation.steps.length} 步
          </span>
        </div>
        <ol className="mt-2 space-y-1.5">
          {operation.steps.map((step, index) => (
            <li
              key={step.id}
              className={`flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-xs ${
                step.status === "running" ||
                step.status === "awaiting-confirmation" ||
                step.status === "ready"
                  ? "bg-[var(--accent-warm-subtle)]"
                  : ""
              }`}
            >
              <span
                className={`mt-0.5 ${
                  step.status === "failed"
                    ? "text-[var(--error)]"
                    : step.status === "succeeded" || step.status === "skipped"
                      ? "text-[var(--success)]"
                      : step.status === "awaiting-confirmation"
                        ? "text-[var(--warning)]"
                        : "text-[var(--ink-subtle)]"
                }`}
              >
                <StepIcon status={step.status} />
              </span>
              <span className="min-w-0 flex-1 break-words">
                <span className="font-medium text-[var(--ink)]">
                  {index + 1}. {step.title}
                </span>
                <span className="mt-0.5 block text-[var(--ink-muted)]">
                  {STEP_STATUS_LABEL[step.status]}
                  {step.condition ? ` · 条件：${step.condition}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {operation.checkpoint && (
        <section
          aria-label="恢复检查点"
          className="rounded-xl border border-[var(--line)] p-3 text-xs"
        >
          <p className="font-semibold">Checkpoint</p>
          <p className="mt-1 break-words text-[var(--ink-muted)]">
            当前步骤 {operation.checkpoint.activeStepId ?? "待恢复"} · 已完成{" "}
            {operation.checkpoint.completedStepIds.length} 步
          </p>
          <p className="mt-1 text-[var(--ink-subtle)]">
            {operation.checkpoint.safeToResume
              ? "已保存安全恢复点"
              : "尚不可安全恢复"}{" "}
            · {new Date(operation.checkpoint.savedAt).toLocaleString()}
          </p>
        </section>
      )}

      {operation.pendingConfirmation && (
        <section
          aria-label="待确认事项"
          className="rounded-xl border border-[var(--warning)] bg-[var(--warning-bg)] p-3 text-xs"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
            <div className="min-w-0">
              <p className="break-words font-semibold text-[var(--ink)]">
                {operation.pendingConfirmation.title}
              </p>
              <p className="mt-1 break-words leading-5 text-[var(--ink-muted)]">
                {operation.pendingConfirmation.summary}
              </p>
              <p className="mt-1 text-[var(--ink-subtle)]">
                裁决方：{operation.pendingConfirmation.authority}
              </p>
            </div>
          </div>
        </section>
      )}

      {operation.error && (
        <section
          role="alert"
          className="rounded-xl bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]"
        >
          <p className="font-semibold">{operation.error.code}</p>
          <p className="mt-1 break-words leading-5">
            {operation.error.message}
          </p>
          <p className="mt-1">
            {operation.error.retryable
              ? "可从失败单元重试"
              : "需要人工处理后再继续"}
          </p>
        </section>
      )}

      {operation.artifactRefs.length > 0 && (
        <section
          aria-label="操作产物"
          className="rounded-xl border border-[var(--line)] p-3 text-xs"
        >
          <p className="font-semibold">已固化产物</p>
          <ul className="mt-2 space-y-1 text-[var(--ink-muted)]">
            {operation.artifactRefs.map((reference, index) => (
              <li
                key={`${reference.kind}:${reference.id}:${reference.revision ?? index}`}
                className="break-all"
              >
                {reference.kind} · {reference.id}
                {reference.revision === undefined
                  ? ""
                  : ` · revision ${reference.revision}`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default memo(function XiaojingGeoOperationPanel({ workspace, navigationTarget = null }: Props) {
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

  const applyOperations = useCallback((next: GeoOperationProjection[]) => {
    setOperations(next);
    setFocusedId((current) => {
      if (
        navigationTarget?.operationId &&
        next.some((operation) => operation.id === navigationTarget.operationId)
      ) {
        return navigationTarget.operationId;
      }
      // A focused operation that reached a terminal state (cancelled /
      // failed) must not keep the workbench pinned to it when another
      // operation is still active — otherwise the phase indicator and the
      // step business card keep describing a dead operation.
      const focusedStillActive = current !== null
        && next.some(
          (operation) => operation.id === current && !TERMINAL.has(operation.status),
        );
      if (focusedStillActive) return current;
      return (
        next.find((operation) => !TERMINAL.has(operation.status))?.id ??
        next.find((operation) => operation.id === current)?.id ??
        next[0]?.id ??
        null
      );
    });
  }, [navigationTarget?.operationId]);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!identity) {
        applyOperations([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const next = await loadGeoOperations(apiPost, identity, { limit: 50 }, signal);
        if (
          navigationTarget?.operationId &&
          !next.some((operation) => operation.id === navigationTarget.operationId)
        ) {
          next.unshift(await loadGeoOperation(
            apiPost,
            identity,
            navigationTarget.operationId,
            signal,
          ));
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
  const step = focused ? activeStep(focused) : null;

  const operationOptions = operations.map((operation) => ({
    value: operation.id,
    label: `${STATUS_LABEL[operation.status]} · ${operation.goal}`,
  }));

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
        <>
          <section
            aria-label="当前 GEO 操作"
            className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
            data-operation-id={focused.id}
            data-operation-revision={focused.revision}
            data-geo-navigation-card={navigationTarget?.operationId === focused.id && navigationTarget.card === "geo-operation" ? navigationTarget.card : undefined}
            data-geo-navigation-artifact={navigationTarget?.operationId === focused.id && navigationTarget.card === "geo-operation" ? navigationTarget.artifact.id : undefined}
            data-geo-navigation-step={navigationTarget?.operationId === focused.id && navigationTarget.card === "geo-operation" ? navigationTarget.stepId : undefined}
          >
            <div className="h-1 bg-[var(--accent)]" />
            <div className="space-y-3 p-4">
              <div className="flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-[0.04em] text-[var(--accent)]">
                    当前 GEO Operation
                  </p>
                  <h3 className="mt-1 break-words text-base font-semibold">
                    {focused.goal}
                  </h3>
                  <p className="mt-1 break-all text-xs text-[var(--ink-subtle)]">
                    {focused.id} · revision {focused.revision} · generation{" "}
                    {focused.executionGeneration}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-[var(--accent-warm-subtle)] px-2 py-1 text-xs font-medium text-[var(--accent)]">
                  {STATUS_LABEL[focused.status]}
                </span>
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

              {/* 过程控制（暂停/恢复/重试/取消）与排队、恢复提示由聊天进度卡承载；
                  工作台只保留只读投影的手动刷新。 */}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void refresh()}
                  aria-label="刷新当前 GEO 操作"
                  className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
                >
                  <RefreshCcw
                    className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                  />
                </button>
              </div>

              {focused.kind === "next-round-optimization" &&
                focused.steps.length === 1 &&
                focused.steps[0]?.id === "decide-knowledge-refresh" && (
                  <p className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
                    「是否更新品牌知识」由小鲸在聊天里向你提问；请回到聊天作答后继续。
                  </p>
                )}
            </div>
          </section>

          <OperationDetails operation={focused} />
        </>
      ) : (
        <section
          aria-label="GEO 操作空状态"
          className="rounded-xl border border-dashed border-[var(--line)] p-4 text-center"
        >
          <CircleDashed className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <p className="mt-2 text-sm font-medium">还没有结构化 GEO 操作</p>
          <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
            在自然对话中说明目标即可；各步骤确认会在聊天卡片上进行。
          </p>
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

      {focused ? (
        <section
          aria-label="当前步骤结果展示"
          data-geo-navigation-card={navigationTarget?.operationId === focused.id && navigationTarget.card !== "geo-operation" ? navigationTarget.card : undefined}
          data-geo-navigation-artifact={navigationTarget?.operationId === focused.id && navigationTarget.card !== "geo-operation" ? navigationTarget.artifact.id : undefined}
          key={`${focused.id}:${step?.id ?? navigationTarget?.card ?? "none"}`}
        >
          {navigationTarget?.operationId === focused.id && navigationTarget.card === "geo-operation" ? null : navigationTarget?.operationId === focused.id && navigationTarget.card === "article-generation" ? (
            <XiaojingArticleGenerationPanel
              workspaceId={workspace.id}
              operationId={navigationTarget.artifact.id}
              refreshKey={topicPlanRevision}
              onApproved={() => setArticleApprovalRevision((value) => value + 1)}
              readOnly
            />
          ) : navigationTarget?.operationId === focused.id && navigationTarget.card === "publish-execution" ? (
            <XiaojingPublishSchedulerPanel
              workspaceId={workspace.id}
              executionId={navigationTarget.artifact.id}
              refreshKey={distributionPlanRevision}
              onRequestPlanEdit={() => setDistributionPlanEditRequest((value) => value + 1)}
              readOnly
            />
          ) : navigationTarget?.operationId === focused.id && navigationTarget.card === "post-publish-monitoring" ? (
            <XiaojingPostPublishMonitoringPanel
              workspaceId={workspace.id}
              planId={navigationTarget.artifact.id}
              readOnly
            />
          ) : step?.capability === "brand-material-import" ||
          step?.capability === "brand-knowledge" ? (
            <XiaojingMaterialImportPanel workspaceId={workspace.id} readOnly />
          ) : step?.capability === "question-opportunities" ? (
            <XiaojingQuestionPoolPanel
              workspaceId={workspace.id}
              productLines={workspace.productLines}
              onConfirmed={() => setQuestionPoolRevision((value) => value + 1)}
              readOnly
            />
          ) : step?.capability === "geo-observation" ? (
            <XiaojingGeoBaselinePanel
              workspaceId={workspace.id}
              refreshKey={questionPoolRevision}
              readOnly
            />
          ) : step?.capability === "content-planning" ? (
            <XiaojingTopicPlanPanel
              workspaceId={workspace.id}
              refreshKey={questionPoolRevision}
              onConfirmed={() => setTopicPlanRevision((value) => value + 1)}
              readOnly
            />
          ) : step?.capability === "content-production" ? (
            <XiaojingArticleGenerationPanel
              workspaceId={workspace.id}
              refreshKey={topicPlanRevision}
              onApproved={() =>
                setArticleApprovalRevision((value) => value + 1)
              }
              readOnly
            />
          ) : step?.capability === "distribution-planning" ? (
            <XiaojingDistributionPlanPanel
              workspaceId={workspace.id}
              refreshKey={articleApprovalRevision}
              editRequestKey={distributionPlanEditRequest}
              onConfirmed={() =>
                setDistributionPlanRevision((value) => value + 1)
              }
              readOnly
            />
          ) : step?.capability === "publishing" ? (
            <XiaojingPublishSchedulerPanel
              workspaceId={workspace.id}
              refreshKey={distributionPlanRevision}
              onRequestPlanEdit={() =>
                setDistributionPlanEditRequest((value) => value + 1)
              }
              readOnly
            />
          ) : step?.capability === "monitoring" ? (
            <XiaojingPostPublishMonitoringPanel workspaceId={workspace.id} readOnly />
          ) : step?.capability === "geo-dashboard" ? (
            <XiaojingRealGeoDashboard workspaceId={workspace.id} />
          ) : null}
        </section>
      ) : (
        <section aria-label="品牌准备工具" className="space-y-3">
          <p className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
            材料导入、题库与各步骤确认都在聊天中的卡片上完成；本工作台只展示权威结果。
          </p>
        </section>
      )}
    </div>
  );
});
