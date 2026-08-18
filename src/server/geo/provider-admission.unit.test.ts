import { describe, expect, it, vi } from "vitest";

import type { GeoProviderCapabilities } from "./provider-capabilities";
import {
  configureGeoProviderAdmission,
  GeoProviderAdmission,
  wrapGeoProviderCapabilities,
} from "./provider-admission";

const moduleMocks = vi.hoisted(() => ({
  managementApi: vi.fn(),
}));

vi.mock("../utils/management-api-client", () => ({
  managementApi: moduleMocks.managementApi,
}));

const identity = {
  workspaceId: "brand-18",
  sessionId: "session-18",
  sidecarId: "sidecar-18",
};

const unavailable = async (): Promise<never> => {
  throw new Error("not used");
};

function baseCapabilities(
  overrides: Partial<GeoProviderCapabilities> = {},
): GeoProviderCapabilities {
  return {
    extraction: { slot: "extraction", complete: unavailable },
    generation: { slot: "generation", complete: unavailable },
    reflection: { slot: "reflection", complete: unavailable },
    keywordSearch: {
      slot: "keyword-search",
      search: unavailable,
      baselineEngines: () => [],
      probeQuestion: unavailable,
    },
    embedding: {
      slot: "embedding",
      dimensions: 1,
      concurrency: 1,
      embed: unavailable,
    },
    objectStorage: { slot: "object-storage", putHtml: unavailable },
    distribution: { slot: "distribution", listResources: unavailable },
    ...overrides,
  };
}

function permit(
  state: "queued" | "acquired",
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    permit: {
      state,
      requestId: "request-18",
      permitToken: state === "acquired" ? "permit-18" : null,
      queueReason:
        state === "queued" ? "全局重型 Provider 并发已达上限（5）" : null,
      queuePosition: state === "queued" ? 2 : null,
      concurrencyLimit: 5,
      activeCount: state === "queued" ? 5 : 4,
      ...overrides,
    },
  };
}

