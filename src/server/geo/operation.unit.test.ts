import { describe, expect, it, vi } from "vitest";

import type {
  GeoOperationProjection,
  GeoOperationStep,
} from "../../shared/geo/operation";
import {
  GeoOperationService,
  type GeoOperationPersistencePort,
} from "./operation";

function projection(
  overrides: Partial<GeoOperationProjection> = {},
): GeoOperationProjection {
  return {
    id: "operation-16",
    workspaceId: "brand-16",
    sessionId: "session-16",
    kind: "article-generation",
    goal: "生成三篇文章",
    status: "ready",
    steps: [],
    inputRefs: [],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    revision: 1,
    executionGeneration: 0,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    terminalAt: null,
    ...overrides,
  };
}

function persistence(current = projection()): GeoOperationPersistencePort & {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
  takeover: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async (request) =>
      projection({
        kind: request.kind,
        goal: request.goal,
        status: request.status,
        steps: request.steps,
        inputRefs: request.inputRefs,
        pendingConfirmation: request.pendingConfirmation,
        sourceOperationId: request.sourceOperationId ?? null,
      }),
    ),
    get: vi.fn(async () => current),
    list: vi.fn(async () => [current]),
    listUnfinished: vi.fn(async () => ({ operations: [], total: 0 })),
    takeover: vi.fn(async () => ({
      operation: projection({ ...current, revision: current.revision + 1 }),
      previousOwnerSessionId: "session-16-previous",
      takenOverAt: "2026-09-01T09:00:00Z",
      transferredArticleOperations: 1,
      transferredQuestionPools: 0,
    })),
    mutate: vi.fn(async (request) =>
      projection({
        ...current,
        revision: current.revision + 1,
        steps: request.replacementSteps ?? current.steps,
      }),
    ),
  };
}

describe("GeoOperationService", () => {
  it("persists a direct intent with only its minimal capability slice", async () => {
    const port = persistence();
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    const operation = await service.create({
      intent: "article-generation",
      goal: "生成三篇文章",
    });

    expect(operation.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "generate-articles",
      "confirm-articles",
    ]);
    expect(port.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "brand-16",
        sessionId: "session-16",
        kind: "article-generation",
      }),
    );
  });

  it("replaces only the undecided next-round plan after the user answers", async () => {
    const undecided = await new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      persistence(),
    ).create({
      intent: "next-round-optimization",
      goal: "下一轮优化",
    });
    const port = persistence(undecided);
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await service.chooseNextRoundKnowledge({
      operationId: undecided.id,
      expectedRevision: undecided.revision,
      updateKnowledge: false,
    });

    expect(port.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "replace-plan",
        operationId: undecided.id,
        replacementSteps: expect.arrayContaining([
          expect.objectContaining({ id: "select-next-question-pool" }),
        ]),
      }),
    );
    const request = port.mutate.mock.calls[0]?.[0] as {
      replacementSteps: GeoOperationStep[];
    };
    expect(
      request.replacementSteps.some((step) => step.id === "collect-materials"),
    ).toBe(false);
    // 用户显式回答分支问题即计划放行：替换计划剥离认可门，
    // 直接从首个工作步骤开始，不再二次停靠。
    expect(
      request.replacementSteps.some(
        (step) => step.confirmation?.kind === "plan-ack",
      ),
    ).toBe(false);
    expect(request.replacementSteps[0]?.id).toBe("select-next-question-pool");
  });

  it("never lets the Node/Agent seam attest paid publishing or monitor activation", async () => {
    for (const step of [
      {
        id: "confirm-publish",
        authority: "publish-scheduler" as const,
        kind: "paid-publish" as const,
      },
      {
        id: "confirm-monitoring",
        authority: "post-publish-monitor" as const,
        kind: "monitoring-activation" as const,
      },
    ]) {
      const current = projection({
        status: "awaiting-confirmation",
        steps: [
          {
            id: step.id,
            title: step.id,
            capability:
              step.id === "confirm-publish" ? "publishing" : "monitoring",
            status: "awaiting-confirmation",
            requiresConfirmation: true,
            irreversible: step.id === "confirm-publish",
            retryUnit: "operation",
            condition: null,
            confirmation: {
              kind: step.kind,
              authority: step.authority,
              title: step.id,
              summary: step.id,
            },
          },
        ],
      });
      const port = persistence(current);
      const service = new GeoOperationService(
        { workspaceId: "brand-16", sessionId: "session-16" },
        port,
      );

      await expect(
        service.recordConfirmedStep({
          operationId: current.id,
          expectedRevision: current.revision,
          stepId: step.id,
        }),
      ).rejects.toThrow(
        "geo_operation_confirmation_requires_rust_ui_authority",
      );
      expect(port.mutate).not.toHaveBeenCalled();
    }
  });

  it("persists an explicit recovering transition before resuming interrupted work", async () => {
    const port = persistence(projection({ status: "running" }));
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await service.markRecovering({
      operationId: "operation-16",
      expectedRevision: 1,
    });

    expect(port.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recover",
        operationId: "operation-16",
        expectedRevision: 1,
      }),
    );
  });

  it("persists visible queue updates against the exact execution generation", async () => {
    const port = persistence(projection({ executionGeneration: 7 }));
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await service.queueStep({
      operationId: "operation-16",
      expectedRevision: 1,
      expectedExecutionGeneration: 7,
      stepId: "generate-articles",
      queueReason: "全局重型 Provider 并发已达上限（5）",
      queuePosition: 4,
    });
    await service.updateQueue({
      operationId: "operation-16",
      expectedRevision: 2,
      expectedExecutionGeneration: 7,
      queueReason: "全局重型 Provider 并发已达上限（5）",
      queuePosition: 3,
    });

    expect(port.mutate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "queue-step",
        expectedExecutionGeneration: 7,
        queuePosition: 4,
      }),
    );
    expect(port.mutate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "update-queue",
        expectedExecutionGeneration: 7,
        queuePosition: 3,
      }),
    );
  });

  it("delegates takeover to the persistence port with revision CAS", async () => {
    const port = persistence();
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    const receipt = await service.takeover({
      operationId: "operation-16",
      expectedRevision: 3,
    });

    expect(port.takeover).toHaveBeenCalledWith({
      operationId: "operation-16",
      expectedRevision: 3,
    });
    expect(receipt.previousOwnerSessionId).toBe("session-16-previous");
    expect(receipt.operation.revision).toBe(2);
  });
});
