import { describe, expect, it } from "vitest";

import distributionPlanContract from "./distributionPlanContract.json";
import { GEO_PORT_CONTRACT } from "./portContract";
import { buildUnambiguousDomains } from "./channelRecall";
import {
  DISTRIBUTION_PLAN_POLICY_VERSION,
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

  it("does not align portal-hosted sohu/163 account domains as channel evidence", () => {
    const result = buildDistributionCandidates({
      industry: "餐饮",
      targetAudience: "餐饮加盟创业者",
      questionSources: [
        {
          id: "probe:q-1:1",
          questionId: "q-1",
          question: "干蒸菜加盟靠谱吗？",
          title: "干蒸菜市场观察_厨房小记",
          url: "https://www.sohu.com/a/460012345_123456",
          articleIds: ["article-showcase"],
        },
        {
          id: "probe:q-2:1",
          questionId: "q-2",
          question: "餐饮加盟有哪些坑？",
          title: "餐饮加盟避坑实录",
          url: "https://www.163.com/dy/article/HQEQKFSM.html",
          articleIds: ["article-news"],
        },
      ],
      activeSources: [
        // 平台级推荐（163.com URL → 品牌「网易」）：网易号资源不应靠品牌兜底误挂。
        {
          title: "网易号生活精选",
          url: "https://www.163.com/dy/article/HQEQKFSM.html",
          articleIds: ["article-news"],
        },
        // 多租户来源上的同名账号：名称对齐仍命中。
        {
          title: "厨房小记",
          url: "https://www.sohu.com",
          articleIds: ["article-news"],
        },
      ],
      preferenceChannels: [],
      perArticleMaxPoints: 3_200,
      articles,
      resources: [
        // 与搜狐引用同域名、名称无关的搜狐号：被动域名对齐必须失效，
        // 主动来源（品牌「搜狐」零渠道字重叠）也不得兜底 → 不进候选。
        resource("media", {
          id: 21,
          name: "济南时报（搜狐号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.sohu.com/a/460999999_654321",
        }),
        // 引用标题含核心名「厨房小记」的搜狐号：被动/主动名称对齐仍命中。
        resource("media", {
          id: 22,
          name: "厨房小记（搜狐号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.sohu.com",
        }),
        // 网易号资源：被动（163.com 引用域名对齐）与主动（品牌「网易」兜底）
        // 两条误挂路径都必须失效 → 不进候选。
        resource("media", {
          id: 23,
          name: "白城融媒（网易号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.163.com",
        }),
      ],
    });
    const byId = new Map(result.candidates.map((c) => [c.resourceId, c]));
    expect(byId.get(21)).toBeUndefined();
    const kitchen = byId.get(22)!;
    expect(kitchen.pathHits).toContain("passive");
    expect(kitchen.pathHits).toContain("active");
    expect(byId.get(23)).toBeUndefined();
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
      url: `https://q-canyinj-guard.com/post/${index}`,
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
          { url: "https://q-aggre-news.com/only", title: "问题二引用" },
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

  it("returns every probed question's citations in full (2026-08-27 二轮裁决：总量帽废除) and dedupes question+url pairs", () => {
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
    // 7 问 × 每问 10 条 = 70 条全量返回；旧 totalCap=50 会截掉后 20 条。
    expect(sources).toHaveLength(70);
    expect(new Set(sources.map((source) => source.id)).size).toBe(70);
    expect(sources.some((source) => source.title === "重复引用")).toBe(false);
  });
});

describe("account-level passive alignment + aligned channel list (2026-08-27 二轮裁决)", () => {
  it("aligns multi-tenant citations to pool channels via L1 account id and gated L2 account name", () => {
    const result = buildDistributionCandidates({
      industry: "餐饮",
      targetAudience: "餐饮创业者",
      questionSources: [
        // L1：搜狐引用 URL 的 _mp_id 与池内搜狐号资源 entrance 相同。
        {
          id: "probe:q-1:1",
          questionId: "q-1",
          question: "食堂承包怎么选？",
          title: "食堂承包收费模式解读_厨房小记",
          url: "https://m.sohu.com/a/1065822220_122878478/",
          articleIds: ["article-news"],
        },
        // L2：头条引用标题尾缀账号名 × 渠道核心名 + 平台门。
        {
          id: "probe:q-1:2",
          questionId: "q-1",
          question: "食堂承包怎么选？",
          title: "2026年靠谱的食堂承包公司盘点_饭饭餐饮",
          url: "http://m.toutiao.com/group/7675431778064122410/",
          articleIds: ["article-news"],
        },
        // L3：抖音引用无尾缀，靠 server 注入的 resolvedAccountName 对齐。
        {
          id: "probe:q-2:1",
          questionId: "q-2",
          question: "团餐避坑有哪些？",
          title: "团餐合作模式避坑干货",
          url: "https://www.iesdouyin.com/share/video/7675535591546899411",
          articleIds: ["article-showcase"],
          resolvedAccountName: "饭饭餐饮",
        },
      ],
      activeSources: [],
      preferenceChannels: [],
      perArticleMaxPoints: 3_200,
      articles,
      resources: [
        resource("media", {
          id: 31,
          name: "厨房小记（搜狐号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.sohu.com/a/460012345_122878478",
        }),
        resource("media", {
          id: 32,
          name: "饭饭餐饮（今日头条）",
          status: 2,
          price: "60",
          entrance_link: "https://www.toutiao.com/item/7655326832983638579/",
        }),
        // L3 正面：抖音号资源承接 douyin 引用注入的 resolvedAccountName。
        resource("media", {
          id: 33,
          name: "饭饭餐饮（抖音号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.douyin.com/user/msituan",
        }),
        // 平台门反面（Q6，2026-08-28）：搜狐号同名资源接不住头条（L2）/抖音
        // （L3）账号名，搜狐引用的 mp_id 也不同——多租户引用的核心名兜底匹配
        // 同样过不了平台一致性门（引用族今日头条/抖音 ∉ 资源族{搜狐}），跨平台
        // 同名不再构成任何被动证据（旧无门口径已废除）。
        resource("media", {
          id: 35,
          name: "饭饭餐饮（搜狐号）",
          status: 2,
          price: "60",
          entrance_link: "https://www.sohu.com/a/1_999999",
        }),
      ],
    });
    const byId = new Map(result.candidates.map((c) => [c.resourceId, c]));
    // L1：mp_id 相等 → 被动证据（label 带账号标注）。
    const sohu = byId.get(31)!;
    expect(sohu.pathHits).toContain("passive");
    expect(sohu.evidence.find((e) => e.path === "passive")?.label).toContain(
      "账号：搜狐号#122878478",
    );
    // L2：头条尾缀账号名 × 核心名 + 头条平台门。
    const toutiao = byId.get(32)!;
    expect(toutiao.pathHits).toContain("passive");
    expect(toutiao.evidence.find((e) => e.path === "passive")?.label).toContain(
      "账号：饭饭餐饮",
    );
    // L3：抖音号资源承接注入的账号名。
    expect(byId.get(33)!.pathHits).toContain("passive");
    // 跨平台同名（搜狐号）：平台门阻断，无被动证据、无对齐列表行。
    const wrongPlatform = byId.get(35);
    expect(wrongPlatform?.pathHits ?? []).not.toContain("passive");
    expect(
      result.passiveAlignedChannels.find((c) => c.resourceId === 35),
    ).toBeUndefined();
    // 对齐列表：账号标注随行。Q15 主干族把 饭饭餐饮（今日头条）与（抖音号）
    // 并为一族，行计数升级为族并集。
    const aligned32 = result.passiveAlignedChannels.find(
      (c) => c.resourceId === 32,
    )!;
    expect(aligned32.accounts).toContain("饭饭餐饮");
    expect(aligned32.questions).toBeGreaterThanOrEqual(1);
    // 观测：按路对齐计数把被动路记为 ≥3。
    expect(result.summary.alignedByPath.passive).toBeGreaterThanOrEqual(3);
  });

  it("resolves citation site names via pool reverse-lookup with title-suffix fallback", () => {
    const result = buildDistributionCandidates({
      industry: "餐饮",
      targetAudience: "餐饮创业者",
      questionSources: [
        {
          id: "probe:q-1:1",
          questionId: "q-1",
          question: "食堂承包公司有哪些？",
          title: "2026年正规的餐饮承包公司推荐 - 八方资源网",
          url: "https://mip.b2b168.com/wvs323607769.html",
          articleIds: ["article-news"],
        },
        {
          id: "probe:q-2:1",
          questionId: "q-2",
          question: "团餐服务商口碑怎么看？",
          title: "广东团餐服务商口碑查询 - 企查查",
          url: "https://www.qcc.com/ccomment/abc",
          articleIds: ["article-news"],
        },
      ],
      activeSources: [],
      preferenceChannels: [],
      perArticleMaxPoints: 3_200,
      articles,
      resources: [
        // 池内资源：b2b168 域名命中 → 组名反查为「八方资源网」。
        resource("media", {
          id: 41,
          name: "八方资源网",
          status: 2,
          price: "40",
          entrance_link: "https://www.b2b168.com/",
        }),
      ],
    });
    expect(result.citationSiteNames["b2b168.com"]).toBe("八方资源网");
    // 池外域名（企查查不在池里）：标题尾缀兜底。
    expect(result.citationSiteNames["qcc.com"]).toBe("企查查");
    // 反查命中率：2 个引用域名中 1 个由池反查命中。
    expect(result.summary.citationDomains).toBe(2);
    expect(result.summary.citationDomainPoolHits).toBe(1);
    // 池内独立站资源本身也拿到被动证据（域名对齐不受多租户门影响）。
    expect(
      result.candidates.find((c) => c.resourceId === 41)?.pathHits,
    ).toContain("passive");
  });
});

describe("official geo_platforms fallback recall (2026-08-27)", () => {  const geoFixture = () => [
    // 垂类∩官方GEO（tier 0）。
    resource("media", {
      id: 21,
      name: "垂类收录汽车网",
      status: 2,
      price: "80",
      published_rate: 90,
      entrance_link: "https://geo-auto.example.com",
      channel_type: 6,
      geo_platforms: [
        { id: 2, label: "豆包", screenshot: null },
        { id: 1, label: "DeepSeek", screenshot: null },
      ],
    }),
    // 纯垂类（tier 1）。
    resource("media", {
      id: 22,
      name: "垂类汽车网",
      status: 2,
      price: "80",
      published_rate: 90,
      entrance_link: "https://auto-only.example.com",
      channel_type: 6,
    }),
    // 纯官方GEO、类目未分类 0（tier 2）——旧逻辑永远进不了候选。
    resource("media", {
      id: 23,
      name: "未分类收录观察网",
      status: 2,
      price: "80",
      published_rate: 90,
      entrance_link: "https://geo-uncategorized.example.com",
      channel_type: 0,
      geo_platforms: [{ id: 5, label: "文心一言", screenshot: null }],
    }),
    // 仅人群词命中（tier 3）——三轮裁决起人群不再触发保底证据，无其它路即不进候选。
    resource("media", {
      id: 24,
      name: "新能源车主生活门户",
      status: 2,
      price: "80",
      published_rate: 90,
      entrance_link: "https://audience-portal.example.com",
      channel_type: 2,
    }),
    // 无任何命中：不进入候选。
    resource("media", {
      id: 25,
      name: "无关游戏站",
      status: 2,
      price: "80",
      published_rate: 90,
      entrance_link: "https://game.example.com",
      channel_type: 5,
    }),
    // 备注关键词 GEO（无官方标记）：只作信号文本，不独立触发——旧行为。
    resource("media", {
      id: 26,
      name: "关键词收录游戏站",
      status: 2,
      price: "80",
      published_rate: 90,
      entrance_link: "https://keyword-game.example.com",
      channel_type: 5,
      remark: "豆包收录效果好",
    }),
  ];

  // 恒等洗牌种子（j≡i）：召回随机采样退化为按池序取样，顺序断言可复现。
  const geoResult = () =>
    candidateResult(geoFixture(), {
      industry: "汽车",
      targetAudience: "新能源车主",
      questionSources: [],
      activeSources: [],
      preferenceChannels: [],
      random: () => 0.99,
    });

  it("admits official geo_platforms as a fallback trigger and ranks vertical∩GEO > vertical > GEO; audience-only drops out", () => {
    const result = geoResult();
    expect(result.candidates.map((candidate) => candidate.resourceId)).toEqual(
      [21, 22, 23],
    );

    const uncategorized = result.candidates.find(
      (candidate) => candidate.resourceId === 23,
    )!;
    expect(uncategorized.pathHits).toEqual(["fallback"]);
    expect(uncategorized.evidence[0].reference).toBe("geo:文心一言");
    expect(uncategorized.evidence[0].label).toBe(
      "官方 GEO 标记：文心一言已收录",
    );

    const verticalGeo = result.candidates.find(
      (candidate) => candidate.resourceId === 21,
    )!;
    expect(verticalGeo.fitReasons).toContain(
      "行业垂类且 AI 平台已收录（豆包/DeepSeek）",
    );
    expect(verticalGeo.evidence[0].label).toContain(
      "官方 GEO 标记：豆包/DeepSeek已收录",
    );

    const keywordOnly = result.candidates.find(
      (candidate) => candidate.resourceId === 26,
    );
    expect(keywordOnly).toBeUndefined();
  });

  it("keeps remark-keyword geo as signal text only when industry already matches", () => {
    const result = candidateResult(
      [
        resource("media", {
          id: 31,
          name: "关键词信号汽车网",
          status: 2,
          price: "80",
          published_rate: 90,
          entrance_link: "https://keyword-auto.example.com",
          channel_type: 6,
          remark: "豆包收录效果好",
        }),
      ],
      {
        industry: "汽车",
        targetAudience: "新能源车主",
        questionSources: [],
        activeSources: [],
        preferenceChannels: [],
      },
    );
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidence[0].label).toContain(
      "资源名称/备注含真实 GEO 收录信号",
    );
  });

  it("applies the same tier preference when assigning articles to channels", () => {
    const result = geoResult();
    const assignments = assignDistributionChannels({
      articles: [articles[0]],
      candidates: result.candidates,
      mappingMode: "one-to-one",
      ratio: { media: 2, weMedia: 1 },
      totalMaxPoints: 16_000,
      publishStartAt: "2026-08-20T09:00:00+08:00",
      industry: "汽车",
      targetAudience: "新能源车主",
    });
    expect(assignments[0].resourceId).toBe(21);
  });

  it("normalizes geo_platforms labels with tolerance (dedupe, drop malformed)", () => {
    const normalized = normalizeDistributionResource("media", {
      id: 41,
      name: "容错归一网",
      status: 2,
      price: "80",
      geo_platforms: [
        { id: 2, label: "豆包", screenshot: null },
        { id: 2, label: "豆包", screenshot: null },
        { id: 9, label: "  ", screenshot: null },
        { id: 10 },
        null,
      ] as never,
    });
    expect(normalized?.geoPlatforms).toEqual(["豆包"]);
    const absent = normalizeDistributionResource("media", {
      id: 42,
      name: "无标记网",
      status: 2,
      price: "80",
    });
    expect(absent?.geoPlatforms).toEqual([]);
  });
});

