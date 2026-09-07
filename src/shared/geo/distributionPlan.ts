import { GEO_PORT_CONTRACT, type GeoContentType } from "./portContract";
import {
  accountKeyFromUrl,
  accountNameFromTitle,
  accountNameMatchesChannel,
  activeNameMatchScore,
  buildPoolDomainNameMap,
  buildQualifierSuffixes,
  buildUnambiguousDomains,
  channelNameCore,
  channelNameCoreAll,
  citationPlatformFamily,
  cleanResourceDomains,
  isJunkResaleListing,
  isMultiTenantPlatformUrl,
  normalizeChannelName,
  officialChannelAligned,
  packKeyOf,
  platformOfficialFamily,
  preferenceEntryMatches,
  primaryPlatformFamily,
  registeredDomain,
  resourcePlatformFamilies,
  siteNameFromTitleSuffix,
  variantFamilyKey,
  type PreferenceChannelEntry,
  type RecallSource,
} from "./channelRecall";
import { cnyToPoints } from "./points";
import {
  DEFAULT_DISTRIBUTION_SPEND_LIMITS,
  MAX_DISTRIBUTION_SPEND_LIMIT_POINTS,
} from "./distributionSpendLimits";

export {
  DEFAULT_DISTRIBUTION_SPEND_LIMITS,
  MAX_DISTRIBUTION_SPEND_LIMIT_POINTS,
  type DistributionSpendLimits,
} from "./distributionSpendLimits";

/** 分发计划策略版本戳（裁判：distributionPlanContract.json，ADR-0012 双侧
 * pin）。全仓唯一兼任兼容闸的版本戳：Rust prepare 直接拒绝 policyVersion
 * 不符的 provider 快照，本常量必须与 Rust 侧逐字符相等才能过闸。 */
export const DISTRIBUTION_PLAN_POLICY_VERSION =
  "js-ai-dev-four-path-distribution-v1";
export const DISTRIBUTION_RESOURCE_PAGE_SIZE = 200;
export const DISTRIBUTION_RESOURCE_MAX_PAGES = 1_000;
export const DISTRIBUTION_MAX_CANDIDATES =
  GEO_PORT_CONTRACT.channelRecall.recommendation.max;
/** 被动路每问引用上限（豆包逐问探测后、进入计划前）。 */
export const PASSIVE_PER_QUESTION_CITATION_CAP =
  GEO_PORT_CONTRACT.channelRecall.passiveRecall.perQuestionCap;
/**
 * 被动路对齐渠道列表上限（2026-08-27 用户裁决二轮）：按跨问覆盖>引用数
 * 排序取前 50；与全局推荐上限（30）互不影响。引用本身全量返回不再截断。
 */
export const PASSIVE_ALIGNED_CHANNEL_CAP =
  GEO_PORT_CONTRACT.channelRecall.passiveRecall.alignedChannelCap;
export type DistributionChannelKind = "media" | "we-media";
export type DistributionRecallPath =
  keyof typeof GEO_PORT_CONTRACT.channelRecall.paths;
export type DistributionPlanStatus =
  | "discovering"
  | "draft"
  | "unavailable"
  | "confirmed";

export interface DistributionQuestionSource {
  id: string;
  questionId: string;
  question: string;
  title: string;
  url: string;
  articleIds: string[];
  /** 引用的站点名（豆包 site_name）；渠道显示名优先用它而非裸域名。 */
  siteName?: string;
  /**
   * L3 页面作者解析注入的账号名（server 抓引用页提取作者后回填；仅多租户
   * 平台引用、且 L1/L2 解析不到账号时才有值）。展示与被动对齐兜底共用。
   */
  resolvedAccountName?: string;
}

/** 主动路全局召回的原始渠道快照（LLM 联网推荐、匹配资源池之前；只读展示用）。 */
export interface DistributionActiveRecallSource {
  title: string;
  url: string | null;
  articleIds: string[];
  /** LLM 推荐理由（原始回答关键信息，≤200 字；展示用）。 */
  reason?: string | null;
}

export interface DistributionPlanStartInput {
  articleOperationId: string;
  articleIds: string[];
  industry: string;
  targetAudience: string;
  questionSources: DistributionQuestionSource[];
  preferredResourceIds: number[];
  mappingMode: "one-to-one" | "ratio";
  ratio: { media: number; weMedia: number };
  perArticleMaxPoints: number;
  totalMaxPoints: number;
  budgetCny: number;
  publishStartAt: string;
}

export interface DistributionArticleSnapshot {
  id: string;
  operationId: string;
  approvedRevision: number;
  title: string;
  topic: string;
  contentType: GeoContentType;
}

/** 已确认问题池里待探测的问题（被动路现场探测输入）。 */
export interface DistributionContextQuestion {
  id: string;
  question: string;
  articleIds: string[];
}

export interface DistributionPlanningContext {
  articleOperationId: string;
  knowledgeVersion: number;
  industry: string;
  articles: DistributionArticleSnapshot[];
  /** 已确认问题池的选中问题（被动路探测输入）。 */
  questions: DistributionContextQuestion[];
  /** 品牌衍生关键词（主动路全局召回输入）。 */
  derivedKeywords: string[];
}

export interface DistributionResourceSnapshot {
  resourceId: number;
  kind: DistributionChannelKind;
  name: string;
  status: number | null;
  price: string | null;
  publishedRate: number | null;
  entranceLink: string | null;
  /**
   * 收录案例链接（超级媒介 case_link，全池 100% 有值、98.3% 与 entrance
   * 同域）；7,599 条资源 entrance 为空时它是唯一域名信号（八方资源网型）。
   * 旧计划投影可能缺省。
   */
  caseLink?: string | null;
  remark: string | null;
  channelType: number | null;
  industryCategory: number | null;
  area: number | null;
  canWeekend: boolean | null;
  publishSpeed: number | null;
  publishedAverageMinutes: number | null;
  platform: number | null;
  /**
   * 官方 GEO 收录平台标签（超级媒介 geo_platforms 结构化字段，去重保序；
   * 空数组=未标记）。保底路的独立触发条件与分档排序输入。
   */
  geoPlatforms: string[];
}

export interface DistributionProviderSnapshot {
  slot: "distribution";
  provider: "超级媒介";
  endpointFamily: "chaojimeijie-resource-api";
  policyVersion: typeof DISTRIBUTION_PLAN_POLICY_VERSION;
  fetchedAt: string | null;
  mediaTotal: number;
  weMediaTotal: number;
}

export interface DistributionCandidateEvidence {
  path: DistributionRecallPath;
  weight: number;
  label: string;
  reference: string;
  url: string | null;
  articleIds: string[];
}

export interface DistributionChannelCandidate {
  resourceId: number;
  kind: DistributionChannelKind;
  name: string;
  estimatedPriceCny: number | null;
  publishedRate: number | null;
  availability: {
    state: "available";
    providerStatus: 2;
    basis: "supermedia-approved-resource";
  };
  recommendationWeight: number;
  hitCount: number;
  pathHits: DistributionRecallPath[];
  evidence: DistributionCandidateEvidence[];
  fitReasons: string[];
  risks: string[];
  uncertainties: string[];
  resourceSnapshot: DistributionResourceSnapshot;
  /** 变体家族键（核心名+主平台族，2026-08-28）：面板按它折叠同家族变体；旧计划可能缺省。 */
  variantFamily?: string;
}

export interface DistributionAssignment {
  articleId: string;
  resourceId: number | null;
  reason: "source-evidence" | "content-fit" | "weighted-score" | "unassigned";
  scheduledAt: string;
}

export interface DistributionDiscoverySummary {
  inputResources: number;
  approvedResources: number;
  filteredUnavailable: number;
  filteredUnknownPrice: number;
  filteredOverPerArticleLimit: number;
  alignedResources: number;
  recommendedResources: number;
  /** 按路分桶的对齐资源数（推荐截断之前；观测口径 2026-08-27 用户裁决）。 */
  alignedByPath: {
    passive: number;
    active: number;
    fallback: number;
    preference: number;
  };
  /** 引用覆盖的不同注册域名数与其中被池反查命中的数量（反查命中率分母/分子）。 */
  citationDomains: number;
  citationDomainPoolHits: number;
  /** 对齐候选覆盖的不同变体家族数（与 alignedResources 的 listing 口径并存）；旧计划可能缺省。 */
  alignedFamilies?: number;
}

/**
 * 被动路对齐渠道（≤PASSIVE_ALIGNED_CHANNEL_CAP，2026-08-28 起按变体家族折叠、
 * 按跨问覆盖>引用数排序）：面板「对齐渠道」区的权威数据——对齐发生在推荐
 * 之前，recommended=false 只表示被 30 推荐挤出，不是对齐失败。行字段取家族
 * 代表；variantCount/价格区间描述折叠掉的同胞。
 */
export interface DistributionPassiveAlignedChannel {
  resourceId: number;
  kind: DistributionChannelKind;
  name: string;
  estimatedPriceCny: number | null;
  /** 对齐引用条数（跨问去重口径：同问多条只计频次，不重复计问题）。 */
  citations: number;
  /** 覆盖的不同问题数（家族内成员的问题并集）。 */
  questions: number;
  /** 账户级证据标注（账号名或「搜狐号#122878478」形态的 L1 标识；家族并集）。 */
  accounts: string[];
  /** 是否进入最终推荐集（配额与权重排序之后；家族任一成员进入即为 true）。 */
  recommended: boolean;
  /** 折叠掉的同胞变体数（含代表自身；=1 表示无变体）。 */
  variantCount: number;
  /** 家族内最低/最高数值价格（全部未知价时为 null）。 */
  priceMinCny: number | null;
  priceMaxCny: number | null;
}

