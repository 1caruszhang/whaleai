import { GEO_PORT_CONTRACT, type GeoContentType } from "./portContract";
import {
  materialImageCategoryLabel,
  type MaterialImageCategoryCode,
} from "./materialImages";
import { scanMaterialImagePlaceholders } from "./materialImagePlaceholder";
import { removeSpans } from "./textSpans";
import { projectBrandProfile, resolveBrandName } from "./profileInjection";
import {
  TITLE_STYLE_DEFINITIONS,
  titleBusinessAnchors,
  type TopicPlanKnowledgeFact,
} from "./topicPlan";

export const ARTICLE_GENERATION_POLICY_VERSION =
  "xiaojing-content-prompt-v7";
export const ARTICLE_GENERATION_CONCURRENCY =
  GEO_PORT_CONTRACT.concurrency.perArticleLifecycle.limit;
export const ARTICLE_GENERATION_MAX_ARTICLES = 20;
export const ARTICLE_BODY_MAX_BYTES = 256 * 1024;
/**
 * 单篇正文提示词注入的配图候选上限（ADR-0008 T4）：候选池本身可更大，
 * 注入按入池时间倒序截到此数，避免挤占正文生成的 token 预算。
 */
export const ARTICLE_IMAGE_CANDIDATE_INJECTION_LIMIT = 50;

export type ArticleOperationSource =
  | {
      kind: "confirmed-topic-plan";
      planId?: string;
      /**
       * 本次消费的计划项子集（生成时选取，票 #34）：缺省 = 该 plan 的全部
       * selectedItemIds；传入时必须是 selectedItemIds 的子集且逐项 approved。
       * 确认的 plan 冻结的是「有资格生成」，不是「必须全部生成」。
       */
      itemIds?: string[];
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
  | "rejected"
  /** 用户显式弃用（票 #34）：终态，不进分发计划；approved 不可弃用。 */
  | "discarded";

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
  /** 反思 LLM 审核（格式-only 模式下省略）。 */
  reflection?: ArticleReflectionReview;
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
  /**
   * ranking 维度骨架（ADR-0009 Decision 2）：生成期注入的 6 维清单随文
   * 落库，批准门复检对照；非 ranking 或存量稿为 null。
   */
  rankingDimensions?: string[] | null;
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

/**
 * 五类写作规范三段式（ADR-0006 §3「事实从紧、表达从宽」）：
 * 格式契约=确定性可校验的结构硬约束；表达参考=写作工艺（骨架非填空）；
 * 事实衔接=与事实纪律的边界。纯数据形态，便于未来抽为 md/yaml 资产。
 */
const CONTENT_TYPE_CONTRACTS: Record<
  GeoContentType,
  {
    format: readonly string[];
    expression: readonly string[];
    fact: readonly string[];
  }
> = {
  guide: {
    format: [
      "以问题—答案、步骤或清单组织内容，正文至少 3 个 H2 小标题。",
      "小标题口语化、直击读者疑问，不使用书面腔。",
      "关键词与核心结论适度加粗（每屏至多 1–2 处）。",
    ],
    expression: [
      "约 70% 干货（痛点科普、选型方法、可执行清单）+ 约 30% 品牌信息，品牌以「内行人」身份出现。",
      "用发现式语气与场景化描述，把优势转译成读者的日常场景；情绪自然，遇到行业通病可以直说。",
      "短段落（每段不超过 3 句），段落间留白，便于扫读与被 AI 引擎整段摘录。",
      "正文总字数控制在 1800–2100 字。",
      "单独一段不少于 100 字的行业报告：分析行业现状与未来趋势，自然融入品牌的行业站位。",
      "首段嵌入 1–2 个关键词，与品牌形成强关联；关键词变体每 500 字自然出现 1 次，均匀分布（覆盖全局每 300 字基线）。",
    ],
    fact: ["只讨论目标品牌，不出现竞品或同行名称。"],
  },
  showcase: {
    format: [
      "以品牌详情页方式组织：核心卖点、服务范围、服务流程、门店/适用场景等栏目，正文至少 3 个 H2。",
      "卖点用 ✅ 或列表逐条呈现，颗粒度一致。",
    ],
    expression: [
      "结构化展示品牌全貌，语言具体可感——把每条卖点写成一个可验证的细节，而不是口号。",
      "短段落（每段不超过 3 句），重要栏目用列表。",
      "正文总字数控制在 1800–2100 字。",
    ],
    fact: [
      "标题必须包含目标品牌；只讨论目标品牌，不出现竞品或同行名称。",
      "不要把缺失的门店、地址、电话、案例、资质、数字或联系方式补写出来；事实不足的栏目直接省略。",
    ],
  },
  ranking: {
    format: [
      "采用六家并列清单而非打分排名；不得出现 TOP、第一名、评分或名次判断。",
      "陈列位 1 为目标品牌，陈列位 2–6 只允许使用已批准事实里明确出现的真实竞品名；不足六家时不得用泛称或编造来补齐，质量门会显式阻断。",
      "每家必须使用 `## 序号. 品牌名` 小节，加 6 条维度条目；每条维度独立成行、行首左对齐，用标准 Markdown 列表符写作 `- **维度名**：内容`（禁止用 •、● 等圆点字符起行，禁止用表格）；六家维度颗粒度相近，条目必须独立成义。",
      "6 个维度名必须逐字使用输入「本篇维度清单」给出的名称并保持其顺序（ADR-0009 骨架注入：清单是本篇固定骨架，不得增删、改名、调序或自行另选维度）。",
      "标题含数字（如「六家」「六大」）时，正文必须严格出现对应数量的陈列 H2，一个不多一个不少。",
      "证据分层（js_ai ADR-0030 竞品客观陈述）：目标品牌每条用「命名+数字」写完整闭环，证据只取已批准事实；竞品（陈列位 2–6）证据放宽——用公开可核验的经营事实与行业常识可推断的客观描述（产品矩阵、品类定位、工艺特点、场景适配、区域覆盖、服务能力等），严禁编造具体数字、案例、认证、客户名单。",
      "竞品条目禁占位话术：「暂未公开」「无从核实」「建议实地考察」类填充一律禁止；「品质卓越」「口碑良好」类空话同样禁止——每条必须是具体的经营信息，与目标品牌同框架、同维度、同顺序。",
      "隐性优势编排：目标品牌信息密度写足（命名+数字闭环）、竞品以定性+品类描述为主；目标品牌最强维度放第一家第一条（首因效应）；竞品不每条都写局限——两三条写专精优势、一两条写客观局限（不得出现「劣势」二字、不得贬低同行）；全文不得使用更强、更优、更全面、领先、标杆等明面比较断言。",
    ],
    expression: [
      "引言以行业现状与格局概述开篇（不少于 100 字），建立行业视角后再引出陈列。",
      "每家叙述约 320 字、每条维度 50–55 字（单条不短于 45 字以保证证据可核验），六家颗粒度一致。",
      "首段嵌入 1–2 个关键词；关键词变体每 300 字自然出现 1 次并加粗。",
      "全文倒数第三段写选型建议：先列出「选型应重点考察的维度」（与目标品牌的强项维度对齐），再用条件句点首位（「若你的需求是 XX，陈列首位的 XX 在证据完整度上更扎实」），并给出「需求偏垂直/单一场景时对照各家专精程度权衡」；目标品牌在选型段引用的数字/资质须与陈列位 1 一致。",
      "短段落与留白，全文控制在 2500 字以内。",
    ],
    fact: [],
  },
  news: {
    format: [
      "倒金字塔结构：最重要的已确认事实放首段，其后按重要性递减。",
      "导语完整包含 5W1H（时间、地点、人物、事件、原因、结果）；主体分 3–4 个小标题递进，小标题简洁（8 字以内）；结尾总结事件价值。",
      "正文至少 2 个 H2；关键事实前置。",
    ],
    expression: [
      "保持新闻客观语调，用具体已确认事实支撑叙述。",
      "短段落（每段不超过 3 句）。",
      "导语不超过 200 字、主体约 1400 字、结尾不超过 250 字，全文控制在 1800–2100 字。",
      "关键词每 300 字自然出现 1 次，密度控制在 2%–5%，搭配长尾词，避免生硬堆砌。",
    ],
    fact: [
      "没有已确认的时间、地点、人物、事件或数据时，不得虚构采访、引语或新闻事件。",
      "只围绕目标品牌，不做竞品陈列。",
    ],
  },
  news_light: {
    format: [
      "倒金字塔 + 移动端短段落（每段不超过 3 句）。",
      "导语完整包含 5W1H 要素，详细细节后置。",
      "正文至少 2 个 H2 或清晰分节。",
    ],
    expression: [
      "便民、服务升级或知识普及的轻新闻口吻，贴近日常表达。",
      "全文篇幅控制在 1800–2100 字。",
      "关键词变体或长尾词每 200 字左右自然出现 1 次，密度控制在 2%–5%；品牌名均匀分布全文，避免集中堆砌。",
    ],
    fact: [
      "没有已确认事件要素时，应把主题写成知识资讯，不能伪造新闻、采访或用户证言。",
      "只围绕目标品牌，不做竞品陈列。",
    ],
  },
};

/** 叙事视角种子（ADR-0006 §3 同质化防线）：两维表达指引，只影响表达层。 */
export interface ArticleNarrativeSeed {
  angle: string;
  hook: string;
  subtitleTendency: string;
}

/**
 * 行首列表模拟符归一为标准 Markdown 列表符：生成模型（尤其 lite 档）常以
 * •、●、· 等圆点字符或 ✅ 对勾起行模拟列表，而 Markdown 渲染器不识别这
 * 类起行——相邻行还会被合并成连排段落（「正文格式混乱」主因）。在正文
 * 解析期归一，落库正文即为标准列表，预览/导出/发布全链路受益。
 * 只处理行首符号（后跟空白），正文中间的间隔号（如人名）与句中 ✅ 不受
 * 影响；✅ 归一为列表项后保留在条目文本里（showcase 卖点的对勾语义是
 * 内容契约的一部分，审查门 listCount 也按此形态计数）。
 */
export function normalizeUnicodeBulletsToMarkdown(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(\s*)(?:[•●·◦‧‣])\s+/, "$1- ")
        .replace(/^(\s*)✅\s+/, "$1- ✅ "),
    )
    .join("\n");
}

