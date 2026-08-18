import { describe, expect, it, vi } from "vitest";

import {
  loadGeoDashboard,
  loadGeoDashboardDrilldown,
  type GeoDashboardApiPost,
} from "./geoDashboardClient";

describe("geoDashboardClient", () => {
  it("uses the current Tab control plane for one exact filtered read", async () => {
    const apiPost = vi.fn(
      async <T>() =>
        ({
          success: true,
          dashboard: { workspaceId: "brand-15" },
        }) as T,
    );
    await loadGeoDashboard(
      apiPost as unknown as GeoDashboardApiPost,
      { workspaceId: "brand-15", sessionId: "session-b" },
      {
        sessionId: "session-a",
        operationId: "publish-op-13",
        from: "2026-08-15T00:00:00Z",
        toExclusive: "2026-08-16T00:00:00Z",
        engineId: "doubao",
      },
    );
    expect(apiPost).toHaveBeenCalledWith("/api/xiaojing/geo-dashboard/get", {
      workspaceId: "brand-15",
      sessionId: "session-b",
      filters: {
        sessionId: "session-a",
        operationId: "publish-op-13",
        from: "2026-08-15T00:00:00Z",
        toExclusive: "2026-08-16T00:00:00Z",
        engineId: "doubao",
      },
    });
  });

  it("loads raw evidence only for one exact drilldown anchor", async () => {
    const apiPost = vi.fn(
      async <T>() =>
        ({
          success: true,
          drilldown: { kind: "baseline-unit", baselineId: "baseline-09" },
        }) as T,
    );
    await loadGeoDashboardDrilldown(
      apiPost as unknown as GeoDashboardApiPost,
      { workspaceId: "brand-15", sessionId: "session-b" },
      { kind: "baseline-unit", id: "unit-09" },
    );
    expect(apiPost).toHaveBeenCalledWith(
      "/api/xiaojing/geo-dashboard/drilldown",
      {
        workspaceId: "brand-15",
        sessionId: "session-b",
        kind: "baseline-unit",
        id: "unit-09",
      },
    );
  });

  it("surfaces a typed server error without inventing fallback data", async () => {
    const apiPost = vi.fn(
      async <T>() =>
        ({
          success: false,
          error: "geo_dashboard_filter_operation_unknown",
        }) as T,
    );
    await expect(
      loadGeoDashboard(
        apiPost as unknown as GeoDashboardApiPost,
        { workspaceId: "brand-15", sessionId: "session-b" },
        { operationId: "cross-brand-operation" },
      ),
    ).rejects.toThrow("geo_dashboard_filter_operation_unknown");
  });
});
