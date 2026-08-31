import {
  GEO_CONTENT_TYPE_COVERAGE_MINIMUMS,
  GEO_PORT_CONTRACT,
  enforceGeoContentTypeCoverage,
  geoCosineSimilarity,
  type GeoContentType,
} from "./portContract";

export const TOPIC_PLAN_POLICY_VERSION = "xiaojing-content-prompt-v3";
export const TOPIC_PLAN_MAX_ITEMS = 50;
export const TOPIC_PLAN_MAX_CONFIRMED_ITEMS = 20;
export const TOPIC_PLAN_TITLE_BATCH_SIZE = 3;
export const TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD = 0.92;

export const TOPIC_PLAN_SEARCH_INTENTS = [
  "informational",
  "commercial-investigation",
  "transactional",
  "local",
] as const;

export type TopicPlanSearchIntent =
  (typeof TOPIC_PLAN_SEARCH_INTENTS)[number];

export interface TopicPlanSourceQuestion {
  id: string;
  text: string;
}

export interface TopicPlanKnowledgeFact {
  factKey: string;
  predicate: string;
  normalizedValueJson: string;
}

/**
 * 卡片/工具结果信封里的瘦身事实：只保留卡片展示与 saveItems 校验真正
 * 消费的 predicate。factKey 是「JSON 字符串当主键」（~130 字节/条且在
 * 嵌套 JSON 里层层转义），曾是信封体积与日志可读性的最大污染源——
 * 服务端按 predicate 回解到库内 factKey，完整值以 SQLite 为权威。
 */
export interface TopicPlanCardFact {
  predicate: string;
}

export type TopicPlanWireFact = TopicPlanKnowledgeFact | TopicPlanCardFact;

/**
 * 信封/回传层计划项：审计字段（titleRationale/titleCandidates）与事实
 * 详情可缺省。完整 TopicPlanItem 结构上满足本类型；服务端合并时缺失字
 * 段一律以库内当前值为准。
 */
export type TopicPlanWireItem = Omit<
  TopicPlanItem,
  "plannedFacts" | "titleRationale" | "titleCandidates"
> & {
  plannedFacts: readonly TopicPlanWireFact[];
  titleRationale?: TopicPlanTitleRationale;
  titleCandidates?: string[];
};

/**
 * plan_topics 工具结果信封专用投影项：完整信封曾达 ~81KB，超过 MCP
 * 工具结果上限被 MCP 宿主客户端持久化成文件，确认卡随 tool.result
 * 存根一起消失（卡片不渲染）。瘦身后同级计划 ~29KB。
 */
export type TopicPlanCardItem = Omit<
  TopicPlanItem,
  "plannedFacts" | "titleRationale" | "titleCandidates"
> & {
  plannedFacts: readonly TopicPlanCardFact[];
};

export interface TopicPlanTopic {
  id: string;
  name: string;
  summary: string;
  questionIds: string[];
  searchIntent: TopicPlanSearchIntent;
  namingReason: string;
}

export interface TopicPlanTitleRationale {
  questionCoverage: string;
  searchIntent: string;
  differentiation: string;
  brandFit: string;
  chinaMarketExpression: string;
}

export interface TopicPlanDeduplicationEvidence {
  method: "embedding" | "not-evaluated-user-override";
  comparedItemIds: string[];
  maxSimilarity: number | null;
  threshold: number;
}

export interface TopicPlanItem {
  id: string;
  topicId: string;
  sourceQuestionIds: string[];
  contentType: GeoContentType;
  typeSelectionReason: string;
  title: string;
  titleCandidates: string[];
  titleRationale: TopicPlanTitleRationale;
  plannedFacts: TopicPlanKnowledgeFact[];
  deduplication: TopicPlanDeduplicationEvidence;
  userEdited: boolean;
  approvalStatus: "draft" | "approved";
  origin: "model" | "user";
}

