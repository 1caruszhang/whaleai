import { describe, expect, it, vi } from "vitest";

import type { GeoBaselineProviderSnapshot } from "../../shared/geo/baseline";
import type { GeoKeywordSearchCapability } from "./provider-capabilities";
import {
  checkPublishedPageAccess,
  PostPublishBaselineProbeService,
} from "./post-publish-monitoring";

const snapshot: GeoBaselineProviderSnapshot = {
  engineId: "doubao" as const,
  provider: "volcengine",
  capabilitySlot: "keyword-search" as const,
  model: "doubao-test",
  endpointFamily: "ark-responses",
  searchMode: "doubao-app-ai-search",
  configurationFingerprint: "fingerprint",
  policyVersion: "xiaojing-geo-baseline-v1" as const,
};
const sourceSnapshot: GeoBaselineProviderSnapshot = {
  ...snapshot,
  model: "doubao-source-a",
  configurationFingerprint: "source-fingerprint-a",
};

function provider(rawEvidence: unknown): GeoKeywordSearchCapability {
  return {
    slot: "keyword-search",
    search: vi.fn(),
    baselineEngines: () => [
      { id: "doubao", label: "豆包", available: true, snapshot },
    ],
    probeQuestion: vi.fn().mockResolvedValue({ rawEvidence, snapshot }),
  };
}

describe("PostPublishBaselineProbeService", () => {
  it("reuses the Ticket 09 parser and keeps raw evidence, citations and exact article ids", async () => {
    const rawEvidence = {
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "TOP 2：小鲸，值得选择。",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://brand.test/article-1#source",
                  title: "品牌文章",
                },
              ],
            },
          ],
        },
      ],
    };
    const result = await new PostPublishBaselineProbeService(
      provider(rawEvidence),
    ).probe({
      engineId: "doubao",
      questionId: "q1",
      question: "哪家好？",
      sourceProviderSnapshot: sourceSnapshot,
      brandNames: ["小鲸"],
      publishedArticles: [
        { articleId: "article-1", url: "https://brand.test/article-1" },
      ],
    });
    expect(result.evidence.rawEvidence).toBe(rawEvidence);
    expect(result.evidence.sourceProviderSnapshot).toBe(sourceSnapshot);
    expect(result.evidence.providerSnapshot).toBe(snapshot);
    expect(result.evidence.rawAnswer).toContain("小鲸");
    expect(result.evidence.rankPosition).toBe(2);
    expect(result.evidence.citedArticleIds).toEqual(["article-1"]);
    expect(result.evidence.citedUrls).toEqual([
      "https://brand.test/article-1",
    ]);
  });

  it("does not estimate a rank from a plain brand mention", async () => {
    const result = await new PostPublishBaselineProbeService(
      provider({ output: [{ content: [{ text: "小鲸值得选择" }] }] }),
    ).probe({
      engineId: "doubao",
      questionId: "q1",
      question: "哪家好？",
      sourceProviderSnapshot: sourceSnapshot,
      brandNames: ["小鲸"],
      publishedArticles: [],
    });
    expect(result.evidence.analysis.brandMentioned).toBe(true);
    expect(result.evidence.rankPosition).toBeNull();
  });

  it("fails explicitly when the real typed engine is unavailable", async () => {
    const unavailable = provider({});
    unavailable.baselineEngines = () => [
      { id: "doubao", label: "豆包", available: false, snapshot },
    ];
    await expect(
      new PostPublishBaselineProbeService(unavailable).probe({
        engineId: "doubao",
        questionId: "q1",
        question: "哪家好？",
        sourceProviderSnapshot: sourceSnapshot,
        brandNames: ["小鲸"],
        publishedArticles: [],
      }),
    ).rejects.toThrow("post_publish_monitor_provider_unavailable");
  });
});