/**
 * 偏好路命中行（配额前计算，2026-08-28 用户裁决 Q12）：每个名单项一行——
 * 旧「从推荐集反推」口径下偏好 0.15 权重永远进不了 top30、面板恒显匹配 0。
 * matched=false 表示核心名在价内池不存在（名单录错或渠道下架时出现），如实展示。
 */
export interface DistributionPreferenceMatchedChannel {
  /** 偏好名单项原文。 */
  entryName: string;
  matched: boolean;
  /** 命中家族的代表（全名逐字命中者优先，否则包代表规则）。 */
  representativeName: string | null;
  representativePriceCny: number | null;
  /** 家族命中变体总数。 */
  variantCount: number;
  /** 是否进入最终推荐集。 */
  recommended: boolean;
}

export interface DistributionPlanProjection {
  id: string;
  operationId: string;
  workspaceId: string;
  createdBySessionId: string;
  articleOperationId: string;
  policyVersion: typeof DISTRIBUTION_PLAN_POLICY_VERSION;
  status: DistributionPlanStatus;
  revision: number;
  industry: string;
  targetAudience: string;
  questionSources: DistributionQuestionSource[];
  /** 主动路全局召回的原始渠道（匹配资源池之前）；旧计划可能缺省。 */
  activeRecallSources?: DistributionActiveRecallSource[];
  /** 偏好路生效名单快照（内置名单+用户 overlay 合成时的名字）；旧计划可能缺省。 */
  preferenceChannelNames?: string[];
  /**
   * 被动路对齐渠道列表（≤50，2026-08-27 用户裁决二轮）；旧计划可能缺省，
   * 面板回落到仅数推荐集里的被动证据。
   */
  passiveAlignedChannels?: DistributionPassiveAlignedChannel[];
  /**
   * 引用站点显示名映射（注册域名 → 展示名，池反查+标题尾缀解析的结果）；
   * 面板组名链：豆包 site_name > 本映射 > 品牌表 > 裸域名。旧计划可能缺省。
   */
  citationSiteNames?: Record<string, string>;
  /**
   * 偏好路命中清单（配额前逐名单项计算，每项一行代表；2026-08-28 用户裁决
   * Q12）；旧计划可能缺省，面板回落到从推荐集反推。
   */
  preferenceMatchedChannels?: DistributionPreferenceMatchedChannel[];
  preferredResourceIds: number[];
  mappingMode: DistributionPlanStartInput["mappingMode"];
  ratio: DistributionPlanStartInput["ratio"];
  articles: DistributionArticleSnapshot[];
  providerState: "pending" | "available" | "unavailable";
  providerSnapshot: DistributionProviderSnapshot;
  resourceSnapshot: DistributionResourceSnapshot[];
  candidates: DistributionChannelCandidate[];
  selectedResourceIds: number[];
  assignments: DistributionAssignment[];
  /** 创建计划时冻结的用户设置；后续设置变更不反写既有计划。 */
  perArticleMaxPoints: number;
  /** 创建计划时冻结的单次分发总消费硬上限。 */
  totalMaxPoints: number;
  budgetCny: number;
  publishStartAt: string;
  discoverySummary: DistributionDiscoverySummary;
  blockingIssues: string[];
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface DistributionPlanEditInput {
  selectedResourceIds: number[];
  assignments: DistributionAssignment[];
  budgetCny: number;
  publishStartAt: string;
}

/**
 * `plan_distribution` 工具结果的转录投影（聊天价格脱敏）：聊天只携带
 * 点数字段（budgetPoints / estimatedPricePoints），CNY 金额与换算倍率
 * 不进转录。服务端 `distributionPlanCardProjection` 产出，确认卡首渲染
 * 消费；完整权威投影由卡片 3s 轮询 /latest 水合。
 */
export interface DistributionPlanCardCandidate {
  resourceId: number;
  kind: DistributionChannelKind;
  name: string;
  estimatedPricePoints: number | null;
  /** 渠道可用性；旧转录可能缺省，消费方需按可选处理。 */
  availability?: {
    state: DistributionChannelCandidate["availability"]["state"];
    providerStatus?: number;
  };
  pathHits: DistributionRecallPath[];
  fitReasons: string[];
  evidence: Array<{
    path: DistributionRecallPath;
    /** 转录体积护栏：≤64 字，超出截断加 …。 */
    label: string;
  }>;
}

export interface DistributionPlanCardProjection {
  id: string;
  status: DistributionPlanStatus;
  revision: number;
  budgetPoints: number;
  perArticleMaxPoints: number;
  totalMaxPoints: number;
  workspaceId: string;
  publishStartAt: string;
  selectedResourceIds: number[];
  blockingIssues: string[];
  articles: Array<{ id: string }>;
  /** 全量保留：防止卡片在轮询水合前确认时丢失分配。 */
  assignments: DistributionAssignment[];
  candidates: DistributionPlanCardCandidate[];
}

export interface DistributionResourceInput {
  id: number;
  name: string;
  status?: number;
  price?: string | number | null;
  published_rate?: number | null;
  entrance_link?: string | null;
  case_link?: string | null;
  remark?: string | null;
  channel_type?: number | null;
  industry_category?: number | null;
  area?: number | null;
  can_weekend?: boolean | null;
  publish_speed?: number | null;
  published_avg?: number | null;
  platform?: number | null;
  geo_platforms?:
    | { id?: number; label?: string; screenshot?: string | null }[]
    | null;
}

// ── 超级媒介官方类目枚举与行业匹配（2026-08-28 用户裁决：按附录命名实现）──
// 附录：频道类型（媒体 channel_type）——官方文档逐条抄录。营销专区类目
// （套餐系列/最新秒杀/十元专区/其他频道）不是行业，不参与行业匹配；
// 数据中出现的 0 不在官方表内（未分类），同样不匹配。
export const MEDIA_CHANNEL_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: "IT科技", 2: "生活消费", 3: "女性时尚", 4: "娱乐休闲", 5: "游戏网站",
  6: "汽车网站", 7: "教育培训", 8: "酒店旅游", 9: "健康医疗", 10: "房产家居",
  11: "财经商业", 12: "新闻资讯", 13: "套餐系列", 14: "最新秒杀", 15: "十元专区",
  16: "文化艺术", 17: "体育运动", 18: "食品餐饮", 19: "工业贸易", 20: "亲子母婴",
  21: "慈善公益", 100: "其他频道",
};

// 附录：行业分类（自媒体 industry_category）——官方文档逐条抄录。
export const WE_MEDIA_INDUSTRY_NAMES: Readonly<Record<number, string>> = {
  1: "文化", 2: "历史", 3: "三农", 4: "财经", 5: "科技", 6: "体育", 7: "汽车",
  8: "娱乐", 9: "时尚", 10: "健康", 11: "教育", 12: "母婴", 13: "美食", 14: "旅游",
  15: "公益", 16: "游戏", 17: "动漫", 18: "社会", 19: "房产", 20: "职场", 21: "情感",
  22: "搞笑", 23: "新闻", 24: "家居", 25: "生活", 100: "其他",
};

// 营销专区/杂项类目**按类目名**排除（码在两张表里含义不同：媒体 13=套餐系列
// 该排除，自媒体 13=美食 是核心类目——按码排除会误杀）。
const NON_INDUSTRY_CATEGORY_NAMES = new Set([
  "套餐系列",
  "最新秒杀",
  "十元专区",
  "其他频道",
  "其他",
]);

// 行业词 → 类目名碎片 别名：仅当词面与类目名互不包含时兜底（如「医美」不含
//「健康医疗」的字面）。碎片与官方类目名做包含匹配，码永远只出现在上两张表。
const INDUSTRY_TERM_ALIASES: Readonly<Record<string, readonly string[]>> = {
  IT: ["科技"], 数码: ["科技"], 互联网: ["科技"], 软件: ["科技"], 人工智能: ["科技"],
  电子: ["科技"],
  医美: ["健康", "医疗"], 医疗: ["健康", "医疗"], 医药: ["健康", "医疗"], 养生: ["健康"],
  美妆: ["时尚"], 服饰: ["时尚"], 奢侈品: ["时尚"],
  影视: ["娱乐"], 综艺: ["娱乐"], 明星: ["娱乐"],
  电竞: ["游戏"],
  民宿: ["旅游"],
  装修: ["家居"], 建材: ["家居"],
  金融: ["财经"], 证券: ["财经"], 保险: ["财经"], 银行: ["财经"],
  理财: ["财经"], 投资: ["财经"],
  媒体: ["新闻"], 资讯: ["新闻"],
  驾校: ["汽车"], 汽修: ["汽车"], 汽配: ["汽车"], 车辆: ["汽车"], 驾驶: ["汽车"],
  慈善: ["公益"],
  孕产: ["母婴"],
  收藏: ["文化"], 书画: ["文化"],
  健身: ["体育"], 足球: ["体育"], 篮球: ["体育"],
  农业: ["食品", "三农"], 农资: ["食品", "三农"],
  制造: ["工业"], 机械: ["工业"], 能源: ["工业"], 化工: ["工业"], 物流: ["工业"],
  贸易: ["工业"],
  家政: ["生活"], 消费: ["生活"],
  美食: ["食品"],
  餐饮: ["美食", "食品"],
};

/**
 * 行业输入 → 官方类目码集合（2026-08-28 用户裁决：按附录命名实现）。匹配三段：
 * 整串包含（「美食行业」⊃「美食」）∨ 别名碎片（「医美」→ 健康/医疗，词面与
 * 类目名互不包含的词才进别名表）∨ 共享 ≥2 字子串（中文连写词：「汽车改装」
 * 与「汽车网站」共享「汽车」——旧单码直查表是一对一硬映射，餐饮→2 的错误
 * 正源于此）。一个行业可命中多个类目（集合语义）。
 */
