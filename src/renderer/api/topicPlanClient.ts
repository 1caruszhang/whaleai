import type {
  TopicPlanCardItem,
  TopicPlanCardProjection,
  TopicPlanConfirmation,
  TopicPlanItem,
  TopicPlanMutationResult,
} from "../../shared/geo/topicPlan";

export type TopicPlanApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface TopicPlanResponse {
  success: boolean;
  /** /latest 已切卡片瘦身投影（审计字段与事实载体剔除）。 */
  plan?: TopicPlanCardProjection | null;
  confirmation?: TopicPlanConfirmation;
  error?: string;
}

interface TopicPlanItemsResponse {
  success: boolean;
  result?: TopicPlanMutationResult;
  error?: string;
}

export async function loadLatestTopicPlan(
  apiPost: TopicPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  confirmedOnly = false,
): Promise<TopicPlanCardProjection | null> {
  const response = await apiPost<TopicPlanResponse>(
    "/api/xiaojing/topic-plans/latest",
    { ...identity, confirmedOnly },
  );
  if (!response.success) {
    throw new Error(response.error ?? "topic_plan_load_failed");
  }
  return response.plan ?? null;
}

export async function saveTopicPlanItems(
  apiPost: TopicPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    planId: string;
    expectedRevision: number;
    items: TopicPlanItem[] | TopicPlanCardItem[];
  },
): Promise<TopicPlanMutationResult> {
  const response = await apiPost<TopicPlanItemsResponse>(
    "/api/xiaojing/topic-plans/items",
    { ...identity, ...input },
  );
  if (!response.success || !response.result) {
    throw new Error(response.error ?? "topic_plan_items_save_failed");
  }
  return response.result;
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
