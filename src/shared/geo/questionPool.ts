import {
  GEO_PORT_CONTRACT,
  classifyGeoQuestionPriority,
  geoCosineSimilarity,
  scoreGeoQuestionMatch,
  scoreGeoQuestionPotential,
} from "./portContract";

export const QUESTION_POOL_POLICY_VERSION = "js-ai-dev-pred-1-v1";
export const QUESTION_POOL_STAGES = [
  "keyword-search",
  "question-generation",
  "embedding",
  "persist",
] as const;

export type QuestionPoolStage = (typeof QUESTION_POOL_STAGES)[number];
export type KeywordCategory = "core" | "scene" | "longtail";
export type KeywordHeat = "high" | "medium" | "low";
export type QuestionPriority = "high" | "medium" | "low";

export interface QuestionPoolGenerationParameters {
  policyVersion: typeof QUESTION_POOL_POLICY_VERSION;
  candidateLimit: number;
  recentSelectionLimit: number;
  priorityThresholds: {
    highAtSum: number;
    mediumAtSum: number;
  };
}

export const DEFAULT_QUESTION_POOL_PARAMETERS: QuestionPoolGenerationParameters =
  {
    policyVersion: QUESTION_POOL_POLICY_VERSION,
    candidateLimit: GEO_PORT_CONTRACT.questionScoring.candidateLimit,
    recentSelectionLimit: 20,
    priorityThresholds: {
      highAtSum: GEO_PORT_CONTRACT.questionScoring.priority.highAtSum,
      mediumAtSum: GEO_PORT_CONTRACT.questionScoring.priority.mediumAtSum,
    },
  };

export interface MinedKeyword {
  id: string;
  term: string;
  category: KeywordCategory;
  heat: KeywordHeat;
  platform: "doubao";
}

export interface QuestionPoolEvidence {
  kind: "keyword-search" | "knowledge-fact" | "user-added";
  reference: string;
  excerpt: string;
}

export interface QuestionPoolScore {
  mode: "pred-1";
  relevance: number;
  recentPoolSimilarity: number;
  optimizationPotential: number;
  priorityTotal: number;
  priority: QuestionPriority;
  formula: string;
  policyVersion: typeof QUESTION_POOL_POLICY_VERSION;
}

export interface QuestionPoolQuestion {
  id: string;
  text: string;
  selected: boolean;
  recommended: boolean;
  score: QuestionPoolScore;
  evidence: QuestionPoolEvidence[];
}

export interface QuestionPoolCheckpoint {
  stage: QuestionPoolStage;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attemptNumber: number;
  billingKey: string;
  inputHash: string;
  errorCode?: string | null;
}

export interface QuestionPoolProjection {
  id: string;
  attemptId?: string | null;
  operationId: string;
  workspaceId: string;
  knowledgeVersion: number;
  productLine: string;
  targetRegion: string;
  generationParameters: QuestionPoolGenerationParameters;
  status:
    | "generating"
    | "awaiting-selection"
    | "confirmed"
    | "failed"
    | "cancelled";
  revision: number;
  keywords: MinedKeyword[];
  questions: QuestionPoolQuestion[];
  sourceEvidence: QuestionPoolEvidence[];
  checkpoints: QuestionPoolCheckpoint[];
  reused: boolean;
  derivedFromPoolId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionPoolDecision {
  poolId: string;
  decisionId: string;
  decision: "confirm-selection";
  expectedRevision: number;
  revision: number;
  knowledgeVersion: number;
  questions: QuestionPoolQuestion[];
  selectedQuestionIds: string[];
  actorId: "desktop-user";
  decidedAt: string;
}

export function normalizeQuestionPoolParameters(
  input?: Partial<QuestionPoolGenerationParameters>,
): QuestionPoolGenerationParameters {
  const candidateLimit = Math.min(
    20,
    Math.max(1, Math.trunc(input?.candidateLimit ?? 20)),
  );
  const recentSelectionLimit = Math.min(
    50,
    Math.max(1, Math.trunc(input?.recentSelectionLimit ?? 20)),
  );
  return {
    ...DEFAULT_QUESTION_POOL_PARAMETERS,
    candidateLimit,
    recentSelectionLimit,
  };
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeHeat(value: unknown): KeywordHeat {
  if (value === "high" || value === "高") return "high";
  if (value === "low" || value === "低") return "low";
  return "medium";
}

function containsBrandName(
  term: string,
  brandNames: readonly string[],
): boolean {
  const normalizedTerm = term.trim().toLocaleLowerCase("zh-CN");
  return brandNames.some((name) => {
    const normalizedName = name.trim().toLocaleLowerCase("zh-CN");
    return normalizedName.length > 0 && normalizedTerm.includes(normalizedName);
  });
}

/**
 * Parse the three js_ai dev keyword buckets and enforce the brand-name ban in
 * code. The prompt is guidance; this filter is the executable authority.
 */
export function parseMinedKeywords(
  raw: string,
  brandNames: readonly string[],
): MinedKeyword[] {
  const parsed = extractJsonObject(raw);
  const keywords: MinedKeyword[] = [];
  const seen = new Set<string>();
  if (parsed) {
    for (const category of ["core", "scene", "longtail"] as const) {
      const bucket = parsed[category];
      if (!Array.isArray(bucket)) continue;
      for (const item of bucket) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const holder = item as Record<string, unknown>;
        if (typeof holder.term !== "string") continue;
        const term = holder.term.trim();
        const identity = term.toLocaleLowerCase("zh-CN");
        if (!term || seen.has(identity) || containsBrandName(term, brandNames))
          continue;
        seen.add(identity);
        keywords.push({
          id: `kw-${keywords.length + 1}`,
          term,
          category,
          heat: normalizeHeat(holder.heat),
          platform: "doubao",
        });
      }
    }
  }
  if (keywords.length === 0) throw new Error("question_pool_empty_keywords");
  return keywords;
}

export interface ParsedQuestionCandidate {
  text: string;
  recommended: boolean;
  sourceKeywords: string[];
}

export function parseQuestionCandidates(
  raw: string,
  keywords: readonly MinedKeyword[],
  limit: number,
): ParsedQuestionCandidate[] {
  const parsed = extractJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.questions)) return [];
  const allowed = new Map(
    keywords.map((keyword) => [keyword.term, keyword.term]),
  );
  const seen = new Set<string>();
  const questions: ParsedQuestionCandidate[] = [];
  for (const item of parsed.questions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    if (typeof holder.text !== "string") continue;
    const text = holder.text.trim();
    const identity = text
      .toLocaleLowerCase("zh-CN")
      .replace(/[？?。！!\s]+$/g, "");
    if (!text || seen.has(identity)) continue;
    const sourceKeywords = Array.isArray(holder.sourceKeywords)
      ? holder.sourceKeywords
          .filter((value): value is string => typeof value === "string")
          .map((value) => allowed.get(value.trim()))
          .filter((value): value is string => Boolean(value))
      : [];
    if (sourceKeywords.length === 0) continue;
    seen.add(identity);
    questions.push({
      text,
      recommended: holder.recommended === true,
      sourceKeywords: [...new Set(sourceKeywords)],
    });
    if (questions.length >= limit) break;
  }
  return questions;
}

