import { describe, expect, it } from "vitest";

import {
  aggregatePostPublishMonitorUnits,
  classifyGeoMetricTrend,
  mapSupermediaStatus,
  parseExplicitTopThreeRank,
  type PostPublishMonitorUnitProjection,
} from "./postPublishMonitoring";

const providerSnapshot = {
  engineId: "doubao" as const,
  provider: "volcengine" as const,
  capabilitySlot: "keyword-search" as const,
  model: "doubao-test",
  endpointFamily: "ark-responses" as const,
  searchMode: "doubao-app-ai-search" as const,
  configurationFingerprint: "fingerprint",
  policyVersion: "xiaojing-geo-baseline-v2" as const,
};

describe("post-publish monitoring policy", () => {
  it("maps the authoritative platform codes without guessing unknown states", () => {
    expect(mapSupermediaStatus(1)).toBe("submitted");
    expect(mapSupermediaStatus(4)).toBe("published");
    expect(mapSupermediaStatus(12)).toBe("indexed");
    expect(mapSupermediaStatus(2)).toBe("rejected");
    expect(mapSupermediaStatus(99)).toBeNull();
  });

  it("only accepts an explicit TOP 1/2/3 rank", () => {
    expect(parseExplicitTopThreeRank("TOP 2：小鲸，其次是其他品牌", ["小鲸"])).toBe(2);
    expect(parseExplicitTopThreeRank("小鲸排名第三，值得考虑", ["小鲸"])).toBe(3);
    expect(parseExplicitTopThreeRank("小鲸值得考虑，并被多处提及", ["小鲸"])).toBeNull();
    expect(parseExplicitTopThreeRank("TOP 5：小鲸", ["小鲸"])).toBeNull();
    expect(
      parseExplicitTopThreeRank("TOP 2：其他品牌，随后也提到了小鲸", ["小鲸"]),
    ).toBeNull();
  });

  it("aggregates only succeeded evidence and keeps stable citation identities", () => {
    const units: PostPublishMonitorUnitProjection[] = [
      {
        id: "status-1",
        revision: 1,
        publishItemId: "item-1",
        kind: "publish-status",
        status: "succeeded",
        attemptNumber: 1,
        attempts: [],
        evidence: {
          platformStatusCode: 12,
          platformStatus: "indexed",
          externalOrderId: "order-1",
          externalRequestSn: "sn-1",
          rawEvidence: { status: 12 },
        },
      },
      {
        id: "access-1",
        revision: 1,
        publishItemId: "item-1",
        kind: "access-indexing",
        status: "succeeded",
        attemptNumber: 1,
        attempts: [],
        evidence: {
          url: "https://example.test/a",
          httpStatus: 200,
          accessible: true,
          indexingState: "indexed",
          rawEvidence: { status: 200 },
        },
      },
      {
        id: "probe-1",
        revision: 1,
        kind: "baseline-probe",
        status: "succeeded",
        attemptNumber: 1,
        attempts: [],
        evidence: {
          questionId: "q1",
          engineId: "doubao",
          rawAnswer: "TOP 1 小鲸",
          rawEvidence: { output: [] },
          sourceProviderSnapshot: providerSnapshot,
          providerSnapshot,
          citations: [],
          analysis: {
            brandMentioned: true,
            brandRecommended: true,
            hasCitationEvidence: true,
          },
          rankPosition: 1,
          citedArticleIds: ["article-b", "article-a"],
          citedUrls: ["https://example.test/a"],
        },
      },
      {
        id: "probe-failed",
        revision: 1,
        kind: "baseline-probe",
        status: "failed",
        attemptNumber: 1,
        attempts: [],
        evidence: {
          questionId: "q2",
          engineId: "doubao",
          rawAnswer: "TOP 1 小鲸",
          rawEvidence: {},
          sourceProviderSnapshot: providerSnapshot,
          providerSnapshot,
          citations: [],
          analysis: {
            brandMentioned: true,
            brandRecommended: true,
            hasCitationEvidence: false,
          },
          rankPosition: 1,
          citedArticleIds: ["must-not-count"],
          citedUrls: [],
        },
      },
    ];
    expect(aggregatePostPublishMonitorUnits(units)).toEqual({
      successfulUnits: 3,
      failedUnits: 1,
      publishedItems: 1,
      indexedItems: 1,
      accessibleItems: 1,
      accessSamples: 1,
      baselineProbes: 1,
      brandMentioned: 1,
      topThree: 1,
      citedArticleIds: ["article-a", "article-b"],
      citedUrls: ["https://example.test/a"],
    });
  });

  it("treats HTTP 200 as accessibility only, never as indexing evidence", () => {
    const units: PostPublishMonitorUnitProjection[] = [
      {
        id: "access-only",
        revision: 1,
        publishItemId: "item-1",
        kind: "access-indexing",
        status: "succeeded",
        attemptNumber: 1,
        attempts: [],
        evidence: {
          url: "https://publisher.example.test/article",
          httpStatus: 200,
          accessible: true,
          indexingState: "unknown",
          platformStatusCode: 4,
          rawEvidence: { platform: { status: 4 }, access: { httpStatus: 200 } },
        },
      },
    ];
    expect(aggregatePostPublishMonitorUnits(units)).toMatchObject({
      accessibleItems: 1,
      indexedItems: 0,
    });
  });
});

describe("classifyGeoMetricTrend（两轮确认噪声纪律）", () => {
  it("needs at least two real samples before saying anything", () => {
    expect(classifyGeoMetricTrend([])).toBe("insufficient");
    expect(classifyGeoMetricTrend([50])).toBe("insufficient");
    expect(classifyGeoMetricTrend([null, 50])).toBe("insufficient");
  });

  it("marks a single-round change as fluctuation, never as a trend", () => {
    expect(classifyGeoMetricTrend([50, 60])).toBe("fluctuating");
    expect(classifyGeoMetricTrend([60, 50])).toBe("fluctuating");
  });

  it("confirms a trend only after two consecutive same-direction moves", () => {
    expect(classifyGeoMetricTrend([50, 60, 70])).toBe("up");
    expect(classifyGeoMetricTrend([70, 60, 50])).toBe("down");
    // 方向反转：最新一轮变化仍是未确认的观测波动。
    expect(classifyGeoMetricTrend([50, 70, 60])).toBe("fluctuating");
    expect(classifyGeoMetricTrend([70, 50, 60])).toBe("fluctuating");
  });

  it("reports flat when the latest change is zero and skips missing rounds", () => {
    expect(classifyGeoMetricTrend([50, 50])).toBe("flat");
    expect(classifyGeoMetricTrend([50, 60, 60])).toBe("flat");
    expect(classifyGeoMetricTrend([null, 40, null, 50, 60])).toBe("up");
  });
});
