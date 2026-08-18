import { describe, expect, it } from "vitest";

import { GEO_PORT_CONTRACT } from "./portContract";
import {
  applyDistributionPlanEdit,
  assignDistributionChannels,
  buildDistributionCandidates,
  distributionPlanBlockingIssues,
  normalizeDistributionResource,
  validateDistributionPlanStartInput,
  type DistributionArticleSnapshot,
  type DistributionPlanProjection,
  type DistributionQuestionSource,
  type DistributionResourceInput,
} from "./distributionPlan";

const articles: DistributionArticleSnapshot[] = [
  {
    id: "article-news",
    operationId: "article-operation",
    approvedRevision: 2,
    title: "汽车行业观察",
    topic: "新能源车售后服务",
    contentType: "news",
  },
  {
    id: "article-showcase",
    operationId: "article-operation",
    approvedRevision: 1,
    title: "门店服务指南",
    topic: "汽车门店服务",
    contentType: "showcase",
  },
];

const sources: DistributionQuestionSource[] = [
  {
    id: "source-1",
    questionId: "q-1",
    question: "新能源车售后服务怎么选？",
    title: "汽车日报",
    url: "https://auto.example.com/questions/1",
    articleIds: ["article-news"],
  },
];

function resource(
  kind: "media" | "we-media",
  input: DistributionResourceInput,
) {
  const normalized = normalizeDistributionResource(kind, input);
  if (!normalized) throw new Error("fixture invalid");
  return normalized;
}

function candidateResult(
  resources: ReturnType<typeof resource>[],
  overrides: Partial<
    Parameters<typeof buildDistributionCandidates>[0]
  > = {},
) {
  return buildDistributionCandidates({
    industry: "汽车改装",
    targetAudience: "新能源车主 门店经营者",
    questionSources: sources,
    activeSources: [
      {
        title: "汽车垂直媒体",
        url: "https://autovertical.example.org/auto",
        articleIds: ["article-news"],
      },
    ],
    preferenceChannels: [
      { name: "新能源车主观察", exact: true },
      { name: "盐城网", exact: true },
    ],
    articles,
    resources,
    ...overrides,
  });
}