function matchesCategoryName(industry: string, name: string): boolean {
  if (industry.includes(name) || name.includes(industry)) return true;
  for (const [term, fragments] of Object.entries(INDUSTRY_TERM_ALIASES)) {
    if (!industry.includes(term)) continue;
    if (fragments.some((fragment) => name.includes(fragment))) return true;
  }
  // 类目名 2-gram ⊂ 行业串（中文复合词的最小有意义片段）。
  for (let i = 0; i + 2 <= Array.from(name).length; i += 1) {
    const gram = Array.from(name).slice(i, i + 2).join("");
    if (industry.includes(gram)) return true;
  }
  return false;
}

export function industryCodesFor(
  industry: string,
  names: Readonly<Record<number, string>>,
): Set<number> {
  const trimmed = industry.trim();
  const codes = new Set<number>();
  if (!trimmed) return codes;
  for (const [rawCode, name] of Object.entries(names)) {
    const code = Number(rawCode);
    if (NON_INDUSTRY_CATEGORY_NAMES.has(name)) continue;
    if (matchesCategoryName(trimmed, name)) codes.add(code);
  }
  return codes;
}
/** 行业命中的类目名（证据 label 用官方命名，如「食品餐饮」）。 */
export function industryCategoryLabels(
  codes: ReadonlySet<number>,
  names: Readonly<Record<number, string>>,
): string[] {
  return [...codes].map((code) => names[code]).filter(Boolean);
}
const CONTENT_KIND_FIT: Readonly<
  Record<GeoContentType, Record<DistributionChannelKind, number>>
> = {
  guide: { media: 0.5, "we-media": 0.5 },
  showcase: { media: 0.4, "we-media": 1 },
  ranking: { media: 0.6, "we-media": 0.4 },
  news: { media: 1, "we-media": 0.3 },
  news_light: { media: 1, "we-media": 0.3 },
};

function normalizedText(value: string, max: number, code: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || Array.from(normalized).length > max) throw new Error(code);
  return normalized;
}

function validIsoTimestamp(value: string): string {
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw new Error("distribution_plan_publish_time_invalid");
  }
  return new Date(normalized).toISOString();
}

function validHttpUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error();
    return url.toString();
  } catch {
    throw new Error("distribution_plan_question_source_url_invalid");
  }
}

function audienceOverlap(
  audience: string,
  snapshot: DistributionResourceSnapshot,
): boolean {
  const terms = audience
    .toLocaleLowerCase("zh-CN")
    .split(/[\s,，、/]+/)
    .map((term) => term.trim())
    .filter((term) => Array.from(term).length >= 2);
  if (terms.length === 0) return false;
  const haystack =
    `${snapshot.name} ${snapshot.remark ?? ""}`.toLocaleLowerCase("zh-CN");
  return terms.some((term) => haystack.includes(term));
}

function nameMatches(sourceTitle: string, resourceName: string): boolean {
  const source = sourceTitle.trim().toLocaleLowerCase("zh-CN");
  const resource = resourceName.trim().toLocaleLowerCase("zh-CN");
  if (source.length < 3 || resource.length < 3) return false;
  // 标题包含全名或核心名（引用标题「xxx_济南时报」应命中「济南时报（官方头条号）」）。
  const core = channelNameCore(resource);
  const names =
    core.length >= 3 && core !== resource ? [resource, core] : [resource];
  return (
    names.some((name) => source.includes(name)) || resource.includes(source)
  );
}

/** 官方 geo_platforms 非空，或名称/备注含 GEO 收录关键词（旧数据兜底）。 */
function geoIncluded(snapshot: DistributionResourceSnapshot): boolean {
  if (snapshot.geoPlatforms.length > 0) return true;
  const text = `${snapshot.name} ${snapshot.remark ?? ""}`;
  if (
    ["豆包", "文心一言", "文心", "通义千问", "通义", "腾讯元宝", "元宝"].some(
      (term) => text.includes(term),
    )
  )
    return true;
  return /\b(ai|geo|kimi|deepseek)\b/i.test(text);
}

/** 结构化行业类目匹配（媒体 channel_type / 自媒体 industry_category 对码）。 */
function industryCategoryMatch(
  snapshot: DistributionResourceSnapshot,
  mediaCodes: ReadonlySet<number>,
  weMediaCodes: ReadonlySet<number>,
): boolean {
  return snapshot.kind === "media"
    ? mediaCodes.has(snapshot.channelType ?? -1)
    : weMediaCodes.has(snapshot.industryCategory ?? -1);
}

/**
 * 保底路候选分档（用户裁决 2026-08-27）：垂类∩官方GEO > 纯垂类 > 纯官方GEO
 * > 仅人群词。只作为同权重同命中数候选的排序 tie-break（候选推荐与文章分配
 * 两处一致），不改变四路按路径累加的权重语义。
 */
function fallbackPreferenceTier(
  snapshot: DistributionResourceSnapshot,
  input: {
    mediaCodes: ReadonlySet<number>;
    weMediaCodes: ReadonlySet<number>;
    targetAudience: string;
  },
): number {
  const industryMatch = industryCategoryMatch(
    snapshot,
    input.mediaCodes,
    input.weMediaCodes,
  );
  const geoMarked = snapshot.geoPlatforms.length > 0;
  if (industryMatch && geoMarked) return 0;
  if (industryMatch) return 1;
  if (geoMarked) return 2;
  return audienceOverlap(input.targetAudience, snapshot) ? 3 : 4;
}

/**
 * 垂类名命中（2026-08-28 用户裁决 Q13/S2）：资源名（含子频道尾块）含行业
 * 或人群词。补结构化类目（channelType/industryCategory）覆盖不到的缺口——
 * 「人民网视频（家居频道）」这类子频道名带垂类但类目码不匹配的场景；作为
 * 排序键全局生效（与主动召回 prompt 的垂媒优先精神一致）。
 */
function verticalNameMatch(
  snapshot: DistributionResourceSnapshot,
  input: { industry: string; targetAudience: string },
): boolean {
  const haystack = snapshot.name.toLowerCase();
  const terms = [
    ...input.industry.split(/[\s,，、/]+/),
    ...input.targetAudience.split(/[\s,，、/]+/),
  ]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => Array.from(term).length >= 2);
  return terms.some((term) => haystack.includes(term));
}

/**
 * 包/家族代表比较器（Q13，2026-08-28 用户裁决；Q15 同日修订）：非 junk →
 * **官网（自有域名）优先**（「必有官网」：蓝色河畔这类头条+官网渠道以官网
 * 版为家族代表）→ 证据权重 → geo_platforms 数 → 价格低 → id 小。junk 靠前
 * 两位自动「永不代表」（除非全组皆 junk）。
 */
function compareWithinFamily(
  left: DistributionChannelCandidate,
  right: DistributionChannelCandidate,
): number {
  const ownSiteFirst = (candidate: DistributionChannelCandidate): number =>
    primaryPlatformFamily(candidate.resourceSnapshot) === null ? 0 : 1;
  return (
    Number(isJunkResaleListing(left.name)) -
      Number(isJunkResaleListing(right.name)) ||
    ownSiteFirst(left) - ownSiteFirst(right) ||
    right.recommendationWeight - left.recommendationWeight ||
    right.resourceSnapshot.geoPlatforms.length -
      left.resourceSnapshot.geoPlatforms.length ||
    (left.estimatedPriceCny ?? Number.POSITIVE_INFINITY) -
      (right.estimatedPriceCny ?? Number.POSITIVE_INFINITY) ||
    // 基础名优先：同分时「餐饮界」代表「餐饮界首发」（主干变体让位）。
    channelNameCoreAll(left.resourceSnapshot.name).length -
      channelNameCoreAll(right.resourceSnapshot.name).length ||
    left.resourceId - right.resourceId
  );
}

/**
 * 主干家族键（Q15，2026-08-28 用户裁决：改为同族）：对对齐候选的核心名做
 * **包含连通聚类**——北京列举网 ⊃ 列举网、列举网geo ⊃ 列举网 即同主干，
 * 跨平台同名（蓝色河畔（今日头条）+ 官网）也并入同族。列举网系 7 席 → ≤2
 * 席；家族键取连通分量中最短的核心名（最泛主干）。此前「核心名全等+平台族
 * 分家」会把 geo 词干/城市前缀/连字符段裂成多个主干。
 */
function assignTrunkFamilies(
  candidates: DistributionChannelCandidate[],
): void {
  const cores = [
    ...new Set(
      candidates.map((candidate) =>
        channelNameCoreAll(candidate.resourceSnapshot.name)
          .trim()
          .toLowerCase(),
      ),
    ),
  ].filter((core) => core.length > 0);
  const parent = new Map<string, string>(
    cores.map((core) => [core, core] as const),
  );
  const find = (core: string): string => {
    const root = parent.get(core)!;
    if (root === core) return core;
    const settled = find(root);
    parent.set(core, settled);
    return settled;
  };
  // 排序后短名在前：只需向后比较包含关系（短⊃长不成立，长⊃短才连通）。
  const sorted = [...cores].sort(
    (left, right) => left.length - right.length,
  );
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const short = sorted[i]!;
      const long = sorted[j]!;
      // 长度差 ≥2 才算主干包含：差 1 位（泛站观察2 ⊂ 泛站观察27）多为
      // 数字/字母后缀的序号变体，不是渠道主干扩张。
      if (long.includes(short) && long.length - short.length >= 2) {
        parent.set(find(long), find(short));
      }
    }
  }
  for (const candidate of candidates) {
    const core = channelNameCoreAll(candidate.resourceSnapshot.name)
      .trim()
      .toLowerCase();
    const trunk = core ? find(core) : candidate.variantFamily ?? core;
    candidate.variantFamily = trunk;
  }
}

