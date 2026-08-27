import { describe, expect, it } from "vitest";
import { JS_AI_DEV_BEHAVIOR_FIXTURE } from "./__fixtures__/jsAiDevBehavior";
import {
  allocateGeoChannelQuota,
  classifyGeoQuestionPriority,
  GEO_PORT_CONTRACT,
  isGeoChannelQualityEligible,
  resolveGeoStageModel,
  scoreGeoHybridKnowledge,
  scoreGeoQuestionMatch,
  scoreGeoQuestionPotential,
} from "./portContract";

describe("GEO port contract", () => {
  it("rejects channels whose authoritative price is missing or malformed", () => {
    for (const price of [undefined, null, "", "   ", "unknown", "-1"]) {
      expect(isGeoChannelQualityEligible({ price })).toBe(false);
    }
  });

  it("pins the audited js_ai baseline and the Xiaojing ownership split", () => {
    expect(GEO_PORT_CONTRACT.baseline).toEqual({
      repository: "js_ai",
      ref: "dev",
      commit: "936b971751f029e9d67fc86356e8234569e33570",
    });

    expect(GEO_PORT_CONTRACT.domainOwnership).toMatchObject({
      BrandWorkspace: {
        businessBoundary: "brand",
        decisionOwner: "geo-domain",
      },
      Session: {
        businessBoundary: "chat-context",
        decisionOwner: "session-runtime",
      },
      GeoOperation: {
        businessBoundary: "one-geo-action",
        decisionOwner: "geo-domain",
      },
      KnowledgeAuthority: {
        businessBoundary: "authoritative-brand-facts",
        decisionOwner: "knowledge-authority",
      },
      GeoArtifact: {
        businessBoundary: "versioned-business-output",
        decisionOwner: "geo-domain",
      },
      ManagedTask: {
        businessBoundary: "monitor-wakeup",
        decisionOwner: "task-scheduler",
      },
      PublishScheduler: {
        businessBoundary: "deterministic-publishing",
        decisionOwner: "publish-scheduler",
      },
    });

    expect(GEO_PORT_CONTRACT.domainOwnership.ManagedTask.ownsGeoState).toBe(
      false,
    );
    expect(
      GEO_PORT_CONTRACT.domainOwnership.PublishScheduler.modelMayReplace,
    ).toBe(false);
  });

  it("preserves the internal stages, planners, human gates, and five content types", () => {
    expect(GEO_PORT_CONTRACT.contentTypes).toEqual([
      "guide",
      "showcase",
      "ranking",
      "news",
      "news_light",
    ]);
    expect(GEO_PORT_CONTRACT.legacyBrandStages).toEqual([
      "idle",
      "extracting_profile",
      "mining_keywords",
      "awaiting_keyword_confirmation",
      "awaiting_profile_confirmation",
      "building_questions",
      "awaiting_question_selection",
      "generating_articles",
      "awaiting_article_reviews",
      "distributing",
      "scheduling",
      "done",
    ]);
    expect(GEO_PORT_CONTRACT.articleLifecycle.primaryPath).toEqual([
      "planned",
      "drafting",
      "draft_ready",
      "reviewing",
      "approved",
      "published",
      "assigning",
      "scheduling",
      "monitoring",
      "done",
    ]);
    expect(GEO_PORT_CONTRACT.articleLifecycle.exceptionStates).toEqual([
      "pending_confirmation",
      "generation_failed",
      "rejected",
    ]);
    expect(GEO_PORT_CONTRACT.humanGates.map((gate) => gate.id)).toEqual([
      "profile",
      "keywords",
      "questions",
      "draft",
      "review-decision",
      "channel-assignment",
      "distribution-plan",
    ]);
    expect(
      GEO_PORT_CONTRACT.humanGates.find(
        (gate) => gate.id === "distribution-plan",
      ),
    ).toMatchObject({
      requiredBefore: "paid-order-submission",
      executorAfterConfirmation: "publish-scheduler",
    });
    expect(GEO_PORT_CONTRACT.migrationPlanners).toEqual({
      material_to_facts: "evidence-planner",
      question_construction: "question-construction-planner",
      content_production: "content-production-planner",
      review: null,
      publish: null,
      channel_recommendation: "pure-distribution-planner",
    });
  });

  it("pins question scoring, embedding, hybrid retrieval, and channel-recall algorithms", () => {
    expect(GEO_PORT_CONTRACT.questionScoring).toEqual({
      mode: "pred-1",
      candidateLimit: 20,
      missingVectorScore: 50,
      match: "round(clamp(max(0, cosineSimilarity) * 100, 0, 100))",
      potential: "round(clamp((1 - nearestPoolCosineSimilarity) * 50, 0, 100))",
      emptyPoolNearestSimilarity: 0,
      priority: { highAtSum: 150, mediumAtSum: 100 },
    });
    expect(GEO_PORT_CONTRACT.embedding).toEqual({
      provider: "volcengine",
      modelFamily: "doubao-embedding-vision",
      endpointPath: "/embeddings/multimodal",
      dimensions: 2048,
      requestSemantics: "one-text-per-request-one-fused-vector",
      concurrency: 2,
      additionalRetries: 2,
      retryBackoffMs: [500, 1000],
      fallback: "deterministic-fnv1a-term-frequency-unit-vector",
    });
    expect(GEO_PORT_CONTRACT.knowledgeRetrieval).toEqual({
      defaultTopK: 5,
      candidatePoolMultiplier: 3,
      cjkNgrams: [2, 3, 4],
      weights: { vector: 0.45, lexical: 0.35, title: 0.12, metadata: 0.08 },
      order: [
        "embedding",
        "knn",
        "hybrid-score",
        "governance-filter",
        "conflict-resolution",
        "top-k",
      ],
    });
    expect(GEO_PORT_CONTRACT.channelRecall).toMatchObject({
      paths: {
        passive: { number: 1, weight: 0.4 },
        active: { number: 2, weight: 0.2 },
        fallback: { number: 3, weight: 0.1 },
        preference: { number: 4, weight: 0.3 },
      },
      alignment: {
        nameFallbackThreshold: 0.55,
        passiveDomainCap: 3,
        activeDomainCap: 2,
        nameFallbackCap: 1,
        multiTenantDomainExempt: true,
      },
      passiveRecall: {
        perQuestionCap: 10,
        totalCap: 50,
        rankBy: "cross-question-registered-domain-frequency-desc",
      },
      fallbackTopN: 50,
      recommendation: {
        max: 30,
        mediaQuota: 20,
        weMediaQuota: 10,
        surplusFill: true,
      },
      quality: {
        defaultPerArticleMaxPoints: 3_000,
        defaultPerExecutionMaxPoints: 20_000,
        limitSource: "user-setting-snapshotted-on-plan",
      },
    });
  });

  it("pins deterministic publish safety rather than delegating it to a model", () => {
    expect(GEO_PORT_CONTRACT.publishing).toEqual({
      oneArticleOneChannel: true,
      rewritePerChannel: false,
      draftPoolLimit: 50,
      schedulerScanIntervalSeconds: 60,
      dailyLimits: { media: 5, weMedia: 3 },
      atLimitSchedule: "next-local-day-00:01",
      skipWeekendWhenUnsupported: true,
      idempotencyKey: "article-{articleId}-channel-{resourceId}-v{version}",
      defaultIdempotencyVersion: 1,
      payloadHash: "sha-256(title|content|remark)",
      maximumRetries: 3,
      retryBackoffMs: [60_000, 300_000, 900_000],
      distributionFailureRollsBackArticle: false,
      orderSubmissionOwner: "publish-scheduler",
    });
  });

  it("pins model routing, web grounding, prompt structures, and concurrency semantics", () => {
    expect(GEO_PORT_CONTRACT.modelRouting).toMatchObject({
      stages: [
        "extraction",
        "keyword_mining",
        "question_pool",
        "type_recommendation",
        "draft",
        "review",
        "rewrite",
        "title",
        "distribution",
      ],
      resolutionOrder: [
        "explicit-stage-config",
        "pinned-default",
        "active-model",
      ],
      pinned: {
        question_pool: ["volcengine", "doubao-seed-2-0-lite-260428"],
        title: ["volcengine", "doubao-seed-2-0-lite-260428"],
        draft: ["volcengine", "doubao-seed-2-0-pro-260215"],
      },
      extractionDefault: "deepseek-chat",
      pinnedStageFailover: false,
    });
    expect(GEO_PORT_CONTRACT.webGrounding).toMatchObject({
      keywordMining: {
        provider: "volcengine-paygo",
        parameter: ["enable_search", true],
      },
      passiveRecall: {
        defaultApi: "responses",
        defaultMode: "ai_search",
        citationsOnly: true,
      },
      sourceDiscovery: {
        legs: ["configured-web-search", "supermedia-resource-pool"],
        failureMode: "independent-best-effort",
      },
      globalRecallRequiresRegisteredDomain: true,
    });
    expect(GEO_PORT_CONTRACT.promptStructures).toMatchObject({
      profileExtraction: { output: "14-field-profile-with-field-provenance" },
      keywordMining: {
        output: "strict-json-core-scene-longtail-with-heat-bands",
        forbidsBrandNames: true,
      },
      questionConstruction: {
        output: "strict-json-questions-text-and-recommended",
      },
      titleGeneration: { candidates: [3, 5], rankingRequiresCurrentYear: true },
      articleGeneration: {
        output: "plain-markdown",
        callsPerDraft: 1,
        unresolvedPlaceholdersAllowed: false,
      },
      globalRecall: {
        output: "json-channel-name-url-topicNumbers",
        topicLimit: 20,
      },
    });
    expect(GEO_PORT_CONTRACT.concurrency).toEqual({
      perArticleLifecycle: {
        limit: 5,
        overflow: "fifo-queue",
        failureIsolation: true,
      },
      perArticleSupervisorLock: true,
      embedding: { limit: 2, preservesInputOrder: true },
      passiveDoubaoAppRecall: { limit: 2, failureIsolation: true },
      passiveWebSearchRecall: "fully-parallel",
      sourceDiscoveryLegs: "parallel",
      globalRecallWithArticleGeneration: "concurrent-fire-and-forget",
      passiveAndActiveRecall: "parallel",
      brandStoreWrites: "serialized",
      brandStoreReads: "concurrent",
    });
  });

  it("keeps historical/demo compatibility out and contains no credential material", () => {
    expect(GEO_PORT_CONTRACT.excludedFromPort).toEqual([
      "historical-test-databases",
      "demo-brands",
      "mock-dashboard-values",
      "obsolete-compatibility-logic",
    ]);
    expect(GEO_PORT_CONTRACT.nonCapabilities).toContain(
      "effect-report-auto-plans-next-round",
    );

    const serialized = JSON.stringify(GEO_PORT_CONTRACT);
    expect(serialized).not.toMatch(
      /"(?:apiKey|secret|token|endpointId)"\s*:|ep-\d{8,}/i,
    );
  });

  it("publishes worked parity cases for future ported slices", () => {
    const fixture = JS_AI_DEV_BEHAVIOR_FIXTURE.scalarAlgorithms;
    for (const testCase of fixture.questionPriority) {
      expect(
        classifyGeoQuestionPriority(testCase.match, testCase.potential),
      ).toBe(testCase.expected);
    }
    for (const testCase of fixture.questionMatch) {
      expect(scoreGeoQuestionMatch(testCase.cosineSimilarity)).toBe(
        testCase.expected,
      );
    }
    for (const testCase of fixture.questionPotential) {
      expect(scoreGeoQuestionPotential(testCase.nearestSimilarity)).toBe(
        testCase.expected,
      );
    }
    for (const testCase of fixture.channelQuality) {
      expect(
        isGeoChannelQualityEligible({
          price: testCase.price,
        }),
      ).toBe(testCase.expected);
    }
    for (const testCase of fixture.hybridScore) {
      expect(scoreGeoHybridKnowledge(testCase)).toBeCloseTo(
        testCase.expected,
        12,
      );
    }
    for (const testCase of fixture.channelQuota) {
      expect(
        allocateGeoChannelQuota(
          testCase.availableMedia,
          testCase.availableWeMedia,
        ),
      ).toEqual(testCase.expected);
    }
    for (const testCase of fixture.modelRouting) {
      expect(resolveGeoStageModel(testCase.stage, testCase.explicit)).toEqual(
        testCase.expected,
      );
    }
  });
});
