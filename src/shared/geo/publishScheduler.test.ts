import { describe, expect, it } from "vitest";

import publishSchedulerContract from "./publishSchedulerContract.json";
import {
  PUBLISH_EXECUTION_STATUSES,
  PUBLISH_ITEM_STATUSES,
  PUBLISH_MAX_SAFE_RETRIES,
  PUBLISH_ORDER_STATUS_LABEL,
  PUBLISH_RETRY_BACKOFF_MS,
  PUBLISH_SCHEDULER_POLICY_VERSION,
  isPublishExecutionImmutable,
  publishExecutionCanStart,
  publishOrderRefundsPoints,
  publishOrderStatusActive,
  publishRetryBackoffMs,
  type PublishExecutionProjection,
  type PublishOrderUpstreamStatus,
} from "./publishScheduler";

describe("publish scheduler contract pin（ADR-0012 三方裁判）", () => {
  it("五键与 publishSchedulerContract.json 严格相等（含顺序）", () => {
    expect(publishSchedulerContract.policyVersion).toBe(
      PUBLISH_SCHEDULER_POLICY_VERSION,
    );
    expect(publishSchedulerContract.retryBackoffMs.values).toEqual([
      ...PUBLISH_RETRY_BACKOFF_MS,
    ]);
    expect(publishSchedulerContract.maxSafeRetries).toBe(
      PUBLISH_MAX_SAFE_RETRIES,
    );
    expect(publishSchedulerContract.executionStatuses).toEqual([
      ...PUBLISH_EXECUTION_STATUSES,
    ]);
    expect(publishSchedulerContract.itemStatuses).toEqual([
      ...PUBLISH_ITEM_STATUSES,
    ]);
  });
});

describe("publish scheduler policy", () => {
  it("keeps the 2026-09 retry contract at two 3-second retries", () => {
    expect([1, 2, 3, 4].map(publishRetryBackoffMs)).toEqual([
      3_000,
      3_000,
      null,
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

describe("publish order status projection (ticket 09)", () => {
  it("labels every upstream status code the way users see it", () => {
    const expected: Record<PublishOrderUpstreamStatus, string> = {
      1: "待处理",
      2: "已拒稿",
      3: "发布中",
      4: "已发布",
      5: "已取消",
      6: "退款中",
      7: "已退款",
      8: "退款被拒",
      9: "已关闭",
      10: "补发中",
      11: "已补发",
      12: "已收录",
    };
    expect(PUBLISH_ORDER_STATUS_LABEL).toEqual(expected);
  });

  it("marks exactly the refund-bearing statuses (backend REFUND_STATUSES parity)", () => {
    const refunding: PublishOrderUpstreamStatus[] = [2, 5, 7];
    const keeping: PublishOrderUpstreamStatus[] = [1, 3, 4, 6, 8, 9, 10, 11, 12];
    for (const status of refunding) {
      expect(publishOrderRefundsPoints(status)).toBe(true);
    }
    for (const status of keeping) {
      expect(publishOrderRefundsPoints(status)).toBe(false);
    }
  });

  it("keeps polling only while an order is unknown or in flight", () => {
    expect(publishOrderStatusActive(null)).toBe(true);
    expect(publishOrderStatusActive(1)).toBe(true);
    expect(publishOrderStatusActive(3)).toBe(true);
    expect(publishOrderStatusActive(6)).toBe(true);
    for (const status of [2, 4, 5, 7, 8, 9, 10, 11, 12] as const) {
      expect(publishOrderStatusActive(status)).toBe(false);
    }
  });
});
