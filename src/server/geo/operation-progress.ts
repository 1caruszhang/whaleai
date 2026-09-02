import type {
  GeoOperationConfirmationKind,
  GeoOperationProjection,
  GeoOperationStep,
  GeoOperationStepProgress,
} from "../../shared/geo/operation";
import {
  currentGeoOperationStep,
  GEO_STEP_PAST_STATUSES as STEP_PAST_STATUSES,
  TERMINAL_GEO_OPERATION_STATUSES,
} from "../../shared/geo/operation";
import { MATERIAL_COLLECTION_CONTRACT } from "../../shared/geo/materialRequestCard";
import { QUESTION_POOL_REUSE_CONTRACT } from "../../shared/geo/questionPool";
import type { NextStepReminderInput } from "../../shared/systemReminder";
import { createGeoOperationService } from "./operation";

/**
 * Bridge between BrandWorkspace business owners and the GeoOperation step
 * state machine. Each milestone fires after the corresponding business route
 * already committed its owner-side mutation, so progress marking is
 * best-effort: it must never fail the business request. Steps whose
 * confirmation authority is `publish-scheduler` or `post-publish-monitor`
 * are intentionally NOT wired here — those stay behind the Rust UI owners.
 *
 * 里程碑分两类：`*-started` 只 begin（工具开始执行时推进到 running，
 * 让进度条立刻反映真实工作）；完成类里程碑把已 running 的步骤 complete
 * （或对仍 ready 的步骤补 begin+complete），再放行对应确认门。
 */

export type GeoOperationMilestone =
  | "materials-imported"
  | "knowledge-confirmed"
  | "question-pool-generation-started"
  | "question-pool-generated"
  | "question-pool-confirmed"
  | "baseline-probe-started"
  | "baseline-probe-finished"
  | "topic-plan-started"
  | "topic-plan-generated"
  | "topic-plan-confirmed"
  | "article-generation-started"
  | "articles-generated"
  | "articles-approved"
  | "distribution-confirmed";

interface MilestonePlan {
  /** Steps to begin (advance to running) without completing, in order. */
  beginSteps?: readonly string[];
  /** Plain steps to start then complete, in order. */
  completeSteps: readonly string[];
  /** 同一业务事实在不同计划形态下停靠的不同 step-id（如问题选择门在
   * 全链是 confirm-question-selection、在 next-round 不更新知识计划是
   * select-next-question-pool）：逐个检查，放行所有处于 awaiting 的门。 */
  confirmSteps: readonly string[];
}

const MILESTONES: Record<GeoOperationMilestone, MilestonePlan> = {
  "materials-imported": {
    completeSteps: ["collect-materials", "extract-facts"],
    confirmSteps: [],
  },
  "knowledge-confirmed": {
    completeSteps: ["collect-materials", "extract-facts"],
    confirmSteps: ["confirm-knowledge"],
  },
  "question-pool-generation-started": {
    beginSteps: ["generate-question-pool"],
    completeSteps: [],
    confirmSteps: [],
  },
  "question-pool-generated": {
    completeSteps: ["generate-question-pool"],
    confirmSteps: [],
  },
  "question-pool-confirmed": {
    completeSteps: [],
    // 复用命中（ADR-0011 Decision 3）与正常确认共用此里程碑：全链的
    // confirm-question-selection 与 next-round 不更新知识计划的
    // select-next-question-pool 是同一道用户门在不同计划形态下的停靠。
    confirmSteps: ["confirm-question-selection", "select-next-question-pool"],
  },
  // The main chain no longer embeds baseline steps; a real probe only
  // advances the conditional steps of a performance-inspection operation.
  "baseline-probe-started": {
    completeSteps: [],
    confirmSteps: ["confirm-missing-evidence-probe"],
  },
  "baseline-probe-finished": {
    completeSteps: ["probe-missing-evidence"],
    confirmSteps: [],
  },
  "topic-plan-started": {
    beginSteps: ["plan-topics"],
    completeSteps: [],
    confirmSteps: [],
  },
  "topic-plan-generated": {
    completeSteps: ["plan-topics"],
    confirmSteps: [],
  },
  "topic-plan-confirmed": {
    completeSteps: ["plan-topics"],
    confirmSteps: ["confirm-content-plan"],
  },
  "article-generation-started": {
    beginSteps: ["generate-articles"],
    completeSteps: [],
    confirmSteps: [],
  },
  "articles-generated": {
    completeSteps: ["generate-articles"],
    confirmSteps: [],
  },
  "articles-approved": {
    completeSteps: ["generate-articles"],
    confirmSteps: ["confirm-articles"],
  },
  "distribution-confirmed": {
    completeSteps: ["plan-distribution"],
    confirmSteps: ["confirm-distribution"],
  },
};