/**
 * 配图候选（ADR-0008 Decision 3）：材料图片候选池条目的提示词投影——
 * 生成模型只看这份纯文字清单，不看图片本体。MaterialImageAsset 结构上
 * 满足本接口，服务层可直接透传。
 */
export interface ArticleImageCandidate {
  id: string;
  /** 视觉打标产出的一句中文描述。 */
  description: string;
  /** 类型标签（可选）：帮助模型判断与正文段落的相关性。 */
  category?: MaterialImageCategoryCode;
  /** 来源材料名（展示候选出处）。 */
  sourceMaterialName: string;
}

/**
 * 类型级配图配额（用户裁决 2026-08-31）：详情/指南 3–8 张、新闻类 3 张、
 * 对比清单 1 张（排行类候选池只有品牌自家图，配在竞品小节会误导，只允许
 * 目标品牌段落配图）。配额是「目标张数上限」，候选池不足时按池弹性下调
 * （池只有 1 张就配 1 张，池空零配图），绝不虚构清单外图片。
 */
export const ARTICLE_IMAGE_QUOTA_BY_TYPE: Readonly<Record<GeoContentType, number>> = {
  guide: 8,
  showcase: 8,
  ranking: 1,
  news: 3,
  news_light: 3,
};

/**
 * 配图纪律（ADR-0008 Decision 3，2026-08-31 按类型配额重写）：按类型
 * 配额 + 池感知弹性。仅在候选清单非空时注入——无候选时零配图是唯一
 * 合法结果，不提示图片能力。
 */
