/**
 * Executable compatibility baseline for the js_ai GEO port.
 *
 * This module contains product and behavioural facts only. It deliberately has
 * no provider imports, filesystem access, environment reads, timers, or network
 * calls so every future GEO slice can depend on it from a credential-free unit
 * test.
 */

import { cnyToPoints } from "./points";
import { DEFAULT_DISTRIBUTION_SPEND_LIMITS } from "./distributionSpendLimits";

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
        "Hidden scheduling infrastructure that only wakes a referenced monitoring operation; it owns no GEO stage or artifact.",
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
      // GD-7 决策（用户已拍板，2026-08-17）：本产品有意融合此门——关键词在
      // question pool attempt 内部挖掘并立即消费，不设独立用户停止点；挖掘词
      // 全量展示在「关键词与问题池」卡片的搜索词区块，供确认问题时一并审阅。
      // 此注释即 js_ai 基线与本产品的差异说明，勿据此恢复独立闸门。
      xiaojingDivergence:
        "fused into question-pool generation; mined terms are displayed in the pool card instead of gating it",
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
      // 2026-08-28 用户裁决：权重自 0.4/0.3/0.15/0.15 调整——保底（垂类规则路）
      // 升至 0.3，主动降至 0.2，偏好降至 0.1；被动 0.4 不变。
      active: {
        number: 2,
        weight: 0.2,
        signal: "global-topic-channel-recommendation",
      },
      fallback: { number: 3, weight: 0.3, signal: "keyword-to-approved-pool" },
      preference: {
        number: 4,
        weight: 0.1,
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
      // 多租户平台（toutiao/douyin/xiaohongshu/bilibili/zhihu/weibo/kuaishou/
      // 公众号/百家号）上注册域名对任意账号/文章/频道页相同，域名相等不构成
      // 渠道对齐证据；这些平台只保留名称对齐（核心名包含匹配）。
      multiTenantDomainExempt: true,
    },
    passiveRecall: {
      oneIndependentSearchPerQuestion: true,
      // 按问题配额而非总截断（2026-08-27 用户裁决二轮）：每问最多 10 条引用，
      // 所有探测问题的引用全量返回（旧 totalCap=50 总量帽废除）；随后按
      // 「渠道（注册域名）出现在多少个不同问题」降序排展示顺序——跨问重复
      // 出现的渠道（多问交集）排前，单问独占渠道靠后。被动路对齐渠道列表
      // 上限 alignedChannelCap=50（按跨问覆盖>引用数排序），与全局推荐
      // 上限（recommendation.max=30）互不影响。
      perQuestionCap: 10,
      alignedChannelCap: 50,
      rankBy: "cross-question-registered-domain-frequency-desc",
      defaultMode: "ai_search",
    },
    // 账户级对齐（2026-08-27 用户裁决：多租户引用对齐到具体账号，三层解析、
    // 全部第一方、不依赖供应商账号字段）：L1 URL 内嵌账号标识 > L2 引用标题
    // 尾缀账号名（平台一致性门）> L3 引用页面作者解析（server 抓页注入，
    // 限量并发、失败静默降级到平台名）。注册域名相等永远不构成账户身份。
    accountResolution: {
      layer1: "url-embedded-account-id",
      layer2: "title-suffix-account-name-platform-gated",
      layer3: {
        pageAuthorFetch: {
          limit: 20,
          timeoutMs: 8_000,
          dedupeBy: "url",
          failure: "silent-degrade-to-platform-name",
        },
      },
    },
    // 引用站点显示名解析链（组名优先级；池反查=超级媒介资源 entranceLink
    // 域名→渠道名的动态映射，多租户域名因一域名多渠道不参与）。
    citationDisplayNameChain: [
      "doubao-site-name",
      "pool-domain-lookup",
      "brand-table",
      "title-suffix-site-name",
      "registered-domain",
    ],
    fallbackTopN: 50,
    geoInclusionHardFilterScope: "fallback-only",
    recommendation: {
      max: 30,
      mediaQuota: 20,
      weMediaQuota: 10,
      // 保底优先席位（2026-08-28 用户裁决改随机采样）：垂类池（t0∪t1）
      // 随机取满 fallbackVerticalQuota 席，单 GEO 池（t2）随机补足 max 内
      // 剩余席位；池尽回流整体排序，t3+ 不占保留席。随机避免固定渠道霸榜。
      fallbackVerticalQuota: 26,
      surplusFill: true,
      // 2026-08-28 用户裁决：排序链加入 junk 压制（随机号商品靠后）、垂类名
      // 命中（名称含行业/人群词优先，兑现「大渠道子频道尽量垂类」）与被动
      // 覆盖度（同分时覆盖问题多者优先，替代拼音序）。
      rank: [
        "weighted-path-score-desc",
        "hit-count-desc",
        "fallback-tier-asc",
        "junk-resale-last",
        "vertical-name-match-first",
        "passive-question-coverage-desc",
        "passive-citation-count-desc",
        "name-asc",
      ],
    },
    // 变体家族（2026-08-28 用户裁决 Q13）：池内同一渠道常被重复挂牌/多套餐
    // （列举网 7 变体、蓝色河畔 5 变体），大渠道下还有真实子频道（学习强国
    // 92 条）。两级结构：家族=核心名+主平台族（跨平台同名分家）；包=规格词
    // 尾块（数据驱动：后缀跨 ≥10 个不同核心名=通用规格词）或无尾块 → 默认包，
    // 身份词尾块按尾块值分子频道包。同包择 1 代表（非junk → 有证据 →
    // geo_platforms 多 → 价低 → id 小），家族 ≤2 席进推荐；展示按家族折叠。
    variantFamily: {
      familyKey: "stripped-core-plus-primary-platform-family",
      packKey: "qualifier-suffix-to-default-pack",
      qualifierSuffixCoreThreshold: 10,
      packRepresentative: [
        "non-junk-first",
        "evidence-weight-desc",
        "geo-platforms-desc",
        "price-asc",
        "resource-id-asc",
      ],
      familyQuota: 2,
      displayFold: "all-four-paths",
    },
    // 多租户名称匹配全分支核心名限定 + 平台官方型通道（2026-08-28 用户裁决
    // Q1/Q3a）：多租户来源的全部名称分支（子串/去后缀/Jaccard）只比对核心名，
    // 括号后缀里的平台词永不算名字证据；平台级来源只经官方型通道命中
    // 「entrance 根路径 ∧ 域名族 ∧ 核心名含平台品牌」的资源（全池 ~89 条），
    // 账号渠道永不承接平台级信号。资源平台族第一信号=媒介盒子 platform
    // 枚举（自媒体 100% 携带，与域名一致率实测 99.3%）。
    multiTenantNameMatching: {
      nameScope: "channel-name-core-all-branches",
      platformFamilySource: [
        "provider-platform-enum",
        "entrance-domain",
        "name-suffix-alias",
      ],
      platformOfficialGate: "root-entrance-and-brand-in-core",
    },
    // 主动路名称匹配收严（2026-08-28 用户裁决：「只要真正正确的渠道」）：
    // Jaccard 字符交集档整体退出主动路（残留误配实测：中国团餐网→中国妈妈网
    // 0.5、今日头条美食频道→美妆头条 0.4——字符有交集但完全不同机构）；
    // 只认 包含关系（1.0/0.8）+ 共享前缀 ≥4 字（界面新闻主站↔界面新闻消费
    // 板块）+ 品牌分支强重叠/非多租户品牌兜底（36氪→36氪（百家号））。
    // 域名相等与平台官方型通道不变。fuzzyMatchScore（含 Jaccard）保留给
    // 偏好路用户手输条目（人工输入需要容错）。
    // 池侧域名信号（2026-08-28 用户裁决：URL 字段参与匹配）：entrance_link +
    // case_link（收录案例链接）双 URL 的注册域名，多租户域剔除。case_link 全池
    // 100% 有值、98.3% 与 entrance 同域、16,107 条独立域；7,599 条资源 entrance
    // 为空时它是唯一域名信号（八方资源网型）。主动/被动域名对齐与池反查共用。
    resourceDomainSignals: ["entrance-link", "case-link"],
    // 域名歧义防护：域名下核心名经包含关系全连通=唯一域（实测 6,131/7,135），
    // 域名命中直接放行；歧义域（ppwll.cn 式跨机构聚合域，1,004 个）要求名称
    // 佐证（主动 activeNameMatchScore≥0.8 / 被动平台门控 nameMatches），
    // 宁可放弃无佐证的真匹配也不放行跨机构误判。
    activeNameMatching: {
      minScore: 0.8,
      jaccardTiers: "excluded",
      prefixRule: "shared-prefix-gte-4-chars",
    },
    // 随机号商品压制（2026-08-28 用户裁决 Q11）：名称含 随机/打包/千粉/百粉/
    // 水军/套餐N家 的转售商品（全池 211 条）不剔除、可对齐可展示，但排序
    // 靠后且不作包/家族代表（除非全组皆 junk）。`包收录` 是正规特性不算。
    junkResaleSuppression: {
      pattern: "随机|打包|千粉|百粉|水军|套餐N家|N家媒体",
      action: "sort-last-and-never-representative",
    },
    // 偏好匹配与命中清单（2026-08-28 用户裁决 Q12）：exact 语义=核心名相等
    // （池子挂牌名后缀漂移不再静默断链）；命中清单在推荐配额之前按名单逐项
    // 计算（每项一行代表：全名逐字命中者优先，否则包代表规则），随投影落库
    // ——旧「从推荐集反推」口径下偏好 0.15 权重永远进不了 top30、面板恒显 0。
    preferenceMatching: {
      exactSemantics: "core-name-equality",
      matchedListProjection: "preferenceMatchedChannels",
      matchedListScope: "pre-quota",
    },
    quality: {
      // 发布率不是决策输入（用户裁决 2026-08-18）：无最低发布率门槛，
      // 发布率未知也不过滤、不阻断确认；价格按用户点数上限过滤。
      defaultPerArticleMaxPoints:
        DEFAULT_DISTRIBUTION_SPEND_LIMITS.perArticleMaxPoints,
      defaultPerExecutionMaxPoints:
        DEFAULT_DISTRIBUTION_SPEND_LIMITS.perExecutionMaxPoints,
      limitSource: "user-setting-snapshotted-on-plan",
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
      question_pool: ["volcengine", "doubao-seed-2-0-lite-260428"],
      title: ["volcengine", "doubao-seed-2-0-lite-260428"],
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
    "scheduler-owned-geo-state",
  ],
} as const;