describe("GeoProviderAdmission", () => {
  it("waits in the Rust-owned FIFO queue and releases the exact permit", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(permit("queued"))
      .mockResolvedValueOnce(permit("acquired"))
      .mockResolvedValueOnce({ ok: true, released: true });
    const onQueue = vi.fn();
    const work = vi.fn(async () => "provider-result");
    const admission = new GeoProviderAdmission(identity, {
      post,
      sleep: vi.fn(async () => undefined),
      requestId: () => "request-18",
      onQueue,
    });

    await expect(
      admission.run({
        slot: "generation",
        unitKind: "article",
        unitId: "article-18",
        work,
      }),
    ).resolves.toBe("provider-result");

    expect(onQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        queuePosition: 2,
        queueReason: expect.stringContaining("全局重型 Provider"),
      }),
    );
    expect(work).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.map(([path]) => path)).toEqual([
      "/api/geo-provider-permits/acquire",
      "/api/geo-provider-permits/status",
      "/api/geo-provider-permits/release",
    ]);
    expect(post.mock.calls[2]?.[2]).toMatchObject({
      ...identity,
      payload: { permitToken: "permit-18" },
    });
  });

  it("cancels queued work on abort without invoking the Provider", async () => {
    const controller = new AbortController();
    const post = vi
      .fn()
      .mockResolvedValueOnce(permit("queued"))
      .mockResolvedValueOnce({ ok: true, cancelled: true });
    const work = vi.fn(async () => "never");
    const admission = new GeoProviderAdmission(identity, {
      post,
      sleep: vi.fn(async () => {
        controller.abort(new Error("cancelled"));
        throw controller.signal.reason;
      }),
      requestId: () => "request-18",
    });

    await expect(
      admission.run({
        slot: "keyword-search",
        unitKind: "probe",
        unitId: "probe-18",
        signal: controller.signal,
        work,
      }),
    ).rejects.toThrow("cancelled");
    expect(work).not.toHaveBeenCalled();
    expect(post.mock.calls.map(([path]) => path)).toEqual([
      "/api/geo-provider-permits/acquire",
      "/api/geo-provider-permits/cancel",
    ]);
  });

  it("surfaces bounded resource exhaustion instead of starting unadmitted work", async () => {
    const work = vi.fn(async () => "never");
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        code: "resource_exhausted",
        error: "geo_provider_queue_capacity_exhausted",
      })
      .mockResolvedValueOnce({ ok: true, cancelled: false });
    const admission = new GeoProviderAdmission(identity, {
      post,
      requestId: () => "request-18",
    });

    await expect(
      admission.run({
        slot: "generation",
        unitKind: "article",
        work,
      }),
    ).rejects.toThrow("resource_exhausted");
    expect(work).not.toHaveBeenCalled();
  });

  it("admits every concrete embedding request instead of hiding a batch behind one permit", async () => {
    vi.stubEnv("XIAOJING_SIDECAR_ID", "sidecar-18");
    moduleMocks.managementApi.mockReset();
    moduleMocks.managementApi.mockImplementation(
      async (path: string, _method: string, body: Record<string, unknown>) => {
        const payload = body.payload as Record<string, unknown>;
        if (path.endsWith("/acquire")) {
          return permit("acquired", {
            requestId: payload.requestId,
            permitToken: `permit-${String(payload.requestId)}`,
          });
        }
        return { ok: true, released: true };
      },
    );
    const embed = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => [text.length]),
    );
    const capabilities = baseCapabilities({
      embedding: {
        slot: "embedding",
        dimensions: 1,
        concurrency: 1,
        embed,
      },
    });
    configureGeoProviderAdmission({
      workspacePath: "/brands/brand-18",
      sessionId: "session-18",
    });

    await expect(
      wrapGeoProviderCapabilities(capabilities).embedding.embed(["a", "bb"]),
    ).resolves.toEqual([[1], [2]]);

    expect(embed).toHaveBeenNthCalledWith(1, ["a"], undefined);
    expect(embed).toHaveBeenNthCalledWith(2, ["bb"], undefined);
    expect(
      moduleMocks.managementApi.mock.calls.filter(([path]) =>
        String(path).endsWith("/acquire"),
      ),
    ).toHaveLength(2);
    expect(
      moduleMocks.managementApi.mock.calls.filter(([path]) =>
        String(path).endsWith("/release"),
      ),
    ).toHaveLength(2);
    vi.unstubAllEnvs();
  });

  it("admits searchSources retrieval through the same permit channel as keyword search", async () => {
    vi.stubEnv("XIAOJING_SIDECAR_ID", "sidecar-18");
    moduleMocks.managementApi.mockReset();
    moduleMocks.managementApi.mockImplementation(
      async (path: string, _method: string, body: Record<string, unknown>) => {
        const payload = body.payload as Record<string, unknown>;
        if (path.endsWith("/acquire")) {
          return permit("acquired", { requestId: payload.requestId });
        }
        return { ok: true, released: true };
      },
    );
    const searchSources = vi.fn(async () => [
      { title: "同行动态", url: "https://rank.example/1" },
    ]);
    const base = baseCapabilities({
      keywordSearch: {
        slot: "keyword-search",
        search: unavailable,
        searchSources,
        baselineEngines: () => [],
        probeQuestion: unavailable,
      },
    });
    configureGeoProviderAdmission({
      workspacePath: "/brands/brand-18",
      sessionId: "session-18",
    });

    await expect(
      wrapGeoProviderCapabilities(base).keywordSearch.searchSources!(
        "成都新都 医美 排行榜",
        { count: 20 },
      ),
    ).resolves.toEqual([{ title: "同行动态", url: "https://rank.example/1" }]);

    const acquire = moduleMocks.managementApi.mock.calls.find(([path]) =>
      String(path).endsWith("/acquire"),
    );
    expect(acquire?.[2]).toMatchObject({
      ...identity,
      payload: { slot: "keyword-search", unitKind: "search-sources" },
    });
    expect(searchSources).toHaveBeenCalledTimes(1);

    // 旧能力注入未实现 searchSources 时包装层保持缺省，不制造新入口。
    const legacyKeywordSearch = { ...base.keywordSearch };
    delete legacyKeywordSearch.searchSources;
    expect(
      wrapGeoProviderCapabilities({
        ...base,
        keywordSearch: legacyKeywordSearch,
      }).keywordSearch.searchSources,
    ).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
