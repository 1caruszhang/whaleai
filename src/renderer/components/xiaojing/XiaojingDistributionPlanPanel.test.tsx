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
        recommendationWeight: 0.7,
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
        uncertainties: [
          "价格未知，不能进入已确认分发计划",
        ],
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
    budgetCny: 500,
    publishStartAt: "2026-08-20T02:00:00Z",
    discoverySummary: {
      inputResources: 1,
      approvedResources: 1,
      filteredUnavailable: 0,
      filteredHighPrice: 0,
      alignedResources: 1,
      recommendedResources: 1,
    },
    blockingIssues: [
      "selected-channel-price-unknown",
    ],
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
    expect(within(panel).getByText(/媒体 · 汽车产业观察/)).toBeInTheDocument();
    expect(within(panel).getByText(/所需点数：点数待定/)).toBeInTheDocument();
    expect(within(panel).getByText(/召回路命中：/)).toBeInTheDocument();
    expect(within(panel).getByText(/被动召回（真实问题来源域名命中）/)).toBeInTheDocument();
    expect(within(panel).getByText(/适配：行业分类匹配汽车/)).toBeInTheDocument();
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
    expect(within(panel).queryByLabelText("编辑预算（元）")).not.toBeInTheDocument();
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
    expect(within(panel).queryByText(/汽车产业观察（已选）/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/新能源车主选音响/)).not.toBeInTheDocument();
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
});
