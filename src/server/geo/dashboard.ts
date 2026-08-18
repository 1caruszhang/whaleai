import {
  applyGeoDashboardProviderAvailability,
  type GeoDashboardDrilldown,
  type GeoDashboardEvidenceKind,
  type GeoDashboardFilter,
  type GeoDashboardProjection,
} from "../../shared/geo/dashboard";
import { managementApi } from "../utils/management-api-client";
import type { GeoKeywordSearchCapability } from "./provider-capabilities";

export type RustGeoDashboardProjection = Omit<
  GeoDashboardProjection,
  "providerEngines"
>;

export interface GeoDashboardPersistencePort {
  get(filters: GeoDashboardFilter): Promise<RustGeoDashboardProjection>;
  drilldown(input: {
    kind: GeoDashboardEvidenceKind;
    id: string;
  }): Promise<GeoDashboardDrilldown>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "geo_dashboard_persistence_failed",
  );
}

export class RustGeoDashboardPort implements GeoDashboardPersistencePort {
  constructor(
    private readonly identity: {
      workspaceId: string;
      sessionId: string;
      sidecarId: string;
    },
  ) {}

  private async post<T>(
    path: string,
    payload: Record<string, unknown>,
    key: string,
  ): Promise<T> {
    const result = await managementApi(path, "POST", {
      ...this.identity,
      payload,
    });
    if (result.ok !== true) throw persistenceError(result);
    return result[key] as T;
  }

  get(filters: GeoDashboardFilter): Promise<RustGeoDashboardProjection> {
    return this.post("/api/brand-geo-dashboard/get", { filters }, "dashboard");
  }

  drilldown(input: {
    kind: GeoDashboardEvidenceKind;
    id: string;
  }): Promise<GeoDashboardDrilldown> {
    return this.post("/api/brand-geo-dashboard/drilldown", input, "drilldown");
  }
}

export class GeoDashboardService {
  constructor(
    private readonly persistence: GeoDashboardPersistencePort,
    private readonly keywordSearch: Pick<
      GeoKeywordSearchCapability,
      "baselineEngines"
    >,
  ) {}

  async get(filters: GeoDashboardFilter): Promise<GeoDashboardProjection> {
    const projection = await this.persistence.get(filters);
    return applyGeoDashboardProviderAvailability(
      projection,
      this.keywordSearch.baselineEngines(),
    );
  }

  drilldown(input: {
    kind: GeoDashboardEvidenceKind;
    id: string;
  }): Promise<GeoDashboardDrilldown> {
    return this.persistence.drilldown(input);
  }
}

export function createGeoDashboardPort(identity: {
  workspaceId: string;
  sessionId: string;
}): RustGeoDashboardPort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error("GEO dashboard requires an authenticated Sidecar identity");
  }
  return new RustGeoDashboardPort({ ...identity, sidecarId });
}
