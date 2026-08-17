import { describe, expect, it, vi } from "vitest";

import type {
  QuestionPoolDecision,
  QuestionPoolProjection,
  QuestionPoolStage,
} from "../../shared/geo/questionPool";
import {
  QuestionPoolService,
  type QuestionPoolPersistencePort,
} from "./question-pool";
import type {
  GeoEmbeddingCapability,
  GeoKeywordSearchCapability,
  GeoTextCapability,
} from "./provider-capabilities";

function basePool(
  overrides: Partial<QuestionPoolProjection> = {},
): QuestionPoolProjection {
  return {
    id: "pool-08",
    attemptId: "attempt-08",
    operationId: "operation-08",
    workspaceId: "brand-08",
    knowledgeVersion: 7,
    productLine: "汽车音响",
    targetRegion: "成都",
    generationParameters: {
      policyVersion: "js-ai-dev-pred-1-v1",
      candidateLimit: 20,
      recentSelectionLimit: 20,
      priorityThresholds: { highAtSum: 150, mediumAtSum: 100 },
    },
    status: "generating",
    revision: 0,
    keywords: [],
    questions: [],
    sourceEvidence: [],
    checkpoints: [],
    reused: false,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    ...overrides,
  };
}

class FakePersistence implements QuestionPoolPersistencePort {
  readonly outputs = new Map<QuestionPoolStage, unknown>();
  readonly status = new Map<QuestionPoolStage, string>();
  readonly attemptNumbers = new Map<QuestionPoolStage, number>();
  readonly claims: QuestionPoolStage[] = [];
  readonly decisions: Array<
    Parameters<QuestionPoolPersistencePort["decide"]>[0]
  > = [];
  readonly revisions: Array<
    Parameters<QuestionPoolPersistencePort["revise"]>[0]
  > = [];
  readonly latestCalls: Array<{ productLine?: string; pendingOnly?: boolean }> =
    [];
  persistCalls = 0;
  cancelCalls = 0;
  reuse: QuestionPoolProjection | null = null;

  async latest(
    productLine?: string,
    pendingOnly?: boolean,
  ): Promise<QuestionPoolProjection | null> {
    this.latestCalls.push({ productLine, pendingOnly });
    return this.reuse;
  }

  async prepare(input: Parameters<QuestionPoolPersistencePort["prepare"]>[0]) {
    if (this.reuse) {
      return {
        kind: "reused" as const,
        context: this.context(),
        attempt: null,
        pool: this.reuse,
      };
    }
    return {
      kind: "attempt" as const,
      context: this.context(),
      attempt: {
        id: "attempt-08",
        poolId: "pool-08",
        state: input.retry ? "failed" : "running",
        idempotencyKey: input.idempotencyKey,
      },
      pool: basePool({ generationParameters: input.generationParameters }),
    };
  }

  private context() {
    return {
      knowledgeVersion: 7,
      brandName: "鲸跃",
      productLines: ["汽车音响"],
      facts: [
        {
          factKey: "industry",
          subject: "鲸跃",
          predicate: "enterprise-profile.industry",
          scopeJson: '{"entityScope":"brand"}',
          normalizedValueJson: '"汽车改装"',
          sources: [{ materialId: "material-07" }],
        },
        {
          factKey: "shortNames",
          subject: "鲸跃",
          predicate: "enterprise-profile.shortNames",
          scopeJson: '{"entityScope":"brand"}',
          normalizedValueJson: '["鲸跃汽车"]',
          sources: [],
        },
      ],
      recentSelectedQuestions: ["上一轮问题"],
    };
  }

  async claim(input: Parameters<QuestionPoolPersistencePort["claim"]>[0]) {
    this.claims.push(input.stage);
    if (this.status.get(input.stage) === "completed") {
      return {
        action: "cached" as const,
        output: this.outputs.get(input.stage),
        attemptNumber: this.attemptNumbers.get(input.stage) ?? 1,
        billingKey: `attempt-08:${input.stage}`,
      };
    }
    const next = (this.attemptNumbers.get(input.stage) ?? 0) + 1;
    this.attemptNumbers.set(input.stage, next);
    this.status.set(input.stage, "running");
    return {
      action: "execute" as const,
      claimToken: `claim:${input.stage}:${next}`,
      attemptNumber: next,
      billingKey: `attempt-08:${input.stage}`,
    };
  }

  async finish(input: Parameters<QuestionPoolPersistencePort["finish"]>[0]) {
    this.status.set(input.stage, input.status);
    if (input.status === "completed")
      this.outputs.set(input.stage, input.output);
  }

