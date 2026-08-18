import type { GeoOperationProjection, GeoOperationStep } from "../../shared/geo/operation";
import { createGeoOperationService } from "./operation";

/**
 * Bridge between BrandWorkspace business owners and the GeoOperation step
 * state machine. Each milestone fires after the corresponding business route
 * already committed its owner-side mutation, so progress marking is
 * best-effort: it must never fail the business request. Steps whose
 * confirmation authority is `publish-scheduler` or `post-publish-monitor`
 * are intentionally NOT wired here — those stay behind the Rust UI owners.
 */

export type GeoOperationMilestone =
  | "materials-imported"
  | "knowledge-confirmed"
  | "question-pool-generated"
  | "question-pool-confirmed"
  | "baseline-probe-started"
  | "baseline-probe-finished"
  | "topic-plan-confirmed"
  | "articles-approved"
  | "distribution-confirmed";

interface MilestonePlan {
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
  "topic-plan-confirmed": {
    completeSteps: ["plan-topics"],
    confirmStep: "confirm-content-plan",
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

function stepCompletable(step: GeoOperationStep | undefined): boolean {
  return step?.status === "ready" || step?.status === "pending";
}

function transitionApplicable(
  operation: GeoOperationProjection,
  plan: MilestonePlan,
): boolean {
  if (TERMINAL_OPERATION.has(operation.status)) return false;
  const confirmTarget = plan.confirmStep
    ? operation.steps.find((step) => step.id === plan.confirmStep)
    : undefined;
  const hasCompletable = plan.completeSteps.some((stepId) =>
    stepCompletable(operation.steps.find((step) => step.id === stepId)),
  );
  if (plan.confirmStep) {
    return confirmTarget?.status === "awaiting-confirmation" || hasCompletable;
  }
  return hasCompletable;
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

  private async advance(
    operationId: string,
    plan: MilestonePlan,
  ): Promise<void> {
    for (const stepId of plan.completeSteps) {
      const step = await this.inspect(operationId, stepId);
      if (!stepCompletable(step)) continue;
      await applyWithRetry(this.service, operationId, (operation) =>
        this.service.beginStep({
          operationId,
          expectedRevision: operation.revision,
          stepId,
        }),
      );
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