export interface GeoOperationProgressService {
  list(): Promise<GeoOperationProjection[]>;
  get(operationId: string): Promise<GeoOperationProjection>;
  beginStep(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
  }): Promise<GeoOperationProjection>;
  completeStep(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
  }): Promise<GeoOperationProjection>;
  reportStepProgress(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
    progress: GeoOperationStepProgress;
  }): Promise<GeoOperationProjection>;
  recordConfirmedStep(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
  }): Promise<GeoOperationProjection>;
}

/** 终态操作集（导出供顺序闸等消费方同口径判定「非终态」）；口径下沉
 * shared policy（票 07），此处按既有名字转发，消费方零改动。「已走完」
 * 步骤状态集与 currentGeoOperationStep 同源 shared policy，上方以
 * STEP_PAST_STATUSES 别名引入，正文复用。 */
export const TERMINAL_OPERATION = TERMINAL_GEO_OPERATION_STATUSES;

export { currentGeoOperationStep };

/**
 * next-step 单表（ADR-0011 Decision 2，与上方里程碑表同文件维护）：
 * step-id → {工具名, 一句话指引}，决策回执信封引述的唯一事实源。只收录
 * 由 agent 的 MCP 工具推进的计划步骤——里程碑自动收尾的步骤（如
 * extract-facts 随 materials-imported 与 collect-materials 一并完成）与
 * 工作台/Rust UI 持有的阶段（发布跟踪、监测链）不入表：查不到就不引述，
 * 信封退回收据形态，不虚构工具。表内工具名与 MCP 注册表的一致性由
 * 集成测试守护（表内工具名必须真实存在）。
 */
export interface GeoNextStepGuide {
  tool: string;
  guidance: string;
}

export const GEO_NEXT_STEP_GUIDES: Readonly<Record<string, GeoNextStepGuide>> = {
  "collect-materials": {
    tool: "request_brand_material",
    // 材料收集契约（票 03）：话术与工具描述、系统提示词材料段逐字同源
    //（MATERIAL_COLLECTION_CONTRACT）——引述里就说清按计划调用即安全，
    // 不在调用现场重新权衡品牌知识是否够用。
    guidance: `Request brand material on the chat material-request card and wait there — ${MATERIAL_COLLECTION_CONTRACT}; pasted text goes through import_pasted_material.`,
  },
  "decide-knowledge-refresh": {
    tool: "choose_next_round_knowledge",
    guidance:
      "Ask the user whether this round refreshes brand knowledge, then record the explicit answer with choose_next_round_knowledge.",
  },
  "generate-question-pool": {
    tool: "run_question_pool",
    // 复用契约（ADR-0011 Decision 3）：话术与工具描述、结果信封逐字同源
    //（QUESTION_POOL_REUSE_CONTRACT）——引述里就说清按计划调用即安全。
    guidance: `Call run_question_pool for the confirmed product line and target region without judging whether to skip — ${QUESTION_POOL_REUSE_CONTRACT}; when the service generates a fresh pool instead, the selection card parks at the question gate.`,
  },
  "select-next-question-pool": {
    tool: "run_question_pool",
    // 复用契约（ADR-0011 Decision 3，2026-09-01 修订）：与
    // generate-question-pool 条目同源话术——按计划调用即安全；复用命中
    // 停卡重选（预勾上次选择），只有用户的卡片确认才放行问题门。
    guidance: `Call run_question_pool as planned without judging whether to skip — ${QUESTION_POOL_REUSE_CONTRACT}.`,
  },
  "plan-topics": {
    tool: "plan_topics",
    guidance:
      "Plan topics, types and titles from the confirmed question selection; the topic-plan card parks at the content gate.",
  },
  "generate-articles": {
    tool: "generate_articles",
    guidance:
      "Generate articles for the confirmed topic-plan items (pass itemIds only for an explicit user-picked subset); drafts park at the approval gate.",
  },
  "plan-distribution": {
    tool: "plan_distribution",
    guidance:
      "Plan channel distribution for the approved articles; the plan card parks at the distribution gate.",
  },
  "prepare-publish": {
    tool: "prepare_publish",
    guidance:
      "Build the publish preview (items, channels and points costs) with prepare_publish; paid publish authorization stays with the user on the card.",
  },
};

