import { describe, expect, it, vi } from "vitest";

import {
  planGeoOperation,
  type GeoOperationProjection,
  type GeoOperationStep,
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

  it("persists the explicit update-knowledge decision with the round (ticket 04)", async () => {
    const port = persistence();
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    // 显式「不更新知识」：随创建落库，起点推导读轮次不靠意图标签推断。
    await service.create({
      intent: "next-round-optimization",
      goal: "下一轮优化",
      updateKnowledge: false,
    });
    expect(port.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ updateKnowledge: false }),
    );

    // 未携带：归一为 null（未决/不适用），绝不臆断成 false。
    await service.create({
      intent: "article-generation",
      goal: "生成三篇文章",
    });
    expect(port.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ updateKnowledge: null }),
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
        // 分支答案随计划替换一并落库（票 #04）：一次 mutation 一次 revision
        // 递增，决策持久化不另开写入路径。
        updateKnowledge: false,
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

  it("skips material collection by replacing the plan and keeping completed knowledge steps (ticket 07)", async () => {
    // 停在材料收集步骤的全链轮：认可门已放行，知识链三步未完成。
    const parkedSteps = planGeoOperation({
      intent: "full-optimization",
      goal: "一轮完整的 GEO 优化",
    }).steps.map((step, index) =>
      index === 0 ? { ...step, status: "succeeded" as const } : { ...step },
    );
    const parked = projection({
      kind: "full-optimization",
      status: "ready",
      steps: parkedSteps,
      revision: 7,
    });
    const port = persistence(parked);
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await service.skipMaterialCollection({
      operationId: parked.id,
      expectedRevision: 7,
    });

    expect(port.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "replace-plan",
        operationId: parked.id,
        expectedRevision: 7,
        // 跳过出口走既有 replace-plan 动作（票 07）：Rust 守卫按该场景
        // 校验替换形状，不与知识分支决策的停卡形态混用。
        replacementReason: "material-collection-skip",
        // 跳过即本轮不更新知识：决策随替换一次落库（票 #04 同机制），
        // 跨会话摘要据实显示复用轮。
        updateKnowledge: false,
      }),
    );
    const request = port.mutate.mock.calls[0]?.[0] as {
      replacementSteps: GeoOperationStep[];
    };
    // 知识段剩余步骤剥离；已完成/已确认步骤（认可门）保留，后续段原样
    // 跟随（全链 19 步 - 知识段 3 步 = 16 步）。
    expect(
      request.replacementSteps.map((step) => step.id),
    ).toEqual(parked.steps.filter((step) => step.id !== "collect-materials"
      && step.id !== "extract-facts"
      && step.id !== "confirm-knowledge").map((step) => step.id));
    expect(request.replacementSteps[0]?.id).toBe("acknowledge-plan");
    expect(
      request.replacementSteps[0]?.confirmation?.kind,
    ).toBe("plan-ack");
    expect(request.replacementSteps[1]?.id).toBe("generate-question-pool");
  });

  it("keeps already-succeeded knowledge steps when skipping from the knowledge gate", async () => {
    // 材料已导入（collect-materials/extract-facts 完成），停在知识确认门。
    const parked = projection({
      kind: "full-optimization",
      status: "awaiting-confirmation",
      revision: 9,
      steps: [
        {
          id: "acknowledge-plan",
          title: "认可本轮计划",
          capability: "brand-knowledge",
          status: "succeeded",
          requiresConfirmation: true,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: {
            kind: "plan-ack",
            authority: "geo-operation",
            title: "认可本轮计划",
            summary: "放行",
          },
        },
        {
          id: "collect-materials",
          title: "收集品牌材料",
          capability: "brand-material-import",
          status: "succeeded",
          requiresConfirmation: false,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: null,
        },
        {
          id: "extract-facts",
          title: "提取候选事实",
          capability: "brand-knowledge",
          status: "succeeded",
          requiresConfirmation: false,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: null,
        },
        {
          id: "confirm-knowledge",
          title: "确认知识变更",
          capability: "brand-knowledge",
          status: "awaiting-confirmation",
          requiresConfirmation: true,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: {
            kind: "knowledge-change",
            authority: "knowledge-authority",
            title: "确认知识变更",
            summary: "逐项裁决",
          },
        },
        {
          id: "generate-question-pool",
          title: "生成问题机会",
          capability: "question-opportunities",
          status: "pending",
          requiresConfirmation: false,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: null,
        },
      ],
    });
    const port = persistence(parked);
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await service.skipMaterialCollection({
      operationId: parked.id,
      expectedRevision: 9,
    });
    const request = port.mutate.mock.calls[0]?.[0] as {
      replacementSteps: GeoOperationStep[];
    };
    // 已完成的知识步保留，未裁决的知识门剥离，后续段原样。
    expect(
      request.replacementSteps.map((step) => step.id),
    ).toEqual([
      "acknowledge-plan",
      "collect-materials",
      "extract-facts",
      "generate-question-pool",
    ]);
  });

  it("rejects the skip when the current step is already past the knowledge segment", async () => {
    const steps = planGeoOperation({
      intent: "full-optimization",
      goal: "一轮完整的 GEO 优化",
    }).steps.map((step, index, all) => {
      const lastKnowledgeIndex = all.findIndex(
        (candidate) => candidate.id === "confirm-knowledge",
      );
      return index <= lastKnowledgeIndex
        ? { ...step, status: "succeeded" as const }
        : { ...step };
    });
    const pastKnowledge = projection({
      kind: "full-optimization",
      status: "ready",
      steps,
      revision: 5,
    });
    const port = persistence(pastKnowledge);
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await expect(
      service.skipMaterialCollection({
        operationId: pastKnowledge.id,
        expectedRevision: 5,
      }),
    ).rejects.toThrow("geo_operation_material_skip_invalid");
    expect(port.mutate).not.toHaveBeenCalled();
  });

  it("rejects the skip on terminal operations", async () => {
    const cancelled = projection({
      kind: "full-optimization",
      status: "cancelled",
      revision: 4,
      steps: [
        {
          id: "collect-materials",
          title: "收集品牌材料",
          capability: "brand-material-import",
          status: "ready",
          requiresConfirmation: false,
          irreversible: false,
          retryUnit: "operation",
          condition: null,
          confirmation: null,
        },
      ],
    });
    const port = persistence(cancelled);
    const service = new GeoOperationService(
      { workspaceId: "brand-16", sessionId: "session-16" },
      port,
    );

    await expect(
      service.skipMaterialCollection({
        operationId: cancelled.id,
        expectedRevision: 4,
      }),
    ).rejects.toThrow("geo_operation_material_skip_invalid");
    expect(port.mutate).not.toHaveBeenCalled();
  });

  it("never lets the Node/Agent seam attest paid publishing or monitor activation", async () => {    for (const step of [
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