export function scoreQuestionPoolCandidate(input: {
  questionVector: readonly number[];
  knowledgeVector: readonly number[];
  recentSelectedVectors: readonly (readonly number[])[];
}): QuestionPoolScore {
  const relevance = scoreGeoQuestionMatch(
    geoCosineSimilarity(input.questionVector, input.knowledgeVector),
  );
  const nearestSimilarity =
    input.recentSelectedVectors.length === 0
      ? 0
      : Math.max(
          ...input.recentSelectedVectors.map((vector) =>
            geoCosineSimilarity(input.questionVector, vector),
          ),
        );
  const recentPoolSimilarity = Math.round(
    Math.max(-1, Math.min(1, nearestSimilarity)) * 100,
  );
  const optimizationPotential = scoreGeoQuestionPotential(nearestSimilarity);
  const priorityTotal = relevance + optimizationPotential;
  return {
    mode: "pred-1",
    relevance,
    recentPoolSimilarity,
    optimizationPotential,
    priorityTotal,
    priority: classifyGeoQuestionPriority(relevance, optimizationPotential),
    formula:
      "priorityTotal = relevance + round(clamp((1 - nearestRecentPoolCosine) * 50, 0, 100)); high >= 150; medium >= 100; low < 100",
    policyVersion: QUESTION_POOL_POLICY_VERSION,
  };
}

export function buildKeywordMiningPrompt(input: {
  region: string;
  industry: string;
  productLine: string;
  brandNames: readonly string[];
  knowledgeSummary: string;
}): string {
  return [
    `目标地域：【${input.region}】`,
    `行业：【${input.industry}】`,
    `产品线：【${input.productLine}】`,
    `已确认知识摘要：${input.knowledgeSummary}`,
    "基于真实联网搜索生成潜在客户使用的搜索词。只返回 JSON。",
    "三类必须递进：core=地域+核心品类；scene=地域+处境/服务场景；longtail=在前两类上增加价格、决策、口碑、攻略、资质、效果、售后、时效、对比或人群限定。",
    `scene 必须以「${input.region}」为根，经联网验证其直接下一级真实区县/街道/商圈，并为场景生成 3–5 个地域变体；不跨行政层级、不编造地名。`,
    `严禁输出具体品牌名、店铺名或企业名，包括：${input.brandNames.join("、") || "无"}；只能使用门店、公司、师傅、服务商等泛称。`,
    "热度只能是 high/medium/low 相对档位，不编造绝对搜索量。",
    '输出：{"core":[{"term":"...","heat":"high|medium|low"}],"scene":[...],"longtail":[...]}',
  ].join("\n");
}

export function buildQuestionGenerationPrompt(input: {
  keywords: readonly MinedKeyword[];
  existingQuestions: readonly string[];
  candidateLimit: number;
}): string {
  const buckets = (["core", "scene", "longtail"] as const).map(
    (category) =>
      `${category}: ${input.keywords
        .filter((keyword) => keyword.category === category)
        .map((keyword) => keyword.term)
        .join("；")}`,
  );
  return [
    "把下面真实挖掘词转换为自然、口语化、最短的问题；不要寒暄，不得加入词里没有的信息。",
    "三条转换规则：core 保留原词并加开放式选择后缀；scene 保留地域与处境，改成推荐问句；longtail 保留全部限定词，仅调整语序并加推荐/找哪家/哪家好。",
    `生成 15–${input.candidateLimit} 条，最多 ${input.candidateLimit} 条。`,
    ...buckets,
    `最近已选问题（避免逐字重复）：${input.existingQuestions.join("；") || "无"}`,
    "sourceKeywords 必须逐字引用上方词库中的一个或多个原词。",
    '只返回：{"questions":[{"text":"...","recommended":false,"sourceKeywords":["原词"]}]}',
  ].join("\n");
}
