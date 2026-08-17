import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuestionPoolProjection } from "../../../shared/geo/questionPool";
import XiaojingQuestionPoolPanel from "./XiaojingQuestionPoolPanel";

const mocks = vi.hoisted(() => ({
  sessionId: "session-08",
  apiPost: vi.fn(),
  latest: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/brandQuestionPoolClient", () => ({
  loadLatestQuestionPool: mocks.latest,
}));

const workspace = {
  id: "brand-08",
  name: "鲸跃科技",
  productLines: ["旗舰产品", "企业服务"],
  rootPath: "C:\\Xiaojing\\brands\\brand-08",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

function pool(
  overrides: Partial<QuestionPoolProjection> = {},
): QuestionPoolProjection {
  return {
    id: "pool-08",
    attemptId: "attempt-08",
    operationId: "operation-08",
    workspaceId: workspace.id,
    knowledgeVersion: 7,
    productLine: "旗舰产品",
    targetRegion: "成都",
    generationParameters: {
      policyVersion: "js-ai-dev-pred-1-v1",
      candidateLimit: 20,
      recentSelectionLimit: 20,
      priorityThresholds: { highAtSum: 150, mediumAtSum: 100 },
    },
    status: "confirmed",
    revision: 1,
    keywords: [
      {
        id: "kw-1",
        term: "成都汽车改装",
        category: "core",
        heat: "high",
        platform: "doubao",
      },
    ],
    questions: [
      {
        id: "q-1",
        text: "成都汽车改装哪家好？",
        selected: true,
        recommended: true,
        score: {
          mode: "pred-1",
          relevance: 90,
          recentPoolSimilarity: 20,
          optimizationPotential: 40,
          priorityTotal: 130,
          priority: "medium",
          formula: "traceable",
          policyVersion: "js-ai-dev-pred-1-v1",
        },
        evidence: [
          {
            kind: "keyword-search",
            reference: "kw-1",
            excerpt: "成都汽车改装",
          },
        ],
      },
      {
        id: "q-2",
        text: "锦江区汽车隔音推荐哪家？",
        selected: false,
        recommended: false,
        score: {
          mode: "pred-1",
          relevance: 80,
          recentPoolSimilarity: 0,
          optimizationPotential: 50,
          priorityTotal: 130,
          priority: "medium",
          formula: "traceable",
          policyVersion: "js-ai-dev-pred-1-v1",
        },
        evidence: [
          {
            kind: "keyword-search",
            reference: "kw-2",
            excerpt: "锦江区汽车隔音",
          },
        ],
      },
    ],
    sourceEvidence: [
      { kind: "knowledge-fact", reference: "7:industry", excerpt: "汽车改装" },
    ],
    checkpoints: [
      {
        stage: "keyword-search",
        status: "completed",
        attemptNumber: 1,
        billingKey: "a:k",
        inputHash: "a".repeat(64),
      },
      {
        stage: "question-generation",
        status: "completed",
        attemptNumber: 1,
        billingKey: "a:q",
        inputHash: "b".repeat(64),
      },
    ],
    reused: true,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    ...overrides,
  };
}

// 票 29：面板退化为纯只读投影——生成/勾选/编辑/确认只有聊天卡片一套
// 实现，组件测试只断言只读渲染行为。
describe("XiaojingQuestionPoolPanel read-only projection", () => {
  beforeEach(() => {
    mocks.sessionId = "session-08";
    mocks.apiPost.mockReset();
    mocks.latest.mockReset().mockResolvedValue(pool());
  });

  it("loads the session's latest pool and renders it read-only", async () => {
    render(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
      />,
    );
    const region = await screen.findByRole("region", { name: "问题池选择" });

    expect(mocks.latest).toHaveBeenCalledWith(mocks.apiPost, {
      workspaceId: "brand-08",
      sessionId: "session-08",
    });
    expect(within(region).getByText("已复用")).toBeInTheDocument();
    expect(within(region).getByText("知识 v7")).toBeInTheDocument();
    expect(within(region).getByText("成都汽车改装哪家好？")).toBeInTheDocument();
    expect(within(region).getByText(/已选 1\/2/)).toBeInTheDocument();
    expect(
      within(region).getByText(/keyword-search:completed#1/),
    ).toBeInTheDocument();
  });

  it("exposes no generation, selection, edit or confirm controls", async () => {
    render(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
      />,
    );
    const panel = await screen.findByRole("region", {
      name: "关键词与问题池",
    });
    await within(panel).findByText(/已选/);

    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(panel).queryByPlaceholderText("补充一个问题"),
    ).not.toBeInTheDocument();
  });

  it("reloads the projection when the session tool signal advances", async () => {
    const { rerender } = render(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
        refreshKey={0}
      />,
    );
    await screen.findByRole("region", { name: "问题池选择" });
    expect(mocks.latest).toHaveBeenCalledTimes(1);

    rerender(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
        refreshKey={1}
      />,
    );
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  });

  it("surfaces load failures without retry affordances that mutate the pool", async () => {
    mocks.latest.mockRejectedValue(new Error("question_pool_load_failed"));
    render(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
      />,
    );
    expect(await screen.findByText("question_pool_load_failed")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // GD-7 决策 A 回归：关键词挖掘融合进池生成，无独立确认门，
  // 但挖掘出的搜索词必须随投影展示，供聊天卡片确认时一并审阅。
  it("shows the mined search terms with category and heat alongside questions", async () => {
    mocks.latest.mockResolvedValue(
      pool({
        keywords: [
          { id: "kw-1", term: "成都汽车音响改装", category: "core", heat: "high", platform: "doubao" },
          { id: "kw-2", term: "锦江区 汽车隔音 多少钱", category: "longtail", heat: "medium", platform: "doubao" },
        ],
      }),
    );
    render(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
      />,
    );
    const region = await screen.findByRole("region", {
      name: "关键词与问题池",
    });
    const keywordBlock = await within(region).findByLabelText(
      "本次挖掘的搜索词",
    );
    expect(
      within(keywordBlock).getByText(/成都汽车音响改装/),
    ).toBeInTheDocument();
    expect(
      within(keywordBlock).getByText(/锦江区 汽车隔音 多少钱/),
    ).toBeInTheDocument();
    expect(within(keywordBlock).getByText(/核心词/)).toBeInTheDocument();
    expect(within(keywordBlock).getByText(/长尾词/)).toBeInTheDocument();
    expect(within(keywordBlock).getAllByText(/热度高|热度中/).length).toBe(2);
  });
});
