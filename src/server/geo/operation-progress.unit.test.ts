import { describe, expect, it } from "vitest";

import {
  GeoOperationProgressRecorder,
  type GeoOperationProgressService,
} from "./operation-progress";
import { planGeoOperation } from "../../shared/geo/operation";
import type { GeoOperationProjection } from "../../shared/geo/operation";

function fullOptimization(
  id: string,
  options: { planReleased?: boolean } = {},
): GeoOperationProjection {
  const plan = planGeoOperation({
    intent: "full-optimization",
    goal: "完整链路测试",
  });
  const released = options.planReleased !== false;
  if (released) {
    // 真实初始态：计划认可门已由用户放行，首个工作步骤就绪。
    plan.steps[0].status = "succeeded";
    plan.steps[1].status = "ready";
    return projectionOf(id, plan, "ready", null);
  }
  return projectionOf(id, plan, plan.status, plan.pendingConfirmation);
}

function projectionOf(
  id: string,
  plan: ReturnType<typeof planGeoOperation>,
  status: GeoOperationProjection["status"],
  pendingConfirmation: GeoOperationProjection["pendingConfirmation"],
): GeoOperationProjection {
  return {
    id,
    workspaceId: "brand-01",
    sessionId: "session-01",
    kind: plan.kind,
    goal: plan.goal,
    status,
    revision: 1,
    executionGeneration: 0,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    terminalAt: null,
    steps: plan.steps,
    inputRefs: plan.inputRefs,
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation,
    error: null,
    sourceOperationId: null,
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };
}

type Call = [action: string, stepId: string, revision: number];

class FakeService implements GeoOperationProgressService {
  operations: GeoOperationProjection[] = [];
  calls: Call[] = [];
  conflictOnce = new Set<string>();

  private stepOf(operationId: string, stepId: string) {
    const operation = this.operations.find((item) => item.id === operationId);
    if (!operation) throw new Error("geo_operation_not_found");
    const step = operation.steps.find((item) => item.id === stepId);
    if (!step) throw new Error("geo_operation_step_not_found");
    return { operation, step };
  }

  async list(): Promise<GeoOperationProjection[]> {
    return this.operations.map((operation) => structuredClone(operation));
  }

  async get(operationId: string): Promise<GeoOperationProjection> {
    const operation = this.operations.find((item) => item.id === operationId);
    if (!operation) throw new Error("geo_operation_not_found");
    return structuredClone(operation);
  }

  private mutate(
    operationId: string,
    stepId: string,
    action: string,
    expectStatus: (status: string) => boolean,
    apply: (step: GeoOperationProjection["steps"][number]) => void,
  ): GeoOperationProjection {
    const { operation, step } = this.stepOf(operationId, stepId);
    this.calls.push([action, stepId, operation.revision]);
    const key = `${action}:${stepId}`;
    if (this.conflictOnce.delete(key)) {
      throw new Error("geo_operation_revision_conflict");
    }
    if (!expectStatus(step.status)) {
      throw new Error("geo_operation_step_not_startable");
    }
    apply(step);
    operation.revision += 1;
    return structuredClone(operation);
  }

  async beginStep(input: { operationId: string; expectedRevision: number; stepId: string }) {
    return this.mutate(input.operationId, input.stepId, "begin", (status) => status === "ready", (step) => {
      step.status = "running";
    });
  }

  async completeStep(input: { operationId: string; expectedRevision: number; stepId: string }) {
    return this.mutate(input.operationId, input.stepId, "complete", (status) => status === "running", (step) => {
      step.status = "succeeded";
      const next = this.operations
        .find((item) => item.id === input.operationId)!
        .steps.find((item) => item.status === "pending");
      if (next) next.status = next.requiresConfirmation ? "awaiting-confirmation" : "ready";
    });
  }

  async recordConfirmedStep(input: { operationId: string; expectedRevision: number; stepId: string }) {
    return this.mutate(
      input.operationId,
      input.stepId,
      "confirm",
      (status) => status === "awaiting-confirmation",
      (step) => {
        step.status = "succeeded";
        const next = this.operations
          .find((item) => item.id === input.operationId)!
          .steps.find((item) => item.status === "pending");
        if (next) next.status = next.requiresConfirmation ? "awaiting-confirmation" : "ready";
      },
    );
  }
}

const identity = { workspaceId: "brand-01", sessionId: "session-01" };

describe("GeoOperationProgressRecorder", () => {
  it("advances knowledge steps and confirms the knowledge gate", async () => {
    const service = new FakeService();
    service.operations = [fullOptimization("op-1")];
    await new GeoOperationProgressRecorder(service).record(identity, "knowledge-confirmed");

    expect(service.calls.map(([action, stepId]) => `${action}:${stepId}`)).toEqual([
      "begin:collect-materials",
      "complete:collect-materials",
      "begin:extract-facts",
      "complete:extract-facts",
      "confirm:confirm-knowledge",
    ]);
    const operation = service.operations[0];
    expect(operation.steps.find((step) => step.id === "generate-question-pool")?.status).toBe("ready");
  });

  it("skips terminal operations and operations without matching steps", async () => {
    const service = new FakeService();
    const cancelled = fullOptimization("op-cancelled");
    cancelled.status = "cancelled";
    service.operations = [cancelled];
    await new GeoOperationProgressRecorder(service).record(identity, "knowledge-confirmed");
    expect(service.calls).toEqual([]);
  });

  it("retries once on revision conflict", async () => {
    const service = new FakeService();
    service.operations = [fullOptimization("op-1")];
    service.conflictOnce.add("begin:collect-materials");
    await new GeoOperationProgressRecorder(service).record(identity, "knowledge-confirmed");

    expect(service.calls.filter(([action, stepId]) => action === "begin" && stepId === "collect-materials")).toHaveLength(2);
    expect(service.operations[0].steps.find((step) => step.id === "confirm-knowledge")?.status).toBe("succeeded");
  });

  it("only confirms the question gate after the pool was generated", async () => {
    const service = new FakeService();
    const operation = fullOptimization("op-1");
    for (const step of operation.steps) step.status = "succeeded";
    const gate = operation.steps.find((step) => step.id === "confirm-question-selection")!;
    gate.status = "awaiting-confirmation";
    service.operations = [operation];

    await new GeoOperationProgressRecorder(service).record(identity, "question-pool-confirmed");
    expect(service.calls.map(([action, stepId]) => `${action}:${stepId}`)).toEqual([
      "confirm:confirm-question-selection",
    ]);
  });

  // 计划认可门未放行时，业务里程碑不能替用户推进任何步骤：
  // begin/confirm 全部按状态机规则被拒并安全跳过。
  it("keeps milestones inert while the plan acknowledgement gate is unreleased", async () => {
    const service = new FakeService();
    service.operations = [fullOptimization("op-1", { planReleased: false })];

    await new GeoOperationProgressRecorder(service).record(identity, "knowledge-confirmed");

    const operation = service.operations[0];
    expect(operation.status).toBe("awaiting-confirmation");
    expect(operation.steps.find((step) => step.id === "acknowledge-plan")?.status).toBe("awaiting-confirmation");
    expect(operation.steps.find((step) => step.id === "collect-materials")?.status).toBe("pending");
    expect(operation.steps.find((step) => step.id === "confirm-knowledge")?.status).toBe("pending");
    expect(service.operations[0].revision).toBe(1);
  });
});
