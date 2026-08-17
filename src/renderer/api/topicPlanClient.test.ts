import { describe, expect, it, vi } from "vitest";

import {
  confirmTopicPlan,
  loadLatestTopicPlan,
  type TopicPlanApiPost,
} from "./topicPlanClient";

const identity = { workspaceId: "brand-10", sessionId: "session-10" };

describe("topicPlanClient", () => {
  it("keeps every operation on the current Tab control plane with explicit identity and revision", async () => {
    const plan = { id: "plan-10", revision: 3 };
    const confirmation = { planId: "plan-10", decisionId: "decision-10" };
    const apiPostMock = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/latest")) {
        return { success: true, plan };
      }
      return { success: true, confirmation };
    });
    const apiPost = apiPostMock as unknown as TopicPlanApiPost;

    await loadLatestTopicPlan(apiPost, identity);
    await confirmTopicPlan(apiPost, identity, {
      planId: "plan-10",
      expectedRevision: 3,
      selectedItemIds: ["item-1"],
    });

    expect(apiPostMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/xiaojing/topic-plans/latest",
      "/api/xiaojing/topic-plans/confirm",
    ]);
    for (const [, body] of apiPostMock.mock.calls) {
      expect(body).toMatchObject(identity);
    }
  });

  it("surfaces provider and persistence failures instead of inventing a plan", async () => {
    const apiPost = vi.fn(async () => ({
      success: false,
      error: "topic_plan_confirmation_failed",
    })) as unknown as TopicPlanApiPost;
    await expect(
      confirmTopicPlan(apiPost, identity, {
        planId: "plan-10",
        expectedRevision: 3,
        selectedItemIds: [],
      }),
    ).rejects.toThrow("topic_plan_confirmation_failed");
  });
});
