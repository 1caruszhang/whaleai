import { describe, expect, it } from "vitest";

import pointsContract from "./pointsContract.json";
import { cnyToPoints, pointsToCny } from "./points";

describe("cnyToPoints", () => {
  it("converts media price to points with the service-fee multiplier", () => {
    // 公式裁判 pointsContract.json：¥88.00 → ceil(8800 × 4 / 25) = 1408 点。
    expect(cnyToPoints(88)).toBe(1408);
    // 换算示例：¥1000 → 16000 点。
    expect(cnyToPoints(1000)).toBe(16000);
  });

  it("returns 0 for zero, negative and non-finite prices", () => {
    expect(cnyToPoints(0)).toBe(0);
    expect(cnyToPoints(-1)).toBe(0);
    expect(cnyToPoints(Number.NaN)).toBe(0);
    expect(cnyToPoints(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("rounds to cents first, then ceils the fractional point", () => {
    // 1 分 → ceil(1 × 4 / 25) = 1 点（分位进位）。
    expect(cnyToPoints(0.01)).toBe(1);
    // 40 分 → ceil(160 / 25) = ceil(6.4) = 7 点。
    expect(cnyToPoints(0.4)).toBe(7);
    // 先按分四舍五入：¥88.004 → 8800 分 → 1408 点。
    expect(cnyToPoints(88.004)).toBe(1408);
    // ¥88.01 → 8801 分 → ceil(35204 / 25) = 1409 点。
    expect(cnyToPoints(88.01)).toBe(1409);
  });
});

describe("点数公式契约（票 #39，ADR-0012）", () => {
  it("公式参数钉在 pointsContract.json 裁判上", () => {
    expect(pointsContract.formula.multiplier).toBe(4);
    expect(pointsContract.formula.divisor).toBe(25);
    expect(pointsContract.formula.rounding).toBe("ceil");
  });

  it("cnyToPoints 实跑裁判 cases（用例按分给出，经 /100 走同一条 round-to-cents 链路）", () => {
    // 三侧之一：Rust publish_channel_price_points 与网关 publishOrderPoints
    // 各自的 pin 测试实跑同一裁判文件（只钉参数测不出算式结构漂移）。
    for (const { inputCents, expectedPoints } of pointsContract.cases) {
      expect(cnyToPoints(inputCents / 100)).toBe(expectedPoints);
    }
  });
});

describe("pointsToCny", () => {
  it("inverts cnyToPoints for the budget round-trip", () => {
    // 点数预算精确往返：16000 点 → ¥1000。
    expect(pointsToCny(16000)).toBe(1000);
    // 渠道单价示例：1408 点 → ¥88。
    expect(pointsToCny(1408)).toBe(88);
  });

  it("round-trips any point count exactly through cnyToPoints", () => {
    // 取不超过 p/16 的最大分值：奇数点数（7 点 → ¥0.43）也不会在
    // 「点数 → 元 → 点数」的卡片显示链路上漂移。
    for (const points of [1, 7, 100, 1408, 16000, 123_457]) {
      expect(cnyToPoints(pointsToCny(points))).toBe(points);
    }
  });

  it("returns 0 for zero, negative and non-finite points", () => {
    expect(pointsToCny(0)).toBe(0);
    expect(pointsToCny(-5)).toBe(0);
    expect(pointsToCny(Number.NaN)).toBe(0);
    expect(pointsToCny(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
