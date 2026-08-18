import { GEO_PORT_CONTRACT, type GeoContentType } from "./portContract";

export const DISTRIBUTION_PLAN_POLICY_VERSION =
  "js-ai-dev-four-path-distribution-v1";
export const DISTRIBUTION_RESOURCE_PAGE_SIZE = 200;
export const DISTRIBUTION_RESOURCE_MAX_PAGES = 1_000;
export const DISTRIBUTION_MAX_CANDIDATES =
  GEO_PORT_CONTRACT.channelRecall.recommendation.max;

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

export interface DistributionPlanningContext {
  articleOperationId: string;
  knowledgeVersion: number;
  industry: string;
  articles: DistributionArticleSnapshot[];
  questionSources: DistributionQuestionSource[];
}

export interface DistributionResourceSnapshot {
  resourceId: number;
  kind: DistributionChannelKind;
  name: string;
  status: number | null;
  price: string | null;
  publishedRate: number | null;
  entranceLink: string | null;
  remark: string | null;
  channelType: number | null;
  industryCategory: number | null;
  area: number | null;
  canWeekend: boolean | null;
  publishSpeed: number | null;
  publishedAverageMinutes: number | null;
  platform: number | null;
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
  filteredLowPublishedRate: number;
  filteredHighPrice: number;
  alignedResources: number;
  recommendedResources: number;
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

export interface DistributionResourceInput {
  id: number;
  name: string;
  status?: number;
  price?: string | number | null;
  published_rate?: number | null;
  entrance_link?: string | null;
  remark?: string | null;
  channel_type?: number | null;
  industry_category?: number | null;
  area?: number | null;
  can_weekend?: boolean | null;
  publish_speed?: number | null;
  published_avg?: number | null;
  platform?: number | null;
}

const INDUSTRY_TO_MEDIA: Readonly<Record<string, number>> = {
  汽车: 6,
  车辆: 6,
  汽修: 6,
  汽配: 6,
  驾校: 6,
  驾驶: 6,
  科技: 1,
  IT: 1,
  互联网: 1,
  软件: 1,
  数码: 1,
  电子: 1,
  人工智能: 1,
  财经: 11,
  金融: 11,
  投资: 11,
  理财: 11,
  证券: 11,
  保险: 11,
  银行: 11,
  新闻: 12,
  资讯: 12,
  媒体: 12,
  健康: 9,
  医疗: 9,
  医药: 9,
  医美: 9,
  养生: 9,
  教育: 7,
  培训: 7,
  留学: 7,
  留学移民: 7,
  生活: 2,
  消费: 2,
  美食: 2,
  餐饮: 2,
  家政: 2,
  时尚: 3,
  女性: 3,
  美妆: 3,
  服饰: 3,
  奢侈品: 3,
  娱乐: 4,
  影视: 4,
  明星: 4,
  音乐: 4,
  综艺: 4,
  游戏: 5,
  电竞: 5,
  旅游: 8,
  旅行: 8,
  酒店: 8,
  民宿: 8,
  房产: 10,
  家居: 10,
  装修: 10,
  建材: 10,
  文化: 16,
  艺术: 16,
  收藏: 16,
  书画: 16,
  体育: 17,
  运动: 17,
  健身: 17,
  足球: 17,
  篮球: 17,
  食品: 18,
  农业: 18,
  农资: 18,
  工业: 19,
  制造: 19,
  机械: 19,
  能源: 19,
  化工: 19,
  母婴: 20,
  亲子: 20,
  孕产: 20,
  公益: 21,
  慈善: 21,
};

const INDUSTRY_TO_WE_MEDIA: Readonly<Record<string, number>> = {
  汽车: 7,
  车辆: 7,
  汽修: 7,
  汽配: 7,
  科技: 5,
  IT: 5,
  互联网: 5,
  软件: 5,
  财经: 4,
  金融: 4,
  投资: 4,
  理财: 4,
  新闻: 23,
  资讯: 23,
  健康: 10,
  医疗: 10,
  医药: 10,
  医美: 10,
  教育: 11,
  培训: 11,
  美食: 13,
  餐饮: 13,
  时尚: 9,
  美妆: 9,
  娱乐: 8,
  影视: 8,
  游戏: 16,
  电竞: 16,
  旅游: 14,
  旅行: 14,
  房产: 19,
  家居: 24,
  体育: 6,
  运动: 6,
  母婴: 12,
  亲子: 12,
  文化: 1,
  历史: 2,
};

const CONTENT_KIND_FIT: Readonly<
  Record<GeoContentType, Record<DistributionChannelKind, number>>
> = {
  guide: { media: 0.5, "we-media": 0.5 },
  showcase: { media: 0.4, "we-media": 1 },
  ranking: { media: 0.6, "we-media": 0.4 },
  news: { media: 1, "we-media": 0.3 },
  news_light: { media: 1, "we-media": 0.3 },
};

const COMMON_TWO_LEVEL_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
]);

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

function registeredDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const hostname = new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./, "");
    const labels = hostname.split(".").filter(Boolean);
    if (labels.length < 2) return null;
    const suffix = labels.slice(-2).join(".");
    return COMMON_TWO_LEVEL_SUFFIXES.has(suffix) && labels.length >= 3
      ? labels.slice(-3).join(".")
      : suffix;
  } catch {
    return null;
  }
}

function industryCode(
  industry: string,
  table: Readonly<Record<string, number>>,
): number | null {
  const direct = table[industry];
  if (direct !== undefined) return direct;
  const hit = Object.entries(table)
    .filter(([label]) => industry.includes(label))
    .sort((left, right) => right[0].length - left[0].length)[0];
  return hit?.[1] ?? null;
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
  return (
    source.length >= 3 &&
    resource.length >= 3 &&
    (source.includes(resource) || resource.includes(source))
  );
}

function geoIncluded(snapshot: DistributionResourceSnapshot): boolean {
  const text = `${snapshot.name} ${snapshot.remark ?? ""}`;
  if (
    ["豆包", "文心一言", "文心", "通义千问", "通义", "腾讯元宝", "元宝"].some(
      (term) => text.includes(term),
    )
  )
    return true;
  return /\b(ai|geo|kimi|deepseek)\b/i.test(text);
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
  }));
  if (questionSources.length > 100)
    throw new Error("distribution_plan_sources_invalid");
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
  };
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
  preferredResourceIds: number[];
  articles: DistributionArticleSnapshot[];
  resources: DistributionResourceSnapshot[];
}): {
  candidates: DistributionChannelCandidate[];
  resourceSnapshot: DistributionResourceSnapshot[];
  summary: DistributionDiscoverySummary;
} {
  const unique = new Map<string, DistributionResourceSnapshot>();
  for (const resource of input.resources) {
    unique.set(`${resource.kind}:${resource.resourceId}`, resource);
  }
  const resources = [...unique.values()];
  const mediaCode = industryCode(input.industry, INDUSTRY_TO_MEDIA);
  const weMediaCode = industryCode(input.industry, INDUSTRY_TO_WE_MEDIA);
  const contentTypes = [
    ...new Set(input.articles.map((article) => article.contentType)),
  ];
  const preferred = new Set(input.preferredResourceIds);
  let filteredUnavailable = 0;
  let filteredLowPublishedRate = 0;
  let filteredHighPrice = 0;
  const approved: DistributionResourceSnapshot[] = [];
  for (const resource of resources) {
    if (resource.status !== 2) {
      filteredUnavailable += 1;
      continue;
    }
    if (
      resource.publishedRate !== null &&
      resource.publishedRate > 0 &&
      resource.publishedRate <
        GEO_PORT_CONTRACT.channelRecall.quality.minimumKnownPublishedRate
    ) {
      filteredLowPublishedRate += 1;
      continue;
    }
    const price = parsePrice(resource.price);
    if (
      price !== null &&
      price >= GEO_PORT_CONTRACT.channelRecall.quality.maximumPriceExclusive
    ) {
      filteredHighPrice += 1;
      continue;
    }
    approved.push(resource);
  }

  const candidates = approved
    .flatMap((resource): DistributionChannelCandidate[] => {
      const evidence: DistributionCandidateEvidence[] = [];
      const resourceDomain = registeredDomain(resource.entranceLink);
      for (const source of input.questionSources) {
        const sourceDomain = registeredDomain(source.url);
        if (
          (resourceDomain && sourceDomain === resourceDomain) ||
          nameMatches(source.title, resource.name)
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
        }
      }
      const industryMatch =
        resource.kind === "media"
          ? mediaCode !== null && resource.channelType === mediaCode
          : weMediaCode !== null && resource.industryCategory === weMediaCode;
      const audienceMatch = audienceOverlap(input.targetAudience, resource);
      if (industryMatch || audienceMatch) {
        evidence.push(
          pathEvidence(
            "active",
            industryMatch
              ? `超级媒介结构化类目匹配行业「${input.industry}」`
              : `渠道名称或备注匹配目标人群「${input.targetAudience}」`,
            industryMatch
              ? `industry:${input.industry}`
              : `audience:${input.targetAudience}`,
            resource.entranceLink,
            [],
          ),
        );
      }
      if (industryMatch && geoIncluded(resource)) {
        evidence.push(
          pathEvidence(
            "fallback",
            "行业类目命中且资源名称/备注含真实 GEO 收录信号",
            `resource:${resource.kind}:${resource.resourceId}`,
            resource.entranceLink,
            [],
          ),
        );
      }
      if (preferred.has(resource.resourceId)) {
        evidence.push(
          pathEvidence(
            "preference",
            "用户明确偏好且资源仍存在于已批准超级媒介池",
            `preferred-resource:${resource.resourceId}`,
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
            existing.label = `${existing.label}；${item.label}`;
            existing.reference = `${existing.reference},${item.reference}`;
          }
        }
      }
      if (byPath.size === 0) return [];
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
      ];
      const uncertainties: string[] = [];
      const risks: string[] = [];
      if (price === null)
        uncertainties.push("价格未知，不能进入已确认分发计划");
      if (resource.publishedRate === null || resource.publishedRate === 0) {
        uncertainties.push("发布成功率未知，不能进入已确认分发计划");
      }
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
        },
      ];
    })
    .sort(
      (left, right) =>
        right.recommendationWeight - left.recommendationWeight ||
        right.hitCount - left.hitCount ||
        left.name.localeCompare(right.name, "zh-CN") ||
        left.resourceId - right.resourceId,
    );

  const mediaQuota = GEO_PORT_CONTRACT.channelRecall.recommendation.mediaQuota;
  const weMediaQuota =
    GEO_PORT_CONTRACT.channelRecall.recommendation.weMediaQuota;
  const mediaCount = candidates.filter(
    (candidate) => candidate.kind === "media",
  ).length;
  const weMediaCount = candidates.length - mediaCount;
  let mediaTake = mediaQuota;
  let weMediaTake = weMediaQuota;
  if (mediaCount < mediaQuota) weMediaTake += mediaQuota - mediaCount;
  else if (weMediaCount < weMediaQuota)
    mediaTake += weMediaQuota - weMediaCount;
  let usedMedia = 0;
  let usedWeMedia = 0;
  const recommended = candidates
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
  return {
    candidates: recommended,
    resourceSnapshot: recommended.map(
      (candidate) => candidate.resourceSnapshot,
    ),
    summary: {
      inputResources: resources.length,
      approvedResources: approved.length,
      filteredUnavailable,
      filteredLowPublishedRate,
      filteredHighPrice,
      alignedResources: candidates.length,
      recommendedResources: recommended.length,
    },
  };
}

