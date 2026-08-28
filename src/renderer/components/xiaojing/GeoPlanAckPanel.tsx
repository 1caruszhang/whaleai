import { Play } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { confirmGeoOperationStep } from "@/api/geoOperationClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  GeoOperationProjection,
  GeoOperationStep,
} from "../../../shared/geo/operation";
import GateCardFooter from "./GateCardFooter";

/**
 * 计划放行门：operation 创建后先停在「认可本轮计划」，用户在进度卡上
 * 一次性放行整份计划，各阶段的产物门不受影响。确认走既有
 * /geo-operations/confirm-step 端点（revision CAS），路由随决策投递
 * XIAOJING_GEO_OPERATION_EVENT reminder 唤醒 agent 继续第一阶段。
 */
export default function GeoPlanAckPanel({
  operation,
  step,
  onGateConfirmed,
}: {
  operation: GeoOperationProjection;
  step: GeoOperationStep;
  /** 确认提交成功后，通知宿主卡片刷新操作投影。 */
  onGateConfirmed?: () => void;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identity = useMemo(
    () =>
      sessionId && !isPendingSessionId(sessionId) && operation.workspaceId
        ? { workspaceId: operation.workspaceId, sessionId }
        : null,
    [sessionId, operation.workspaceId],
  );

  const submit = useCallback(async () => {
    if (!identity || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmGeoOperationStep(apiPost, identity, {
        operationId: operation.id,
        expectedRevision: operation.revision,
        stepId: step.id,
      });
      onGateConfirmed?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [
    apiPost,
    busy,
    identity,
    onGateConfirmed,
    operation.id,
    operation.revision,
    step.id,
  ]);

  return (
    <div
      data-geo-plan-ack={operation.id}
      className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-2.5"
    >
      <p className="text-sm font-medium text-[var(--ink)]">
        {step.confirmation?.title ?? "认可本轮计划"}
      </p>
      <p className="mt-1 break-words text-xs leading-5 text-[var(--ink-secondary)]">
        {step.confirmation?.summary}
      </p>
      {error && (
        <p
          role="alert"
          className="mt-2 break-words rounded-lg bg-[var(--error-bg)] px-2.5 py-2 text-xs text-[var(--error)]"
        >
          {error}
        </p>
      )}
      <GateCardFooter>
        <button
          type="button"
          disabled={busy || !identity}
          onClick={() => void submit()}
          className="inline-flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1.5 text-sm text-[var(--button-primary-text)] disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" /> 认可计划并开始
        </button>
      </GateCardFooter>
    </div>
  );
}