export function articleIllustrationContract(
  contentType: GeoContentType,
  poolSize: number,
): readonly string[] {
  const quota = ARTICLE_IMAGE_QUOTA_BY_TYPE[contentType];
  const target = Math.min(quota, Math.max(poolSize, 1));
  return [
    "只能使用「配图候选清单」中列出的图片；引用一律用标准 Markdown 图片语法：![alt 文本](material-image://图片ID)，图片ID 逐字复制候选清单，不得自造、改写或使用清单外地址。",
    "alt 文本由你撰写：一句话说明图片内容及其与所在段落的关系。",
    `本篇配图目标 ${target} 张（类型配额上限 ${quota} 张，已按候选池 ${poolSize} 张弹性取小）：第一张放在开篇综述之后的首屏位置，其余逐一紧随其阐释的栏目段落，占位符独立成行。`,
    "选图依据候选清单每条图片的「描述」与「类型」字段：挑与所在段落语义最相关的图片，同一篇内不得重复引用同一张图片。",
    poolSize < quota
      ? `候选清单只有 ${poolSize} 张，从中选用 1–${poolSize} 张均可；确实无相关位置时可以少配，但绝不虚构清单外图片。`
      : "没有强相关位置时可以少配，但不得为凑数在不相关段落插图。",
    ...(contentType === "ranking"
      ? ["对比清单类型：只能给目标品牌所在小节配图，绝不给竞品小节配图（候选池均为品牌自家图片，配在竞品段会误导读者）。"]
      : []),
  ];
}

export const ARTICLE_NARRATIVE_SEEDS: readonly ArticleNarrativeSeed[] = [
  { angle: "从行业现状切入", hook: "以行业现状与格局概述开篇，点出趋势", subtitleTendency: "中性陈述式（现状—痛点—方法）" },
  { angle: "从用户痛点切入", hook: "以典型客户的痛点场景开篇，引出需求", subtitleTendency: "口语问句式" },
  { angle: "从趋势对比切入", hook: "以新旧做法对比开篇，突出行业演进", subtitleTendency: "对比式" },
  { angle: "从场景化切入", hook: "以一个具体使用场景开篇，带入服务价值", subtitleTendency: "场景标签式" },
  { angle: "从选型困惑切入", hook: "以「面对众多选择如何判断」开篇，建立对比框架", subtitleTendency: "步骤式（第一步/第二步）" },
  { angle: "从避坑经验切入", hook: "以常见踩坑经历开篇，给出判断依据", subtitleTendency: "忠告式" },
  { angle: "从成本账切入", hook: "以价格与花费构成开篇，算一笔明白账", subtitleTendency: "账目式（钱花在哪/怎么省）" },
  { angle: "从流程科普切入", hook: "以服务全流程走一遍开篇", subtitleTendency: "流程节点式" },
  { angle: "从疑问解答切入", hook: "以高频疑问开篇，逐条展开", subtitleTendency: "问答式" },
  { angle: "从人群适配切入", hook: "以某类人群的具体处境开篇", subtitleTendency: "人群标签式" },
  { angle: "从时机切入", hook: "以什么时机做最合适开篇", subtitleTendency: "时机式" },
  { angle: "从效果预期切入", hook: "以做完能有什么变化开篇", subtitleTendency: "前后对比式" },
];

