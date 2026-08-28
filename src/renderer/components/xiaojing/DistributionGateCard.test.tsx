import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DistributionChannelCandidate,
  DistributionPlanProjection,
  DistributionResourceSnapshot,
} from "../../../shared/geo/distributionPlan";
import DistributionGateCard from "./DistributionGateCard";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  confirm: vi.fn(),
  edit: vi.fn(),
  latest: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-1" }),
}));

vi.mock("@/api/distributionPlanClient", () => ({
  confirmDistributionPlan: mocks.confirm,
  editDistributionPlan: mocks.edit,
  loadLatestDistributionPlan: mocks.latest,
}));

function snapshot(
  overrides: Partial<DistributionResourceSnapshot> = {},
): DistributionResourceSnapshot {
  return {
    resourceId: 8,
    kind: "media",
    name: "汽车产业观察",
    status: 2,
    price: "88",
    publishedRate: 92,
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
    ...overrides,
  };
}

function candidate(
  overrides: Partial<DistributionChannelCandidate> = {},
): DistributionChannelCandidate {
  return {
    resourceId: 8,
    kind: "media",
    name: "汽车产业观察",
    estimatedPriceCny: 88,
    publishedRate: 92,
    availability: {
      state: "available",
      providerStatus: 2,
      basis: "supermedia-approved-resource",
    },
    recommendationWeight: 0.4,
    hitCount: 1,
    pathHits: ["passive"],
    evidence: [
      {
        path: "passive",
        weight: 0.4,
        label: "真实问题来源域名命中",
        reference: "q1",
        url: "https://source.example/report",
        articleIds: ["article-1"],
      },
    ],
    fitReasons: ["行业类目与「汽车」一致", "目标人群符合媒体渠道曝光点"],
    risks: [],
    uncertainties: [],
    resourceSnapshot: snapshot(),
    ...overrides,
  };
}