export interface TopicPlanProjection {
  id: string;
  operationId: string;
  workspaceId: string;
  questionPoolId: string;
  questionPoolRevision: number;
  knowledgeVersion: number;
  productLine: string;
  targetRegion: string;
  policyVersion: typeof TOPIC_PLAN_POLICY_VERSION;
  status: "awaiting-confirmation" | "confirmed";
  revision: number;
  topics: TopicPlanTopic[];
  items: TopicPlanItem[];
  selectedItemIds: string[];
  modelAudit: {
    clustering: "embedding+generation-llm";
    naming: "generation-llm";
    typeRecommendation: "generation-llm";
    titleGeneration: "generation-llm";
    titleDeduplication: "embedding";
  };
  providerSnapshot: {
    generation: {
      provider: "volcengine";
      capabilitySlot: "generation";
      model: string;
    };
    titlePlanning: {
      provider: "volcengine";
      capabilitySlot: "generation";
      model: string;
    };
    embedding: {
      provider: "volcengine";
      capabilitySlot: "embedding";
      modelFamily: "doubao-embedding-vision";
      dimensions: number;
    };
    policyVersion: typeof TOPIC_PLAN_POLICY_VERSION;
  };
  modelAttempts: TopicPlanModelAttempt[];
  reused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TopicPlanModelAttempt {
  stage:
    | "question-embedding"
    | "topic-clustering"
    | "type-recommendation"
    | "topic-fact-embedding"
    | "title-generation"
    | "title-deduplication-embedding";
  provider: "volcengine";
  capabilitySlot: "generation" | "embedding";
  model: string;
  status: "success";
  itemId?: string;
  inputCount?: number;
}

/** plan_topics 工具结果信封的卡片投影（items 为瘦身项）。 */
export interface TopicPlanCardProjection extends Omit<TopicPlanProjection, "items"> {
  items: TopicPlanCardItem[];
}

/** 完整投影 → 信封瘦身投影：剔除每项的 titleRationale、titleCandidates
 * 与事实的全部载体字段（factKey/normalizedValueJson/scopeJson/subject），
 * 事实只剩 predicate。卡片与 saveItems 校验消费的字段全部保留；被剔除
 * 字段的权威值在 SQLite，合并时服务端回填/按 predicate 回解。 */
export function toTopicPlanCardProjection(plan: TopicPlanProjection): TopicPlanCardProjection {
  return {
    ...plan,
    items: plan.items.map(({ titleRationale: _r, titleCandidates: _c, ...item }) => ({
      ...item,
      plannedFacts: item.plannedFacts.map((fact) => ({
        predicate: fact.predicate,
      })),
    })),
  };
}

export interface TopicPlanMutationResult {
  plan: TopicPlanProjection;
  mutationId: string;
  preservedItemIds: string[];
}

export interface TopicPlanConfirmation {
  planId: string;
  decisionId: string;
  expectedRevision: number;
  revision: number;
  questionPoolId: string;
  questionPoolRevision: number;
  knowledgeVersion: number;
  selectedItemIds: string[];
  actorId: "desktop-user";
  decidedAt: string;
}

export interface TopicPlanSemanticHint {
  questionId: string;
  neighborQuestionId: string;
  cosineSimilarity: number;
}

function parseJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  for (const payload of [withoutFence, trimmed]) {
    try {
      return JSON.parse(payload);
    } catch {
      const starts = [payload.indexOf("["), payload.indexOf("{")].filter(
        (index) => index >= 0,
      );
      const start = starts.length > 0 ? Math.min(...starts) : -1;
      const end = Math.max(payload.lastIndexOf("]"), payload.lastIndexOf("}"));
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(payload.slice(start, end + 1));
        } catch {
          // Try the next representation before failing closed.
        }
      }
    }
  }
  return null;
}

function nonEmptyString(value: unknown, max = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > max) return null;
  return normalized;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((candidate) => nonEmptyString(candidate))
        .filter((candidate): candidate is string => candidate !== null),
    ),
  ];
}

export function buildTopicSemanticHints(
  questions: readonly TopicPlanSourceQuestion[],
  vectors: readonly (readonly number[])[],
  neighborsPerQuestion = 2,
): TopicPlanSemanticHint[] {
  if (vectors.length !== questions.length) {
    throw new Error("topic_plan_embedding_count_invalid");
  }
  const hints: TopicPlanSemanticHint[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const neighbors = questions
      .map((question, neighborIndex) => ({
        questionId: question.id,
        neighborIndex,
        cosineSimilarity:
          neighborIndex === index
            ? Number.NEGATIVE_INFINITY
            : geoCosineSimilarity(vectors[index], vectors[neighborIndex]),
      }))
      .filter((candidate) => candidate.neighborIndex !== index)
      .sort(
        (left, right) =>
          right.cosineSimilarity - left.cosineSimilarity ||
          left.neighborIndex - right.neighborIndex,
      )
      .slice(0, Math.max(0, neighborsPerQuestion));
    for (const neighbor of neighbors) {
      hints.push({
        questionId: questions[index].id,
        neighborQuestionId: neighbor.questionId,
        cosineSimilarity: Number(neighbor.cosineSimilarity.toFixed(6)),
      });
    }
  }
  return hints;
}

export function buildTopicClusteringPrompt(input: {
  brandName: string;
  industry: string;
  productLine: string;
  targetRegion: string;
  questions: readonly TopicPlanSourceQuestion[];
  semanticHints: readonly TopicPlanSemanticHint[];
}): string {
  return [
    "你是一位 GEO 内容策略专家，精通中国用户搜索意图与语义聚类。",
    "请结合问题原文和真实 Embedding 相似度提示，把语义焦点相同的问题归组，并为每组命名。",
    "相似度只是语义证据，不是字符串规则；最终必须按搜索意图判断，不能把价格、证件、选型等不同意图强行合并。",
    "每个输入 questionId 必须且只能出现一次；单独问题可以独立成组，但仍须由你命名并解释。",
    "searchIntent 只能是 informational、commercial-investigation、transactional、local。",
    '只返回 JSON 数组：[{"questionIds":["q1"],"name":"简洁主题名","summary":"综合主题句","searchIntent":"informational","reason":"聚类和命名原因"}]',
    `品牌：${input.brandName}`,
    `行业：${input.industry}`,
    `产品线：${input.productLine}`,
    `目标地域：${input.targetRegion}`,
    "问题：",
    ...input.questions.map(
      (question, index) => `${index + 1}. [${question.id}] ${question.text}`,
    ),
    "Embedding 近邻提示：",
    ...(input.semanticHints.length > 0
      ? input.semanticHints.map(
          (hint) =>
            `${hint.questionId} -> ${hint.neighborQuestionId}: ${hint.cosineSimilarity}`,
        )
      : ["没有可用近邻；不得用字符串拼接冒充语义聚类。"]),
  ].join("\n");
}

