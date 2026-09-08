import { createHash } from "node:crypto";

import {
  DISTRIBUTION_PLAN_POLICY_VERSION,
  DISTRIBUTION_RESOURCE_MAX_PAGES,
  DISTRIBUTION_RESOURCE_PAGE_SIZE,
  applyDistributionPlanEdit,
  assertDistributionPlanConfirmable,
  assignDistributionChannels,
  buildDistributionCandidates,
  distributionPlanBlockingIssues,
  industryCodesFor,
  normalizeDistributionResource,
  selectPassiveSources,
  validateDistributionPlanStartInput,
  WE_MEDIA_INDUSTRY_NAMES,
  type DistributionActiveRecallSource,
  type DistributionPlanEditInput,
  type DistributionPlanProjection,
  type DistributionPlanStartInput,
  type DistributionPlanningContext,
  type DistributionSpendLimits,
  type DistributionProviderSnapshot,
  type DistributionQuestionSource,
  type DistributionResourceInput,
  type DistributionResourceSnapshot,
} from "../../shared/geo/distributionPlan";
import {
  accountNameFromTitle,
  buildGlobalRecallPrompt,
  clampTopicNumbers,
  isMultiTenantPlatformUrl,
  parseGlobalRecallResult,
  resolvePreferenceChannels,
  type PreferenceChannelEntry,
  type PreferenceChannelSettings,
  type RecallSource,
} from "../../shared/geo/channelRecall";
import { parseGeoProbeProviderResponse } from "../../shared/geo/baseline";
import { cnyToPoints } from "../../shared/geo/points";
import { GEO_PORT_CONTRACT } from "../../shared/geo/portContract";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import { fetch as undiciFetch } from "undici";
import { managementApi } from "../utils/management-api-client";
import { withAbortSignal } from "../utils/cancellation";
import { buildSsrfGuardedDispatcher, isUrlSchemeSafe } from "../utils/ssrf";
import type { GeoBillingPermitPort } from "./billing-permit";
import type {
  GeoDistributionCapability,
  GeoDistributionResource,
  GeoKeywordSearchCapability,
} from "./provider-capabilities";

/** 四路召回对 keyword-search 端口的消费面（探测 + 联网生成，便于测试注入）。 */
export type DistributionKeywordSearchPort = Pick<
  GeoKeywordSearchCapability,
  "probeQuestion" | "search"
>;

// L3 账号解析（契约 accountResolution）：引用页作者抓取的限量与超时。
const CITATION_PAGE_FETCH_LIMIT =
  GEO_PORT_CONTRACT.channelRecall.accountResolution.layer3.pageAuthorFetch
    .limit;
const CITATION_PAGE_FETCH_TIMEOUT_MS =
  GEO_PORT_CONTRACT.channelRecall.accountResolution.layer3.pageAuthorFetch
    .timeoutMs;

/**
 * 抓引用页 HTML（SSRF 守卫 + 8s 超时；任何失败返回 null 静默降级）。
 * 仅 HTTPS、仅公网地址、域名解析钉扎——与材料导入同一套守卫口径。
 */
async function fetchCitationPageHtml(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (!isUrlSchemeSafe(parsed).ok) return null;
    const dispatcher = await buildSsrfGuardedDispatcher(parsed);
    return await withAbortSignal(
      undefined,
      async (signal) => {
        const response = await undiciFetch(parsed, {
          signal,
          ...(dispatcher ? { dispatcher } : {}),
          redirect: "follow",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          },
        });
        if (!response.ok) return null;
        const html = await response.text();
        return html.length > 0 ? html.slice(0, 400_000) : null;
      },
      { timeoutMs: CITATION_PAGE_FETCH_TIMEOUT_MS },
    );
  } catch {
    return null;
  }
}

/**
 * 从页面 HTML 提取作者/账号名：meta（article:author / og:article:author /
 * author / twitter:creator）优先，JSON-LD 的 author 字段兜底。纯启发式，
 * 提不到返回 null——L3 失败只损失账号标注，不影响对齐本身。
 */