/** 决策回执信封携带的引述：步骤、工具、指引与所引述计划快照的 revision。
 * 与 builder 侧的 NextStepReminderInput 同一契约（结构一致，直传）。 */
export type GeoNextStepQuotation = NextStepReminderInput;

/**
 * 从持久化计划引述 next-step（ADR-0011 Decision 2）：锚定 afterStepId 时
 * 取其后首个未走完的步骤，无锚点时取整单首个未走完步骤。查不到表项、
 * 计划走完或操作终态时返回 null——信封退回收据形态，绝不虚构引述。
 */
export function quoteGeoNextStep(
  operation: GeoOperationProjection,
  afterStepId?: string,
): GeoNextStepQuotation | null {
  if (TERMINAL_OPERATION.has(operation.status)) return null;
  const anchorIndex = afterStepId
    ? operation.steps.findIndex((step) => step.id === afterStepId)
    : -1;
  if (afterStepId && anchorIndex === -1) return null;
  const candidate = currentGeoOperationStep(
    operation.steps.slice(anchorIndex + 1),
  );
  if (!candidate) return null;
  const guide = GEO_NEXT_STEP_GUIDES[candidate.id];
  if (!guide) return null;
  return {
    stepId: candidate.id,
    tool: guide.tool,
    guidance: guide.guidance,
    planRevision: operation.revision,
  };
}

/**
 * 按确认门类引述：在活跃操作里找尚未裁决（pending 或停靠中）的该类门，
 * 引述其后的计划步骤。兼容两类停靠时机——问题池/选题/文章/知识的门由
 * 生成里程碑提前停靠（awaiting-confirmation），分发门只在确认路由的
 * 里程碑里完成停靠（信封投递时仍 pending）。多个操作命中同一门类时取
 * updatedAt 最新的一个；没有匹配门（如知识决策发生在任何操作之外，或
 * 门已被放行/跳过）返回 null。
 */
