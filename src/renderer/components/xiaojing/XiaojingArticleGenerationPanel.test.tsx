import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ArticleOperationProjection,
  ArticleProjection,
} from "../../../shared/geo/articleGeneration";
import XiaojingArticleGenerationPanel from "./XiaojingArticleGenerationPanel";

const mocks = vi.hoisted(() => ({
  sessionId: "session-11",
  apiPost: vi.fn(),
  latest: vi.fn(),
  exact: vi.fn(),
  body: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/articleGenerationClient", () => ({
  loadLatestArticleOperation: mocks.latest,
  loadArticleOperation: mocks.exact,
  loadArticleBody: mocks.body,
}));

function article(overrides: Partial<ArticleProjection> = {}): ArticleProjection {
  return {
    id: "article-11",
    operationId: "operation-11",
    workspaceId: "brand-11",
    sourcePlanItemId: null,
    knowledgeVersion: 7,
    contentType: "guide",
    topic: "企业知识库怎么选",
    requestedTitle: "企业知识库怎么选",
    constraints: "面向采购负责人",
    plannedFacts: [
      {
        factKey: "fact-1",
        predicate: "profile.history",
        normalizedValueJson: '"成立10年"',
      },
    ],
    status: "draft_ready",
    revision: 1,
    approvedRevision: null,
    failureReason: null,
    generationAttempt: 1,
    currentVersion: {
      revision: 1,
      title: "企业知识库怎么选",
      bodyPath: "operations/operation-11/articles/article-11/v1.md",
      bodySha256: "abc",
      origin: "generated",
      basedOnRevision: null,
      review: null,
      createdAt: "2026-08-15T00:00:00Z",
      approvedAt: null,
    },
    approvedVersion: null,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    ...overrides,
  };
}

function operation(overrides: Partial<ArticleOperationProjection> = {}): ArticleOperationProjection {
  return {
    id: "operation-11",
    workspaceId: "brand-11",
    createdBySessionId: "session-11",
    sourceKind: "direct",
    topicPlanId: null,
    topicPlanRevision: null,
    knowledgeVersion: 7,
    policyVersion: "xiaojing-content-prompt-v4",
    status: "running",
    articles: [article()],
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    ...overrides,
  };
}

// 票 29：面板退化为纯只读投影——生成/编辑/重试/批准只有聊天卡片一套
// 实现，组件测试只断言只读渲染行为与批准稿只读查看。
describe("XiaojingArticleGenerationPanel read-only projection", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.sessionId = "session-11";
    mocks.latest.mockReset().mockResolvedValue(operation());
    mocks.exact.mockReset().mockResolvedValue(operation({ id: "operation-exact" }));
    mocks.body.mockReset();
  });

  it("loads a notification-targeted article Operation by exact id instead of latest", async () => {
    render(<XiaojingArticleGenerationPanel workspaceId="brand-11" operationId="operation-exact" />);
    await screen.findByRole("region", { name: "文章生成与审核" });
    expect(mocks.exact).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-11", sessionId: "session-11" },
      "operation-exact",
    );
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("renders only approved articles and directs pending drafts back to the chat card", async () => {
    mocks.latest.mockResolvedValue(
      operation({
        articles: [
          article({ status: "approved", approvedRevision: 2, id: "article-approved" }),
          article({ status: "draft_ready" }),
          article({ status: "generation_failed", id: "article-failed", failureReason: "生成超时" }),
        ],
      }),
    );
    render(<XiaojingArticleGenerationPanel workspaceId="brand-11" />);
    const panel = await screen.findByRole("region", { name: "文章生成与审核" });

    expect(within(panel).getByText("企业知识库怎么选")).toBeInTheDocument();
    expect(within(panel).getByText(/已批准 1 篇/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/另有 2 篇生成或审阅中的文章/),
    ).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "查看批准稿" })).toBeInTheDocument();
    // 未确认的过程产物（失败原因等）留在聊天卡片，不进工作台。
    expect(within(panel).queryByText(/草稿待审核/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/生成超时/)).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "审校并批准" }),
    ).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "重新生成此篇" }),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText("文章主题")).not.toBeInTheDocument();
  });

  it("shows a chat-card pointer when no article has been approved yet", async () => {
    render(<XiaojingArticleGenerationPanel workspaceId="brand-11" />);
    const panel = await screen.findByRole("region", { name: "文章生成与审核" });

    expect(
      within(panel).getByText(/尚无已批准文章；草稿的审阅与批准请回到聊天中的确认卡片完成/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText("企业知识库怎么选")).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "查看批准稿" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the approved body viewable without offering draft edits", async () => {
    mocks.latest.mockResolvedValue(
      operation({
        articles: [
          article({ status: "approved", approvedRevision: 1 }),
        ],
      }),
    );
    mocks.body.mockResolvedValue({
      articleId: "article-11",
      revision: 1,
      title: "企业知识库怎么选",
      body: "# 企业知识库怎么选\n\n批准稿正文。",
      approved: true,
    });
    render(<XiaojingArticleGenerationPanel workspaceId="brand-11" />);
    const panel = await screen.findByRole("region", { name: "文章生成与审核" });

    // 投影经异步到达：用 findBy 等待按钮出现，避免高负载下的取数竞态。
    fireEvent.click(
      await within(panel).findByRole("button", { name: "查看批准稿" }),
    );
    expect(await within(panel).findByText(/批准稿正文/)).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.body).toHaveBeenCalledWith(
        mocks.apiPost,
        { workspaceId: "brand-11", sessionId: "session-11" },
        { operationId: "operation-11", articleId: "article-11", approved: true },
      ),
    );
    expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: "保存为新版本" }),
    ).not.toBeInTheDocument();
  });

  it("reloads the projection when the session tool signal advances", async () => {
    const { rerender } = render(
      <XiaojingArticleGenerationPanel workspaceId="brand-11" refreshKey={0} />,
    );
    await screen.findByRole("region", { name: "文章生成与审核" });
    expect(mocks.latest).toHaveBeenCalledTimes(1);

    rerender(
      <XiaojingArticleGenerationPanel workspaceId="brand-11" refreshKey={1} />,
    );
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  });
});