function clampGeoScore(value: number): number {
  const finiteValue = Number.isFinite(value) ? value : 50;
  return Math.max(0, Math.min(100, Math.round(finiteValue)));
}

export function geoCosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
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

/**
 * Public PRED-1 reference seam matching js_ai's scoreCandidates behavior.
 * Missing candidate vectors degrade to neutral 50/50 instead of failing the
 * whole question batch.
 */
export function scoreGeoQuestionCandidate(input: {
  questionVector: readonly number[] | null;
  profileAnchorVector: readonly number[] | null;
  poolVectors: readonly (readonly number[])[];
}): { match: number; potential: number; priority: "high" | "medium" | "low" } {
  if (!input.questionVector) {
    return { match: 50, potential: 50, priority: "medium" };
  }

  const match = input.profileAnchorVector
    ? scoreGeoQuestionMatch(
        geoCosineSimilarity(input.questionVector, input.profileAnchorVector),
      )
    : 50;
  let nearestPoolSimilarity = 0;
  if (input.poolVectors.length > 0) {
    nearestPoolSimilarity = -1;
    for (const poolVector of input.poolVectors) {
      nearestPoolSimilarity = Math.max(
        nearestPoolSimilarity,
        geoCosineSimilarity(input.questionVector, poolVector),
      );
    }
  }
  const potential = scoreGeoQuestionPotential(nearestPoolSimilarity);
  return {
    match,
    potential,
    priority: classifyGeoQuestionPriority(match, potential),
  };
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

/** Mirrors the pre-alignment channel hard filter. Published rate is not a
 * decision input anywhere (user ruling 2026-08-18); the price is converted to
 * points and compared with the user-owned per-article cap. */
export function isGeoChannelQualityEligible(input: {
  price?: string | null;
  perArticleMaxPoints?: number;
}): boolean {
  const quality = GEO_PORT_CONTRACT.channelRecall.quality;
  if (input.price == null || input.price.trim() === "") return false;
  const numericPrice = Number(input.price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) return false;
  return (
    cnyToPoints(numericPrice) <=
    (input.perArticleMaxPoints ?? quality.defaultPerArticleMaxPoints)
  );
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

export type GeoRecallPath = "passive" | "active" | "fallback" | "preference";
export type GeoChannelKind = "media" | "we-media";
export type GeoContentType = (typeof GEO_PORT_CONTRACT.contentTypes)[number];
export type GeoArticleStatus =
  | (typeof GEO_PORT_CONTRACT.articleLifecycle.primaryPath)[number]
  | (typeof GEO_PORT_CONTRACT.articleLifecycle.exceptionStates)[number];

type GeoMigrationPoint = keyof typeof GEO_PORT_CONTRACT.migrationPlanners;
export type GeoArticleGuard =
  | "profileIncomplete"
  | "generationFailed"
  | "draftApproved"
  | "riskBlocked"
  | "factClear"
  | "retryReview"
  | "assignmentConfirmed"
  | "distributionPlanConfirmed"
  | "profileConfirmed"
  | "retryGeneration"
  | "retryAfterRejection";

const GEO_ARTICLE_TRANSITIONS: readonly {
  from: GeoArticleStatus;
  to: GeoArticleStatus;
  migrationPoint?: GeoMigrationPoint;
  guard?: GeoArticleGuard;
}[] = [
  {
    from: "planned",
    to: "pending_confirmation",
    migrationPoint: "material_to_facts",
    guard: "profileIncomplete",
  },
  {
    from: "planned",
    to: "drafting",
    migrationPoint: "question_construction",
  },
  { from: "drafting", to: "generation_failed", guard: "generationFailed" },
  {
    from: "drafting",
    to: "draft_ready",
    migrationPoint: "content_production",
  },
  {
    from: "draft_ready",
    to: "generation_failed",
    guard: "generationFailed",
  },
  { from: "draft_ready", to: "reviewing", guard: "draftApproved" },
  {
    from: "reviewing",
    to: "rejected",
    migrationPoint: "review",
    guard: "riskBlocked",
  },
  {
    from: "reviewing",
    to: "approved",
    migrationPoint: "review",
    guard: "factClear",
  },
  {
    from: "reviewing",
    to: "drafting",
    migrationPoint: "content_production",
    guard: "retryReview",
  },
  { from: "approved", to: "published", migrationPoint: "publish" },
  { from: "published", to: "assigning" },
  {
    from: "assigning",
    to: "scheduling",
    migrationPoint: "channel_recommendation",
    guard: "assignmentConfirmed",
  },
  {
    from: "scheduling",
    to: "monitoring",
    guard: "distributionPlanConfirmed",
  },
  { from: "monitoring", to: "done" },
  {
    from: "pending_confirmation",
    to: "drafting",
    migrationPoint: "question_construction",
    guard: "profileConfirmed",
  },
  {
    from: "generation_failed",
    to: "drafting",
    migrationPoint: "content_production",
    guard: "retryGeneration",
  },
  {
    from: "rejected",
    to: "drafting",
    migrationPoint: "content_production",
    guard: "retryAfterRejection",
  },
] as const;

/** Pure article lifecycle oracle. A missing/false guard always parks. */
export function migrateGeoArticleState(
  status: GeoArticleStatus,
  guards: Readonly<Partial<Record<GeoArticleGuard, boolean>>>,
): {
  nextStatus: GeoArticleStatus;
  smallPlan?: { migrationPoint: GeoMigrationPoint; plannerRole: string };
} {
  for (const transition of GEO_ARTICLE_TRANSITIONS) {
    if (transition.from !== status) continue;
    if (transition.guard && guards[transition.guard] !== true) continue;

    const plannerRole = transition.migrationPoint
      ? GEO_PORT_CONTRACT.migrationPlanners[transition.migrationPoint]
      : null;
    return {
      nextStatus: transition.to,
      ...(transition.migrationPoint && plannerRole
        ? {
            smallPlan: {
              migrationPoint: transition.migrationPoint,
              plannerRole,
            },
          }
        : {}),
    };
  }
  return { nextStatus: status };
}

/** Deterministic key for exactly one article/channel/version publication. */
export function buildGeoPublishIdempotencyKey(
  articleId: string,
  resourceId: number,
  version: number | string = GEO_PORT_CONTRACT.publishing
    .defaultIdempotencyVersion,
): string {
  return `article-${articleId}-channel-${resourceId}-v${version}`;
}

/** SHA-256 of the canonical title|content|remark payload used for dedup. */
export async function computeGeoPublishPayloadHash(
  title: string,
  content: string,
  remark = "",
): Promise<string> {
  const payload = new TextEncoder().encode(`${title}|${content}|${remark}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Same-key order dedup: reuse identical payloads and fail closed on drift. */
export function decideGeoIdempotentOrder(
  existing:
    | { externalOrderId?: string | null; payloadHash?: string | null }
    | undefined,
  newPayloadHash: string,
):
  | { action: "proceed" }
  | { action: "skip"; existingOrderId: string }
  | { action: "conflict"; existingOrderId: string } {
  if (!existing) return { action: "proceed" };
  const existingOrderId = existing.externalOrderId ?? "";
  if (existing.payloadHash === newPayloadHash) {
    return { action: "skip", existingOrderId };
  }
  return { action: "conflict", existingOrderId };
}

/** Fixed 1/5/15 minute retry policy, capped after the third retry. */
export function geoPublishRetryBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  const delays = GEO_PORT_CONTRACT.publishing.retryBackoffMs;
  return delays[Math.min(Math.floor(attempt), delays.length) - 1];
}

/** Local-calendar scheduling parity for the js_ai publish planner. */
export function computeGeoNextPublishAt(input: {
  nowMs: number;
  channelDailyCount: number;
  channelDailyLimit: number;
  canWeekend: boolean;
}): number {
  if (input.channelDailyCount < input.channelDailyLimit) {
    return Math.floor(input.nowMs / 1000);
  }

  const now = new Date(input.nowMs);
  let next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    1,
    0,
    0,
  );
  while (!input.canWeekend && (next.getDay() === 0 || next.getDay() === 6)) {
    next = new Date(
      next.getFullYear(),
      next.getMonth(),
      next.getDate() + 1,
      0,
      1,
      0,
      0,
    );
  }
  return Math.floor(next.getTime() / 1000);
}

/**
 * 整批内容类型覆盖下限（用户裁决 2026-08-26）：guide 与 ranking 各至少 3
 * 篇、其余类型各至少 2 篇，合计至少 12 篇。主题过少导致结构上限（每主题
 * 最多 5 类）放不下时按现有规则尽力补齐，不失败。
 */
export const GEO_CONTENT_TYPE_COVERAGE_MINIMUMS: Record<
  GeoContentType,
  number
> = {
  guide: 3,
  showcase: 2,
  ranking: 3,
  news: 2,
  news_light: 2,
};

/**
 * Pure coverage floor: backfills each content type up to
 * GEO_CONTENT_TYPE_COVERAGE_MINIMUMS (guide/ranking 3, others 2; 12 items in
 * total) without mutating caller input.
 */
export function enforceGeoContentTypeCoverage(
  recommendations: readonly {
    topicId: string;
    types: readonly GeoContentType[];
  }[],
): Array<{ topicId: string; types: GeoContentType[] }> {
  const result = recommendations.map((recommendation) => ({
    topicId: recommendation.topicId,
    types: [...recommendation.types],
  }));

  for (const contentType of GEO_PORT_CONTRACT.contentTypes) {
    let needed =
      GEO_CONTENT_TYPE_COVERAGE_MINIMUMS[contentType] -
      result.filter((recommendation) =>
        recommendation.types.includes(contentType),
      ).length;
    while (needed > 0) {
      const recipient = result
        .filter(
          (recommendation) =>
            !recommendation.types.includes(contentType) &&
            recommendation.types.length < GEO_PORT_CONTRACT.contentTypes.length,
        )
        .sort((left, right) => left.types.length - right.types.length)[0];
      if (!recipient) break;
      recipient.types.push(contentType);
      needed -= 1;
    }
  }

  return result;
}

/** Pure four-path union used as the parity oracle for ported channel recall. */
export function mergeGeoChannelPathHits(
  hits: readonly {
    resourceId: number;
    kind: GeoChannelKind;
    name: string;
    path: GeoRecallPath;
  }[],
): Array<{
  resourceId: number;
  kind: GeoChannelKind;
  name: string;
  pathHits: GeoRecallPath[];
  hitCount: number;
  score: number;
}> {
  const weights = GEO_PORT_CONTRACT.channelRecall.paths;
  const byResourceId = new Map<
    number,
    {
      resourceId: number;
      kind: GeoChannelKind;
      name: string;
      pathHits: GeoRecallPath[];
      hitCount: number;
      score: number;
    }
  >();

  for (const hit of hits) {
    const existing = byResourceId.get(hit.resourceId);
    if (existing) {
      if (!existing.pathHits.includes(hit.path)) {
        existing.pathHits.push(hit.path);
        existing.hitCount = existing.pathHits.length;
        // toFixed(10) 归一与 buildDistributionCandidates 同口径，避免 0.2+0.4 浮点尾差。
        existing.score = Number(
          (existing.score + weights[hit.path].weight).toFixed(10),
        );
      }
      continue;
    }
    byResourceId.set(hit.resourceId, {
      resourceId: hit.resourceId,
      kind: hit.kind,
      name: hit.name,
      pathHits: [hit.path],
      hitCount: 1,
      score: weights[hit.path].weight,
    });
  }

  return [...byResourceId.values()].sort(
    (left, right) =>
      right.score - left.score ||
      right.hitCount - left.hitCount ||
      left.resourceId - right.resourceId,
  );
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