describe("Ticket 12 distribution plan contract", () => {
  it("validates and freezes industry, audience, real question sources, constraints and exact articles", () => {
    const result = validateDistributionPlanStartInput({
      articleOperationId: " article-operation ",
      articleIds: ["article-news", "article-showcase", "article-news"],
      industry: " 汽车改装 ",
      targetAudience: " 新能源车主   门店经营者 ",
      questionSources: sources,
      preferredResourceIds: [2, 2],
      mappingMode: "ratio",
      ratio: { media: 2, weMedia: 1 },
      budgetCny: 200,
      publishStartAt: "2026-08-20T09:00:00+08:00",
    });

    expect(result.articleIds).toEqual(["article-news", "article-showcase"]);
    expect(result.industry).toBe("汽车改装");
    expect(result.targetAudience).toBe("新能源车主 门店经营者");
    expect(result.questionSources[0].url).toBe(
      "https://auto.example.com/questions/1",
    );
    expect(result.preferredResourceIds).toEqual([2]);
    expect(result.publishStartAt).toBe("2026-08-20T01:00:00.000Z");
  });

  it("keeps js_ai dev path weights and sums each distinct path only once", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "汽车日报",
        status: 2,
        price: "88.00",
        published_rate: 92,
        entrance_link: "https://auto.example.com",
        remark: "新能源车主 AI 包收录",
        channel_type: 6,
      }),
      resource("we-media", {
        id: 2,
        name: "新能源车主观察",
        status: 2,
        price: "66",
        published_rate: 85,
        entrance_link: "https://cars.example.cn",
        remark: "新能源车主",
        industry_category: 7,
      }),
    ]);

    const first = result.candidates.find(
      (candidate) => candidate.resourceId === 1,
    )!;
    // 被动=探测引用域名对齐；主动=全局召回渠道对齐（本资源未命中）；
    // 保底=结构化类目/人群规则路（合并后单路）；偏好=名单精确名命中。
    expect(first.pathHits).toEqual(["passive", "fallback"]);
    expect(first.recommendationWeight).toBeCloseTo(
      GEO_PORT_CONTRACT.channelRecall.paths.passive.weight +
        GEO_PORT_CONTRACT.channelRecall.paths.fallback.weight,
      10,
    );
    const preferred = result.candidates.find(
      (candidate) => candidate.resourceId === 2,
    )!;
    expect(preferred.pathHits).toEqual(["fallback", "preference"]);
    expect(preferred.recommendationWeight).toBeCloseTo(
      GEO_PORT_CONTRACT.channelRecall.paths.fallback.weight +
        GEO_PORT_CONTRACT.channelRecall.paths.preference.weight,
      10,
    );
    expect(preferred.resourceSnapshot.name).toBe(preferred.name);
    expect(preferred.resourceSnapshot.price).toBe("66");
    expect(preferred.resourceSnapshot.publishedRate).toBe(85);
    expect(preferred.availability.providerStatus).toBe(2);
  });

  it("aligns global-recall channels on the active path with domain-first matching", () => {
    const result = candidateResult(
      [
        resource("media", {
          id: 9,
          name: "汽车垂直媒体",
          status: 2,
          price: "30",
          published_rate: 0,
          entrance_link: "https://autovertical.example.org/auto",
          channel_type: 1,
          remark: "普通资讯",
        }),
      ],
      {
        // 类目与人群都不命中、不在偏好名单——只剩主动路证据可命中。
        industry: "医疗整形",
        targetAudience: "求美人群",
        preferenceChannels: [],
      },
    );
    const active = result.candidates.find(
      (candidate) => candidate.resourceId === 9,
    )!;
    expect(active.pathHits).toEqual(["active"]);
    expect(active.evidence[0].articleIds).toEqual(["article-news"]);
  });

  it("hard-filters unavailable, known low-rate, and high-price resources before alignment", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "审核中渠道",
        status: 1,
        price: "20",
        published_rate: 99,
        channel_type: 6,
        remark: "AI",
      }),
      resource("media", {
        id: 2,
        name: "低成功率渠道",
        status: 2,
        price: "20",
        published_rate: 69,
        channel_type: 6,
        remark: "AI",
      }),
      resource("media", {
        id: 3,
        name: "超预算门槛渠道",
        status: 2,
        price: "150",
        published_rate: 90,
        channel_type: 6,
        remark: "AI",
      }),
      resource("media", {
        id: 4,
        name: "真实可用渠道",
        status: 2,
        price: "149.99",
        published_rate: 70,
        channel_type: 6,
        remark: "AI",
      }),
    ]);

    // 发布率不参与决策（用户裁决 2026-08-18）：低成功率渠道保留为候选，
    // 唯一被质量过滤掉的是价格 >=150 的渠道。
    expect(
      result.candidates
        .map((candidate) => candidate.resourceId)
        .sort((left, right) => left - right),
    ).toEqual([2, 4]);
    expect(result.summary).toMatchObject({
      filteredUnavailable: 1,
      filteredHighPrice: 1,
      approvedResources: 2,
    });
  });

  it("retains zero-rate and empty-price channels; only unknown price blocks confirmation", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "汽车未知报价媒体",
        status: 2,
        price: "",
        published_rate: 0,
        channel_type: 6,
        remark: "AI",
      }),
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].estimatedPriceCny).toBeNull();
    expect(result.candidates[0].publishedRate).toBe(0);
    expect(result.candidates[0].uncertainties).toEqual([
      "价格未知，不能进入已确认分发计划",
    ]);
    const issues = distributionPlanBlockingIssues({
      providerState: "available",
      questionSources: sources,
      articles: [articles[0]],
      candidates: result.candidates,
      selectedResourceIds: [1],
      assignments: [
        {
          articleId: "article-news",
          resourceId: 1,
          reason: "source-evidence",
          scheduledAt: "2026-08-20T01:00:00.000Z",
        },
      ],
      budgetCny: 100,
    });
    expect(issues).toContain("selected-channel-price-unknown");
    expect(issues).not.toContain("selected-channel-published-rate-unknown");
  });

  it("returns an empty candidate set instead of random or fabricated fallback", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "不相关渠道",
        status: 2,
        price: "50",
        published_rate: 90,
        channel_type: 1,
        remark: "普通科技资讯",
      }),
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.summary.alignedResources).toBe(0);
  });

  it("maps every article to one distinct real channel and honors the batch ratio", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "汽车日报",
        status: 2,
        price: "80",
        published_rate: 90,
        entrance_link: "https://auto.example.com",
        channel_type: 6,
        remark: "AI",
      }),
      resource("we-media", {
        id: 2,
        name: "新能源车主观察",
        status: 2,
        price: "60",
        published_rate: 90,
        industry_category: 7,
        remark: "新能源车主",
      }),
    ]);
    const assignments = assignDistributionChannels({
      articles,
      candidates: result.candidates,
      mappingMode: "ratio",
      ratio: { media: 1, weMedia: 1 },
      publishStartAt: "2026-08-20T09:00:00+08:00",
    });
    expect(
      assignments.map((assignment) => assignment.resourceId).sort(),
    ).toEqual([1, 2]);
    expect(
      new Set(assignments.map((assignment) => assignment.resourceId)).size,
    ).toBe(2);
    expect(assignments[0].reason).toBe("source-evidence");
  });

  it("recomputes blockers after user edits mapping, budget and time", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "汽车日报",
        status: 2,
        price: "80",
        published_rate: 90,
        entrance_link: "https://auto.example.com",
        channel_type: 6,
        remark: "AI",
      }),
      resource("we-media", {
        id: 2,
        name: "新能源车主观察",
        status: 2,
        price: "60",
        published_rate: 90,
        industry_category: 7,
        remark: "新能源车主",
      }),
    ]);
    const projection: DistributionPlanProjection = {
      id: "plan-1",
      operationId: "distribution-operation",
      workspaceId: "workspace",
      createdBySessionId: "session-a",
      articleOperationId: "article-operation",
      policyVersion: "js-ai-dev-four-path-distribution-v1",
      status: "draft",
      revision: 1,
      industry: "汽车改装",
      targetAudience: "新能源车主 门店经营者",
      providerState: "available",
      providerSnapshot: {
        slot: "distribution",
        provider: "超级媒介",
        endpointFamily: "chaojimeijie-resource-api",
        policyVersion: "js-ai-dev-four-path-distribution-v1",
        fetchedAt: "2026-08-15T00:00:00.000Z",
        mediaTotal: 1,
        weMediaTotal: 1,
      },
      questionSources: sources,
      preferredResourceIds: [2],
      mappingMode: "one-to-one",
      ratio: { media: 2, weMedia: 1 },
      articles,
      candidates: result.candidates,
      resourceSnapshot: result.resourceSnapshot,
      selectedResourceIds: [1, 2],
      assignments: assignDistributionChannels({
        articles,
        candidates: result.candidates,
        mappingMode: "one-to-one",
        ratio: { media: 2, weMedia: 1 },
        publishStartAt: "2026-08-20T09:00:00+08:00",
      }),
      budgetCny: 200,
      publishStartAt: "2026-08-20T01:00:00.000Z",
      discoverySummary: result.summary,
      blockingIssues: [],
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
      confirmedAt: null,
    };

    const edited = applyDistributionPlanEdit(projection, {
      selectedResourceIds: [1, 2],
      assignments: projection.assignments.map((assignment, index) => ({
        ...assignment,
        scheduledAt: `2026-08-${20 + index}T09:00:00+08:00`,
      })),
      budgetCny: 100,
      publishStartAt: "2026-08-20T09:00:00+08:00",
    });
    expect(edited.blockingIssues).toEqual(["distribution-budget-exceeded"]);
  });
});
