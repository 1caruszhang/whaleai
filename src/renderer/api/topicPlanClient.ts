import type {
  TopicPlanConfirmation,
  TopicPlanProjection,
} from "../../shared/geo/topicPlan";

export type TopicPlanApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface TopicPlanResponse {
  success: boolean;
  plan?: TopicPlanProjection | null;
  confirmation?: TopicPlanConfirmation;
  error?: string;
}

export async function loadLatestTopicPlan(
  apiPost: TopicPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  confirmedOnly = false,
): Promise<TopicPlanProjection | null> {
  const response = await apiPost<TopicPlanResponse>(
    "/api/xiaojing/topic-plans/latest",
    { ...identity, confirmedOnly },
  );
  if (!response.success) {
    throw new Error(response.error ?? "topic_plan_load_failed");
  }
  return response.plan ?? null;
}

export async function confirmTopicPlan(
  apiPost: TopicPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    planId: string;
    expectedRevision: number;
    selectedItemIds: string[];
  },
): Promise<TopicPlanConfirmation> {
  const response = await apiPost<TopicPlanResponse>(
    "/api/xiaojing/topic-plans/confirm",
    { ...identity, ...input },
  );
  if (!response.success || !response.confirmation) {
    throw new Error(response.error ?? "topic_plan_confirmation_failed");
  }
  return response.confirmation;
}