export function parseTopicClusters(
  raw: string,
  questions: readonly TopicPlanSourceQuestion[],
): TopicPlanTopic[] {
  const payload = parseJsonPayload(raw);
  if (!Array.isArray(payload)) throw new Error("topic_plan_clusters_invalid");
  const allowedIds = new Set(questions.map((question) => question.id));
  const seenIds = new Set<string>();
  const topics: TopicPlanTopic[] = [];
  for (const value of payload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("topic_plan_cluster_invalid");
    }
    const holder = value as Record<string, unknown>;
    const questionIds = uniqueStrings(holder.questionIds);
    const name = nonEmptyString(holder.name, 80);
    const summary = nonEmptyString(holder.summary, 500);
    const namingReason = nonEmptyString(holder.reason, 500);
    const searchIntent = holder.searchIntent;
    if (
      questionIds.length === 0 ||
      !name ||
      !summary ||
      !namingReason ||
      !TOPIC_PLAN_SEARCH_INTENTS.includes(searchIntent as TopicPlanSearchIntent)
    ) {
      throw new Error("topic_plan_cluster_invalid");
    }
    for (const questionId of questionIds) {
      if (!allowedIds.has(questionId) || seenIds.has(questionId)) {
        throw new Error("topic_plan_question_assignment_invalid");
      }
      seenIds.add(questionId);
    }
    topics.push({
      id: `topic-${topics.length + 1}`,
      name,
      summary,
      questionIds,
      searchIntent: searchIntent as TopicPlanSearchIntent,
      namingReason,
    });
  }
  if (
    topics.length === 0 ||
    seenIds.size !== allowedIds.size ||
    [...allowedIds].some((questionId) => !seenIds.has(questionId))
  ) {
    throw new Error("topic_plan_question_coverage_incomplete");
  }
  return topics;
}

export function buildTypeRecommendationPrompt(input: {
  brandName: string;
  industry: string;
  productLine: string;
  targetRegion: string;
  topics: readonly TopicPlanTopic[];
}): string {
  return [
    "你是一位 GEO 内容策略专家。为每个语义主题推荐 1–5 个内容类型，并逐类型解释选择原因。",
    "五类只能是 guide、showcase、ranking、news、news_light。",
    `整批覆盖下限（2026-08-26 裁定）：guide 与 ranking 各至少 ${GEO_CONTENT_TYPE_COVERAGE_MINIMUMS.guide} 篇，showcase、news、news_light 各至少 ${GEO_CONTENT_TYPE_COVERAGE_MINIMUMS.showcase} 篇，合计至少 ${Object.values(GEO_CONTENT_TYPE_COVERAGE_MINIMUMS).reduce((sum, minimum) => sum + minimum, 0)} 篇；推荐时优先按此下限安排，不满足时系统会确定性补齐。`,
    "guide=痛点科普/怎么选/怎么做；showcase=品牌详情/服务/卖点；ranking=对比/清单/哪家好；news=事件或行业变化深度报道；news_light=便民或服务升级轻新闻。",
    '只返回 JSON 数组：[{"topicId":"topic-1","recommendations":[{"type":"guide","reason":"为什么适合该主题"}]}]',
    `品牌：${input.brandName}`,
    `行业：${input.industry}`,
    `产品线：${input.productLine}`,
    `目标地域：${input.targetRegion}`,
    ...input.topics.map(
      (topic) =>
        `[${topic.id}] ${topic.name}｜${topic.summary}｜搜索意图 ${topic.searchIntent}`,
    ),
  ].join("\n");
}

export interface TopicPlanTypeRecommendation {
  topicId: string;
  types: GeoContentType[];
  reasons: Partial<Record<GeoContentType, string>>;
}

function contentType(value: unknown): GeoContentType | null {
  return GEO_PORT_CONTRACT.contentTypes.includes(value as GeoContentType)
    ? (value as GeoContentType)
    : null;
}

