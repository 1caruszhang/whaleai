/**
 * Executable compatibility baseline for the js_ai GEO port.
 *
 * This module contains product and behavioural facts only. It deliberately has
 * no provider imports, filesystem access, environment reads, timers, or network
 * calls so every future GEO slice can depend on it from a credential-free unit
 * test.
 */

export const GEO_PORT_CONTRACT = {
  baseline: {
    repository: "js_ai",
    ref: "dev",
    commit: "936b971751f029e9d67fc86356e8234569e33570",
  },
  domainOwnership: {
    BrandWorkspace: {
      businessBoundary: "brand",
      decisionOwner: "geo-domain",
      persistenceOwner: "rust-brand-store",
      meaning:
        "The only brand business boundary: knowledge, product lines, sessions, artifacts, publishing, and observations share this identity.",
    },
    Session: {
      businessBoundary: "chat-context",
      decisionOwner: "session-runtime",
      persistenceOwner: "rust-session-store",
      meaning:
        "An isolated chat and agent context inside one BrandWorkspace; it may create many GeoOperations and never owns shared brand facts.",
    },
    GeoOperation: {
      businessBoundary: "one-geo-action",
      decisionOwner: "geo-domain",
      persistenceOwner: "rust-brand-store",
      meaning:
        "One concrete GEO action with inputs, checkpoints, artifacts, and a terminal outcome; it is not a fixed one-run-per-session workflow.",
    },
    KnowledgeAuthority: {
      businessBoundary: "authoritative-brand-facts",
      decisionOwner: "knowledge-authority",
      persistenceOwner: "rust-brand-store",
      meaning:
        "The only policy entry for accepting authoritative brand facts. Models and UI may submit candidates or decisions but cannot write around it.",
    },
    GeoArtifact: {
      businessBoundary: "versioned-business-output",
      decisionOwner: "geo-domain",
      persistenceOwner: "rust-brand-store",
      meaning:
        "A versioned, provenance-carrying business output such as a question pool, plan, article, order, observation, or report.",
    },
    ManagedTask: {
      businessBoundary: "monitor-wakeup",
      decisionOwner: "task-scheduler",
      persistenceOwner: "rust-task-store",
      ownsGeoState: false,
      meaning:
        "Hidden scheduling infrastructure that only wakes a referenced monitoring operation; Task Center does not own GEO stages or artifacts.",
    },
    PublishScheduler: {
      businessBoundary: "deterministic-publishing",
      decisionOwner: "publish-scheduler",
      persistenceOwner: "rust-brand-store",
      modelMayReplace: false,
      meaning:
        "The deterministic owner of idempotent paid-order submission, timing, status sync, and retry. A model may propose a plan but never submit in its place.",
    },
  },
  contentTypes: ["guide", "showcase", "ranking", "news", "news_light"],
  legacyBrandStages: [
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
  ],
  articleLifecycle: {
    primaryPath: [
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
    ],
    exceptionStates: ["pending_confirmation", "generation_failed", "rejected"],
    retryRecovery: {
      pending_confirmation: "drafting",
      generation_failed: "drafting",
      rejected: "drafting",
      reviewing_rewrite: "drafting",
    },
  },
  migrationPlanners: {
    material_to_facts: "evidence-planner",
    question_construction: "question-construction-planner",
    content_production: "content-production-planner",
    review: null,
    publish: null,
    channel_recommendation: "pure-distribution-planner",
  },
  humanGates: [
    {
      id: "profile",
      requiredBefore: "keyword-mining",
      executorAfterConfirmation: "geo-domain",
      semantics:
        "Missing required fields or inferred values park until the user accepts or edits the profile.",
    },
    {
      id: "keywords",
      requiredBefore: "question-construction",
      executorAfterConfirmation: "geo-domain",
      semantics:
        "Mined search terms are reviewed before any candidate questions are built.",
    },
    {
      id: "questions",
      requiredBefore: "article-planning",
      executorAfterConfirmation: "geo-domain",
      semantics:
        "Only the selected pending questions become ready and enter semantic topic/type/title planning.",
    },
    {
      id: "draft",
      requiredBefore: "risk-and-fact-review",
      executorAfterConfirmation: "geo-domain",
      semantics:
        "A generated draft parks at draft_ready; confirmation advances without regenerating it.",
    },
    {
      id: "review-decision",
      requiredBefore: "article-approval",
      executorAfterConfirmation: "geo-domain",
      semantics:
        "Risk blocks pre-empt approval; unsupported hard claims park for a user rewrite or explicit decision.",
    },
    {
      id: "channel-assignment",
      requiredBefore: "oss-distribution-planning",
      executorAfterConfirmation: "geo-domain",
      semantics:
        "The user confirms the one-article-to-one-channel assignment; channels cannot be silently reused.",
    },
    {
      id: "distribution-plan",
      requiredBefore: "paid-order-submission",
      executorAfterConfirmation: "publish-scheduler",
      semantics:
        "Only this confirmation authorizes deterministic order creation and scheduled submission.",
    },
  ],
  operationSteps: [
    {
      id: "material-to-facts",
      dependsOn: ["brand-materials"],
      produces: ["profile-candidates", "knowledge-chunks"],
      semantics:
        "Extract the 14-field profile with provenance, preserve source text while chunking, enrich real competitors, then embed.",
    },
    {
      id: "keyword-mining",
      dependsOn: ["confirmed-profile"],
      produces: ["keyword-library"],
      semantics:
        "Mine real core, scene, and long-tail search terms once; existing terms make the step idempotent.",
    },
    {
      id: "question-construction",
      dependsOn: ["confirmed-profile", "confirmed-keywords"],
      produces: ["pending-question-candidates"],
      semantics:
        "Turn mined terms into natural questions, score them with PRED-1, and stop at selection.",
    },
    {
      id: "topic-type-title-planning",
      dependsOn: ["selected-questions"],
      produces: ["semantic-topics", "type-recommendations", "title-candidates"],
      semantics:
        "Semantically merge questions, recommend one to five types while preserving five-type batch coverage, and generate titles before body generation.",
    },
    {
      id: "content-production",
      dependsOn: ["confirmed-facts", "selected-title", "type-template"],
      produces: ["channel-agnostic-markdown-draft"],
      semantics:
        "Refresh the Claim root and make one body-generation call; per-channel rewriting is retired.",
    },
    {
      id: "review",
      dependsOn: ["confirmed-draft", "confirmed-facts"],
      produces: ["approved-or-parked-article"],
      semantics:
        "Run fail-closed risk scanning, exact normalized claim matching, and an LLM semantic backstop only where needed.",
    },
    {
      id: "global-channel-recall",
      dependsOn: [
        "all-selected-questions",
        "article-topics",
        "approved-channel-pool",
      ],
      produces: ["global-channel-pool"],
      semantics:
        "Run once concurrently with article generation, then intersect the four-path union with the real resource pool.",
    },
    {
      id: "channel-assignment",
      dependsOn: ["confirmed-channel-candidates", "generated-articles"],
      produces: ["one-to-one-assignment-map"],
      semantics:
        "Prefer topic matches, fall back to hit count, and do not reuse a channel.",
    },
    {
      id: "distribution-plan",
      dependsOn: ["confirmed-assignment"],
      produces: ["oss-preview", "next-publish-at"],
      semantics:
        "Upload the main draft once without a rewrite and compute deterministic timing; do not create an order yet.",
    },
    {
      id: "publish",
      dependsOn: ["confirmed-distribution-plan"],
      produces: ["idempotent-orders", "publish-observations"],
      semantics:
        "The PublishScheduler creates, submits, synchronizes, and retries orders; model output is never execution authority.",
    },
  ],
  questionScoring: {
    mode: "pred-1",
    candidateLimit: 20,
    missingVectorScore: 50,
    match: "round(clamp(max(0, cosineSimilarity) * 100, 0, 100))",
    potential: "round(clamp((1 - nearestPoolCosineSimilarity) * 50, 0, 100))",
    emptyPoolNearestSimilarity: 0,
    priority: { highAtSum: 150, mediumAtSum: 100 },
  },
  embedding: {
    provider: "volcengine",
    modelFamily: "doubao-embedding-vision",
    endpointPath: "/embeddings/multimodal",
    dimensions: 2048,
    requestSemantics: "one-text-per-request-one-fused-vector",
    concurrency: 2,
    additionalRetries: 2,
    retryBackoffMs: [500, 1000],
    fallback: "deterministic-fnv1a-term-frequency-unit-vector",
  },
  knowledgeRetrieval: {
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
  },
  channelRecall: {
    paths: {
      passive: {
        number: 1,
        weight: 0.4,
        signal: "real-per-question-citations",
      },
      active: {
        number: 2,
        weight: 0.2,
        signal: "global-topic-channel-recommendation",
      },
      fallback: { number: 3, weight: 0.1, signal: "keyword-to-approved-pool" },
      preference: {
        number: 4,
        weight: 0.3,
        signal: "human-curated-approved-pool",
      },
    },
    mergeSemantics: "union-by-resource-id-sum-distinct-path-weights",
    poolSemantics: "four-path-union-intersect-approved-supermedia-pool",
    alignment: {
      order: ["registered-domain-etld-plus-one", "chinese-name-fallback"],
      nameFallbackThreshold: 0.55,
      passiveDomainCap: 3,
      activeDomainCap: 2,
      nameFallbackCap: 1,
    },
    passiveRecall: {
      oneIndependentSearchPerQuestion: true,
      perQuestionCap: 15,
      perRegisteredDomainCap: 3,
      defaultMode: "ai_search",
    },
    fallbackTopN: 50,
    geoInclusionHardFilterScope: "fallback-only",
    recommendation: {
      max: 30,
      mediaQuota: 20,
      weMediaQuota: 10,
      surplusFill: true,
      rank: ["weighted-path-score-desc", "hit-count-desc", "name-asc"],
    },
    quality: {
      minimumKnownPublishedRate: 70,
      unknownPublishedRate: 0,
      maximumPriceExclusive: 150,
      priceParsedNumerically: true,
      appliedBeforeAlignmentAndQuota: true,
    },
  },
  publishing: {
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
  },
  modelRouting: {
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
      question_pool: ["volcengine", "doubao-seed-2-0-mini-260428"],
      title: ["volcengine", "doubao-seed-2-0-mini-260428"],
      draft: ["volcengine", "doubao-seed-2-0-pro-260215"],
    },
    extractionDefault: "deepseek-chat",
    keywordMiningRoute: "volcengine-paygo-endpoint-specific",
    pinnedStageFailover: false,
    unpinnedFailoverTriggers: [
      "request-error",
      "empty-content",
      "sse-empty-stream",
      "truncation",
    ],
    truncationNearTokenLimitRatio: 0.92,
  },
  webGrounding: {
    keywordMining: {
      provider: "volcengine-paygo",
      endpointSemantics: "api-v3-not-agent-plan",
      parameter: ["enable_search", true],
      heatSemantics: "high-medium-low-band-not-absolute-volume",
    },
    passiveRecall: {
      defaultApi: "responses",
      defaultMode: "ai_search",
      citationsOnly: true,
      questionSemantics: "one-independent-query-per-selected-question",
    },
    activeRecall: {
      scope: "one-global-numbered-topic-query",
      provider: "volcengine-paygo-enable-search",
    },
    sourceDiscovery: {
      legs: ["configured-web-search", "supermedia-resource-pool"],
      failureMode: "independent-best-effort",
      limits: { web: 5, media: 5, weMedia: 3 },
    },
    globalRecallRequiresRegisteredDomain: true,
    fabricatedOrUnresolvableUrlsAreDropped: true,
  },
  promptStructures: {
    profileExtraction: {
      inputs: ["source-materials"],
      output: "14-field-profile-with-field-provenance",
      fields: [
        "fullName",
        "shortNames",
        "addresses",
        "serviceArea",
        "industry",
        "products",
        "relatedBrands",
        "competitors",
        "targetCustomers",
        "coreAdvantages",
        "trustEndorsements",
        "customerPainPoints",
        "customerCases",
        "contactInfo",
      ],
      provenanceOrder: ["extracted", "asked", "inferred"],
    },
    keywordMining: {
      inputs: [
        "region",
        "industry",
        "confirmed-products",
        "confirmed-advantages",
        "confirmed-cases",
      ],
      output: "strict-json-core-scene-longtail-with-heat-bands",
      forbidsBrandNames: true,
      requiresRealSubregionVerification: true,
    },
    questionConstruction: {
      inputs: [
        "confirmed-profile",
        "confirmed-keyword-library",
        "existing-questions",
      ],
      output: "strict-json-questions-text-and-recommended",
      candidateLimit: 20,
      questionCarriesContentType: false,
    },
    topicMerge: {
      output: "json-questionIds-and-composite-topic",
      missingQuestionFallback: "single-question-group",
    },
    typeRecommendation: {
      output: "json-questionId-types-reason",
      typesPerTopic: [1, 5],
      enforcesBatchCoverageOfAllFiveTypes: true,
    },
    titleGeneration: {
      candidates: [3, 5],
      styles: {
        guide: "question",
        showcase: "seo",
        ranking: "attractive",
        news: "professional",
        news_light: "professional",
      },
      maximumCharacters: {
        guide: 28,
        showcase: 30,
        ranking: 30,
        news: 25,
        news_light: 30,
      },
      showcaseRequiresTargetBrand: true,
      rankingForbidsBrand: true,
      rankingRequiresCurrentYear: true,
    },
    articleGeneration: {
      inputs: [
        "selected-title",
        "semantic-topic",
        "confirmed-facts",
        "confirmed-profile",
        "type-template",
      ],
      output: "plain-markdown",
      callsPerDraft: 1,
      maxTokens: 8192,
      temperature: 0.85,
      topP: 0.9,
      unresolvedPlaceholdersAllowed: false,
      competitorNamesAvailableTo: ["ranking"],
    },
    globalRecall: {
      inputs: ["numbered-deduplicated-topics", "industry", "derived-keywords"],
      output: "json-channel-name-url-topicNumbers",
      topicLimit: 20,
      outOfRangeTopicNumbers: "drop-number-keep-channel",
    },
  },
  concurrency: {
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
  },
  excludedFromPort: [
    "historical-test-databases",
    "demo-brands",
    "mock-dashboard-values",
    "obsolete-compatibility-logic",
  ],
  nonCapabilities: [
    "effect-report-auto-plans-next-round",
    "mock-metrics-as-decision-input",
    "model-owned-paid-order-submission",
    "task-center-owned-geo-state",
  ],
  parityCases: {
    questionPriority: [
      { match: 75, potential: 75, expected: "high" },
      { match: 74, potential: 75, expected: "medium" },
      { match: 50, potential: 50, expected: "medium" },
      { match: 49, potential: 50, expected: "low" },
    ],
    questionMatch: [
      { cosineSimilarity: 1, expected: 100 },
      { cosineSimilarity: 0.499, expected: 50 },
      { cosineSimilarity: -0.5, expected: 0 },
    ],
    questionPotential: [
      { nearestSimilarity: 1, expected: 0 },
      { nearestSimilarity: 0, expected: 50 },
      { nearestSimilarity: -1, expected: 100 },
    ],
    channelQuality: [
      { publishedRate: 0, price: "100", expected: true },
      { publishedRate: 69, price: "100", expected: false },
      { publishedRate: 70, price: "149", expected: true },
      { publishedRate: 70, price: "150", expected: false },
      { publishedRate: undefined, price: "99", expected: true },
    ],
    hybridScore: [
      { vector: 1, lexical: 0.5, title: 0.25, metadata: 0.75, expected: 0.715 },
    ],
    channelQuota: [
      {
        availableMedia: 30,
        availableWeMedia: 30,
        expectedMedia: 20,
        expectedWeMedia: 10,
      },
      {
        availableMedia: 8,
        availableWeMedia: 30,
        expectedMedia: 8,
        expectedWeMedia: 22,
      },
      {
        availableMedia: 30,
        availableWeMedia: 4,
        expectedMedia: 26,
        expectedWeMedia: 4,
      },
    ],
    modelRouting: [
      {
        stage: "draft",
        explicit: undefined,
        expected: ["volcengine", "doubao-seed-2-0-pro-260215"],
      },
      {
        stage: "draft",
        explicit: ["custom-provider", "custom-model"],
        expected: ["custom-provider", "custom-model"],
      },
      { stage: "review", explicit: undefined, expected: "active-model" },
    ],
  },
} as const;