function parsePrice(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function validateDistributionPlanStartInput(
  input: DistributionPlanStartInput,
): DistributionPlanStartInput {
  const articleOperationId = normalizedText(
    input.articleOperationId,
    160,
    "distribution_plan_article_operation_invalid",
  );
  const articleIds = [
    ...new Set(
      input.articleIds.map((id) =>
        normalizedText(id, 160, "distribution_plan_article_id_invalid"),
      ),
    ),
  ];
  if (articleIds.length === 0 || articleIds.length > 50) {
    throw new Error("distribution_plan_articles_invalid");
  }
  const questionSources = input.questionSources.map((source, index) => ({
    id: normalizedText(
      source.id || `source-${index + 1}`,
      160,
      "distribution_plan_source_id_invalid",
    ),
    questionId: normalizedText(
      source.questionId,
      160,
      "distribution_plan_question_id_invalid",
    ),
    question: normalizedText(
      source.question,
      500,
      "distribution_plan_question_invalid",
    ),
    title: normalizedText(
      source.title,
      300,
      "distribution_plan_source_title_invalid",
    ),
    url: validHttpUrl(source.url),
    articleIds: [
      ...new Set(source.articleIds.filter((id) => articleIds.includes(id))),
    ],
    ...(source.siteName?.trim()
      ? { siteName: source.siteName.trim().slice(0, 120) }
      : {}),
    ...(source.resolvedAccountName?.trim()
      ? { resolvedAccountName: source.resolvedAccountName.trim().slice(0, 60) }
      : {}),
  }));
  // 全量引用上限（2026-08-27 用户裁决二轮）：20 问 × 每问 10 条 = 200 上界，
  // 250 为纯防脏数据护栏。
  if (questionSources.length > 250)
    throw new Error("distribution_plan_sources_invalid");
  if (
    !Number.isInteger(input.perArticleMaxPoints) ||
    input.perArticleMaxPoints < 1 ||
    input.perArticleMaxPoints > MAX_DISTRIBUTION_SPEND_LIMIT_POINTS
  ) {
    throw new Error("distribution_plan_per_article_limit_invalid");
  }
  if (
    !Number.isInteger(input.totalMaxPoints) ||
    input.totalMaxPoints < 1 ||
    input.totalMaxPoints > MAX_DISTRIBUTION_SPEND_LIMIT_POINTS
  ) {
    throw new Error("distribution_plan_total_limit_invalid");
  }
  if (
    !Number.isFinite(input.budgetCny) ||
    input.budgetCny < 0 ||
    input.budgetCny > 10_000_000
  ) {
    throw new Error("distribution_plan_budget_invalid");
  }
  const ratio = {
    media: Math.trunc(input.ratio.media),
    weMedia: Math.trunc(input.ratio.weMedia),
  };
  if (ratio.media < 0 || ratio.weMedia < 0 || ratio.media + ratio.weMedia < 1) {
    throw new Error("distribution_plan_ratio_invalid");
  }
  return {
    ...input,
    articleOperationId,
    articleIds,
    industry: normalizedText(
      input.industry,
      200,
      "distribution_plan_industry_invalid",
    ),
    targetAudience: normalizedText(
      input.targetAudience,
      500,
      "distribution_plan_audience_invalid",
    ),
    questionSources,
    preferredResourceIds: [
      ...new Set(input.preferredResourceIds.filter(Number.isInteger)),
    ],
    ratio,
    budgetCny: Math.round(input.budgetCny * 100) / 100,
    publishStartAt: validIsoTimestamp(input.publishStartAt),
  };
}

export function normalizeDistributionResource(
  kind: DistributionChannelKind,
  resource: DistributionResourceInput,
): DistributionResourceSnapshot | null {
  if (!Number.isInteger(resource.id) || resource.id <= 0) return null;
  const name = resource.name?.trim();
  if (!name || Array.from(name).length > 300) return null;
  const numberOrNull = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const price =
    resource.price === null || resource.price === undefined
      ? null
      : String(resource.price).trim() || null;
  return {
    resourceId: resource.id,
    kind,
    name,
    status: numberOrNull(resource.status),
    price,
    publishedRate: numberOrNull(resource.published_rate),
    entranceLink:
      typeof resource.entrance_link === "string" &&
      resource.entrance_link.trim()
        ? resource.entrance_link.trim()
        : null,
    caseLink:
      typeof resource.case_link === "string" && resource.case_link.trim()
        ? resource.case_link.trim()
        : null,
    remark:
      typeof resource.remark === "string" && resource.remark.trim()
        ? resource.remark.trim()
        : null,
    channelType: numberOrNull(resource.channel_type),
    industryCategory: numberOrNull(resource.industry_category),
    area: numberOrNull(resource.area),
    canWeekend:
      typeof resource.can_weekend === "boolean" ? resource.can_weekend : null,
    publishSpeed: numberOrNull(resource.publish_speed),
    publishedAverageMinutes: numberOrNull(resource.published_avg),
    platform: numberOrNull(resource.platform),
    geoPlatforms: Array.isArray(resource.geo_platforms)
      ? [
          ...new Set(
            resource.geo_platforms.flatMap((item) =>
              typeof item?.label === "string" && item.label.trim()
                ? [item.label.trim()]
                : [],
            ),
          ),
        ]
      : [],
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * 被动来源选样（js_ai 对齐 + 2026-08-27 用户裁决二轮）：
 * 1. 每问最多 `perQuestionCap`（10）条引用，按问题内原序——所有已确认问题
 *    都能进入被动证据，不再被先到者占满总量；
 * 2. 渠道 = 引用 URL 的注册域名；按「渠道出现在多少个不同问题」降序、
 *    同渠道引用数降序、原始出现序升续排——跨问重复出现的渠道（多问交集）
 *    排前；
 * 3. 全量返回（旧 totalCap=50 总量帽废除）：排序只决定展示顺序，不截断。
 */
export function selectPassiveSources(
  collected: ReadonlyArray<{
    question: {
      id: string;
      question: string;
      articleIds: string[];
    };
    citations: ReadonlyArray<{
      url: string;
      title?: string;
      siteName?: string;
    }>;
  }>,
): DistributionQuestionSource[] {
  const seen = new Set<string>();
  type Row = {
    questionId: string;
    question: string;
    articleIds: string[];
    title: string;
    siteName: string | undefined;
    url: string;
    channel: string;
    order: number;
  };
  const rows: Row[] = [];
  for (const outcome of collected) {
    let taken = 0;
    for (const citation of outcome.citations) {
      if (taken >= PASSIVE_PER_QUESTION_CITATION_CAP) break;
      const url = citation.url.trim();
      if (!/^https?:\/\//i.test(url)) continue;
      // Set.add 恒返回集合本身，必须 has/add 分离判重（旧写法 `!seen.add()`
      // 恒 false，去重从未生效——此前靠总量帽把重复引用截掉才未被察觉）。
      const dedupeKey = `${outcome.question.id}:${url}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const host = hostOf(url) ?? url;
      const siteName = citation.siteName?.trim() || undefined;
      rows.push({
        questionId: outcome.question.id,
        question: outcome.question.question,
        articleIds: outcome.question.articleIds,
        title: citation.title?.trim() || siteName || host,
        siteName,
        url,
        channel: registeredDomain(url) ?? host,
        order: rows.length,
      });
      taken += 1;
    }
  }
  const channelQuestions = new Map<string, Set<string>>();
  const channelHits = new Map<string, number>();
  for (const row of rows) {
    const questions = channelQuestions.get(row.channel) ?? new Set<string>();
    questions.add(row.questionId);
    channelQuestions.set(row.channel, questions);
    channelHits.set(row.channel, (channelHits.get(row.channel) ?? 0) + 1);
  }
  const ranked = [...rows].sort(
    (left, right) =>
      (channelQuestions.get(right.channel)?.size ?? 0) -
        (channelQuestions.get(left.channel)?.size ?? 0) ||
      (channelHits.get(right.channel) ?? 0) -
        (channelHits.get(left.channel) ?? 0) ||
      left.order - right.order,
  );
  return ranked.map((row, index) => ({
    id: `probe:${row.questionId}:${index + 1}`,
    questionId: row.questionId,
    question: row.question,
    title: row.title,
    url: row.url,
    articleIds: row.articleIds,
    ...(row.siteName ? { siteName: row.siteName } : {}),
  }));
}

function pathEvidence(
  path: DistributionRecallPath,
  label: string,
  reference: string,
  url: string | null,
  articleIds: string[],
): DistributionCandidateEvidence {
  return {
    path,
    weight: GEO_PORT_CONTRACT.channelRecall.paths[path].weight,
    label,
    reference,
    url,
    articleIds,
  };
}

export function buildDistributionCandidates(input: {
  industry: string;
  targetAudience: string;
  questionSources: DistributionQuestionSource[];
  /** 主动路（全局单次召回）渠道来源；主题编号已在服务端解析成 articleIds。 */
  activeSources: RecallSource[];
  /** 偏好路生效清单（内置名单+用户 overlay 合成；js_ai preferenceChannels 契约）。 */
  preferenceChannels: PreferenceChannelEntry[];
  perArticleMaxPoints: number;
  articles: DistributionArticleSnapshot[];
  resources: DistributionResourceSnapshot[];
  /** 保底召回随机采样注入（测试定苗）；缺省 Math.random。 */
  random?: () => number;
}): {
  candidates: DistributionChannelCandidate[];
  resourceSnapshot: DistributionResourceSnapshot[];
  summary: DistributionDiscoverySummary;
  /** 被动路对齐渠道（≤PASSIVE_ALIGNED_CHANNEL_CAP；面板对齐渠道区数据源）。 */
  passiveAlignedChannels: DistributionPassiveAlignedChannel[];
  /** 引用站点显示名映射（注册域名 → 池反查/标题尾缀解析的展示名）。 */
  citationSiteNames: Record<string, string>;
  /** 偏好路命中清单（配额前逐名单项计算，每项一行代表）。 */
  preferenceMatchedChannels: DistributionPreferenceMatchedChannel[];
} {
  const unique = new Map<string, DistributionResourceSnapshot>();
  for (const resource of input.resources) {
    unique.set(`${resource.kind}:${resource.resourceId}`, resource);
  }
  const resources = [...unique.values()];
  // 规格词后缀集合（Q13 数据驱动判定）：跨 ≥10 个不同核心名的括号尾块视为
  // 通用规格词（可发GEO/包收录/官方…），变体分包的依据。
  const qualifierSuffixes = buildQualifierSuffixes(resources);
  // 唯一域名集合（2026-08-28 URL 防误判）：域名下核心名经包含关系全连通才算
  // 唯一，歧义域（ppwll.cn 式跨机构聚合域）的域名命中需名称佐证。
  const unambiguousDomains = buildUnambiguousDomains(resources);
  // 行业→官方类目码集合（按附录命名匹配；一个行业可命中多个类目）。
  const mediaCodes = industryCodesFor(
    input.industry,
    MEDIA_CHANNEL_TYPE_NAMES,
  );
  const weMediaCodes = industryCodesFor(
    input.industry,
    WE_MEDIA_INDUSTRY_NAMES,
  );
  const tierInput = {
    mediaCodes,
    weMediaCodes,
    targetAudience: input.targetAudience,
  };
  const contentTypes = [
    ...new Set(input.articles.map((article) => article.contentType)),
  ];
  let filteredUnavailable = 0;
  let filteredUnknownPrice = 0;
  let filteredOverPerArticleLimit = 0;
  const approved: DistributionResourceSnapshot[] = [];
  for (const resource of resources) {
    if (resource.status !== 2) {
      filteredUnavailable += 1;
      continue;
    }
    // 发布率不参与任何决策。用户设置以最终点数为口径；未知价格无法证明
    // 在上限以内，因此不进入返回给用户的候选集。
    const price = parsePrice(resource.price);
    if (price === null) {
      filteredUnknownPrice += 1;
      continue;
    }
    if (cnyToPoints(price) > input.perArticleMaxPoints) {
      filteredOverPerArticleLimit += 1;
      continue;
    }
    approved.push(resource);
  }

  // ── 观测与展示辅助（2026-08-27 用户裁决）：池反查映射、引用站点显示名、
  // 被动对齐统计。池反查 = 资源 entranceLink 域名 → 渠道名的权威映射；
  // miss 时回落标题尾缀站点名（` - 八方资源网` 式短尾缀）。
  const poolDomainNames = buildPoolDomainNameMap(resources);
  const citationDomains = new Set<string>();
  const citationPoolHits = new Set<string>();
  for (const source of input.questionSources) {
    const domain = registeredDomain(source.url);
    if (!domain) continue;
    citationDomains.add(domain);
    if (poolDomainNames.has(domain)) citationPoolHits.add(domain);
  }
  const citationSiteNames: Record<string, string> = {};
  for (const domain of citationDomains) {
    const pooled = poolDomainNames.get(domain);
    if (pooled) {
      citationSiteNames[domain] = pooled;
      continue;
    }
    for (const source of input.questionSources) {
      if (registeredDomain(source.url) !== domain) continue;
      const suffix = siteNameFromTitleSuffix(source.title);
      if (suffix) {
        citationSiteNames[domain] = suffix;
        break;
      }
    }
  }
  interface PassiveAlignmentStats {
    citations: number;
    questions: Set<string>;
    accounts: Set<string>;
  }
  const passiveStats = new Map<string, PassiveAlignmentStats>();
  const passiveStatsOf = (
    resource: DistributionResourceSnapshot,
  ): PassiveAlignmentStats => {
    const key = `${resource.kind}:${resource.resourceId}`;
    let stats = passiveStats.get(key);
    if (!stats) {
      stats = { citations: 0, questions: new Set(), accounts: new Set() };
      passiveStats.set(key, stats);
    }
    return stats;
  };

  // ── 全局排序链（Q5/Q11/S2，2026-08-28 用户裁决）：权重 → 命中路径数 →
  // 保底分档 → 随机号靠后 → 垂类名命中 → 被动覆盖问题数 → 被动引用数 →
  // 名称。包代表重排与 quota 走查复用同一比较器，保证走查序=全局排序序。
  const passiveCoverageOf = (candidate: {
    kind: DistributionChannelKind;
    resourceId: number;
  }): { questions: number; citations: number } => {
    const stat = passiveStats.get(`${candidate.kind}:${candidate.resourceId}`);
    return { questions: stat?.questions.size ?? 0, citations: stat?.citations ?? 0 };
  };
  const verticalInput = {
    industry: input.industry,
    targetAudience: input.targetAudience,
  };
  const compareByGlobalRank = (
    left: DistributionChannelCandidate,
    right: DistributionChannelCandidate,
  ): number =>
    right.recommendationWeight - left.recommendationWeight ||
    right.hitCount - left.hitCount ||
    fallbackPreferenceTier(left.resourceSnapshot, tierInput) -
      fallbackPreferenceTier(right.resourceSnapshot, tierInput) ||
    Number(isJunkResaleListing(left.name)) -
      Number(isJunkResaleListing(right.name)) ||
    Number(verticalNameMatch(right.resourceSnapshot, verticalInput)) -
      Number(verticalNameMatch(left.resourceSnapshot, verticalInput)) ||
    passiveCoverageOf(right).questions - passiveCoverageOf(left).questions ||
    passiveCoverageOf(right).citations - passiveCoverageOf(left).citations ||
    left.name.localeCompare(right.name, "zh-CN") ||
    left.resourceId - right.resourceId;

  let candidates = approved
    .flatMap((resource): DistributionChannelCandidate[] => {
      const evidence: DistributionCandidateEvidence[] = [];
      // 池侧域名信号（2026-08-28 用户裁决）：entrance + case_link 双 URL 的
      // 干净注册域名集合——7,599 条资源 entrance 为空，case_link 是唯一信号。
      const resourceDomains = new Set(cleanResourceDomains(resource));
      // 账户级对齐的池侧输入：entranceLink 内嵌账号标识 + 平台族集合
      // （platform 枚举第一信号，2026-08-28）。
      const resourceAccountKey = accountKeyFromUrl(resource.entranceLink);
      const families = resourcePlatformFamilies({
        name: resource.name,
        entranceLink: resource.entranceLink,
        platform: resource.platform,
      });
      const stats = passiveStatsOf(resource);
      for (const source of input.questionSources) {
        const sourceDomain = registeredDomain(source.url);
        // 多租户平台（头条/抖音/公众号等）上文章引用与账号共享注册域名，
        // 域名相等不构成被动对齐证据，只保留名称对齐与账户级对齐。
        const multiTenantSource = isMultiTenantPlatformUrl(source.url);
        // 域名歧义防护（2026-08-28 用户裁决）：唯一域（域名下核心名经包含
        // 关系全连通）直接放行；歧义域（ppwll.cn 式跨机构聚合域/同机构多
        // 产品域）要求名称佐证——引用标题含资源核心名且过平台门。
        const domainAligned =
          !multiTenantSource &&
          sourceDomain !== null &&
          resourceDomains.has(sourceDomain) &&
          (unambiguousDomains.has(sourceDomain) ||
            (nameMatches(source.title, resource.name) &&
              (!multiTenantSource ||
                (citationPlatformFamily(source.url) !== null &&
                  families.has(citationPlatformFamily(source.url)!)))));
        // 账户级对齐（2026-08-27 用户裁决，三层解析）：L1 URL 账号标识相等
        // > L2 标题尾缀/L3 注入账号名 × 渠道核心名 + 平台一致性门。
        let accountAligned = false;
        let accountLabel: string | null = null;
        if (multiTenantSource) {
          const sourceKey = accountKeyFromUrl(source.url);
          if (
            sourceKey &&
            resourceAccountKey &&
            sourceKey.platform === resourceAccountKey.platform &&
            sourceKey.accountId === resourceAccountKey.accountId
          ) {
            accountAligned = true;
            accountLabel = `${sourceKey.platform}号#${sourceKey.accountId}`;
          } else {
            const accountName =
              source.resolvedAccountName?.trim() ||
              accountNameFromTitle(source.title) ||
              "";
            if (
              accountName &&
              accountNameMatchesChannel({
                accountName,
                citationPlatform: citationPlatformFamily(source.url),
                resourceName: resource.name,
                resourceFamilies: families,
              })
            ) {
              accountAligned = true;
              accountLabel = accountName;
            }
          }
        }
        if (domainAligned || accountAligned) {
          const label =
            accountAligned && accountLabel
              ? `真实问题来源「${source.title}」与资源池渠道对齐（账号：${accountLabel}）`
              : `真实问题来源「${source.title}」与资源池渠道对齐`;
          evidence.push(
            pathEvidence(
              "passive",
              label,
              source.questionId,
              source.url,
              source.articleIds,
            ),
          );
          stats.citations += 1;
          stats.questions.add(source.questionId);
          if (accountLabel) stats.accounts.add(accountLabel);
        } else if (
          // Q6（2026-08-28 用户裁决）：标题含核心名的兜底匹配对多租户引用加
          // 平台一致性门（引用平台族 ∈ 资源平台族）——跨平台同名（全池 523 组）
          // 与蹭名账号不构成被动证据；非多租户引用（如 b2b168→八方资源网）
          // 保持无门。
          nameMatches(source.title, resource.name) &&
          (!multiTenantSource ||
            (citationPlatformFamily(source.url) !== null &&
              families.has(citationPlatformFamily(source.url)!)))
        ) {
          evidence.push(
            pathEvidence(
              "passive",
              `真实问题来源「${source.title}」与资源池渠道对齐`,
              source.questionId,
              source.url,
              source.articleIds,
            ),
          );
          stats.citations += 1;
          stats.questions.add(source.questionId);
        }
      }
      const industryMatch = industryCategoryMatch(
        resource,
        mediaCodes,
        weMediaCodes,
      );
      const audienceMatch = audienceOverlap(input.targetAudience, resource);
      // 官方 GEO 标记（geo_platforms 非空）是结构化触发条件；备注关键词命中
      // （geoIncluded）只作为信号文本兜底，不独立触发——与旧行为一致。
      const geoMarked = resource.geoPlatforms.length > 0;
      // 主动路（ADR-0031 全局召回）：LLM 联网推荐的渠道，域名优先、名称回落；
      // 多租户平台域名（toutiao.com 等）不构成渠道身份，名称对齐只认核心名
      // （fuzzyMatchScore 全分支限定，2026-08-28）；平台级来源另经「平台官方型」
      // 通道命中根路径官方资源（搜狐网三农（GEO）等，Q3a 用户裁决）。
      // 名称回落用 activeNameMatchScore（≥0.8：包含/共享前缀/品牌强重叠，
      // Jaccard 字符交集档不参与）——同日用户裁决：主动路只要真正正确的
      // 渠道，Jaccard 档的残留误配（中国团餐网→中国妈妈网 0.5、
      // 今日头条美食频道→美妆头条 0.4）全部清除。
      for (const source of input.activeSources) {
        const sourceDomain = registeredDomain(source.url);
        const multiTenantSource = isMultiTenantPlatformUrl(source.url);
        const sourceFamily = multiTenantSource
          ? citationPlatformFamily(source.url)
          : null;
        // 域名歧义防护（同被动路口径）：唯一域直接放行；歧义域要求名称
        // 佐证（activeNameMatchScore≥0.8：包含/前缀/品牌强重叠）。
        const domainHit =
          !multiTenantSource &&
          sourceDomain !== null &&
          resourceDomains.has(sourceDomain) &&
          (unambiguousDomains.has(sourceDomain) ||
            activeNameMatchScore(source, resource.name, {
              multiTenantPlatform: multiTenantSource,
            }) >= 0.8);
      // 平台官方型通道（Q3a）+ 双重佐证（2026-08-28 真实池核验后收严）：
      // 同族之外还须 (a) 结构化类目一致（channelType/industryCategory 对码，
      // 真实池核验：网易美食（GEO）ic=13、搜狐网美食（GEO）ic=13、
      // 今日头条健康（GEO）ct=9——官方型 GEO 资源类目字段真实可用，且能
      // 接住名称佐证接不住的同义垂类「餐饮频道→网易美食」）或
      // (b) officialChannelAligned 品牌后频道残差对齐（字段缺失/宽类目
      // 「生活消费」「其他」时的名称兜底）。二者皆无则不命中——否则
      // 「网易餐饮频道」会跨垂类命中「网易房产（GEO）」。
      const officialHit =
        sourceFamily !== null &&
        platformOfficialFamily({
          name: resource.name,
          entranceLink: resource.entranceLink,
        }) === sourceFamily &&
        (industryMatch || officialChannelAligned(source, resource.name));
        if (
          domainHit ||
          officialHit ||
          activeNameMatchScore(source, resource.name, {
            multiTenantPlatform: multiTenantSource,
          }) >= 0.8
        ) {
          evidence.push(
            pathEvidence(
              "active",
              officialHit && !domainHit
                ? `全局召回推荐渠道「${source.title}」命中平台官方型资源`
                : `全局召回推荐渠道「${source.title}」与本资源对齐`,
              `recall:${source.title}`,
              source.url ?? resource.entranceLink,
              source.articleIds ?? [],
            ),
          );
        }
      }
      // 保底路（js_ai path 3 语义）证据不再在此全量挂载——三轮裁决（2026-08-28）
      // 把随机采样下沉到召回层：垂类/GEO 候选先进池，经 t0 全量 + t1 随机 +
      // t2 补足抽样后才挂 fallback 证据（见下方「保底路召回采样」块）。
      // 偏好路（js_ai preferenceChannels 契约）：内置 exact 名单 + 用户 overlay。
      const preferenceHit = input.preferenceChannels.find((entry) =>
        preferenceEntryMatches(entry, {
          name: resource.name,
          entranceLink: resource.entranceLink,
        }),
      );
      if (preferenceHit) {
        evidence.push(
          pathEvidence(
            "preference",
            `偏好名单命中「${preferenceHit.name}」`,
            `preference:${preferenceHit.name}`,
            resource.entranceLink,
            [],
          ),
        );
      }
      const byPath = new Map<
        DistributionRecallPath,
        DistributionCandidateEvidence
      >();
      for (const item of evidence) {
        const existing = byPath.get(item.path);
        if (!existing) {
          byPath.set(item.path, item);
        } else {
          existing.articleIds = [
            ...new Set([...existing.articleIds, ...item.articleIds]),
          ];
          if (item.path === "passive") {
            // 被动标签逐来源拼接会随命中数线性膨胀（工具结果进 Agent 上下文），
            // 超出预算即截断；完整证据仍由来源引用可溯。
            const merged = `${existing.label}；${item.label}`;
            existing.label =
              merged.length > 200 ? `${merged.slice(0, 200)}…` : merged;
          }
          // reference 逗号合并（Rust 确认门按前缀+逗号解析）：面板四路召回
          // 展示靠它把每个召回来源关联回命中的渠道；fallback 是单条规则路，
          // reference 必须保持 `industry:`/`audience:`/`geo:` 原样，不合并。
          if (item.path !== "fallback") {
            existing.reference = `${existing.reference},${item.reference}`;
          }
        }
      }
      // 垂类/GEO 候选此刻可能零证据（保底证据延迟到召回采样后挂载），保留进
      // 抽样池；t3 人群词与无命中资源照旧出局（三轮裁决：人群不触发保底）。
      if (byPath.size === 0 && !industryMatch && !geoMarked) return [];
      const pathHits = [...byPath.keys()].sort(
        (left, right) =>
          GEO_PORT_CONTRACT.channelRecall.paths[left].number -
          GEO_PORT_CONTRACT.channelRecall.paths[right].number,
      );
      const recommendationWeight = Number(
        pathHits
          .reduce(
            (total, path) =>
              total + GEO_PORT_CONTRACT.channelRecall.paths[path].weight,
            0,
          )
          .toFixed(10),
      );
      const price = parsePrice(resource.price);
      const contentFit = Math.max(
        ...contentTypes.map((type) => CONTENT_KIND_FIT[type][resource.kind]),
      );
      const fitReasons = [
        industryMatch
          ? `行业类目与「${input.industry}」一致`
          : `行业类目未确认匹配「${input.industry}」`,
        audienceMatch
          ? `渠道信息命中目标人群「${input.targetAudience}」`
          : `目标人群匹配仅有间接证据`,
        `文章类型 ${contentTypes.join("/")} 对该渠道形态的最高适配度 ${(contentFit * 100).toFixed(0)}%`,
        ...(industryMatch && geoMarked
          ? [
              `行业垂类且 AI 平台已收录（${resource.geoPlatforms.join("/")}）`,
            ]
          : []),
      ];
      const uncertainties: string[] = [];
      const risks: string[] = [];
      if (price === null)
        uncertainties.push("价格未知，不能进入已确认分发计划");
      if (!byPath.has("passive"))
        risks.push("没有与真实问题来源直接对齐的被动召回证据");
      if (!industryMatch) risks.push("行业结构化类目未命中");
      if (!audienceMatch) risks.push("目标人群适配证据较弱");
      return [
        {
          resourceId: resource.resourceId,
          kind: resource.kind,
          name: resource.name,
          estimatedPriceCny: price,
          publishedRate: resource.publishedRate,
          availability: {
            state: "available",
            providerStatus: 2,
            basis: "supermedia-approved-resource",
          },
          recommendationWeight,
          hitCount: pathHits.length,
          pathHits,
          evidence: [...byPath.values()],
          fitReasons,
          risks,
          uncertainties,
          resourceSnapshot: resource,
          variantFamily: variantFamilyKey({
            name: resource.name,
            entranceLink: resource.entranceLink,
            platform: resource.platform,
          }),
        },
      ];
    })
    .sort(compareByGlobalRank);

  // Q15 主干族指派：包含连通聚类改写 variantFamily（列举网系/跨平台同名并族）。
  assignTrunkFamilies(candidates);

  const mediaQuota = GEO_PORT_CONTRACT.channelRecall.recommendation.mediaQuota;
  const weMediaQuota =
    GEO_PORT_CONTRACT.channelRecall.recommendation.weMediaQuota;
  const familyQuota = GEO_PORT_CONTRACT.channelRecall.variantFamily.familyQuota;
  // ── 变体两级塌缩（Q13，2026-08-28 用户裁决）：同（家族,包）只出 1 个代表
  //（比较器 compareWithinFamily：非junk → 证据权重 → geo 多 → 价低 → id 小）；
  // 代表按全局排序进 quota 走查，家族 ≤2 席。被塌缩/限席挤出的同胞留在对齐
  // 池（面板折叠展示，不算对齐失败）。
  const packKeyOfCandidate = (candidate: DistributionChannelCandidate): string =>
    `${candidate.variantFamily}#${packKeyOf(candidate.resourceSnapshot.name, qualifierSuffixes)}`;
  const packBestByPack = new Map<string, DistributionChannelCandidate>();
  for (const candidate of candidates) {
    const packKey = packKeyOfCandidate(candidate);
    const current = packBestByPack.get(packKey);
    if (!current || compareWithinFamily(candidate, current) < 0) {
      packBestByPack.set(packKey, candidate);
    }
  }
  const admissible = [...packBestByPack.values()].sort(compareByGlobalRank);
  // 本函数构造的候选恒带 variantFamily；?? 兜底只为满足可选类型（旧投影复用）。
  const familyOf = (candidate: DistributionChannelCandidate): string =>
    candidate.variantFamily ?? `${candidate.kind}:${candidate.resourceId}`;
  // ── 保底路召回采样（2026-08-28 三轮用户裁决：随机采样下沉召回层，合并层
  // 恢复纯加权排序取前 30，无任何保底占位）：t0（垂类∩GEO）确定性全量召回；
  // t1（纯垂类）随机补足 verticalQuota 席——数据飞轮探索臂，每次运行抽到
  // 不同子集，未抽中即本次未被保底路召回（不带 0.3 权重，多路命中者权重
  // 回落，如被动+垂类→0.4，与主动路未召回同理）；t2（单 GEO）随机补足至
  // totalCap 封顶；t3 人群不挂保底证据。抽样单位=包代表（家族塌缩前）。
  const random = input.random ?? Math.random;
  const fallbackTierOf = (candidate: DistributionChannelCandidate) =>
    fallbackPreferenceTier(candidate.resourceSnapshot, tierInput);
  const shuffled = <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const fallbackRecall = GEO_PORT_CONTRACT.channelRecall.fallbackRecall;
  const tier0Picks = admissible.filter(
    (candidate) => fallbackTierOf(candidate) === 0,
  );
  const tier1Pool = shuffled(
    admissible.filter((candidate) => fallbackTierOf(candidate) === 1),
  );
  const tier2Pool = shuffled(
    admissible.filter((candidate) => fallbackTierOf(candidate) === 2),
  );
  const tier1Picks = tier1Pool.slice(
    0,
    Math.max(0, fallbackRecall.verticalQuota - tier0Picks.length),
  );
  const tier2Picks = tier2Pool.slice(
    0,
    Math.max(0, fallbackRecall.totalCap - tier0Picks.length - tier1Picks.length),
  );
  const fallbackEvidenceOf = (
    resource: DistributionResourceSnapshot,
  ): DistributionCandidateEvidence => {
    // 三轮裁决：人群词不参与保底路——信号与 reference 只保留行业/GEO 两种
    // 触发。`audience:` reference 分支删除（t2 候选名含人群词时会产出与快照
    // geoPlatforms 不一致的载荷，破坏 Rust 确认门交叉校验；Rust 侧仍兼容
    // 校验旧计划的 audience: 值）。
    const industryHit = industryCategoryMatch(
      resource,
      mediaCodes,
      weMediaCodes,
    );
    const geoHit = resource.geoPlatforms.length > 0;
    const signals = [
      industryHit
        ? `超级媒介结构化类目匹配「${
            [
              ...industryCategoryLabels(mediaCodes, MEDIA_CHANNEL_TYPE_NAMES),
              ...industryCategoryLabels(weMediaCodes, WE_MEDIA_INDUSTRY_NAMES),
            ]
              .join("/")
              .trim() || input.industry}」`
        : null,
      geoHit
        ? `官方 GEO 标记：${resource.geoPlatforms.join("/")}已收录`
        : geoIncluded(resource)
          ? "资源名称/备注含真实 GEO 收录信号"
          : null,
    ].filter((signal): signal is string => signal !== null);
    return pathEvidence(
      "fallback",
      signals.join("；"),
      industryHit
        ? `industry:${input.industry}`
        : `geo:${resource.geoPlatforms.join("/")}`,
      resource.entranceLink,
      [],
    );
  };
  const recalledKeys = new Set(
    [...tier0Picks, ...tier1Picks, ...tier2Picks].map(
      (
        candidate,
      ): `${DistributionChannelKind}:${number}` =>
        `${candidate.kind}:${candidate.resourceId}`,
    ),
  );
  const candidateByKey = new Map(
    candidates.map((candidate) => [
      `${candidate.kind}:${candidate.resourceId}`,
      candidate,
    ] as const),
  );
  for (const key of recalledKeys) {
    const candidate = candidateByKey.get(key);
    if (!candidate) continue;
    candidate.evidence.push(fallbackEvidenceOf(candidate.resourceSnapshot));
    const mergedHits: DistributionRecallPath[] = [
      ...candidate.pathHits,
      "fallback",
    ];
    mergedHits.sort(
      (left, right) =>
        GEO_PORT_CONTRACT.channelRecall.paths[left].number -
        GEO_PORT_CONTRACT.channelRecall.paths[right].number,
    );
    candidate.pathHits = mergedHits;
    candidate.hitCount = candidate.pathHits.length;
    candidate.recommendationWeight = Number(
      candidate.pathHits
        .reduce(
          (total, path) =>
            total + GEO_PORT_CONTRACT.channelRecall.paths[path].weight,
          0,
        )
        .toFixed(10),
    );
  }
  // 未被任何路召回的候选退出候选集（纯垂类/单GEO 未抽中、t3 人群无其它路）。
  candidates = candidates.filter(
    (candidate) => candidate.pathHits.length > 0,
  );
  // ── 家族限席 + 全局排序走查（三轮裁决恢复旧语义）：admissible 过滤到已
  // 召回成员后按最终权重排序，家族 ≤2 席，再走媒体/自媒体配额取前 30。
  const familyUsed = new Map<string, number>();
  const familyAdmitted = admissible
    .filter((candidate) => candidate.pathHits.length > 0)
    .sort(compareByGlobalRank)
    .filter((candidate) => {
      const family = familyOf(candidate);
      const used = familyUsed.get(family) ?? 0;
      if (used >= familyQuota) return false;
      familyUsed.set(family, used + 1);
      return true;
    });
  const mediaCount = familyAdmitted.filter(
    (candidate) => candidate.kind === "media",
  ).length;
  const weMediaCount = familyAdmitted.length - mediaCount;
  let mediaTake = mediaQuota;
  let weMediaTake = weMediaQuota;
  if (mediaCount < mediaQuota) weMediaTake += mediaQuota - mediaCount;
  else if (weMediaCount < weMediaQuota) mediaTake += weMediaQuota - weMediaCount;
  let usedMedia = 0;
  let usedWeMedia = 0;
  const recommended = familyAdmitted
    .filter((candidate) => {
      if (candidate.kind === "media") {
        if (usedMedia >= mediaTake) return false;
        usedMedia += 1;
        return true;
      }
      if (usedWeMedia >= weMediaTake) return false;
      usedWeMedia += 1;
      return true;
    })
    .slice(0, DISTRIBUTION_MAX_CANDIDATES);
  const recommendedKeys = new Set(
    recommended.map((candidate) => `${candidate.kind}:${candidate.resourceId}`),
  );
  // ── 被动对齐渠道：按变体家族折叠（Q13/S1，2026-08-28）。代表 =
  // compareWithinFamily 最优成员；引用/问题/账号为家族并集；recommended =
  // 家族任一成员进入推荐。cap 按家族数计（防止 7 个同名变体吃满 50 个名额）。
  const passiveFamilyGroups = new Map<
    string,
    DistributionChannelCandidate[]
  >();
  for (const candidate of candidates) {
    if (!candidate.evidence.some((item) => item.path === "passive")) continue;
    const family = familyOf(candidate);
    const group = passiveFamilyGroups.get(family) ?? [];
    group.push(candidate);
    passiveFamilyGroups.set(family, group);
  }
  const passiveAlignedChannels: DistributionPassiveAlignedChannel[] = [
    ...passiveFamilyGroups.values(),
  ]
    .map((members) => {
      const rep = [...members].sort(compareWithinFamily)[0]!;
      const questions = new Set<string>();
      const accounts = new Set<string>();
      let citations = 0;
      for (const member of members) {
        const stat = passiveStats.get(
          `${member.kind}:${member.resourceId}`,
        );
        citations += stat?.citations ?? 0;
        for (const question of stat?.questions ?? []) questions.add(question);
        for (const account of stat?.accounts ?? []) accounts.add(account);
      }
      const prices = members
        .map((member) => member.estimatedPriceCny)
        .filter((price): price is number => price !== null);
      return {
        resourceId: rep.resourceId,
        kind: rep.kind,
        name: rep.name,
        estimatedPriceCny: rep.estimatedPriceCny,
        citations,
        questions: questions.size,
        accounts: [...accounts],
        recommended: members.some((member) =>
          recommendedKeys.has(`${member.kind}:${member.resourceId}`),
        ),
        variantCount: members.length,
        priceMinCny: prices.length > 0 ? Math.min(...prices) : null,
        priceMaxCny: prices.length > 0 ? Math.max(...prices) : null,
      };
    })
    .sort(
      (left, right) =>
        right.questions - left.questions ||
        right.citations - left.citations ||
        left.name.localeCompare(right.name, "zh-CN"),
    )
    .slice(0, PASSIVE_ALIGNED_CHANNEL_CAP);
  // ── 偏好命中清单（Q12，2026-08-28）：配额前逐名单项计算，每项一行代表
  //（全名逐字命中者优先，否则包代表规则）；matched=false = 核心名在价内池
  // 不存在，如实展示（安庆新闻网型）。
  const preferenceMatchedChannels: DistributionPreferenceMatchedChannel[] =
    input.preferenceChannels.map((entry) => {
      const members = candidates.filter((candidate) =>
        preferenceEntryMatches(entry, {
          name: candidate.resourceSnapshot.name,
          entranceLink: candidate.resourceSnapshot.entranceLink,
        }),
      );
      if (members.length === 0) {
        return {
          entryName: entry.name,
          matched: false,
          representativeName: null,
          representativePriceCny: null,
          variantCount: 0,
          recommended: false,
        };
      }
      const exactMember = members.find(
        (member) =>
          normalizeChannelName(entry.name) ===
          normalizeChannelName(member.resourceSnapshot.name),
      );
      const rep = exactMember ?? [...members].sort(compareWithinFamily)[0]!;
      return {
        entryName: entry.name,
        matched: true,
        representativeName: rep.name,
        representativePriceCny: rep.estimatedPriceCny,
        variantCount: members.length,
        recommended: members.some((member) =>
          recommendedKeys.has(`${member.kind}:${member.resourceId}`),
        ),
      };
    });
  const alignedByPath = { passive: 0, active: 0, fallback: 0, preference: 0 };
  for (const candidate of candidates) {
    for (const item of candidate.evidence) alignedByPath[item.path] += 1;
  }
  return {
    candidates: recommended,
    resourceSnapshot: recommended.map(
      (candidate) => candidate.resourceSnapshot,
    ),
    passiveAlignedChannels,
    citationSiteNames,
    preferenceMatchedChannels,
    summary: {
      inputResources: resources.length,
      approvedResources: approved.length,
      filteredUnavailable,
      filteredUnknownPrice,
      filteredOverPerArticleLimit,
      alignedResources: candidates.length,
      recommendedResources: recommended.length,
      alignedFamilies: new Set(candidates.map(familyOf)).size,
      alignedByPath,
      citationDomains: citationDomains.size,
      citationDomainPoolHits: citationPoolHits.size,
    },
  };
}

function candidateForArticle(
  article: DistributionArticleSnapshot,
  candidates: DistributionChannelCandidate[],
  tierInput?: {
    mediaCodes: ReadonlySet<number>;
    weMediaCodes: ReadonlySet<number>;
    targetAudience: string;
  },
): DistributionChannelCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftPassive = left.evidence.some(
      (item) => item.path === "passive" && item.articleIds.includes(article.id),
    );
    const rightPassive = right.evidence.some(
      (item) => item.path === "passive" && item.articleIds.includes(article.id),
    );
    if (leftPassive !== rightPassive) return leftPassive ? -1 : 1;
    const leftFit = CONTENT_KIND_FIT[article.contentType][left.kind];
    const rightFit = CONTENT_KIND_FIT[article.contentType][right.kind];
    const tier = tierInput
      ? fallbackPreferenceTier(left.resourceSnapshot, tierInput) -
        fallbackPreferenceTier(right.resourceSnapshot, tierInput)
      : 0;
    return (
      rightFit - leftFit ||
      right.recommendationWeight - left.recommendationWeight ||
      tier ||
      left.resourceId - right.resourceId
    );
  });
}

