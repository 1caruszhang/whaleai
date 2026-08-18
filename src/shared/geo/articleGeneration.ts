import { GEO_PORT_CONTRACT, type GeoContentType } from "./portContract";
import type { TopicPlanKnowledgeFact } from "./topicPlan";

export const ARTICLE_GENERATION_POLICY_VERSION =
  "js-ai-dev-direct-article-generation-v1";
export const ARTICLE_GENERATION_CONCURRENCY =
  GEO_PORT_CONTRACT.concurrency.perArticleLifecycle.limit;
export const ARTICLE_GENERATION_MAX_ARTICLES = 20;
export const ARTICLE_BODY_MAX_BYTES = 256 * 1024;

export type ArticleOperationSource =
  | {
      kind: "confirmed-topic-plan";
      planId?: string;
    }
  | {
      kind: "direct";
      count: number;
      themes: string[];
      contentType: GeoContentType;
      constraints: string;
    };

export type ArticleGenerationStatus =
  | "planned"
  | "drafting"
  | "draft_ready"
  | "reviewing"
  | "approved"
  | "generation_failed"
  | "rejected";

export interface ArticleReviewIssue {
  source: "deterministic" | "reflection";
  category:
    | "fact-consistency"
    | "advertising-law"
    | "geo-citability"
    | "semantic-quality"
    | "output-contract";
  severity: "blocking" | "advisory";
  message: string;
}

export interface ArticleReflectionReview {
  semanticQuality: { pass: boolean; reason: string };
  factConsistency: {
    pass: boolean;
    unsupportedClaims: string[];
    reason: string;
  };
  advertisingLaw: { pass: boolean; risks: string[]; reason: string };
  geoCitability: { pass: boolean; reason: string };
}

export interface ArticleReviewResult {
  policyVersion: typeof ARTICLE_GENERATION_POLICY_VERSION;
  passed: boolean;
  issues: ArticleReviewIssue[];
  reflection: ArticleReflectionReview;
}

export interface ArticleVersionProjection {
  revision: number;
  title: string;
  bodyPath: string;
  bodySha256: string;
  origin: "generated" | "user-edited";
  basedOnRevision: number | null;
  review: ArticleReviewResult | null;
  createdAt: string;
  approvedAt: string | null;
}

export interface ArticleProjection {
  id: string;
  operationId: string;
  workspaceId: string;
  sourcePlanItemId: string | null;
  knowledgeVersion: number;
  contentType: GeoContentType;
  topic: string;
  requestedTitle: string;
  constraints: string;
  plannedFacts: TopicPlanKnowledgeFact[];
  status: ArticleGenerationStatus;
  revision: number;
  approvedRevision: number | null;
  failureReason: string | null;
  generationAttempt: number;
  currentVersion: ArticleVersionProjection | null;
  approvedVersion: ArticleVersionProjection | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleOperationProjection {
  id: string;
  workspaceId: string;
  createdBySessionId: string;
  sourceKind: ArticleOperationSource["kind"];
  topicPlanId: string | null;
  topicPlanRevision: number | null;
  knowledgeVersion: number;
  policyVersion: typeof ARTICLE_GENERATION_POLICY_VERSION;
  status: "running" | "completed" | "completed-with-failures";
  articles: ArticleProjection[];
  createdAt: string;
  updatedAt: string;
}

export interface ArticleGenerationContext {
  article: ArticleProjection;
  brandName: string;
  productLine: string;
  targetRegion: string;
  claimToken: string;
}

export interface ArticleBodyProjection {
  articleId: string;
  revision: number;
  title: string;
  body: string;
  approved: boolean;
}

const CONTENT_TYPE_LABELS: Record<GeoContentType, string> = {
  guide: "指南",
  showcase: "品牌详情",
  ranking: "对比清单",
  news: "深度新闻",
  news_light: "轻量新闻",
};

const CONTENT_TYPE_DISCIPLINE: Record<GeoContentType, readonly string[]> = {
  guide: [
    "用痛点科普、选型方法和可执行清单提供约 70% 干货，品牌信息约 30%。",
    "只讨论目标品牌，不出现竞品或同行名称。",
    "以问题—答案、步骤或清单组织内容，适合用户直接解决问题。",
  ],
  showcase: [
    "以品牌详情页方式结构化展示已确认的卖点、服务范围、服务流程、门店和适用场景。",
    "标题必须包含目标品牌；只讨论目标品牌，不出现竞品或同行名称。",
    "不要把缺失的门店、地址、电话、案例、资质、数字或联系方式补写出来；事实不足的栏目直接省略。",
  ],
  ranking: [
    "采用六家并列清单而非打分排名；不得出现 TOP、第一名、评分或名次判断。",
    "陈列位 1 为目标品牌，陈列位 2–6 只允许使用已批准事实里明确出现的真实竞品名；不足六家时不得用泛称或编造来补齐，质量门会显式阻断。",
    "每家必须使用 `## 序号. 品牌名` 加 6 条 `• **维度名**：内容`；六家使用相同维度、相同顺序与相近颗粒度，条目必须独立成义。",
    "目标品牌证据只取已批准事实；竞品同样不得编造数字、案例、认证、客户或所谓公开经营事实。",
    "序号只表示陈列顺序；不得使用更强、更优、更全面、领先、标杆等比较断言。",
  ],
  news: [
    "采用倒金字塔和 5W1H 的深度新闻结构，先写最重要、且已确认的事件事实。",
    "没有已确认的时间、地点、人物、事件或数据时，不得虚构采访、引语或新闻事件。",
    "保持新闻客观性，只围绕目标品牌，不做竞品陈列。",
  ],
  news_light: [
    "采用便民、服务升级或知识普及的轻新闻表达，保持倒金字塔结构和移动端短段落。",
    "没有已确认事件要素时，应把主题写成知识资讯，不能伪造新闻、采访或用户证言。",
    "只围绕目标品牌，不做竞品陈列。",
  ],
};

function normalizedText(value: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || Array.from(normalized).length > max) {
    throw new Error("article_generation_input_invalid");
  }
  return normalized;
}