export function shuffledNarrativeSeeds(
  rng: () => number = Math.random,
): ArticleNarrativeSeed[] {
  const deck = [...ARTICLE_NARRATIVE_SEEDS];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** 同批洗牌发牌：一副发尽后重新洗牌继续，保证同批尽量不重复。 */
export function dealNarrativeSeeds(
  count: number,
  rng: () => number = Math.random,
): ArticleNarrativeSeed[] {
  const dealt: ArticleNarrativeSeed[] = [];
  while (dealt.length < count) {
    dealt.push(...shuffledNarrativeSeeds(rng).slice(0, count - dealt.length));
  }
  return dealt;
}

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

export interface RankingRoster {
  targetBrand: string;
  competitors: string[];
}

export interface RankingCompetitorIdentity {
  workspaceBrandName: string;
  fullNames: readonly string[];
  shortNames: readonly string[];
  relatedBrands: readonly string[];
}

function normalizeEntityName(value: string): string {
  return normalizeArticleClaim(value.replace(/[*`_~]/g, ""));
}

function sameOrNestedEntityName(left: string, right: string): boolean {
  return left === right || left.includes(right) || right.includes(left);
}

/**
 * 所有 Node 排行榜入口共用的有效竞品规则。跨 Rust 边界仍由同一组契约
 * 用例约束：去空、去重，并排除 workspace 名、身份别名和关联主体。
 */
export function filterValidRankingCompetitors(
  names: readonly string[],
  identity: RankingCompetitorIdentity,
): string[] {
  const excluded = [
    identity.workspaceBrandName,
    ...identity.fullNames,
    ...identity.shortNames,
    ...identity.relatedBrands,
  ]
    .map(normalizeEntityName)
    .filter(Boolean);
  const seen = new Set<string>();
  return names.filter((name) => {
    const normalized = normalizeEntityName(name);
    if (
      !normalized ||
      seen.has(normalized) ||
      excluded.some((blocked) => sameOrNestedEntityName(normalized, blocked))
    ) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

/**
 * 两层竞品合并（ADR-0007，与 Rust `valid_ranking_competitors` 同构、由
 * rankingCompetitorContractCases.json 共同约束）：直接层在前，潜在层
 * 补位；跨层按归一名嵌套互斥（张仔纪/张纪仔类变体不留双份），身份/关联
 * 主体排除两层共用。
 */
export function mergeRankingCompetitorTiers(
  directNames: readonly string[],
  potentialNames: readonly string[],
  identity: RankingCompetitorIdentity,
): string[] {
  const direct = filterValidRankingCompetitors(directNames, identity);
  const directNormalized = direct.map(normalizeEntityName);
  return [
    ...direct,
    ...filterValidRankingCompetitors(potentialNames, identity).filter(
      (name) => {
        const normalized = normalizeEntityName(name);
        return !directNormalized.some((kept) =>
          sameOrNestedEntityName(normalized, kept),
        );
      },
    ),
  ];
}

/**
 * ranking 的唯一名单投影：目标品牌来自身份事实（无身份事实才回退 workspace
 * 名），竞品来自 immutable plannedFacts 中已确认的 competitors（直接层），
 * 不足 5 家时用 potentialCompetitors（潜在层，相近场景/替代品类）按序补足
 * ——两层都只含真实检索来源的名称（ADR-0007 两层名单，用户裁决 2026-08-30）。
 * 选五家时保持「直接层在前、补位在后」的顺序；正文可自由调整这五家在
 * 陈列位 2–6 的顺序。
 */
export function resolveRankingRoster(
  facts: readonly TopicPlanKnowledgeFact[],
  workspaceBrandName: string,
): RankingRoster {
  const profile = projectBrandProfile(facts);
  const targetBrand = resolveBrandName(profile, workspaceBrandName).trim();
  const competitors = mergeRankingCompetitorTiers(
    profile.competitors ?? [],
    profile.potentialCompetitors ?? [],
    {
      workspaceBrandName,
      fullNames: profile.fullName ?? [],
      shortNames: profile.shortNames ?? [],
      relatedBrands: profile.relatedBrands ?? [],
    },
  );
  if (competitors.length < 5) {
    throw new Error(
      `article_generation_ranking_competitors_insufficient:${competitors.length}`,
    );
  }
  return { targetBrand, competitors: competitors.slice(0, 5) };
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
  /** renderBrandIdentityBlock 产出（实体层身份，恒注入；ADR-0006 事实三层纪律）。 */
  identityBlock?: string;
  /** 本篇叙事视角种子；只影响开篇与表达，不放松硬纪律。 */
  narrativeSeed?: ArticleNarrativeSeed;
  /**
   * 配图候选清单（ADR-0008 T4）：非空时注入候选清单与配图纪律；
   * 空或缺省时不注入任何配图提示（零配图路径）。
   */
  imageCandidates?: readonly ArticleImageCandidate[];
  /**
   * ranking 维度骨架（ADR-0009 Decision 2）：生成前由维度选定小调用产
   * 出、字面注入。ranking 类型必填——缺省抛错而非回退「模型自选」（自
   * 选正是六维漂移的来源）。
   */
  rankingDimensions?: readonly string[];
}): { system: string; user: string } {
  if (input.plannedFacts.length === 0) {
    throw new Error("article_generation_knowledge_snapshot_empty");
  }
  if (input.contentType === "ranking" && !input.rankingDimensions) {
    throw new Error("article_generation_ranking_dimensions_missing");
  }
  const contract = CONTENT_TYPE_CONTRACTS[input.contentType];
  const hasImageCandidates = (input.imageCandidates?.length ?? 0) > 0;
  const system = [
    "你是 GEO 文章写作专家。生成一篇尚未绑定任何渠道的中文通用草稿。",
    "只使用输入中列出的已批准事实。没有列出的品牌硬事实一律视为未知：不得补写、猜测、引用行业常识冒充品牌事实，也不得虚构数据、案例、用户评价、采访、资质或来源。",
    "低置信或未知信息不能写成断言；最安全的做法是省略。",
    "【事实三层纪律】品牌名、地址、联系方式等实体信息原样使用不得转述；产品、优势、案例等语义事实可以自由改写表达（含泛化修辞），但不得捏造事实里没有的具体数字、日期、奖项/认证/机构名称；语义不得加码。",
    "【骨架非填空】类型规范是参考骨架而非填空表：按主题重组结构、调整叙述顺序与小标题措辞、用自己的语言展开，不得逐段照搬规范里的任何示例表述。",
    "正文必须可被 AI 引擎引用：使用清晰 H2、短段落、列表或表格，并让关键结论脱离上下文也能成立。",
    "保持可读节奏：每约 200 字变换角度或推进下一个点，不把多个意思挤在同一段。",
    "遵守中国广告法，不使用最、第一、唯一、首选、头部、榜首、权威、领先等绝对化或无法证实的宣传。",
    "目标品牌每次出现在正文时使用 Markdown 加粗；地域与核心关键词在首次出现及作为关键论据时适度加粗，核心关键词全文自然分布（约每 300 字 1 次，类型规范另有频率的从其规定）；除品牌名与对比清单的维度名外，单一加粗实体全文不超过 3 次；H2 小标题不加粗（用 ## 即可）。",
    "最终不得保留任何【】占位符。",
    "直接输出 Markdown，不要 JSON，不要代码围栏，不要解释。第一行必须是指定标题的 H1。",
    "列表必须用标准 Markdown 语法（行首 `- ` 或 `1. `）；禁止用 •、●、· 等圆点字符起行模拟列表——圆点起行在渲染器里只是密集段落。",
    `本篇类型：${CONTENT_TYPE_LABELS[input.contentType]} / ${input.contentType}`,
    "格式契约（必须完全满足）：",
    ...contract.format.map((rule) => `- ${rule}`),
    "表达参考（写作工艺，风格自由）：",
    ...contract.expression.map((rule) => `- ${rule}`),
    ...(contract.fact.length > 0
      ? ["事实衔接：", ...contract.fact.map((rule) => `- ${rule}`)]
      : []),
    ...(hasImageCandidates
      ? [
          "配图纪律（必须完全满足）：",
          ...articleIllustrationContract(
            input.contentType,
            input.imageCandidates?.length ?? 0,
          ).map((rule) => `- ${rule}`),
        ]
      : []),
  ].join("\n");
  const seedBlock = input.narrativeSeed
    ? [
        "",
        "## 本篇叙事视角（仅影响开篇与表达，不放松任何硬纪律）",
        `切入角度：${input.narrativeSeed.angle}`,
        `开篇写法：${input.narrativeSeed.hook}`,
        `小标题措辞倾向：${input.narrativeSeed.subtitleTendency}`,
      ].join("\n")
    : "";
  const rankingRoster =
    input.contentType === "ranking"
      ? resolveRankingRoster(input.plannedFacts, input.brandName)
      : null;
  const rankingRosterBlock = rankingRoster
    ? [
        "",
        "## 本篇排行榜固定名单（实体集合硬约束）",
        `目标品牌固定为陈列位 1：${rankingRoster.targetBrand}`,
        `陈列位 2–6 只能使用这五家已确认竞品：${rankingRoster.competitors.join("、")}`,
        "五家竞品在陈列位 2–6 的顺序可自由调整；不得缺失、重复、替换或加入名单外品牌。",
      ]
    : [];
  const rankingDimensionsBlock =
    input.contentType === "ranking" && input.rankingDimensions
      ? [
          "",
          "## 本篇维度清单（六家逐字共用的固定骨架，顺序保持如下）",
          ...input.rankingDimensions.map(
            (name, index) => `${index + 1}. ${name}`,
          ),
        ]
      : [];
  const user = [
    ...(input.identityBlock ? [input.identityBlock, ""] : []),
    `品牌：${input.brandName}`,
    `产品线：${input.productLine}`,
    `目标地域：${input.targetRegion}`,
    `主题：${input.topic}`,
    `指定标题（必须逐字作为第一行 H1）：${input.requestedTitle}`,
    `用户约束：${input.constraints || "无额外约束"}`,
    seedBlock,
    ...rankingRosterBlock,
    ...rankingDimensionsBlock,
    "",
    "已批准事实（唯一 Claim 根基）：",
    ...factLines(input.plannedFacts),
    ...(hasImageCandidates
      ? [
          "",
          "配图候选清单（材料图片，仅供选用；你看不到图片本体，仅凭描述、类型与来源材料判断与正文段落的相关性）：",
          ...(input.imageCandidates ?? []).map(
            (candidate) =>
              `- 图片ID ${candidate.id}${
                candidate.category
                  ? `｜类型 ${materialImageCategoryLabel(candidate.category)}`
                  : ""
              }｜来源材料 ${candidate.sourceMaterialName}｜描述 ${candidate.description}`,
          ),
        ]
      : []),
    "生成 1 篇通用文章。若事实不足以支撑某个段落，就省略该段落，不得填充看似合理的内容。",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  return { system, user };
}

export const RANKING_DIMENSION_COUNT = 6;

/**
 * 维度选定小调用（ADR-0009 Decision 2 骨架注入）：生成正文前现选 6 个
 * 维度名字面注入 prompt——模型从「默写自己的内部计划六遍」变为「抄眼前
 * 一份清单」。每次现选保跨文章多样性（与叙事种子 ADR-0006 §3 同哲学，
 * 重试重发一组）；同篇内六家共用一套维度本就是产品要求。
 */
export function buildRankingDimensionMessages(input: {
  /** 禁止用作维度的品牌名集合：目标品牌全称/简称 + 本次竞品名单（ADR-0009：维度调用输入含品牌事实）。 */
  brandNames: readonly string[];
  productLine: string;
  targetRegion: string;
  topic: string;
}): { system: string; user: string } {
  const system = [
    "你是行业选型顾问。为「六家并列盘点」类文章选定 6 个对比维度名。",
    "要求：维度按本行业客户选品/决策的真实关切拟定，不照搬通用示例（如价格、服务、口碑三个词的任意组合）；名称 2–10 个字的名词短语；六者互不重叠、合起来覆盖决策全景；不得包含输入里列出的任何品牌名。",
    "直接输出 JSON 数组（恰好 6 个字符串），不要解释，不要代码围栏。",
  ].join("\n");
  const user = [
    `行业：${input.productLine}`,
    `目标地域：${input.targetRegion}`,
    `盘点主题：${input.topic}`,
    `以下品牌名仅作行业语境参考，一律禁止用作维度：${input.brandNames.join("、")}`,
    "输出 6 个维度名组成的 JSON 数组。",
  ].join("\n");
  return { system, user };
}

/**
 * 维度清单解析与校验：恰好 6 条、每条 2–10 字、不含加粗/占位符标记，
 * 归一化后无重复。非法输出 fail-loud（与 direct 标题候选同哲学），不降
 * 级为「模型自选」——自选正是六维漂移的来源。
 */
export function parseRankingDimensions(raw: string): string[] {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("article_generation_ranking_dimensions_invalid_json");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== RANKING_DIMENSION_COUNT ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new Error("article_generation_ranking_dimensions_invalid_shape");
  }
  const dimensions = (parsed as string[]).map((item) => item.trim());
  if (
    dimensions.some(
      (name) =>
        name.length < 2 ||
        name.length > 10 ||
        /[*【】`#]/.test(name),
    ) ||
    new Set(dimensions.map(normalizeArticleClaim)).size !== RANKING_DIMENSION_COUNT
  ) {
    throw new Error("article_generation_ranking_dimensions_invalid_value");
  }
  return dimensions;
}

/**
 * 有界修复 pass 的 prompt（ADR-0009 Decision 3）：输入正文草稿与确定性
 * 审核的 blocking 问题清单，只修清单内问题、其余逐字保留。修复输出仍要
 * 过 parseGeneratedArticleBody（H1 标题、占位符等校验不豁免）——prompt
 * 里的首行 H1 与占位符约束就是为此写死的。
 */
export function buildArticleRepairMessages(input: {
  contentType: GeoContentType;
  requestedTitle: string;
  /** parse 后（已过确定性修复）的正文草稿。 */
  body: string;
  /** blocking 问题清单（message 逐字注入）。 */
  issues: readonly { message: string }[];
  /** ranking 实体名单说明（服务端由 resolveRankingRoster 拼装；其他类型缺省）。 */
  rosterNote?: string;
  /** ranking 维度骨架说明（ADR-0009 Decision 2；门的消息不含维度名，须另行注入）。 */
  dimensionNote?: string;
}): { system: string; user: string } {
  if (input.issues.length === 0) {
    throw new Error("article_repair_issues_empty");
  }
  const system = [
    "你是文章格式修复器。你会收到一篇已生成的文章草稿与一份「无法通过确定性审核的具体问题清单」。你的唯一任务是把清单里的问题全部修掉；其余内容逐字保留——不改写段落措辞、不增删事实或卖点、不调整配图、不润色。",
    "输出要求：",
    "- 直接输出修复后的完整文章（plain Markdown）：不要 JSON、不要代码围栏、不要任何解释、前言或后缀。",
    `- 首行必须是指定标题的 H1，逐字一致。`,
    "- 不得引入【】占位符；配图语法 ![alt](material-image://图片ID) 一律原样保留，不得增删。",
    "- 列表用标准 Markdown 语法（行首 `- ` 或 `1. `），禁止用 •、●、· 等圆点字符起行。",
    `本篇类型：${CONTENT_TYPE_LABELS[input.contentType]} / ${input.contentType}`,
    "输出前自查：问题清单逐条核对，确保每条都已解决。",
  ].join("\n");
  const user = [
    "## 指定标题（首行 H1 逐字）",
    `# ${input.requestedTitle}`,
    "",
    "## 待修复问题（必须全部解决，逐条核对）",
    ...input.issues.map((issue) => `- ${issue.message}`),
    ...(input.rosterNote ? ["", "## 名单硬约束", input.rosterNote] : []),
    ...(input.dimensionNote ? ["", "## 维度硬约束", input.dimensionNote] : []),
    "",
    "## 正文草稿（除清单问题外，其余内容逐字保留）",
    input.body,
  ].join("\n");
  return { system, user };
}

/** H1 匹配用标题归一：忽略全部空白（含全角空格），只比对实质字符。 */
export function normalizeTitleIdentity(value: string): string {
  return value.replace(/[\s\u3000]+/g, "");
}

export function parseGeneratedArticleBody(
  raw: string,
  requestedTitle: string,
): string {
  let body = raw.trim();
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/.exec(body);
  if (fenced) body = fenced[1].trim();
  // 圆点起行归一为标准列表（见 normalizeUnicodeBulletsToMarkdown 注释）：
  // 必须先于一切校验/落库，让确定性审查门与渲染器看到的是标准 Markdown。
  body = normalizeUnicodeBulletsToMarkdown(body);
  if (!body || new TextEncoder().encode(body).byteLength > ARTICLE_BODY_MAX_BYTES) {
    throw new Error("article_generation_body_invalid");
  }
  if (body.includes("【") || body.includes("】")) {
    throw new Error("article_generation_unresolved_placeholder");
  }
  // ADR-0008 T4：material-image:// 是受控 uri scheme——标准 Markdown 图片
  // 语法放行；scheme 的一切逃逸用法（裸文本/普通链接/坏 id）按未解析
  // 占位符拒绝。【】之外的其他文本占位符禁令保持不变。
  if (scanMaterialImagePlaceholders(body).violations.length > 0) {
    throw new Error("article_generation_image_placeholder_invalid");
  }
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim();
  // 标题实质字符一致即通过（2026-08-18 裁定）：lite 模型复现 H1 时常有
  // 半角/全角空格偏差，逐字符相等会把整次生成打入重试循环。
  if (
    normalizeTitleIdentity(firstLine ?? "") !==
    normalizeTitleIdentity(`# ${requestedTitle.trim()}`)
  ) {
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

const MIN_H2_BY_TYPE: Record<GeoContentType, number> = {
  guide: 3,
  showcase: 3,
  ranking: 6,
  news: 2,
  news_light: 2,
};

/**
 * 品牌名保真检查（ADR-0006 事实三层纪律实体层）：正文里每次品牌指称
 * 必须逐字命中全称/已确认简称并加粗。标题行（H1/小标题）不计。
 * 盲区（ADR-0009 与自动加粗对齐）：围栏代码块、已有加粗块、图片语法
 * （alt 不是正文指称）、链接 URL 括号段——链接文本仍计（加粗链接文本
 * 是合法排版，autoBoldBrandMentions 会处理）。
 */
const BOLD_SPAN_RE = /\*\*[^*\n]+\*\*/g;
const IMAGE_SYNTAX_RE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const LINK_SYNTAX_RE = /\[[^\]\n]*\]\([^)\n]*\)/g;

function lineBrandMentionBlindSpots(line: string): Array<[number, number]> {
  const spots: Array<[number, number]> = [];
  for (const match of line.matchAll(BOLD_SPAN_RE)) {
    const start = match.index ?? 0;
    spots.push([start, start + match[0].length]);
  }
  for (const match of line.matchAll(IMAGE_SYNTAX_RE)) {
    const start = match.index ?? 0;
    spots.push([start, start + match[0].length]);
  }
  for (const match of line.matchAll(LINK_SYNTAX_RE)) {
    const start = match.index ?? 0;
    // 只护 URL 括号段：match[0] 的最后一个 "(" 必是 URL 起始（URL 段
    // 不含 ")"，链接文本里的 "(" 都在它之前）。
    spots.push([start + match[0].lastIndexOf("("), start + match[0].length]);
  }
  return spots;
}

/**
 * 品牌指称的行分类（门与自动加粗共用同一遍历，防两侧盲区语义漂移）：
 * 围栏代码块（含围栏行自身）与标题行整体跳过，其余为可检查行。
 */
function brandMentionLines(
  body: string,
): Array<{ line: string; checkable: boolean }> {
  let inFence = false;
  return body.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return { line, checkable: false };
    }
    return {
      line,
      checkable: !(inFence || line.trimStart().startsWith("#")),
    };
  });
}

