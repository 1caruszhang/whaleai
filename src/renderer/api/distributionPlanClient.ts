import type {
  DistributionPlanEditInput,
  DistributionPlanProjection,
} from "../../shared/geo/distributionPlan";

export type DistributionPlanApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface DistributionPlanResponse {
  success: boolean;
  plan?: DistributionPlanProjection | null;
  error?: string;
}

function requirePlan(
  response: DistributionPlanResponse,
): DistributionPlanProjection {
  if (!response.success || !response.plan) {
    throw new Error(response.error ?? "distribution_plan_not_found");
  }
  return response.plan;
}

export async function loadLatestDistributionPlan(
  apiPost: DistributionPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
): Promise<DistributionPlanProjection | null> {
  const response = await apiPost<DistributionPlanResponse>(
    "/api/xiaojing/distribution-plans/latest",
    identity,
  );
  if (!response.success) {
    throw new Error(response.error ?? "distribution_plan_latest_failed");
  }
  return response.plan ?? null;
}

export function editDistributionPlan(
  apiPost: DistributionPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    planId: string;
    expectedRevision: number;
    edit: DistributionPlanEditInput;
  },
): Promise<DistributionPlanProjection> {
  return apiPost<DistributionPlanResponse>(
    "/api/xiaojing/distribution-plans/edit",
    { ...identity, ...input },
  ).then(requirePlan);
}

export function confirmDistributionPlan(
  apiPost: DistributionPlanApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { planId: string; expectedRevision: number },
): Promise<DistributionPlanProjection> {
  return apiPost<DistributionPlanResponse>(
    "/api/xiaojing/distribution-plans/confirm",
    { ...identity, ...input },
  ).then(requirePlan);
}