describe("official gate + variant family + junk + preference list (2026-08-28 用户裁决 Q3a/Q13/Q11/Q12/Q5)", () => {
  it("platform-level active source hits official-type resources only (Q3a)", () => {
    const result = candidateResult(
      [
        // 根路径 + 品牌核心名 → 官方型，承接对齐的平台级/同频道来源。
        resource("media", {
          id: 41,
          name: "今日头条美食（GEO）",
          status: 2,
          price: "30",
          entrance_link: "https://www.toutiao.com/",
        }),
        // 同平台不同垂类的官方型资源：频道佐证不齐，不得跨垂类命中。
        resource("media", {
          id: 43,
          name: "今日头条体育（GEO）",
          status: 2,
          price: "30",
          entrance_link: "https://www.toutiao.com/",
        }),
        // 文章页 entrance 的账号转售 → 平台级来源不命中（fuzzy 全分支核心名化）。
        resource("media", {
          id: 42,
          name: "泾川融媒（今日头条）",
          status: 2,
          price: "30",
          entrance_link: "https://www.toutiao.com/article/7676004397788299810/",
        }),
      ],
      {
        activeSources: [
          {
            title: "今日头条美食频道",
            url: "https://www.toutiao.com/channel/food",
            articleIds: ["article-news"],
          },
        ],
        preferenceChannels: [],
      },
    );
    const ids = result.candidates.map((c) => c.resourceId);
    expect(ids).toContain(41);
    expect(ids).not.toContain(42);
    expect(ids).not.toContain(43);
    const official = result.candidates.find((c) => c.resourceId === 41)!;
    expect(
      official.evidence.find((e) => e.path === "active")?.label,
    ).toContain("平台官方型");
  });

  it("platform-level source without channel word still lands on official-type resources (Q3a 收紧保留面)", () => {
    // 标题剥品牌后为空（纯平台级来源）→ 官方型承接不设频道佐证。
    const result = candidateResult(
      [
        resource("media", {
          id: 51,
          name: "网易房产（GEO）",
          status: 2,
          price: "30",
          entrance_link: "https://www.163.com/",
        }),
      ],
      {
        activeSources: [
          {
            title: "网易",
            url: "https://www.163.com/",
            articleIds: ["article-news"],
          },
        ],
        preferenceChannels: [],
      },
    );
    expect(result.candidates.map((c) => c.resourceId)).toContain(51);
  });

  it("cross-vertical official-type hit is blocked by channel corroboration (2026-08-28 收紧)", () => {
    // 实测复现：炊班主（团餐）场景，LLM 返回餐饮/医美频道，误挂网易房产。
    const result = candidateResult(
      [
        resource("media", {
          id: 61,
          name: "网易房产（GEO）",
          status: 2,
          price: "30",
          entrance_link: "https://www.163.com/",
          channel_type: 10,
        }),
        resource("media", {
          id: 62,
          name: "网易餐饮（GEO）",
          status: 2,
          price: "30",
          entrance_link: "https://www.163.com/",
          channel_type: 18,
        }),
      ],
      {
        activeSources: [
          {
            title: "网易新闻健康医美频道",
            url: "https://www.163.com/",
            articleIds: ["article-news"],
          },
          {
            title: "网易餐饮频道",
            url: "https://www.163.com/",
            articleIds: ["article-news"],
          },
        ],
        preferenceChannels: [],
      },
    );
    const ids = result.candidates.map((c) => c.resourceId);
    expect(ids).not.toContain(61);
    expect(ids).toContain(62);
  });

  it("structured category corroboration catches synonym verticals the name heuristic misses (2026-08-28 真实池)", () => {
    // 真实池形态：网易美食（GEO）是自媒体，industry_category=13（美食）。
    // 名称佐证接不住「餐饮频道→网易美食」（餐饮/美食零字重叠），结构化
    // 类目（餐饮→美食/食品 别名）能接住；房产资源两路佐证皆无 → 拦截。
    const result = candidateResult(
      [
        resource("we-media", {
          id: 71,
          name: "网易美食（GEO）",
          status: 2,
          price: "30",
          entrance_link: "http://www.163.com/",
          industry_category: 13,
        }),
        resource("we-media", {
          id: 72,
          name: "网易房产（GEO）",
          status: 2,
          price: "30",
          entrance_link: "http://www.163.com/",
          industry_category: 19,
        }),
      ],
      {
        industry: "餐饮",
        activeSources: [
          {
            title: "网易餐饮频道",
            url: "http://www.163.com/",
            articleIds: ["article-news"],
          },
        ],
        preferenceChannels: [],
      },
    );
    const ids = result.candidates.map((c) => c.resourceId);
    expect(ids).toContain(71);
    expect(ids).not.toContain(72);
  });

  it("default pack keeps one representative; sub-channel family caps at 2 seats (Q13)", () => {
    // 10 个不同核心名挂（可发GEO）/（带图）后缀 → 两者都成规格词（阈值 ≥10 核心）。
    const filler = Array.from({ length: 10 }, (_, i) => [
      resource("media", {
        id: 900 + i,
        name: `站点${i}（可发GEO）`,
        status: 2,
        price: "10",
        entrance_link: `https://filler${i}.example.com/`,
      }),
      resource("media", {
        id: 950 + i,
        name: `渠道${i}（带图）`,
        status: 2,
        price: "10",
        entrance_link: `https://jfiller${i}.example.com/`,
      }),
    ]).flat();
    const liejuVariants = [
      resource("media", {
        id: 1,
        name: "列举网（可发GEO）",
        status: 2,
        price: "9",
        entrance_link: "https://www.lieju.net/a",
      }),
      resource("media", {
        id: 2,
        name: "列举网",
        status: 2,
        price: "4",
        entrance_link: "https://www.lieju.net/b",
      }),
      resource("media", {
        id: 3,
        name: "列举网（带图）",
        status: 2,
        price: "4",
        entrance_link: "https://www.lieju.net/c",
      }),
    ];
    const subChannels = ["江南时报", "江苏经济报", "电力税务"].map(
      (suffix, i) =>
        resource("media", {
          id: 50 + i,
          name: `学习强国（${suffix}）`,
          status: 2,
          price: "40",
          entrance_link: `https://xuexi${i}.example.com/`,
        }),
    );
    const result = candidateResult(
      [...filler, ...liejuVariants, ...subChannels],
      {
        activeSources: [
          {
            title: "学习强国",
            url: "https://xuexiqiangguo.example.org/",
            articleIds: ["article-news"],
          },
        ],
        // 偏好核心名匹配点亮列举网全部变体（同证据权重）。
        preferenceChannels: [{ name: "列举网（AI包收录）", exact: true }],
      },
    );
    const lieju = result.candidates.filter((c) =>
      c.name.startsWith("列举网"),
    );
    // 同（家族,默认包）只出 1 个代表：三个变体塌缩为 1。
    expect(lieju.length).toBe(1);
    const xuexi = result.candidates.filter((c) =>
      c.name.startsWith("学习强国"),
    );
    // 子频道各成一包，但家族 ≤2 席。
    expect(xuexi.length).toBe(2);
  });

  it("junk resale listing never represents its pack even when cheaper (Q11)", () => {
    const filler = Array.from({ length: 10 }, (_, i) =>
      resource("media", {
        id: 800 + i,
        name: `渠道${i}（随机）`,
        status: 2,
        price: "10",
        entrance_link: `https://jfiller${i}.example.com/`,
      }),
    );
    const result = candidateResult(
      [
        ...filler,
        resource("media", {
          id: 61,
          name: "知乎好物（随机）",
          status: 2,
          price: "3",
          entrance_link: "https://zh.example.com/1",
        }),
        resource("media", {
          id: 62,
          name: "知乎好物",
          status: 2,
          price: "10",
          entrance_link: "https://zh.example.com/2",
        }),
      ],
      { preferenceChannels: [{ name: "知乎好物", exact: true }] },
    );
    const hits = result.candidates.filter((c) => c.name.includes("知乎好物"));
    expect(hits.length).toBe(1);
    // 便宜 ¥3 的随机号不作代表，¥10 的正常号代表默认包。
    expect(hits[0]!.name).toBe("知乎好物");
  });

  it("preferenceMatchedChannels lists one representative row per entry pre-quota (Q12)", () => {
    const result = candidateResult(
      [
        resource("media", {
          id: 71,
          name: "列举网（GEO可发）",
          status: 2,
          price: "9",
          entrance_link: "https://www.lieju.net/a",
          geo_platforms: [{ label: "豆包" }],
        }),
        resource("media", {
          id: 72,
          name: "列举网",
          status: 2,
          price: "4",
          entrance_link: "https://www.lieju.net/b",
        }),
        resource("media", {
          id: 73,
          name: "安庆都市网（可发GEO）",
          status: 2,
          price: "6",
          entrance_link: "https://aqdushi.example.com/",
        }),
      ],
      {
        preferenceChannels: [
          { name: "列举网（AI包收录）", exact: true },
          { name: "安庆新闻网", exact: true },
        ],
      },
    );
    const rows = result.preferenceMatchedChannels;
    expect(rows).toHaveLength(2);
    const lieju = rows.find((r) => r.entryName === "列举网（AI包收录）")!;
    expect(lieju.matched).toBe(true);
    expect(lieju.variantCount).toBe(2);
    // 代表 = geo_platforms 命中多者（（GEO可发）带豆包标记）。
    expect(lieju.representativeName).toBe("列举网（GEO可发）");
    expect(lieju.recommended).toBe(true);
    const anqing = rows.find((r) => r.entryName === "安庆新闻网")!;
    expect(anqing.matched).toBe(false);
    expect(anqing.representativeName).toBeNull();
  });

  it("passive aligned channels fold same-family variants with price range (Q13/S1)", () => {
    const result = candidateResult(
      [
        resource("media", {
          id: 81,
          name: "八方资源网（B2B）",
          status: 2,
          price: "6",
          entrance_link: "https://mip.b2b168.com/wvs1.html",
        }),
        resource("media", {
          id: 82,
          name: "八方资源网",
          status: 2,
          price: "4",
          entrance_link: "https://www.b2b168.com/",
        }),
      ],
      {
        questionSources: [
          {
            id: "source-b2b",
            questionId: "q-1",
            question: "新能源车售后服务怎么选？",
            title: "餐饮承包公司推荐_八方资源网",
            url: "https://mip.b2b168.com/wvs1.html",
            articleIds: ["article-news"],
          },
        ],
        activeSources: [],
        preferenceChannels: [],
      },
    );
    const aligned = result.passiveAlignedChannels.filter((c) =>
      c.name.includes("八方资源网"),
    );
    expect(aligned).toHaveLength(1);
    expect(aligned[0]!.variantCount).toBe(2);
    expect(aligned[0]!.priceMinCny).toBe(4);
    expect(aligned[0]!.priceMaxCny).toBe(6);
    expect(result.summary.alignedFamilies).toBeGreaterThanOrEqual(1);
  });

  it("passive coverage breaks weight ties before name order (Q5)", () => {
    const twoQuestionSources: DistributionQuestionSource[] = [
      {
        id: "source-a1",
        questionId: "q-1",
        question: "问题一",
        title: "站点甲引用",
        url: "https://site-canyinj-guard.com/1",
        articleIds: ["article-news"],
      },
      {
        id: "source-a2",
        questionId: "q-2",
        question: "问题二",
        title: "站点甲引用二",
        url: "https://site-canyinj-guard.com/2",
        articleIds: ["article-news"],
      },
      {
        id: "source-b1",
        questionId: "q-1",
        question: "问题一",
        title: "站点乙引用",
        url: "https://site-aggre-news.com/1",
        articleIds: ["article-news"],
      },
    ];
    const geoResource = (id: number, name: string, link: string) =>
      resource("media", {
        id,
        name,
        status: 2,
        price: "10",
        entrance_link: link,
        geo_platforms: [{ label: "豆包" }],
      });
    const result = candidateResult(
      [
        // 名字拼音序在前的站点乙只覆盖 1 问；覆盖 2 问的站点甲应排前。
        geoResource(91, "站点乙", "https://site-aggre-news.com/"),
        geoResource(92, "站点甲", "https://site-canyinj-guard.com/"),
      ],
      {
        questionSources: twoQuestionSources,
        activeSources: [],
        preferenceChannels: [],
        // 恒等洗牌：两个 t2 GEO 候选保留池序（覆盖度排序），断言可复现。
        random: () => 0.99,
      },
    );
    expect(result.candidates[0]!.resourceId).toBe(92);
    expect(result.candidates[0]!.name).toContain("站点甲");
  });
});