function candidateForArticle(
  article: DistributionArticleSnapshot,
  candidates: DistributionChannelCandidate[],
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
    return (
      rightFit - leftFit ||
      right.recommendationWeight - left.recommendationWeight ||
      left.resourceId - right.resourceId
    );
  });
}

export function assignDistributionChannels(input: {
  articles: DistributionArticleSnapshot[];
  candidates: DistributionChannelCandidate[];
  mappingMode: DistributionPlanStartInput["mappingMode"];
  ratio: DistributionPlanStartInput["ratio"];
  publishStartAt: string;
}): DistributionAssignment[] {
  const scheduledAt = validIsoTimestamp(input.publishStartAt);
  const used = new Set<number>();
  const totalRatio = input.ratio.media + input.ratio.weMedia;
  const mediaTarget =
    input.mappingMode === "ratio"
      ? Math.round((input.articles.length * input.ratio.media) / totalRatio)
      : input.articles.length;
  let mediaUsed = 0;
  return input.articles.map((article) => {
    let ranked = candidateForArticle(article, input.candidates).filter(
      (candidate) => !used.has(candidate.resourceId),
    );
    if (input.mappingMode === "ratio") {
      const preferredKind: DistributionChannelKind =
        mediaUsed < mediaTarget ? "media" : "we-media";
      ranked = [
        ...ranked.filter((candidate) => candidate.kind === preferredKind),
        ...ranked.filter((candidate) => candidate.kind !== preferredKind),
      ];
    }
    const selected = ranked[0];
    if (!selected) {
      return {
        articleId: article.id,
        resourceId: null,
        reason: "unassigned",
        scheduledAt,
      };
    }
    used.add(selected.resourceId);
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
    | "budgetCny"
  >,
): string[] {
  const issues: string[] = [];
  if (plan.providerState !== "available")
    issues.push("distribution-provider-unavailable");
  if (plan.questionSources.length === 0)
    issues.push("question-source-evidence-missing");
  if (plan.candidates.length === 0)
    issues.push("channel-candidate-unavailable");
  const selected = new Set(plan.selectedResourceIds);
  if (selected.size !== plan.selectedResourceIds.length)
    issues.push("selected-channel-duplicate");
  const byResource = new Map(
    plan.candidates.map((candidate) => [candidate.resourceId, candidate]),
  );
  let estimatedTotal = 0;
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
    if (candidate.estimatedPriceCny === null)
      issues.push("selected-channel-price-unknown");
    else estimatedTotal += candidate.estimatedPriceCny;
    if (candidate.publishedRate === null || candidate.publishedRate === 0) {
      issues.push("selected-channel-published-rate-unknown");
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
  if (estimatedTotal > plan.budgetCny)
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
