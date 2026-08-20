import { describe, expect, it } from "vitest";

import { cnyToPoints } from "./points";

describe("cnyToPoints", () => {
  it("converts media price to points with the service-fee multiplier", () => {
    // 与 Rust/网关同式：¥88.00 → ceil(8800 × 4 / 25) = 1408 点。
    expect(cnyToPoints(88)).toBe(1408);
    // 默认预算示例：¥1000 → 16000 点。
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