function clampGeoScore(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : 50;
  return Math.max(0, Math.min(100, Math.round(finiteValue)));
}

/** Pure PRED-1 reference evaluator for parity tests in ported slices. */
export function scoreGeoQuestionMatch(cosineSimilarity: number): number {
  return clampGeoScore(Math.max(0, cosineSimilarity) * 100);
}

/** Pure PRED-1 novelty evaluator; an empty pool passes `0` and scores 50. */
export function scoreGeoQuestionPotential(
  nearestPoolSimilarity: number,
): number {
  return clampGeoScore((1 - nearestPoolSimilarity) * 50);
}

export function classifyGeoQuestionPriority(
  match: number,
  potential: number,
): "high" | "medium" | "low" {
  const sum = match + potential;
  if (sum >= GEO_PORT_CONTRACT.questionScoring.priority.highAtSum)
    return "high";
  if (sum >= GEO_PORT_CONTRACT.questionScoring.priority.mediumAtSum) {
    return "medium";
  }
  return "low";
}

export function scoreGeoHybridKnowledge(input: {
  vector: number;
  lexical: number;
  title: number;
  metadata: number;
}): number {
  const weights = GEO_PORT_CONTRACT.knowledgeRetrieval.weights;
  return (
    input.vector * weights.vector +
    input.lexical * weights.lexical +
    input.title * weights.title +
    input.metadata * weights.metadata
  );
}

