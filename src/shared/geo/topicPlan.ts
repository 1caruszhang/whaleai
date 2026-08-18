import {
  GEO_PORT_CONTRACT,
  enforceGeoContentTypeCoverage,
  geoCosineSimilarity,
  type GeoContentType,
} from "./portContract";

export const TOPIC_PLAN_POLICY_VERSION = "js-ai-dev-topic-type-title-v1";
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
    "五类只能是 guide、showcase、ranking、news、news_light。整批应尽量覆盖全部五类。",
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
  targetRegion: string;
  currentYear: number;
  existingTitles: readonly string[];
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
  return [
    "你是一位面向中国市场的 GEO 标题策划专家。为一个确定的主题/内容类型生成 3–5 个标题候选。",
    "标题必须同时覆盖来源问题的核心诉求、匹配搜索意图、避免与已有标题重复、适配目标品牌，并符合自然中文搜索表达；不得关键词堆砌或标题党。",
    `内容类型：${input.contentType}；标题风格：${contract.styles[input.contentType]}；最多 ${contract.maximumCharacters[input.contentType]} 个中文字符。`,
    `每个标题必须自然包含目标地域「${input.targetRegion}」和行业规范统称「${input.industry}」。`,
    brandRule,
    yearRule,
    `严禁出现竞品名：${input.competitors.join("、") || "无已确认竞品"}。`,
    "严禁出现「头部」「首选」「TOP」「排行」「榜」「靠谱」「权威」「有限」「背书」「医院排名」以及「最」「第一」「唯一」「绝对」等极限词。",
    '只返回 JSON：{"itemId":"...","candidates":["标题1","标题2","标题3"],"rationale":{"questionCoverage":"...","searchIntent":"...","differentiation":"...","brandFit":"...","chinaMarketExpression":"..."}}',
    `itemId：${input.itemId}`,
    `主题：${input.topic.name}｜${input.topic.summary}`,
    `搜索意图：${input.topic.searchIntent}`,
    `来源问题：${input.sourceQuestions.map((question) => question.text).join("；")}`,
    `拟覆盖知识事实：${input.plannedFacts.map((fact) => `${fact.predicate}=${fact.normalizedValueJson}`).join("；")}`,
    `目标品牌：${input.brandName}${input.shortName ? `（简称：${input.shortName}）` : ""}`,
    `已有标题（必须避免同义重复）：${input.existingTitles.join("；") || "无"}`,
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

export function validateTitleCandidates(input: {
  candidates: readonly string[];
  contentType: GeoContentType;
  targetRegion: string;
  industry: string;
  brandNames: readonly string[];
  competitors: readonly string[];
  currentYear: number;
}): string[] {
  const limit =
    GEO_PORT_CONTRACT.promptStructures.titleGeneration.maximumCharacters[
      input.contentType
    ];
  const targetBrand = input.brandNames.find((brand) => brand.trim())?.trim();
  const unique = new Set<string>();
  const valid = input.candidates.filter((candidate) => {
    const title = candidate.trim();
    const identity = title
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s，,。.!！?？:：;；—_-]+/g, "");
    if (!identity || unique.has(identity) || Array.from(title).length > limit)
      return false;
    if (title.includes("【目标品牌】")) return false;
    if (FORBIDDEN_TITLE_TERMS.some((term) => title.includes(term))) return false;
    if (input.competitors.some((competitor) => competitor && title.includes(competitor)))
      return false;
    if (input.targetRegion && !title.includes(input.targetRegion)) return false;
    if (input.industry && !title.includes(input.industry)) return false;
    if (input.contentType === "showcase" && targetBrand && !input.brandNames.some((brand) => brand && title.includes(brand)))
      return false;
    if (input.contentType === "ranking" && input.brandNames.some((brand) => brand && title.includes(brand)))
      return false;
    if (input.contentType === "ranking" && !title.includes(String(input.currentYear)))
      return false;
    unique.add(identity);
    return true;
  });
  if (valid.length < GEO_PORT_CONTRACT.promptStructures.titleGeneration.candidates[0]) {
    throw new Error("topic_plan_title_candidates_insufficient");
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
    let choice:
      | {
          title: string;
          maxSimilarity: number;
          comparedItemIds: string[];
        }
      | undefined;
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
        choice = {
          title: candidate,
          maxSimilarity,
          comparedItemIds: comparisons.map((comparison) => comparison.itemId),
        };
        break;
      }
    }
    if (!choice) throw new Error("topic_plan_title_diversity_insufficient");
    selected.push({ itemId: item.itemId, title: choice.title });
    output.push({
      itemId: item.itemId,
      title: choice.title,
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
