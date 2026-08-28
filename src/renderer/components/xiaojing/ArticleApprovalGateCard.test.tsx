import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ArticleOperationProjection,
  ArticleProjection,
} from "../../../shared/geo/articleGeneration";
import { renderWithTheme as render } from "@/test/renderWithTheme";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  loadBody: vi.fn(),
  loadLatest: vi.fn(),
  edit: vi.fn(),
  approve: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17" }),
}));

vi.mock("@/api/articleGenerationClient", () => ({
  loadArticleBody: mocks.loadBody,
  loadLatestArticleOperation: mocks.loadLatest,
  editArticle: mocks.edit,
  approveArticle: mocks.approve,
  retryArticle: mocks.retry,
}));

import ArticleApprovalGateCard, {
  parseArticleApprovalGateCard,
} from "./ArticleApprovalGateCard";

const BODY = "# 成都车载音响选购指南\n\n## 选购要点\n\n- 预算先行";

function makeArticle(
  overrides: Partial<ArticleProjection> = {},
): ArticleProjection {
  const revision = overrides.revision ?? 3;
  const title = overrides.currentVersion?.title ?? "成都车载音响选购指南";
  return {
    id: "article-1",
    operationId: "operation-17",
    workspaceId: "brand-17",
    sourcePlanItemId: null,
    knowledgeVersion: 9,
    contentType: "guide",
    topic: "车载音响选购",
    requestedTitle: title,
    constraints: "",
    plannedFacts: [],
    status: "draft_ready",
    revision,
    approvedRevision: null,
    failureReason: null,
    generationAttempt: 1,
    currentVersion: {
      revision,
      title,
      bodyPath: `operations/operation-17/articles/article-1/v${revision}.md`,
      bodySha256: "hash",
      origin: "generated",
      basedOnRevision: revision - 1,
      review: null,
      createdAt: "2026-08-18T00:00:00Z",
      approvedAt: null,
    },
    approvedVersion: null,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
    ...overrides,
  } as unknown as ArticleProjection;
}

function makeOperation(
  articles: ArticleProjection[],
): ArticleOperationProjection {
  return {
    id: "operation-17",
    workspaceId: "brand-17",
    createdBySessionId: "session-17",
    sourceKind: "direct",
    topicPlanId: null,
    topicPlanRevision: null,
    knowledgeVersion: 9,
    policyVersion: "js-ai-dev-direct-article-generation-v1",
    status: "running",
    articles,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
  } as unknown as ArticleOperationProjection;
}

function wrappedResult(operation: ArticleOperationProjection): string {
  return JSON.stringify([
    {
      type: "text",
      text: JSON.stringify({ kind: "article-operation", operation }),
    },
  ]);
}

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.loadBody.mockReset();
  mocks.loadLatest.mockReset().mockResolvedValue(null);
  mocks.edit.mockReset();
  mocks.approve.mockReset();
  mocks.retry.mockReset();
});