export function parseAndEnforceTypeRecommendations(
  raw: string,
  topics: readonly TopicPlanTopic[],
): TopicPlanTypeRecommendation[] {
  const payload = parseJsonPayload(raw);
  if (!Array.isArray(payload)) {
    throw new Error("topic_plan_type_recommendations_invalid");
  }
  const parsed = new Map<string, TopicPlanTypeRecommendation>();
  for (const value of payload) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const holder = value as Record<string, unknown>;
    const topicId = nonEmptyString(holder.topicId, 100);
    if (!topicId || !Array.isArray(holder.recommendations)) continue;
    const types: GeoContentType[] = [];
    const reasons: Partial<Record<GeoContentType, string>> = {};
    for (const recommendation of holder.recommendations) {
      if (
        !recommendation ||
        typeof recommendation !== "object" ||
        Array.isArray(recommendation)
      ) {
        continue;
      }
      const entry = recommendation as Record<string, unknown>;
      const type = contentType(entry.type);
      const reason = nonEmptyString(entry.reason, 500);
      if (!type || !reason || types.includes(type)) continue;
      types.push(type);
      reasons[type] = reason;
      if (types.length >= GEO_PORT_CONTRACT.contentTypes.length) break;
    }
    if (types.length > 0) parsed.set(topicId, { topicId, types, reasons });
  }
  if (
    parsed.size !== topics.length ||
    topics.some((topic) => !parsed.has(topic.id))
  ) {
    throw new Error("topic_plan_type_recommendation_coverage_incomplete");
  }
  const ordered = topics.map((topic) => parsed.get(topic.id)!);
  const covered = enforceGeoContentTypeCoverage(ordered);
  return covered.map((entry) => {
    const original = parsed.get(entry.topicId)!;
    const topic = topics.find((candidate) => candidate.id === entry.topicId)!;
    const reasons = { ...original.reasons };
    for (const type of entry.types) {
      reasons[type] ??=
        `五类内容覆盖下限补齐：${topic.name}可用${type}角度覆盖${topic.searchIntent}搜索意图。`;
    }
    return { ...entry, reasons };
  });
}

