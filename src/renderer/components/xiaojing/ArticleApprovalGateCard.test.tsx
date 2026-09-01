import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  discard: vi.fn(),
  retry: vi.fn(),
  fetchImage: vi.fn(),
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
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
  discardArticle: mocks.discard,
  retryArticle: mocks.retry,
}));

vi.mock("@/api/brandMaterialClient", () => ({
  fetchMaterialImageContent: mocks.fetchImage,
}));

import ArticleApprovalGateCard, {
  parseArticleApprovalGateCard,
} from "./ArticleApprovalGateCard";

const BODY = "# 成都车载音响选购指南\n\n## 选购要点\n\n- 预算先行";

// #16：带占位符的正文——预览态占位符渲染为图片，编辑源文态删行即删图。
const BODY_WITH_IMAGES = [
  "# 成都车载音响选购指南",
  "",
  "![产品实拍](material-image://image-1)",
  "",
  "## 选购要点",
  "",
  "![环境照](material-image://image-2)",
  "",
  "- 预算先行",
].join("\n");

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

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

// 重试用例共用时序脚手架：点击「重试本篇」并冲刷 fire-and-forget 的
// POST 返回（fake timers 下微任务随 advance(0) 排空）。
async function clickRetry(card: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(card).getByRole("button", { name: /重试本篇/ }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

// 推过 3s 轮询窗口：新投影到达并完成落定派生的两级渲染冲刷。
async function advancePastPollWindow() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_100);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.loadBody.mockReset();
  mocks.loadLatest.mockReset().mockResolvedValue(null);
  mocks.edit.mockReset();
  mocks.approve.mockReset();
  mocks.discard.mockReset();
  mocks.retry.mockReset();
  mocks.fetchImage.mockReset().mockResolvedValue({ mediaType: "image/png", bytes: pngBytes() });
  mocks.createObjectURL.mockReset().mockImplementation(() => `blob:gate-${Math.random()}`);
  mocks.revokeObjectURL.mockReset();
  if (!("createObjectURL" in URL)) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: mocks.createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: mocks.revokeObjectURL,
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
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

  it("splits blocking and advisory review issues into separate sections (ADR-0009)", () => {
    const article = makeArticle({
      currentVersion: {
        revision: 3,
        title: "成都车载音响选购指南",
        bodyPath: "operations/operation-17/articles/article-1/v3.md",
        bodySha256: "hash",
        origin: "generated",
        basedOnRevision: 2,
        review: {
          policyVersion: "xiaojing-content-prompt-v7",
          passed: false,
          issues: [
            {
              source: "deterministic",
              category: "geo-citability",
              severity: "blocking",
              message: "格式契约不满足：guide 类型至少需要 3 个 H2（当前 2）。",
            },
            {
              source: "deterministic",
              category: "advertising-law",
              severity: "advisory",
              message: "检测到广告法或模板禁用表达：最好、领先",
            },
          ],
        },
        createdAt: "2026-08-18T00:00:00Z",
        approvedAt: null,
      },
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([article]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    expect(
      within(card).getByText(/guide 类型至少需要 3 个 H2/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/发布前建议人工处理（不影响批准）/),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(/检测到广告法或模板禁用表达/),
    ).toBeInTheDocument();
  });

  it("keeps advisory warnings visible even when the review passed", () => {
    const article = makeArticle({
      currentVersion: {
        revision: 3,
        title: "成都车载音响选购指南",
        bodyPath: "operations/operation-17/articles/article-1/v3.md",
        bodySha256: "hash",
        origin: "generated",
        basedOnRevision: 2,
        review: {
          policyVersion: "xiaojing-content-prompt-v7",
          passed: true,
          issues: [
            {
              source: "deterministic",
              category: "fact-consistency",
              severity: "advisory",
              message: "正文硬主张没有已批准事实依据：成立10年",
            },
          ],
        },
        createdAt: "2026-08-18T00:00:00Z",
        approvedAt: null,
      },
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([article]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    expect(
      within(card).getByText(/正文硬主张没有已批准事实依据/),
    ).toBeInTheDocument();
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
        name: "编辑源文 成都车载音响选购指南",
      }),
    );
    const textarea = within(card).getByRole("textbox", {
      name: "编辑源文输入 成都车载音响选购指南",
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
    expect(
      within(card).getByRole("heading", { name: "新标题" }),
    ).toBeInTheDocument();
    expect(
      within(card).queryByRole("textbox", { name: /编辑源文输入/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "批准所选（1 篇）" }));
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
        name: "编辑源文 成都车载音响选购指南",
      }),
    );
    fireEvent.change(
      within(card).getByRole("textbox", {
        name: "编辑源文输入 成都车载音响选购指南",
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
      within(card).getByRole("button", { name: "批准所选（2 篇）" }),
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
      within(card).queryByRole("button", { name: /批准所选/ }),
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
      within(card).getByRole("button", { name: "批准所选（2 篇）" }),
    );
    await waitFor(() =>
      expect(within(card).getByText(/部分文章未能批准/)).toBeInTheDocument(),
    );
    expect(
      within(card).getByText(/article_generation_revision_conflict/),
    ).toBeInTheDocument();
    expect(within(card).getByText(/已批准 1\/2/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "批准所选（1 篇）" }),
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
      within(card).getByRole("button", { name: "批准所选（1 篇）" }),
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
      within(card).queryByRole("button", { name: /批准所选/ }),
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

  // 重试是 fire-and-forget：retry 返回 claim 前旧快照（仍是失败态、
  // attempt 未变），行内翻「重新生成中」并收起旧失败原因；整批无待审稿
  // 时轮询也必须跑（票据开启），投递 attempt 递增的新稿后自动退出等待。
  it("flips the failed row to regenerating and adopts the polled draft", async () => {
    vi.useFakeTimers();
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      generationAttempt: 1,
      approvedRevision: null,
      failureReason: "article_generation_ranking_output_invalid:实体集合不符",
      currentVersion: null,
    });
    // 服务端契约：retry 路由返回的是 claim 之前的旧投影。
    mocks.retry.mockResolvedValue(failed);
    const recovered = makeArticle({
      status: "draft_ready",
      revision: 1,
      generationAttempt: 2,
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
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    await clickRetry(card);
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      { operationId: "operation-17", articleId: "article-1", expectedRevision: 0 },
    );
    expect(within(card).getByText(/重新生成中/)).toBeInTheDocument();
    expect(within(card).queryByText(/实体集合不符/)).not.toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeDisabled();

    // 3s 轮询投递新稿（attempt 2 落定）→ 退出等待、进入待审。
    mocks.loadLatest.mockResolvedValue({
      ...makeOperation([recovered]),
      updatedAt: "2026-08-18T00:02:30Z",
    });
    await advancePastPollWindow();
    expect(within(card).queryByText(/重新生成中/)).not.toBeInTheDocument();
    expect(within(card).getByText(/草稿待审核/)).toBeInTheDocument();
    expect(
      within(card).queryByRole("button", { name: /重试本篇/ }),
    ).not.toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /批准所选（1 篇）/ }),
    ).toBeInTheDocument();
  });

  // 再失败：attempt 递增、revision 不变——同样由轮询送达，翻回「生成失
  // 败」并显示新一轮失败原因，重试入口恢复。
  it("flips back to failed with the new reason when the retry fails again", async () => {
    vi.useFakeTimers();
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      generationAttempt: 1,
      approvedRevision: null,
      failureReason: "provider_unavailable",
      currentVersion: null,
    });
    mocks.retry.mockResolvedValue(failed);
    const failedAgain = makeArticle({
      status: "generation_failed",
      revision: 0,
      generationAttempt: 2,
      approvedRevision: null,
      failureReason: "article_generation_ranking_output_invalid:实体集合不符",
      currentVersion: null,
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    await clickRetry(card);
    expect(within(card).getByText(/重新生成中/)).toBeInTheDocument();

    mocks.loadLatest.mockResolvedValue({
      ...makeOperation([failedAgain]),
      updatedAt: "2026-08-18T00:03:00Z",
    });
    await advancePastPollWindow();
    expect(within(card).queryByText(/重新生成中/)).not.toBeInTheDocument();
    expect(within(card).getByText(/指南 · 生成失败/)).toBeInTheDocument();
    expect(within(card).getByText(/实体集合不符/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeEnabled();
  });

  // 兜底：重生成正常 1–2 分钟；超过 5 分钟未落定时提示「生成时间较长」
  // 并恢复重试入口，等待动画与轮询不中断。
  it("keeps waiting but re-enables retry with a slow hint after 5 minutes", async () => {
    vi.useFakeTimers();
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      approvedRevision: null,
      failureReason: "provider_unavailable",
      currentVersion: null,
    });
    mocks.retry.mockResolvedValue(failed);
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    await clickRetry(card);
    expect(within(card).getByText(/重新生成中/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    expect(within(card).queryByText(/生成时间较长/)).not.toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeDisabled();
    // 票据在途时轮询必须持续运行（整批无 draft_ready 也跑）。
    expect(mocks.loadLatest).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
    });
    expect(
      within(card).getByText(/生成时间较长，可稍候/),
    ).toBeInTheDocument();
    expect(within(card).getByText(/重新生成中/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeEnabled();
  });

  // 本卡票据丢失（卡片重挂载）后再次点击：服务端报在途 → 同样进入等待
  // 态，而不是留在可重复点击的失败态。
  it("enters the waiting state when the server says a retry is already running", async () => {
    vi.useFakeTimers();
    const failed = makeArticle({
      status: "generation_failed",
      revision: 0,
      approvedRevision: null,
      failureReason: "provider_unavailable",
      currentVersion: null,
    });
    mocks.retry.mockRejectedValue(new Error("article_retry_in_progress"));
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([failed]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    await clickRetry(card);
    expect(within(card).getByText(/重试已在进行中/)).toBeInTheDocument();
    expect(within(card).getByText(/重新生成中/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /重试本篇/ }),
    ).toBeDisabled();
  });

  // 共识 Q1：重试进行中只影响本篇——同卡另一篇待审稿的预览与批准入口
  // 不受干扰。
  it("keeps other articles interactive while one is regenerating", async () => {
    vi.useFakeTimers();
    const ready = makeArticle({ id: "article-ready" });
    const failed = makeArticle({
      id: "article-failed",
      status: "generation_failed",
      revision: 0,
      approvedRevision: null,
      failureReason: "provider_unavailable",
      currentVersion: null,
    });
    mocks.retry.mockResolvedValue(failed);
    render(
      <ArticleApprovalGateCard
        data={{
          kind: "article-operation",
          operation: makeOperation([ready, failed]),
        }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });

    await clickRetry(card);
    expect(within(card).getByText(/重新生成中/)).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /查看正文/ }),
    ).toBeEnabled();
    expect(
      within(card).getByRole("button", { name: /批准所选（1 篇）/ }),
    ).toBeEnabled();
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

  // #16 AC1：展开默认是渲染预览；占位符经材料内容取回（mock）换本地 blob
  // 显示为图片，不出现裸文本 scheme。
  it("expands to a rendered preview by default with placeholders as blob images", async () => {
    mocks.loadBody.mockResolvedValue({
      articleId: "article-1",
      revision: 3,
      title: "成都车载音响选购指南",
      body: BODY_WITH_IMAGES,
      approved: false,
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([makeArticle()]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    fireEvent.click(
      within(card).getByRole("button", { name: "查看正文 成都车载音响选购指南" }),
    );

    const images = await waitFor(() => {
      const found = within(card).getAllByRole("img");
      expect(found).toHaveLength(2);
      return found;
    });
    expect(images[0]).toHaveAttribute("src", expect.stringMatching(/^blob:gate-/));
    expect(images[0]).toHaveAttribute("alt", "产品实拍");
    expect(images[1]).toHaveAttribute("alt", "环境照");
    expect(
      within(card).getByRole("heading", { level: 2, name: "选购要点" }),
    ).toBeInTheDocument();
    expect(card.textContent).not.toContain("material-image:");
    expect(mocks.fetchImage).toHaveBeenCalledTimes(2);
  });

  // #16 AC2：预览/编辑源文切换；编辑态删除占位符行保存后，预览不再有该图
  // （删占位符行即删图），blob 被回收。
  it("deletes the placeholder line in edit mode and the saved preview drops that image", async () => {
    mocks.loadBody.mockResolvedValue({
      articleId: "article-1",
      revision: 3,
      title: "成都车载音响选购指南",
      body: BODY_WITH_IMAGES,
      approved: false,
    });
    const edited = makeArticle({
      revision: 4,
      currentVersion: {
        revision: 4,
        title: "成都车载音响选购指南",
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
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([makeArticle()]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    fireEvent.click(
      within(card).getByRole("button", { name: "查看正文 成都车载音响选购指南" }),
    );
    fireEvent.click(
      await within(card).findByRole("button", { name: "编辑源文 成都车载音响选购指南" }),
    );

    const textarea = within(card).getByRole("textbox", {
      name: "编辑源文输入 成都车载音响选购指南",
    });
    expect(textarea).toHaveValue(BODY_WITH_IMAGES);
    // 删除第二张占位符所在的行（「删掉第二张图」的手动路径）。
    const revised = BODY_WITH_IMAGES
      .split("\n")
      .filter((line) => line !== "![环境照](material-image://image-2)")
      .join("\n");
    fireEvent.change(textarea, { target: { value: revised } });
    fireEvent.click(within(card).getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(mocks.edit).toHaveBeenCalledTimes(1));
    expect(mocks.edit.mock.calls[0][2].body).not.toContain("material-image://image-2");
    await waitFor(() =>
      expect(within(card).getAllByRole("img")).toHaveLength(1),
    );
    expect(within(card).getByRole("img", { name: "产品实拍" })).toBeInTheDocument();
    expect(
      within(card).queryByRole("img", { name: "环境照" }),
    ).not.toBeInTheDocument();
    // revoke 与图片从 DOM 消失同拍（useMaterialImages effect 体内执行），
    // 但断言仍走 waitFor：不把正确性押在渲染调度的时序细节上。
    await waitFor(() => expect(mocks.revokeObjectURL).toHaveBeenCalled());
  });

  // #16 AC3：聊天闸门修订（「删掉第二张图」类指令作用于占位符）——3s 轮询
  // 投递新版本投影，卡片重渲染并按新 revision 重拉正文：第二张图消失，
  // 仅对仍在正文的占位符做内容取回。
  it("re-renders the preview from the chat-revised body, dropping the deleted image", async () => {
    vi.useFakeTimers();
    const initial = makeArticle();
    const revised = makeArticle({
      revision: 4,
      currentVersion: {
        revision: 4,
        title: "成都车载音响选购指南",
        bodyPath: "operations/operation-17/articles/article-1/v4.md",
        bodySha256: "hash-4",
        origin: "generated",
        basedOnRevision: 3,
        review: null,
        createdAt: "2026-08-18T00:02:00Z",
        approvedAt: null,
      },
    });
    mocks.loadBody.mockResolvedValueOnce({
      articleId: "article-1",
      revision: 3,
      title: "成都车载音响选购指南",
      body: BODY_WITH_IMAGES,
      approved: false,
    });
    render(
      <ArticleApprovalGateCard
        data={{ kind: "article-operation", operation: makeOperation([initial]) }}
      />,
    );
    const card = screen.getByRole("region", { name: "文章审核批准" });
    await act(async () => {
      fireEvent.click(
        within(card).getByRole("button", { name: "查看正文 成都车载音响选购指南" }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(card).getAllByRole("img")).toHaveLength(2);

    // 聊天修订产出新版本（updatedAt 变化驱动轮询投递）。
    mocks.loadLatest.mockResolvedValue({
      ...makeOperation([revised]),
      updatedAt: "2026-08-18T00:02:30Z",
    });
    const revisedBody = BODY_WITH_IMAGES
      .split("\n")
      .filter((line) => line !== "![环境照](material-image://image-2)")
      .join("\n");
    mocks.loadBody.mockResolvedValueOnce({
      articleId: "article-1",
      revision: 4,
      title: "成都车载音响选购指南",
      body: revisedBody,
      approved: false,
    });

    // 3s 轮询窗口过后：新版本到达 → 正文按新 revision 重拉 → 第二张图消失。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100);
    });
    expect(mocks.loadBody).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(within(card).getAllByRole("img")).toHaveLength(1);
    expect(within(card).getByRole("img", { name: "产品实拍" })).toBeInTheDocument();
    expect(
      within(card).queryByRole("img", { name: "环境照" }),
    ).not.toBeInTheDocument();
    // 取回次数：初始 2 张 + 修订重挂载后对仅存占位符（image-1）重取 1 次
    // （旧实例卸载时 blob 已回收，重挂载必须重取，不泄漏也不复用失效 URL）。
    expect(mocks.fetchImage).toHaveBeenCalledTimes(3);
  });

  // 票 #34：待审稿默认全选；取消勾选的篇目不随「批准所选」提交。
  it("approves only checked pending articles and leaves unchecked ones pending", async () => {
    const first = makeArticle();
    const second = makeArticle({ id: "article-2" });
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

    // 默认全选：按钮计数覆盖全部待审稿。
    expect(
      within(card).getByRole("button", { name: "批准所选（2 篇）" }),
    ).toBeInTheDocument();

    // 两篇同名标题 → 用 getAllBy 定位第一个 checkbox（article-1）。
    const checkboxes = within(card).getAllByRole("checkbox", {
      name: "选择批准 成都车载音响选购指南",
    });
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0]).not.toBeChecked();
    expect(
      within(card).getByRole("button", { name: "批准所选（1 篇）" }),
    ).toBeInTheDocument();

    fireEvent.click(
      within(card).getByRole("button", { name: "批准所选（1 篇）" }),
    );
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1));
    expect(mocks.approve).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      {
        operationId: "operation-17",
        articleId: "article-2",
        expectedRevision: 3,
      },
    );
    // 未勾选篇目留在待审：按钮回落到「批准所选（0 篇）」并禁用，卡片不进终态。
    expect(within(card).queryByText(/已全部批准/)).not.toBeInTheDocument();
    const idleButton = within(card).getByRole("button", {
      name: "批准所选（0 篇）",
    });
    expect(idleButton).toBeDisabled();
  });

  // 票 #34：明确不要的稿走两步确认弃用，终态不进分发；批准 + 弃用收束
  // 后卡片呈现「已全部处理」。
  it("discards an unwanted draft via two-step confirm and settles the card", async () => {
    const first = makeArticle();
    const second = makeArticle({ id: "article-2" });
    mocks.discard.mockResolvedValue(
      makeArticle({ id: "article-1", status: "discarded" }),
    );
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

    // 第一步「不要这篇」只进入确认态，不调用接口。
    fireEvent.click(
      within(card).getAllByRole("button", { name: /不要这篇/ })[0],
    );
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(
      within(card).getAllByRole("button", { name: /确认不要/ })[0],
    ).toBeInTheDocument();

    // 「算了」退回；再次确认才真正弃用。
    fireEvent.click(within(card).getAllByRole("button", { name: "算了" })[0]);
    expect(mocks.discard).not.toHaveBeenCalled();
    fireEvent.click(
      within(card).getAllByRole("button", { name: /不要这篇/ })[0],
    );
    fireEvent.click(
      within(card).getAllByRole("button", { name: /确认不要/ })[0],
    );
    await waitFor(() => expect(mocks.discard).toHaveBeenCalledTimes(1));
    expect(mocks.discard).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-17", sessionId: "session-17" },
      {
        operationId: "operation-17",
        articleId: "article-1",
        expectedRevision: 3,
      },
    );
    expect(within(card).getByText(/已弃用，不进入分发/)).toBeInTheDocument();

    // 弃用稿不再渲染勾选；批准其余稿后卡片收束为已全部处理。
    expect(
      within(card).getAllByRole("checkbox", {
        name: "选择批准 成都车载音响选购指南",
      }),
    ).toHaveLength(1);
    fireEvent.click(
      within(card).getByRole("button", { name: "批准所选（1 篇）" }),
    );
    await waitFor(() =>
      expect(
        within(card).getByText(/已全部处理（批准 1 · 弃用 1）/),
      ).toBeInTheDocument(),
    );
    expect(
      within(card).queryByRole("button", { name: /批准所选/ }),
    ).not.toBeInTheDocument();
  });
});
