import type {
  GeoOperationProjection,
  GeoOperationReference,
} from "../../shared/geo/operation";

export type GeoOperationApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

export interface GeoOperationIdentity {
  workspaceId: string;
  sessionId: string;
}

export type GeoOperationControlAction = "pause" | "resume" | "retry" | "cancel";

interface GeoOperationResponse {
  success: boolean;
  operation?: GeoOperationProjection;
  operations?: GeoOperationProjection[];
  error?: string;
}

function requireOperation(response: GeoOperationResponse): GeoOperationProjection {
  if (!response.success || !response.operation) {
    throw new Error(response.error ?? "geo_operation_request_failed");
  }
  return response.operation;
}

export async function loadGeoOperations(
  apiPost: GeoOperationApiPost,
  identity: GeoOperationIdentity,
  options: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<GeoOperationProjection[]> {
  const response = await apiPost<GeoOperationResponse>(
    "/api/xiaojing/geo-operations/list",
    { ...identity, ...options },
    { signal },
  );
  if (!response.success) {
    throw new Error(response.error ?? "geo_operation_list_failed");
  }
  return response.operations ?? [];
}

export function loadGeoOperation(
  apiPost: GeoOperationApiPost,
  identity: GeoOperationIdentity,
  operationId: string,
  signal?: AbortSignal,
): Promise<GeoOperationProjection> {
  return apiPost<GeoOperationResponse>(
    "/api/xiaojing/geo-operations/get",
    { ...identity, operationId },
    { signal },
  ).then(requireOperation);
}

export function controlGeoOperation(
  apiPost: GeoOperationApiPost,
  identity: GeoOperationIdentity,
  input: {
    operationId: string;
    expectedRevision: number;
    action: GeoOperationControlAction;
  },
): Promise<GeoOperationProjection> {
  return apiPost<GeoOperationResponse>(
    "/api/xiaojing/geo-operations/control",
    { ...identity, ...input },
  ).then(requireOperation);
}

export function chooseNextRoundKnowledge(
  apiPost: GeoOperationApiPost,
  identity: GeoOperationIdentity,
  input: {
    operationId: string;
    expectedRevision: number;
    updateKnowledge: boolean;
  },
): Promise<GeoOperationProjection> {
  return apiPost<GeoOperationResponse>(
    "/api/xiaojing/geo-operations/choose-next-round-knowledge",
    { ...identity, ...input },
  ).then(requireOperation);
}

export function confirmGeoOperationStep(
  apiPost: GeoOperationApiPost,
  identity: GeoOperationIdentity,
  input: {
    operationId: string;
    expectedRevision: number;
    stepId: string;
    artifactRefs?: GeoOperationReference[];
  },
): Promise<GeoOperationProjection> {
  return apiPost<GeoOperationResponse>(
    "/api/xiaojing/geo-operations/confirm-step",
    { ...identity, ...input },
  ).then(requireOperation);
}