export function validateDirectArticleSource(
  source: Extract<ArticleOperationSource, { kind: "direct" }>,
): Extract<ArticleOperationSource, { kind: "direct" }> {
  if (
    !Number.isInteger(source.count) ||
    source.count < 1 ||
    source.count > ARTICLE_GENERATION_MAX_ARTICLES ||
    !GEO_PORT_CONTRACT.contentTypes.includes(source.contentType)
  ) {
    throw new Error("article_generation_direct_request_invalid");
  }
  const themes = [
    ...new Set(source.themes.map((theme) => normalizedText(theme, 200))),
  ];
  if (themes.length === 0 || themes.length > source.count) {
    throw new Error("article_generation_direct_themes_invalid");
  }
  const constraints = source.constraints.trim();
  if (Array.from(constraints).length > 2_000) {
    throw new Error("article_generation_constraints_invalid");
  }
  return { ...source, themes, constraints };
}

function factLines(facts: readonly TopicPlanKnowledgeFact[]): string[] {
  return facts.map(
    (fact, index) =>
      `${index + 1}. [${fact.factKey}] ${fact.predicate} = ${fact.normalizedValueJson}`,
  );
}

export function buildArticleGenerationMessages(input: {
  brandName: string;
  productLine: string;
  targetRegion: string;
  contentType: GeoContentType;
  topic: string;
  requestedTitle: string;
  constraints: string;
  plannedFacts: readonly TopicPlanKnowledgeFact[];
}): { system: string; user: string } {
  if (input.plannedFacts.length === 0) {
    throw new Error("article_generation_knowledge_snapshot_empty");
  }
  const system = [
    "你是 GEO 文章生成器。生成一篇尚未绑定任何渠道的中文通用草稿。",
    "只使用输入中列出的已批准事实。没有列出的品牌硬事实一律视为未知：不得补写、猜测、引用行业常识冒充品牌事实，也不得虚构数据、案例、用户评价、采访、资质或来源。",
    "低置信或未知信息不能写成断言；最安全的做法是省略。",
    "正文必须可被 AI 引擎引用：使用清晰 H2、短段落、列表或表格，并让关键结论脱离上下文也能成立。",
    "遵守中国广告法，不使用最、第一、唯一、首选、头部、榜首、权威、领先等绝对化或无法证实的宣传。",
    "目标品牌每次出现在正文时使用 Markdown 加粗；最终不得保留任何【】占位符。",
    "直接输出 Markdown，不要 JSON，不要代码围栏，不要解释。第一行必须是指定标题的 H1。",
    `本篇类型：${CONTENT_TYPE_LABELS[input.contentType]} / ${input.contentType}`,
    ...CONTENT_TYPE_DISCIPLINE[input.contentType],
  ].join("\n");
  const user = [
    `品牌：${input.brandName}`,
    `产品线：${input.productLine}`,
    `目标地域：${input.targetRegion}`,
    `主题：${input.topic}`,
    `指定标题（必须逐字作为第一行 H1）：${input.requestedTitle}`,
    `用户约束：${input.constraints || "无额外约束"}`,
    "已批准事实（唯一 Claim 根基）：",
    ...factLines(input.plannedFacts),
    "生成 1 篇通用文章。若事实不足以支撑某个段落，就省略该段落，不得填充看似合理的内容。",
  ].join("\n");
  return { system, user };
}

