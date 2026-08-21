import { invoke } from "@tauri-apps/api/core";

import {
  DEFAULT_DISTRIBUTION_SPEND_LIMITS,
  type DistributionSpendLimits,
} from "../../shared/geo/distributionPlan";
import { isTauriEnvironment } from "@/utils/browserMock";

export async function fetchDistributionSpendLimits(): Promise<DistributionSpendLimits> {
  if (!isTauriEnvironment()) return { ...DEFAULT_DISTRIBUTION_SPEND_LIMITS };
  return invoke<DistributionSpendLimits>("cmd_get_distribution_spend_limits");
}

export async function saveDistributionSpendLimits(
  limits: DistributionSpendLimits,
): Promise<DistributionSpendLimits> {
  if (!isTauriEnvironment()) return limits;
  return invoke<DistributionSpendLimits>("cmd_set_distribution_spend_limits", {
    limits,
  });
}
