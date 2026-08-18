import { afterEach, describe, expect, it, vi } from "vitest";

import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import type {
  DistributionPlanProjection,
  DistributionPlanStartInput,
} from "../../shared/geo/distributionPlan";
import {
  DistributionPlanningService,
  createDistributionPlanPort,
  type DistributionPlanPersistencePort,
} from "./distribution-plan";
import type { GeoDistributionCapability } from "./provider-capabilities";

const source: DistributionPlanStartInput = {
  articleOperationId: "article-operation",
  articleIds: ["article-1"],
  industry: "汽车改装",
  targetAudience: "新能源车主",
  questionSources: [
    {
      id: "unit-1:citation:1",
      questionId: "q-1",
      question: "新能源车售后怎么选？",
      title: "汽车日报",
      url: "https://auto.example.com/question/1",
      articleIds: ["article-1"],
    },
  ],
  preferredResourceIds: [],
  mappingMode: "one-to-one",
  ratio: { media: 2, weMedia: 1 },
  budgetCny: 100,
  publishStartAt: "2026-08-20T01:00:00.000Z",
};

function plan(id: string): DistributionPlanProjection {
  return {
    id,
    operationId: `operation-${id}`,
    workspaceId: "workspace",
    createdBySessionId: "session",
    articleOperationId: "article-operation",
    policyVersion: "js-ai-dev-four-path-distribution-v1",
    status: "discovering",
    revision: 0,
    industry: "汽车改装",
    targetAudience: "新能源车主",
    questionSources: source.questionSources,
    preferredResourceIds: [],
    mappingMode: "one-to-one",
    ratio: { media: 2, weMedia: 1 },
    articles: [
      {
        id: "article-1",
        operationId: "article-operation",
        approvedRevision: 1,
        title: "汽车行业观察",
        topic: "新能源车售后",
        contentType: "news",
      },
    ],
    providerState: "pending",
    providerSnapshot: {
      slot: "distribution",
      provider: "超级媒介",
      endpointFamily: "chaojimeijie-resource-api",
      policyVersion: "js-ai-dev-four-path-distribution-v1",
      fetchedAt: null,
      mediaTotal: 0,
      weMediaTotal: 0,
    },
    resourceSnapshot: [],
    candidates: [],
    selectedResourceIds: [],
    assignments: [
      {
        articleId: "article-1",
        resourceId: null,
        reason: "unassigned",
        scheduledAt: source.publishStartAt,
      },
    ],
    budgetCny: 100,
    publishStartAt: source.publishStartAt,
    discoverySummary: {
      inputResources: 0,
      approvedResources: 0,
      filteredUnavailable: 0,
      filteredLowPublishedRate: 0,
      filteredHighPrice: 0,
      alignedResources: 0,
      recommendedResources: 0,
    },
    blockingIssues: [],
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    confirmedAt: null,
  };
}

function persistence() {
  const plans = new Map<string, DistributionPlanProjection>();
  let sequence = 0;
  const port: DistributionPlanPersistencePort = {
    context: vi.fn(),
    latest: vi.fn(async () => plan("unrelated-latest")),
    get: vi.fn(async (planId) => {
      const value = plans.get(planId);
      if (!value) throw new Error("missing plan");
      return structuredClone(value);
    }),
    prepare: vi.fn(async () => {
      const value = plan(`plan-${++sequence}`);
      plans.set(value.id, value);
      return { plan: structuredClone(value), claimToken: `claim-${sequence}` };
    }),
    finishDiscovery: vi.fn(async (input) => {
      const current = plans.get(input.planId)!;
      const next: DistributionPlanProjection = {
        ...current,
        status:
          input.providerState === "available" && input.candidates.length > 0
            ? "draft"
            : "unavailable",
        revision: current.revision + 1,
        providerState: input.providerState,
        providerSnapshot: input.providerSnapshot,
        resourceSnapshot: input.resourceSnapshot,
        candidates: input.candidates,
        selectedResourceIds: input.selectedResourceIds,
        assignments: input.assignments,
        discoverySummary: input.discoverySummary,
        blockingIssues: input.blockingIssues,
      };
      plans.set(input.planId, next);
      return structuredClone(next);
    }),
    edit: vi.fn(),
    confirm: vi.fn(),
  };
  return { port, plans };
}

