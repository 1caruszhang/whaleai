import { describe, expect, it } from "vitest";

import {
  GEO_NEXT_STEP_GUIDES,
  GeoOperationProgressRecorder,
  quoteGeoNextStep,
  quoteGeoNextStepForAction,
  quoteNextStepForGate,
  type GeoOperationProgressService,
} from "./operation-progress";
import {
  GEO_OPERATION_PHASE_ID_ORDER,
  planGeoOperation,
  type GeoOperationConfirmationKind,
} from "../../shared/geo/operation";
import type {
  GeoOperationProjection,
  PlanGeoOperationInput,
} from "../../shared/geo/operation";

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

/** 前置步骤全部完成、目标步骤就绪的操作（用于内容生产段）。 */
function operationWithStepReady(
  id: string,
  stepId: string,
): GeoOperationProjection {
  const operation = fullOptimization(id);
  const target = operation.steps.findIndex((step) => step.id === stepId);
  if (target < 0) throw new Error(`step not found: ${stepId}`);
  for (const [index, step] of operation.steps.entries()) {
    if (index < target) step.status = "succeeded";
    else if (index === target) step.status = "ready";
    else step.status = "pending";
  }
  return operation;
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

  async reportStepProgress(input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
    progress: { current: number; total: number };
  }) {
    const { operation, step } = this.stepOf(input.operationId, input.stepId);
    this.calls.push(["progress", input.stepId, operation.revision]);
    if (step.status !== "running") {
      throw new Error("geo_operation_step_not_progressable");
    }
    step.progress = { ...input.progress };
    operation.revision += 1;
    return structuredClone(operation);
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

/** 五类决策回执信封对应的确认门 kind（ADR-0011 Decision 2 引述范围）。 */
const FIVE_DECISION_GATE_KINDS: readonly GeoOperationConfirmationKind[] = [
  "knowledge-change",
  "question-selection",
  "topic-plan",
  "article-approval",
  "distribution-plan",
];

describe("next-step 引述（ADR-0011 Decision 2）", () => {
  it("锚定确认门后引述下一个计划步骤：工具名 + 一句话指引 + 计划 revision", () => {
    const operation = operationWithStepReady("op-1", "generate-question-pool");
    operation.revision = 9;
    expect(quoteGeoNextStep(operation, "confirm-knowledge")).toEqual({
      stepId: "generate-question-pool",
      tool: "run_question_pool",
      guidance: GEO_NEXT_STEP_GUIDES["generate-question-pool"]!.guidance,
      planRevision: 9,
    });
  });

  it("无锚点时引述首个未完成步骤；succeeded/skipped 一律跨过", () => {
    const operation = fullOptimization("op-1");
    // 计划已放行、知识链已完成，问题池被跳过：应引述选题而非问题池。
    for (const step of operation.steps) step.status = "succeeded";
    operation.steps.find((step) => step.id === "generate-question-pool")!.status = "skipped";
    operation.steps.find((step) => step.id === "confirm-question-selection")!.status = "skipped";
    operation.steps.find((step) => step.id === "plan-topics")!.status = "ready";
    const quotation = quoteGeoNextStep(operation);
    expect(quotation?.stepId).toBe("plan-topics");
    expect(quotation?.tool).toBe("plan_topics");
  });

  it("终态操作、锚点不存在、计划走完、表外步骤一律不引述（信封退回收据）", () => {
    const cancelled = fullOptimization("op-1");
    cancelled.status = "cancelled";
    expect(quoteGeoNextStep(cancelled, "confirm-knowledge")).toBeNull();

    const operation = fullOptimization("op-1");
    expect(quoteGeoNextStep(operation, "no-such-step")).toBeNull();

    const finished = fullOptimization("op-1");
    finished.status = "succeeded";
    for (const step of finished.steps) step.status = "succeeded";
    expect(quoteGeoNextStep(finished)).toBeNull();

    const outside = fullOptimization("op-1");
    const probe = planGeoOperation({
      intent: "performance-inspection",
      goal: "效果巡检",
    });
    outside.steps = probe.steps;
    expect(quoteGeoNextStep(outside, "acknowledge-plan")).toBeNull();
  });

  it("按门类引述：命中未裁决门所在操作，兼容两种问题选择门 step-id", () => {
    const operation = operationWithStepReady("op-1", "generate-articles");
    const gate = operation.steps.find((step) => step.id === "confirm-content-plan")!;
    gate.status = "awaiting-confirmation";
    expect(quoteNextStepForGate([operation], "topic-plan")?.stepId).toBe("generate-articles");

    const keepKnowledge = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮不更新知识",
      updateKnowledge: false,
    });
    const nextRound = projectionOf("op-2", keepKnowledge, "awaiting-confirmation", null);
    nextRound.steps[0]!.status = "succeeded"; // plan-ack released
    nextRound.steps[1]!.status = "awaiting-confirmation"; // select-next-question-pool
    const quotation = quoteNextStepForGate([nextRound], "question-selection");
    expect(quotation?.stepId).toBe("plan-topics");
    expect(quotation?.tool).toBe("plan_topics");
  });

  it("多个活跃操作命中同一门类时取 updatedAt 最新的一个；已裁决门不参与", () => {
    const stale = operationWithStepReady("op-stale", "generate-articles");
    const staleGate = stale.steps.find((step) => step.id === "confirm-content-plan")!;
    staleGate.status = "awaiting-confirmation";
    stale.updatedAt = "2026-08-01T00:00:00Z";

    const fresh = operationWithStepReady("op-fresh", "plan-distribution");
    const freshGate = fresh.steps.find((step) => step.id === "confirm-articles")!;
    freshGate.status = "awaiting-confirmation";
    fresh.updatedAt = "2026-08-02T00:00:00Z";

    expect(quoteNextStepForGate([stale, fresh], "article-approval")?.stepId).toBe("plan-distribution");
    expect(quoteNextStepForGate([stale, fresh], "topic-plan")?.stepId).toBe("generate-articles");

    // 已裁决完成的门（succeeded）不再命中；fresh 的门放行后回落到 stale
    // 仍停靠的同门类操作——引述是计划引述，两单此处一致。
    freshGate.status = "succeeded";
    expect(quoteNextStepForGate([stale, fresh], "article-approval")?.stepId).toBe("plan-distribution");
    staleGate.status = "succeeded";
    expect(quoteNextStepForGate([stale, fresh], "topic-plan")).toBeNull();
    // 两单的文章门全部裁决（stale 的 confirm-articles 由 pending 放行）后才归零：
    // pending 门在信封投递时可能尚未停靠（分发的门只在确认里程碑停靠）。
    stale.steps.find((step) => step.id === "confirm-articles")!.status = "succeeded";
    expect(quoteNextStepForGate([stale, fresh], "article-approval")).toBeNull();
  });

  it("分发门在信封投递时仍 pending（只在确认里程碑停靠）也能引述", () => {
    const operation = operationWithStepReady("op-1", "plan-distribution");
    const gate = operation.steps.find((step) => step.id === "confirm-distribution")!;
    gate.status = "pending";
    expect(quoteNextStepForGate([operation], "distribution-plan")?.stepId).toBe("prepare-publish");
    expect(quoteNextStepForGate([operation], "distribution-plan")?.tool).toBe("prepare_publish");
  });

  it("操作事件按 action 推导锚点：confirm-step 锚定该门，resume/retry/next-round 取首个未完成步骤，pause/cancel 不引述", () => {
    const operation = operationWithStepReady("op-1", "collect-materials");
    operation.status = "awaiting-confirmation";
    operation.steps[0]!.status = "awaiting-confirmation"; // acknowledge-plan
    expect(quoteGeoNextStepForAction(operation, "confirm-step:acknowledge-plan")?.stepId).toBe("collect-materials");

    const paused = operationWithStepReady("op-2", "plan-topics");
    paused.status = "paused";
    expect(quoteGeoNextStepForAction(paused, "resume")?.stepId).toBe("plan-topics");
    expect(quoteGeoNextStepForAction(paused, "retry")?.stepId).toBe("plan-topics");

    const replaced = operationWithStepReady("op-3", "plan-topics");
    expect(quoteGeoNextStepForAction(replaced, "next-round-keep-knowledge")?.stepId).toBe("plan-topics");

    expect(quoteGeoNextStepForAction(paused, "pause")).toBeUndefined();
    const cancelled = operationWithStepReady("op-4", "plan-topics");
    cancelled.status = "cancelled";
    expect(quoteGeoNextStepForAction(cancelled, "cancel")).toBeUndefined();
  });

  it("五类确认门后的下一步在全部意图×跨度组合下都落在 next-step 单表内（表是唯一事实源）", () => {
    const plans: ReturnType<typeof planGeoOperation>[] = [];
    const directInputs: PlanGeoOperationInput[] = [
      { intent: "full-optimization", goal: "全链" },
      { intent: "knowledge-update", goal: "知识" },
      { intent: "question-opportunities", goal: "问题" },
      { intent: "article-generation", goal: "文章" },
      { intent: "distribution-planning", goal: "分发" },
      { intent: "publishing", goal: "发布" },
      { intent: "monitoring", goal: "监测" },
      { intent: "next-round-optimization", goal: "下一轮更新知识", updateKnowledge: true },
      { intent: "next-round-optimization", goal: "下一轮不更新知识", updateKnowledge: false },
    ];
    for (const input of directInputs) plans.push(planGeoOperation(input));
    // 起止推导的跨度组合：每个合法终点都过一遍。
    const startPhaseOf: Record<string, (typeof GEO_OPERATION_PHASE_ID_ORDER)[number]> = {
      "full-optimization": "knowledge",
      "knowledge-update": "knowledge",
      "question-opportunities": "questions",
      "article-generation": "content",
      "distribution-planning": "distribution",
      publishing: "publishing",
      monitoring: "monitoring",
    };
    for (const input of directInputs) {
      if (input.intent === "next-round-optimization" && input.updateKnowledge === undefined) continue;
      const start =
        input.intent === "next-round-optimization"
          ? input.updateKnowledge
            ? "knowledge"
            : "questions"
          : startPhaseOf[input.intent]!;
      const startIndex = GEO_OPERATION_PHASE_ID_ORDER.indexOf(start);
      for (const [endIndex, endingPhase] of GEO_OPERATION_PHASE_ID_ORDER.entries()) {
        if (endIndex > startIndex) {
          plans.push(planGeoOperation({ ...input, endingPhase }));
        }
      }
    }

    const missing: string[] = [];
    for (const plan of plans) {
      plan.steps.forEach((step, index) => {
        if (!step.confirmation || !FIVE_DECISION_GATE_KINDS.includes(step.confirmation.kind)) return;
        const successor = plan.steps[index + 1];
        if (!successor) return;
        if (!GEO_NEXT_STEP_GUIDES[successor.id]) missing.push(successor.id);
      });
    }
    expect(missing).toEqual([]);
  });
});

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

  it("question-pool-confirmed also releases the next-round select-next-question-pool gate (reuse hit)", async () => {
    // 复用命中（ADR-0011 Decision 3）：next-round 不更新知识的计划里问题
    // 选择门停靠在 select-next-question-pool——run_question_pool 复用分支
    // 发出的 question-pool-confirmed 里程碑必须放行这道门并解锁后续步骤。
    const plan = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮不更新知识",
      updateKnowledge: false,
    });
    const operation = projectionOf("op-next", plan, "awaiting-confirmation", null);
    operation.steps[0]!.status = "succeeded"; // plan-ack released
    operation.steps[1]!.status = "awaiting-confirmation"; // select-next-question-pool
    const service = new FakeService();
    service.operations = [operation];

    await new GeoOperationProgressRecorder(service).record(identity, "question-pool-confirmed");

    expect(service.calls.map(([action, stepId]) => `${action}:${stepId}`)).toEqual([
      "confirm:select-next-question-pool",
    ]);
    const released = service.operations[0];
    expect(released.steps.find((step) => step.id === "select-next-question-pool")?.status)
      .toBe("succeeded");
    expect(released.steps.find((step) => step.id === "plan-topics")?.status).toBe("ready");
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

  it("article-generation-started begins the generate-articles step without completing it", async () => {
    const service = new FakeService();
    service.operations = [operationWithStepReady("op-1", "generate-articles")];

    await new GeoOperationProgressRecorder(service).record(identity, "article-generation-started");

    expect(service.calls.map(([action, stepId]) => `${action}:${stepId}`)).toEqual([
      "begin:generate-articles",
    ]);
    const step = service.operations[0].steps.find((item) => item.id === "generate-articles");
    expect(step?.status).toBe("running");
    // 确认门保持未到，不能被 started 里程碑提前停靠。
    expect(
      service.operations[0].steps.find((item) => item.id === "confirm-articles")?.status,
    ).toBe("pending");
  });

  it("articles-generated completes a running step and parks the approval gate", async () => {
    const service = new FakeService();
    const operation = operationWithStepReady("op-1", "generate-articles");
    operation.steps.find((item) => item.id === "generate-articles")!.status = "running";
    service.operations = [operation];

    await new GeoOperationProgressRecorder(service).record(identity, "articles-generated");

    expect(service.calls.map(([action, stepId]) => `${action}:${stepId}`)).toEqual([
      "complete:generate-articles",
    ]);
    expect(
      service.operations[0].steps.find((item) => item.id === "generate-articles")?.status,
    ).toBe("succeeded");
    expect(
      service.operations[0].steps.find((item) => item.id === "confirm-articles")?.status,
    ).toBe("awaiting-confirmation");
  });

  it("articles-approved only confirms the gate when generation already completed", async () => {
    const service = new FakeService();
    const operation = operationWithStepReady("op-1", "generate-articles");
    operation.steps.find((item) => item.id === "generate-articles")!.status = "succeeded";
    operation.steps.find((item) => item.id === "confirm-articles")!.status = "awaiting-confirmation";
    service.operations = [operation];

    await new GeoOperationProgressRecorder(service).record(identity, "articles-approved");

    expect(service.calls.map(([action, stepId]) => `${action}:${stepId}`)).toEqual([
      "confirm:confirm-articles",
    ]);
  });

  it("reportStepProgress updates only operations whose step is running", async () => {
    const service = new FakeService();
    const active = operationWithStepReady("op-active", "generate-articles");
    active.steps.find((item) => item.id === "generate-articles")!.status = "running";
    const idle = operationWithStepReady("op-idle", "generate-articles");
    service.operations = [active, idle];
    const activeRevisionBefore = active.revision;

    await new GeoOperationProgressRecorder(service).reportStepProgress(
      identity,
      "generate-articles",
      { current: 2, total: 5 },
    );

    expect(service.calls).toEqual([
      ["progress", "generate-articles", activeRevisionBefore],
    ]);
    expect(
      service.operations[0].steps.find((item) => item.id === "generate-articles")?.progress,
    ).toEqual({ current: 2, total: 5 });
    expect(
      service.operations[1].steps.find((item) => item.id === "generate-articles")?.progress,
    ).toBeNull();
  });
});
