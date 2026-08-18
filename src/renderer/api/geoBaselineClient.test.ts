import { describe, expect, it, vi } from "vitest";

import {
  loadGeoBaselineEngines,
  loadLatestGeoBaseline,
  retryGeoBaselineUnits,
  startGeoBaseline,
  type GeoBaselineApiPost,
} from "./geoBaselineClient";

describe("geoBaselineClient", () => {
  it("keeps every mutation on the current Tab control-plane apiPost", async () => {
    const apiPostMock = vi
      .fn()
      .mockResolvedValueOnce({ success: true, engines: [] })
      .mockResolvedValueOnce({ success: true, baseline: null })
      .mockResolvedValueOnce({ success: true, baseline: { id: "baseline-09" } })
      .mockResolvedValueOnce({ success: true, baseline: { id: "baseline-09" } });
    const apiPost = apiPostMock as unknown as GeoBaselineApiPost;
    const identity = { workspaceId: "brand-09", sessionId: "session-09" };

    await loadGeoBaselineEngines(apiPost, identity);
    await loadLatestGeoBaseline(apiPost, identity);
    await startGeoBaseline(apiPost, identity, {
      questionPoolId: "pool-08",
      engineIds: ["doubao"],
      idempotencyKey: "request-09",
    });
    await retryGeoBaselineUnits(apiPost, identity, {
      baselineId: "baseline-09",
      unitIds: ["unit-failed"],
    });

    expect(apiPostMock.mock.calls).toEqual([
      ["/api/xiaojing/geo-baselines/engines", identity],
      ["/api/xiaojing/geo-baselines/latest", identity],
      [
        "/api/xiaojing/geo-baselines/start",
        { ...identity, questionPoolId: "pool-08", engineIds: ["doubao"], idempotencyKey: "request-09" },
      ],
      [
        "/api/xiaojing/geo-baselines/retry",
        { ...identity, baselineId: "baseline-09", unitIds: ["unit-failed"] },
      ],
    ]);
  });
});
