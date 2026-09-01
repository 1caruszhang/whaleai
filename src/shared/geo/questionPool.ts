import {
  GEO_PORT_CONTRACT,
  classifyGeoQuestionPriority,
  geoCosineSimilarity,
  scoreGeoQuestionMatch,
  scoreGeoQuestionPotential,
} from "./portContract";

export const QUESTION_POOL_POLICY_VERSION = "xiaojing-content-prompt-v1";
export const QUESTION_POOL_STAGES = [
  "keyword-search",
  "question-generation",
  "embedding",
  "persist",
] as const;

/**
 * 问题池复用契约（ADR-0011 Decision 3 协议侧）：同知识版本已有有效确认池
 * 时，run_question_pool 的调用零消耗秒回——模型按计划调用即安全，不现场
 * 判断「已有确认池要不要重跑」。同一话术必须逐字出现在三处：工具描述、
 * 复用命中的结果信封（outcome + proceed 提示）、next-step 单表的
 * generate-question-pool 条目；改话术三处同改，由 MCP 集成测试
 * （xiaojing-geo-question-pool-reuse）断言三处一致。
 */
export const QUESTION_POOL_REUSE_OUTCOME = "reused-confirmed-pool";
export const QUESTION_POOL_REUSE_CONTRACT =
  "a valid confirmed pool for the same knowledge version is reused at zero cost and returned instantly — proceed directly with the next step";

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

/** 搜索词不允许出现分句/列举标点——拦「成都本地，辐射西南地区…」式拼接词。 */
const TERM_FORBIDDEN_PUNCTUATION = /[，,、；;。．.！!？?：:·"'"「」【】（）()]/;
const TERM_MAX_CHARACTERS = 30;
/** 品牌词入池硬上限（ADR-0006 修正三：至多一条，超出的静默丢弃）。 */
const BRAND_TERM_LIMIT = 1;

/**
 * Parse the three js_ai dev keyword buckets. The prompt is guidance; this
 * filter is the executable authority:
 * - 词形门：禁分句/列举标点、长度 ≤30、去重（含与已入库词去重）；
 * - 品牌词门：品牌相关词至多保留第一条，其余丢弃（竞品/无关品牌词仍全滤）。
 */