function plan(
  overrides: Partial<DistributionPlanProjection> = {},
): DistributionPlanProjection {
  return {
    id: "plan-1",
    operationId: "distribution-operation",
    workspaceId: "brand-1",
    createdBySessionId: "session-other",
    articleOperationId: "articles-1",
    policyVersion: "js-ai-dev-four-path-distribution-v1",
    status: "draft",
    revision: 1,
    industry: "汽车",
    targetAudience: "新能源车主",
    questionSources: [],
    preferredResourceIds: [],
    mappingMode: "one-to-one",
    ratio: { media: 1, weMedia: 1 },
    articles: [
      {
        id: "article-1",
        operationId: "articles-1",
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
      weMediaTotal: 1,
    },
    resourceSnapshot: [snapshot()],
    candidates: [candidate()],
    selectedResourceIds: [8],
    assignments: [],
    // 预算示例：¥1000 → 16000 点。
    perArticleMaxPoints: 3_200,
    totalMaxPoints: 16_000,
    budgetCny: 1000,
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
    blockingIssues: [],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    confirmedAt: null,
    ...overrides,
  };
}

describe("DistributionGateCard channel recommendation rows", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.confirm.mockReset();
    mocks.edit.mockReset();
    mocks.latest.mockReset().mockResolvedValue(plan());
  });

  it("shows only kind+name, points, recall paths and fit reasons per candidate", () => {
    render(<DistributionGateCard data={{ kind: "distribution-plan", plan: plan() }} />);
    const card = screen.getByRole("region", { name: "分发计划确认" });

    // 预算点数化：¥1000 → 16000 点。
    expect(within(card).getByText("预算 16000 点")).toBeInTheDocument();

    const rows = within(card).getAllByRole("article");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // 四要素：类型标签+渠道名、所需点数（¥88 → 1408 点）、召回路命中、适配。
    expect(within(row).getByText(/媒体 · 汽车产业观察/)).toBeInTheDocument();
    expect(within(row).getByText(/所需点数：1408 点/)).toBeInTheDocument();
    expect(
      within(row).getByText(/召回路命中：被动召回（真实问题来源域名命中）/),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(
        /适配：行业类目与「汽车」一致；目标人群符合媒体渠道曝光点/,
      ),
    ).toBeInTheDocument();

    // ¥ 价格、报价、发布率、资源号、权重等其余字段全部移除。
    expect(card.textContent ?? "").not.toContain("¥");
    expect(within(card).queryByText(/报价/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/发布率/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/权重/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/资源 #/)).not.toBeInTheDocument();
  });

  it("shows 点数待定 for unknown prices and hides the fit row when empty", () => {
    render(
      <DistributionGateCard
        data={{
          kind: "distribution-plan",
          plan: plan({
            candidates: [
              candidate({
                resourceId: 9,
                kind: "we-media",
                name: "车主生活圈",
                estimatedPriceCny: null,
                fitReasons: [],
                pathHits: ["fallback"],
                evidence: [
                  {
                    path: "fallback",
                    weight: 0.15,
                    label: "结构化类目匹配",
                    reference: "industry:汽车",
                    url: null,
                    articleIds: [],
                  },
                ],
              }),
            ],
            selectedResourceIds: [9],
          }),
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "分发计划确认" });
    const row = within(card).getAllByRole("article")[0]!;

    expect(within(row).getByText(/自媒体 · 车主生活圈/)).toBeInTheDocument();
    expect(within(row).getByText(/所需点数：点数待定/)).toBeInTheDocument();
    expect(
      within(row).getByText(/召回路命中：保底召回（结构化类目匹配）/),
    ).toBeInTheDocument();
    // fitReasons 为空时整行「适配」不出现。
    expect(within(row).queryByText(/适配：/)).not.toBeInTheDocument();
    expect(card.textContent ?? "").not.toContain("¥");
  });

  // 聊天转录脱敏（最小方案）：plan_distribution 工具结果只带数字段
  // （budgetPoints / estimatedPricePoints），卡片首渲染与确认回算都走点数。
  it("renders the slim tool-result shape (points only) and back-converts budget on confirm", async () => {
    const { budgetCny: _budgetCny, ...slimBase } = plan();
    const { estimatedPriceCny: _estimatedPriceCny, ...slimCandidate } = candidate();
    const slim = {
      ...slimBase,
      budgetPoints: 16000,
      candidates: [{ ...slimCandidate, estimatedPricePoints: 1408 }],
    };
    mocks.edit.mockResolvedValue({ revision: 2 });
    mocks.confirm.mockResolvedValue({});

    render(<DistributionGateCard data={{ kind: "distribution-plan", plan: slim }} />);
    const card = screen.getByRole("region", { name: "分发计划确认" });

    expect(within(card).getByText("预算 16000 点")).toBeInTheDocument();
    expect(within(card).getByText(/所需点数：1408 点/)).toBeInTheDocument();
    expect(card.textContent ?? "").not.toContain("¥");

    fireEvent.click(
      within(card).getByRole("button", { name: /确认分发计划/ }),
    );
    await waitFor(() => expect(mocks.edit).toHaveBeenCalled());
    // 轮询水合前确认：点数预算按 pointsToCny 回算为内部 CNY（16000 点 → 1000）。
    const payload = mocks.edit.mock.calls[0]?.[2] as {
      edit: { budgetCny: number };
    };
    expect(payload.edit.budgetCny).toBe(1000);
  });

  // 取消勾选持有分配的渠道时对账分配（修复 article-channel-not-selected）：
  // 文章按候选顺序改派到其他已选未占用候选；无候选可用时置 unassigned。
  function multiChannelPlan(): DistributionPlanProjection {
    const articles = [
      { id: "article-1", operationId: "articles-1", approvedRevision: 3, title: "篇一", topic: "汽车音响", contentType: "guide" as const },
      { id: "article-2", operationId: "articles-1", approvedRevision: 3, title: "篇二", topic: "车载支架", contentType: "guide" as const },
    ];
    const candidates = [
      candidate({ resourceId: 8 }),
      candidate({
        resourceId: 9,
        kind: "we-media",
        name: "车主生活圈",
        evidence: [],
      }),
      candidate({
        resourceId: 10,
        kind: "we-media",
        name: "新能源观察",
        evidence: [],
      }),
    ];
    return plan({
      articles,
      candidates,
      selectedResourceIds: [8, 9, 10],
      assignments: [
        { articleId: "article-1", resourceId: 8, reason: "source-evidence", scheduledAt: "2026-08-20T02:00:00Z" },
        { articleId: "article-2", resourceId: 9, reason: "content-fit", scheduledAt: "2026-08-20T02:00:00Z" },
      ],
    });
  }

  it("reassigns the article when unchecking its assigned channel", async () => {
    mocks.edit.mockResolvedValue({ revision: 2 });
    mocks.confirm.mockResolvedValue({});
    render(
      <DistributionGateCard
        data={{ kind: "distribution-plan", plan: multiChannelPlan() }}
      />,
    );
    const card = screen.getByRole("region", { name: "分发计划确认" });

    // 取消勾选渠道 8（article-1 的分配指向它）。
    fireEvent.click(within(card).getByRole("checkbox", { name: "选择渠道 汽车产业观察" }));
    fireEvent.click(
      within(card).getByRole("button", { name: /确认分发计划/ }),
    );
    await waitFor(() => expect(mocks.edit).toHaveBeenCalled());
    const payload = mocks.edit.mock.calls[0]?.[2] as {
      edit: {
        selectedResourceIds: number[];
        assignments: { articleId: string; resourceId: number | null }[];
      };
    };
    expect(payload.edit.selectedResourceIds).toEqual([9, 10]);
    expect(payload.edit.assignments).toEqual([
      // article-1 改派到下一个已选未占用候选（渠道 10）。
      expect.objectContaining({ articleId: "article-1", resourceId: 10 }),
      expect.objectContaining({ articleId: "article-2", resourceId: 9 }),
    ]);
  });

  it("marks the article unassigned when no selected channel is free", async () => {
    mocks.edit.mockResolvedValue({ revision: 2 });
    mocks.confirm.mockResolvedValue({});
    const twoArticles = [
      { id: "article-1", operationId: "articles-1", approvedRevision: 3, title: "篇一", topic: "汽车音响", contentType: "guide" as const },
      { id: "article-2", operationId: "articles-1", approvedRevision: 3, title: "篇二", topic: "车载支架", contentType: "guide" as const },
    ];
    render(
      <DistributionGateCard
        data={{
          kind: "distribution-plan",
          plan: plan({
            articles: twoArticles,
            candidates: [candidate({ resourceId: 8 }), candidate({ resourceId: 9, name: "车主生活圈", kind: "we-media", evidence: [] })],
            selectedResourceIds: [8, 9],
            assignments: [
              { articleId: "article-1", resourceId: 8, reason: "source-evidence", scheduledAt: "2026-08-20T02:00:00Z" },
              { articleId: "article-2", resourceId: 9, reason: "content-fit", scheduledAt: "2026-08-20T02:00:00Z" },
            ],
          }),
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "分发计划确认" });

    // 渠道 9 已被 article-2 占用且不可复用：article-1 只能置 unassigned。
    fireEvent.click(within(card).getByRole("checkbox", { name: "选择渠道 汽车产业观察" }));
    fireEvent.click(
      within(card).getByRole("button", { name: /确认分发计划/ }),
    );
    await waitFor(() => expect(mocks.edit).toHaveBeenCalled());
    const payload = mocks.edit.mock.calls[0]?.[2] as {
      edit: { assignments: { articleId: string; resourceId: number | null; reason: string }[] };
    };
    expect(payload.edit.assignments).toEqual([
      expect.objectContaining({ articleId: "article-1", resourceId: null, reason: "unassigned" }),
      expect.objectContaining({ articleId: "article-2", resourceId: 9 }),
    ]);
  });
});
