import { describe, expect, it } from "vitest";

import {
  PUBLISH_ORDER_STATUS_LABEL,
  isPublishExecutionImmutable,
  publishExecutionCanStart,
  publishOrderRefundsPoints,
  publishOrderStatusActive,
  publishRetryBackoffMs,
  type PublishExecutionProjection,
  type PublishOrderUpstreamStatus,
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
