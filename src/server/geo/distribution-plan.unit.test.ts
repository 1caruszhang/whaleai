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
  fetchPreferenceChannelsFromGateway,
  parsePreferenceChannelsResponse,
  preferenceIndustryCodes,
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
  perArticleMaxPoints: 3_200,
  totalMaxPoints: 16_000,
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
    perArticleMaxPoints: 3_200,
    totalMaxPoints: 16_000,
    budgetCny: 100,
    publishStartAt: source.publishStartAt,
    discoverySummary: {
      inputResources: 0,
      approvedResources: 0,
      filteredUnavailable: 0,
      filteredUnknownPrice: 0,
      filteredOverPerArticleLimit: 0,
      alignedResources: 0,
      recommendedResources: 0,
      alignedByPath: { passive: 0, active: 0, fallback: 0, preference: 0 },
      citationDomains: 0,
      citationDomainPoolHits: 0,
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
    context: vi.fn(
      async (): Promise<DistributionPlanningContext> => ({
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
      }),
    ),
    channelPreferences: vi.fn(async () => undefined),
    spendLimits: vi.fn(async () => ({
      perArticleMaxPoints: 3_200,
      perExecutionMaxPoints: 16_000,
    })),
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
        activeRecallSources: input.activeRecallSources,
        preferenceChannelNames: input.preferenceChannelNames,
        passiveAlignedChannels: input.passiveAlignedChannels,
        citationSiteNames: input.citationSiteNames,
        preferenceMatchedChannels: input.preferenceMatchedChannels,
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
    // 订单面（票 08）在分发计划发现测试中不触达。
    placeOrder: vi.fn(async () => {
      throw new Error("not used");
    }),
    queryOrders: vi.fn(async () => {
      throw new Error("not used");
    }),
    urgeOrder: vi.fn(async () => {
      throw new Error("not used");
    }),
    cancelOrder: vi.fn(async () => {
      throw new Error("not used");
    }),
    applyRefund: vi.fn(async () => {
      throw new Error("not used");
    }),
    applyRepublish: vi.fn(async () => {
      throw new Error("not used");
    }),
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
      recommendationWeight: 0.9,
    });
    expect(result.candidates[0].resourceSnapshot.name).toBe("汽车日报");
    expect(port.get).toHaveBeenCalledWith("plan-1");
    expect(port.latest).not.toHaveBeenCalled();
  });

  it("injects L3 page-author resolution into question sources and degrades silently on failure", async () => {
    const { port } = persistence();
    // 被动探测返回多租户（抖音）引用且标题无账号尾缀 → 进入 L3 抓取。
    const search = keywordSearch();
    search.probeQuestion = vi.fn(async () => ({
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
                      url: "https://www.iesdouyin.com/share/video/7675535591",
                      title: "团餐合作模式避坑干货",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      snapshot: {} as never,
    }));
    const pageFetch = vi.fn(
      async () =>
        '<html><script type="application/ld+json">{"@type":"VideoObject","author":{"@type":"Person","name":"饭饭餐饮"}}</script></html>',
    );
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
      search,
      () => new Date("2026-08-15T00:00:00.000Z"),
      undefined,
      pageFetch,
    );
    await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    expect(pageFetch).toHaveBeenCalledTimes(1);
    expect(port.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        questionSources: [
          expect.objectContaining({
            url: "https://www.iesdouyin.com/share/video/7675535591",
            resolvedAccountName: "饭饭餐饮",
          }),
        ],
      }),
    );

    // 抓取失败（null）：静默降级，来源不带 resolvedAccountName。
    const failingFetch = vi.fn(async () => null);
    const { port: port2 } = persistence();
    const service2 = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port2,
      provider(),
      search,
      () => new Date("2026-08-15T00:00:00.000Z"),
      undefined,
      failingFetch,
    );
    await service2.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    const stored = vi.mocked(port2.prepare).mock.calls[0]![0];
    expect(stored.questionSources[0]?.url).toBe(
      "https://www.iesdouyin.com/share/video/7675535591",
    );
    expect(stored.questionSources[0]?.resolvedAccountName).toBeUndefined();
  });

  it("pulls the ops-console preference base by industry codes and passes matched rows through finishDiscovery (Q12)", async () => {
    const { port } = persistence();
    const fetchPreferenceBase = vi.fn(async () => [
      { name: "汽车日报", exact: true },
      { name: "不存在的渠道", exact: true },
    ]);
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
      keywordSearch(),
      () => new Date("2026-08-15T00:00:00.000Z"),
      undefined,
      undefined,
      fetchPreferenceBase,
    );
    await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    // 计划行业「汽车改装」→ 官方行业分类码集 {7}（汽车，industryCodesFor
    // 整串包含口径）；空码集不会出现——基础名单恒以码集拉取（通用行由
    // 服务端兜底下发）。
    expect(fetchPreferenceBase).toHaveBeenCalledTimes(1);
    expect(fetchPreferenceBase).toHaveBeenCalledWith([7]);
    const call = vi.mocked(port.finishDiscovery).mock.calls[0]![0];
    expect(call.preferenceChannelNames).toEqual(["汽车日报", "不存在的渠道"]);
    // 偏好命中清单在配额前逐名单项计算并随投影落库；每项一行，未命中项
    // matched=false（名单录错/渠道下架型）如实透传。
    const rows = call.preferenceMatchedChannels ?? [];
    expect(rows.length).toBe(2);
    const matched = rows.find((row) => row.entryName === "汽车日报");
    expect(matched).toMatchObject({ matched: true, recommended: true });
    const missing = rows.find((row) => row.entryName === "不存在的渠道");
    expect(missing).toMatchObject({ matched: false, recommended: false });
  });

  it("matches bound preference rows by (kind,id) through the whole plan flow (P2)", async () => {
    const { port } = persistence();
    // 绑定行名字与池内挂牌名完全无关（转售商改名形态）：只有 id 相等能命中；
    // 第二条拿媒体 id 绑自媒体形态 = 跨形态串门，必须不命中（不回落名称）。
    const fetchPreferenceBase = vi.fn(async () => [
      { name: "某转售挂牌变体", exact: true, kind: "media" as const, resourceId: 11 },
      { name: "跨形态串门条目", exact: true, kind: "we-media" as const, resourceId: 11 },
    ]);
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
      keywordSearch(),
      () => new Date("2026-08-15T00:00:00.000Z"),
      undefined,
      undefined,
      fetchPreferenceBase,
    );
    await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    const call = vi.mocked(port.finishDiscovery).mock.calls[0]![0];
    expect(call.preferenceChannelNames).toEqual([
      "某转售挂牌变体",
      "跨形态串门条目",
    ]);
    const rows = call.preferenceMatchedChannels ?? [];
    expect(rows.length).toBe(2);
    // (media,11) 命中池内「汽车日报」——绑定行形态天然正确，名字漂移无感。
    const bound = rows.find((row) => row.entryName === "某转售挂牌变体");
    expect(bound).toMatchObject({
      matched: true,
      recommended: true,
      representativeName: "汽车日报",
    });
    // (we-media,11) 形态不符 = 不命中；同 id 的媒体资源在场也不救（无名称回落）。
    const crossKind = rows.find((row) => row.entryName === "跨形态串门条目");
    expect(crossKind).toMatchObject({ matched: false, recommended: false });
  });

  it("degrades to an empty preference base when the ops-console pull fails", async () => {
    const { port } = persistence();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchPreferenceBase = vi.fn(async () => {
      throw new Error("preference_pull_http_502");
    });
    const service = new DistributionPlanningService(
      { workspaceId: "workspace", sessionId: "session" },
      port,
      provider(),
      keywordSearch(),
      () => new Date("2026-08-15T00:00:00.000Z"),
      undefined,
      undefined,
      fetchPreferenceBase,
    );
    const result = await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    // 拉取失败只损失偏好路证据：计划照常产出，名单为空、无偏好证据。
    expect(result.status).toBe("draft");
    const call = vi.mocked(port.finishDiscovery).mock.calls[0]![0];
    expect(call.preferenceChannelNames).toEqual([]);
    expect(call.preferenceMatchedChannels).toEqual([]);
    expect(
      result.candidates.every((candidate) =>
        candidate.evidence.every((item) => item.path !== "preference"),
      ),
    ).toBe(true);
    // 脱敏告警：只有错误码语义，不含 token/响应体。
    expect(warn).toHaveBeenCalledWith(
      "[preference-channels] pull failed:",
      "preference_pull_http_502",
    );
    warn.mockRestore();
  });

  it("runs with an empty preference base when no gateway fetcher is configured", async () => {
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
    expect(result.status).toBe("draft");
    const call = vi.mocked(port.finishDiscovery).mock.calls[0]![0];
    expect(call.preferenceChannelNames).toEqual([]);
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
      placeOrder: vi.fn(async () => {
        throw new Error("not used");
      }),
      queryOrders: vi.fn(async () => {
        throw new Error("not used");
      }),
      urgeOrder: vi.fn(async () => {
        throw new Error("not used");
      }),
      cancelOrder: vi.fn(async () => {
        throw new Error("not used");
      }),
      applyRefund: vi.fn(async () => {
        throw new Error("not used");
      }),
      applyRepublish: vi.fn(async () => {
        throw new Error("not used");
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
        async apply(input: {
          permitId: string;
          operation: string;
          units: number;
        }) {
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
    expect(permits.calls[0].permitId).toMatch(
      /^dist:article-operation:[0-9a-f]{16}$/,
    );
    expect(permits.calls).toEqual([
      permits.calls[0],
      {
        kind: "report",
        permitId: permits.calls[0].permitId,
        unit: 0,
        outcome: "success",
      },
    ]);
  });

  it("reports failed passive probes as failure units (per-question refund)", async () => {
    const { port } = persistence();
    const permits = permitPort();
    const search = keywordSearch();
    search.probeQuestion.mockRejectedValue(
      new Error("keyword-search 上游请求失败"),
    );
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
      {
        kind: "report",
        permitId: permits.calls[0].permitId,
        unit: 0,
        outcome: "failure",
      },
    ]);
  });

  it("replays the same permitId for the same source (recovery re-run) and never bills resource browsing", async () => {
    const { port } = persistence();
    const permits = permitPort();
    const search = keywordSearch();
    const service = billedService(port, permits.port, search);

    await service.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    const firstPermitId = permits.calls[0].permitId;
    const resourceCallsBefore = (
      provider().listResources as ReturnType<typeof vi.fn>
    ).mock;
    expect(resourceCallsBefore).toBeDefined();

    // 同一来源恢复重跑：重放同一 permitId，不产生第二笔申请。
    const secondPersistence = persistence();
    const secondPermits = permitPort();
    const service2 = billedService(
      secondPersistence.port,
      secondPermits.port,
      search,
    );
    await service2.start({
      workspaceId: "workspace",
      sessionId: "session",
      source,
    });
    expect(secondPermits.calls[0]).toMatchObject({
      kind: "apply",
      permitId: firstPermitId,
      units: 1,
    });

    // 浏览/读取面（latest/get/context/edit/confirm）零 permit 调用。
    const readPermits = permitPort();
    const readService = billedService(
      persistence().port,
      readPermits.port,
      search,
    );
    await readService.latest({
      workspaceId: "workspace",
      sessionId: "session",
    });
    await readService.context({
      workspaceId: "workspace",
      sessionId: "session",
    });
    expect(readPermits.calls).toEqual([]);
  });
});

