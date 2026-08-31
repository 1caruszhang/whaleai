import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DistributionPlanProjection } from "../../../shared/geo/distributionPlan";
import XiaojingDistributionPlanPanel from "./XiaojingDistributionPlanPanel";

const mocks = vi.hoisted(() => ({
  sessionId: "session-12",
  apiPost: vi.fn(),
  latest: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/distributionPlanClient", () => ({
  loadLatestDistributionPlan: mocks.latest,
}));

function projection(
  overrides: Partial<DistributionPlanProjection> = {},
): DistributionPlanProjection {
  const snapshot = {
    resourceId: 8,
    kind: "media" as const,
    name: "汽车产业观察",
    status: 2,
    price: "",
    publishedRate: 0,
    entranceLink: "https://source.example",
    remark: "汽车",
    channelType: 6,
    industryCategory: null,
    area: null,
    canWeekend: true,
    publishSpeed: null,
    publishedAverageMinutes: null,
    platform: null,
    geoPlatforms: [],
  };
  return {
    id: "plan-exact",
    operationId: "distribution-operation",
    workspaceId: "brand-12",
    createdBySessionId: "session-other",
    articleOperationId: "articles-12",
    policyVersion: "js-ai-dev-four-path-distribution-v1",
    status: "draft",
    revision: 2,
    industry: "汽车",
    targetAudience: "新能源车主",
    questionSources: [
      {
        id: "unit-1:citation:1",
        questionId: "q1",
        question: "汽车音响怎么选",
        title: "真实行业报告",
        url: "https://source.example/report",
        articleIds: ["article-1"],
      },
    ],
    preferredResourceIds: [],
    mappingMode: "one-to-one",
    ratio: { media: 1, weMedia: 1 },
    articles: [
      {
        id: "article-1",
        operationId: "articles-12",
        approvedRevision: 3,
        title: "新能源车主选音响",
        topic: "汽车音响",
        contentType: "guide",
      },
    ],
    providerState: "available",
    providerSnapshot: {
      slot: "distribution",
      provider: "超级媒介",
      endpointFamily: "chaojimeijie-resource-api",
      policyVersion: "js-ai-dev-four-path-distribution-v1",
      fetchedAt: "2026-08-15T00:00:00Z",
      mediaTotal: 1,
      weMediaTotal: 0,
    },
    resourceSnapshot: [snapshot],
    candidates: [
      {
        resourceId: 8,
        kind: "media",
        name: "汽车产业观察",
        estimatedPriceCny: null,
        publishedRate: 0,
        availability: {
          state: "available",
          providerStatus: 2,
          basis: "supermedia-approved-resource",
        },
        recommendationWeight: 0.85,
        hitCount: 3,
        pathHits: ["passive", "active", "fallback"],
        evidence: [
          {
            path: "passive",
            weight: 0.4,
            label: "真实问题来源域名命中",
            reference: "汽车音响怎么选 · 真实行业报告",
            url: "https://source.example/report",
            articleIds: ["article-1"],
          },
        ],
        fitReasons: ["行业分类匹配汽车", "内容类型 guide 可发布"],
        risks: ["报价未提供"],
        uncertainties: ["价格未知，不能进入已确认分发计划"],
        resourceSnapshot: snapshot,
      },
    ],
    selectedResourceIds: [8],
    assignments: [
      {
        articleId: "article-1",
        resourceId: 8,
        reason: "source-evidence",
        scheduledAt: "2026-08-20T02:00:00Z",
      },
    ],
    perArticleMaxPoints: 3_200,
    totalMaxPoints: 16_000,
    budgetCny: 500,
    publishStartAt: "2026-08-20T02:00:00Z",
    discoverySummary: {
      inputResources: 1,
      approvedResources: 1,
      filteredUnavailable: 0,
      filteredUnknownPrice: 0,
      filteredOverPerArticleLimit: 0,
      alignedResources: 1,
      recommendedResources: 1,
      alignedByPath: { passive: 0, active: 0, fallback: 1, preference: 0 },
      citationDomains: 0,
      citationDomainPoolHits: 0,
    },
    blockingIssues: ["selected-channel-price-unknown"],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    confirmedAt: null,
    ...overrides,
  };
}

