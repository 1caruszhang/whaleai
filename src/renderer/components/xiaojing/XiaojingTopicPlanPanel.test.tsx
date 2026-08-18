import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  TOPIC_PLAN_POLICY_VERSION,
  type TopicPlanProjection,
} from "../../../shared/geo/topicPlan";
import XiaojingTopicPlanPanel from "./XiaojingTopicPlanPanel";

const mocks = vi.hoisted(() => ({
  sessionId: "session-10",
  apiPost: vi.fn(),
  latest: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/topicPlanClient", () => ({
  loadLatestTopicPlan: mocks.latest,
}));

function projection(overrides: Partial<TopicPlanProjection> = {}): TopicPlanProjection {
  return {
    id: "plan-10",
    operationId: "operation-10",
    workspaceId: "brand-10",
    questionPoolId: "pool-08",
    questionPoolRevision: 1,
    knowledgeVersion: 7,
    productLine: "汽车音响",
    targetRegion: "成都",
    policyVersion: TOPIC_PLAN_POLICY_VERSION,
    status: "confirmed",
    revision: 2,
    topics: [
      {
        id: "topic-1",
        name: "成都汽车音响改装选型",
        summary: "覆盖本地门店选择",
        questionIds: ["q1", "q2"],
        searchIntent: "commercial-investigation",
        namingReason: "共同选型意图",
      },
    ],
    items: [
      {
        id: "item-guide",
        topicId: "topic-1",
        sourceQuestionIds: ["q1", "q2"],
        contentType: "guide",
        typeSelectionReason: "适合回答选型问题",
        title: "成都汽车音响改装怎么选？本地判断指南",
        titleCandidates: ["成都汽车音响改装怎么选？本地判断指南"],
        titleRationale: {
          questionCoverage: "覆盖 q1/q2",
          searchIntent: "匹配比较意图",
          differentiation: "与其他标题角度不同",
          brandFit: "适配品牌专家定位",
          chinaMarketExpression: "自然中文搜索表达",
        },
        plannedFacts: [
          {
            factKey: "industry",
            predicate: "enterprise-profile.industry",
            normalizedValueJson: '"汽车音响改装"',
          },
        ],
        deduplication: {
          method: "embedding",
          comparedItemIds: [],
          maxSimilarity: 0,
          threshold: 0.92,
        },
        userEdited: false,
        approvalStatus: "approved",
        origin: "model",
      },
      {
        id: "item-news",
        topicId: "topic-1",
        sourceQuestionIds: ["q1"],
        contentType: "news",
        typeSelectionReason: "跟踪行业动态",
        title: "成都汽车音响改装服务新变化",
        titleCandidates: ["成都汽车音响改装服务新变化"],
        titleRationale: {
          questionCoverage: "覆盖 q1",
          searchIntent: "匹配动态意图",
          differentiation: "与指南角度不同",
          brandFit: "适配品牌专家定位",
          chinaMarketExpression: "自然中文搜索表达",
        },
        plannedFacts: [
          {
            factKey: "industry",
            predicate: "enterprise-profile.industry",
            normalizedValueJson: '"汽车音响改装"',
          },
        ],
        deduplication: {
          method: "embedding",
          comparedItemIds: [],
          maxSimilarity: 0,
          threshold: 0.92,
        },
        userEdited: true,
        approvalStatus: "approved",
        origin: "user",
      },
    ],
    selectedItemIds: ["item-guide", "item-news"],
    modelAudit: {
      clustering: "embedding+generation-llm",
      naming: "generation-llm",
      typeRecommendation: "generation-llm",
      titleGeneration: "generation-llm",
      titleDeduplication: "embedding",
    },
    providerSnapshot: {
      generation: {
        provider: "volcengine",
        capabilitySlot: "generation",
        model: "doubao-seed-2-0-pro-260215",
      },
      titlePlanning: {
        provider: "volcengine",
        capabilitySlot: "generation",
        model: "doubao-seed-2-0-mini-260428",
      },
      embedding: {
        provider: "volcengine",
        capabilitySlot: "embedding",
        modelFamily: "doubao-embedding-vision",
        dimensions: 2048,
      },
      policyVersion: TOPIC_PLAN_POLICY_VERSION,
    },
    modelAttempts: [
      {
        stage: "topic-clustering",
        provider: "volcengine",
        capabilitySlot: "generation",
        model: "doubao-seed-2-0-pro-260215",
        status: "success",
      },
    ],
    reused: false,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    ...overrides,
  };
}

// 票 29：面板退化为纯只读投影——勾选/编辑/局部重算/确认只有聊天卡片
// 一套实现，组件测试只断言只读渲染行为。
describe("XiaojingTopicPlanPanel read-only projection", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.sessionId = "session-10";
    mocks.latest.mockReset().mockResolvedValue(projection());
  });

  it("renders the latest plan items with topic, type and planned facts", async () => {
    render(<XiaojingTopicPlanPanel workspaceId="brand-10" />);
    const panel = await screen.findByRole("region", { name: "主题与内容计划" });

    expect(mocks.latest).toHaveBeenCalledWith(mocks.apiPost, {
      workspaceId: "brand-10",
      sessionId: "session-10",
    });
    expect(within(panel).getByText("知识 v7")).toBeInTheDocument();
    expect(within(panel).getByText("已确认")).toBeInTheDocument();
    expect(
      within(panel).getByText("成都汽车音响改装怎么选？本地判断指南"),
    ).toBeInTheDocument();
    expect(
      within(panel).getAllByText(/拟覆盖事实：enterprise-profile.industry/),
    ).toHaveLength(2);
    // 两个计划项都归属同一主题，主题名随每项展示。
    expect(
      within(panel).getAllByText(/成都汽车音响改装选型/),
    ).toHaveLength(2);
  });

  it("exposes no approve, edit, regenerate or confirm controls", async () => {
    render(<XiaojingTopicPlanPanel workspaceId="brand-10" />);
    const panel = await screen.findByRole("region", { name: "主题与内容计划" });
    await within(panel).findByText("已确认");

    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(panel).queryByText(/保存修改/)).not.toBeInTheDocument();
  });

  it("directs unconfirmed plans back to the chat card without a parallel confirm path", async () => {
    mocks.latest.mockResolvedValue(projection({ status: "awaiting-confirmation" }));
    render(<XiaojingTopicPlanPanel workspaceId="brand-10" />);
    const panel = await screen.findByRole("region", { name: "主题与内容计划" });

    expect(
      await within(panel).findByText(/请回到聊天中的确认卡片/),
    ).toBeInTheDocument();
    // 未确认计划不倾倒条目内容；条目只在确认后进入工作台。
    expect(
      within(panel).queryByText("成都汽车音响改装怎么选？本地判断指南"),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByText(/拟覆盖事实：/),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
  });

  it("reloads the projection when the session tool signal advances", async () => {
    const { rerender } = render(
      <XiaojingTopicPlanPanel workspaceId="brand-10" refreshKey={0} />,
    );
    await screen.findByRole("region", { name: "主题与内容计划" });
    expect(mocks.latest).toHaveBeenCalledTimes(1);

    rerender(<XiaojingTopicPlanPanel workspaceId="brand-10" refreshKey={1} />);
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  });
});