describe("URL field matching via case_link (2026-08-28 用户裁决)", () => {
  it("passive citations align through case_link when entrance is empty (八方资源网型)", () => {
    const result = candidateResult(
      [
        resource("media", {
          id: 91,
          name: "八方资源网",
          status: 2,
          price: "6",
          entrance_link: null,
          case_link: "https://mip.b2b168.com/wvs1.html",
        }),
      ],
      {
        questionSources: [
          {
            id: "source-b2b",
            questionId: "q-1",
            question: "新能源车售后服务怎么选？",
            title: "餐饮承包公司推荐",
            url: "https://mip.b2b168.com/wvs1.html",
            articleIds: ["article-news"],
          },
        ],
        activeSources: [],
        preferenceChannels: [],
      },
    );
    expect(result.candidates[0]!.pathHits).toContain("passive");
    // 池反查也点亮：引用域名组名可用八方资源网而非裸域名。
    expect(result.citationSiteNames["b2b168.com"]).toBe("八方资源网");
    expect(result.summary.citationDomainPoolHits).toBe(1);
  });

  it("active sources domain-hit through case_link (亿欧网快讯型)", () => {
    const result = candidateResult(
      [
        resource("media", {
          id: 92,
          name: "亿欧网快讯（官方）",
          status: 2,
          price: "60",
          entrance_link: null,
          case_link: "https://www.iyiou.com/news/1",
        }),
      ],
      {
        activeSources: [
          {
            title: "亿欧餐饮频道",
            url: "https://www.iyiou.com/catering/",
            articleIds: ["article-news"],
          },
        ],
        preferenceChannels: [],
      },
    );
    expect(result.candidates[0]!.pathHits).toContain("active");
  });
});