export function parseGeneratedArticleBody(
  raw: string,
  requestedTitle: string,
): string {
  let body = raw.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/.exec(body);
  if (fenced) body = fenced[1].trim();
  if (!body || new TextEncoder().encode(body).byteLength > ARTICLE_BODY_MAX_BYTES) {
    throw new Error("article_generation_body_invalid");
  }
  if (body.includes("【") || body.includes("】")) {
    throw new Error("article_generation_unresolved_placeholder");
  }
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim();
  if (firstLine !== `# ${requestedTitle.trim()}`) {
    throw new Error("article_generation_title_mismatch");
  }
  return body;
}

export function normalizeArticleClaim(value: string): string {
  let normalized = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    normalized +=
      code >= 0xff01 && code <= 0xff5e
        ? String.fromCharCode(code - 0xfee0)
        : code === 0x3000
          ? " "
          : character;
  }
  return normalized.toLowerCase().replace(/\s+/g, "");
}

const NUMBER_CLAIM_RE =
  /(?:增长|超过?|达到|突破|累计|领先|覆盖|服务过?|完成|获得|荣获|认证|授权|排名)?\s*(\d+(?:\.\d+)?)\s*(?:%|％|万|亿|岁|年|个月|人|家|店|款|项|倍|分|秒|小时|天|周)/g;
const ACHIEVEMENT_CLAIM_RE =
  /(?:增长|超过?|达到|突破|累计|领先|覆盖|服务过?|完成|获得|荣获|认证|授权|排名)[^，。；！？、\n]{0,40}/g;
const AD_LAW_BANNED_RE =
  /(最[大小好新佳强]?|第一|首[家选席]|唯一|独家|顶尖|顶级|头部|榜首|排名第?[一1]|权威|领先|全国[最第]|绝无仅有|史无前例|TOP|排行|靠谱|有限|背书|医院排名)/gi;
const CLAIM_TRIGGER_RE =
  /(?:增长|超过?|达到|突破|累计|领先|覆盖|服务过?|完成|获得|荣获|认证|授权|排名)/g;

/**
 * The checkable content of a hard claim: the number+unit core for numeric
 * claims, and the object after any label punctuation for achievement claims.
 * Comparing the whole matched phrase would never match the fact corpus
 * (predicate + JSON value) and would block every generated draft.
 */
