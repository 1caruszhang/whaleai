import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EMBEDDING_FALLBACK_DIMENSIONS,
  buildFallbackVector,
  embedWithDegradation,
} from "./embedding-fallback";
import {
  GeoCapabilityUnavailableError,
  GeoTransientUpstreamError,
  GeoUpstreamHttpError,
  type GeoEmbeddingCapability,
} from "./provider-capabilities";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildFallbackVector", () => {
  it("is deterministic and defaults to 2048 dimensions", () => {
    const text = "成都汽车音响改装哪家好？";
    expect(buildFallbackVector(text)).toEqual(buildFallbackVector(text));
    expect(buildFallbackVector(text)).toHaveLength(EMBEDDING_FALLBACK_DIMENSIONS);
    expect(EMBEDDING_FALLBACK_DIMENSIONS).toBe(2048);
  });

  it("respects custom dimensions with a minimum of 1", () => {
    expect(buildFallbackVector("汽车音响", 128)).toHaveLength(128);
    expect(buildFallbackVector("汽车音响", 0)).toHaveLength(1);
  });

  it("returns an L2 unit vector for non-empty text and zeros for empty text", () => {
    const vector = buildFallbackVector("鲸跃汽车音响 成都 chengdu_audio");
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(buildFallbackVector("   ").every((x) => x === 0)).toBe(true);
  });

  it("places a shared CJK token on the same dimension across texts", () => {
    const single = buildFallbackVector("汽车", 512);
    const combined = buildFallbackVector("汽车 音响", 512);
    const sharedIndices = single
      .map((value, index) => (value !== 0 ? index : -1))
      .filter((index) => index >= 0);
    expect(sharedIndices.length).toBeGreaterThan(0);
    for (const index of sharedIndices) {
      expect(combined[index]).not.toBe(0);
    }
  });

  it("ignores single-character latin tokens", () => {
    // 拉丁 token 长度 > 1 才计入词频；单字符被丢弃 → 全零向量。
    expect(buildFallbackVector("a b c", 512).every((x) => x === 0)).toBe(true);
    expect(
      buildFallbackVector("ab c", 512).some((x) => x !== 0),
    ).toBe(true);
  });
});

function fakeEmbedding(
  embed: GeoEmbeddingCapability["embed"],
): GeoEmbeddingCapability {
  return { slot: "embedding", dimensions: 8, concurrency: 1, embed };
}

describe("embedWithDegradation", () => {
  it("passes provider vectors through untouched on success", async () => {
    const vectors = [[1, 0, 0, 0, 0, 0, 0, 0]];
    const result = await embedWithDegradation(
      fakeEmbedding(async () => vectors),
      ["问一句"],
    );
    expect(result).toEqual({ vectors, degraded: false });
  });

  it.each([408, 429, 500, 503])(
    "falls back with degraded=true and a WARN log on transient HTTP %i",
    async (status) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await embedWithDegradation(
        fakeEmbedding(async () => {
          throw new GeoUpstreamHttpError(
            "embedding",
            status,
            `embedding 上游请求失败（HTTP ${status}）`,
          );
        }),
        ["汽车", "音响"],
        { logTag: "[test]" },
      );
      expect(result.degraded).toBe(true);
      expect(result.vectors).toEqual([
        buildFallbackVector("汽车", 8),
        buildFallbackVector("音响", 8),
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain("[test]");
    },
  );

  it("treats network failures (GeoTransientUpstreamError) as transient", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await embedWithDegradation(
      fakeEmbedding(async () => {
        throw new GeoTransientUpstreamError(
          "embedding",
          "embedding 上游网络错误：fetch failed",
        );
      }),
      ["问一句"],
    );
    expect(result.degraded).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rethrows 503 carrying a config-class errorCode without fallback", async () => {
    // 网关缺 ARK_EMBEDDING_ENDPOINT_ID 时抛 503 + embedding_endpoint_not_configured
    // （provider-proxy-routes requireEmbeddingModel）：按状态启发式会误判瞬时，
    // 必须按机器可读错误码判配置类、显式失败，不得回落降级向量。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new GeoUpstreamHttpError(
      "embedding",
      503,
      "embedding embedding 服务暂不可用：服务器缺少 ARK_EMBEDDING_ENDPOINT_ID 配置",
      "embedding_endpoint_not_configured",
    );
    await expect(
      embedWithDegradation(
        fakeEmbedding(async () => {
          throw failure;
        }),
        ["问一句"],
      ),
    ).rejects.toBe(failure);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows config-class failures (4xx ≠ 429) without fallback or log", async () => {    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new GeoUpstreamHttpError(
      "embedding",
      400,
      "embedding 上游请求失败（HTTP 400）：model 缺失；请检查 embedding 模型/端点配置",
    );
    await expect(
      embedWithDegradation(
        fakeEmbedding(async () => {
          throw failure;
        }),
        ["问一句"],
      ),
    ).rejects.toBe(failure);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows GeoCapabilityUnavailableError without fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      embedWithDegradation(
        fakeEmbedding(async () => {
          throw new GeoCapabilityUnavailableError("embedding 能力尚未配置");
        }),
        ["问一句"],
      ),
    ).rejects.toThrow("embedding 能力尚未配置");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows when the caller signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      embedWithDegradation(
        fakeEmbedding(async () => {
          throw new GeoUpstreamHttpError("embedding", 503, "embedding 上游请求失败（HTTP 503）");
        }),
        ["问一句"],
        { signal: controller.signal },
      ),
    ).rejects.toThrow("HTTP 503");
    expect(warn).not.toHaveBeenCalled();
  });
});