describe("URL domain ambiguity guard (2026-08-28 用户裁决：URL 匹配防误判)", () => {
  it("unique domains hit directly; ambiguous aggregator domains require name corroboration", () => {
    const result = candidateResult(
      [
        // 聚合域 example-aggre.com 上挂两家互不相干机构：名称佐证通过的命中，
        // 无佐证的拦截（ppwll.cn 式跨机构误判防护）。
        resource("media", {
          id: 101,
          name: "每日快报",
          status: 2,
          price: "10",
          entrance_link: "https://www.example-aggre.com/meiri/",
        }),
        resource("media", {
          id: 102,
          name: "邯郸在线",
          status: 2,
          price: "10",
          entrance_link: "https://www.example-aggre.com/handan/",
        }),
        // 唯一域（同核心名变体，包含连通）：域名直接命中，无需名称佐证。
        resource("media", {
          id: 103,
          name: "餐饮界首发",
          status: 2,
          price: "12",
          entrance_link: "https://www.canyinj-guard.com/first",
        }),
        resource("media", {
          id: 104,
          name: "餐饮界",
          status: 2,
          price: "10",
          entrance_link: "https://www.canyinj-guard.com/",
        }),
      ],
      {
        activeSources: [
          { title: "每日快报", url: "https://www.example-aggre.com/", articleIds: ["article-news"] },
          { title: "餐饮前沿网", url: "https://www.canyinj-guard.com/", articleIds: ["article-news"] },
        ],
        preferenceChannels: [],
      },
    );
    const ids = result.candidates.map((c) => c.resourceId);
    expect(ids).toContain(101);
    expect(ids).not.toContain(102);
    // Q15 主干族：餐饮界/餐饮界首发 同族同默认包塌缩为 1，基础名代表。
    expect(ids).toContain(104);
    expect(ids).not.toContain(103);
  });

  it("buildUnambiguousDomains merges containment-connected cores", () => {
    const unique = buildUnambiguousDomains([
      { name: "餐饮界", entranceLink: "https://canyinj-guard.com/", caseLink: null },
      { name: "餐饮界首发", entranceLink: null, caseLink: "https://canyinj-guard.com/x" },
      { name: "邯郸在线", entranceLink: "https://aggre-news.com/", caseLink: null },
      { name: "每日快报", entranceLink: "https://aggre-news.com/y", caseLink: null },
    ]);
    expect(unique.has("canyinj-guard.com")).toBe(true);
    expect(unique.has("aggre-news.com")).toBe(false);
  });
});

