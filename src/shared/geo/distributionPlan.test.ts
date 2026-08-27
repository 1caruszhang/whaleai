import { describe, expect, it } from "vitest";

import { GEO_PORT_CONTRACT } from "./portContract";
import {
  applyDistributionPlanEdit,
  assignDistributionChannels,
  buildDistributionCandidates,
  normalizeDistributionResource,
  selectPassiveSources,
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
  overrides: Partial<Parameters<typeof buildDistributionCandidates>[0]> = {},
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
    perArticleMaxPoints: 3_200,
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
      perArticleMaxPoints: 3_200,
      totalMaxPoints: 16_000,
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

  it("does not align shared multi-tenant platform domains as channel evidence", () => {
    const result = buildDistributionCandidates({
      industry: "餐饮",
      targetAudience: "餐饮加盟创业者",
      questionSources: [
        {
          id: "probe:q-1:1",
          questionId: "q-1",
          question: "餐饮加盟有哪些坑？",
          title: "闭店率直逼80%!昔日餐饮顶流跌落神坛_有趣的橙子sGq",
          url: "http://m.toutiao.com/group/7660280796321759780/",
          articleIds: ["article-news"],
        },
        {
          id: "probe:q-2:1",
          questionId: "q-2",
          question: "干蒸菜加盟靠谱吗？",
          title: "红餐网盘点干蒸菜市场",
          url: "https://www.redchinaweb.cn/article/1",
          articleIds: ["article-showcase"],
        },
      ],
      activeSources: [
        {
          title: "今日头条美食垂类频道",
          url: "https://www.toutiao.com/channel/food",
          articleIds: ["article-news"],
        },
        {
          title: "南郡新闻",
          url: "https://www.toutiao.com/article/7628893842158223878/",
          articleIds: ["article-news"],
        },
      ],
      preferenceChannels: [],
      perArticleMaxPoints: 3_200,
      articles,
      resources: [
        // 同在 toutiao.com 的无关头条号：被动（引用文章在 m.toutiao.com）与
        // 主动（美食垂类频道）的域名对齐都必须失效，且无名称证据 → 不进候选。
        resource("media", {
          id: 11,
          name: "济南时报（官方头条号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.toutiao.com/article/7647701690547782170/",
        }),
        // 引用标题含核心名「有趣的橙子sGq」的头条号：被动名称对齐仍命中。
        resource("media", {
          id: 12,
          name: "有趣的橙子sGq（头条号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.toutiao.com/c/user/token/abc/",
        }),
        // 主动召回同名账号：名称子串对齐仍命中。
        resource("media", {
          id: 13,
          name: "南郡新闻（官方头条号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.toutiao.com/article/7628893842158223878/",
        }),
        // 自有域名媒体站：被动域名对齐不受多租户门影响。
        resource("media", {
          id: 14,
          name: "红餐网",
          status: 2,
          price: "120",
          entrance_link: "https://www.redchinaweb.cn",
        }),
        // 名称带平台品牌限定后缀的头条号：多租户来源的平台品牌兜底分
        // （0.5）不再作为主动路证据——同名不同号不误挂。
        resource("media", {
          id: 15,
          name: "白城融媒（今日头条）",
          status: 2,
          price: "60",
          entrance_link: "https://www.toutiao.com/c/user/token/bc/",
        }),
        // 渠道字面真实重叠（美食频道家族）：主动路名称证据仍命中。
        resource("media", {
          id: 16,
          name: "今日头条美食（GEO）",
          status: 2,
          price: "60",
          entrance_link: "https://www.toutiao.com/c/user/token/ms/",
        }),
      ],
    });
    const byId = new Map(result.candidates.map((c) => [c.resourceId, c]));
    expect(byId.get(11)).toBeUndefined();
    const orange = byId.get(12)!;
    expect(orange.pathHits).toContain("passive");
    expect(orange.pathHits).not.toContain("active");
    const nanjun = byId.get(13)!;
    expect(nanjun.pathHits).toContain("active");
    expect(nanjun.pathHits).not.toContain("passive");
    const redcan = byId.get(14)!;
    expect(redcan.pathHits).toContain("passive");
    // 品牌限定后缀（（今日头条））不算渠道身份：白城融媒无任何名称证据。
    expect(byId.get(15)).toBeUndefined();
    const toutiaoFood = byId.get(16)!;
    expect(toutiaoFood.pathHits).toContain("active");
  });

  it("filters unavailable and channels over the user per-article point limit before alignment", () => {
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
        name: "超过单篇点数上限渠道",
        status: 2,
        price: "200.01",
        published_rate: 90,
        channel_type: 6,
        remark: "AI",
      }),
      resource("media", {
        id: 4,
        name: "刚好达到单篇上限渠道",
        status: 2,
        price: "200",
        published_rate: 70,
        channel_type: 6,
        remark: "AI",
      }),
    ]);

    // 发布率不参与决策；3200 点以内（含边界）保留，超过即过滤。
    expect(
      result.candidates
        .map((candidate) => candidate.resourceId)
        .sort((left, right) => left - right),
    ).toEqual([2, 4]);
    expect(result.summary).toMatchObject({
      filteredUnavailable: 1,
      filteredOverPerArticleLimit: 1,
      approvedResources: 2,
    });
  });

  it("keeps zero-rate channels eligible but excludes channels with unknown prices", () => {
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
      resource("media", {
        id: 2,
        name: "汽车零发布率媒体",
        status: 2,
        price: "100",
        published_rate: 0,
        channel_type: 6,
        remark: "AI",
      }),
    ]);
    expect(result.candidates.map((candidate) => candidate.resourceId)).toEqual([
      2,
    ]);
    expect(result.candidates[0].publishedRate).toBe(0);
    expect(result.summary.filteredUnknownPrice).toBe(1);
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
      totalMaxPoints: 16_000,
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

  it("skips an over-budget candidate and assigns the next affordable channel", () => {
    const result = candidateResult([
      resource("media", {
        id: 1,
        name: "文章一优先媒体",
        status: 2,
        price: "100",
        channel_type: 6,
        remark: "汽车 新能源车主",
      }),
      resource("media", {
        id: 2,
        name: "文章二昂贵媒体",
        status: 2,
        price: "120",
        channel_type: 6,
        remark: "汽车 新能源车主",
      }),
      resource("media", {
        id: 3,
        name: "文章二可负担媒体",
        status: 2,
        price: "100",
        channel_type: 6,
        remark: "汽车 新能源车主",
      }),
    ]);
    const candidates = result.candidates.map((candidate) => ({
      ...candidate,
      evidence:
        candidate.resourceId === 1 || candidate.resourceId === 2
          ? [
              ...candidate.evidence,
              {
                path: "passive" as const,
                weight: 0.4,
                label: "文章定向来源",
                reference: "fixture",
                url: null,
                articleIds: [
                  candidate.resourceId === 1
                    ? "article-news"
                    : "article-showcase",
                ],
              },
            ]
          : candidate.evidence,
      pathHits:
        candidate.resourceId === 1 || candidate.resourceId === 2
          ? ["passive" as const, ...candidate.pathHits]
          : candidate.pathHits,
      hitCount:
        candidate.hitCount +
        (candidate.resourceId === 1 || candidate.resourceId === 2 ? 1 : 0),
      recommendationWeight:
        candidate.recommendationWeight +
        (candidate.resourceId === 1 || candidate.resourceId === 2 ? 0.4 : 0),
    }));

    const assignments = assignDistributionChannels({
      articles,
      candidates,
      mappingMode: "one-to-one",
      ratio: { media: 1, weMedia: 0 },
      totalMaxPoints: 3_200,
      publishStartAt: "2026-08-20T09:00:00+08:00",
    });

    expect(assignments.map((assignment) => assignment.resourceId)).toEqual([
      1, 3,
    ]);
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
        totalMaxPoints: 16_000,
        publishStartAt: "2026-08-20T09:00:00+08:00",
      }),
      perArticleMaxPoints: 3_200,
      totalMaxPoints: 16_000,
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