export function parseMinedKeywords(
  raw: string,
  brandNames: readonly string[],
  options?: { existingTerms?: readonly string[] },
): MinedKeyword[] {
  const parsed = extractJsonObject(raw);
  const existing = new Set(
    (options?.existingTerms ?? []).map((term) =>
      term.trim().toLocaleLowerCase("zh-CN"),
    ),
  );
  const keywords: MinedKeyword[] = [];
  const seen = new Set<string>();
  let brandCount = 0;
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
        if (!term || seen.has(identity) || existing.has(identity)) continue;
        if (TERM_FORBIDDEN_PUNCTUATION.test(term)) continue;
        if (Array.from(term).length > TERM_MAX_CHARACTERS) continue;
        if (containsBrandName(term, brandNames)) {
          brandCount += 1;
          if (brandCount > BRAND_TERM_LIMIT) continue;
        }
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

export const KEYWORD_MINING_SYSTEM_PROMPT =
  "你是一位搜索词研究专家。请基于真实联网搜索数据，挖掘用户在指定区域+行业的真实搜索词。只返回结构化 JSON，不要 prose、不要 markdown 代码块。";

export type LibraryKeywordTerm = {
  term: string;
  category: "core" | "scene" | "longtail";
  heat: "high" | "medium" | "low";
};

export function buildKeywordMiningPrompt(input: {
  /** 派生的地域锚（服务范围主锚，粒度保留）；空串 = 无地缘模式（泛值/线上/SaaS）。 */
  region: string;
  /** 服务范围白名单（地域上限，ADR-0006 修正四）：提示词层约束。 */
  allowedRegions?: readonly string[];
  industry: string;
  productLine: string;
  brandNames: readonly string[];
  /** renderMiningProfileBlock 的产出；画像无业务信号时为空串。 */
  profileBlock: string;
  /** 已入库词库（用户确认过）：增量挖新，不重复产出。 */
  libraryKeywords?: readonly LibraryKeywordTerm[];
  /** 领域内的具体业务焦点（如"汽车隔音"）；缺省=整个产品线领域。 */
  businessFocus?: string;
}): string {
  const { industry } = input;
  const geoMode = input.region.length > 0;
  const isDistrictAnchor = /[区县]$/.test(input.region);
  const brandName = input.brandNames.find((name) => name.trim())?.trim() ?? "";
  const heatMark = (heat: string) =>
    heat === "high" ? "●" : heat === "low" ? "○" : "◐";
  const libraryBlock =
    input.libraryKeywords && input.libraryKeywords.length > 0
      ? [
          "## 已入库词库（不要重复产出；在其之上增量挖掘）",
          "以下词已确认入库。不要重复产出它们或其同义改写；增量挖掘的方向：尚未覆盖的意图维度、新场景、新表达形态。",
          ...input.libraryKeywords.map(
            (keyword) =>
              `- ${heatMark(keyword.heat)} ${keyword.term}（${keyword.category}）`,
          ),
          "",
        ]
      : [];
  const opening = geoMode
    ? `我在【${input.region}】经营【${industry}】业务。`
    : `我经营【${industry}】业务（服务不限定单一地域/线上或全国交付）。`;
  const whitelist =
    input.allowedRegions && input.allowedRegions.length > 0
      ? [...new Set([input.region, ...input.allowedRegions])].join("、")
      : input.region;
  const regionRules = geoMode
    ? [
        `【地域白名单（用户声明的服务范围）】${whitelist}。所有输出词中的地域只能取自白名单，或【${input.region}】直接下辖的真实下级地名；白名单之外的城市、省份、大区名一律禁止，「辐射/覆盖」类拼接也禁止。`,
        isDistrictAnchor
          ? `scene 的地域直接用【${input.region}】或其去掉「区/县」尾的口语形式；区县级服务范围不再向下裂变到街道、乡镇。`
          : `scene 地域以【${input.region}】为根，联网搜索其【直接下辖的】下一级真实地名做裂变（不跨级、不编造、不越出上述白名单），每个场景 3–5 个地域变体。`,
      ]
    : [
        "地域按真实用户语言自然呈现——本地服务的用户会带城市名，线上/全国服务的用户通常不带；不强制地域锚，也不得虚构地域。",
      ];
  return [
    opening,
    "请帮我挖掘：我的潜在客户在搜索这个行业和相关服务需求时，会用哪些搜索词、场景词和完整语义词。",
    "",
    "## 任务与证据纪律",
    "基于真实联网搜索数据，挖掘潜在客户会使用的搜索词；优先反映真实搜索行为（联网搜索验证），而非泛泛的行业常识。",
    "【热度证据纪律】热度档位必须以联网搜索证据为据——搜不到真实使用痕迹的词，宁标 low 或不产出；严禁凭感觉把拼接词标成 high。",
    ...(input.profileBlock ? ["", input.profileBlock] : []),
    ...(input.businessFocus
      ? [
          "",
          `具体业务焦点：【${input.businessFocus}】（领域：${input.productLine}）——挖掘围绕该业务但不超出该领域。`,
        ]
      : []),
    "",
    ...libraryBlock,
    "## 三类词（递进关系：core 挖品类 → scene 叠加场景处境 → longtail 叠加多元搜索意图；后类承接前类已挖出的服务词，不另起炉灶）",
    ...regionRules,
    "【主体】按语义需要加入泛指词（门店/公司/师傅/服务商/店/厂家），绝不用具体店铺名。",
    ...(brandName
      ? [`除下方品牌词专段允许的至多一条外，任何词不得出现品牌名（含：${input.brandNames.join("、")}）。`]
      : []),
    "",
    `- 行业核心词（core）· 4–6 个：行业最通用、搜索量最大的品类词，结构 = [地域+]行业[+泛指主体]。`,
    geoMode
      ? `  示例：${input.region}${industry}、${input.region}${industry}店、${input.region}${industry}哪家好。`
      : `  示例：${industry}、${industry}公司、${industry}哪家好。`,
    "",
    `- 场景需求词（scene）· 8–12 个：用户在具体处境下的需求表达，结构 = [地域+]行业+场景处境[+泛指主体]。`,
    geoMode
      ? `  示例（仅示范形态，禁止照搬地名）：${input.region}新车提车${industry}、${input.region}车子异响做隔音。`
      : `  示例（仅示范形态）：新车提车想做${industry}、设备出问题需要上门${industry}。`,
    "",
    `- 完整语意长尾词（longtail）· 12–18 个：更完整、更口语化的长句搜索，承接 core/scene 服务词叠加【多元搜索意图维度】，覆盖决策路径多个侧面，不要只套一两种问法。`,
    "  【意图维度方向（举例方向，非穷举，按本业务真实场景挑选/派生/自由组合）】",
    "  价格/预算：多少钱、报价、性价比｜决策/选择：哪家好、怎么选、避坑｜口碑/评价：口碑、靠谱吗、踩雷｜攻略/求知：怎么做、流程、要注意什么",
    "  资质/合规：资质、正规吗、有没有证｜效果/预期：效果怎么样、能维持多久｜售后/保障：保修、售后、质保多久",
    "  时效/便利：24小时、上门、当天｜对比/替代：A和B区别、值不值｜人群/场景限定：针对某人群、某时机",
    `  示例（仅示范形态，禁止照搬）：${geoMode ? input.region : ""}${industry}避坑、${geoMode ? input.region : ""}${industry}资质怎么看、${geoMode ? input.region : ""}${industry}24小时上门吗。`,
    "  注意：**不要只围绕「多少钱/哪家靠谱」造词**——它们只是十个维度里的两项。",
    ...(brandName
      ? [
          "",
          "## 品牌词（至多 1 条）",
          `可产出至多一条品牌相关搜索词，形如「${brandName}怎么样」「${brandName}靠谱吗」——仅当联网能验证该品牌名有真实搜索量；搜不到证据就不产出。竞品名永远严禁出现。`,
        ]
      : []),
    "",
    "## 输出",
    "只返回一个 JSON 对象（不要 prose、不要 markdown 代码块）：",
    '{"core":[{"term":"...","heat":"high|medium|low"}],"scene":[...],"longtail":[...]}',
    "热度=相对档位（高=搜索量大、竞争激烈；中=适中；低=长尾精准），档位判断遵循上方证据纪律。",
  ].join("\n");
}

export const QUESTION_GENERATION_SYSTEM_PROMPT =
  "你是一位 GEO（生成式引擎优化）用户意图研究员，精通中文搜索生态。只把真实搜索词转换为结构化的自然中文问题；不要调用工具。";

const HEAT_MARKS: Record<string, string> = {
  high: "●",
  medium: "◐",
  low: "○",
};

export function buildQuestionGenerationPrompt(input: {
  region: string;
  industry: string;
  keywords: readonly MinedKeyword[];
  existingQuestions: readonly string[];
  candidateLimit: number;
  /** renderFullProfileBlock 的产出；画像无字段时为空串。 */
  profileBlock: string;
}): string {
  const bucket = (category: MinedKeyword["category"], label: string) => {
    const terms = input.keywords.filter(
      (keyword) => keyword.category === category,
    );
    const rendered = terms
      .map((keyword) => `${keyword.term}${HEAT_MARKS[keyword.heat] ?? ""}`)
      .join("；");
    return `- ${label}（${category}）：${rendered || "无"}`;
  };
  return [
    "## 最高原则",
    "每条问题都必须是一句通顺、口语化的完整中文——读起来像真人真的会说/会搜的一句话。",
    "宁可少加东西，也不要拼出半通不通的句子。",
    "",
    "## 转换规则（全部从挖掘词派生，不杜撰词里没有的信息）",
    "1. 行业核心词（core，[地域+]核心品类）→ 保留原词，可加【一个】与语义匹配的开放式尾巴表示选择意图（哪家好 / 推荐 / 靠谱的找哪家…按语义自选）；哪个读起来通顺用哪个，没有合适的就不加，直接换成疑问句。",
    "   示例（仅示范形态，禁止照搬）：",
    `   · ${input.region}${input.industry}哪家好`,
    `   · ${input.region}${input.industry}推荐`,
    `   · ${input.region}做${input.industry}，选店还是选工作室？`,
    "2. 场景需求词（scene，处境+服务词）→ 改写成自然的推荐/求助问句；【不要套固定句式】，每条尽量用不同的问法，不要机械填充模板。",
    "   示例（仅示范形态，禁止照搬）：",
    `   · 我在${input.region}，想找家靠谱的做${input.industry}的店`,
    `   · ${input.region}急用，哪家${input.industry}能当天上门？`,
    `   · 刚搬到${input.region}，人生地不熟，${input.industry}一般去哪做？`,
    "3. 完整语意长尾词（longtail，含限定条件）→ 先判断：A. 词已是完整问句 → 理顺后直接用，【不加任何后缀】；B. 裸名词短语 → 理顺语序后补【一个】通顺的尾巴。",
    "   长尾词里的限定条件一个不能丢、也不能自己加新的限定词；【不要用『推荐』作尾巴——『推荐』拼进完整句子里多半读不通】。",
    "   示例（仅示范形态，禁止照搬）：",
    `   · ${input.region}${input.industry}24小时上门吗 → ${input.region}${input.industry}有24小时上门的吗？`,
    `   · ${input.region}${input.industry}资质怎么看 → ${input.region}${input.industry}的资质怎么查？`,
    "4. 品牌词（如「XX品牌怎么样」）→ 保持原样或轻微理顺——这类问题本身已是完整问句。",
    "",
    "## 硬约束",
    "- 口语化，像真人会搜的——不是书面语、不是关键词堆砌。",
    "- 最短：能少一个字就少一个字；不加寒暄（请问 / 你好）。",
    "- 不杜撰：不加入挖掘词和品牌档案里没有的信息。",
    ...(input.region
      ? [`- 地域表述不超出【${input.region}】范围，不引入其他城市/地区名。`]
      : []),
    "- 【绝对禁止】把「推荐」「哪家好」「找哪家」机械拼接到一个已经完整的句子末尾——「……怎么预约推荐」「……效果怎么样推荐」是病句，绝不允许。",
    `- 每个挖掘词至少转出 1 条问题；总量 15–${input.candidateLimit} 条。词多于配额时，优先覆盖高热度与意图多样的词（●高优先），不要逐词平铺。`,
    "- 标记 2–3 个曝光价值最高的问题为 recommended: true。",
    "- 避免与下方【最近已选问题】重复。",
    ...(input.profileBlock ? ["", input.profileBlock] : []),
    "",
    "## 挖掘词库（●高 / ◐中 / ○低 为相对热度）",
    bucket("core", "行业核心词"),
    bucket("scene", "场景需求词"),
    bucket("longtail", "完整语意长尾词"),
    "",
    "## 最近已选问题（避免重复）",
    input.existingQuestions.length > 0
      ? input.existingQuestions.slice(0, 30).join("；")
      : "无",
    "",
    "## 输出",
    "只返回 JSON（不要 prose、不要 markdown 代码块）：",
    '{"questions":[{"text":"...","recommended":false,"sourceKeywords":["逐字引用词库原词"]}]}',
    "sourceKeywords 必须逐字引用上方词库中的一个或多个原词。",
  ].join("\n");
}