  async persist(input: Parameters<QuestionPoolPersistencePort["persist"]>[0]) {
    this.persistCalls += 1;
    return basePool({
      status: "awaiting-selection",
      keywords: input.keywords,
      questions: input.questions,
      sourceEvidence: input.sourceEvidence,
    });
  }

  async cancel() {
    this.cancelCalls += 1;
    return basePool({ status: "cancelled" });
  }

  async decide(
    input: Parameters<QuestionPoolPersistencePort["decide"]>[0],
  ): Promise<QuestionPoolDecision> {
    this.decisions.push(input);
    return {
      poolId: input.poolId,
      decisionId: "decision-08",
      decision: "confirm-selection",
      expectedRevision: input.expectedRevision,
      revision: input.expectedRevision + 1,
      knowledgeVersion: 7,
      questions: input.questions,
      selectedQuestionIds: input.selectedQuestionIds,
      actorId: input.actorId,
      decidedAt: "2026-08-15T00:10:00Z",
    };
  }

  async revise(
    input: Parameters<QuestionPoolPersistencePort["revise"]>[0],
  ): Promise<QuestionPoolProjection> {
    this.revisions.push(input);
    const pool = basePool({
      id: input.poolId,
      status: "awaiting-selection",
      revision: input.expectedRevision + 1,
      keywords: input.keywords,
      questions: input.questions,
    });
    this.reuse = pool;
    return pool;
  }
}

function providers(
  options: {
    failGenerationOnce?: boolean;
    ungroundedQuestions?: boolean;
  } = {},
) {
  const keywordSearch = {
    slot: "keyword-search" as const,
    baselineEngines: vi.fn(() => []),
    probeQuestion: vi.fn<GeoKeywordSearchCapability["probeQuestion"]>(),
    search: vi.fn<GeoKeywordSearchCapability["search"]>(async () =>
      JSON.stringify({
        core: [
          { term: "成都汽车改装", heat: "high" },
          { term: "鲸跃汽车音响", heat: "high" },
        ],
        scene: [{ term: "锦江区汽车隔音", heat: "medium" }],
        longtail: [{ term: "成都汽车音响改装店资质怎么看", heat: "low" }],
      }),
    ),
  } satisfies GeoKeywordSearchCapability;
  let shouldFail = options.failGenerationOnce === true;
  const generation = {
    slot: "generation" as const,
    complete: vi.fn(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("question_pool_provider_failed");
      }
      return JSON.stringify({
        questions: options.ungroundedQuestions
          ? [
              { text: "缺少来源的问题？" },
              { text: "杜撰来源的问题？", sourceKeywords: ["编造词"] },
            ]
          : [
              {
                text: "成都汽车改装哪家好？",
                recommended: true,
                sourceKeywords: ["成都汽车改装", "编造词"],
              },
              {
                text: "锦江区汽车隔音推荐哪家？",
                sourceKeywords: ["锦江区汽车隔音"],
              },
            ],
      });
    }),
  } satisfies GeoTextCapability;
  const embedding = {
    slot: "embedding" as const,
    dimensions: 2,
    concurrency: 2,
    embed: vi.fn(async (texts: readonly string[]) =>
      texts.map((_, index) => {
        if (index === 0 || index === 1) return [1, 0];
        if (index === 2) return [0, 1];
        return [-1, 0];
      }),
    ),
  } satisfies GeoEmbeddingCapability;
  return { keywordSearch, generation, embedding };
}

function service(persistence: FakePersistence, provider = providers()) {
  return {
    service: new QuestionPoolService(
      { workspaceId: "brand-08", sessionId: "session-08" },
      persistence,
      provider.keywordSearch,
      provider.generation,
      provider.embedding,
    ),
    provider,
  };
}

const input = {
  workspaceId: "brand-08",
  sessionId: "session-08",
  productLine: "汽车音响",
  targetRegion: "成都",
  idempotencyKey: "request-08",
};