describe("trunk family + official-site-first + dining category fix (2026-08-28 Q15/Q16)", () => {
  it("merges geo/city/prefixed trunks into one family (列举网系 7 席 → ≤2) with official site as rep", () => {
    const result = candidateResult(
      [
        resource("media", { id: 1, name: "列举网", status: 2, price: "4", entrance_link: "https://www.lieju.net/a" }),
        resource("media", { id: 2, name: "列举网GEO（全国可发）", status: 2, price: "3", entrance_link: "https://www.lieju.net/b" }),
        resource("media", { id: 3, name: "北京列举网", status: 2, price: "3", entrance_link: "https://www.lieju.net/c" }),
        resource("media", { id: 4, name: "列举网（今日头条）", status: 2, price: "15", entrance_link: "https://www.toutiao.com/item/1/" }),
      ],
      { preferenceChannels: [{ name: "列举网", exact: true }], activeSources: [] },
    );
    const lieju = result.candidates.filter((c) => /列举/.test(c.name));
    // 主干包含连通：列举网/列举网GEO/北京列举网/列举网（今日头条）同族。
    expect(lieju.length).toBeLessThanOrEqual(2);
    expect(lieju.map((c) => c.name)).toContain("列举网");
    // 官网优先：无平台域的列举网（lieju.net）作代表，头条版不代表。
    expect(result.preferenceMatchedChannels.find((r) => r.entryName === "列举网")?.representativeName).toBe("列举网");
  });

  it("dining industry maps to media category 18 (食品餐饮) so real verticals get fallback", () => {
    const result = candidateResult(
      [
        // 码 18：转售商实际使用的「食品餐饮」类目（餐饮界/中华餐饮网型）。
        resource("media", { id: 71, name: "中华餐饮网", status: 2, price: "20", entrance_link: "https://canyin.example.org/", channel_type: 18 }),
        // 码 2：生活消费综合站，餐饮行业不应命中。
        resource("media", { id: 72, name: "生活消费观察", status: 2, price: "10", entrance_link: "https://life.example.com/", channel_type: 2 }),
      ],
      {
        industry: "餐饮管理",
        targetAudience: "餐饮创业者",
        questionSources: [],
        activeSources: [],
        preferenceChannels: [],
      },
    );
    const ids = result.candidates.map((c) => c.resourceId);
    expect(ids).toContain(71);
    expect(ids).not.toContain(72);
    expect(
      result.candidates.find((c) => c.resourceId === 71)!.pathHits,
    ).toContain("fallback");
  });
});

