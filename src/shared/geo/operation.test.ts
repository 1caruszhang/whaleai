import { describe, expect, it } from "vitest";

import geoOperationContract from "./geoOperationContract.json";
import {
  GEO_OPERATION_CAPABILITIES,
  GEO_OPERATION_CONFIRMATION_AUTHORITIES,
  GEO_OPERATION_CONFIRMATION_KINDS,
  GEO_OPERATION_KINDS,
  GEO_OPERATION_REFERENCE_KINDS,
  GEO_OPERATION_RETRY_UNITS,
  GEO_OPERATION_STATUSES,
  GEO_OPERATION_STEP_STATUSES,
  KNOWLEDGE_SEGMENT_STEP_IDS,
  RUST_UI_CONFIRMATION_AUTHORITIES,
  TERMINAL_GEO_OPERATION_STATUSES,
  classifyGeoIntent,
  formatGeoOperationSpanLabel,
  geoOperationPhaseStatus,
  groupGeoOperationSteps,
  planGeoOperation,
} from "./operation";

describe("geo operation contract pin（ADR-0012 三方裁判）", () => {
  it("十一键与 geoOperationContract.json 严格相等（含顺序）", () => {
    expect(geoOperationContract.operationKinds).toEqual([
      ...GEO_OPERATION_KINDS,
    ]);
    expect(geoOperationContract.operationStatuses).toEqual([
      ...GEO_OPERATION_STATUSES,
    ]);
    expect(geoOperationContract.terminalStatuses).toEqual([
      ...TERMINAL_GEO_OPERATION_STATUSES,
    ]);
    expect(geoOperationContract.stepStatuses).toEqual([
      ...GEO_OPERATION_STEP_STATUSES,
    ]);
    expect(geoOperationContract.capabilities).toEqual([
      ...GEO_OPERATION_CAPABILITIES,
    ]);
    expect(geoOperationContract.referenceKinds).toEqual([
      ...GEO_OPERATION_REFERENCE_KINDS,
    ]);
    expect(geoOperationContract.retryUnits).toEqual([
      ...GEO_OPERATION_RETRY_UNITS,
    ]);
    expect(geoOperationContract.confirmationKinds).toEqual([
      ...GEO_OPERATION_CONFIRMATION_KINDS,
    ]);
    expect(geoOperationContract.confirmationAuthorities).toEqual([
      ...GEO_OPERATION_CONFIRMATION_AUTHORITIES,
    ]);
    expect(geoOperationContract.rustUiConfirmationAuthorities).toEqual([
      ...RUST_UI_CONFIRMATION_AUTHORITIES,
    ]);
    expect(geoOperationContract.knowledgeSegmentStepIds.values).toEqual([
      ...KNOWLEDGE_SEGMENT_STEP_IDS,
    ]);
  });
});

