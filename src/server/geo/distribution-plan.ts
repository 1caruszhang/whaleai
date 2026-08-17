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
  type DistributionResourceInput,
  type DistributionResourceSnapshot,
} from "../../shared/geo/distributionPlan";
import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import { managementApi } from "../utils/management-api-client";
import type {
  GeoDistributionCapability,
  GeoDistributionResource,
} from "./provider-capabilities";

export interface DistributionPlanPreparation {
  plan: DistributionPlanProjection;
  claimToken: string;
}

export interface DistributionPlanPersistencePort {
  context(articleOperationId?: string): Promise<DistributionPlanningContext>;
  latest(): Promise<DistributionPlanProjection | null>;
  get(planId: string): Promise<DistributionPlanProjection>;
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
    private readonly now: () => Date = () => new Date(),
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
    const preparation = await this.persistence.prepare(source);
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
          filteredLowPublishedRate: 0,
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
      preferredResourceIds: base.preferredResourceIds,
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
    // Exact identity read: a concurrent Session may have created a newer plan.
    return this.persistence.get(base.id);
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