describe("vertical quota + new weights (2026-08-28 用户裁决)", () => {
  it("pure weighted merge: recalled verticals compete at 0.3, passive-hit generals at 0.4 outrank them", () => {
    // 28 个泛站：各拿 1 条被动引用（0.4）；8 个餐饮类目（码 18）垂媒：仅保底 0.3。
    // 三轮裁决：合并层纯加权排序，无保底占位——泛站 0.4 全部排在前，垂媒以
    // 0.3 按名序补足前 30（8 席全量召回，进入推荐的只有 2 席）。
    const general = Array.from({ length: 28 }, (_, i) =>
      resource("media", {
        id: 300 + i,
        name: `泛站观察${i}`,
        status: 2,
        price: "10",
        entrance_link: `https://general-site-${i}.com/`,
      }),
    );
    const vertical = Array.from({ length: 8 }, (_, i) =>
      resource("media", {
        id: 400 + i,
        name: `餐饮垂媒站${i}`,
        status: 2,
        price: "10",
        entrance_link: `https://vertical-site-${i}.org/`,
        channel_type: 18,
      }),
    );
    const citations = Array.from({ length: 28 }, (_, i) => ({
      id: `src-${i}`,
      questionId: `q-${i}`,
      question: `问题${i}`,
      title: `泛站引用${i}`,
      url: `https://general-site-${i}.com/article`,
      articleIds: ["article-news"],
    }));
    const result = candidateResult([...general, ...vertical], {
      industry: "餐饮管理",
      targetAudience: "餐饮创业者",
      questionSources: citations,
      activeSources: [],
      preferenceChannels: [],
    });
    const verticalIn = result.candidates.filter((c) =>
      c.name.includes("餐饮垂媒站"),
    );
    const generalIn = result.candidates.filter((c) =>
      c.name.includes("泛站观察"),
    );
    // 8 个垂媒全部被保底路召回（召回口径），但推荐集按权重取前 30 只含 2 席。
    expect(result.summary.alignedByPath.fallback).toBe(8);
    expect(verticalIn.length).toBe(2);
    // 无自媒体候选 → 媒体配额溢流为 20+10=30：28 泛站（0.4）+ 2 垂媒（0.3）。
    expect(generalIn.length).toBe(28);
    expect(result.candidates.length).toBe(30);
    expect(result.candidates[0]!.recommendationWeight).toBeCloseTo(0.4, 10);
    expect(result.candidates[29]!.recommendationWeight).toBeCloseTo(0.3, 10);
  });

  it("applies the recalibrated weights passive .4 / active .2 / fallback .3 / preference .1", () => {
    expect(GEO_PORT_CONTRACT.channelRecall.paths.active.weight).toBe(0.2);
    expect(GEO_PORT_CONTRACT.channelRecall.paths.fallback.weight).toBe(0.3);
    expect(GEO_PORT_CONTRACT.channelRecall.paths.preference.weight).toBe(0.1);
    expect(GEO_PORT_CONTRACT.channelRecall.paths.passive.weight).toBe(0.4);
    // passive+fallback+preference = 0.8（旧 0.7）。
    const result = candidateResult(
      [
        resource("media", {
          id: 501,
          name: "列举网",
          status: 2,
          price: "4",
          entrance_link: "https://www.lieju.net/a",
          channel_type: 18,
        }),
      ],
      {
        industry: "餐饮管理",
        targetAudience: "餐饮创业者",
        questionSources: [
          {
            id: "s1",
            questionId: "q-1",
            question: "问题",
            title: "列举网引用",
            url: "https://www.lieju.net/a",
            articleIds: ["article-news"],
          },
        ],
        activeSources: [],
        preferenceChannels: [{ name: "列举网", exact: true }],
      },
    );
    expect(result.candidates[0]!.recommendationWeight).toBeCloseTo(0.8, 10);
  });
});

