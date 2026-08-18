/**
 * Independent worked examples audited from js_ai dev at the pinned commit.
 *
 * Expected values are literals captured from the source behavior, not derived
 * from Xiaojing's reference evaluators. Keep this fixture free of production
 * imports so changing an implementation cannot silently rewrite its oracle.
 */
export const JS_AI_DEV_BEHAVIOR_FIXTURE = {
  baseline: {
    repository: "js_ai",
    ref: "dev",
    commit: "936b971751f029e9d67fc86356e8234569e33570",
  },
  scalarAlgorithms: {
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
      // js_ai 原判：publishedRate 69 被低成功率硬过滤（expected false）。
      // 小鲸同学 用户裁决 2026-08-18：发布率不参与任何决策，唯一质量门是
      // 数值价格 >=150 过滤——低成功率渠道在此期望 true。
      { publishedRate: 0, price: "100", expected: true },
      { publishedRate: 69, price: "100", expected: true },
      { publishedRate: 70, price: "149", expected: true },
      { publishedRate: 70, price: "150", expected: false },
      { publishedRate: undefined, price: "99", expected: true },
    ],
    hybridScore: [
      {
        vector: 1,
        lexical: 0.5,
        title: 0.25,
        metadata: 0.75,
        expected: 0.715,
      },
    ],
    channelQuota: [
      {
        availableMedia: 30,
        availableWeMedia: 30,
        expected: { media: 20, weMedia: 10 },
      },
      {
        availableMedia: 8,
        availableWeMedia: 30,
        expected: { media: 8, weMedia: 22 },
      },
      {
        availableMedia: 30,
        availableWeMedia: 4,
        expected: { media: 26, weMedia: 4 },
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
  questionScoring: [
    {
      id: "aligned-question-empty-pool",
      questionVector: [1, 0],
      profileAnchorVector: [1, 0],
      poolVectors: [],
      expected: { match: 100, potential: 50, priority: "high" },
    },
    {
      id: "covered-question-low-brand-match",
      questionVector: [1, 0],
      profileAnchorVector: [0, 1],
      poolVectors: [[1, 0]],
      expected: { match: 0, potential: 0, priority: "low" },
    },
    {
      id: "opposite-pool-vector-fills-gap",
      questionVector: [1, 0],
      profileAnchorVector: [1, 0],
      poolVectors: [[-1, 0]],
      expected: { match: 100, potential: 100, priority: "high" },
    },
    {
      id: "missing-question-vector-neutral-degradation",
      questionVector: null,
      profileAnchorVector: [1, 0],
      poolVectors: [[1, 0]],
      expected: { match: 50, potential: 50, priority: "medium" },
    },
  ],
  channelPathMerge: {
    hits: [
      { resourceId: 1, kind: "media", name: "甲媒体", path: "passive" },
      { resourceId: 1, kind: "media", name: "甲媒体", path: "active" },
      { resourceId: 1, kind: "media", name: "甲媒体", path: "passive" },
      { resourceId: 2, kind: "we-media", name: "乙自媒体", path: "fallback" },
      { resourceId: 2, kind: "we-media", name: "乙自媒体", path: "preference" },
      { resourceId: 3, kind: "media", name: "z-channel", path: "passive" },
      { resourceId: 9, kind: "media", name: "a-channel", path: "passive" },
    ],
    expected: [
      {
        resourceId: 1,
        kind: "media",
        name: "甲媒体",
        pathHits: ["passive", "active"],
        hitCount: 2,
        score: 0.6000000000000001,
      },
      {
        resourceId: 2,
        kind: "we-media",
        name: "乙自媒体",
        pathHits: ["fallback", "preference"],
        hitCount: 2,
        score: 0.4,
      },
      {
        resourceId: 3,
        kind: "media",
        name: "z-channel",
        pathHits: ["passive"],
        hitCount: 1,
        score: 0.4,
      },
      {
        resourceId: 9,
        kind: "media",
        name: "a-channel",
        pathHits: ["passive"],
        hitCount: 1,
        score: 0.4,
      },
    ],
  },
  contentTypeCoverage: [
    {
      id: "small-batch-one-per-type",
      input: [
        { topicId: "t1", types: ["guide"] },
        { topicId: "t2", types: ["guide"] },
      ],
      expected: [
        { topicId: "t1", types: ["guide", "showcase", "news"] },
        { topicId: "t2", types: ["guide", "ranking", "news_light"] },
      ],
    },
    {
      id: "large-batch-two-per-type",
      input: [
        { topicId: "t1", types: ["guide"] },
        { topicId: "t2", types: ["guide"] },
        { topicId: "t3", types: ["guide"] },
        { topicId: "t4", types: ["guide"] },
        { topicId: "t5", types: ["guide"] },
      ],
      expected: [
        { topicId: "t1", types: ["guide", "showcase", "news"] },
        { topicId: "t2", types: ["guide", "showcase", "news_light"] },
        { topicId: "t3", types: ["guide", "ranking", "news_light"] },
        { topicId: "t4", types: ["guide", "ranking"] },
        { topicId: "t5", types: ["guide", "news"] },
      ],
    },
  ],
  articleStateTransitions: [
    {
      id: "incomplete-profile-parks-for-confirmation",
      status: "planned",
      guards: { profileIncomplete: true },
      expected: {
        nextStatus: "pending_confirmation",
        smallPlan: {
          migrationPoint: "material_to_facts",
          plannerRole: "evidence-planner",
        },
      },
    },
    {
      id: "confirmed-profile-enters-question-construction",
      status: "pending_confirmation",
      guards: { profileConfirmed: true },
      expected: {
        nextStatus: "drafting",
        smallPlan: {
          migrationPoint: "question_construction",
          plannerRole: "question-construction-planner",
        },
      },
    },
    {
      id: "generated-draft-parks-before-review",
      status: "drafting",
      guards: {},
      expected: {
        nextStatus: "draft_ready",
        smallPlan: {
          migrationPoint: "content_production",
          plannerRole: "content-production-planner",
        },
      },
    },
    {
      id: "draft-confirmation-does-not-regenerate-body",
      status: "draft_ready",
      guards: { draftApproved: true },
      expected: { nextStatus: "reviewing" },
    },
    {
      id: "risk-block-preempts-clean-fact-review",
      status: "reviewing",
      guards: { riskBlocked: true, factClear: true },
      expected: { nextStatus: "rejected" },
    },
    {
      id: "fix-required-review-parks",
      status: "reviewing",
      guards: { riskBlocked: false, factClear: false },
      expected: { nextStatus: "reviewing" },
    },
    {
      id: "channel-assignment-parks-without-confirmation",
      status: "assigning",
      guards: {},
      expected: { nextStatus: "assigning" },
    },
    {
      id: "confirmed-assignment-runs-pure-distribution-planner",
      status: "assigning",
      guards: { assignmentConfirmed: true },
      expected: {
        nextStatus: "scheduling",
        smallPlan: {
          migrationPoint: "channel_recommendation",
          plannerRole: "pure-distribution-planner",
        },
      },
    },
    {
      id: "distribution-plan-parks-before-paid-order-confirmation",
      status: "scheduling",
      guards: {},
      expected: { nextStatus: "scheduling" },
    },
    {
      id: "confirmed-distribution-plan-enters-monitoring",
      status: "scheduling",
      guards: { distributionPlanConfirmed: true },
      expected: { nextStatus: "monitoring" },
    },
  ],
  publishing: {
    idempotencyKeys: [
      {
        articleId: "art_abc",
        resourceId: 42,
        expected: "article-art_abc-channel-42-v1",
      },
      {
        articleId: "art_abc",
        resourceId: 42,
        version: 2,
        expected: "article-art_abc-channel-42-v2",
      },
    ],
    payloadHash: {
      title: "标题",
      content: "# 内容",
      remark: "备注",
      expected:
        "b70587e869229ad9e4885177591d4b819ed8576c905193a63a32aeaf47a4999e",
    },
    idempotencyDecisions: [
      {
        id: "new-key-proceeds",
        existing: undefined,
        newPayloadHash: "hash-new",
        expected: { action: "proceed" },
      },
      {
        id: "same-key-same-payload-reuses-order",
        existing: { externalOrderId: "sn-123", payloadHash: "hash-same" },
        newPayloadHash: "hash-same",
        expected: { action: "skip", existingOrderId: "sn-123" },
      },
      {
        id: "same-key-different-payload-conflicts",
        existing: { externalOrderId: "sn-123", payloadHash: "hash-old" },
        newPayloadHash: "hash-new",
        expected: { action: "conflict", existingOrderId: "sn-123" },
      },
    ],
    retryBackoff: [
      { attempt: 0, expectedMs: 0 },
      { attempt: 1, expectedMs: 60_000 },
      { attempt: 2, expectedMs: 300_000 },
      { attempt: 3, expectedMs: 900_000 },
      { attempt: 5, expectedMs: 900_000 },
    ],
    schedule: [
      {
        id: "under-limit-publishes-now",
        now: [2026, 7, 31, 12, 0],
        channelDailyCount: 4,
        channelDailyLimit: 5,
        canWeekend: true,
        expected: [2026, 7, 31, 12, 0],
      },
      {
        id: "at-limit-schedules-next-day-0001",
        now: [2026, 7, 31, 12, 0],
        channelDailyCount: 5,
        channelDailyLimit: 5,
        canWeekend: true,
        expected: [2026, 8, 1, 0, 1],
      },
      {
        id: "at-limit-skips-weekend",
        now: [2026, 7, 31, 12, 0],
        channelDailyCount: 5,
        channelDailyLimit: 5,
        canWeekend: false,
        expected: [2026, 8, 3, 0, 1],
      },
    ],
  },
} as const;
