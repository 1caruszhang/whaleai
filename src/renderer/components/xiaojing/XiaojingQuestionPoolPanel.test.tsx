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
      policyVersion: "xiaojing-content-prompt-v1",
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
          policyVersion: "xiaojing-content-prompt-v1",
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
          policyVersion: "xiaojing-content-prompt-v1",
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

  it("loads the session's latest pool and renders only the confirmed selection", async () => {
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
    // 只展示确认时选定的问题；未选问题不进入工作台。
    expect(
      within(region).queryByText("锦江区汽车隔音推荐哪家？"),
    ).not.toBeInTheDocument();
    expect(within(region).getByText(/已选 1/)).toBeInTheDocument();
    // checkpoint 是过程细节，只留在聊天进度卡。
    expect(
      within(region).queryByText(/keyword-search:completed#1/),
    ).not.toBeInTheDocument();
  });

  it("defers unconfirmed pools to the chat gate card instead of dumping questions", async () => {
    mocks.latest.mockResolvedValue(
      pool({ status: "awaiting-selection" }),
    );
    render(
      <XiaojingQuestionPoolPanel
        workspaceId={workspace.id}
      />,
    );
    expect(
      await screen.findByText(/问题池尚未确认；请回到聊天中的确认卡片完成选题/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "问题池选择" })).not.toBeInTheDocument();
    expect(screen.queryByText("成都汽车改装哪家好？")).not.toBeInTheDocument();
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

  // GD-7 决策 A 回归：挖掘搜索词的确认期审阅由聊天卡片承载（卡片同
  // aria-label），工作台确认视图不再重复倾倒这些过程输入。
  it("keeps mined keywords on the chat gate card, out of the confirmed workbench view", async () => {
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
      name: "问题池选择",
    });
    expect(
      within(region).queryByLabelText("本次挖掘的搜索词"),
    ).not.toBeInTheDocument();
    expect(
      within(region).queryByText(/成都汽车音响改装/),
    ).not.toBeInTheDocument();
    expect(within(region).getByText("成都汽车改装哪家好？")).toBeInTheDocument();
  });
});