describe("published page SSRF guard", () => {
  it("rejects an initial private target before DNS or fetch", async () => {
    const fetch = vi.fn();
    const dispatcherFor = vi.fn();
    await expect(
      checkPublishedPageAccess("https://127.0.0.1/private", {
        fetch,
        dispatcherFor,
      }),
    ).rejects.toThrow("published_page_url_rejected");
    expect(dispatcherFor).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects DNS resolving inward before any request", async () => {
    const fetch = vi.fn();
    await expect(
      checkPublishedPageAccess("https://public.example/a", {
        fetch,
        dispatcherFor: async () => {
          throw new Error("resolved to RFC1918");
        },
      }),
    ).rejects.toThrow("published_page_url_rejected");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never follows a public response to a private redirect target", async () => {
    const fetch = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      }),
    );
    await expect(
      checkPublishedPageAccess("https://public.example/a", {
        fetch,
        dispatcherFor: async () => undefined,
      }),
    ).rejects.toThrow("published_page_redirect_rejected");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("PostPublishBaselineProbeService billing (ticket 07)", () => {
  function billing(options: { available?: number; failProbe?: boolean } = {}) {
    const calls: Array<
      | { kind: "balance" }
      | { kind: "apply"; permitId: string; operation: string; units: number }
      | { kind: "report"; permitId: string; unit: number; outcome: string }
    > = [];
    return {
      calls,
      channel: {
        async balance() {
          calls.push({ kind: "balance" });
          return {
            total: (options.available ?? 100) + 10,
            frozen: 10,
            available: options.available ?? 100,
          };
        },
        async apply(input: { permitId: string; operation: string; units: number }) {
          calls.push({ kind: "apply", ...input });
          return {
            permitId: input.permitId,
            operation: input.operation,
            units: input.units,
            totalPoints: 5,
            status: "open" as const,
            frozenPoints: 5,
            consumedPoints: 0,
            refundedPoints: 0,
          };
        },
        async reportUnit(permitId: string, unit: number, outcome: string) {
          calls.push({ kind: "report", permitId, unit, outcome });
        },
      },
    };
  }

  const input = {
    engineId: "doubao" as const,
    questionId: "q-1",
    question: "小鲸同学值得选吗？",
    sourceProviderSnapshot: sourceSnapshot,
    brandNames: ["小鲸"],
    publishedArticles: [{ articleId: "article-1", url: "https://brand.test/article-1" }],
  };

  it("pre-checks balance, applies a monitoring_patrol permit and reports success", async () => {
    const providerCapability = provider({ output_text: "TOP 1：小鲸。" });
    const billingChannel = billing({ available: 7 });
    const service = new PostPublishBaselineProbeService(
      providerCapability,
      billingChannel.channel,
      () => "round-1",
    );

    const result = await service.probe(input);

    expect(result.evidence.questionId).toBe("q-1");
    expect(billingChannel.calls).toEqual([
      { kind: "balance" },
      { kind: "apply", permitId: "monitor:round-1", operation: "monitoring_patrol", units: 1 },
      { kind: "report", permitId: "monitor:round-1", unit: 0, outcome: "success" },
    ]);
  });

  it("auto-pauses with a typed error and no permit when balance is below one patrol unit", async () => {
    const providerCapability = provider({ output_text: "TOP 1：小鲸。" });
    const billingChannel = billing({ available: 4 });
    const service = new PostPublishBaselineProbeService(
      providerCapability,
      billingChannel.channel,
      () => "round-2",
    );

    await expect(service.probe(input)).rejects.toMatchObject({
      name: "PostPublishInsufficientBalanceError",
      required: 5,
      available: 4,
    });
    expect(providerCapability.probeQuestion).not.toHaveBeenCalled();
    expect(billingChannel.calls).toEqual([{ kind: "balance" }]);
  });

  it("reports the patrol unit as failure when the probe fails, and stays free without billing", async () => {
    const providerCapability = provider({ output_text: "x" });
    (providerCapability.probeQuestion as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("keyword-search 上游请求失败（HTTP 500）"),
    );
    const billingChannel = billing();
    const billed = new PostPublishBaselineProbeService(
      providerCapability,
      billingChannel.channel,
      () => "round-3",
    );
    await expect(billed.probe(input)).rejects.toThrow("keyword-search");
    expect(billingChannel.calls).toEqual([
      { kind: "balance" },
      { kind: "apply", permitId: "monitor:round-3", operation: "monitoring_patrol", units: 1 },
      { kind: "report", permitId: "monitor:round-3", unit: 0, outcome: "failure" },
    ]);

    // 无计费通道（开发直连模式）：零计费调用，纯探测语义不变。
    const unbilledCalls = billing();
    const unbilled = new PostPublishBaselineProbeService(
      provider({ output_text: "TOP 1：小鲸。" }),
      undefined,
      () => "round-4",
    );
    await unbilled.probe(input);
    expect(unbilledCalls.calls).toEqual([]);
  });
});
