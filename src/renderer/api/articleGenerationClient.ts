import type {
  ArticleBodyProjection,
  ArticleOperationProjection,
  ArticleProjection,
} from "../../shared/geo/articleGeneration";

export type ArticleApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface ArticleResponse {
  success: boolean;
  operation?: ArticleOperationProjection | null;
  article?: ArticleProjection;
  body?: ArticleBodyProjection;
  error?: string;
}

function requireOperation(response: ArticleResponse): ArticleOperationProjection {
  if (!response.success || !response.operation) {
    throw new Error(response.error ?? "article_generation_operation_failed");
  }
  return response.operation;
}

function requireArticle(response: ArticleResponse): ArticleProjection {
  if (!response.success || !response.article) {
    throw new Error(response.error ?? "article_generation_article_failed");
  }
  return response.article;
}

export async function loadLatestArticleOperation(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
): Promise<ArticleOperationProjection | null> {
  const response = await apiPost<ArticleResponse>(
    "/api/xiaojing/articles/latest",
    identity,
  );
  if (!response.success) {
    throw new Error(response.error ?? "article_generation_latest_failed");
  }
  return response.operation ?? null;
}

export function loadArticleOperation(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
  operationId: string,
): Promise<ArticleOperationProjection> {
  return apiPost<ArticleResponse>(
    "/api/xiaojing/articles/operation/get",
    { ...identity, operationId },
  ).then(requireOperation);
}

export async function loadArticleBody(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    operationId: string;
    articleId: string;
    revision?: number;
    approved?: boolean;
  },
): Promise<ArticleBodyProjection> {
  const response = await apiPost<ArticleResponse>(
    "/api/xiaojing/articles/body",
    { ...identity, ...input },
  );
  if (!response.success || !response.body) {
    throw new Error(response.error ?? "article_generation_body_failed");
  }
  return response.body;
}

export function editArticle(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    operationId: string;
    articleId: string;
    expectedRevision: number;
    title: string;
    body: string;
  },
): Promise<ArticleProjection> {
  return apiPost<ArticleResponse>(
    "/api/xiaojing/articles/edit",
    { ...identity, ...input },
  ).then(requireArticle);
}

export function approveArticle(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { operationId: string; articleId: string; expectedRevision: number },
): Promise<ArticleProjection> {
  return apiPost<ArticleResponse>(
    "/api/xiaojing/articles/approve",
    { ...identity, ...input },
  ).then(requireArticle);
}

/** 用户显式弃用（票 #34）：draft_ready/生成失败/风险阻断稿可弃，终态不进分发计划；已批准稿不可弃。 */
export function discardArticle(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { operationId: string; articleId: string; expectedRevision: number },
): Promise<ArticleProjection> {
  return apiPost<ArticleResponse>(
    "/api/xiaojing/articles/discard",
    { ...identity, ...input },
  ).then(requireArticle);
}

/** 单篇重试（fire-and-forget：返回 claim 前旧快照，新稿/再失败由 /latest 轮询追上）：generation_failed 的文章逐篇恢复，不重跑整批。 */
export function retryArticle(
  apiPost: ArticleApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { operationId: string; articleId: string; expectedRevision: number },
): Promise<ArticleProjection> {
  return apiPost<ArticleResponse>(
    "/api/xiaojing/articles/retry",
    { ...identity, ...input },
  ).then(requireArticle);
}