describe("ArticleApprovalGateCard", () => {
  it("parses only exact article-operation envelopes", () => {
    const operation = makeOperation([makeArticle()]);
    expect(
      parseArticleApprovalGateCard(wrappedResult(operation))?.operation.id,
    ).toBe("operation-17");
    expect(
      parseArticleApprovalGateCard(JSON.stringify({ kind: "other" })),
    ).toBeNull();
  });

  it("expands and collapses the body without refetching the same revision", async () => {
    const article = makeArticle();
    mocks.loadBody.mockResolvedValue({
      articleId: "article-1",
      revision: 3,
      title: "成都车载音响选购指南",
      body: BODY,
      approved: false,
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([article]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    const toggle = within(card).getByRole("button", {
      name: "查看正文 成都车载音响选购指南",
    });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await within(card).findByText(/预算先行/)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(card).queryByText(/预算先行/)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(await within(card).findByText(/预算先行/)).toBeInTheDocument();
    expect(mocks.loadBody).toHaveBeenCalledTimes(1);
  });

  it("edits the body into a user-edited revision and approves that revision", async () => {
    const article = makeArticle();
    mocks.loadBody.mockResolvedValue({
      articleId: "article-1",
      revision: 3,
      title: "成都车载音响选购指南",
      body: BODY,
      approved: false,
    });
    const edited = makeArticle({
      revision: 4,
      currentVersion: {
        revision: 4,
        title: "新标题",
        bodyPath: "operations/operation-17/articles/article-1/v4.md",
        bodySha256: "hash-4",
        origin: "user-edited",
        basedOnRevision: 3,
        review: null,
        createdAt: "2026-08-18T00:01:00Z",
        approvedAt: null,
      },
    });
    mocks.edit.mockResolvedValue(edited);
    mocks.approve.mockResolvedValue(
      makeArticle({
        revision: 4,
        status: "approved",
        approvedRevision: 4,
        currentVersion: edited.currentVersion,
      }),
    );
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([article]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    fireEvent.click(
      within(card).getByRole("button", {
        name: "查看正文 成都车载音响选购指南",
      }),
    );
    fireEvent.click(
      await within(card).findByRole("button", {
        name: "编辑正文 成都车载音响选购指南",
      }),
    );
    const textarea = within(card).getByRole("textbox", {
      name: "编辑正文输入 成都车载音响选购指南",
    });
    fireEvent.change(textarea, {
      target: { value: "# 新标题\n\n编辑后的正文" },
    });
    fireEvent.click(within(card).getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(mocks.edit).toHaveBeenCalledTimes(1));
    expect(mocks.edit).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      {
        operationId: "operation-17",
        articleId: "article-1",
        expectedRevision: 3,
        title: "新标题",
        body: "# 新标题\n\n编辑后的正文",
      },
    );
    await waitFor(() =>
      expect(within(card).getByText(/· 已编辑/)).toBeInTheDocument(),
    );
    expect(within(card).getByText("新标题")).toBeInTheDocument();
    expect(
      within(card).queryByRole("textbox", { name: /编辑正文输入/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "批准并继续（1 篇）" }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      {
        operationId: "operation-17",
        articleId: "article-1",
        expectedRevision: 4,
      },
    );
    await waitFor(() =>
      expect(
        within(card).getByText(/已全部批准（1 篇）/),
      ).toBeInTheDocument(),
    );
  });

  it("rejects an edit whose first line is not an H1 title", async () => {
    const article = makeArticle();
    mocks.loadBody.mockResolvedValue({
      articleId: "article-1",
      revision: 3,
      title: "成都车载音响选购指南",
      body: BODY,
      approved: false,
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([article]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    fireEvent.click(
      within(card).getByRole("button", {
        name: "查看正文 成都车载音响选购指南",
      }),
    );
    fireEvent.click(
      await within(card).findByRole("button", {
        name: "编辑正文 成都车载音响选购指南",
      }),
    );
    fireEvent.change(
      within(card).getByRole("textbox", {
        name: "编辑正文输入 成都车载音响选购指南",
      }),
      { target: { value: "新标题\n\n正文没有 H1" } },
    );
    fireEvent.click(within(card).getByRole("button", { name: "保存修改" }));

    expect(
      await within(card).findByText(/正文第一行必须保持「# 标题」格式/),
    ).toBeInTheDocument();
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("approves every pending article sequentially and shows the done banner", async () => {
    const first = makeArticle();
    const second = makeArticle({ id: "article-2", revision: 5 });
    mocks.approve.mockImplementation(
      async (
        _api: unknown,
        _identity: unknown,
        input: { articleId: string; expectedRevision: number },
      ) =>
        makeArticle({
          id: input.articleId,
          revision: input.expectedRevision,
          status: "approved",
          approvedRevision: input.expectedRevision,
        }),
    );
    render(
      <ArticleApprovalGateCard
        data={{
          kind: "article-operation",
          operation: makeOperation([first, second]),
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    expect(within(card).getByText(/已批准 0\/2/)).toBeInTheDocument();

    fireEvent.click(
      within(card).getByRole("button", { name: "批准并继续（2 篇）" }),
    );
    await waitFor(() =>
      expect(
        within(card).getByText(/已全部批准（2 篇）/),
      ).toBeInTheDocument(),
    );
    expect(mocks.approve).toHaveBeenCalledTimes(2);
    expect(mocks.approve).toHaveBeenNthCalledWith(
      1,
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      {
        operationId: "operation-17",
        articleId: "article-1",
        expectedRevision: 3,
      },
    );
    expect(mocks.approve).toHaveBeenNthCalledWith(
      2,
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      {
        operationId: "operation-17",
        articleId: "article-2",
        expectedRevision: 5,
      },
    );
    expect(
      within(card).queryByRole("button", { name: /批准并继续/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps going after a per-article failure and lists the failed draft", async () => {
    const first = makeArticle();
    const second = makeArticle({ id: "article-2" });
    mocks.approve
      .mockRejectedValueOnce(new Error("article_generation_revision_conflict"))
      .mockResolvedValueOnce(
        makeArticle({
          id: "article-2",
          status: "approved",
          approvedRevision: 3,
        }),
      );
    render(
      <ArticleApprovalGateCard
        data={{
          kind: "article-operation",
          operation: makeOperation([first, second]),
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    fireEvent.click(
      within(card).getByRole("button", { name: "批准并继续（2 篇）" }),
    );
    await waitFor(() =>
      expect(within(card).getByText(/部分文章未能批准/)).toBeInTheDocument(),
    );
    expect(
      within(card).getByText(/article_generation_revision_conflict/),
    ).toBeInTheDocument();
    expect(within(card).getByText(/已批准 1\/2/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "批准并继续（1 篇）" }),
    ).toBeInTheDocument();
    expect(
      within(card).queryByText(/已全部批准/),
    ).not.toBeInTheDocument();
  });

  it("does not show approved state when the server review blocks the draft", async () => {
    const article = makeArticle();
    mocks.approve.mockResolvedValue(
      makeArticle({
        status: "rejected",
        failureReason: "article_review_blocked",
      }),
    );
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([article]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    fireEvent.click(
      within(card).getByRole("button", { name: "批准并继续（1 篇）" }),
    );
    await waitFor(() =>
      expect(within(card).getByText(/指南 · 风险阻断/)).toBeInTheDocument(),
    );
    expect(
      within(card).queryByText(/已全部批准/),
    ).not.toBeInTheDocument();
    expect(
      within(card).getByText(/仍有文章被风险阻断或生成失败/),
    ).toBeInTheDocument();
  });

  it("renders the done banner directly for an already approved operation", () => {
    render(
      <ArticleApprovalGateCard
        data={{
          kind: "article-operation",
          operation: makeOperation([
            makeArticle({
              status: "approved",
              approvedRevision: 3,
            }),
          ]),
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    expect(
      within(card).getByText(/已全部批准（1 篇）/),
    ).toBeInTheDocument();
    expect(
      within(card).queryByRole("button", { name: /批准并继续/ }),
    ).not.toBeInTheDocument();
  });

  // 回归（2026-08-26 线上报障）：ranking 稿确定性门拒绝后停在 revision=0、
  // 无版本行；此前卡片仍提供「查看正文」，点开必然命中 article_version_not_found。
  it("offers per-article retry instead of body viewing for a revision-0 failed article", () => {
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      approvedRevision: null,
      failureReason:
        "article_generation_ranking_output_invalid:第 1 家必须是目标品牌，第 2–6 家必须完整使用五家已确认竞品",
      currentVersion: null,
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    expect(
      within(card).queryByRole("button", { name: /查看正文/ }),
    ).not.toBeInTheDocument();
    expect(within(card).getByText(/指南 · 生成失败/)).toBeInTheDocument();
    expect(within(card).getByText(/第 1 家必须是目标品牌/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeInTheDocument();
  });

  it("retries the failed article with exact revision and adopts the regenerated draft", async () => {
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      approvedRevision: null,
      failureReason: "article_generation_ranking_output_invalid:实体集合不符",
      currentVersion: null,
    });
    const recovered = makeArticle({
      status: "draft_ready",
      revision: 1,
      approvedRevision: null,
      failureReason: null,
      currentVersion: {
        revision: 1,
        title: "成都车载音响选购指南",
        bodyPath: "operations/operation-17/articles/article-1/v1.md",
        bodySha256: "hash-1",
        origin: "generated",
        basedOnRevision: null,
        review: null,
        createdAt: "2026-08-18T00:02:00Z",
        approvedAt: null,
      },
    });
    mocks.retry.mockResolvedValue(recovered);
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    fireEvent.click(within(card).getByRole("button", { name: /重试本篇/ }));
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledTimes(1));
    expect(mocks.retry).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      { operationId: "operation-17", articleId: "article-1", expectedRevision: 0 },
    );
    await waitFor(() =>
      expect(within(card).getByText(/草稿待审核/)).toBeInTheDocument(),
    );
    expect(
      within(card).getByRole("button", { name: /批准并继续（1 篇）/ }),
    ).toBeInTheDocument();
  });

  it("surfaces a retry error without losing the retry affordance", async () => {
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      approvedRevision: null,
      failureReason: "provider_unavailable",
      currentVersion: null,
    });
    mocks.retry.mockRejectedValue(new Error("article_generation_revision_conflict"));
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    fireEvent.click(within(card).getByRole("button", { name: /重试本篇/ }));
    await waitFor(() =>
      expect(
        within(card).getByText("article_generation_revision_conflict"),
      ).toBeInTheDocument(),
    );
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeInTheDocument();
  });
});
