import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { loadBrandHistory } from "./brandHistoryClient";

describe("brandHistoryClient", () => {
  beforeEach(() => invokeMock.mockReset());

  it("queries the exact BrandWorkspace through the Rust authority", async () => {
    invokeMock.mockResolvedValue({
      workspaceId: "brand-17",
      knowledgeVersions: [],
      artifacts: [],
    });

    await loadBrandHistory("brand-17");

    expect(invokeMock).toHaveBeenCalledWith("cmd_brand_workspace_history", {
      workspaceId: "brand-17",
    });
  });
});