describe("QuestionPoolService", () => {
  it("uses fake typed provider ports and persists versioned provenance plus traceable scores", async () => {
    const persistence = new FakePersistence();
    const { service: subject, provider } = service(persistence);
    const pool = await subject.generate(input);

    expect(provider.keywordSearch.search).toHaveBeenCalledTimes(1);
    expect(provider.generation.complete).toHaveBeenCalledTimes(1);
    expect(provider.embedding.embed).toHaveBeenCalledTimes(1);
    expect(pool).toMatchObject({
      knowledgeVersion: 7,
      productLine: "汽车音响",
      targetRegion: "成都",
      status: "awaiting-selection",
    });
    expect(pool.keywords.map((keyword) => keyword.term)).not.toContain(
      "鲸跃汽车音响",
    );
    expect(pool.questions[0]).toMatchObject({
      selected: true,
      score: {
        relevance: 100,
        recentPoolSimilarity: -100,
        optimizationPotential: 100,
        priority: "high",
      },
      evidence: [{ kind: "keyword-search", excerpt: "成都汽车改装" }],
    });
    expect(pool.questions[0].evidence).toHaveLength(1);
    expect(pool.sourceEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "keyword-search" }),
        expect.objectContaining({
          kind: "knowledge-fact",
          reference: "7:industry",
        }),
      ]),
    );
    expect(persistence.persistCalls).toBe(1);
  });

  it("fails explicitly when generation returns only ungrounded questions", async () => {
    const persistence = new FakePersistence();
    const setup = service(
      persistence,
      providers({ ungroundedQuestions: true }),
    );

    await expect(setup.service.generate(input)).rejects.toThrow(
      "question_pool_empty_questions",
    );
    expect(setup.provider.embedding.embed).not.toHaveBeenCalled();
    expect(persistence.persistCalls).toBe(0);
  });

  it("reuses an exact valid pool without any provider call", async () => {
    const persistence = new FakePersistence();
    persistence.reuse = basePool({ status: "confirmed", reused: true });
    const { service: subject, provider } = service(persistence);

    expect(await subject.generate(input)).toBe(persistence.reuse);
    expect(provider.keywordSearch.search).not.toHaveBeenCalled();
    expect(provider.generation.complete).not.toHaveBeenCalled();
    expect(provider.embedding.embed).not.toHaveBeenCalled();
  });

  it("retries only the failed stage and reuses paid checkpoints with one billing key", async () => {
    const persistence = new FakePersistence();
    const setup = service(persistence, providers({ failGenerationOnce: true }));
    await expect(setup.service.generate(input)).rejects.toThrow(
      "question_pool_provider_failed",
    );
    await setup.service.generate({ ...input, retry: true });

    expect(setup.provider.keywordSearch.search).toHaveBeenCalledTimes(1);
    expect(setup.provider.generation.complete).toHaveBeenCalledTimes(2);
    expect(setup.provider.embedding.embed).toHaveBeenCalledTimes(1);
    expect(persistence.attemptNumbers.get("keyword-search")).toBe(1);
    expect(persistence.attemptNumbers.get("question-generation")).toBe(2);
    expect(persistence.attemptNumbers.get("embedding")).toBe(1);
  });

  it("deduplicates concurrent calls for the same attempt", async () => {
    const persistence = new FakePersistence();
    const setup = service(persistence);
    const [first, second] = await Promise.all([
      setup.service.generate(input),
      setup.service.generate(input),
    ]);
    expect(first).toBe(second);
    expect(setup.provider.keywordSearch.search).toHaveBeenCalledTimes(1);
    expect(persistence.persistCalls).toBe(1);
  });

  it("cancels the active provider signal and records cancellation", async () => {
    const persistence = new FakePersistence();
    const provider = providers();
    provider.keywordSearch.search.mockImplementation(
      (_prompt: string, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const setup = service(persistence, provider);
    const generation = setup.service.generate(input);
    await vi.waitFor(() =>
      expect(provider.keywordSearch.search).toHaveBeenCalled(),
    );
    await setup.service.cancel(input.idempotencyKey);
    await expect(generation).rejects.toThrow("question_pool_cancelled");
    expect(persistence.cancelCalls).toBeGreaterThanOrEqual(1);
  });

  it("submits a structured append-only selection decision with desktop actor", async () => {
    const persistence = new FakePersistence();
    const setup = service(persistence);
    const generated = await setup.service.generate(input);
    generated.questions[1].selected = true;
    const decision = await setup.service.confirm({
      workspaceId: "brand-08",
      sessionId: "session-08",
      poolId: generated.id,
      expectedRevision: generated.revision,
      questions: generated.questions,
    });
    expect(decision).toMatchObject({
      decision: "confirm-selection",
      actorId: "desktop-user",
      selectedQuestionIds: generated.questions.map((question) => question.id),
    });
    expect(persistence.decisions[0]).toMatchObject({ actorId: "desktop-user" });
  });

  it("revises a pending question and forwards the verbatim instruction to persistence", async () => {
    const persistence = new FakePersistence();
    const { service: subject } = service(persistence);
    const generated = await subject.generate(input);
    persistence.reuse = { ...generated, status: "awaiting-selection" };
    const target = generated.questions[0];

    const outcome = await subject.revise({
      workspaceId: "brand-08",
      sessionId: "session-08",
      action: "modify",
      targetKind: "question",
      targetId: target.id,
      value: "成都汽车改装哪家靠谱？",
      reason: "把第一个问题改得更口语",
      actorId: "desktop-user",
    });

    // 修订只解析本 Session 的待决池（跳过普通 latest 优先返回的已确认池）。
    expect(persistence.latestCalls.at(-1)).toEqual({
      productLine: undefined,
      pendingOnly: true,
    });
    expect(persistence.revisions[0]).toMatchObject({
      poolId: generated.id,
      expectedRevision: generated.revision,
      action: "modify",
      targetKind: "question",
      targetId: target.id,
      actorId: "desktop-user",
      reason: "把第一个问题改得更口语",
    });
    expect(
      persistence.revisions[0].questions.find((q) => q.id === target.id)?.text,
    ).toBe("成都汽车改装哪家靠谱？");
    expect(outcome.pool.status).toBe("awaiting-selection");
  });

  it("adds and deletes pending keywords and questions with user-added provenance", async () => {
    const persistence = new FakePersistence();
    const { service: subject } = service(persistence);
    const generated = await subject.generate(input);
    persistence.reuse = { ...generated, status: "awaiting-selection" };

    await subject.revise({
      workspaceId: "brand-08",
      sessionId: "session-08",
      action: "add",
      targetKind: "keyword",
      value: { term: "成都汽车隔音", category: "scene", heat: "high" },
      reason: "加一个场景词",
      actorId: "desktop-user",
    });
    const addedKeywords = persistence.revisions[0].keywords;
    expect(addedKeywords.at(-1)).toMatchObject({
      term: "成都汽车隔音",
      category: "scene",
      heat: "high",
      platform: "doubao",
    });
    expect(addedKeywords.at(-1)?.id).toMatch(/^kw-user-/);

    await subject.revise({
      workspaceId: "brand-08",
      sessionId: "session-08",
      action: "add",
      targetKind: "question",
      value: { text: "成都贴隐形车衣要多少钱？" },
      reason: "补一个价格问题",
      actorId: "desktop-user",
    });
    const addedQuestion = persistence.revisions[1].questions.at(-1);
    expect(addedQuestion).toMatchObject({
      text: "成都贴隐形车衣要多少钱？",
      recommended: false,
    });
    expect(addedQuestion?.id).toMatch(/^q-user-/);
    expect(addedQuestion?.evidence).toEqual([
      { kind: "user-added", reference: "chat-revision", excerpt: "成都贴隐形车衣要多少钱？" },
    ]);
    expect(addedQuestion?.score).toMatchObject({ priority: "low", relevance: 0 });

    const before = persistence.revisions[1].questions.length;
    await subject.revise({
      workspaceId: "brand-08",
      sessionId: "session-08",
      action: "delete",
      targetKind: "question",
      targetId: addedQuestion!.id,
      reason: "删掉刚才加的",
      actorId: "desktop-user",
    });
    expect(persistence.revisions[2].questions).toHaveLength(before - 1);
  });

  it("rejects revisions on confirmed pools, unknown targets, duplicates and cross-session identity", async () => {
    const persistence = new FakePersistence();
    const { service: subject } = service(persistence);
    const generated = await subject.generate(input);

    persistence.reuse = { ...generated, status: "confirmed" };
    await expect(
      subject.revise({
        workspaceId: "brand-08",
        sessionId: "session-08",
        action: "delete",
        targetKind: "question",
        targetId: generated.questions[0].id,
        reason: "删",
        actorId: "desktop-user",
      }),
    ).rejects.toThrow("question_pool_confirmed_immutable");

    persistence.reuse = { ...generated, status: "awaiting-selection" };
    await expect(
      subject.revise({
        workspaceId: "brand-08",
        sessionId: "session-08",
        action: "modify",
        targetKind: "question",
        targetId: "q-404",
        value: "x",
        reason: "改",
        actorId: "desktop-user",
      }),
    ).rejects.toThrow("question_pool_revision_target_not_found");

    await expect(
      subject.revise({
        workspaceId: "brand-08",
        sessionId: "session-08",
        action: "add",
        targetKind: "question",
        value: { text: generated.questions[0].text },
        reason: "加重复问题",
        actorId: "desktop-user",
      }),
    ).rejects.toThrow("question_pool_question_duplicate");

    await expect(
      subject.revise({
        workspaceId: "brand-08",
        sessionId: "session-other",
        action: "delete",
        targetKind: "question",
        targetId: generated.questions[0].id,
        reason: "跨会话修订",
        actorId: "desktop-user",
      }),
    ).rejects.toThrow("question_pool_identity_mismatch");
    expect(persistence.revisions).toHaveLength(0);
  });
});