describe("GeoOperation intent policy", () => {
  it.each([
    ["更新知识库", "knowledge-update"],
    ["生成三篇文章", "article-generation"],
    ["检查当前 GEO 表现", "performance-inspection"],
    ["制定分发计划", "distribution-planning"],
    ["完整 GEO 优化", "full-optimization"],
    ["开始下一轮优化", "next-round-optimization"],
    ["帮我做geo优化", "full-optimization"],
    ["提升一下 AI 搜索里的曝光", "full-optimization"],
  ] as const)("routes %s to the matching operation kind", (text, expected) => {
    expect(classifyGeoIntent(text)).toBe(expected);
  });

  it("keeps non-GEO requests out of the operation policy", () => {
    expect(classifyGeoIntent("优化一下这段代码的性能")).toBeNull();
    expect(classifyGeoIntent("今天天气怎么样")).toBeNull();
  });

  it("does not smuggle unrelated stages into direct article generation", () => {
    const plan = planGeoOperation({
      intent: "article-generation",
      goal: "生成三篇文章",
    });

    expect(plan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "generate-articles",
      "confirm-articles",
    ]);
    expect(plan.steps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "generate-question-pool" }),
        expect.objectContaining({ id: "probe-missing-evidence" }),
        expect.objectContaining({ id: "plan-distribution" }),
        expect.objectContaining({ id: "submit-publish" }),
      ]),
    );
  });

  it("parks every decided plan at the plan acknowledgement gate before any stage", () => {
    for (const intent of [
      "knowledge-update",
      "question-opportunities",
      "article-generation",
      "performance-inspection",
      "distribution-planning",
      "publishing",
      "monitoring",
      "full-optimization",
    ] as const) {
      const plan = planGeoOperation({ intent, goal: "一轮完整的 GEO 优化" });
      expect(plan.steps[0]).toMatchObject({
        id: "acknowledge-plan",
        status: "awaiting-confirmation",
        requiresConfirmation: true,
      });
      expect(plan.status).toBe("awaiting-confirmation");
      expect(plan.pendingConfirmation).toMatchObject({
        kind: "plan-ack",
        authority: "geo-operation",
      });
    }

    // 下一轮的「是否更新知识」分支决策不是计划放行门；决定后的计划
    // 同样从认可门开始。
    const decided = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮优化",
      updateKnowledge: true,
    });
    expect(decided.steps[0]?.id).toBe("acknowledge-plan");
    expect(decided.steps[1]?.id).toBe("collect-materials");
  });

  it("adds channel planning to publishing only when no confirmed plan is referenced", () => {
    const fromArticles = planGeoOperation({
      intent: "publishing",
      goal: "发布这些文章",
      inputRefs: [{ kind: "article", id: "approved-article-16", revision: 3 }],
    });
    expect(fromArticles.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "plan-distribution",
      "confirm-distribution",
      "prepare-publish",
      "confirm-publish",
      "observe-publish",
    ]);

    const fromConfirmedPlan = planGeoOperation({
      intent: "publishing",
      goal: "发布已确认分发计划",
      inputRefs: [
        { kind: "distribution-plan", id: "distribution-plan-16", revision: 2 },
      ],
    });
    expect(fromConfirmedPlan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "prepare-publish",
      "confirm-publish",
      "observe-publish",
    ]);
  });

  it("composes the existing capability steps for an explicit full optimization", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const ids = plan.steps.map((step) => step.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "collect-materials",
        "generate-question-pool",
        "generate-articles",
        "plan-distribution",
        "confirm-publish",
        "collect-monitoring-evidence",
      ]),
    );
    expect(
      plan.steps.find((step) => step.id === "confirm-publish"),
    ).toMatchObject({
      requiresConfirmation: true,
      irreversible: true,
      confirmation: {
        kind: "paid-publish",
        authority: "publish-scheduler",
      },
    });
  });

  it("keeps baseline probing out of the composed main chain (19 steps)", () => {
    for (const updateKnowledge of [undefined, true]) {
      const plan = planGeoOperation({
        intent:
          updateKnowledge === undefined
            ? "full-optimization"
            : "next-round-optimization",
        goal: "完整 GEO 优化",
        ...(updateKnowledge === undefined ? {} : { updateKnowledge }),
      });

      expect(plan.steps).toHaveLength(19);
      expect(
        plan.steps.some((step) => step.capability === "geo-observation"),
      ).toBe(false);
      expect(
        plan.steps.filter((step) => step.requiresConfirmation).length,
      ).toBe(8);
    }

    const withoutKnowledge = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮优化",
      updateKnowledge: false,
    });
    expect(withoutKnowledge.steps).toHaveLength(15);
    expect(
      withoutKnowledge.steps.some(
        (step) => step.capability === "geo-observation",
      ),
    ).toBe(false);
  });

  it("places every judgment, provider-cost, and external side-effect behind an explicit authority", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const gates = plan.steps.filter((step) => step.requiresConfirmation);

    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((step) => step.confirmation !== null)).toBe(true);
    expect(gates.map((step) => step.confirmation?.kind)).toEqual(
      expect.arrayContaining([
        "plan-ack",
        "knowledge-change",
        "question-selection",
        "topic-plan",
        "article-approval",
        "distribution-plan",
        "paid-publish",
        "monitoring-activation",
      ]),
    );
    // Baseline probing left the main chain: its provider-cost gate exists only
    // in the on-demand performance-inspection intent.
    expect(gates.map((step) => step.confirmation?.kind)).not.toContain(
      "baseline-probe",
    );
    expect(plan.steps.some((step) => step.id === "submit-publish")).toBe(false);
  });

  it("parks a next round until knowledge refresh is explicitly decided", () => {
    const undecided = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮优化",
    });
    expect(undecided.status).toBe("awaiting-confirmation");
    expect(undecided.steps.map((step) => step.id)).toEqual([
      "decide-knowledge-refresh",
    ]);
    expect(undecided.pendingConfirmation?.summary).toContain(
      "效果报告只作上下文",
    );
    expect(undecided.pendingConfirmation).toMatchObject({
      kind: "next-round-knowledge",
      authority: "brand-workspace",
    });

    const withoutKnowledge = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮优化",
      updateKnowledge: false,
    });
    expect(withoutKnowledge.steps[1]?.id).toBe("select-next-question-pool");
    expect(
      withoutKnowledge.steps.some((step) => step.id === "collect-materials"),
    ).toBe(false);

    const withKnowledge = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮优化",
      updateKnowledge: true,
    });
    expect(withKnowledge.steps[1]?.id).toBe("collect-materials");
  });

  // 归一（票 02，spec 2026-09-02）：全链意图显式携带「不更新知识」时，
  // 计划形状与「下一轮优化 + 不更新知识」完全同形——首工作步从问题池选择，
  // 不重走知识链。两个入口消费同一份步骤构造，快照锁形防意图与计划漂移。
  it("gives full-optimization + updateKnowledge=false the exact next-round no-update step shape", () => {
    const full = planGeoOperation({
      intent: "full-optimization",
      goal: "全链意图：这一轮不更新品牌知识",
      updateKnowledge: false,
    });
    const nextRound = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮优化",
      updateKnowledge: false,
    });

    // 形状锁定不是整对象逐字节：意图与 goal 字段必然不同。
    expect(full.kind).toBe("full-optimization");
    expect(nextRound.kind).toBe("next-round-optimization");
    expect(full.goal).not.toBe(nextRound.goal);

    // 步骤序列的 id/标题/能力/确认门/初始状态（含认可门文案）逐项相等。
    expect(full.steps).toEqual(nextRound.steps);
    expect(full.status).toBe(nextRound.status);
    expect(full.pendingConfirmation).toEqual(nextRound.pendingConfirmation);

    // 首工作步为「从问题池选择」；知识链步骤不进计划。
    expect(full.steps[1]).toMatchObject({
      id: "select-next-question-pool",
      title: "从问题池选择下一轮问题",
      capability: "question-opportunities",
      status: "pending",
      requiresConfirmation: true,
      confirmation: {
        kind: "question-selection",
        authority: "brand-workspace",
      },
    });
    for (const knowledgeStep of [
      "collect-materials",
      "extract-facts",
      "confirm-knowledge",
    ]) {
      expect(full.steps.some((step) => step.id === knowledgeStep)).toBe(false);
    }
    // 计划照常停靠认可门（借用首工作步 capability，落问题机会段）。
    expect(full.steps[0]).toMatchObject({
      id: "acknowledge-plan",
      status: "awaiting-confirmation",
      capability: "question-opportunities",
    });
    // 进度卡跨度与阶段分组从归一后的起点自然派生，不另设文案。
    expect(formatGeoOperationSpanLabel(full.steps)).toBe(
      "跨度：问题机会 → 监测",
    );
    expect(groupGeoOperationSteps(full.steps).map((group) => group.id)).toEqual(
      ["questions", "content", "distribution", "publishing", "monitoring"],
    );
  });

  it("keeps the two entrances shape-identical with an endingPhase too", () => {
    const full = planGeoOperation({
      intent: "full-optimization",
      goal: "这轮不更新知识，做到分发为止",
      updateKnowledge: false,
      endingPhase: "distribution",
    });
    const nextRound = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮做到分发为止",
      updateKnowledge: false,
      endingPhase: "distribution",
    });

    expect(full.steps).toEqual(nextRound.steps);
    expect(full.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "select-next-question-pool",
      "plan-topics",
      "confirm-content-plan",
      "generate-articles",
      "confirm-articles",
      "plan-distribution",
      "confirm-distribution",
    ]);
  });

  // 防回归：未携带该参数（或显式为真）的全链计划与现状逐项一致——
  // 既有调用方零破坏。
  it("keeps the plain full-optimization plan item-by-item unchanged when updateKnowledge is omitted or true", () => {
    const currentFullChainIds = [
      "acknowledge-plan",
      "collect-materials",
      "extract-facts",
      "confirm-knowledge",
      "generate-question-pool",
      "confirm-question-selection",
      "plan-topics",
      "confirm-content-plan",
      "generate-articles",
      "confirm-articles",
      "plan-distribution",
      "confirm-distribution",
      "prepare-publish",
      "confirm-publish",
      "observe-publish",
      "configure-monitoring",
      "confirm-monitoring",
      "collect-monitoring-evidence",
      "report-monitoring",
    ];
    for (const updateKnowledge of [undefined, true]) {
      const plan = planGeoOperation({
        intent: "full-optimization",
        goal: "完整 GEO 优化",
        ...(updateKnowledge === undefined ? {} : { updateKnowledge }),
      });
      expect(plan.steps.map((step) => step.id)).toEqual(currentFullChainIds);
      expect(
        plan.steps.filter((step) => step.requiresConfirmation),
      ).toHaveLength(8);
      expect(formatGeoOperationSpanLabel(plan.steps)).toBe(
        "跨度：品牌知识 → 监测",
      );
    }
  });

  it("still rejects ending phases not strictly downstream of the normalized start", () => {
    // 归一后起点段是 questions：终点等于起点（questions）或在其上游
    // （knowledge）照旧 fail-loud——那不是跨度，是矛盾的输入。
    for (const endingPhase of ["knowledge", "questions"] as const) {
      expect(() =>
        planGeoOperation({
          intent: "full-optimization",
          goal: "这轮不更新知识",
          updateKnowledge: false,
          endingPhase,
        }),
      ).toThrow("geo_operation_ending_phase_invalid");
    }
  });

  it("makes missing performance probes conditional instead of treating reports as an execution owner", () => {
    const plan = planGeoOperation({
      intent: "performance-inspection",
      goal: "检查当前 GEO 表现",
    });

    expect(plan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "load-real-evidence",
      "confirm-missing-evidence-probe",
      "probe-missing-evidence",
      "report-performance",
    ]);
    expect(plan.steps[2]).toMatchObject({
      condition: "if-evidence-insufficient",
      requiresConfirmation: true,
    });
    expect(plan.steps[3]).toMatchObject({
      condition: "if-evidence-insufficient",
      retryUnit: "probe",
    });
  });

  it("never uses a dashboard report as next-round authority", () => {
    for (const updateKnowledge of [true, false]) {
      const plan = planGeoOperation({
        intent: "next-round-optimization",
        goal: "根据当前情况继续",
        updateKnowledge,
        inputRefs: [{ kind: "report", id: "report-15" }],
      });
      expect(plan.inputRefs).toContainEqual({
        kind: "report",
        id: "report-15",
      });
      expect(plan.steps[0]?.capability).not.toBe("geo-dashboard");
    }
  });

  // 票 #27（ADR-0010 Decision 5）：起点推导理由只进入计划认可门的
  // summary（用户在计划门上确认的是「从哪开始」），步骤序列与确认门
  // 位置零改动。
  it("carries the starting-point derivation reason on the plan-ack gate without touching the step sequence", () => {
    const reason = "知识 3 天前刚确认，直接从问题机会继续";
    const withReason = planGeoOperation({
      intent: "full-optimization",
      goal: "一轮完整的 GEO 优化",
      startingPointReason: reason,
    });
    const withoutReason = planGeoOperation({
      intent: "full-optimization",
      goal: "一轮完整的 GEO 优化",
    });

    // 18+1 步序列与确认门位置不变：id 与 confirmation kind 全等。
    expect(
      withReason.steps.map((step) => [step.id, step.confirmation?.kind]),
    ).toEqual(
      withoutReason.steps.map((step) => [step.id, step.confirmation?.kind]),
    );
    expect(withReason.steps).toHaveLength(19);

    // 推导理由出现在认可门 summary 与操作级 pendingConfirmation。
    expect(withReason.steps[0]?.confirmation).toMatchObject({
      kind: "plan-ack",
      authority: "geo-operation",
    });
    expect(withReason.steps[0]?.confirmation?.summary).toContain("从哪里开始");
    expect(withReason.steps[0]?.confirmation?.summary).toContain(reason);
    expect(withReason.pendingConfirmation?.summary).toContain(reason);

    // 未提供理由时认可门文案与现状完全一致（默认路径零漂移）。
    expect(withoutReason.steps[0]?.confirmation?.summary).toBe(
      "查看上方阶段与步骤计划后放行；各阶段的产物仍会停在各自的确认门。",
    );
  });

  it("ignores blank derivation reasons and rejects oversized ones", () => {
    expect(
      planGeoOperation({
        intent: "article-generation",
        goal: "生成三篇文章",
        startingPointReason: "   ",
      }).steps[0]?.confirmation?.summary,
    ).not.toContain("从哪里开始");

    expect(() =>
      planGeoOperation({
        intent: "article-generation",
        goal: "生成三篇文章",
        startingPointReason: "长".repeat(301),
      }),
    ).toThrow("geo_operation_starting_point_reason_invalid");
  });

  // 起止推导（endingPhase）：一张计划卡覆盖起点到终点的完整跨度，
  // 轮内不再为同一链条新起操作。产物确认门位置不变。
  it("extends a direct intent through downstream phases with endingPhase", () => {
    const plan = planGeoOperation({
      intent: "article-generation",
      goal: "从文章一路做到发布",
      endingPhase: "publishing",
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      // 起点段仍是文章直达（计划已确认，不回补规划步骤）……
      "generate-articles",
      "confirm-articles",
      // ……下游各段按链序追加，含各自的产物确认门。
      "plan-distribution",
      "confirm-distribution",
      "prepare-publish",
      "confirm-publish",
      "observe-publish",
    ]);
    // 认可门仍是第一步，操作仍在计划门停靠。
    expect(plan.steps[0]?.confirmation?.kind).toBe("plan-ack");
    expect(plan.status).toBe("awaiting-confirmation");
  });

  it("truncates the full chain when full-optimization carries an endingPhase", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "这轮只做到文章为止",
      endingPhase: "content",
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "collect-materials",
      "extract-facts",
      "confirm-knowledge",
      "generate-question-pool",
      "confirm-question-selection",
      "plan-topics",
      "confirm-content-plan",
      "generate-articles",
      "confirm-articles",
    ]);
  });

  it("composes the no-update next round from the selection step up to the endingPhase", () => {
    const plan = planGeoOperation({
      intent: "next-round-optimization",
      goal: "下一轮做到分发为止",
      updateKnowledge: false,
      endingPhase: "distribution",
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "select-next-question-pool",
      "plan-topics",
      "confirm-content-plan",
      "generate-articles",
      "confirm-articles",
      "plan-distribution",
      "confirm-distribution",
    ]);
  });

  it("rejects an endingPhase upstream of the intent start, off-chain intents, and orphan reasons", () => {
    expect(() =>
      planGeoOperation({
        intent: "distribution-planning",
        goal: "分发",
        endingPhase: "content",
      }),
    ).toThrow("geo_operation_ending_phase_invalid");

    // 终点＝起点不是跨度：单阶段轮次省略 endingPhase（无计划发布意图把
    // 起点推导到分发段时，endingPhase=distribution 会静默丢掉发布段）。
    expect(() =>
      planGeoOperation({
        intent: "distribution-planning",
        goal: "只做分发",
        endingPhase: "distribution",
      }),
    ).toThrow("geo_operation_ending_phase_invalid");

    expect(() =>
      planGeoOperation({
        intent: "performance-inspection",
        goal: "巡检",
        endingPhase: "monitoring",
      }),
    ).toThrow("geo_operation_ending_phase_invalid");

    // 分支未决的下一轮没有可裁量的跨度。
    expect(() =>
      planGeoOperation({
        intent: "next-round-optimization",
        goal: "下一轮",
        endingPhase: "content",
      }),
    ).toThrow("geo_operation_ending_phase_invalid");

    // 终点理由没有终点阶段可挂。
    expect(() =>
      planGeoOperation({
        intent: "article-generation",
        goal: "生成三篇文章",
        endingPointReason: "用户选择先发文",
      }),
    ).toThrow("geo_operation_ending_point_reason_invalid");

    expect(() =>
      planGeoOperation({
        intent: "article-generation",
        goal: "生成三篇文章",
        // 终点取严格下游（distribution），隔离考察理由长度规则本身；
        // 等于起点的终点已在上文按 phase 无效拒绝。
        endingPhase: "distribution",
        endingPointReason: "长".repeat(301),
      }),
    ).toThrow("geo_operation_ending_point_reason_invalid");
  });

  it("does not duplicate the publish segment when publishing without a confirmed plan carries an endingPhase", () => {
    // 无计划发布意图的自然跨度含分发+发布两段；带终点时起点覆盖只留
    // 分发段，发布段由链序追加——终点落在发布上时发布步骤只出现一次。
    const plan = planGeoOperation({
      intent: "publishing",
      goal: "补齐分发计划后发布",
      endingPhase: "publishing",
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      "acknowledge-plan",
      "plan-distribution",
      "confirm-distribution",
      "prepare-publish",
      "confirm-publish",
      "observe-publish",
    ]);
  });

  it("carries the ending statement on the plan-ack gate and keeps gate positions untouched", () => {
    const plan = planGeoOperation({
      intent: "article-generation",
      goal: "从文章一路做到发布",
      startingPointReason: "知识、问题池与内容计划均已确认",
      endingPhase: "publishing",
      endingPointReason: "用户选择先发文验证效果",
    });
    const gate = plan.steps[0]?.confirmation;
    expect(gate?.summary).toContain(
      "从哪里开始：知识、问题池与内容计划均已确认。",
    );
    expect(gate?.summary).toContain(
      "到哪里结束：发布——用户选择先发文验证效果。",
    );
    expect(plan.pendingConfirmation?.summary).toContain("到哪里结束");

    // 不带终点时认可门文案零漂移（默认路径不受影响）。
    const plain = planGeoOperation({
      intent: "article-generation",
      goal: "生成三篇文章",
    });
    expect(plain.steps[0]?.confirmation?.summary).toBe(
      "查看上方阶段与步骤计划后放行；各阶段的产物仍会停在各自的确认门。",
    );
  });
});