describe("passive source selection (per-question quota + cross-question ranking)", () => {
  it("caps citations per question at 10 so later questions still get slots", () => {
    const citations = Array.from({ length: 15 }, (_, index) => ({
      url: `https://q-a.example.com/post/${index}`,
      title: `引用 ${index}`,
    }));
    const sources = selectPassiveSources([
      {
        question: {
          id: "q-1",
          question: "问题一",
          articleIds: ["article-news"],
        },
        citations,
      },
      {
        question: { id: "q-2", question: "问题二", articleIds: [] },
        citations: [
          { url: "https://q-b.example.com/only", title: "问题二引用" },
        ],
      },
    ]);
    expect(
      sources.filter((source) => source.questionId === "q-1"),
    ).toHaveLength(10);
    expect(
      sources.filter((source) => source.questionId === "q-2"),
    ).toHaveLength(1);
  });

  it("ranks channels cited by more distinct questions first", () => {
    const sources = selectPassiveSources([
      {
        question: { id: "q-1", question: "问题一", articleIds: [] },
        citations: [
          { url: "https://solo-site.com/a", title: "单问渠道" },
          { url: "https://shared-site.com/a", title: "跨问渠道" },
        ],
      },
      {
        question: { id: "q-2", question: "问题二", articleIds: [] },
        citations: [{ url: "https://shared-site.com/b", title: "跨问渠道2" }],
      },
    ]);
    expect(sources.map((source) => source.title)).toEqual([
      "跨问渠道",
      "跨问渠道2",
      "单问渠道",
    ]);
  });

  it("keeps site names and uses them as the title fallback", () => {
    const sources = selectPassiveSources([
      {
        question: { id: "q-1", question: "问题一", articleIds: [] },
        citations: [
          {
            url: "https://hezegd.com/a",
            title: "干蒸菜加盟避坑指南",
            siteName: "和泽加盟网",
          },
          // 只有 site_name：作为标题兜底，避免显示裸域名。
          { url: "https://xixiage.cn/", siteName: "夕霞阁官网" },
        ],
      },
    ]);
    expect(sources[0]).toMatchObject({
      title: "干蒸菜加盟避坑指南",
      siteName: "和泽加盟网",
    });
    expect(sources[1]).toMatchObject({
      title: "夕霞阁官网",
      siteName: "夕霞阁官网",
    });
  });

  it("keeps only the top 50 sources and dedupes question+url pairs", () => {
    const collected = Array.from({ length: 7 }, (_, questionIndex) => ({
      question: {
        id: `q-${questionIndex + 1}`,
        question: `问题 ${questionIndex + 1}`,
        articleIds: [],
      },
      citations: Array.from({ length: 10 }, (_, citeIndex) => ({
        url: `https://site-${questionIndex}.example.com/p/${citeIndex}`,
        title: `引用 ${questionIndex}-${citeIndex}`,
      })),
    }));
    collected.push({
      question: { id: "q-1", question: "问题 1", articleIds: [] },
      citations: [{ url: "https://site-0.example.com/p/0", title: "重复引用" }],
    });
    const sources = selectPassiveSources(collected);
    expect(sources).toHaveLength(50);
    expect(new Set(sources.map((source) => source.id)).size).toBe(50);
    expect(sources.some((source) => source.title === "重复引用")).toBe(false);
  });
});
