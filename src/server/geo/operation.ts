import {
  planGeoOperation,
  type GeoOperationCheckpoint,
  type GeoOperationError,
  type GeoOperationKind,
  type GeoOperationPlan,
  type GeoOperationProjection,
  type GeoOperationReference,
  type GeoOperationStep,
  type GeoOperationStepProgress,
  type GeoOperationTakeoverReceipt,
  type GeoOperationUnfinishedSummary,
} from "../../shared/geo/operation";
import { managementApi } from "../utils/management-api-client";

export type GeoOperationControlAction = "pause" | "resume" | "retry" | "cancel";

type GeoOperationPersistenceAction =
  | GeoOperationControlAction
  | "queue-step"
  | "update-queue"
  | "start-step"
  | "checkpoint"
  | "complete-step"
  | "report-step-progress"
  | "skip-step"
  | "confirm-step"
  | "fail-step"
  | "recover"
  | "replace-plan";

export interface GeoOperationCreateInput {
  intent: GeoOperationKind;
  goal: string;
  inputRefs?: GeoOperationReference[];
  sourceOperationId?: string;
  updateKnowledge?: boolean;
}

export interface GeoOperationListInput {
  includeAllSessions?: boolean;
  limit?: number;
}

interface GeoOperationCreateRequest {
  workspaceId: string;
  sessionId: string;
  kind: GeoOperationKind;
  goal: string;
  status: GeoOperationPlan["status"];
  steps: GeoOperationStep[];
  inputRefs: GeoOperationReference[];
  pendingConfirmation: GeoOperationPlan["pendingConfirmation"];
  sourceOperationId?: string;
}

interface GeoOperationMutationRequest {
  workspaceId: string;
  sessionId: string;
  operationId: string;
  expectedRevision: number;
  action: GeoOperationPersistenceAction;
  stepId?: string;
  checkpoint?: GeoOperationCheckpoint;
  error?: GeoOperationError;
  artifactRefs?: GeoOperationReference[];
  replacementSteps?: GeoOperationStep[];
  stepProgress?: GeoOperationStepProgress;
  queueReason?: string;
  queuePosition?: number;
  expectedExecutionGeneration?: number;
}

export interface GeoOperationPersistencePort {
  create(request: GeoOperationCreateRequest): Promise<GeoOperationProjection>;
  get(operationId: string): Promise<GeoOperationProjection>;
  list(input: GeoOperationListInput): Promise<GeoOperationProjection[]>;
  mutate(request: GeoOperationMutationRequest): Promise<GeoOperationProjection>;
  /** 跨会话只读元信息（ADR-0010）：品牌内非终态轮次，不含正文/聊天记录。 */
  listUnfinished(): Promise<GeoOperationUnfinishedSummary[]>;
  /** 接管 mutation（ADR-0010）：CAS 所有权转移到当前 Session。 */
  takeover(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<GeoOperationTakeoverReceipt>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "geo_operation_persistence_failed",
  );
}

export class RustGeoOperationPort implements GeoOperationPersistencePort {
  constructor(
    private readonly identity: {
      workspaceId: string;
      sessionId: string;
      sidecarId: string;
    },
  ) {}

