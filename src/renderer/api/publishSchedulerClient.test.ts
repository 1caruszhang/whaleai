import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  loadPublishExecution,
  startPublishExecution,
  type PublishSchedulerApiPost,
} from "./publishSchedulerClient";

describe("publishSchedulerClient", () => {
  it("keeps exact execution ids when re-reading a targeted execution", async () => {
    const apiPostMock = vi.fn(async (path: string, body: unknown) => {
      const input = body as { executionId?: string };
      return { success: true, execution: { id: input.executionId } };
    });
    const apiPost = apiPostMock as unknown as PublishSchedulerApiPost;
    const identity = { workspaceId: "brand-13", sessionId: "session-a" };
    const exactA = await loadPublishExecution(apiPost, identity, "execution-plan-a");
    expect(exactA.id).toBe("execution-plan-a");
    expect(apiPostMock).toHaveBeenLastCalledWith(
      "/api/xiaojing/publish-scheduler/get",
      { ...identity, executionId: "execution-plan-a" },
    );
  });

  it("starts only the exact independently confirmed execution revision", async () => {
    mocks.invoke.mockResolvedValue({ id: "execution-13", revision: 3 });
    await startPublishExecution(
      { workspaceId: "brand-13", sessionId: "session-13" },
      { executionId: "execution-13", expectedRevision: 2 },
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "cmd_publish_execution_start_ui",
      {
        workspaceId: "brand-13",
        sessionId: "session-13",
        input: { executionId: "execution-13", expectedRevision: 2 },
      },
    );
  });
});
