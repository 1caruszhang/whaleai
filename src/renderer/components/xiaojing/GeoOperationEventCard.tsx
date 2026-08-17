import {
  CheckCircle2,
  CircleDashed,
  Clock3,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  controlGeoOperation,
  loadGeoOperation,
  type GeoOperationControlAction,
} from "@/api/geoOperationClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isTauriEnvironment } from "@/utils/browserMock";
import { listenWithCleanup } from "@/utils/tauriListen";
import { isPendingSessionId } from "../../../shared/constants";
import {
  geoOperationPhaseStatus,
  groupGeoOperationSteps,
} from "../../../shared/geo/operation";
import type { GeoOperationProjection } from "../../../shared/geo/operation";
import { unwrapToolResultText } from "../../../shared/toolResult";
import GeoOperationGatePanels from "./GeoOperationGatePanels";

export interface GeoOperationEventCardData {
  kind: "geo-operation" | "geo-operation-projection";
  operations: GeoOperationProjection[];
}

interface GeoProviderQueueEvent {
  workspaceId: string;
  sessionId: string;
  permit: {
    state: "acquired" | "queued";
    requestId: string;
    queueReason: string | null;
    queuePosition: number | null;
    concurrencyLimit: number;
  };
}

function isOperation(value: unknown): value is GeoOperationProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GeoOperationProjection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.goal === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.steps)
  );
}

function parseEnvelope(value: unknown): GeoOperationEventCardData | null {
  if (Array.isArray(value)) {
    // MCP 结果投影是 content blocks 数组：`[{type:'text',text:'<payload>'}]`。
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parseGeoOperationEventCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: string;
    operation?: unknown;
    result?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parseGeoOperationEventCard(text) : null;
  }
  if (envelope.kind === "geo-operation" && isOperation(envelope.operation)) {
    return { kind: "geo-operation", operations: [envelope.operation] };
  }
  if (envelope.kind === "geo-operation-projection") {
    // 空列表也是权威结果（当前 Session 尚无操作），交由卡片渲染空态，
    // 而不是掉回裸工具行让用户以为工具失效。
    if (Array.isArray(envelope.result)) {
      return {
        kind: "geo-operation-projection",
        operations: envelope.result.filter(isOperation),
      };
    }
    return isOperation(envelope.result)
      ? { kind: "geo-operation-projection", operations: [envelope.result] }
      : null;
  }
  return null;
}

export function parseGeoOperationEventCard(
  result: string,
): GeoOperationEventCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