/** Mirrors the pre-alignment channel hard filter, including zero-as-unknown. */
export function isGeoChannelQualityEligible(input: {
  publishedRate?: number | null;
  price?: string | null;
}): boolean {
  const quality = GEO_PORT_CONTRACT.channelRecall.quality;
  if (
    typeof input.publishedRate === "number" &&
    input.publishedRate > quality.unknownPublishedRate &&
    input.publishedRate < quality.minimumKnownPublishedRate
  ) {
    return false;
  }
  if (input.price != null && input.price !== "") {
    const numericPrice = Number(input.price);
    if (
      Number.isFinite(numericPrice) &&
      numericPrice >= quality.maximumPriceExclusive
    ) {
      return false;
    }
  }
  return true;
}

/** Returns the soft 20/10 channel-kind caps after surplus fill. */
export function allocateGeoChannelQuota(
  availableMedia: number,
  availableWeMedia: number,
): { media: number; weMedia: number } {
  const recommendation = GEO_PORT_CONTRACT.channelRecall.recommendation;
  const mediaAvailable = Math.max(0, Math.floor(availableMedia));
  const weMediaAvailable = Math.max(0, Math.floor(availableWeMedia));
  let mediaLimit = recommendation.mediaQuota;
  let weMediaLimit = recommendation.weMediaQuota;

  if (mediaAvailable < recommendation.mediaQuota) {
    weMediaLimit += recommendation.mediaQuota - mediaAvailable;
  } else if (weMediaAvailable < recommendation.weMediaQuota) {
    mediaLimit += recommendation.weMediaQuota - weMediaAvailable;
  }

  return {
    media: Math.min(mediaAvailable, mediaLimit),
    weMedia: Math.min(weMediaAvailable, weMediaLimit),
  };
}

export function resolveGeoStageModel(
  stage: string,
  explicit?: readonly [provider: string, model: string],
): readonly [provider: string, model: string] | "active-model" {
  if (explicit) return explicit;
  const pinned = GEO_PORT_CONTRACT.modelRouting.pinned as Partial<
    Record<string, readonly [provider: string, model: string]>
  >;
  return pinned[stage] ?? "active-model";
}

export type GeoPortContract = typeof GEO_PORT_CONTRACT;
