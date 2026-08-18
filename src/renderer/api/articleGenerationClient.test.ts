import { describe, expect, it, vi } from "vitest";

import {
  type ArticleApiPost,
  approveArticle,
  editArticle,
  loadArticleOperation,
  loadArticleBody,
} from "./articleGenerationClient";

describe("articleGenerationClient", () => {
  it("loads one exact Operation without falling back to latest", async () => {
    const apiPostMock = vi.fn(async () => ({
      success: true,
      operation: { id: "operation-exact" },
    }));
    await loadArticleOperation(
      apiPostMock as unknown as ArticleApiPost,
      { workspaceId: "workspace-1", sessionId: "session-1" },
      "operation-exact",
    );
    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/xiaojing/articles/operation/get",
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        operationId: "operation-exact",
      },
    );
  });

  it("keeps exact operation/article identity and revision on every request", async () => {
    const article = { id: "article-1" };
    const apiPostMock = vi.fn(async (path: string, _body?: unknown) =>
      path.endsWith("/body")
        ? { success: true, body: { articleId: "article-1", revision: 2, body: "正文" } }
        : { success: true, article },
    );
    const apiPost = apiPostMock as unknown as ArticleApiPost;
    const identity = { workspaceId: "workspace-1", sessionId: "session-1" };
    const exact = {
      operationId: "operation-1",
      articleId: "article-1",
      expectedRevision: 2,
    };
    await approveArticle(apiPost, identity, exact);
    await loadArticleBody(apiPost, identity, exact);
    for (const call of apiPostMock.mock.calls) {
      expect(call[1]).toMatchObject({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        operationId: "operation-1",
        articleId: "article-1",
      });
    }
  });

  it("edits one exact article with its identity, revision, title and body", async () => {
    const apiPostMock = vi.fn(async () => ({
      success: true,
      article: { id: "article-1" },
    }));
    await editArticle(
      apiPostMock as unknown as ArticleApiPost,
      { workspaceId: "workspace-1", sessionId: "session-1" },
      {
        operationId: "operation-1",
        articleId: "article-1",
        expectedRevision: 2,
        title: "成都车载音响选购指南",
        body: "# 成都车载音响选购指南\n\n正文",
      },
    );
    expect(apiPostMock).toHaveBeenCalledWith(
      "/api/xiaojing/articles/edit",
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        operationId: "operation-1",
        articleId: "article-1",
        expectedRevision: 2,
        title: "成都车载音响选购指南",
        body: "# 成都车载音响选购指南\n\n正文",
      },
    );
  });
});
