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
  normalizeDistributionResource,
  validateDistributionPlanStartInput,
  type DistributionPlanEditInput,
  type DistributionPlanProjection,
  type DistributionPlanStartInput,
  type DistributionPlanningContext,
  type DistributionProviderSnapshot,
  type DistributionQuestionSource,
  type DistributionResourceInput,
  type DistributionResourceSnapshot,
} from "../../shared/geo/distributionPlan";
import {
  buildGlobalRecallPrompt,
  clampTopicNumbers,
  parseGlobalRecallResult,
  resolvePreferenceChannels,
  type PreferenceChannelEntry,
  type PreferenceChannelSettings,
  type RecallSource,
} from "../../shared/geo/channelRecall";
import { parseGeoProbeProviderResponse } from "../../shared/geo/baseline";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import { managementApi } from "../utils/management-api-client";
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

export interface DistributionPlanPreparation {
  plan: DistributionPlanProjection;
  claimToken: string;
}

export interface DistributionPlanPersistencePort {
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

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
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
    await Promise.all(Array.from({ length: Math.min(2, questions.length) }, worker));
    const sources: DistributionQuestionSource[] = [];
    const seen = new Set<string>();
    for (const outcome of collected) {
      for (const [index, citation] of outcome.citations.entries()) {
        const url = citation.url.trim();
        if (!/^https?:\/\//i.test(url)) continue;
        if (!seen.add(`${outcome.question.id}:${url}`)) continue;
        sources.push({
          id: `probe:${outcome.question.id}:${index + 1}`,
          questionId: outcome.question.id,
          question: outcome.question.question,
          title: citation.title?.trim() || hostOf(url) || "已验证来源",
          url,
          articleIds: outcome.question.articleIds,
        });
        if (sources.length >= 100) return { sources, outcomes };
      }
    }
    return { sources, outcomes };
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
      await this.permits.reportUnit(permitId, unit, outcome).catch(
        () => undefined,
      );
    };
    const settleDiscovery = async (
      outcomes: boolean[],
      discoverySucceeded: boolean,
    ) => {
      if (!this.permits) return;
      if (probeCount > 0) {
        await Promise.all(
          outcomes.map((ok, unit) => reportUnit(unit, ok ? "success" : "failure")),
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
      const questionSources = probeOutcome.sources;
      const preferenceChannels: PreferenceChannelEntry[] =
        resolvePreferenceChannels(preferenceSettings);
      const preparation = await this.persistence.prepare({
        ...source,
        questionSources,
      });
      const base = preparation.plan;
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
            filteredHighPrice: 0,
            alignedResources: 0,
            recommendedResources: 0,
          },
          blockingIssues: [
            "distribution-provider-unavailable",
            "channel-candidate-unavailable",
            "article-channel-unassigned",
          ],
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
        (resource): resource is DistributionResourceSnapshot => resource !== null,
      );
      const discovery = buildDistributionCandidates({
        industry: base.industry,
        targetAudience: base.targetAudience,
        questionSources: base.questionSources,
        activeSources,
        preferenceChannels,
        articles: base.articles,
        resources: normalized,
      });
      const assignments = assignDistributionChannels({
        articles: base.articles,
        candidates: discovery.candidates,
        mappingMode: base.mappingMode,
        ratio: base.ratio,
        publishStartAt: base.publishStartAt,
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
