import { describe, expect, it } from "vitest";

import distributionSpendLimitsContract from "./distributionSpendLimitsContract.json";
import {
  DEFAULT_DISTRIBUTION_SPEND_LIMITS,
  MAX_DISTRIBUTION_SPEND_LIMIT_POINTS,
} from "./distributionSpendLimits";

// 分发限额契约（票 #39，ADR-0012）：三常量与裁判 JSON 严格相等；
// Rust 侧 distribution_spend_limits.rs 的同文件测试 include_str! 同一裁判。
describe("分发限额契约（票 #39，ADR-0012）", () => {
  it("双侧常量与 distributionSpendLimitsContract.json 裁判严格相等", () => {
    expect(DEFAULT_DISTRIBUTION_SPEND_LIMITS.perArticleMaxPoints).toBe(
      distributionSpendLimitsContract.defaultPerArticleMaxPoints,
    );
    expect(DEFAULT_DISTRIBUTION_SPEND_LIMITS.perExecutionMaxPoints).toBe(
      distributionSpendLimitsContract.defaultPerExecutionMaxPoints,
    );
    expect(MAX_DISTRIBUTION_SPEND_LIMIT_POINTS).toBe(
      distributionSpendLimitsContract.maxDistributionSpendLimitPoints,
    );
  });
});