export function assignDistributionChannels(input: {
  articles: DistributionArticleSnapshot[];
  candidates: DistributionChannelCandidate[];
  mappingMode: DistributionPlanStartInput["mappingMode"];
  ratio: DistributionPlanStartInput["ratio"];
  totalMaxPoints: number;
  publishStartAt: string;
  /**
   * 保底路分档 tie-break 输入（垂类∩GEO > 纯垂类 > 纯GEO > 仅人群词）；
   * 缺省时不分档（保持旧排序），确认门校验不感知该字段。
   */
  industry?: string;
  targetAudience?: string;
}): DistributionAssignment[] {
  const tierInput =
    input.industry !== undefined && input.targetAudience !== undefined
      ? {
          mediaCodes: industryCodesFor(
            input.industry,
            MEDIA_CHANNEL_TYPE_NAMES,
          ),
          weMediaCodes: industryCodesFor(
            input.industry,
            WE_MEDIA_INDUSTRY_NAMES,
          ),
          targetAudience: input.targetAudience,
        }
      : undefined;
  const scheduledAt = validIsoTimestamp(input.publishStartAt);
  const used = new Set<number>();
  const totalRatio = input.ratio.media + input.ratio.weMedia;
  const mediaTarget =
    input.mappingMode === "ratio"
      ? Math.round((input.articles.length * input.ratio.media) / totalRatio)
      : input.articles.length;
  let mediaUsed = 0;
  let allocatedPoints = 0;
  return input.articles.map((article) => {
    let ranked = candidateForArticle(
      article,
      input.candidates,
      tierInput,
    ).filter((candidate) => !used.has(candidate.resourceId));
    if (input.mappingMode === "ratio") {
      const preferredKind: DistributionChannelKind =
        mediaUsed < mediaTarget ? "media" : "we-media";
      ranked = [
        ...ranked.filter((candidate) => candidate.kind === preferredKind),
        ...ranked.filter((candidate) => candidate.kind !== preferredKind),
      ];
    }
    const selected = ranked.find((candidate) => {
      if (candidate.estimatedPriceCny === null) return false;
      return (
        allocatedPoints + cnyToPoints(candidate.estimatedPriceCny) <=
        input.totalMaxPoints
      );
    });
    if (!selected) {
      return {
        articleId: article.id,
        resourceId: null,
        reason: "unassigned",
        scheduledAt,
      };
    }
    used.add(selected.resourceId);
    if (selected.estimatedPriceCny !== null) {
      allocatedPoints += cnyToPoints(selected.estimatedPriceCny);
    }
    if (selected.kind === "media") mediaUsed += 1;
    const passive = selected.evidence.some(
      (item) => item.path === "passive" && item.articleIds.includes(article.id),
    );
    const contentFit = CONTENT_KIND_FIT[article.contentType][selected.kind];
    return {
      articleId: article.id,
      resourceId: selected.resourceId,
      reason: passive
        ? "source-evidence"
        : contentFit >= 0.6
          ? "content-fit"
          : "weighted-score",
      scheduledAt,
    };
  });
}

