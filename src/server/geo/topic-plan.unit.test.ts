import { describe, expect, it, vi } from "vitest";

import {
  TOPIC_PLAN_POLICY_VERSION,
  type TopicPlanConfirmation,
  type TopicPlanItem,
  type TopicPlanMutationResult,
  type TopicPlanProjection,
} from "../../shared/geo/topicPlan";
import {
  TopicPlanService,
  type TopicPlanContext,
  type TopicPlanPersistencePort,
} from "./topic-plan";
import type {
  GeoEmbeddingCapability,
  GeoTextCapability,
} from "./provider-capabilities";

const identity = { workspaceId: "brand-10", sessionId: "session-10" };

function context(): TopicPlanContext {
  return {
    questionPoolId: "pool-08",
    questionPoolRevision: 4,
    knowledgeVersion: 7,
    productLine: "汽车音响",
    targetRegion: "成都",
    brandName: "鲸跃",
    questions: [
      { id: "q1", text: "成都汽车音响改装哪家服务更专业" },
      { id: "q2", text: "成都汽车音响改装怎么选门店" },
      { id: "q3", text: "成都汽车音响改装价格怎么规划" },
    ],
    facts: [
      {
        factKey: "industry",
        subject: "鲸跃",
        predicate: "enterprise-profile.industry",
        scopeJson: "{}",
        normalizedValueJson: '"汽车音响改装"',
      },
      {
        factKey: "full-name",
        subject: "鲸跃",
        predicate: "enterprise-profile.fullName",
        scopeJson: "{}",
        normalizedValueJson: '"成都鲸跃汽车音响有限公司"',
      },
      {
        factKey: "short-names",
        subject: "鲸跃",
        predicate: "enterprise-profile.shortNames",
        scopeJson: "{}",
        normalizedValueJson: '["鲸跃"]',
      },
      {
        factKey: "competitors",
        subject: "鲸跃",
        predicate: "enterprise-profile.competitors",
        scopeJson: "{}",
        normalizedValueJson: '["竞品甲"]',
      },
      {
        factKey: "advantages",
        subject: "鲸跃",
        predicate: "enterprise-profile.coreAdvantages",
        scopeJson: "{}",
        normalizedValueJson: '["按需求设计方案"]',
      },
    ],
  };
}

function projection(
  input: Parameters<TopicPlanPersistencePort["create"]>[0],
): TopicPlanProjection {
  return {
    id: "plan-10",
    operationId: "operation-10",
    workspaceId: identity.workspaceId,
    questionPoolId: input.questionPoolId,
    questionPoolRevision: input.questionPoolRevision,
    knowledgeVersion: input.knowledgeVersion,
    productLine: "汽车音响",
    targetRegion: "成都",
    policyVersion: TOPIC_PLAN_POLICY_VERSION,
    status: "awaiting-confirmation",
    revision: 0,
    topics: input.topics,
    items: input.items,
    selectedItemIds: [],
    modelAudit: input.modelAudit,
    providerSnapshot: input.providerSnapshot,
    modelAttempts: input.modelAttempts,
    reused: false,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  };
}

class FakePersistence implements TopicPlanPersistencePort {
  plan: TopicPlanProjection | null = null;
  readonly createInputs: Array<Parameters<TopicPlanPersistencePort["create"]>[0]> = [];
  readonly mutationInputs: Array<Parameters<TopicPlanPersistencePort["mutate"]>[0]> = [];
  readonly confirmationInputs: Array<Parameters<TopicPlanPersistencePort["confirm"]>[0]> = [];
  readonly getIds: string[] = [];

  async latest(): Promise<TopicPlanProjection | null> {
    return this.plan;
  }

  async get(planId: string): Promise<TopicPlanProjection | null> {
    this.getIds.push(planId);
    return this.plan?.id === planId ? this.plan : null;
  }

  async prepare(questionPoolId?: string) {
    if (questionPoolId && questionPoolId !== "pool-08") {
      throw new Error("topic_plan_question_pool_not_found");
    }
    return { context: context(), existing: this.plan };
  }

  async create(input: Parameters<TopicPlanPersistencePort["create"]>[0]) {
    this.createInputs.push(input);
    this.plan = projection(input);
    return this.plan;
  }