describe("preference channel gateway pull (ops-console base list)", () => {
  it("parses strict shapes and discards the whole list on any malformed entry", () => {
    expect(parsePreferenceChannelsResponse(null)).toEqual([]);
    expect(parsePreferenceChannelsResponse({ channels: "nope" })).toEqual([]);
    expect(parsePreferenceChannelsResponse([1, 2])).toEqual([]);
    // 任一条目坏形状 → 整单作废（自家 backend 固定契约，半坏即契约漂移），
    // 不部分透传。
    expect(
      parsePreferenceChannelsResponse({
        channels: [
          { name: "  红餐网  ", domain: "canyinj.com", exact: true },
          { name: "" },
        ],
      }),
    ).toEqual([]);
    expect(
      parsePreferenceChannelsResponse({ channels: [{ name: 42 }] }),
    ).toEqual([]);
    expect(
      parsePreferenceChannelsResponse({ channels: ["junk"] }),
    ).toEqual([]);
    expect(
      parsePreferenceChannelsResponse({
        channels: [{ name: "x".repeat(201), exact: true }],
      }),
    ).toEqual([]);
    expect(
      parsePreferenceChannelsResponse({
        channels: [{ name: "红餐网", domain: "", exact: true }],
      }),
    ).toEqual([]);
    expect(
      parsePreferenceChannelsResponse({
        channels: [{ name: "红餐网", domain: "canyinj.com" }],
      }),
    ).toEqual([]);
    // 合法形状逐条透传（trim、domain 缺省、exact 布尔）。
    expect(
      parsePreferenceChannelsResponse({
        channels: [
          { name: "  红餐网  ", domain: "canyinj.com", exact: true },
          { name: "列举网", exact: false },
        ],
      }),
    ).toEqual([
      { name: "红餐网", domain: "canyinj.com", exact: true },
      { name: "列举网", exact: false },
    ]);
    // 条目上限：超长名单截断到 100，不是形状违规。
    const capped = parsePreferenceChannelsResponse({
      channels: Array.from({ length: 150 }, () => ({
        name: "渠道",
        exact: true,
      })),
    });
    expect(capped).toHaveLength(100);
  });

  it("parses bound entries with paired kind/resourceId and rejects drift", () => {
    // 绑定行（P2）：kind+resourceId 成对在场则原样透传（id 相等命中用）。
    expect(
      parsePreferenceChannelsResponse({
        channels: [
          {
            name: "红餐网",
            exact: true,
            kind: "media",
            resourceId: 42,
          },
          { name: "列举网", exact: false },
        ],
      }),
    ).toEqual([
      { name: "红餐网", exact: true, kind: "media", resourceId: 42 },
      { name: "列举网", exact: false },
    ]);
    // kind 白名单之外 → 整单作废。
    expect(
      parsePreferenceChannelsResponse({
        channels: [{ name: "红餐网", exact: true, kind: "video", resourceId: 42 }],
      }),
    ).toEqual([]);
    // resourceId 非正整数（0/负数/小数/字符串）→ 整单作废。
    for (const resourceId of [0, -1, 1.5, "42"]) {
      expect(
        parsePreferenceChannelsResponse({
          channels: [
            { name: "红餐网", exact: true, kind: "media", resourceId },
          ],
        }),
      ).toEqual([]);
    }
    // 成对校验：单字段出现（有 kind 无 resourceId / 反之）→ 契约漂移，整单作废。
    expect(
      parsePreferenceChannelsResponse({
        channels: [{ name: "红餐网", exact: true, kind: "media" }],
      }),
    ).toEqual([]);
    expect(
      parsePreferenceChannelsResponse({
        channels: [{ name: "红餐网", exact: true, resourceId: 42 }],
      }),
    ).toEqual([]);
  });

  it("fetches from the gateway with bearer token and codes query", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ channels: [{ name: "红餐网", exact: true }] }),
    );
    const channels = await fetchPreferenceChannelsFromGateway({
      baseUrl: "https://gw.example.com/",
      accessToken: "token-1",
      codes: [7, 13],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(channels).toEqual([{ name: "红餐网", exact: true }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://gw.example.com/config/preference-channels?codes=7,13",
      expect.objectContaining({
        headers: { authorization: "Bearer token-1" },
      }),
    );
    // 空码集 = 无 query（只拉通用兜底行）。
    await fetchPreferenceChannelsFromGateway({
      baseUrl: "https://gw.example.com",
      accessToken: "token-1",
      codes: [],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(vi.mocked(fetchImpl).mock.calls[1]![0]).toBe(
      "https://gw.example.com/config/preference-channels",
    );
  });

  it("throws a typed status-only error on non-2xx (no body/token leak)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("upstream secret body", { status: 502 }),
    );
    await expect(
      fetchPreferenceChannelsFromGateway({
        baseUrl: "https://gw.example.com",
        accessToken: "token-1",
        codes: [],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow("preference_pull_http_502");
  });
});

describe("preferenceIndustryCodes (brand-industry selector incl. industry-trade supplement)", () => {
  it("maps common industries through the we-media vocabulary", () => {
    expect(preferenceIndustryCodes("汽车改装")).toEqual([7]);
    expect(preferenceIndustryCodes("餐饮")).toEqual([13]);
    expect(preferenceIndustryCodes("  ")).toEqual([]);
  });

  it("covers industry-trade brands via the 26 supplement (media-appendix orphan)", () => {
    // 工业/制造/化工/能源/物流线：自媒体附录无类目，经别名表→「工业」
    // 碎片命中补位码 26，否则这些行业只能落通用、行业隔离失效。
    expect(preferenceIndustryCodes("工业")).toEqual([26]);
    expect(preferenceIndustryCodes("化工制造")).toEqual([26]);
    expect(preferenceIndustryCodes("物流贸易")).toEqual([26]);
  });
});
