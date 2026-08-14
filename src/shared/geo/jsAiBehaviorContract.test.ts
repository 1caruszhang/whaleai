import { describe, expect, it } from "vitest";

import { JS_AI_DEV_BEHAVIOR_FIXTURE } from "./__fixtures__/jsAiDevBehavior";
import {
  buildGeoPublishIdempotencyKey,
  computeGeoNextPublishAt,
  computeGeoPublishPayloadHash,
  decideGeoIdempotentOrder,
  enforceGeoContentTypeCoverage,
  geoPublishRetryBackoffMs,
  mergeGeoChannelPathHits,
  migrateGeoArticleState,
  scoreGeoQuestionCandidate,
} from "./portContract";

function localTimestamp(parts: readonly number[]): number {
  const [year, month, day, hour, minute] = parts;
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function localCalendar(epochSeconds: number): number[] {
  const value = new Date(epochSeconds * 1000);
  return [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
  ];
}

describe("js_ai dev GEO behavior contract", () => {
  it("preserves PRED-1 vector scoring and neutral missing-vector degradation", () => {
    for (const testCase of JS_AI_DEV_BEHAVIOR_FIXTURE.questionScoring) {
      expect(
        scoreGeoQuestionCandidate({
          questionVector: testCase.questionVector,
          profileAnchorVector: testCase.profileAnchorVector,
          poolVectors: testCase.poolVectors,
        }),
        testCase.id,
      ).toEqual(testCase.expected);
    }
  });

  it("merges four-path channel hits without double-counting a repeated path", () => {
    expect(
      mergeGeoChannelPathHits(JS_AI_DEV_BEHAVIOR_FIXTURE.channelPathMerge.hits),
    ).toEqual(JS_AI_DEV_BEHAVIOR_FIXTURE.channelPathMerge.expected);
  });

  it("backfills all five content types without mutating topic order", () => {
    for (const testCase of JS_AI_DEV_BEHAVIOR_FIXTURE.contentTypeCoverage) {
      const inputSnapshot = structuredClone(testCase.input);
      expect(enforceGeoContentTypeCoverage(testCase.input), testCase.id).toEqual(
        testCase.expected,
      );
      expect(testCase.input, `${testCase.id}: input mutated`).toEqual(
        inputSnapshot,
      );
    }
  });

  it("preserves human gates and planner ownership across article states", () => {
    for (const testCase of JS_AI_DEV_BEHAVIOR_FIXTURE.articleStateTransitions) {
      expect(
        migrateGeoArticleState(testCase.status, testCase.guards),
        testCase.id,
      ).toEqual(testCase.expected);
    }
  });

  it("keeps paid publishing deterministic and idempotent", async () => {
    const fixture = JS_AI_DEV_BEHAVIOR_FIXTURE.publishing;
    for (const testCase of fixture.idempotencyKeys) {
      expect(
        buildGeoPublishIdempotencyKey(
          testCase.articleId,
          testCase.resourceId,
          "version" in testCase ? testCase.version : undefined,
        ),
      ).toBe(testCase.expected);
    }
    expect(
      await computeGeoPublishPayloadHash(
        fixture.payloadHash.title,
        fixture.payloadHash.content,
        fixture.payloadHash.remark,
      ),
    ).toBe(fixture.payloadHash.expected);
    for (const testCase of fixture.idempotencyDecisions) {
      expect(
        decideGeoIdempotentOrder(testCase.existing, testCase.newPayloadHash),
        testCase.id,
      ).toEqual(testCase.expected);
    }
    for (const testCase of fixture.retryBackoff) {
      expect(geoPublishRetryBackoffMs(testCase.attempt)).toBe(
        testCase.expectedMs,
      );
    }
    for (const testCase of fixture.schedule) {
      const result = computeGeoNextPublishAt({
        nowMs: localTimestamp(testCase.now),
        channelDailyCount: testCase.channelDailyCount,
        channelDailyLimit: testCase.channelDailyLimit,
        canWeekend: testCase.canWeekend,
      });
      expect(localCalendar(result), testCase.id).toEqual(testCase.expected);
    }
  });
});