function provider(): GeoDistributionCapability {
  return {
    slot: "distribution",
    listResources: vi.fn(async (kind) => ({
      total: 1,
      items:
        kind === "media"
          ? [
              {
                id: 11,
                name: "汽车日报",
                status: 2,
                price: "88",
                published_rate: 90,
                entrance_link: "https://auto.example.com",
                channel_type: 6,
                remark: "新能源车主 AI 包收录",
              },
            ]
          : [
              {
                id: 22,
                name: "不相关科技号",
                status: 2,
                price: "30",
                published_rate: 90,
                industry_category: 5,
              },
            ],
    })),
  };
}

afterEach(() => {
  delete process.env.XIAOJING_SIDECAR_ID;
});

describe("DistributionPlanningService", () => {
  it("persists real resource fields and reads the exact created plan, never latest", async () => {
    const { port } = persistence();
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
      () => new Date("2026-08-15T00:00:00.000Z"),
    );

    const result = await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });

    expect(result.id).toBe("plan-1");
    expect(result.candidates[0]).toMatchObject({
      resourceId: 11,
      name: "汽车日报",
      estimatedPriceCny: 88,
      publishedRate: 90,
      recommendationWeight: 0.7,
    });
    expect(result.candidates[0].resourceSnapshot.name).toBe("汽车日报");
    expect(port.get).toHaveBeenCalledWith("plan-1");
    expect(port.latest).not.toHaveBeenCalled();
  });

  it("coalesces concurrent resource loads, caches for 30 minutes, and refetches after TTL", async () => {
    const { port } = persistence();
    const capability = provider();
    let nowMs = Date.parse("2026-08-15T00:00:00.000Z");
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      capability,
      () => new Date(nowMs),
    );
    const request = {
      workspaceId: "workspace",
      sessionId: "session",
      source,
    };

    await Promise.all([service.start(request), service.start(request)]);
    expect(capability.listResources).toHaveBeenCalledTimes(2);
    await service.start(request);
    expect(capability.listResources).toHaveBeenCalledTimes(2);
    nowMs += XIAOJING_GEO_PROVIDER_DEFAULTS.distributionCacheTtlMs + 1;
    await service.start(request);
    expect(capability.listResources).toHaveBeenCalledTimes(4);
  });

  it("persists an explicit unavailable plan when resource discovery is unconfigured", async () => {
    const { port } = persistence();
    const capability: GeoDistributionCapability = {
      slot: "distribution",
      listResources: vi.fn(async () => {
        throw new Error("distribution 能力尚未配置");
      }),
    };
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      capability,
    );

    const result = await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    expect(result.status).toBe("unavailable");
    expect(result.providerSnapshot.fetchedAt).toBeNull();
    expect(result.resourceSnapshot).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.blockingIssues).toContain(
      "distribution-provider-unavailable",
    );
  });

  it("does not relabel persistence or CAS failures as provider unavailable", async () => {
    const { port } = persistence();
    port.finishDiscovery = vi.fn(async () => {
      throw new Error("distribution_plan_revision_conflict");
    });
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
    );

    await expect(
      service.start({
        workspaceId: "workspace",
        sessionId: "session",
        source,
      }),
    ).rejects.toThrow("distribution_plan_revision_conflict");
    expect(port.finishDiscovery).toHaveBeenCalledTimes(1);
  });

  it("requires the authenticated Sidecar identity instead of falling back to sessionId", () => {
    expect(() =>
      createDistributionPlanPort({
        workspaceId: "workspace",
        sessionId: "session",
      }),
    ).toThrow("authenticated Sidecar identity");
    process.env.XIAOJING_SIDECAR_ID = " sidecar-generation-1 ";
    expect(
      createDistributionPlanPort({
        workspaceId: "workspace",
        sessionId: "session",
      }),
    ).toBeDefined();
  });
});