// 票 29：面板退化为纯只读投影——发现/勾选/映射编辑/确认只有聊天卡片
// 一套实现，组件测试只断言只读渲染行为。
describe("XiaojingDistributionPlanPanel read-only projection", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.sessionId = "session-12";
    mocks.latest.mockReset().mockResolvedValue(null);
  });

  it("shows confirmed snapshot evidence and recall-path hits only after confirmation", async () => {
    mocks.latest.mockResolvedValue(
      projection({
        status: "confirmed",
        confirmedAt: "2026-08-15T00:02:00Z",
        blockingIssues: [],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });

    expect(
      await within(panel).findByText(/汽车产业观察（已选）/),
    ).toBeInTheDocument();
    // 渠道推荐行只剩四要素：类型标签+渠道名、所需点数、召回路命中、适配。
    // （四路复盘中同名渠道 chip 也会出现，取 all 断言。）
    expect(
      within(panel).getAllByText(/媒体 · 汽车产业观察/).length,
    ).toBeGreaterThan(0);
    expect(within(panel).getByText(/所需点数：点数待定/)).toBeInTheDocument();
    expect(within(panel).getByText(/召回路命中：/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/被动召回（真实问题来源域名命中）/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/适配：行业分类匹配汽车/),
    ).toBeInTheDocument();
    // ¥ 报价、Provider 状态、权重与发布率等其余字段不再展示。
    expect(panel.textContent ?? "").not.toContain("¥");
    expect(within(panel).queryByText(/报价/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/Provider 状态/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/权重/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/成功率/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/发布率/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/风险：/)).not.toBeInTheDocument();
    expect(
      within(panel).queryByText(/价格未知，不能进入已确认分发计划/),
    ).not.toBeInTheDocument();
    // 预算点数化：¥500 → 8000 点。
    expect(within(panel).getByText(/预算：8000 点/)).toBeInTheDocument();
    expect(within(panel).queryByText(/预算（元）/)).not.toBeInTheDocument();
    expect(within(panel).getByText(/新能源车主选音响/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/任何付费、下单或发布仍需后续独立确认/),
    ).toBeInTheDocument();
  });

  it("shows computed points for priced candidates and hides the fit row when empty", async () => {
    mocks.latest.mockResolvedValue(
      projection({
        status: "confirmed",
        confirmedAt: "2026-08-15T00:02:00Z",
        blockingIssues: [],
        candidates: [
          {
            ...projection().candidates[0]!,
            // ¥88.00 → 1408 点（ceil(8800 × 4 / 25)，与 Rust/网关同式）。
            estimatedPriceCny: 88,
            fitReasons: [],
          },
        ],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });

    expect(
      await within(panel).findByText(/所需点数：1408 点/),
    ).toBeInTheDocument();
    expect(panel.textContent ?? "").not.toContain("¥");
    // fitReasons 为空时整行「适配」不出现。
    expect(within(panel).queryByText(/适配：/)).not.toBeInTheDocument();
  });

  it("exposes no discovery, selection, mapping or confirm controls", async () => {
    mocks.latest.mockResolvedValue(
      projection({
        status: "confirmed",
        confirmedAt: "2026-08-15T00:02:00Z",
        blockingIssues: [],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });
    await within(panel).findByText(/汽车产业观察（已选）/);

    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText("目标人群")).not.toBeInTheDocument();
    expect(
      within(panel).queryByLabelText("编辑预算（元）"),
    ).not.toBeInTheDocument();
  });

  it("renders confirmed plans as immutable and directs pending ones to the chat card", async () => {
    mocks.latest.mockResolvedValue(projection());
    const { unmount } = render(
      <XiaojingDistributionPlanPanel workspaceId="brand-12" />,
    );
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });
    // 未确认计划不倾倒候选/映射/预算，只保留指向聊天确认卡片的引导。
    expect(
      await within(panel).findByText(/分发计划尚未确认/),
    ).toBeInTheDocument();
    expect(
      within(panel).queryByText(/汽车产业观察（已选）/),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByText(/新能源车主选音响/),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByText(/确认已阻断/)).not.toBeInTheDocument();
    unmount();

    mocks.latest.mockResolvedValue(
      projection({
        status: "confirmed",
        confirmedAt: "2026-08-15T00:02:00Z",
        blockingIssues: [],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const confirmedPanel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });
    expect(
      await within(confirmedPanel).findByText(/计划已确认；尚未扣费/),
    ).toBeInTheDocument();
  });

  it("does not invent candidates when the provider is unavailable", async () => {
    mocks.latest.mockResolvedValue(
      projection({
        status: "confirmed",
        confirmedAt: "2026-08-15T00:02:00Z",
        providerState: "unavailable",
        resourceSnapshot: [],
        candidates: [],
        selectedResourceIds: [],
        assignments: [
          {
            articleId: "article-1",
            resourceId: null,
            reason: "unassigned",
            scheduledAt: "2026-08-20T02:00:00Z",
          },
        ],
        blockingIssues: [],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });
    expect(
      await within(panel).findByText(/没有真实可用候选/),
    ).toBeInTheDocument();
    expect(within(panel).getAllByText(/未分配/).length).toBeGreaterThan(0);
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("reloads the projection when the session tool signal advances", async () => {
    mocks.latest.mockResolvedValue(projection());
    const { rerender } = render(
      <XiaojingDistributionPlanPanel workspaceId="brand-12" refreshKey={0} />,
    );
    await screen.findByRole("region", { name: "渠道发现与分发计划" });
    expect(mocks.latest).toHaveBeenCalledTimes(1);

    rerender(
      <XiaojingDistributionPlanPanel workspaceId="brand-12" refreshKey={1} />,
    );
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  });

  it("shows per-path recall sources with matched highlighting before confirmation", async () => {
    mocks.latest.mockResolvedValue(
      projection({
        status: "draft",
        questionSources: [
          {
            id: "probe:q1:1",
            questionId: "q1",
            question: "汽车音响怎么选",
            title: "真实行业报告",
            url: "https://source.example/report",
            articleIds: ["article-1"],
            siteName: "汽车产业观察网",
          },
          {
            id: "probe:q2:1",
            questionId: "q2",
            question: "新能源保养去哪",
            title: "未命中的引用",
            url: "https://other.example/post",
            articleIds: [],
          },
        ],
        activeRecallSources: [
          {
            title: "汽车垂直资讯站",
            url: "https://auto.example.org",
            articleIds: ["article-1"],
            reason: "汽车行业垂直媒体，覆盖售后与门店话题",
          },
          {
            title: "未命中的推荐渠道",
            url: "https://news.example.com",
            articleIds: [],
          },
        ],
        preferenceChannelNames: ["汽车产业观察", "未命中偏好号"],
        candidates: [
          {
            ...projection().candidates[0]!,
            evidence: [
              {
                path: "passive",
                weight: 0.4,
                label: "真实问题来源「真实行业报告」与资源池渠道对齐",
                reference: "q1",
                url: "https://source.example/report",
                articleIds: ["article-1"],
              },
              {
                path: "active",
                weight: 0.3,
                label: "全局召回推荐渠道「汽车垂直资讯站」与本资源对齐",
                reference: "recall:汽车垂直资讯站",
                url: "https://auto.example.org",
                articleIds: ["article-1"],
              },
              {
                path: "fallback",
                weight: 0.15,
                label: "超级媒介结构化类目匹配行业「汽车」",
                reference: "industry:汽车",
                url: "https://source.example",
                articleIds: [],
              },
              {
                path: "preference",
                weight: 0.15,
                label: "偏好名单命中「汽车产业观察」",
                reference: "preference:汽车产业观察",
                url: "https://source.example",
                articleIds: [],
              },
            ],
          },
        ],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });

    expect(await within(panel).findByText("四路召回结果")).toBeInTheDocument();
    // 三分口径（2026-08-27 二轮裁决）：每路都是
    // 「来源 N · 对齐渠道 A · 进入推荐 M」，不再把对齐与推荐压成一个数。
    expect(
      within(panel).getAllByText(/来源 \d+ · 对齐渠道 \d+ · 进入推荐 \d+/)
        .length,
    ).toBe(4);
    // 被动路按渠道分组：组名优先用豆包 site_name（有站点名的组不再显示
    // 裸域名），组头带 N 条引用 · M 个问题，组内引用是 {问题，标题（url 链接）}。
    expect(within(panel).getAllByText(/✓ 汽车产业观察网/).length).toBe(1);
    expect(within(panel).queryAllByText(/✓ source\.example/).length).toBe(0);
    expect(within(panel).getAllByText(/1 条引用 · 覆盖 1 个问题/).length).toBe(
      2,
    );
    expect(within(panel).getByText(/问题：汽车音响怎么选/)).toBeInTheDocument();
    const cited = within(panel).getByRole("link", { name: "真实行业报告" });
    expect(cited).toHaveAttribute("href", "https://source.example/report");
    expect(within(panel).getByText(/未命中的引用/)).toBeInTheDocument();
    expect(within(panel).getByText(/问题：新能源保养去哪/)).toBeInTheDocument();
    // 其余路保持行/chip：主动来源命中 ✓ 并显示 LLM 推荐理由，未命中灰显。
    expect(within(panel).getByText(/✓ 汽车垂直资讯站/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/理由：汽车行业垂直媒体，覆盖售后与门店话题/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/未命中的推荐渠道/)).toBeInTheDocument();
    // 分组标签明确「召回来源」与「匹配/对齐渠道」两种形态：被动路是
    // 「对齐渠道（…✓=进入推荐…）」，其余三路是「匹配渠道（…）」。
    expect(
      within(panel).getAllByText(/召回来源/).length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      within(panel).getAllByText(/匹配渠道（/).length,
    ).toBeGreaterThanOrEqual(3);
    expect(within(panel).getAllByText(/对齐渠道（/).length).toBeGreaterThanOrEqual(
      1,
    );
    expect(within(panel).getAllByText(/媒体 · 汽车产业观察/).length).toBe(4);
    // fallback 是规则路：展示行业/人群输入，行业规则命中。
    expect(within(panel).getByText(/行业类目「汽车」/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/目标人群「新能源车主」/),
    ).toBeInTheDocument();
    // 偏好名单快照来源与未命中名单同屏（偏好 chip 精确名，避免与被动组名
    // 「汽车产业观察网」前缀混淆）。
    expect(
      within(panel).getByText((_, element) =>
        Boolean(
          element?.tagName === "SPAN" &&
            element.textContent === "✓ 汽车产业观察",
        ),
      ),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/未命中偏好号/)).toBeInTheDocument();
    // 未确认计划不出现候选点数行（复盘区不含价格）。
    expect(within(panel).queryByText(/所需点数/)).not.toBeInTheDocument();
  });

  it("folds same-family matched channels with ×N and renders preference matched rows (2026-08-28 Q12/Q13)", async () => {
    const base = projection().candidates[0]!;
    mocks.latest.mockResolvedValue(
      projection({
        status: "draft",
        preferenceChannelNames: ["列举网（AI包收录）", "安庆新闻网"],
        preferenceMatchedChannels: [
          {
            entryName: "列举网（AI包收录）",
            matched: true,
            representativeName: "列举网",
            representativePriceCny: 4,
            variantCount: 3,
            recommended: false,
          },
          {
            entryName: "安庆新闻网",
            matched: false,
            representativeName: null,
            representativePriceCny: null,
            variantCount: 0,
            recommended: false,
          },
        ],
        candidates: [
          // 同家族两个候选 → 匹配渠道 chip 折叠为一枚 ×2。
          {
            ...base,
            resourceId: 11,
            name: "汽车产业观察",
            variantFamily: "汽车产业观察|own",
          },
          {
            ...base,
            resourceId: 12,
            name: "汽车产业观察（可发GEO）",
            variantFamily: "汽车产业观察|own",
          },
        ],
        passiveAlignedChannels: [
          {
            resourceId: 11,
            kind: "media",
            name: "汽车产业观察",
            estimatedPriceCny: 88,
            citations: 2,
            questions: 2,
            accounts: [],
            recommended: true,
            variantCount: 2,
            priceMinCny: 4,
            priceMaxCny: 9,
          },
        ],
      }),
    );
    render(<XiaojingDistributionPlanPanel workspaceId="brand-12" />);
    const panel = await screen.findByRole("region", {
      name: "渠道发现与分发计划",
    });
    await within(panel).findByText("四路召回结果");
    // 同家族折叠：同路径的两枚候选合并为一枚 ×2 chip。
    const folded = within(panel).getAllByText(/汽车产业观察 ×2/);
    expect(folded.length).toBeGreaterThanOrEqual(1);
    // 被动对齐行：同名变体与点数区间随行（¥4-9 → 64-144 点，复盘区不出现 ¥）。
    expect(within(panel).getByText(/同名变体 ×2/)).toBeInTheDocument();
    expect(
      within(panel).getAllByText(/64-144 点/).length,
    ).toBeGreaterThanOrEqual(1);
    // 偏好命中清单（配额前）：命中行带代表名+点数（¥4 → 64 点；未进推荐 → 无 ✓），
    // 未命中行如实显示「价内资源池未见同名渠道」。
    expect(
      within(panel).getAllByText(/列举网（AI包收录）/).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      within(panel).getAllByText(/64 点/).length,
    ).toBeGreaterThanOrEqual(1);
    // 未命中行的说明在 chip title（价内资源池未见同名渠道），行本体灰显。
    expect(
      within(panel).getByTitle(/价内资源池未见同名渠道/),
    ).toBeInTheDocument();
    expect(
      within(panel).getAllByText(/安庆新闻网/).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