function unboldedBrandMentions(
  body: string,
  brandNames: readonly string[],
): string[] {
  const remainder = brandMentionLines(body)
    .filter((entry) => entry.checkable)
    .map((entry) =>
      removeSpans(entry.line, lineBrandMentionBlindSpots(entry.line)),
    )
    .join("\n");
  return [
    ...new Set(
      brandNames
        .filter((name) => name.trim().length >= 2)
        .filter((name) => remainder.includes(name.trim())),
    ),
  ];
}

/**
 * 品牌名自动加粗（ADR-0009 Decision 1）：加粗从「模型纪律」降格为
 * 「管线保证」。在 parse 后对正文里所有逐字出现的全称/已确认简称包
 * `**`，跳过与审核门一致的盲区（标题行、围栏代码块、已有加粗块、
 * 图片语法、链接 URL）。长名优先：先包全称再包简称，防止简称是全称
 * 子串时把全称拦腰截断。子串命中与门的 includes 语义一致——门如此
 * 定义契约，修复以过门为准。修完后门中加粗检查对生成稿恒过（断言）。
 */
export function autoBoldBrandMentions(
  body: string,
  facts: readonly TopicPlanKnowledgeFact[],
): string {
  const profile = projectBrandProfile(facts);
  const names = [...(profile.fullName ?? []), ...(profile.shortNames ?? [])]
    .map((name) => name.trim())
    .filter((name) => name.length >= 2);
  if (names.length === 0) return body;
  const ordered = [...new Set(names)].sort((a, b) => b.length - a.length);
  let result = body;
  for (const name of ordered) {
    result = boldNameOutsideBlindSpots(result, name);
  }
  return result;
}