  async mutate(
    input: Parameters<TopicPlanPersistencePort["mutate"]>[0],
  ): Promise<TopicPlanMutationResult> {
    this.mutationInputs.push(input);
    if (!this.plan || this.plan.id !== input.planId) {
      throw new Error("topic_plan_not_found");
    }
    if (this.plan.status === "confirmed") {
      throw new Error("topic_plan_confirmed_immutable");
    }
    if (this.plan.revision !== input.expectedRevision) {
      throw new Error("topic_plan_revision_conflict");
    }
    this.plan = {
      ...this.plan,
      revision: this.plan.revision + 1,
      items: input.items,
      modelAttempts: [...this.plan.modelAttempts, ...input.modelAttempts],
    };
    return {
      plan: this.plan,
      mutationId: `mutation-${this.plan.revision}`,
      preservedItemIds: input.preservedItemIds,
    };
  }

  async confirm(
    input: Parameters<TopicPlanPersistencePort["confirm"]>[0],
  ): Promise<TopicPlanConfirmation> {
    this.confirmationInputs.push(input);
    if (!this.plan || this.plan.revision !== input.expectedRevision) {
      throw new Error("topic_plan_revision_conflict");
    }
    this.plan = {
      ...this.plan,
      status: "confirmed",
      revision: this.plan.revision + 1,
      selectedItemIds: input.selectedItemIds,
    };
    return {
      planId: input.planId,
      decisionId: "decision-10",
      expectedRevision: input.expectedRevision,
      revision: this.plan.revision,
      questionPoolId: this.plan.questionPoolId,
      questionPoolRevision: this.plan.questionPoolRevision,
      knowledgeVersion: this.plan.knowledgeVersion,
      selectedItemIds: input.selectedItemIds,
      actorId: "desktop-user",
      decidedAt: "2026-08-15T00:01:00.000Z",
    };
  }
}

class DeterministicEmbedding implements GeoEmbeddingCapability {
  readonly slot = "embedding" as const;
  readonly dimensions = 128;
  readonly concurrency = 2;
  private readonly indices = new Map<string, number>();

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      let index = this.indices.get(text);
      if (index === undefined) {
        index = this.indices.size;
        this.indices.set(text, index);
      }
      const vector = Array.from({ length: this.dimensions }, () => 0);
      vector[index % this.dimensions] = 1;
      return vector;
    });
  }
}

const titlesByType = {
  guide: [
    "成都汽车音响改装选店看哪些服务细节",
    "成都汽车音响改装方案应如何按需求判断",
    "成都汽车音响改装前要确认哪些服务内容",
  ],
  showcase: [
    "成都鲸跃汽车音响改装服务方案解析",
    "成都鲸跃汽车音响改装需求沟通案例",
    "成都鲸跃汽车音响改装方案设计说明",
  ],
  ranking: [
    "2026成都汽车音响改装门店选择清单",
    "2026成都汽车音响改装服务比较要点",
    "2026成都汽车音响改装方案评估清单",
  ],
  news: [
    "成都汽车音响改装服务趋势观察",
    "成都汽车音响改装需求变化分析",
    "成都汽车音响改装行业服务动态",
  ],
  news_light: [
    "成都汽车音响改装消费需求观察",
    "成都汽车音响改装用户关注点变化",
    "成都汽车音响改装方案沟通新特点",
  ],
} as const;

class DeterministicGeneration implements GeoTextCapability {
  readonly slot = "generation" as const;
  readonly calls: Array<{
    prompt: string;
    purpose?: "title-planning";
  }> = [];

