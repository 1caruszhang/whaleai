import { describe, expect, it, vi } from "vitest";

import type {
  DistributionPlanEditInput,
  DistributionPlanProjection,
} from "../../shared/geo/distributionPlan";
import {
  confirmDistributionPlan,
  editDistributionPlan,
  loadLatestDistributionPlan,
} from "./distributionPlanClient";

const identity = { workspaceId: "brand-12", sessionId: "session-12" };
const plan = { id: "plan-exact", revision: 4 } as DistributionPlanProjection;

describe("distributionPlanClient", () => {
  it("uses only current-Tab POST control-plane endpoints", async () => {
    const apiPost = vi.fn().mockResolvedValue({ success: true, plan });
    await expect(loadLatestDistributionPlan(apiPost, identity)).resolves.toBe(
      plan,
    );
    expect(apiPost.mock.calls).toEqual([
      ["/api/xiaojing/distribution-plans/latest", identity],
    ]);
  });

  it("keeps exact plan and revision identity for edit and confirm", async () => {
    const apiPost = vi.fn().mockResolvedValue({ success: true, plan });
    const edit = { budgetCny: 800 } as DistributionPlanEditInput;
    await editDistributionPlan(apiPost, identity, {
      planId: "plan-exact",
      expectedRevision: 3,
      edit,
    });
    await confirmDistributionPlan(apiPost, identity, {
      planId: "plan-exact",
      expectedRevision: 4,
    });
    expect(apiPost.mock.calls).toEqual([
      [
        "/api/xiaojing/distribution-plans/edit",
        {
          ...identity,
          planId: "plan-exact",
          expectedRevision: 3,
          edit,
        },
      ],
      [
        "/api/xiaojing/distribution-plans/confirm",
        {
          ...identity,
          planId: "plan-exact",
          expectedRevision: 4,
        },
      ],
    ]);
  });

  it("fails closed on malformed success responses", async () => {
    const apiPost = vi.fn().mockResolvedValue({ success: true });
    await expect(
      confirmDistributionPlan(apiPost, identity, {
        planId: "plan-exact",
        expectedRevision: 4,
      }),
    ).rejects.toThrow("distribution_plan_not_found");
  });
});
