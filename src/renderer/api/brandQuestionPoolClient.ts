import type {
  QuestionPoolDecision,
  QuestionPoolProjection,
  QuestionPoolQuestion,
} from "../../shared/geo/questionPool";

export type QuestionPoolApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface QuestionPoolResponse<T> {
  success: boolean;
  pool?: T | null;
  decision?: T;
  error?: string;
}

export async function loadLatestQuestionPool(
  apiPost: QuestionPoolApiPost,
  identity: { workspaceId: string; sessionId: string },
  productLine?: string,
): Promise<QuestionPoolProjection | null> {
  const response = await apiPost<QuestionPoolResponse<QuestionPoolProjection>>(
    "/api/xiaojing/question-pools/latest",
    { ...identity, productLine },
  );
  if (!response.success)
    throw new Error(response.error ?? "question_pool_load_failed");
  return response.pool ?? null;
}

export async function confirmQuestionPool(
  apiPost: QuestionPoolApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    poolId: string;
    expectedRevision: number;
    questions: QuestionPoolQuestion[];
  },
): Promise<QuestionPoolDecision> {
  const response = await apiPost<QuestionPoolResponse<QuestionPoolDecision>>(
    "/api/xiaojing/question-pools/confirm",
    { ...identity, ...input },
  );
  if (!response.success || !response.decision) {
    throw new Error(response.error ?? "question_pool_confirm_failed");
  }
  return response.decision;
}

/**
 * 「重新生成问题池」按钮（复用契约 2026-09-01 修订）：跳过零成本复用、
 * 强制重新联网挖掘（真实 provider 花费）。返回全新的 awaiting-selection
 * 池，调用方以正常选择流程呈现。
 */
export async function regenerateQuestionPool(
  apiPost: QuestionPoolApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    productLine: string;
    targetRegion: string;
    idempotencyKey: string;
  },
): Promise<QuestionPoolProjection> {
  const response = await apiPost<QuestionPoolResponse<QuestionPoolProjection>>(
    "/api/xiaojing/question-pools/generate",
    { ...identity, ...input, regenerate: true },
  );
  if (!response.success || !response.pool) {
    throw new Error(response.error ?? "question_pool_regenerate_failed");
  }
  return response.pool;
}
