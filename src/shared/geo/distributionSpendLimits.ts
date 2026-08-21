/** Shared client/Sidecar defaults. Rust owns persistence and independently
 * mirrors these values for cold-start config fallback. */
export const DEFAULT_DISTRIBUTION_SPEND_LIMITS = {
  perArticleMaxPoints: 3_000,
  perExecutionMaxPoints: 20_000,
} as const;

export const MAX_DISTRIBUTION_SPEND_LIMIT_POINTS = 160_000_000;

export interface DistributionSpendLimits {
  perArticleMaxPoints: number;
  perExecutionMaxPoints: number;
}
