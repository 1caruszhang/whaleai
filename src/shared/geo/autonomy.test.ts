import { describe, expect, it } from "vitest";

import {
  AUTO_CONFIRMABLE_CONFIRMATION_KINDS,
  gateAutoConfirms,
  normalizeGeoAutonomyProfile,
} from "./autonomy";

describe("GEO autonomy profile policy", () => {
  it("opts into auto explicitly and falls back to manual for anything else", () => {
    expect(normalizeGeoAutonomyProfile("auto")).toBe("auto");
    expect(normalizeGeoAutonomyProfile("manual")).toBe("manual");
    expect(normalizeGeoAutonomyProfile(undefined)).toBe("manual");
    expect(normalizeGeoAutonomyProfile("full")).toBe("manual");
    expect(normalizeGeoAutonomyProfile("")).toBe("manual");
  });

  it("auto-confirms only zero-cost selection gates and never paid/publish/monitor gates", () => {
    expect(gateAutoConfirms("auto", "question-selection")).toBe(true);

    expect(gateAutoConfirms("manual", "question-selection")).toBe(false);
    expect(gateAutoConfirms("auto", "knowledge-change")).toBe(false);
    expect(gateAutoConfirms("auto", "baseline-probe")).toBe(false);
    expect(gateAutoConfirms("auto", "topic-plan")).toBe(false);
    expect(gateAutoConfirms("auto", "article-approval")).toBe(false);
    expect(gateAutoConfirms("auto", "distribution-plan")).toBe(false);
    expect(gateAutoConfirms("auto", "paid-publish")).toBe(false);
    expect(gateAutoConfirms("auto", "external-publish")).toBe(false);
    expect(gateAutoConfirms("auto", "monitoring-activation")).toBe(false);
    expect(gateAutoConfirms("auto", "unknown-future-kind")).toBe(false);
  });

  it("documents the widening set as question-selection only", () => {
    expect(AUTO_CONFIRMABLE_CONFIRMATION_KINDS).toEqual(["question-selection"]);
  });
});