export function selectPlannedFacts(input: {
  topic: TopicPlanTopic;
  topicVector: readonly number[];
  facts: readonly TopicPlanKnowledgeFact[];
  factVectors: readonly (readonly number[])[];
  limit?: number;
}): TopicPlanKnowledgeFact[] {
  if (input.facts.length !== input.factVectors.length) {
    throw new Error("topic_plan_fact_embedding_count_invalid");
  }
  return input.facts
    .map((fact, index) => ({
      fact,
      index,
      score: geoCosineSimilarity(input.topicVector, input.factVectors[index]),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, input.limit ?? 5))
    .map(({ fact }) => fact);
}

/**
 * 语义 Top-N 决定一般素材；内容类型的硬事实不参与名额竞争。ranking 必须把
 * 已确认竞品事实钉回计划，否则竞品在相似度第 6 名时会从 immutable
 * plannedFacts 消失，正文阶段无法恢复。
 */
export function selectContentTypePlannedFacts(
  contentType: GeoContentType,
  selectedFacts: readonly TopicPlanKnowledgeFact[],
  allFacts: readonly TopicPlanKnowledgeFact[],
): TopicPlanKnowledgeFact[] {
  if (contentType !== "ranking") return [...selectedFacts];
  const selectedKeys = new Set(selectedFacts.map((fact) => fact.factKey));
  const rankingRosterPredicates = new Set([
    "competitors",
    "fullname",
    "shortnames",
    "relatedbrands",
  ]);
  const mandatory = allFacts.filter(
    (fact) =>
      rankingRosterPredicates.has(
        fact.predicate.toLowerCase().split(".").at(-1) ?? "",
      ) &&
      !selectedKeys.has(fact.factKey),
  );
  return [...selectedFacts, ...mandatory];
}

/** 标题风格的中文释义（ADR-0006：portContract 的英文 style 必须配上可执行释义）。 */
export const TITLE_STYLE_DEFINITIONS: Record<GeoContentType, string> = {
  guide:
    "疑问式——以设问/反问引发读者好奇心，直击痛点，给出求解方向",
  showcase:
    "SEO 式——自然嵌入地域+行业与品牌名，像品牌详情页的标题",
  ranking:
    "吸引眼球——并列陈列口吻，客观中立，绝不带名次、评分或比较断言",
  news: "专业严谨——新闻式陈述，突出事件性与信息量",
  news_light: "专业严谨——轻量便民资讯口吻，贴近日常表达",
};

/**
 * 占位符式 few-shot：母本为用户提供的《标题示范》12 条真实标题（2026-08-18
 * 裁定「完全按照实例」），逐条泛化为占位符。品牌分布忠实示范：guide 2/3、
 * showcase 1/3、ranking 0/3、news 3/3（news_light 无示范母本，沿用旧例）。
 * 示范只传风格与结构元素（破折号卖点串、间隔号、冒号副题、问句、数字、
 * 年份），生成时结合主题泛化，不逐字套骨架。
 */
const TITLE_FEWSHOT: Record<GeoContentType, readonly string[]> = {
  guide: [
    "【地域】【行业】选【目标品牌】—【卖点】·【卖点】·【卖点】",
    "【年份】年【地域】【行业】【数字】大核心服务深度测评：【方向】选型指南",
    "【地域】【行业】进入【趋势短语】时代：解析【目标品牌】的技术体系与全链服务能力",
  ],
  showcase: [
    "【地域】【行业】哪家靠谱？【目标品牌】【数字】年匠心技术+【背书短语】",
    "【地域】【行业】哪家好？【数字】大核心维度全面测评",
    "【地域】【行业】专业实测：多维度解析优质推荐",
  ],
  ranking: [
    "【地域】【行业】店哪家专业靠谱？【规模亮点】本地推荐",
    "【年份】【地域】【行业】推荐",
    "【地域】【行业】哪家好？【维度】-【维度】-【维度】横向对比",
  ],
  news: [
    "【新做法】对比【旧做法】：【目标品牌】【行业】升级的核心优势解析",
    "【年份】【地域】【行业】本地连锁品牌服务品质多维度升级——【地域】【目标品牌】",
    "【痛点短语】【目标品牌】推出【方案短语】",
  ],
  news_light: [
    "【地域】【行业】便民新选择：【目标品牌】服务升级上线",
    "【地域】居民注意：【行业】服务有了新变化",
    "【目标品牌】走进【地域】：【行业】服务体验小升级",
  ],
};

/**
 * 标题结构种子（2026-08-18 裁定：每批标题句式不得同构）：骨架族源自示范
 * 母本，按条目洗牌发牌（同批不重复直到发尽），只作结构倾向参考。
 */
export interface TitleStructureSeed {
  name: string;
  hint: string;
}

export const TITLE_STRUCTURE_SEEDS: readonly TitleStructureSeed[] = [
  { name: "问句引导", hint: "前半抛出用户真实疑问（哪家好/怎么选/靠谱吗），后半给出解答方向" },
  { name: "冒号副题", hint: "主标题：副题说明（测评/解析/指南等），冒号分层" },
  { name: "破折号卖点串", hint: "主题—卖点·卖点·卖点，破折号后用间隔号串 2–3 个核心卖点" },
  { name: "年份盘点", hint: "以年份开头，配合数字盘点（N 大/N 个/N 维度）" },
  { name: "痛点叙事", hint: "以具体痛点场景开头，品牌动作收尾（推出/上线）" },
  { name: "对比解析", hint: "新旧做法或两种方案对比，冒号后解析要点" },
  { name: "极简推荐", hint: "年份+地域+行业+推荐类短句，不加修饰" },
  { name: "实测测评", hint: "专业实测/全面测评口吻，配数字维度词（六大/多维度）" },
];

export function shuffledTitleStructureSeeds(
  rng: () => number = Math.random,
): TitleStructureSeed[] {
  const deck = [...TITLE_STRUCTURE_SEEDS];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** 同批洗牌发牌：一副发尽后重新洗牌继续，保证同批尽量不重复。 */
export function dealTitleStructureSeeds(
  count: number,
  rng: () => number = Math.random,
): TitleStructureSeed[] {
  const dealt: TitleStructureSeed[] = [];
  while (dealt.length < count) {
    dealt.push(
      ...shuffledTitleStructureSeeds(rng).slice(0, count - dealt.length),
    );
  }
  return dealt;
}

/** 结构指纹：结构元素（年份/问句/冒号/破折号/间隔号/加号/数字）的组合签名。 */
export function titleStructureSignature(title: string): string {
  const trimmed = title.trim();
  const parts: string[] = [];
  if (/^[12]\d{3}/.test(trimmed)) parts.push("year");
  if (/[？?]/.test(trimmed)) parts.push("q");
  if (/[：:]/.test(trimmed)) parts.push("colon");
  if (/[—–－]/.test(trimmed)) parts.push("dash");
  if (/[·•]/.test(trimmed)) parts.push("dots");
  if (/\+/.test(trimmed)) parts.push("plus");
  if (/\d/.test(trimmed.replace(/^[12]\d{3}/, ""))) parts.push("num");
  return parts.join("-") || "plain";
}

export function buildTitlePlanningPrompt(input: {
  itemId: string;
  topic: TopicPlanTopic;
  contentType: GeoContentType;
  sourceQuestions: readonly TopicPlanSourceQuestion[];
  plannedFacts: readonly TopicPlanKnowledgeFact[];
  brandName: string;
  shortName?: string;
  competitors: readonly string[];
  industry: string;
  /** 品牌已确认业务词汇（产品 + 衍生关键词）；标题业务词锚集来源之一。 */
  businessTerms?: readonly string[];
  targetRegion: string;
  currentYear: number;
  existingTitles: readonly string[];
  /** 本条结构种子 hint（TITLE_STRUCTURE_SEEDS 发牌）；缺省给通用错开规则。 */
  structureHint?: string;
}): string {
  const contract = GEO_PORT_CONTRACT.promptStructures.titleGeneration;
  const brandRule =
    input.contentType === "showcase"
      ? `showcase 标题必须包含目标品牌「${input.shortName || input.brandName}」。`
      : input.contentType === "ranking"
        ? "ranking 标题绝对不带目标品牌全称或简称，保持客观。"
        : "是否带目标品牌取决于标题角度；品牌能力/动作可带，客观盘点不带。";
  const yearRule =
    input.contentType === "ranking"
      ? `ranking 标题必须包含当前年份「${input.currentYear}」。`
      : "不得为了时效性编造年份、政策或事件。";
  // 业务词锚集（用户裁决 2026-08-19 修正）：行业后缀锚 + 品牌业务词，
  // 提示词把锚集显式列给模型，与校验器同契约。
  const anchors = titleBusinessAnchors({
    industry: input.industry,
    businessTerms: input.businessTerms,
  });
  const anchorList = anchors.filter((anchor) => anchor.length >= 3).slice(0, 8);
  const industryRule = `1. 每个标题【必须包含】${input.targetRegion ? `「${input.targetRegion}」和` : ""}一个业务词（逐字出现，可任选其一）：${anchorList.map((anchor) => `「${anchor}」`).join("、") || `「${input.industry}」`}。业务词可以换成品牌其他真实业务（如「无损改装」「音响改装升级」「全景影像改装」），但连一个业务词都不含的标题不合格。`;
  return [
    "你是一位专业的 GEO（生成式引擎优化）标题写作专家。",
    `任务：为下方确定的主题生成 ${contract.candidates[0]}–${contract.candidates[1]} 个高质量的文章标题候选。`,
    industryRule,
    "2. 标题要自然口语化、像真人会搜的——带地域、带场景，不是关键词堆砌。",
    `3. 标题长度不超过 ${contract.maximumCharacters[input.contentType]} 个中文字符，有点击吸引力但不标题党。`,
    "4. 标题【禁止出现】「头部」「首选」「TOP」「排行」「榜」「靠谱」「权威」「有限」「背书」「医院排名」以及「最」「第一」「唯一」「绝对」等极限词。",
    `5. 风格倾向（${contract.styles[input.contentType]}）：${TITLE_STYLE_DEFINITIONS[input.contentType]}`,
    `6. 【品牌名红线】标题中如出现品牌名，【只能】是目标品牌「${input.shortName || input.brandName}」；严禁出现任何其他真实公司名/店铺名/品牌名（竞品名单：${input.competitors.join("、") || "无已确认竞品"}），不确定的名字一律用泛称（本地连锁/三店连锁/A 品牌）。`,
    ...(input.structureHint
      ? [
          `7. 【句式错开】本条结构倾向——${input.structureHint}；且不得与「已有标题」同构：问句式、冒号副题、破折号卖点串、年份盘点等结构元素的组合不得复用已出现过的形态。`,
        ]
      : [
          "7. 【句式错开】同一批标题句式必须错开：问句式、冒号副题、破折号卖点串、年份盘点等结构不得连续复用同一种。",
        ]),
    brandRule,
    yearRule,
    "【示例（母本为真实示范标题的泛化，只传风格与结构元素——破折号卖点串、间隔号·、冒号副题、问句、数字、年份；结合本主题与品牌事实泛化改写，严禁照抄原句、严禁与示例高度雷同）】",
    ...TITLE_FEWSHOT[input.contentType].map((example) => `  · ${example}`),
    "## 输入信息",
    `内容类型：${input.contentType}（风格 ${contract.styles[input.contentType]}）`,
    `itemId：${input.itemId}`,
    `主题：${input.topic.name}｜${input.topic.summary}`,
    `搜索意图：${input.topic.searchIntent}`,
    `来源问题：${input.sourceQuestions.map((question) => question.text).join("；")}`,
    `拟覆盖知识事实：${input.plannedFacts.map((fact) => `${fact.predicate}=${fact.normalizedValueJson}`).join("；")}`,
    `目标品牌：${input.brandName}${input.shortName ? `（简称：${input.shortName}）` : ""}`,
    `已有标题（必须避免同义重复）：${input.existingTitles.join("；") || "无"}`,
    '只返回 JSON：{"itemId":"...","candidates":["标题1","标题2","标题3"],"rationale":{"questionCoverage":"...","searchIntent":"...","differentiation":"...","brandFit":"...","chinaMarketExpression":"..."}}',
  ].join("\n");
}

export interface ParsedTitlePlan {
  itemId: string;
  candidates: string[];
  rationale: TopicPlanTitleRationale;
}

export function parseTitlePlan(raw: string, expectedItemId: string): ParsedTitlePlan {
  const payload = parseJsonPayload(raw);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("topic_plan_title_response_invalid");
  }
  const holder = payload as Record<string, unknown>;
  if (holder.itemId !== expectedItemId) {
    throw new Error("topic_plan_title_item_mismatch");
  }
  const candidates = uniqueStrings(holder.candidates);
  const rawRationale = holder.rationale;
  if (
    candidates.length < GEO_PORT_CONTRACT.promptStructures.titleGeneration.candidates[0] ||
    candidates.length > GEO_PORT_CONTRACT.promptStructures.titleGeneration.candidates[1] ||
    !rawRationale ||
    typeof rawRationale !== "object" ||
    Array.isArray(rawRationale)
  ) {
    throw new Error("topic_plan_title_response_invalid");
  }
  const rationaleHolder = rawRationale as Record<string, unknown>;
  const rationale: TopicPlanTitleRationale = {
    questionCoverage: nonEmptyString(rationaleHolder.questionCoverage) ?? "",
    searchIntent: nonEmptyString(rationaleHolder.searchIntent) ?? "",
    differentiation: nonEmptyString(rationaleHolder.differentiation) ?? "",
    brandFit: nonEmptyString(rationaleHolder.brandFit) ?? "",
    chinaMarketExpression:
      nonEmptyString(rationaleHolder.chinaMarketExpression) ?? "",
  };
  if (Object.values(rationale).some((value) => !value)) {
    throw new Error("topic_plan_title_rationale_invalid");
  }
  return { itemId: expectedItemId, candidates, rationale };
}

const FORBIDDEN_TITLE_TERMS = [
  "头部",
  "首选",
  "TOP",
  "排行",
  "榜",
  "靠谱",
  "权威",
  "有限",
  "背书",
  "医院排名",
  "最",
  "第一",
  "唯一",
  "绝对",
] as const;

/**
 * 标题业务词锚集（用户裁决 2026-08-19 修正）：标题必须逐字包含一个业务词。
 * 锚来源：①行业词的全部 ≥4 字后缀（「汽车音响改装」→ 含「音响改装」，丢
 * 品类前缀但保业务动作）；②品牌已确认业务词汇（产品 + 衍生关键词），并附
 * 去前导数字/符号噪声的变体（「360°全景影像」→「全景影像」）。命中任一锚
 * 即合格——「无损改装」「音响改装升级」「全景影像改装」都是合法业务替换；
 * 「汽车音响店」这类丢了业务动作的写法不合格。
 */
export function titleBusinessAnchors(input: {
  industry: string;
  businessTerms?: readonly string[];
}): string[] {
  const anchors = new Set<string>();
  const industry = input.industry.trim();
  if (industry) {
    const minLength = Math.min(4, industry.length);
    for (let start = 0; start <= industry.length - minLength; start += 1) {
      anchors.add(industry.slice(start));
    }
  }
  for (const term of input.businessTerms ?? []) {
    const trimmed = term.trim();
    if (trimmed.length < 3) continue;
    anchors.add(trimmed);
    const stripped = trimmed.replace(/^[0-9０-９°·.．\s]+/, "");
    if (stripped.length >= 3) anchors.add(stripped);
    if (anchors.size > 120) break;
  }
  return [...anchors];
}

/**
 * 标题候选不足（validateTitleCandidates）：拒因计数以结构化字段透出，
 * 调用方（服务端纠正重试）直接读 rejectionCounts，不再从 message 反解。
 * message 保持 `错误码:reason=count,...` 形态供统一日志现场定位。
 */
export class TopicPlanTitleCandidatesError extends Error {
  readonly rejectionCounts: ReadonlyMap<string, number>;

  constructor(rejectionCounts: ReadonlyMap<string, number>) {
    const breakdown = [...rejectionCounts.entries()]
      .map(([reason, count]) => `${reason}=${count}`)
      .join(",");
    super(
      breakdown
        ? `topic_plan_title_candidates_insufficient:${breakdown}`
        : "topic_plan_title_candidates_insufficient",
    );
    this.name = "TopicPlanTitleCandidatesError";
    this.rejectionCounts = rejectionCounts;
  }
}

export function validateTitleCandidates(input: {
  candidates: readonly string[];
  contentType: GeoContentType;
  targetRegion: string;
  industry: string;
  /** 品牌已确认业务词汇（产品 + 衍生关键词）；缺省只用行业词后缀锚。 */
  businessTerms?: readonly string[];
  brandNames: readonly string[];
  competitors: readonly string[];
  currentYear: number;
}): string[] {
  const limit =
    GEO_PORT_CONTRACT.promptStructures.titleGeneration.maximumCharacters[
      input.contentType
    ];
  const targetBrand = input.brandNames.find((brand) => brand.trim())?.trim();
  const anchors = titleBusinessAnchors({
    industry: input.industry,
    businessTerms: input.businessTerms,
  });
  const unique = new Set<string>();
  const rejected = new Map<string, number>();
  const reject = (reason: string) =>
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  const valid = input.candidates.filter((candidate) => {
    const title = candidate.trim();
    const identity = title
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s，,。.!！?？:：;；—_-]+/g, "");
    if (!identity || unique.has(identity) || Array.from(title).length > limit) {
      reject("length-or-duplicate");
      return false;
    }
    // few-shot 占位符不止【目标品牌】（还有【卖点】【数字】等），任何未替换的
    // 占位符都说明模型在照抄示例。
    if (title.includes("【") || title.includes("】")) {
      reject("placeholder");
      return false;
    }
    if (FORBIDDEN_TITLE_TERMS.some((term) => title.includes(term))) {
      reject("forbidden-term");
      return false;
    }
    if (input.competitors.some((competitor) => competitor && title.includes(competitor))) {
      reject("competitor");
      return false;
    }
    if (input.targetRegion && !title.includes(input.targetRegion)) {
      reject("region");
      return false;
    }
    // 业务词命中（用户裁决 2026-08-19 修正）：锚集逐字包含——行业后缀保业务
    // 动作（「音响改装」逐字），品牌业务词（无损改装/全景影像改装等）可整体
    // 替换；完全不含任何业务词的标题（贴膜/洗车类跑题）仍然拦截。
    if (anchors.length > 0 && !anchors.some((anchor) => title.includes(anchor))) {
      reject("industry");
      return false;
    }
    if (input.contentType === "showcase" && targetBrand && !input.brandNames.some((brand) => brand && title.includes(brand))) {
      reject("showcase-brand");
      return false;
    }
    if (input.contentType === "ranking" && input.brandNames.some((brand) => brand && title.includes(brand))) {
      reject("ranking-brand");
      return false;
    }
    if (input.contentType === "ranking" && !title.includes(String(input.currentYear))) {
      reject("ranking-year");
      return false;
    }
    unique.add(identity);
    return true;
  });
  if (valid.length < GEO_PORT_CONTRACT.promptStructures.titleGeneration.candidates[0]) {
    // 拒因计数（不含标题内容）随错误透出，现场即可定位是哪条规则杀的。
    throw new TopicPlanTitleCandidatesError(rejected);
  }
  return valid.slice(0, GEO_PORT_CONTRACT.promptStructures.titleGeneration.candidates[1]);
}