export function distributionPlanBlockingIssues(
  plan: Pick<
    DistributionPlanProjection,
    | "providerState"
    | "questionSources"
    | "articles"
    | "candidates"
    | "selectedResourceIds"
    | "assignments"
    | "perArticleMaxPoints"
    | "totalMaxPoints"
    | "budgetCny"
  >,
): string[] {
  const issues: string[] = [];
  if (plan.providerState !== "available")
    issues.push("distribution-provider-unavailable");
  // 被动证据为空不再是阻断（用户裁决 2026-08-18，对齐 js_ai）：探测失败只降级，
  // 计划照常进入候选与确认链路。
  if (plan.candidates.length === 0)
    issues.push("channel-candidate-unavailable");
  const selected = new Set(plan.selectedResourceIds);
  if (selected.size !== plan.selectedResourceIds.length)
    issues.push("selected-channel-duplicate");
  const byResource = new Map(
    plan.candidates.map((candidate) => [candidate.resourceId, candidate]),
  );
  let estimatedTotalPoints = 0;
  for (const resourceId of selected) {
    const candidate = byResource.get(resourceId);
    if (!candidate) {
      issues.push("selected-channel-outside-resource-snapshot");
      continue;
    }
    if (
      candidate.availability.state !== "available" ||
      candidate.availability.providerStatus !== 2
    ) {
      issues.push("selected-channel-unavailable");
    }
    if (candidate.estimatedPriceCny === null) {
      issues.push("selected-channel-price-unknown");
    } else {
      const pricePoints = cnyToPoints(candidate.estimatedPriceCny);
      estimatedTotalPoints += pricePoints;
      if (
        pricePoints >
        (plan.perArticleMaxPoints ??
          DEFAULT_DISTRIBUTION_SPEND_LIMITS.perArticleMaxPoints)
      ) {
        issues.push("selected-channel-per-article-limit-exceeded");
      }
    }
    if (candidate.evidence.length === 0)
      issues.push("selected-channel-evidence-missing");
  }
  const articleIds = new Set(plan.articles.map((article) => article.id));
  const assignedArticles = new Set<string>();
  const assignedResources = new Set<number>();
  for (const assignment of plan.assignments) {
    if (
      !articleIds.has(assignment.articleId) ||
      assignedArticles.has(assignment.articleId)
    ) {
      issues.push("article-assignment-invalid");
    }
    assignedArticles.add(assignment.articleId);
    if (assignment.resourceId === null) {
      issues.push("article-channel-unassigned");
      continue;
    }
    if (!selected.has(assignment.resourceId))
      issues.push("article-channel-not-selected");
    if (assignedResources.has(assignment.resourceId))
      issues.push("channel-reuse-forbidden");
    assignedResources.add(assignment.resourceId);
    if (!Number.isFinite(Date.parse(assignment.scheduledAt)))
      issues.push("assignment-time-invalid");
  }
  if (assignedArticles.size !== articleIds.size)
    issues.push("article-assignment-incomplete");
  const budgetPoints = cnyToPoints(plan.budgetCny);
  const totalMaxPoints = plan.totalMaxPoints ?? budgetPoints;
  if (estimatedTotalPoints > Math.min(totalMaxPoints, budgetPoints))
    issues.push("distribution-budget-exceeded");
  return [...new Set(issues)];
}