export function quoteNextStepForGate(
  operations: readonly GeoOperationProjection[],
  gateKind: GeoOperationConfirmationKind,
): GeoNextStepQuotation | null {
  const active = operations
    .filter((operation) => !TERMINAL_OPERATION.has(operation.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const operation of active) {
    const gate = operation.steps.find(
      (step) =>
        step.confirmation?.kind === gateKind &&
        !STEP_PAST_STATUSES.has(step.status),
    );
    if (!gate) continue;
    const quotation = quoteGeoNextStep(operation, gate.id);
    if (quotation) return quotation;
  }
  return null;
}

/**
 * 决策路由的引述入口：读当前 Session 的活跃操作，按门类引述 next-step，
 * 供信封 builder 的可选 nextStep 字段直接使用。引述是 best-effort——
 * 读取失败返回 undefined，绝不阻塞信封投递。
 */
export async function quoteGeoNextStepForGateKind(
  identity: { workspaceId: string; sessionId: string },
  gateKind: GeoOperationConfirmationKind,
): Promise<GeoNextStepQuotation | undefined> {
  try {
    return quoteNextStepForGate(
      await createGeoOperationService(identity).list(),
      gateKind,
    ) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 操作事件信封的引述锚点策略：confirm-step 锚定刚放行的门之后，
 * resume/retry/next-round/skip-material-collection 锚定首个未完成步骤；
 * pause/cancel 是停进或终态，不引述。跳过出口（票 07）的回执读的是替换
 * 后的持久化计划——引述即跳过后的真实下一步，与顺序闸同口径不分叉。
 */
export function quoteGeoNextStepForAction(
  operation: GeoOperationProjection,
  action: string,
): GeoNextStepQuotation | undefined {
  if (action.startsWith("confirm-step:")) {
    return quoteGeoNextStep(operation, action.slice("confirm-step:".length)) ?? undefined;
  }
  if (
    action === "resume" ||
    action === "retry" ||
    action === "skip-material-collection" ||
    action.startsWith("next-round-")
  ) {
    return quoteGeoNextStep(operation) ?? undefined;
  }
  return undefined;
}

/**
 * 可推进 = 尚未终态。running 也算：started 里程碑已 begin 的步骤由
 * 完成类里程碑收尾（Rust complete-step 要求步骤恰为 running）。
 */
function stepProgressable(step: GeoOperationStep | undefined): boolean {
  return (
    step?.status === "ready" ||
    step?.status === "pending" ||
    step?.status === "running"
  );
}

function transitionApplicable(
  operation: GeoOperationProjection,
  plan: MilestonePlan,
): boolean {
  if (TERMINAL_OPERATION.has(operation.status)) return false;
  const confirmTargets = plan.confirmSteps
    .map((stepId) => operation.steps.find((step) => step.id === stepId))
    .filter((step): step is GeoOperationStep => step !== undefined);
  const actionable = [
    ...(plan.beginSteps ?? []),
    ...plan.completeSteps,
  ];
  const hasProgressable = actionable.some((stepId) =>
    stepProgressable(operation.steps.find((step) => step.id === stepId)),
  );
  if (plan.confirmSteps.length > 0) {
    return (
      confirmTargets.some((step) => step.status === "awaiting-confirmation") ||
      hasProgressable
    );
  }
  return hasProgressable;
}

async function applyWithRetry(
  service: GeoOperationProgressService,
  operationId: string,
  action: (operation: GeoOperationProjection) => Promise<GeoOperationProjection>,
): Promise<GeoOperationProjection | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const operation = await service.get(operationId);
    if (TERMINAL_OPERATION.has(operation.status)) return operation;
    try {
      return await action(operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && message.includes("revision_conflict")) continue;
      if (
        message.includes("geo_operation_step_not_") ||
        message.includes("geo_operation_confirmation_step_invalid") ||
        message.includes("geo_operation_status_invalid")
      ) {
        return operation;
      }
      throw error;
    }
  }
  return null;
}

export class GeoOperationProgressRecorder {
  constructor(private readonly service: GeoOperationProgressService) {}

  async record(
    identity: { workspaceId: string; sessionId: string },
    milestone: GeoOperationMilestone,
  ): Promise<void> {
    const plan = MILESTONES[milestone];
    let operations: GeoOperationProjection[];
    try {
      operations = await this.service.list();
    } catch {
      return;
    }
    const candidates = operations.filter((operation) =>
      transitionApplicable(operation, plan),
    );
    for (const operation of candidates) {
      try {
        await this.advance(operation.id, plan);
      } catch {
        // Progress marking is best-effort; the business mutation that
        // triggered the milestone has already committed.
      }
    }
  }

  /**
   * 量化进度上报（如逐篇生成 N/M）：只作用于该步骤已 running 的操作，
   * 逐篇回报、并发安全（applyWithRetry 内重取 revision）。
   */
  async reportStepProgress(
    identity: { workspaceId: string; sessionId: string },
    stepId: string,
    progress: GeoOperationStepProgress,
  ): Promise<void> {
    let operations: GeoOperationProjection[];
    try {
      operations = await this.service.list();
    } catch {
      return;
    }
    const candidates = operations.filter(
      (operation) =>
        !TERMINAL_OPERATION.has(operation.status) &&
        operation.steps.some(
          (step) => step.id === stepId && step.status === "running",
        ),
    );
    for (const operation of candidates) {
      try {
        await applyWithRetry(this.service, operation.id, (current) =>
          this.service.reportStepProgress({
            operationId: current.id,
            expectedRevision: current.revision,
            stepId,
            progress,
          }),
        );
      } catch {
        // Best-effort: 下一次逐篇回报会带上最新计数。
      }
    }
  }

  private async advance(
    operationId: string,
    plan: MilestonePlan,
  ): Promise<void> {
    for (const stepId of plan.beginSteps ?? []) {
      const step = await this.inspect(operationId, stepId);
      if (step?.status !== "ready") continue;
      await applyWithRetry(this.service, operationId, (operation) =>
        this.service.beginStep({
          operationId,
          expectedRevision: operation.revision,
          stepId,
        }),
      );
    }
    for (const stepId of plan.completeSteps) {
      let step = await this.inspect(operationId, stepId);
      if (step?.status === "ready") {
        await applyWithRetry(this.service, operationId, (operation) =>
          this.service.beginStep({
            operationId,
            expectedRevision: operation.revision,
            stepId,
          }),
        );
        step = await this.inspect(operationId, stepId);
      }
      if (step?.status !== "running") continue;
      await applyWithRetry(this.service, operationId, (operation) =>
        this.service.completeStep({
          operationId,
          expectedRevision: operation.revision,
          stepId,
        }),
      );
    }
    for (const stepId of plan.confirmSteps) {
      const step = await this.inspect(operationId, stepId);
      if (step?.status !== "awaiting-confirmation") continue;
      await applyWithRetry(this.service, operationId, (operation) =>
        this.service.recordConfirmedStep({
          operationId,
          expectedRevision: operation.revision,
          stepId,
        }),
      );
    }
  }

  private async inspect(
    operationId: string,
    stepId: string,
  ): Promise<GeoOperationStep | undefined> {
    const operation = await this.service.get(operationId);
    return operation.steps.find((step) => step.id === stepId);
  }
}

let recorder: GeoOperationProgressRecorder | undefined;

/**
 * Fire-and-forget milestone marking for the current Sidecar session. Routes
 * call this after their business owner committed; failures are swallowed by
 * the recorder so they cannot change the business response.
 */
export async function recordGeoOperationMilestone(
  identity: { workspaceId: string; sessionId: string },
  milestone: GeoOperationMilestone,
): Promise<void> {
  try {
    recorder ??= new GeoOperationProgressRecorder(
      createGeoOperationService(identity),
    );
    await recorder.record(identity, milestone);
  } catch {
    // Best-effort only.
  }
}

/**
 * Fire-and-forget 量化进度上报（如逐篇生成 N/M）给当前 Sidecar Session 的
 * 匹配操作。调用方不得 await 后再继续业务——逐篇并发回报时串行等待会
 * 拖慢生成；失败由内部吞掉，下一次回报自然校正。
 */
export async function reportGeoOperationStepProgress(
  identity: { workspaceId: string; sessionId: string },
  stepId: string,
  progress: GeoOperationStepProgress,
): Promise<void> {
  try {
    recorder ??= new GeoOperationProgressRecorder(
      createGeoOperationService(identity),
    );
    await recorder.reportStepProgress(identity, stepId, progress);
  } catch {
    // Best-effort only.
  }
}
