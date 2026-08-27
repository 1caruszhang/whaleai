import type {
  GeoOperationProjection,
  GeoOperationStep,
  GeoOperationStepProgress,
} from "../../shared/geo/operation";
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
  /** The confirmation gate this milestone satisfies (must be awaiting). */
  confirmStep: string | null;
}

const MILESTONES: Record<GeoOperationMilestone, MilestonePlan> = {
  "materials-imported": {
    completeSteps: ["collect-materials", "extract-facts"],
    confirmStep: null,
  },
  "knowledge-confirmed": {
    completeSteps: ["collect-materials", "extract-facts"],
    confirmStep: "confirm-knowledge",
  },
  "question-pool-generation-started": {
    beginSteps: ["generate-question-pool"],
    completeSteps: [],
    confirmStep: null,
  },
  "question-pool-generated": {
    completeSteps: ["generate-question-pool"],
    confirmStep: null,
  },
  "question-pool-confirmed": {
    completeSteps: [],
    confirmStep: "confirm-question-selection",
  },
  // The main chain no longer embeds baseline steps; a real probe only
  // advances the conditional steps of a performance-inspection operation.
  "baseline-probe-started": {
    completeSteps: [],
    confirmStep: "confirm-missing-evidence-probe",
  },
  "baseline-probe-finished": {
    completeSteps: ["probe-missing-evidence"],
    confirmStep: null,
  },
  "topic-plan-started": {
    beginSteps: ["plan-topics"],
    completeSteps: [],
    confirmStep: null,
  },
  "topic-plan-generated": {
    completeSteps: ["plan-topics"],
    confirmStep: null,
  },
  "topic-plan-confirmed": {
    completeSteps: ["plan-topics"],
    confirmStep: "confirm-content-plan",
  },
  "article-generation-started": {
    beginSteps: ["generate-articles"],
    completeSteps: [],
    confirmStep: null,
  },
  "articles-generated": {
    completeSteps: ["generate-articles"],
    confirmStep: null,
  },
  "articles-approved": {
    completeSteps: ["generate-articles"],
    confirmStep: "confirm-articles",
  },
  "distribution-confirmed": {
    completeSteps: ["plan-distribution"],
    confirmStep: "confirm-distribution",
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

const TERMINAL_OPERATION = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

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
  const confirmTarget = plan.confirmStep
    ? operation.steps.find((step) => step.id === plan.confirmStep)
    : undefined;
  const actionable = [
    ...(plan.beginSteps ?? []),
    ...plan.completeSteps,
  ];
  const hasProgressable = actionable.some((stepId) =>
    stepProgressable(operation.steps.find((step) => step.id === stepId)),
  );
  if (plan.confirmStep) {
    return confirmTarget?.status === "awaiting-confirmation" || hasProgressable;
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
    if (plan.confirmStep) {
      const step = await this.inspect(operationId, plan.confirmStep);
      if (step?.status !== "awaiting-confirmation") return;
      await applyWithRetry(this.service, operationId, (operation) =>
        this.service.recordConfirmedStep({
          operationId,
          expectedRevision: operation.revision,
          stepId: plan.confirmStep as string,
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
