import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("real GEO dashboard production boundary", () => {
  it("does not import demo data, random values, localhost fetch or mutation routes", () => {
    const files = [
      "src/shared/geo/dashboard.ts",
      "src/server/geo/dashboard.ts",
      "src/renderer/api/geoDashboardClient.ts",
      "src/renderer/components/xiaojing/XiaojingRealGeoDashboard.tsx",
    ];
    const source = files
      .map((file) => readFileSync(join(root, file), "utf8"))
      .join("\n");
    for (const forbidden of [
      "geoDemoData",
      "DEMO_",
      "Math.random",
      "localhost",
      "127.0.0.1",
      "publish-scheduler/start",
      "post-publish-monitor/activate",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("registers exact read-only Node routes with current Tab identity checks", () => {
    const source = readFileSync(join(root, "src/server/routes/xiaojing-effects.ts"), "utf8");
    expect(source).toContain("/api/xiaojing/geo-dashboard/get");
    expect(source).toContain("/api/xiaojing/geo-dashboard/drilldown");
    expect(source).toContain("geo_dashboard_identity_mismatch");
    expect(source).toContain("payload.sessionId !== runtimeSessionId");
  });
});
