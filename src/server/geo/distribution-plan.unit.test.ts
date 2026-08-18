import { afterEach, describe, expect, it, vi } from "vitest";

import { XIAOJING_GEO_PROVIDER_DEFAULTS } from "../../shared/geo/providerCapabilities";
import type {
  DistributionPlanProjection,
  DistributionPlanStartInput,
  DistributionPlanningContext,
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
    context: vi.fn(async (): Promise<DistributionPlanningContext> => ({
      articleOperationId: "article-operation",
      knowledgeVersion: 1,
      industry: "汽车改装",
      articles: [
        {
          id: "article-1",
          operationId: "article-operation",
          approvedRevision: 1,
          title: "汽车行业观察",
          topic: "新能源车售后",
          contentType: "news" as const,
        },
      ],
      questions: [
        {
          id: "q-1",
          question: "新能源车售后怎么选？",
          articleIds: ["article-1"],
        },
      ],
      derivedKeywords: ["汽车音响", "改装"],
    })),
    channelPreferences: vi.fn(async () => undefined),
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

/** keyword-search 端口 fake：被动探测返回引用，主动召回返回渠道数组。 */
function keywordSearch() {
  return {
    probeQuestion: vi.fn(async () => ({
      rawEvidence: {
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "回答正文",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://auto.example.com/question/1",
                      title: "汽车日报",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      snapshot: {
        engineId: "doubao",
        provider: "volcengine",
        capabilitySlot: "keyword-search",
        model: "doubao-seed-2-0-lite",
        endpointFamily: "ark-responses",
        searchMode: "doubao-app-ai-search",
        configurationFingerprint: "test",
      } as never,
    })),
    search: vi.fn(
      async () =>
        '[{"name":"汽车日报","url":"https://auto.example.com/recall","topicNumbers":[1]}]',
    ),
  };
}

describe("DistributionPlanningService", () => {
  it("persists real resource fields and reads the exact created plan, never latest", async () => {
    const { port } = persistence();
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
      keywordSearch(),
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
      keywordSearch(),
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
      keywordSearch(),
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
      keywordSearch(),
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

describe("DistributionPlanningService billing permits (ticket 07)", () => {
  function permitPort() {
    const calls: Array<
      | { kind: "apply"; permitId: string; operation: string; units: number }
      | { kind: "report"; permitId: string; unit: number; outcome: string }
      | { kind: "close"; permitId: string }
    > = [];
    return {
      calls,
      port: {
        async apply(input: { permitId: string; operation: string; units: number }) {
          calls.push({ kind: "apply", ...input });
          return {
            permitId: input.permitId,
            operation: input.operation,
            units: input.units,
            totalPoints: 30 + 5 * input.units,
            status: "open" as const,
            frozenPoints: 30 + 5 * input.units,
            consumedPoints: 0,
            refundedPoints: 0,
          };
        },
        async reportUnit(permitId: string, unit: number, outcome: string) {
          calls.push({ kind: "report", permitId, unit, outcome });
        },
        async close(permitId: string) {
          calls.push({ kind: "close", permitId });
        },
      },
    };
  }

  function billedService(
    persistencePort: ReturnType<typeof persistence>["port"],
    permits: ReturnType<typeof permitPort>["port"],
    search: ReturnType<typeof keywordSearch> = keywordSearch(),
  ) {
    return new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      persistencePort,
      provider(),
      search,
      () => new Date("2026-08-15T00:00:00.000Z"),
      permits,
    );
  }

  it("pre-deducts base + passive-question units and reports each probe outcome", async () => {
    const { port } = persistence();
    const permits = permitPort();
    const service = billedService(port, permits.port);

    const result = await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });

    expect(result.id).toBe("plan-1");
    // 上下文只有 1 个已确认问题 → units = 1（基础 30 + 5）。
    expect(permits.calls[0]).toMatchObject({
      kind: "apply",
      operation: "distribution_planning",
      units: 1,
    });
    expect(permits.calls[0].permitId).toMatch(/^dist:article-operation:[0-9a-f]{16}$/);
    expect(permits.calls).toEqual([
      permits.calls[0],
      { kind: "report", permitId: permits.calls[0].permitId, unit: 0, outcome: "success" },
    ]);
  });

  it("reports failed passive probes as failure units (per-question refund)", async () => {
    const { port } = persistence();
    const permits = permitPort();
    const search = keywordSearch();
    search.probeQuestion.mockRejectedValue(new Error("keyword-search 上游请求失败"));
    const service = billedService(port, permits.port, search);

    const result = await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });

    // 被动路 independent-best-effort：探测失败计划仍产出（降级），但该问
    // 单位按失败回补（服务端口径：全失败时基础费随整体退回）。
    expect(result.status).toBeDefined();
    expect(permits.calls).toEqual([
      permits.calls[0],
      { kind: "report", permitId: permits.calls[0].permitId, unit: 0, outcome: "failure" },
    ]);
  });

  it("replays the same permitId for the same source (recovery re-run) and never bills resource browsing", async () => {
    const { port } = persistence();
    const permits = permitPort();
    const search = keywordSearch();
    const service = billedService(port, permits.port, search);

    await service.start({ workspaceId: "workspace", sessionId: "session", source });
    const firstPermitId = permits.calls[0].permitId;
    const resourceCallsBefore = (provider().listResources as ReturnType<typeof vi.fn>).mock;
    expect(resourceCallsBefore).toBeDefined();

    // 同一来源恢复重跑：重放同一 permitId，不产生第二笔申请。
    const secondPersistence = persistence();
    const secondPermits = permitPort();
    const service2 = billedService(secondPersistence.port, secondPermits.port, search);
    await service2.start({ workspaceId: "workspace", sessionId: "session", source });
    expect(secondPermits.calls[0]).toMatchObject({
      kind: "apply",
      permitId: firstPermitId,
      units: 1,
    });

    // 浏览/读取面（latest/get/context/edit/confirm）零 permit 调用。
    const readPermits = permitPort();
    const readService = billedService(persistence().port, readPermits.port, search);
    await readService.latest({ workspaceId: "workspace", sessionId: "session" });
    await readService.context({ workspaceId: "workspace", sessionId: "session" });
    expect(readPermits.calls).toEqual([]);
  });
});