const STATUS_LABEL: Record<GeoOperationProjection["status"], string> = {
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

const STEP_STATUS_LABEL: Record<
  GeoOperationProjection["steps"][number]["status"],
  string
> = {
  pending: "待开始",
  ready: "就绪",
  running: "进行中",
  "awaiting-confirmation": "待确认",
  succeeded: "已完成",
  failed: "失败",
  skipped: "已跳过",
};

const TERMINAL = new Set<GeoOperationProjection["status"]>([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * 闸门交互宿主去重：同一条消息流里同一操作可能出现多张进度卡片
 * （多次 GEO 工具结果），但交互面板只能挂在最新一张上，
 * 否则历史消息里会出现多份重复的确认界面。
 * 挂载即认领（单调递增 ordinal），最新的卡片独占交互宿主。
 */
const gateHostClaims = new Map<string, number>();
const gateHostListeners = new Set<() => void>();
let gateHostOrdinalSeed = 0;

function notifyGateHosts() {
  gateHostListeners.forEach((listener) => listener());
}

function subscribeGateHost(listener: () => void) {
  gateHostListeners.add(listener);
  return () => {
    gateHostListeners.delete(listener);
  };
}

function claimGateHost(operationId: string, ordinal: number) {
  if ((gateHostClaims.get(operationId) ?? 0) >= ordinal) return;
  gateHostClaims.set(operationId, ordinal);
  notifyGateHosts();
}

function releaseGateHost(operationId: string, ordinal: number) {
  if (gateHostClaims.get(operationId) !== ordinal) return;
  gateHostClaims.delete(operationId);
  notifyGateHosts();
}

function useGateHost(operationId: string): boolean {
  const [ordinal] = useState(() => {
    gateHostOrdinalSeed += 1;
    return gateHostOrdinalSeed;
  });
  const isHost = useSyncExternalStore(
    subscribeGateHost,
    () => gateHostClaims.get(operationId) === ordinal,
    () => false,
  );
  useEffect(() => {
    claimGateHost(operationId, ordinal);
    return () => releaseGateHost(operationId, ordinal);
  }, [operationId, ordinal]);
  return isHost;
}

function statusIcon(operation: GeoOperationProjection) {
  if (operation.status === "succeeded") {
    return <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />;
  }
  if (operation.status === "recovering") {
    return <RotateCcw className="h-4 w-4 text-[var(--info)]" />;
  }
  if (
    operation.status === "queued" ||
    operation.status === "awaiting-confirmation"
  ) {
    return <Clock3 className="h-4 w-4 text-[var(--warning)]" />;
  }
  return <CircleDashed className="h-4 w-4 text-[var(--accent)]" />;
}

const CONTROL_BUTTON_TONE: Record<string, string> = {
  neutral: "border border-[var(--line)]",
  primary:
    "bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]",
  danger: "border border-[var(--line)] text-[var(--error)]",
};

function ControlButton({
  action,
  icon,
  label,
  tone,
  busy,
  onSubmit,
}: {
  action: GeoOperationControlAction;
  icon: ReactNode;
  label: string;
  tone: keyof typeof CONTROL_BUTTON_TONE;
  busy: boolean;
  onSubmit: (action: GeoOperationControlAction) => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => onSubmit(action)}
      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm disabled:opacity-50 ${CONTROL_BUTTON_TONE[tone]}`}
    >
      {icon} {label}
    </button>
  );
}

function OperationArticle({ operation }: { operation: GeoOperationProjection }) {
  const isHost = useGateHost(operation.id);
  const { apiPost } = useTabApi();
  // agent 回合进行中（思考/调用工具/输出正文）时挂起卡片交互：
  // 卡片必须等小鲸说完它的判断与建议后才承载操作，避免两路各走各的。
  // 生命周期控制不受此约束：暂停/取消是用户对操作本身的意图，不与
  // agent 的闸门建议竞争。
  const { sessionId, isLoading: isAgentResponding } = useTabState();
  // 工具结果快照在父级重渲染时会重新 parse 出新对象；
  // 只有 revision 真正变化才重置快照，避免覆盖轮询得到的实时状态。
  const [snapshot, setSnapshot] = useState(operation);
  const [live, setLive] = useState(operation);
  const [refreshTick, setRefreshTick] = useState(0);
  const [busyAction, setBusyAction] = useState<GeoOperationControlAction | null>(
    null,
  );
  const [controlError, setControlError] = useState<string | null>(null);
  const [providerQueues, setProviderQueues] = useState<
    Record<string, GeoProviderQueueEvent["permit"]>
  >({});
  const snapshotRevisionRef = useRef(operation.revision);
  useEffect(() => {
    if (operation.revision === snapshotRevisionRef.current) return;
    snapshotRevisionRef.current = operation.revision;
    setSnapshot(operation);
    setLive(operation);
  }, [operation]);

  const identity = useMemo(
    () =>
      sessionId && !isPendingSessionId(sessionId) && snapshot.workspaceId
        ? { workspaceId: snapshot.workspaceId, sessionId }
        : null,
    [sessionId, snapshot.workspaceId],
  );
  const terminal = TERMINAL.has(live.status);

  useEffect(() => {
    if (!isHost || !identity || TERMINAL.has(live.status)) return undefined;
    const controller = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const next = await loadGeoOperation(
          apiPost,
          identity,
          snapshot.id,
          controller.signal,
        );
        if (!controller.signal.aborted) setLive(next);
      } catch {
        // 轮询失败保留最后一次投影，下一轮再试。
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [apiPost, identity, isHost, live.status, refreshTick, snapshot.id]);

  // provider 排队提示与轮询同生命周期：只在交互宿主卡上订阅，
  // 数据通道沿用 geo-provider-queue-updated Tauri 事件，不新增 SSE 事件。
  useEffect(() => {
    setProviderQueues({});
    if (!isHost || !identity || terminal || !isTauriEnvironment()) {
      return undefined;
    }
    const controller = new AbortController();
    void listenWithCleanup<GeoProviderQueueEvent>(
      "geo-provider-queue-updated",
      ({ payload }) => {
        if (
          payload.workspaceId !== identity.workspaceId ||
          payload.sessionId !== identity.sessionId
        )
          return;
        setProviderQueues((current) => {
          const next = { ...current };
          if (payload.permit.state === "queued") {
            next[payload.permit.requestId] = payload.permit;
          } else {
            delete next[payload.permit.requestId];
          }
          return next;
        });
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [identity, isHost, terminal]);

  // 控制提交沿用既有 /geo-operations/control 端点与 revision CAS：
  // 卡片只提交动作意图，权威状态以响应投影和后续轮询为准。
  const runControl = useCallback(
    async (action: GeoOperationControlAction) => {
      if (!identity || busyAction) return;
      setBusyAction(action);
      setControlError(null);
      try {
        const next = await controlGeoOperation(apiPost, identity, {
          operationId: live.id,
          expectedRevision: live.revision,
          action,
        });
        setLive(next);
      } catch (cause) {
        setControlError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyAction(null);
      }
    },
    [apiPost, busyAction, identity, live.id, live.revision],
  );

  const completed = live.steps.filter(
    (step) => step.status === "succeeded" || step.status === "skipped",
  ).length;

  const showPause = live.status === "running" && !!live.checkpoint?.safeToResume;
  const showResume = live.status === "paused" || live.status === "recovering";
  const showRetry =
    live.status === "failed" && live.error?.retryable === true;
  const showCancel = !terminal;
  const hasControls = showPause || showResume || showRetry || showCancel;
  const providerQueue = Object.values(providerQueues).sort(
    (left, right) =>
      (left.queuePosition ?? Number.MAX_SAFE_INTEGER) -
      (right.queuePosition ?? Number.MAX_SAFE_INTEGER),
  )[0];
  const showProviderQueueBanner =
    isHost && !terminal && live.status !== "queued" && !!providerQueue;

  return (
    <article
      className="rounded-lg bg-[var(--paper-inset)] p-2.5"
    >
      <div className="flex min-w-0 items-start gap-2">
        {statusIcon(live)}
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium text-[var(--ink)]">
            {live.goal}
          </p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {STATUS_LABEL[live.status]} · {completed}/
            {live.steps.length} 步
          </p>
          {live.status === "queued" && (
            <p className="mt-1 break-words text-xs text-[var(--info)]">
              排队位置 {live.queuePosition ?? "待分配"}
              {live.queueReason ? ` · ${live.queueReason}` : ""}
            </p>
          )}
          {live.status === "recovering" && (
            <p
              aria-live="polite"
              className="mt-1 flex items-center gap-1.5 break-words text-xs text-[var(--info)]"
            >
              <RotateCcw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              正在从已保存 checkpoint 恢复
            </p>
          )}
          <ol
            aria-label="GEO 操作步骤计划"
            className="mt-1.5 space-y-1.5"
            data-geo-operation-steps={live.id}
          >
            {groupGeoOperationSteps(live.steps).map((group) => {
              const done = group.steps.filter(
                (step) =>
                  step.status === "succeeded" || step.status === "skipped",
              ).length;
              const phaseStatus = geoOperationPhaseStatus(group.steps);
              return (
                <li key={group.id}>
                  <p
                    className={`text-xs font-medium ${
                      phaseStatus === "awaiting-confirmation" ||
                      phaseStatus === "running"
                        ? "text-[var(--warning)]"
                        : phaseStatus === "succeeded"
                          ? "text-[var(--ink-subtle)]"
                          : "text-[var(--ink-secondary)]"
                    }`}
                  >
                    {group.title} · {done}/{group.steps.length} ·{" "}
                    {STEP_STATUS_LABEL[phaseStatus]}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {group.steps.map((step) => {
                      const gate = step.confirmation;
                      const awaiting =
                        step.status === "awaiting-confirmation" && gate;
                      return (
                        <li
                          key={step.id}
                          className={`break-words text-xs leading-5 ${
                            awaiting
                              ? "text-[var(--warning)]"
                              : step.status === "succeeded" ||
                                  step.status === "skipped"
                                ? "text-[var(--ink-subtle)]"
                                : "text-[var(--ink-secondary)]"
                          }`}
                        >
                          <span className="text-[var(--ink-muted)]">
                            [{STEP_STATUS_LABEL[step.status]}]
                          </span>{" "}
                          {awaiting && gate
                            ? `${gate.title} — 停在待确认门，${gate.summary}`
                            : step.title}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {isHost &&
        identity &&
        (hasControls || showProviderQueueBanner || controlError) && (
        <div
          className="mt-2 space-y-2"
          data-geo-operation-controls={live.id}
        >
          {showProviderQueueBanner && providerQueue && (
            <p
              aria-live="polite"
              className="rounded-lg bg-[var(--info-bg)] px-2.5 py-2 text-xs text-[var(--info)]"
            >
              重型 Provider 排队位置 {providerQueue.queuePosition ?? "待分配"}
              {providerQueue.queueReason
                ? ` · ${providerQueue.queueReason}`
                : ` · 应用全局并发上限 ${providerQueue.concurrencyLimit}`}
            </p>
          )}
          {hasControls && (
            <div className="flex flex-wrap gap-2">
              {showPause && (
                <ControlButton
                  action="pause"
                  icon={<Pause className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="暂停"
                  tone="neutral"
                  busy={busyAction !== null}
                  onSubmit={runControl}
                />
              )}
              {showResume && (
                <ControlButton
                  action="resume"
                  icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="恢复"
                  tone="primary"
                  busy={busyAction !== null}
                  onSubmit={runControl}
                />
              )}
              {showRetry && (
                <ControlButton
                  action="retry"
                  icon={
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  }
                  label="重试失败单元"
                  tone="primary"
                  busy={busyAction !== null}
                  onSubmit={runControl}
                />
              )}
              {showCancel && (
                <ControlButton
                  action="cancel"
                  icon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
                  label="取消"
                  tone="danger"
                  busy={busyAction !== null}
                  onSubmit={runControl}
                />
              )}
            </div>
          )}
          {controlError && (
            <p
              role="alert"
              className="break-words rounded-lg bg-[var(--error-bg)] px-2.5 py-2 text-xs text-[var(--error)]"
            >
              {controlError}
            </p>
          )}
        </div>
      )}
      {isHost && !terminal && !isAgentResponding && (
        <div className="mt-2" data-geo-gate-panels={live.id}>
          <GeoOperationGatePanels
            operation={live}
            onGateConfirmed={() => setRefreshTick((value) => value + 1)}
          />
        </div>
      )}
    </article>
  );
}

export default memo(function GeoOperationEventCard({
  data,
}: {
  data: GeoOperationEventCardData;
}) {
  if (data.operations.length === 0) {
    return (
      <section
        aria-label="GEO 操作空状态"
        className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
        data-geo-operation-empty
      >
        <p className="text-xs font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
          GEO 操作
        </p>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">
          当前会话还没有 GEO 操作记录。
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="GEO 优化进度"
      className="space-y-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-geo-operation-event
    >
      <p className="text-xs font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
        GEO 操作已更新
      </p>
      {data.operations.slice(0, 5).map((operation) => (
        <OperationArticle key={operation.id} operation={operation} />
      ))}
      <p className="text-xs leading-5 text-[var(--ink-subtle)]">
        这是系统维护的进度卡片，不是用户发送的消息；需要你确认的操作直接在上方卡片里完成。
      </p>
    </section>
  );
});
