import { invoke } from "@tauri-apps/api/core";

import type { BrandHistoryProjection } from "../../shared/geo/brandHistory";

export function loadBrandHistory(workspaceId: string): Promise<BrandHistoryProjection> {
  return invoke("cmd_brand_workspace_history", { workspaceId });
}
