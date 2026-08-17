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
