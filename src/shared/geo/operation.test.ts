import { describe, expect, it } from "vitest";

import {
  classifyGeoIntent,
  geoOperationPhaseStatus,
  groupGeoOperationSteps,
  planGeoOperation,
} from "./operation";

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
        intent: updateKnowledge === undefined ? "full-optimization" : "next-round-optimization",
        goal: "完整 GEO 优化",
        ...(updateKnowledge === undefined ? {} : { updateKnowledge }),
      });

      expect(plan.steps).toHaveLength(19);
      expect(plan.steps.some((step) => step.capability === "geo-observation")).toBe(
        false,
      );
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
      withoutKnowledge.steps.some((step) => step.capability === "geo-observation"),
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
    expect(withReason.steps.map((step) => [step.id, step.confirmation?.kind])).toEqual(
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