describe("GeoOperation phase grouping", () => {
  it("splits the full-optimization 19 steps into the six spoken stages", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const groups = groupGeoOperationSteps(plan.steps);

    expect(groups.map((group) => group.id)).toEqual([
      "knowledge",
      "questions",
      "content",
      "distribution",
      "publishing",
      "monitoring",
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      "品牌知识",
      "问题机会",
      "内容生产",
      "渠道计划",
      "发布",
      "监测",
    ]);
    // 认可门借用首个工作步骤的 capability，落进开头阶段而不是「其他」。
    expect(groups.map((group) => group.steps.length)).toEqual([
      4, 2, 4, 2, 3, 4,
    ]);
    expect(groups[0].steps[0]).toMatchObject({
      id: "acknowledge-plan",
      status: "awaiting-confirmation",
    });
    // 阶段分组覆盖全部步骤：19 步都必须落在某个阶段里。
    expect(groups.flatMap((group) => group.steps)).toHaveLength(19);
  });

  it("keeps unmatched steps visible in a trailing group instead of dropping them", () => {
    const plan = planGeoOperation({
      intent: "knowledge-update",
      goal: "更新品牌知识",
    });
    const torn = [
      plan.steps[0],
      {
        ...plan.steps[0],
        id: "orphan",
        title: "残缺投影步骤",
        capability: "legacy-capability",
      },
    ] as unknown as typeof plan.steps;
    const groups = groupGeoOperationSteps(torn);

    expect(groups.map((group) => group.id)).toEqual(["knowledge", "other"]);
    expect(groups[1]?.steps.map((step) => step.id)).toEqual(["orphan"]);
  });

  it("derives the phase status from its steps", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const knowledge = groupGeoOperationSteps(plan.steps)[0].steps;

    expect(geoOperationPhaseStatus([])).toBe("pending");
    expect(
      geoOperationPhaseStatus(
        knowledge.map((step) => ({ ...step, status: "succeeded" })),
      ),
    ).toBe("succeeded");
    expect(
      geoOperationPhaseStatus(
        knowledge.map((step, index) => ({
          ...step,
          status: index === 0 ? "succeeded" : "pending",
        })),
      ),
    ).toBe("pending");
    expect(
      geoOperationPhaseStatus(
        knowledge.map((step, index) => ({
          ...step,
          status: index === 1 ? "failed" : "succeeded",
        })),
      ),
    ).toBe("failed");
    expect(
      geoOperationPhaseStatus(
        knowledge.map((step, index) => ({
          ...step,
          status: index === 2 ? "awaiting-confirmation" : "succeeded",
        })),
      ),
    ).toBe("awaiting-confirmation");
  });
});

