import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ managementApi: vi.fn() }));

vi.mock("../utils/management-api-client", () => ({
  managementApi: mocks.managementApi,
}));

import { RustPublishSchedulerPort } from "./publish-scheduler";

describe("RustPublishSchedulerPort", () => {
  beforeEach(() => mocks.managementApi.mockReset());

  it("is a thin authenticated control-plane port and never receives a body or secret", async () => {
    const execution = { id: "execution-13" };
    mocks.managementApi.mockResolvedValue({ ok: true, execution });
    const port = new RustPublishSchedulerPort({
      workspaceId: "brand-13",
      sessionId: "session-13",
      sidecarId: "sidecar-13",
    });
    await expect(port.preview("plan-13")).resolves.toBe(execution);
    expect(mocks.managementApi).toHaveBeenCalledWith(
      "/api/brand-publish-scheduler/preview",
      "POST",
      {
        workspaceId: "brand-13",
        sessionId: "session-13",
        sidecarId: "sidecar-13",
        payload: { planId: "plan-13" },
      },
    );
    expect(JSON.stringify(mocks.managementApi.mock.calls)).not.toContain("body");
    expect(JSON.stringify(mocks.managementApi.mock.calls)).not.toContain("secret");
  });

  it("does not expose paid-action confirm, start or retry routes to the Sidecar", () => {
    const server = readFileSync(
      fileURLToPath(new URL("../routes/xiaojing-effects.ts", import.meta.url)),
      "utf8",
    );
    const management = readFileSync(
      fileURLToPath(
        new URL("../../../src-tauri/src/management_api.rs", import.meta.url),
      ),
      "utf8",
    );
    for (const action of ["confirm", "start", "retry"]) {
      expect(server).not.toContain(`/api/xiaojing/publish-scheduler/${action}`);
      expect(management).not.toContain(
        `/api/brand-publish-scheduler/${action}`,
      );
    }
    expect(server).toContain("/api/xiaojing/publish-scheduler/preview");
    expect(server).toContain("/api/xiaojing/publish-scheduler/get");
  });
});