  async complete(
    messages: Parameters<GeoTextCapability["complete"]>[0],
    options?: Parameters<GeoTextCapability["complete"]>[1],
  ): Promise<string> {
    const prompt = messages.at(-1)?.content ?? "";
    this.calls.push({ prompt, purpose: options?.purpose });
    if (prompt.includes("Embedding 近邻提示")) {
      return JSON.stringify([
        {
          questionIds: ["q1", "q2"],
          name: "成都汽车音响改装选型",
          summary: "覆盖本地门店选择与服务判断",
          searchIntent: "commercial-investigation",
          reason: "两个问题共享本地服务选择意图",
        },
        {
          questionIds: ["q3"],
          name: "成都汽车音响改装预算",
          summary: "解释价格构成与预算规划",
          searchIntent: "transactional",
          reason: "独立的价格规划意图",
        },
      ]);
    }
    if (prompt.includes("推荐 1–5 个内容类型")) {
      return JSON.stringify([
        {
          topicId: "topic-1",
          recommendations: [{ type: "guide", reason: "回答门店怎么选" }],
        },
        {
          topicId: "topic-2",
          recommendations: [{ type: "guide", reason: "回答预算怎么定" }],
        },
      ]);
    }
    const itemId = prompt.match(/itemId：(item-[^\n]+)/)?.[1];
    const contentType = prompt.match(
      /内容类型：(guide|showcase|ranking|news|news_light)/,
    )?.[1] as keyof typeof titlesByType | undefined;
    if (!itemId || !contentType) throw new Error("unexpected test prompt");
    const suffix = itemId.includes("topic-2") ? "乙" : "甲";
    const candidates = titlesByType[contentType].map((title) => `${title}${suffix}`);
    return JSON.stringify({
      itemId,
      candidates,
      rationale: {
        questionCoverage: "覆盖来源问题核心诉求",
        searchIntent: "匹配主题搜索意图",
        differentiation: "与已有标题采用不同表达",
        brandFit: contentType === "showcase" ? "使用已确认品牌简称" : "遵守品牌边界",
        chinaMarketExpression: "使用自然中国市场搜索表达",
      },
    });
  }
}

function service(
  persistence: FakePersistence,
  generation: GeoTextCapability = new DeterministicGeneration(),
) {
  return new TopicPlanService(
    identity,
    persistence,
    generation,
    new DeterministicEmbedding(),
    () => new Date("2026-08-15T00:00:00.000Z"),
  );
}

