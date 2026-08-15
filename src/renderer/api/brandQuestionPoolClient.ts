import type {
  QuestionPoolDecision,
  QuestionPoolGenerationParameters,
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

function requirePool<T>(response: QuestionPoolResponse<T>): T {
  if (!response.success || response.pool == null) {
    throw new Error(response.error ?? "question_pool_not_found");
  }
  return response.pool;
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

export function generateQuestionPool(
  apiPost: QuestionPoolApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    productLine: string;
    targetRegion: string;
    idempotencyKey: string;
    generationParameters?: Partial<QuestionPoolGenerationParameters>;
    retry?: boolean;
  },
  signal?: AbortSignal,
): Promise<QuestionPoolProjection> {
  return apiPost<QuestionPoolResponse<QuestionPoolProjection>>(
    "/api/xiaojing/question-pools/generate",
    { ...identity, ...input },
    { signal },
  ).then(requirePool);
}

export function cancelQuestionPool(
  apiPost: QuestionPoolApiPost,
  identity: { workspaceId: string; sessionId: string },
  idempotencyKey: string,
): Promise<QuestionPoolProjection> {
  return apiPost<QuestionPoolResponse<QuestionPoolProjection>>(
    "/api/xiaojing/question-pools/cancel",
    { ...identity, idempotencyKey },
  ).then(requirePool);
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