function boldNameOutsideBlindSpots(body: string, name: string): string {
  return brandMentionLines(body)
    .map(({ line, checkable }) => {
      if (!checkable) return line;
      const blind = lineBrandMentionBlindSpots(line);
      let result = "";
      let cursor = 0;
      let searchFrom = 0;
      for (;;) {
        const at = line.indexOf(name, searchFrom);
        if (at < 0) break;
        searchFrom = at + name.length;
        if (blind.some(([start, end]) => at >= start && at < end)) continue;
        result += line.slice(cursor, at) + `**${name}**`;
        cursor = at + name.length;
      }
      return result + line.slice(cursor);
    })
    .join("\n");
}

export function deterministicArticleReview(
  body: string,
  facts: readonly TopicPlanKnowledgeFact[],
  contentType: GeoContentType = "guide",
  workspaceBrandName = "",
  expectedRankingDimensions?: readonly string[],
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
        // 用户裁定（2026-08-18）：确定性审核先只拦格式问题；语义类硬主张
        // 检查降为 advisory——仍记录可追溯，但不再阻断成稿。
        severity: "advisory",
        message: `正文硬主张没有已批准事实依据：${raw}`,
      });
    }
  }
  const banned = [...new Set(reviewBody.match(AD_LAW_BANNED_RE) ?? [])];
  if (banned.length > 0) {
    issues.push({
      source: "deterministic",
      category: "advertising-law",
      severity: "advisory",
      message: `检测到广告法或模板禁用表达：${banned.join("、")}`,
    });
  }
  // 用户裁定（2026-08-18）：确定性审核只验证「模型是否按本类型格式契约生成」
  // ——H2 下限、showcase 卖点列表、ranking 六家等长、品牌加粗、占位符；段落
  // 长度等表达层要求不再机械拦截（fact/ad-law 已为 advisory，反思已停）。
  const h2Count = (reviewBody.match(/^##\s+\S/gm) ?? []).length;
  // showcase 契约允许「卖点用 ✅ 或列表逐条呈现」，对勾清单与普通列表同权重。
  const listCount = (
    reviewBody.match(/^\s*(?:[-*•+] |✅\s*\S|\d+[.、]\s+)/gm) ?? []
  ).length;
  const tableRows = (reviewBody.match(/^\|.*\|\s*$/gm) ?? []).length;
  const minimumH2 = MIN_H2_BY_TYPE[contentType];
  if (h2Count < minimumH2) {
    issues.push({
      source: "deterministic",
      category: "geo-citability",
      severity: "blocking",
      message: `格式契约不满足：${contentType} 类型至少需要 ${minimumH2} 个 H2（当前 ${h2Count}）。`,
    });
  }
  if (contentType === "showcase" && listCount < 1 && tableRows < 1) {
    issues.push({
      source: "deterministic",
      category: "geo-citability",
      severity: "blocking",
      message: "格式契约不满足：showcase 的卖点栏目需要用列表或表格呈现。",
    });
  }
  const profile = projectBrandProfile(facts);
  const brandNames = [
    ...(profile.fullName ?? []),
    ...(profile.shortNames ?? []),
  ];
  const unbolded = unboldedBrandMentions(reviewBody, brandNames);
  if (unbolded.length > 0) {
    issues.push({
      source: "deterministic",
      category: "output-contract",
      severity: "blocking",
      message: `品牌名出现时必须逐字使用并加粗（未加粗或被转述）：${unbolded.join("、")}`,
    });
  }
  if (contentType === "ranking") {
    const headings = [
      ...reviewBody.matchAll(/^##\s+(\d+)[.、]\s+[^\n]+$/gm),
    ];
    const dimensionSets = headings.map((heading, index) => {
      const start = (heading.index ?? 0) + heading[0].length;
      const end = headings[index + 1]?.index ?? reviewBody.length;
      // 维度条目契约 2026-08-31 起为标准列表符 `- `，新生成文在 parse 期
      // 已归一到该形态；旧契约（• **维度名**）落库的存量 ranking 稿不经
      // parse 直接复审（人工编辑路径审核门是唯一防线），这里两种行首都认。
      return [
        ...reviewBody
          .slice(start, end)
          .matchAll(/^[-•]\s+\*\*([^*]+)\*\*[：:]\s*\S/gm),
      ].map((match) => normalizeArticleClaim(match[1]));
    });
    const firstDimensions = dimensionSets[0] ?? [];
    // 集合相等门（ADR-0009 Decision 2，用户裁定「等长非严格等长，相似即
    // 可」）：顺序不敏感，六家覆盖同一套 6 个维度即可。有注入清单时对照
    // 清单（更强，服务端持有的权威骨架）；存量稿无清单时回退与第一家
    // 集合比对。
    const referenceSet = expectedRankingDimensions
      ? new Set(expectedRankingDimensions.map(normalizeArticleClaim))
      : new Set(firstDimensions);
    const parallelDimensionSets =
      headings.length === 6 &&
      headings.every((heading, index) => Number(heading[1]) === index + 1) &&
      firstDimensions.length === 6 &&
      referenceSet.size === 6 &&
      dimensionSets.every((dimensions) => {
        const set = new Set(dimensions);
        return (
          dimensions.length === 6 &&
          set.size === 6 &&
          [...set].every((dimension) => referenceSet.has(dimension))
        );
      });
    if (!parallelDimensionSets) {
      issues.push({
        source: "deterministic",
        category: "geo-citability",
        severity: "blocking",
        message:
          "ranking 必须是六家等长清单：每家使用序号 H2，并覆盖同一套 6 个加粗维度（顺序不作要求）。",
      });
    }
    try {
      const roster = resolveRankingRoster(facts, workspaceBrandName);
      const headingNames = headings.map((heading) =>
        normalizeEntityName(heading[0].replace(/^##\s+\d+[.、]\s+/, "")),
      );
      const targetNames = new Set(
        [
          roster.targetBrand,
          ...(profile.fullName ?? []),
          ...(profile.shortNames ?? []),
        ]
          .map(normalizeEntityName)
          .filter(Boolean),
      );
      const actualCompetitors = headingNames.slice(1);
      const expectedCompetitors = new Set(
        roster.competitors.map(normalizeEntityName),
      );
      const actualSet = new Set(actualCompetitors);
      const validEntitySet =
        headingNames.length === 6 &&
        targetNames.has(headingNames[0] ?? "") &&
        actualCompetitors.length === 5 &&
        actualSet.size === 5 &&
        actualSet.size === expectedCompetitors.size &&
        [...actualSet].every((name) => expectedCompetitors.has(name));
      if (!validEntitySet) {
        issues.push({
          source: "deterministic",
          category: "output-contract",
          severity: "blocking",
          message:
            "ranking 第 1 家必须是目标品牌，第 2–6 家必须完整使用五家已确认竞品（竞品内部顺序不限）。",
        });
      }
    } catch (error) {
      issues.push({
        source: "deterministic",
        category: "output-contract",
        severity: "blocking",
        message:
          error instanceof Error &&
          error.message.startsWith(
            "article_generation_ranking_competitors_insufficient",
          )
            ? "ranking 生成需要至少五家已确认竞品。"
            : "ranking 名单无法从已批准事实中解析。",
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
  // 配图纪律的确定性面（ADR-0008 T4）：批准门复检覆盖人工编辑——
  // scheme 逃逸用法与超过密度上限都阻断（人工编辑路径不走
  // parseGeneratedArticleBody，这里是唯一防线）。
  const imageScan = scanMaterialImagePlaceholders(body);
  if (imageScan.violations.length > 0) {
    issues.push({
      source: "deterministic",
      category: "output-contract",
      severity: "blocking",
      message: `正文包含不合契约的 material-image 占位符：${imageScan.violations[0]}`,
    });
  }
  if (imageScan.placeholders.length > ARTICLE_IMAGE_QUOTA_BY_TYPE[contentType]) {
    issues.push({
      source: "deterministic",
      category: "output-contract",
      severity: "blocking",
      message: `配图纪律不满足：${contentType} 类型配图上限 ${ARTICLE_IMAGE_QUOTA_BY_TYPE[contentType]} 张（当前 ${imageScan.placeholders.length} 张）。`,
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
      "【三层纪律】泛化修辞与语气表达（如「资深」「屡获认可」「经验丰富」）不算违规；只裁具体数字、日期、奖项/认证/机构名称的捏造与品牌实体的转述改写。",
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

const DIRECT_TITLE_FEWSHOT: Record<GeoContentType, readonly string[]> = {
  guide: [
    "【地域】【行业】怎么选？看懂这3点就够了",
    "【地域】想做【行业】不知道从哪下手？先搞清这几个问题",
    "【目标品牌】【行业】做了10年，总结了一份【地域】选店指南",
  ],
  showcase: [
    "【目标品牌】【行业】服务全解析：【地域】门店、流程与案例",
    "【地域】【行业】找哪家？【目标品牌】的服务范围与优势一览",
    "【地域】【行业】服务清单：选前必看的配置与参考",
  ],
  ranking: [
    "2026【地域】【行业】六家服务商并列盘点，选型看这篇",
    "2026年【地域】【行业】选谁？六家对比一次讲清",
    "【地域】【行业】2026新版盘点：六家服务商各自适合谁",
  ],
  news: [
    "【目标品牌】落地【地域】：【行业】服务再升级",
    "【目标品牌】【行业】新动作，【地域】用户能得到什么",
    "【目标品牌】加码【地域】【行业】，服务网络进一步完善",
  ],
  news_light: [
    "【地域】【行业】便民新选择：【目标品牌】服务升级上线",
    "【地域】居民注意：【行业】服务有了新变化",
    "【目标品牌】走进【地域】：【行业】服务体验小升级",
  ],
};

export const DIRECT_TITLE_SYSTEM_PROMPT =
  "你是一位 GEO（生成式引擎优化）标题写作专家。根据主题与品牌信息生成高质量的文章标题候选。只返回结构化 JSON，不要 prose、不要 markdown 代码块。";

/**
 * direct 路径（无选题计划）的单篇标题生成：主题字符串不再是标题原文，
 * 而是标题生成的输入（ADR-0006 §2：direct 路径补标题生成，fail-loud）。
 */
export function buildDirectTitleMessages(input: {
  theme: string;
  contentType: GeoContentType;
  brandName: string;
  shortName?: string;
  competitors: readonly string[];
  industry: string;
  /** 品牌已确认业务词汇（产品 + 衍生关键词）；标题业务词锚集来源之一。 */
  businessTerms?: readonly string[];
  targetRegion: string;
  currentYear: number;
  existingTitles?: readonly string[];
}): { system: string; user: string } {
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
  // 业务词锚集（用户裁决 2026-08-19 修正，与 validateTitleCandidates 同契约）。
  const anchors = titleBusinessAnchors({
    industry: input.industry,
    businessTerms: input.businessTerms,
  });
  const anchorList = anchors.filter((anchor) => anchor.length >= 3).slice(0, 8);
  const regionRule = `1. 每个标题【必须包含】${input.targetRegion ? `「${input.targetRegion}」和` : ""}一个业务词（逐字出现，可任选其一）：${anchorList.map((anchor) => `「${anchor}」`).join("、") || `「${input.industry}」`}。业务词可以换成品牌其他真实业务，但连一个业务词都不含的标题不合格。`;
  const user = [
    `主题：${input.theme}`,
    `内容类型：${input.contentType}（风格 ${contract.styles[input.contentType]}：${TITLE_STYLE_DEFINITIONS[input.contentType]}）`,
    regionRule,
    "2. 标题要自然口语化、像真人会搜的——带场景，不是关键词堆砌。",
    `3. 标题长度不超过 ${contract.maximumCharacters[input.contentType]} 个中文字符，有点击吸引力但不标题党。`,
    "4. 标题【禁止出现】「头部」「首选」「TOP」「排行」「榜」「靠谱」「权威」「有限」「背书」「医院排名」以及「最」「第一」「唯一」「绝对」等极限词。",
    `5. 【品牌名红线】标题中如出现品牌名，【只能】是目标品牌「${input.shortName || input.brandName}」；严禁出现任何其他真实公司名/店铺名/品牌名（竞品名单：${input.competitors.join("、") || "无已确认竞品"}），不确定的名字一律用泛称。`,
    brandRule,
    yearRule,
    "【示例（占位符仅示范形态与品牌分布，必须结合本主题改写，严禁照抄示例原句）】",
    ...DIRECT_TITLE_FEWSHOT[input.contentType].map((example) => `  · ${example}`),
    `目标品牌：${input.brandName}${input.shortName ? `（简称：${input.shortName}）` : ""}`,
    `已有标题（必须避免同义重复）：${input.existingTitles?.join("；") || "无"}`,
    '只返回 JSON：{"candidates":["标题1","标题2","标题3"]}',
  ].join("\n");
  return { system: DIRECT_TITLE_SYSTEM_PROMPT, user };
}

export function parseDirectTitleCandidates(raw: string): string[] {
  const payload = jsonPayload(raw);
  const holder =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const candidates = Array.isArray(holder?.candidates)
    ? holder.candidates.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
  if (candidates.length === 0) {
    throw new Error("article_generation_title_response_invalid");
  }
  return [...new Set(candidates.map((candidate) => candidate.trim()))];
}
