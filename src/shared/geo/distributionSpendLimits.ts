/** Shared client/Sidecar defaults. Referee contract:
 * `distributionSpendLimitsContract.json`（与 Rust `distribution_spend_limits.rs`
 * 的同文件测试双侧 pin，票 #39 / ADR-0012）。Rust owns persistence and
 * applies these values for cold-start config fallback. */
export const DEFAULT_DISTRIBUTION_SPEND_LIMITS = {
  perArticleMaxPoints: 3_000,
  perExecutionMaxPoints: 20_000,
} as const;

export const MAX_DISTRIBUTION_SPEND_LIMIT_POINTS = 160_000_000;

export interface DistributionSpendLimits {
  perArticleMaxPoints: number;
  perExecutionMaxPoints: number;
}