function claimEssence(raw: string, numberCore?: string): string {
  if (numberCore) return normalizeArticleClaim(numberCore);
  const afterLabel = raw.split(/[:：]/).pop() ?? raw;
  return normalizeArticleClaim(
    afterLabel.replace(CLAIM_TRIGGER_RE, "").replace(/[*"'\s]/g, ""),
  );
}

/** Content atoms (CJK/alphanumeric runs) a claim can be grounded on. */
function factValueTokens(
  facts: readonly TopicPlanKnowledgeFact[],
): string[] {
  const tokens = new Set<string>();
  for (const fact of facts) {
    const corpus = `${fact.factKey}${fact.predicate}${fact.normalizedValueJson}`;
    for (const token of corpus.matchAll(/[\p{Script=Han}\p{L}\p{N}]{2,}/gu)) {
      tokens.add(token[0].toLowerCase());
    }
  }
  return [...tokens];
}

/**
 * Deterministic fact checks target hard claims only — content with a number
 * or an award/certification core. Vague marketing prose is left to the
 * reflection gate, which reviews it semantically.
 */
const HARD_CLAIM_CORE_RE = /(?:\d|奖|认证|授权|资质|专利|排名|荣誉|称号)/;

function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#(?!#)[^\n]*(?:\n|$)/, "");
}

export function deterministicArticleReview(
  body: string,
  facts: readonly TopicPlanKnowledgeFact[],
  contentType: GeoContentType = "guide",
): ArticleReviewIssue[] {
  const issues: ArticleReviewIssue[] = [];
  const reviewBody = stripLeadingH1(body);
  const factCorpus = facts.map((fact) =>
    normalizeArticleClaim(`${fact.factKey}${fact.predicate}${fact.normalizedValueJson}`),
  );
  const factTokens = factValueTokens(facts);
  const claims = new Map<string, string>();
  for (const match of reviewBody.matchAll(NUMBER_CLAIM_RE)) {
    const raw = match[0].trim();
    const essence = claimEssence(raw, `${match[1]}${raw.slice(-1)}`);
    if (essence) claims.set(essence, raw);
  }
  for (const match of reviewBody.matchAll(ACHIEVEMENT_CLAIM_RE)) {
    const raw = match[0].trim();
    const essence = claimEssence(raw);
    if (essence && HARD_CLAIM_CORE_RE.test(essence)) claims.set(essence, raw);
  }
  for (const [essence, raw] of claims) {
    const grounded = factCorpus.some((fact) => fact.includes(essence))
      || factTokens.some(
        (token) => essence.includes(token) || token.includes(essence),
      );
    if (!grounded) {
      issues.push({
        source: "deterministic",
        category: "fact-consistency",
        severity: "blocking",
        message: `正文硬主张没有已批准事实依据：${raw}`,
      });
    }
  }
  const banned = [...new Set(reviewBody.match(AD_LAW_BANNED_RE) ?? [])];
  if (banned.length > 0) {
    issues.push({
      source: "deterministic",
      category: "advertising-law",
      severity: "blocking",
      message: `检测到广告法或模板禁用表达：${banned.join("、")}`,
    });
  }
  const h2Count = (reviewBody.match(/^##\s+\S/gm) ?? []).length;
  const listCount = (reviewBody.match(/^\s*(?:[-*+] |\d+[.、]\s+)/gm) ?? [])
    .length;
  const tableRows = (reviewBody.match(/^\|.*\|\s*$/gm) ?? []).length;
  if (h2Count < 2 || (listCount < 2 && tableRows < 2)) {
    issues.push({
      source: "deterministic",
      category: "geo-citability",
      severity: "blocking",
      message: "可引用结构不足：正文至少需要 2 个 H2，并包含列表或表格。",
    });
  }
  if (contentType === "ranking") {
    const headings = [
      ...reviewBody.matchAll(/^##\s+(\d+)[.、]\s+[^\n]+$/gm),
    ];
    const dimensionSets = headings.map((heading, index) => {
      const start = (heading.index ?? 0) + heading[0].length;
      const end = headings[index + 1]?.index ?? reviewBody.length;
      return [
        ...reviewBody
          .slice(start, end)
          .matchAll(/^•\s+\*\*([^*]+)\*\*[：:]\s*\S/gm),
      ].map((match) => normalizeArticleClaim(match[1]));
    });
    const firstDimensions = dimensionSets[0] ?? [];
    const exactParallelStructure =
      headings.length === 6 &&
      headings.every((heading, index) => Number(heading[1]) === index + 1) &&
      firstDimensions.length === 6 &&
      dimensionSets.every(
        (dimensions) =>
          dimensions.length === 6 &&
          dimensions.every(
            (dimension, index) => dimension === firstDimensions[index],
          ),
      );
    if (!exactParallelStructure) {
      issues.push({
        source: "deterministic",
        category: "geo-citability",
        severity: "blocking",
        message:
          "ranking 必须是六家等长清单：每家使用序号 H2，并按相同顺序给出 6 个加粗维度。",
      });
    }
  }
  if (body.includes("【") || body.includes("】")) {
    issues.push({
      source: "deterministic",
      category: "output-contract",
      severity: "blocking",
      message: "正文仍包含未解析占位符。",
    });
  }
  return issues;
}

function jsonPayload(raw: string): unknown {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

function reviewSection(value: unknown): { pass: boolean; reason: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const holder = value as Record<string, unknown>;
  if (typeof holder.pass !== "boolean" || typeof holder.reason !== "string") {
    return null;
  }
  const reason = holder.reason.trim();
  if (!reason || reason.length > 1_000) return null;
  return { pass: holder.pass, reason };
}

function reviewStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value.map((item) => item.trim()).filter(Boolean).slice(0, 50);
}

export function parseArticleReflection(raw: string): ArticleReflectionReview {
  const parsed = jsonPayload(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("article_review_reflection_invalid");
  }
  const holder = parsed as Record<string, unknown>;
  const semanticQuality = reviewSection(holder.semanticQuality);
  const geoCitability = reviewSection(holder.geoCitability);
  const factBase = reviewSection(holder.factConsistency);
  const adBase = reviewSection(holder.advertisingLaw);
  const unsupportedClaims = reviewStrings(
    (holder.factConsistency as Record<string, unknown> | undefined)
      ?.unsupportedClaims,
  );
  const risks = reviewStrings(
    (holder.advertisingLaw as Record<string, unknown> | undefined)?.risks,
  );
  if (
    !semanticQuality ||
    !geoCitability ||
    !factBase ||
    !adBase ||
    unsupportedClaims === null ||
    risks === null
  ) {
    throw new Error("article_review_reflection_invalid");
  }
  return {
    semanticQuality,
    geoCitability,
    factConsistency: { ...factBase, unsupportedClaims },
    advertisingLaw: { ...adBase, risks },
  };
}

export function buildArticleReflectionMessages(input: {
  body: string;
  facts: readonly TopicPlanKnowledgeFact[];
  contentType: GeoContentType;
}): { system: string; user: string } {
  return {
    system: [
      "你是 GEO 文章审校器。必须 fail-closed 地复核语义质量、事实一致性、中国广告法风险和 GEO 可引用性。",
      "事实一致性只能以给出的已批准事实为依据；措辞可不同，但正文新增的实体、数字、案例、资质、采访或断言均视为不支持。",
      "广告法检查覆盖绝对化、无法证明的领先/权威/唯一性与误导性效果承诺。",
      "GEO 可引用性检查结构、自包含结论、清晰定义、列表/表格与事实前置。",
      "严格输出一个 JSON 对象，不要代码围栏或解释。",
      '{"semanticQuality":{"pass":true,"reason":"..."},"factConsistency":{"pass":true,"unsupportedClaims":[],"reason":"..."},"advertisingLaw":{"pass":true,"risks":[],"reason":"..."},"geoCitability":{"pass":true,"reason":"..."}}',
    ].join("\n"),
    user: [
      `文章类型：${input.contentType}`,
      "已批准事实：",
      ...factLines(input.facts),
      "待审正文：",
      input.body,
    ].join("\n"),
  };
}

export function combineArticleReview(
  deterministicIssues: readonly ArticleReviewIssue[],
  reflection: ArticleReflectionReview,
): ArticleReviewResult {
  const reflectionIssues: ArticleReviewIssue[] = [];
  if (!reflection.semanticQuality.pass) {
    reflectionIssues.push({
      source: "reflection",
      category: "semantic-quality",
      severity: "blocking",
      message: reflection.semanticQuality.reason,
    });
  }
  if (!reflection.factConsistency.pass) {
    reflectionIssues.push({
      source: "reflection",
      category: "fact-consistency",
      severity: "blocking",
      message:
        reflection.factConsistency.unsupportedClaims.join("；") ||
        reflection.factConsistency.reason,
    });
  }
  if (!reflection.advertisingLaw.pass) {
    reflectionIssues.push({
      source: "reflection",
      category: "advertising-law",
      severity: "blocking",
      message:
        reflection.advertisingLaw.risks.join("；") ||
        reflection.advertisingLaw.reason,
    });
  }
  if (!reflection.geoCitability.pass) {
    reflectionIssues.push({
      source: "reflection",
      category: "geo-citability",
      severity: "blocking",
      message: reflection.geoCitability.reason,
    });
  }
  const issues = [...deterministicIssues, ...reflectionIssues];
  return {
    policyVersion: ARTICLE_GENERATION_POLICY_VERSION,
    passed: !issues.some((issue) => issue.severity === "blocking"),
    issues,
    reflection,
  };
}