describe("TopicPlanService", () => {
  it("uses embeddings and LLMs for named topics, five types, factual titles and semantic dedup", async () => {
    const persistence = new FakePersistence();
    const generation = new DeterministicGeneration();
    const plan = await service(persistence, generation).generate({
      ...identity,
      questionPoolId: "pool-08",
    });

    expect(plan.topics).toHaveLength(2);
    expect(new Set(plan.items.map((item) => item.contentType))).toEqual(
      new Set(["guide", "showcase", "ranking", "news", "news_light"]),
    );
    expect(plan.items).toHaveLength(6);
    expect(plan.items.every((item) => item.typeSelectionReason.length > 0)).toBe(true);
    expect(
      plan.items.every(
        (item) =>
          item.sourceQuestionIds.length > 0 &&
          item.plannedFacts.length > 0 &&
          item.plannedFacts.every((fact) =>
            context().facts.some(
              (snapshotFact) =>
                snapshotFact.factKey === fact.factKey &&
                snapshotFact.predicate === fact.predicate &&
                snapshotFact.normalizedValueJson === fact.normalizedValueJson,
            ),
          ) &&
          item.deduplication.method === "embedding",
      ),
    ).toBe(true);
    expect(plan.modelAudit).toEqual({
      clustering: "embedding+generation-llm",
      naming: "generation-llm",
      typeRecommendation: "generation-llm",
      titleGeneration: "generation-llm",
      titleDeduplication: "embedding",
    });
    expect(plan.providerSnapshot.titlePlanning.model).toBe(
      "doubao-seed-2-0-lite-260428",
    );
    expect(plan.modelAttempts.filter((attempt) => attempt.stage === "title-generation"))
      .toHaveLength(plan.items.length);
    expect(
      generation.calls
        .filter((call) => call.prompt.includes("itemId："))
        .every((call) => call.purpose === "title-planning"),
    ).toBe(true);
  });

  it("fails explicitly on Provider/parse failure and never persists a template or mock plan", async () => {
    const persistence = new FakePersistence();
    const generation: GeoTextCapability = {
      slot: "generation",
      complete: vi.fn().mockRejectedValue(new Error("model unavailable")),
    };
    await expect(
      service(persistence, generation).generate({ ...identity }),
    ).rejects.toThrow("topic_plan_provider_unavailable:model unavailable");
    expect(persistence.createInputs).toHaveLength(0);
    expect(persistence.plan).toBeNull();
  });

  it("uses exact plan/revision CAS and preserves edited or approved targets during partial regeneration", async () => {
    const persistence = new FakePersistence();
    const generation = new DeterministicGeneration();
    const planner = service(persistence, generation);
    const initial = await planner.generate({ ...identity });
    const edited = initial.items.map((item, index): TopicPlanItem => ({
      ...item,
      userEdited: index === 0,
      approvalStatus: index === 1 ? "approved" : "draft",
    }));
    persistence.plan = { ...initial, items: edited };
    const titleCallCount = generation.calls.filter((call) => call.purpose === "title-planning").length;

    const result = await planner.regenerate({
      ...identity,
      planId: initial.id,
      expectedRevision: initial.revision,
      itemIds: [edited[0].id, edited[1].id, edited[2].id],
    });

    expect(persistence.getIds.at(-1)).toBe("plan-10");
    expect(persistence.mutationInputs.at(-1)).toMatchObject({
      planId: "plan-10",
      expectedRevision: 0,
      targetItemIds: [edited[0].id, edited[1].id, edited[2].id],
      preservedItemIds: expect.arrayContaining([edited[0].id, edited[1].id]),
    });
    expect(result.plan.items.find((item) => item.id === edited[0].id)).toEqual(edited[0]);
    expect(result.plan.items.find((item) => item.id === edited[1].id)).toEqual(edited[1]);
    expect(
      generation.calls.filter((call) => call.purpose === "title-planning").length -
        titleCallCount,
    ).toBe(1);

    await expect(
      planner.regenerate({
        ...identity,
        planId: "another-plan",
        expectedRevision: 0,
        itemIds: [edited[2].id],
      }),
    ).rejects.toThrow("topic_plan_not_found");
  });

  it("leaves the exact persisted plan untouched when local regeneration Provider parsing fails", async () => {
    const persistence = new FakePersistence();
    const initialPlanner = service(persistence);
    const initial = await initialPlanner.generate({ ...identity });
    const before = structuredClone(initial);
    const failingGeneration: GeoTextCapability = {
      slot: "generation",
      complete: vi.fn().mockResolvedValue("not-json"),
    };

    await expect(
      service(persistence, failingGeneration).regenerate({
        ...identity,
        planId: initial.id,
        expectedRevision: initial.revision,
        itemIds: [initial.items[0].id],
      }),
    ).rejects.toThrow("topic_plan_title_response_invalid");
    expect(persistence.mutationInputs).toHaveLength(0);
    expect(persistence.plan).toEqual(before);
  });

  it("marks material edits as protected, resets approval, and confirms only explicit approved IDs", async () => {
    const persistence = new FakePersistence();
    const planner = service(persistence);
    const initial = await planner.generate({ ...identity });
    persistence.plan = {
      ...initial,
      items: initial.items.map((item, index) => ({
        ...item,
        approvalStatus: index === 0 ? "approved" : "draft",
      })),
    };
    const incoming = persistence.plan.items.map((item, index) =>
      index === 0 ? { ...item, title: "用户改写标题" } : item,
    );
    const saved = await planner.saveItems({
      ...identity,
      planId: initial.id,
      expectedRevision: 0,
      items: incoming,
    });
    expect(saved.plan.items[0]).toMatchObject({
      title: "用户改写标题",
      userEdited: true,
      approvalStatus: "draft",
      deduplication: {
        method: "not-evaluated-user-override",
        maxSimilarity: null,
      },
    });

    persistence.plan = {
      ...saved.plan,
      items: saved.plan.items.map((item, index) => ({
        ...item,
        approvalStatus: index === 1 ? "approved" : item.approvalStatus,
      })),
    };
    const confirmation = await planner.confirm({
      ...identity,
      planId: initial.id,
      expectedRevision: 1,
      selectedItemIds: [persistence.plan.items[1].id],
    });
    expect(confirmation.selectedItemIds).toEqual([persistence.plan.items[1].id]);
    await expect(
      planner.saveItems({
        ...identity,
        planId: initial.id,
        expectedRevision: 2,
        items: persistence.plan.items,
      }),
    ).rejects.toThrow("topic_plan_confirmed_immutable");
  });
});
