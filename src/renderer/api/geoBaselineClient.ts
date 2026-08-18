import type {
  GeoBaselineEngineAvailability,
  GeoBaselineEngineId,
  GeoBaselineProjection,
} from "../../shared/geo/baseline";

export type GeoBaselineApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface GeoBaselineResponse {
  success: boolean;
  engines?: GeoBaselineEngineAvailability[];
  baseline?: GeoBaselineProjection | null;
  error?: string;
}

function requireBaseline(response: GeoBaselineResponse): GeoBaselineProjection {
  if (!response.success || !response.baseline) {
    throw new Error(response.error ?? "geo_baseline_not_found");
  }
  return response.baseline;
}

export async function loadGeoBaselineEngines(
  apiPost: GeoBaselineApiPost,
  identity: { workspaceId: string; sessionId: string },
): Promise<GeoBaselineEngineAvailability[]> {
  const response = await apiPost<GeoBaselineResponse>(
    "/api/xiaojing/geo-baselines/engines",
    identity,
  );
  if (!response.success) {
    throw new Error(response.error ?? "geo_baseline_engines_failed");
  }
  return response.engines ?? [];
}

export async function loadLatestGeoBaseline(
  apiPost: GeoBaselineApiPost,
  identity: { workspaceId: string; sessionId: string },
): Promise<GeoBaselineProjection | null> {
  const response = await apiPost<GeoBaselineResponse>(
    "/api/xiaojing/geo-baselines/latest",
    identity,
  );
  if (!response.success) {
    throw new Error(response.error ?? "geo_baseline_load_failed");
  }
  return response.baseline ?? null;
}

export function startGeoBaseline(
  apiPost: GeoBaselineApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: {
    questionPoolId: string;
    engineIds: GeoBaselineEngineId[];
    idempotencyKey: string;
  },
): Promise<GeoBaselineProjection> {
  return apiPost<GeoBaselineResponse>(
    "/api/xiaojing/geo-baselines/start",
    { ...identity, ...input },
  ).then(requireBaseline);
}

export function retryGeoBaselineUnits(
  apiPost: GeoBaselineApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { baselineId: string; unitIds: string[] },
): Promise<GeoBaselineProjection> {
  return apiPost<GeoBaselineResponse>(
    "/api/xiaojing/geo-baselines/retry",
    { ...identity, ...input },
  ).then(requireBaseline);
}