  private async post<T>(
    path: string,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<T> {
    const result = await managementApi(path, "POST", {
      ...this.identity,
      payload,
    });
    if (result.ok !== true) throw persistenceError(result);
    return result[key] as T;
  }

  create(request: GeoOperationCreateRequest): Promise<GeoOperationProjection> {
    return this.post(
      "/api/brand-geo-operations/create",
      request as unknown as Record<string, unknown>,
      "operation",
    );
  }

  get(operationId: string): Promise<GeoOperationProjection> {
    return this.post(
      "/api/brand-geo-operations/get",
      { operationId },
      "operation",
    );
  }

  list(input: GeoOperationListInput): Promise<GeoOperationProjection[]> {
    return this.post(
      "/api/brand-geo-operations/list",
      input as Record<string, unknown>,
      "operations",
    );
  }

  listUnfinished(): Promise<GeoOperationUnfinishedSummary[]> {
    return this.post(
      "/api/brand-geo-operations/unfinished",
      {},
      "operations",
    );
  }

  takeover(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<GeoOperationTakeoverReceipt> {
    return this.post(
      "/api/brand-geo-operations/takeover",
      input as unknown as Record<string, unknown>,
      "takeover",
    );
  }

  mutate(
    request: GeoOperationMutationRequest,
  ): Promise<GeoOperationProjection> {
    return this.post(
      "/api/brand-geo-operations/mutate",
      request as unknown as Record<string, unknown>,
      "operation",
    );
  }
}

/**
 * Brand-scoped orchestration seam. It owns intent planning and lifecycle
 * transitions; concrete GEO modules keep owning their algorithms and artifacts.
 */
export class GeoOperationService {
  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly persistence: GeoOperationPersistencePort,
  ) {}

  create(input: GeoOperationCreateInput): Promise<GeoOperationProjection> {
    const plan = planGeoOperation(input);
    return this.persistence.create({
      ...this.identity,
      kind: plan.kind,
      goal: plan.goal,
      status: plan.status,
      steps: plan.steps,
      inputRefs: plan.inputRefs,
      pendingConfirmation: plan.pendingConfirmation,
      sourceOperationId: plan.sourceOperationId,
    });
  }

  get(operationId: string): Promise<GeoOperationProjection> {
    return this.persistence.get(operationId);
  }

  list(input: GeoOperationListInput = {}): Promise<GeoOperationProjection[]> {
    return this.persistence.list(input);
  }

  /**
   * 跨会话只读 tracer（ADR-0010 Decision 3）：本品牌所有会话的非终态
   * 轮次元信息——类型、卡住步骤、待审数量、所属会话、时间。供品牌状态
   * 摘要在新会话一次读取；不含草稿正文与聊天记录。
   */
  listUnfinished(): Promise<GeoOperationUnfinishedSummary[]> {
    return this.persistence.listUnfinished();
  }

  /**
   * 接管一个未完成轮次（ADR-0010）：经信息闸门卡片整卡一次确认后调用，
   * CAS 把所有权（含 awaiting-selection 池与未批准草稿）转移到当前
   * Session。运行中/终态/已被抢的拒绝由 Rust 返回可转述错误，调用方
   * （MCP 工具层）翻译为恢复指引。
   */
  takeover(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<GeoOperationTakeoverReceipt> {
    return this.persistence.takeover(input);
  }

  control(input: {
    operationId: string;
    expectedRevision: number;
    action: GeoOperationControlAction;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: input.action });
  }

  async chooseNextRoundKnowledge(input: {
    operationId: string;
    expectedRevision: number;
    updateKnowledge: boolean;
  }): Promise<GeoOperationProjection> {
    const operation = await this.persistence.get(input.operationId);
    if (
      operation.kind !== "next-round-optimization" ||
      operation.status !== "awaiting-confirmation" ||
      operation.steps.length !== 1 ||
      operation.steps[0]?.id !== "decide-knowledge-refresh"
    ) {
      throw new Error("geo_operation_next_round_decision_invalid");
    }
    const plan = planGeoOperation({
      intent: operation.kind,
      goal: operation.goal,
      inputRefs: operation.inputRefs,
      sourceOperationId: operation.sourceOperationId ?? undefined,
      updateKnowledge: input.updateKnowledge,
    });
    // 用户在聊天里显式回答了分支问题，这次交互本身就是计划放行：
    // 剥离计划认可门，替换后的计划直接从首个工作步骤（或首个产物门）开始。
    const releasedSteps = plan.steps.filter(
      (step) => step.confirmation?.kind !== "plan-ack",
    );
    return this.mutate({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      action: "replace-plan",
      replacementSteps: releasedSteps,
    });
  }

  beginStep(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration?: number;
    stepId: string;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "start-step" });
  }

  queueStep(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration: number;
    stepId: string;
    queueReason: string;
    queuePosition: number;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "queue-step" });
  }

  updateQueue(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration: number;
    queueReason: string;
    queuePosition: number;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "update-queue" });
  }

  checkpoint(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration?: number;
    checkpoint: GeoOperationCheckpoint;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "checkpoint" });
  }

  reportStepProgress(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
    progress: GeoOperationStepProgress;
  }): Promise<GeoOperationProjection> {
    return this.mutate({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      action: "report-step-progress",
      stepId: input.stepId,
      stepProgress: input.progress,
    });
  }

  markRecovering(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration?: number;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "recover" });
  }

  completeStep(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration?: number;
    stepId: string;
    artifactRefs?: GeoOperationReference[];
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "complete-step" });
  }

  skipConditionalStep(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "skip-step" });
  }

  async recordConfirmedStep(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
    artifactRefs?: GeoOperationReference[];
  }): Promise<GeoOperationProjection> {
    const operation = await this.persistence.get(input.operationId);
    const step = operation.steps.find(
      (candidate) => candidate.id === input.stepId,
    );
    if (!step?.confirmation) {
      throw new Error("geo_operation_confirmation_step_invalid");
    }
    if (
      step.confirmation.authority === "publish-scheduler" ||
      step.confirmation.authority === "post-publish-monitor"
    ) {
      throw new Error("geo_operation_confirmation_requires_rust_ui_authority");
    }
    return this.mutate({ ...input, action: "confirm-step" });
  }

  failStep(input: {
    operationId: string;
    expectedRevision: number;
    expectedExecutionGeneration?: number;
    stepId: string;
    error: GeoOperationError;
  }): Promise<GeoOperationProjection> {
    return this.mutate({ ...input, action: "fail-step" });
  }

  private mutate(
    input: Omit<GeoOperationMutationRequest, "workspaceId" | "sessionId">,
  ): Promise<GeoOperationProjection> {
    return this.persistence.mutate({
      ...this.identity,
      ...input,
    });
  }
}

export function createGeoOperationService(identity: {
  workspaceId: string;
  sessionId: string;
}): GeoOperationService {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error("GeoOperation requires an authenticated Sidecar identity");
  }
  return new GeoOperationService(
    identity,
    new RustGeoOperationPort({ ...identity, sidecarId }),
  );
}