export function authorNameFromPageHtml(html: string): string | null {
  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["'](?:article:author|og:article:author|twitter:creator)["'][^>]*?content=["']([^"']{2,60})["']/i,
    /<meta[^>]+content=["']([^"']{2,60})["'][^>]*?(?:property|name)=["'](?:article:author|og:article:author|twitter:creator)["']/i,
    /<meta[^>]+name=["']author["'][^>]*?content=["']([^"']{2,60})["']/i,
    /<meta[^>]+content=["']([^"']{2,60})["'][^>]*?name=["']author["']/i,
  ];
  for (const pattern of metaPatterns) {
    const value = html.match(pattern)?.[1]?.trim();
    if (value) return value;
  }
  const ldBlocks =
    html.match(
      /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi,
    ) ?? [];
  for (const block of ldBlocks) {
    const payload = block
      .replace(/^<script[^>]*>/i, "")
      .replace(/<\/script>\s*$/i, "")
      .trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const stack: unknown[] = [parsed];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if (!node || typeof node !== "object") continue;
      const record = node as Record<string, unknown>;
      const author = record.author;
      const name =
        typeof author === "string"
          ? author
          : author &&
              typeof author === "object" &&
              !Array.isArray(author) &&
              typeof (author as Record<string, unknown>).name === "string"
            ? ((author as Record<string, unknown>).name as string)
            : null;
      if (name) {
        const trimmed = name.trim();
        if (trimmed.length >= 2 && trimmed.length <= 60) return trimmed;
      }
      stack.push(...Object.values(record));
    }
  }
  return null;
}

export interface DistributionPlanPreparation {
  plan: DistributionPlanProjection;
  claimToken: string;
}

export interface DistributionPlanPersistencePort {
  spendLimits(): Promise<DistributionSpendLimits>;
  context(articleOperationId?: string): Promise<DistributionPlanningContext>;
  latest(): Promise<DistributionPlanProjection | null>;
  get(planId: string): Promise<DistributionPlanProjection>;
  /** 偏好渠道 overlay（品牌库单例；读失败按无 overlay 降级）。 */
  channelPreferences(): Promise<PreferenceChannelSettings | undefined>;
  prepare(
    input: DistributionPlanStartInput,
  ): Promise<DistributionPlanPreparation>;
  finishDiscovery(input: {
    planId: string;
    expectedRevision: number;
    claimToken: string;
    providerState: "available" | "unavailable";
    providerSnapshot: DistributionProviderSnapshot;
    resourceSnapshot: DistributionResourceSnapshot[];
    candidates: DistributionPlanProjection["candidates"];
    selectedResourceIds: number[];
    assignments: DistributionPlanProjection["assignments"];
    discoverySummary: DistributionPlanProjection["discoverySummary"];
    blockingIssues: string[];
    /** 召回输入快照（右侧面板四路召回展示）：主动路原始渠道 + 偏好生效名单。 */
    activeRecallSources: DistributionActiveRecallSource[];
    preferenceChannelNames: string[];
    /** 被动路对齐渠道列表（≤50；面板「对齐渠道」区数据源）。 */
    passiveAlignedChannels: DistributionPlanProjection["passiveAlignedChannels"];
    /** 引用站点显示名映射（注册域名 → 池反查/标题尾缀解析的展示名）。 */
    citationSiteNames: DistributionPlanProjection["citationSiteNames"];
    /** 偏好路命中清单（配额前逐名单项一行代表；面板「偏好召回」区数据源）。 */
    preferenceMatchedChannels: DistributionPlanProjection["preferenceMatchedChannels"];
  }): Promise<DistributionPlanProjection>;
  edit(input: {
    planId: string;
    expectedRevision: number;
    edit: DistributionPlanEditInput & { blockingIssues: string[] };
    /** 聊天修订（票 38）携带用户指令原文，写入 geo_distribution_plan_audit。 */
    reason?: string;
  }): Promise<DistributionPlanProjection>;
  confirm(input: {
    planId: string;
    expectedRevision: number;
  }): Promise<DistributionPlanProjection>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "distribution_plan_persistence_failed",
  );
}

export class RustDistributionPlanPort
  implements DistributionPlanPersistencePort
{
  constructor(
    private readonly identity: {
      workspaceId: string;
      sessionId: string;
      sidecarId: string;
    },
  ) {}

  private envelope(payload: object): Record<string, unknown> {
    return { ...this.identity, payload };
  }

  private async post<T>(
    path: string,
    payload: object,
    key: string,
  ): Promise<T> {
    const result = await managementApi(path, "POST", this.envelope(payload));
    if (result.ok !== true) throw persistenceError(result);
    return result[key] as T;
  }

  latest(): Promise<DistributionPlanProjection | null> {
    return this.post("/api/brand-distribution-plans/latest", {}, "plan");
  }

  spendLimits(): Promise<DistributionSpendLimits> {
    return this.post("/api/app/distribution-spend-limits", {}, "limits");
  }

  context(articleOperationId?: string): Promise<DistributionPlanningContext> {
    return this.post(
      "/api/brand-distribution-plans/context",
      { articleOperationId },
      "context",
    );
  }

  channelPreferences(): Promise<PreferenceChannelSettings | undefined> {
    return managementApi(
      "/api/brand-distribution-plans/preferences/get",
      "POST",
      this.envelope({}),
    ).then(
      (result) =>
        result.ok === true
          ? (result.preferences as PreferenceChannelSettings | undefined)
          : undefined,
      () => undefined,
    );
  }

  get(planId: string): Promise<DistributionPlanProjection> {
    return this.post("/api/brand-distribution-plans/get", { planId }, "plan");
  }

  prepare(
    input: DistributionPlanStartInput,
  ): Promise<DistributionPlanPreparation> {
    return this.post(
      "/api/brand-distribution-plans/prepare",
      input,
      "preparation",
    );
  }

  finishDiscovery(
    input: Parameters<DistributionPlanPersistencePort["finishDiscovery"]>[0],
  ): Promise<DistributionPlanProjection> {
    return this.post(
      "/api/brand-distribution-plans/discovery/finish",
      input,
      "plan",
    );
  }

  edit(
    input: Parameters<DistributionPlanPersistencePort["edit"]>[0],
  ): Promise<DistributionPlanProjection> {
    return this.post("/api/brand-distribution-plans/edit", input, "plan");
  }

  confirm(
    input: Parameters<DistributionPlanPersistencePort["confirm"]>[0],
  ): Promise<DistributionPlanProjection> {
    return this.post("/api/brand-distribution-plans/confirm", input, "plan");
  }
}

export function createDistributionPlanPort(identity: {
  workspaceId: string;
  sessionId: string;
}): DistributionPlanPersistencePort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error(
      "Distribution planning requires an authenticated Sidecar identity",
    );
  }
  return new RustDistributionPlanPort({ ...identity, sidecarId });
}

async function loadResourceKind(
  capability: GeoDistributionCapability,
  kind: "media" | "we-media",
): Promise<{ total: number; items: GeoDistributionResource[] }> {
  const byId = new Map<number, GeoDistributionResource>();
  let total = 0;
  for (let page = 1; page <= DISTRIBUTION_RESOURCE_MAX_PAGES; page += 1) {
    const result = await capability.listResources(
      kind,
      page,
      DISTRIBUTION_RESOURCE_PAGE_SIZE,
    );
    total = Math.max(total, result.total);
    for (const resource of result.items) {
      if (Number.isInteger(resource.id) && resource.id > 0) {
        byId.set(resource.id, resource);
      }
    }
    if (result.items.length === 0 || byId.size >= result.total) break;
    if (page === DISTRIBUTION_RESOURCE_MAX_PAGES) {
      throw new Error("distribution_resource_pagination_limit");
    }
  }
  return { total, items: [...byId.values()] };
}

function unavailableSnapshot(): DistributionProviderSnapshot {
  return {
    slot: "distribution",
    provider: "超级媒介",
    endpointFamily: "chaojimeijie-resource-api",
    policyVersion: DISTRIBUTION_PLAN_POLICY_VERSION,
    fetchedAt: null,
    mediaTotal: 0,
    weMediaTotal: 0,
  };
}

// ── 偏好基础名单拉取（运营台云端下发，2026-09）────────────────────────────

/**
 * 偏好拉取的行业码集：「品牌所属行业」选择器（backend
 * PREFERENCE_CATEGORY_NAMES 的取数侧），不是渠道形态分类——1-25 经
 * WE_MEDIA_INDUSTRY_NAMES 现成口径；26=工业贸易是媒体附录独有类目的补位
 * 码（自媒体附录无工业类目，工业/制造/化工/能源/物流线品牌靠别名表→
 * 「工业」碎片命中它，否则行业隔离对这些行业无法生效）。
 */
const PREFERENCE_EXTRA_INDUSTRY_NAMES: Readonly<Record<number, string>> = {
  26: "工业贸易",
};

export function preferenceIndustryCodes(industry: string): number[] {
  return [
    ...industryCodesFor(industry, WE_MEDIA_INDUSTRY_NAMES),
    ...industryCodesFor(industry, PREFERENCE_EXTRA_INDUSTRY_NAMES),
  ];
}

/** 单次拉取超时：配置面 best-effort，不能吊死计划发现。 */
const PREFERENCE_PULL_TIMEOUT_MS = 5_000;
/** 下发条目上限（对齐 backend 侧名单规模护栏）。 */
const PREFERENCE_LIST_MAX = 100;

/**
 * 严格解析 /config/preference-channels 响应（反 TypeError 炸计划发现）：
 * 逐条校验——名称字符串且 1-200 字、domain 缺省或非空字符串、exact 必须
 * 布尔；顶层或任一条目形状不符即整体作废（空数组），绝不把半坏数据喂进
 * 偏好匹配（响应来自自家 backend 的固定契约，半坏即契约漂移）。超过
 * 100 条在第 100 条截断（名单规模护栏，不算形状违规）。
 */
export function parsePreferenceChannelsResponse(
  payload: unknown,
): PreferenceChannelEntry[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const channels = (payload as { channels?: unknown }).channels;
  if (!Array.isArray(channels)) return [];
  const entries: PreferenceChannelEntry[] = [];
  for (const item of channels) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    const name = record.name.trim();
    if (name.length === 0 || Array.from(name).length > 200) return [];
    if (
      record.domain !== undefined &&
      (typeof record.domain !== "string" || record.domain.trim().length === 0)
    ) {
      return [];
    }
    if (typeof record.exact !== "boolean") return [];
    const domain =
      typeof record.domain === "string" ? record.domain.trim() : undefined;
    entries.push({
      name,
      ...(domain ? { domain } : {}),
      exact: record.exact,
    });
    if (entries.length >= PREFERENCE_LIST_MAX) break;
  }
  return entries;
}