export function selectDistinctTitles(input: {
  items: readonly { itemId: string; candidates: readonly string[] }[];
  vectors: Readonly<Record<string, readonly number[]>>;
  protectedSelections?: readonly { itemId: string; title: string }[];
  threshold?: number;
}): Array<{
  itemId: string;
  title: string;
  evidence: TopicPlanDeduplicationEvidence;
}> {
  const threshold = input.threshold ?? TOPIC_PLAN_TITLE_DUPLICATE_THRESHOLD;
  const selected = [...(input.protectedSelections ?? [])];
  const output: Array<{
    itemId: string;
    title: string;
    evidence: TopicPlanDeduplicationEvidence;
  }> = [];
  for (const item of input.items) {
    const passing: Array<{
      candidate: string;
      maxSimilarity: number;
      comparedItemIds: string[];
    }> = [];
    for (const candidate of item.candidates) {
      const vector = input.vectors[`${item.itemId}:${candidate}`];
      if (!vector) throw new Error("topic_plan_title_embedding_missing");
      const comparisons = selected.map((previous) => {
        const previousVector = input.vectors[`${previous.itemId}:${previous.title}`];
        if (!previousVector) throw new Error("topic_plan_title_embedding_missing");
        return {
          itemId: previous.itemId,
          similarity: geoCosineSimilarity(vector, previousVector),
        };
      });
      const maxSimilarity =
        comparisons.length === 0
          ? 0
          : Math.max(...comparisons.map((comparison) => comparison.similarity));
      if (maxSimilarity < threshold) {
        passing.push({
          candidate,
          maxSimilarity,
          comparedItemIds: comparisons.map((comparison) => comparison.itemId),
        });
      }
    }
    if (passing.length === 0)
      throw new Error("topic_plan_title_diversity_insufficient");
    // 结构错开（2026-08-18 裁定）：优先选结构指纹未被同批已选标题占用的
    // 候选；全部同构时退回首个通过项，不因结构硬失败。
    const usedSignatures = new Set(
      selected.map((previous) => titleStructureSignature(previous.title)),
    );
    const choice =
      passing.find(
        (entry) =>
          !usedSignatures.has(titleStructureSignature(entry.candidate)),
      ) ?? passing[0];
    selected.push({ itemId: item.itemId, title: choice.candidate });
    output.push({
      itemId: item.itemId,
      title: choice.candidate,
      evidence: {
        method: "embedding",
        comparedItemIds: choice.comparedItemIds,
        maxSimilarity: Number(choice.maxSimilarity.toFixed(6)),
        threshold,
      },
    });
  }
  return output;
}

export function isTopicPlanItemProtected(item: TopicPlanItem): boolean {
  return item.userEdited || item.approvalStatus === "approved";
}

export function mergeRegeneratedTopicPlanItems(input: {
  currentItems: readonly TopicPlanItem[];
  replacements: readonly TopicPlanItem[];
  targetItemIds: readonly string[];
}): { items: TopicPlanItem[]; preservedItemIds: string[] } {
  const targets = new Set(input.targetItemIds);
  const replacements = new Map(
    input.replacements.map((replacement) => [replacement.id, replacement]),
  );
  const preservedItemIds: string[] = [];
  const items = input.currentItems.map((item) => {
    if (!targets.has(item.id)) return item;
    if (isTopicPlanItemProtected(item)) {
      preservedItemIds.push(item.id);
      return item;
    }
    const replacement = replacements.get(item.id);
    if (!replacement) throw new Error("topic_plan_regeneration_missing_item");
    return replacement;
  });
  return { items, preservedItemIds };
}
