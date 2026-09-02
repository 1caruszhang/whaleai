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

/**
 * 「重新生成内容计划」按钮（复用停卡重选）：跳过既有计划复用、强制重新
 * 规划（真实 provider 花费）；返回的待决计划按正常流程呈现与确认。
 */
export async function regenerateTopicPlan(
  apiPost: TopicPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { questionPoolId?: string },
): Promise<TopicPlanCardProjection> {
  const response = await apiPost<TopicPlanResponse>(
    "/api/xiaojing/topic-plans/generate",
    { ...identity, ...input, regenerate: true },
  );
  if (!response.success || !response.plan) {
    throw new Error(response.error ?? "topic_plan_regenerate_failed");
  }
  return response.plan;
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
