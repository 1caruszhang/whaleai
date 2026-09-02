import {
  currentGeoOperationStep,
  GEO_STEP_PAST_STATUSES,
  KNOWLEDGE_SEGMENT_STEP_IDS,
  planGeoOperation,
  RUST_UI_CONFIRMATION_AUTHORITIES,
  TERMINAL_GEO_OPERATION_STATUSES,
  type GeoOperationCheckpoint,
  type GeoOperationError,
  type GeoOperationKind,
  type GeoOperationPhaseId,
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
  /**
   * 起点推导理由（票 #27，ADR-0010 Decision 5）：经带推荐选项问得到用户
   * 选择后由 MCP 工具层传入；只随计划进入认可门 summary，不改步骤序列。
   */
  startingPointReason?: string;
  /**
   * 终点阶段与终点理由（起止推导）：计划卡呈现从起点到终点的完整跨度，
   * 轮内不再为同一链条新起操作重复征询。透传给 planGeoOperation 裁决
   * 下游合法性与步骤组合。
   */
  endingPhase?: GeoOperationPhaseId;
  endingPointReason?: string;
}

export interface GeoOperationListInput {
  includeAllSessions?: boolean;
  limit?: number;
}

/** 截断视图（Rust `GeoOperationUnfinishedList`）：最新至多 5 条元信息 + 品牌
 * 内非终态轮次全量计数——弃置轮次只累积不消失，无上界会让每个新会话的
 * 品牌状态摘要为全部历史轮次付上下文。 */
export interface GeoOperationUnfinishedList {
  operations: GeoOperationUnfinishedSummary[];
  total: number;
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
  /** 本轮「是否更新品牌知识」的显式决策（票 #04）：随创建持久化到投影；
   * 未携带归一为 null（未决/不适用），不靠 kind 意图标签回推。 */
  updateKnowledge?: boolean | null;
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
  /** 仅 replace-plan 消费（票 #04）：知识分支的用户显式答案随计划替换
   * 一并落库；其他动作忽略，避免散落第二条写入路径。 */
  updateKnowledge?: boolean;
  /** replace-plan 的调用场景（票 07）：缺省 = 知识分支决策（既有唯一
   * 形态，守卫要求停卡在 decide-knowledge-refresh 单步）；
   * 'material-collection-skip' = 材料收集跳过出口——Rust 守卫按场景
   * 校验替换形状（只允许剥离知识段未走完步骤），不放宽成自由计划编辑。 */
  replacementReason?: string;
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
  /** 跨会话只读元信息（ADR-0010）：品牌内非终态轮次，不含正文/聊天记录；
   * 条目按最新截到上界，total 报全量计数。 */
  listUnfinished(): Promise<GeoOperationUnfinishedList>;
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

  listUnfinished(): Promise<GeoOperationUnfinishedList> {
    // 响应同时携带 operations 与 total 两个键，无法走单键的 post 助手。
    return managementApi(
      "/api/brand-geo-operations/unfinished",
      "POST",
      { ...this.identity, payload: {} },
    ).then((result) => {
      if (result.ok !== true) throw persistenceError(result);
      const operations = Array.isArray(result.operations)
        ? (result.operations as GeoOperationUnfinishedSummary[])
        : [];
      // total 是上界语义的一半：缺失说明对端 Rust 版本落后于契约
      // （截断已发生但未上报），静默降级会让摘要谎报 truncatedCount=0。
      if (typeof result.total !== "number") {
        throw new Error("geo_operation_unfinished_total_missing");
      }
      return { operations, total: result.total };
    });
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
      updateKnowledge: input.updateKnowledge ?? null,
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
   * 摘要在新会话一次读取；不含草稿正文与聊天记录；条目按最新截到
   * 上界，total 报全量计数。
   */
  listUnfinished(): Promise<GeoOperationUnfinishedList> {
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
      // 决策随替换一次落库（票 #04）：一次 mutation 一次 revision 递增，
      // 不为持久化分支答案另开写入路径。
      updateKnowledge: input.updateKnowledge,
    });
  }

  /**
   * 跳过出口（geo-plan-normalization 票 07）：用户在材料请求卡上确认
   * 「跳过材料收集」后，走既有 replace-plan 计划替换动作剥离知识段剩余
   * 步骤——已完成/已确认步骤保留，替换后从首个未走完步骤续接。不为该
   * 场景新增里程碑：里程碑推进器的确认门放行只作用于「等待确认」步骤，
   * 够不着被前置步骤挡住的等待门。跳过即本轮不更新知识，决策随替换
   * 落库（票 #04 同机制），跨会话摘要据实显示复用轮。
   */
  async skipMaterialCollection(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<GeoOperationProjection> {
    const operation = await this.persistence.get(input.operationId);
    const current = currentGeoOperationStep(operation.steps);
    if (
      TERMINAL_GEO_OPERATION_STATUSES.has(operation.status) ||
      !current ||
      !KNOWLEDGE_SEGMENT_STEP_IDS.has(current.id)
    ) {
      throw new Error("geo_operation_material_skip_invalid");
    }
    const replacementSteps = operation.steps.filter(
      (step) =>
        !KNOWLEDGE_SEGMENT_STEP_IDS.has(step.id) ||
        GEO_STEP_PAST_STATUSES.has(step.status),
    );
    return this.mutate({
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      action: "replace-plan",
      replacementSteps,
      replacementReason: "material-collection-skip",
      updateKnowledge: false,
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
    if (RUST_UI_CONFIRMATION_AUTHORITIES.has(step.confirmation.authority)) {
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