describe("fallback recall sampling (2026-08-28 三轮用户裁决：召回层随机，合并层纯加权排序)", () => {
  it("randomly recalls 26 of 30 verticals — seeded picks differ, same seed reproduces, unsampled are not recalled", () => {
    const verticals = Array.from({ length: 30 }, (_, i) =>
      resource("media", {
        id: 600 + i,
        name: `垂媒${String(i).padStart(2, "0")}`,
        status: 2,
        price: "10",
        entrance_link: `https://vm-${i}.com/`,
        channel_type: 18,
      }),
    );
    const overrides = {
      industry: "餐饮管理",
      targetAudience: "餐饮创业者",
      questionSources: [],
      activeSources: [],
      preferenceChannels: [],
    };
    // 种子 0.99：j 恒等于 i，洗牌为恒等 → 按池序召回前 26（垂媒00-25）。
    const identity = candidateResult(verticals, {
      ...overrides,
      random: () => 0.99,
    });
    // 种子 0：j 恒为 0，洗牌退化为左旋一位 → 召回到 垂媒26、挤掉 垂媒00。
    const rotated = candidateResult(verticals, {
      ...overrides,
      random: () => 0,
    });
    const identityNames = identity.candidates.map((c) => c.name);
    const rotatedNames = rotated.candidates.map((c) => c.name);
    // 未抽中即未被保底路召回：候选集只有 26 个，垂媒26-29 完全不在列表。
    expect(identity.candidates).toHaveLength(26);
    expect(identityNames[0]).toBe("垂媒00");
    expect(identityNames).toContain("垂媒25");
    expect(identityNames).not.toContain("垂媒26");
    expect(rotated.candidates).toHaveLength(26);
    expect(rotatedNames[0]).toBe("垂媒01");
    expect(rotatedNames).toContain("垂媒26");
    expect(rotatedNames).not.toContain("垂媒00");
    // 同种子可复现（随机采样不破坏确定性调试）。
    const rotatedAgain = candidateResult(verticals, {
      ...overrides,
      random: () => 0,
    });
    expect(rotatedAgain.candidates.map((c) => c.name)).toEqual(rotatedNames);
  });

  it("recalls GEO fill up to the cap; pure-fallback ranks below passive-hit generals by weight", () => {
    const verticals = ["垂媒甲", "垂媒乙"].map((name, i) =>
      resource("media", {
        id: 610 + i,
        name,
        status: 2,
        price: "10",
        entrance_link: `https://v-${i}.com/`,
        channel_type: 18,
      }),
    );
    const geoOnly = Array.from({ length: 8 }, (_, i) =>
      resource("media", {
        id: 620 + i,
        name: `GEO站${i}`,
        status: 2,
        price: "10",
        entrance_link: `https://g-${i}.com/`,
        geo_platforms: [{ label: "豆包" }],
      }),
    );
    const generals = Array.from({ length: 10 }, (_, i) =>
      resource("media", {
        id: 630 + i,
        name: `泛站${i}`,
        status: 2,
        price: "10",
        entrance_link: `https://gen-${i}.com/`,
      }),
    );
    const citations = Array.from({ length: 10 }, (_, i) => ({
      id: `s-${i}`,
      questionId: `q-${i}`,
      question: `问题${i}`,
      title: `泛站引用${i}`,
      url: `https://gen-${i}.com/article`,
      articleIds: ["article-news"],
    }));
    const result = candidateResult([...verticals, ...geoOnly, ...generals], {
      industry: "餐饮管理",
      targetAudience: "餐饮创业者",
      questionSources: citations,
      activeSources: [],
      preferenceChannels: [],
    });
    const names = result.candidates.map((c) => c.name);
    // 保底召回 = 垂类(2) + GEO 补足(8)，共 10 路 fallback 证据；
    // 合并层纯加权：泛站被动 0.4 全部排前，保底 0.3 组内按分档 垂类(t1) > GEO(t2)。
    expect(result.summary.alignedByPath.fallback).toBe(10);
    expect(result.candidates).toHaveLength(20);
    expect(names.slice(0, 10)).toEqual(
      expect.arrayContaining(Array.from({ length: 10 }, (_, i) => `泛站${i}`)),
    );
    expect(names.indexOf("泛站0")).toBeLessThan(10);
    expect(names.indexOf("垂媒甲")).toBe(10);
    expect(names.indexOf("垂媒乙")).toBe(11);
    expect(names.indexOf("GEO站0")).toBe(12);
  });
});

// 分发计划版本戳契约（票 #41，ADR-0012）：与裁判 JSON 严格相等；
// Rust 侧 distribution_plans.rs 的同文件测试 include_str! 同一裁判。
// 这是全仓唯一兼任兼容闸的版本戳——Rust prepare 拒绝 policyVersion
// 不符的 provider 快照，两侧漂移直接在 pin 测试红。
describe("distributionPlan 契约（票 #41，ADR-0012）", () => {
  it("DISTRIBUTION_PLAN_POLICY_VERSION 与 distributionPlanContract.json 裁判严格相等", () => {
    expect(distributionPlanContract.policyVersion).toBe(
      DISTRIBUTION_PLAN_POLICY_VERSION,
    );
  });
});
