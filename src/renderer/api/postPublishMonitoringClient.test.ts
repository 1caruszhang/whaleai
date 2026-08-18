import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  activatePostPublishMonitor,
  retryPostPublishMonitorUnit,
} from "./postPublishMonitoringClient";

describe("postPublishMonitoringClient", () => {
  it("carries exact plan revision and exact failed-unit revision through Rust IPC", async () => {
    mocks.invoke.mockResolvedValue({ id: "monitor-14" });
    const identity = { workspaceId: "brand-14", sessionId: "session-14" };
    await activatePostPublishMonitor(identity, { planId: "monitor-14", expectedRevision: 3 });
    expect(mocks.invoke).toHaveBeenCalledWith("cmd_post_publish_monitor_activate_ui", {
      ...identity,
      input: { planId: "monitor-14", expectedRevision: 3 },
    });
    await retryPostPublishMonitorUnit(identity, {
      planId: "monitor-14",
      unitId: "unit-access-14",
      expectedUnitRevision: 7,
    });
    expect(mocks.invoke).toHaveBeenLastCalledWith("cmd_post_publish_monitor_retry_ui", {
      ...identity,
      input: { planId: "monitor-14", unitId: "unit-access-14", expectedUnitRevision: 7 },
    });
  });
});