/**
 * 网关拉取（billing 通道同款 Bearer 口径）：5s 超时、非 2xx 抛类型化错误。
 * 错误消息只含状态码语义（preference_pull_http_502），不含 token/响应体。
 */
export async function fetchPreferenceChannelsFromGateway(input: {
  baseUrl: string;
  accessToken: string;
  codes: readonly number[];
  fetchImpl?: typeof fetch;
}): Promise<PreferenceChannelEntry[]> {
  const query =
    input.codes.length > 0 ? `?codes=${[...input.codes].join(",")}` : "";
  const response = await (input.fetchImpl ?? fetch)(
    `${input.baseUrl.replace(/\/+$/, "")}/config/preference-channels${query}`,
    {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: AbortSignal.timeout(PREFERENCE_PULL_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`preference_pull_http_${response.status}`);
  }
  return parsePreferenceChannelsResponse(await response.json());
}

export class DistributionPlanningService {
  private readonly resourceCache: Partial<
    Record<
      "media" | "we-media",
      {
        fetchedAtMs: number;
        result: { total: number; items: GeoDistributionResource[] };
      }
    >
  > = {};

  private readonly resourceLoads: Partial<
    Record<
      "media" | "we-media",
      Promise<{ total: number; items: GeoDistributionResource[] }>
    >
  > = {};

  constructor(
    private readonly identity: { workspaceId: string; sessionId: string },
    private readonly persistence: DistributionPlanPersistencePort,
    private readonly distribution: GeoDistributionCapability,
    private readonly keywordSearch: DistributionKeywordSearchPort,
    private readonly now: () => Date = () => new Date(),
    /** 网关计费（票 07）：基础 30 + 被动路 5/问；缺省时跳过 permit。 */
    private readonly permits?: GeoBillingPermitPort,
    /**
     * L3 账户解析的页面抓取（2026-08-27 用户裁决）：抓引用页 HTML（≤8s、
     * SSRF 守卫），失败返回 null 静默降级。测试注入假实现；生产缺省用 undici。
     */
    private readonly accountPageFetch: (
      url: string,
    ) => Promise<string | null> = fetchCitationPageHtml,
    /**
     * 偏好基础名单拉取（运营台下发，2026-09）：入参为计划的官方行业分类
     * 码集（空 = 只拉通用行）。best-effort——失败在 start() 内降级为空
     * 名单并打脱敏告警，本轮偏好路无命中。缺省（无网关/开发直连）恒为空。
     */
    private readonly fetchPreferenceBase?: (
      codes: readonly number[],
    ) => Promise<readonly PreferenceChannelEntry[]>,
  ) {}

  private assertIdentity(input: {
    workspaceId: string;
    sessionId: string;
  }): void {
    if (
      input.workspaceId !== this.identity.workspaceId ||
      input.sessionId !== this.identity.sessionId
    ) {
      throw new Error("distribution_plan_identity_mismatch");
    }
  }

  private loadResources(
    kind: "media" | "we-media",
  ): Promise<{ total: number; items: GeoDistributionResource[] }> {
    const nowMs = this.now().getTime();
    const cached = this.resourceCache[kind];
    if (
      cached &&
      nowMs - cached.fetchedAtMs <
        XIAOJING_GEO_PROVIDER_DEFAULTS.distributionCacheTtlMs
    ) {
      return Promise.resolve(cached.result);
    }
    const inFlight = this.resourceLoads[kind];
    if (inFlight) return inFlight;
    const load = loadResourceKind(this.distribution, kind)
      .then((result) => {
        this.resourceCache[kind] = {
          fetchedAtMs: this.now().getTime(),
          result,
        };
        return result;
      })
      .finally(() => {
        delete this.resourceLoads[kind];
      });
    this.resourceLoads[kind] = load;
    return load;
  }

  /**
   * 被动路（js_ai probePassiveRecallMulti 语义）：对已确认问题池逐问现场
   * 探测豆包引用（Responses + ai_search），2-wide 窗口限流、逐问隔离失败。
   * 整体失败返回空数组——被动证据缺失只降级，不阻断（用户裁决 2026-08-18）。
   * 逐问成败（outcomes，按问题顺序）供计费逐单位回报（票 07）。
   */
  private async probeQuestionSources(
    context: DistributionPlanningContext,
  ): Promise<{
    sources: DistributionQuestionSource[];
    outcomes: boolean[];
  }> {
    const questions = context.questions.slice(0, 20);
    const outcomes: boolean[] = new Array(questions.length).fill(false);
    const collected: Array<{
      question: DistributionPlanningContext["questions"][number];
      citations: Array<{ url: string; title?: string }>;
    }> = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor++;
        const question = questions[index];
        if (!question) return;
        try {
          const response = await this.keywordSearch.probeQuestion(
            "doubao",
            question.question,
          );
          outcomes[index] = true;
          collected.push({
            question,
            citations: parseGeoProbeProviderResponse(response.rawEvidence)
              .citations,
          });
        } catch {
          outcomes[index] = false;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(2, questions.length) }, worker),
    );
    // 被动来源选样（契约 passiveRecall）：每问 10 条、跨问渠道频次降序、
    // 全量返回（2026-08-27 用户裁决二轮，旧总量帽 50 废除）。
    return { sources: selectPassiveSources(collected), outcomes };
  }

  /**
   * L3 账户解析（契约 accountResolution）：多租户引用且 L1（URL 内嵌标识）
   * 与 L2（标题尾缀账号名）都拿不到账号的，抓引用页提取作者；≤20 条并发、
   * 单条 8s 超时、任何失败静默降级（不动来源）。结果以 resolvedAccountName
   * 回填——随 prepare 落库，供被动对齐兜底与面板账号标注。
   */
  private async resolveCitationAccounts(
    sources: DistributionQuestionSource[],
  ): Promise<DistributionQuestionSource[]> {
    const targets: DistributionQuestionSource[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      if (source.resolvedAccountName) continue;
      if (!isMultiTenantPlatformUrl(source.url)) continue;
      if (accountNameFromTitle(source.title)) continue;
      const url = source.url.trim();
      if (seen.has(url)) continue;
      seen.add(url);
      targets.push(source);
      if (targets.length >= CITATION_PAGE_FETCH_LIMIT) break;
    }
    if (targets.length === 0) return sources;
    const resolved = await Promise.all(
      targets.map(async (source) => {
        const html = await this.accountPageFetch(source.url);
        const author = html === null ? null : authorNameFromPageHtml(html);
        return author ? { source, author } : null;
      }),
    );
    const bySource = new Map<DistributionQuestionSource, string>();
    for (const entry of resolved) {
      if (entry) bySource.set(entry.source, entry.author);
    }
    if (bySource.size === 0) return sources;
    return sources.map((source) => {
      const author = bySource.get(source);
      return author ? { ...source, resolvedAccountName: author } : source;
    });
  }

  /**
   * 主动路（ADR-0031 全局单次召回）：topics+行业+衍生关键词一次联网调用，
   * 产出渠道+主题编号；解析带注册域名门（无域名渠道宁缺勿滥）。失败返回
   * 空数组（independent-best-effort）。
   */
  private async recallActiveSources(
    context: DistributionPlanningContext,
  ): Promise<RecallSource[]> {
    try {
      const topics = context.articles
        .map((article) => article.topic?.trim() ?? "")
        .filter((topic) => topic.length > 0);
      if (topics.length === 0) return [];
      const prompt = buildGlobalRecallPrompt({
        topics,
        industry: context.industry,
        derivedKeywords: context.derivedKeywords,
      });
      const answer = await this.keywordSearch.search(prompt, {
        system: "你是 GEO 渠道投放专家；只返回 JSON 数组，不要解释。",
        maxTokens: 4096,
      });
      const channels = parseGlobalRecallResult(answer);
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const topic of topics) {
        if (seen.has(topic)) continue;
        seen.add(topic);
        deduped.push(topic);
      }
      const topicArticles = new Map<string, string[]>();
      for (const article of context.articles) {
        const topic = article.topic?.trim();
        if (!topic) continue;
        topicArticles.set(topic, [
          ...(topicArticles.get(topic) ?? []),
          article.id,
        ]);
      }
      return channels.map((channel) => ({
        title: channel.name,
        url: channel.url,
        reason: channel.reason,
        articleIds: clampTopicNumbers(
          channel.topicNumbers,
          deduped.length,
        ).flatMap((number) => topicArticles.get(deduped[number - 1]!) ?? []),
      }));
    } catch {
      return [];
    }
  }

  async latest(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<DistributionPlanProjection | null> {
    this.assertIdentity(input);
    return this.persistence.latest();
  }

  async context(input: {
    workspaceId: string;
    sessionId: string;
    articleOperationId?: string;
  }): Promise<DistributionPlanningContext> {
    this.assertIdentity(input);
    return this.persistence.context(input.articleOperationId);
  }

  async spendLimits(input: {
    workspaceId: string;
    sessionId: string;
  }): Promise<DistributionSpendLimits> {
    this.assertIdentity(input);
    return this.persistence.spendLimits();
  }

  async start(input: {
    workspaceId: string;
    sessionId: string;
    source: DistributionPlanStartInput;
  }): Promise<DistributionPlanProjection> {
    this.assertIdentity(input);
    const source = validateDistributionPlanStartInput(input.source);
    // 计费（票 07）：分发计划（含渠道发现）基础 30 + 被动路 5/问。permitId
    // 绑定来源请求（文章操作 + 参数指纹）：同一请求的网络重试/恢复重跑重放
    // 同一 permit；被动路探测在预扣后发起，逐问回报成败（失败问回补 5 点，
    // 基础费绑定首个成功问）。无被动问时单单位 = 计划发现整体成败。
    // 渠道资源读取本身免费（浏览/缓存命中不扣点）。
    const context = await this.persistence.context(source.articleOperationId);
    const probeCount = Math.min(context.questions.length, 20);
    const unitCount = Math.max(1, probeCount);
    const sourceFingerprint = createHash("sha256")
      .update(JSON.stringify(source))
      .digest("hex")
      .slice(0, 16);
    const permitId = `dist:${source.articleOperationId ?? "latest"}:${sourceFingerprint}`;
    if (this.permits) {
      await this.permits.apply({
        permitId,
        operation: "distribution_planning",
        units: unitCount,
      });
    }
    const reportUnit = async (unit: number, outcome: "success" | "failure") => {
      if (!this.permits) return;
      await this.permits
        .reportUnit(permitId, unit, outcome)
        .catch(() => undefined);
    };
    const settleDiscovery = async (
      outcomes: boolean[],
      discoverySucceeded: boolean,
    ) => {
      if (!this.permits) return;
      if (probeCount > 0) {
        await Promise.all(
          outcomes.map((ok, unit) =>
            reportUnit(unit, ok ? "success" : "failure"),
          ),
        );
      } else {
        await reportUnit(0, discoverySucceeded ? "success" : "failure");
      }
    };
    try {
      // 四路召回的现场证据（js_ai 语义）：被动=问题池逐问探测、主动=全局单次
      // 召回、偏好=品牌 overlay 合成；保底是纯规则路（无外部输入）。探测与召回
      // 均按 independent-best-effort 降级——失败只损失对应路的证据，不阻断计划。
      const [probeOutcome, activeSources, preferenceSettings] =
        await Promise.all([
          this.probeQuestionSources(context),
          this.recallActiveSources(context),
          this.persistence.channelPreferences().catch(() => undefined),
        ]);
      const questionSources = await this.resolveCitationAccounts(
        probeOutcome.sources,
      ).catch(() => probeOutcome.sources);
      // 召回输入快照（右侧面板四路召回展示）：主动路原始渠道随发现结果
      // 一起落进投影，供用户对照「召回了什么 vs 匹配了什么」。
      const activeRecallSources: DistributionActiveRecallSource[] =
        activeSources.map((source) => ({
          title: source.title,
          url: source.url ?? null,
          articleIds: source.articleIds ?? [],
          reason: source.reason ?? null,
        }));
      const preparation = await this.persistence.prepare({
        ...source,
        questionSources,
      });
      const base = preparation.plan;
      // 偏好基础名单（2026-09 起运营台按行业下发）：计划行业 → 品牌所属
      // 行业码集（preferenceIndustryCodes，空行业=空码集只拉通用行）→
      // 网关拉取。best-effort——失败/坏响应降级空名单并打脱敏告警，只损失
      // 偏好路证据；无网关/开发直连 fetchPreferenceBase 缺省 = 空基础名单，
      // 仅剩本地 overlay 增补可用。
      const preferenceBase = this.fetchPreferenceBase
        ? await this.fetchPreferenceBase(
            preferenceIndustryCodes(base.industry),
          ).catch((error: unknown) => {
            console.warn(
              "[preference-channels] pull failed:",
              error instanceof Error ? error.message : "unknown",
            );
            return [] as const;
          })
        : ([] as const);
      const preferenceChannels: PreferenceChannelEntry[] =
        resolvePreferenceChannels(preferenceBase, preferenceSettings);
      const preferenceChannelNames = preferenceChannels.map(
        (entry) => entry.name,
      );
      let media: { total: number; items: GeoDistributionResource[] };
      let weMedia: { total: number; items: GeoDistributionResource[] };
      try {
        [media, weMedia] = await Promise.all([
          this.loadResources("media"),
          this.loadResources("we-media"),
        ]);
      } catch {
        await this.persistence.finishDiscovery({
          planId: base.id,
          expectedRevision: base.revision,
          claimToken: preparation.claimToken,
          providerState: "unavailable",
          providerSnapshot: unavailableSnapshot(),
          resourceSnapshot: [],
          candidates: [],
          selectedResourceIds: [],
          assignments: base.articles.map((article) => ({
            articleId: article.id,
            resourceId: null,
            reason: "unassigned",
            scheduledAt: base.publishStartAt,
          })),
          discoverySummary: {
            inputResources: 0,
            approvedResources: 0,
            filteredUnavailable: 0,
            filteredUnknownPrice: 0,
            filteredOverPerArticleLimit: 0,
            alignedResources: 0,
            recommendedResources: 0,
            alignedByPath: {
              passive: 0,
              active: 0,
              fallback: 0,
              preference: 0,
            },
            citationDomains: 0,
            citationDomainPoolHits: 0,
          },
          blockingIssues: [
            "distribution-provider-unavailable",
            "channel-candidate-unavailable",
            "article-channel-unassigned",
          ],
          activeRecallSources,
          preferenceChannelNames,
          passiveAlignedChannels: [],
          citationSiteNames: {},
          preferenceMatchedChannels: [],
        });
        await settleDiscovery(probeOutcome.outcomes, false);
        return this.persistence.get(base.id);
      }
      const normalized = [
        ...media.items.map((resource) =>
          normalizeDistributionResource(
            "media",
            resource as DistributionResourceInput,
          ),
        ),
        ...weMedia.items.map((resource) =>
          normalizeDistributionResource(
            "we-media",
            resource as DistributionResourceInput,
          ),
        ),
      ].filter(
        (resource): resource is DistributionResourceSnapshot =>
          resource !== null,
      );
      const discovery = buildDistributionCandidates({
        industry: base.industry,
        targetAudience: base.targetAudience,
        questionSources: base.questionSources,
        activeSources,
        preferenceChannels,
        perArticleMaxPoints: base.perArticleMaxPoints,
        articles: base.articles,
        resources: normalized,
      });
      const assignments = assignDistributionChannels({
        articles: base.articles,
        candidates: discovery.candidates,
        mappingMode: base.mappingMode,
        ratio: base.ratio,
        totalMaxPoints: Math.min(
          base.totalMaxPoints,
          cnyToPoints(base.budgetCny),
        ),
        publishStartAt: base.publishStartAt,
        industry: base.industry,
        targetAudience: base.targetAudience,
      });
      const selectedResourceIds = assignments.flatMap((assignment) =>
        assignment.resourceId === null ? [] : [assignment.resourceId],
      );
      const providerSnapshot: DistributionProviderSnapshot = {
        ...unavailableSnapshot(),
        fetchedAt: this.now().toISOString(),
        mediaTotal: media.total,
        weMediaTotal: weMedia.total,
      };
      const blockingIssues = distributionPlanBlockingIssues({
        ...base,
        providerState: "available",
        candidates: discovery.candidates,
        selectedResourceIds,
        assignments,
      });
      await this.persistence.finishDiscovery({
        planId: base.id,
        expectedRevision: base.revision,
        claimToken: preparation.claimToken,
        providerState: "available",
        providerSnapshot,
        resourceSnapshot: discovery.resourceSnapshot,
        candidates: discovery.candidates,
        selectedResourceIds,
        assignments,
        discoverySummary: discovery.summary,
        blockingIssues,
        activeRecallSources,
        preferenceChannelNames,
        passiveAlignedChannels: discovery.passiveAlignedChannels,
        citationSiteNames: discovery.citationSiteNames,
        preferenceMatchedChannels: discovery.preferenceMatchedChannels,
      });
      await settleDiscovery(probeOutcome.outcomes, true);
      // Exact identity read: a concurrent Session may have created a newer plan.
      return this.persistence.get(base.id);
    } catch (error) {
      // 未回报单位（含无被动问时的单单位失败）随结清回补。
      if (this.permits) {
        await this.permits.close(permitId).catch(() => undefined);
      }
      throw error;
    }
  }

  async edit(input: {
    workspaceId: string;
    sessionId: string;
    planId: string;
    expectedRevision: number;
    edit: DistributionPlanEditInput;
    /** 聊天修订（票 38）携带用户指令原文，写入 geo_distribution_plan_audit。 */
    reason?: string;
  }): Promise<DistributionPlanProjection> {
    this.assertIdentity(input);
    const plan = await this.persistence.get(input.planId);
    if (plan.revision !== input.expectedRevision) {
      throw new Error("distribution_plan_revision_conflict");
    }
    const edit = applyDistributionPlanEdit(plan, input.edit);
    await this.persistence.edit({
      planId: plan.id,
      expectedRevision: input.expectedRevision,
      edit,
      ...(input.reason ? { reason: input.reason } : {}),
    });
    return this.persistence.get(plan.id);
  }

  async confirm(input: {
    workspaceId: string;
    sessionId: string;
    planId: string;
    expectedRevision: number;
  }): Promise<DistributionPlanProjection> {
    this.assertIdentity(input);
    const plan = await this.persistence.get(input.planId);
    if (plan.revision !== input.expectedRevision) {
      throw new Error("distribution_plan_revision_conflict");
    }
    assertDistributionPlanConfirmable(plan);
    await this.persistence.confirm({
      planId: plan.id,
      expectedRevision: input.expectedRevision,
    });
    return this.persistence.get(plan.id);
  }
}
