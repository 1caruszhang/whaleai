import { describe, expect, it } from "vitest";

import {
  isPublishExecutionImmutable,
  publishExecutionCanStart,
  publishRetryBackoffMs,
  type PublishExecutionProjection,
} from "./publishScheduler";

describe("publish scheduler policy", () => {
  it("keeps the js_ai dev retry contract at 1, 5 and 15 minutes", () => {
    expect([1, 2, 3, 4].map(publishRetryBackoffMs)).toEqual([
      60_000,
      300_000,
      900_000,
      null,
    ]);
  });

  it("makes a plan immutable at the independent confirmation boundary", () => {
    expect(isPublishExecutionImmutable("awaiting-confirmation")).toBe(false);
    expect(isPublishExecutionImmutable("confirmed")).toBe(true);
    expect(isPublishExecutionImmutable("partially-succeeded")).toBe(true);
  });

  it("only starts confirmed or safely resumable executions", () => {
    const execution = (status: PublishExecutionProjection["status"]) =>
      ({ status }) as PublishExecutionProjection;
    expect(publishExecutionCanStart(execution("awaiting-confirmation"))).toBe(false);
    expect(publishExecutionCanStart(execution("confirmed"))).toBe(true);
    expect(publishExecutionCanStart(execution("scheduled"))).toBe(false);
    expect(publishExecutionCanStart(execution("failed"))).toBe(false);
    expect(publishExecutionCanStart(execution("reconciliation-required"))).toBe(false);
    expect(publishExecutionCanStart(execution("succeeded"))).toBe(false);
  });
});