export function applyDistributionPlanEdit(
  plan: DistributionPlanProjection,
  input: DistributionPlanEditInput,
): DistributionPlanEditInput & { blockingIssues: string[] } {
  if (plan.status === "confirmed")
    throw new Error("distribution_plan_confirmed_immutable");
  if (
    !Number.isFinite(input.budgetCny) ||
    input.budgetCny < 0 ||
    input.budgetCny > 10_000_000
  ) {
    throw new Error("distribution_plan_budget_invalid");
  }
  const selectedResourceIds = [...new Set(input.selectedResourceIds)];
  const publishStartAt = validIsoTimestamp(input.publishStartAt);
  const assignments = input.assignments.map((assignment) => ({
    ...assignment,
    scheduledAt: validIsoTimestamp(assignment.scheduledAt),
  }));
  const next = {
    ...plan,
    selectedResourceIds,
    assignments,
    budgetCny: Math.round(input.budgetCny * 100) / 100,
    publishStartAt,
  };
  return {
    selectedResourceIds,
    assignments,
    budgetCny: next.budgetCny,
    publishStartAt,
    blockingIssues: distributionPlanBlockingIssues(next),
  };
}

export function assertDistributionPlanConfirmable(
  plan: DistributionPlanProjection,
): void {
  const issues = distributionPlanBlockingIssues(plan);
  if (issues.length > 0 || plan.blockingIssues.length > 0) {
    throw new Error(
      `distribution_plan_confirmation_blocked:${[...new Set([...plan.blockingIssues, ...issues])].join(",")}`,
    );
  }
}
