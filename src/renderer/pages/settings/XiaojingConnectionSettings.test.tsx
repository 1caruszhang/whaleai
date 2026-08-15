import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { ToastProvider } from "@/components/Toast";
import { GEO_PROVIDER_CAPABILITY_CATALOG } from "../../../shared/geo/providerCapabilities";
import XiaojingConnectionSettings from "./XiaojingConnectionSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const statuses = GEO_PROVIDER_CAPABILITY_CATALOG.map((spec) => ({
  slot: spec.slot,
  state:
    spec.slot === "keyword-search"
      ? ("available" as const)
      : ("unconfigured" as const),
  source:
    spec.slot === "keyword-search"
      ? ("development-env" as const)
      : ("missing" as const),
}));

describe("Xiaojing fixed GEO capability settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "cmd_geo_provider_capability_status") return statuses;
      if (command === "cmd_geo_provider_capability_verify") {
        return {
          slot: "keyword-search",
          state: "rate_limited",
          source: "development-env",
          detail: "服务当前限流，请稍后重试",
        };
      }
      return undefined;
    });
  });

  it("renders exactly eight fixed slots and no generic provider/model market controls", async () => {
    render(
      <ToastProvider>
        <XiaojingConnectionSettings />
      </ToastProvider>,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("cmd_geo_provider_capability_status"),
    );
    for (const spec of GEO_PROVIDER_CAPABILITY_CATALOG) {
      expect(screen.getByText(spec.label)).toBeInTheDocument();
    }
    expect(screen.getAllByText("验证连接")).toHaveLength(8);
    expect(screen.queryByText("添加供应商")).not.toBeInTheDocument();
    expect(screen.queryByText("切换 Runtime")).not.toBeInTheDocument();
  });

  it("projects verifying and rate-limited states without receiving a credential", async () => {
    let finishVerification: ((value: unknown) => void) | undefined;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "cmd_geo_provider_capability_status") return statuses;
      if (command === "cmd_geo_provider_capability_verify") {
        return new Promise((resolve) => {
          finishVerification = resolve;
        });
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <XiaojingConnectionSettings />
      </ToastProvider>,
    );
    const status = await screen.findByTestId(
      "capability-keyword-search-status",
    );
    expect(status).toHaveTextContent("可用");

    const card = status.closest("div.rounded-xl");
    expect(card).not.toBeNull();
    await user.click(card!.querySelector("button")!);

    expect(status).toHaveTextContent("验证中");
    finishVerification?.({
      slot: "keyword-search",
      state: "rate_limited",
      source: "development-env",
      detail: "服务当前限流，请稍后重试",
    });
    await waitFor(() => expect(status).toHaveTextContent("限流"));
    expect(invoke).toHaveBeenCalledWith("cmd_geo_provider_capability_verify", {
      slot: "keyword-search",
    });
    expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toMatch(
      /apiKey|secret/i,
    );
  });
});
