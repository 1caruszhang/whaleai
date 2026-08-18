import { describe, expect, it, vi } from "vitest";

import {
  loadGeoBaselineEngines,
  loadLatestGeoBaseline,
  retryGeoBaselineUnits,
  startGeoBaseline,
  type GeoBaselineApiPost,
} from "./geoBaselineClient";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("geoBaselineClient", () => {
  it("keeps every execution call on the current Tab control-plane apiPost", async () => {
    const apiPostMock = vi
      .fn()
      .mockResolvedValueOnce({ success: true, engines: [] })
      .mockResolvedValueOnce({ success: true, baseline: { id: "baseline-09" } })
      .mockResolvedValueOnce({ success: true, baseline: { id: "baseline-09" } });
    const apiPost = apiPostMock as unknown as GeoBaselineApiPost;
    const identity = { workspaceId: "brand-09", sessionId: "session-09" };

    await loadGeoBaselineEngines(apiPost, identity);
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

  it("reads the latest baseline over session-free Rust IPC", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({ id: "baseline-09" });

    const baseline = await loadLatestGeoBaseline("brand-09");

    expect(baseline).toEqual({ id: "baseline-09" });
    expect(invokeMock).toHaveBeenCalledWith("cmd_geo_baseline_latest_ui", {
      workspaceId: "brand-09",
    });
  });
});