describe("GeoOperation span label", () => {
  it("derives the natural span from the first and last work steps", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    // 认可门借用首步 capability（品牌知识段起步），自然跨度末段是监测。
    expect(formatGeoOperationSpanLabel(plan.steps)).toBe(
      "跨度：品牌知识 → 监测",
    );
  });

  it("ends the label at the endingPhase segment when provided", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "做到文章为止",
      endingPhase: "publishing",
    });
    expect(formatGeoOperationSpanLabel(plan.steps)).toBe(
      "跨度：品牌知识 → 发布",
    );
  });

  it("reports a single stage name when start and end share the phase", () => {
    const knowledge = planGeoOperation({
      intent: "knowledge-update",
      goal: "更新品牌知识",
    });
    expect(formatGeoOperationSpanLabel(knowledge.steps)).toBe("跨度：品牌知识");

    const questions = planGeoOperation({
      intent: "question-opportunities",
      goal: "生成问题机会",
    });
    expect(formatGeoOperationSpanLabel(questions.steps)).toBe("跨度：问题机会");
  });

  it("returns null when an endpoint capability maps to no stage", () => {
    // 残缺投影防御：端点 capability 不落六阶段链时不猜测跨度（效果巡检
    // 等链外意图的 geo-observation 即此类；其 geo-dashboard 端点仍归监测段）。
    const torn = [
      {
        ...planGeoOperation({ intent: "knowledge-update", goal: "更新知识" })
          .steps[0],
        capability: "geo-observation" as never,
      },
    ];
    expect(formatGeoOperationSpanLabel(torn)).toBeNull();
    expect(formatGeoOperationSpanLabel([])).toBeNull();
  });
});
