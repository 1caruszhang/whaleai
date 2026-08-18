import type {
  GeoDashboardDrilldown,
  GeoDashboardEvidenceKind,
  GeoDashboardFilter,
  GeoDashboardProjection,
} from "../../shared/geo/dashboard";

export type GeoDashboardApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface DashboardResponse {
  success: boolean;
  dashboard?: GeoDashboardProjection;
  drilldown?: GeoDashboardDrilldown;
  error?: string;
}

export async function loadGeoDashboard(
  apiPost: GeoDashboardApiPost,
  identity: { workspaceId: string; sessionId: string },
  filters: GeoDashboardFilter,
): Promise<GeoDashboardProjection> {
  const response = await apiPost<DashboardResponse>(
    "/api/xiaojing/geo-dashboard/get",
    { ...identity, filters },
  );
  if (!response.success || !response.dashboard) {
    throw new Error(response.error ?? "geo_dashboard_load_failed");
  }
  return response.dashboard;
}

export async function loadGeoDashboardDrilldown(
  apiPost: GeoDashboardApiPost,
  identity: { workspaceId: string; sessionId: string },
  input: { kind: GeoDashboardEvidenceKind; id: string },
): Promise<GeoDashboardDrilldown> {
  const response = await apiPost<DashboardResponse>(
    "/api/xiaojing/geo-dashboard/drilldown",
    { ...identity, ...input },
  );
  if (!response.success || !response.drilldown) {
    throw new Error(response.error ?? "geo_dashboard_drilldown_failed");
  }
  return response.drilldown;
}
