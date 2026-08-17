import { describe, expect, it, vi } from "vitest";

import {
  confirmQuestionPool,
  loadLatestQuestionPool,
  type QuestionPoolApiPost,
} from "./brandQuestionPoolClient";

describe("Question pool structured client", () => {
  it("uses only Session-scoped structured control routes", async () => {
    const apiPostMock = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/confirm"))
        return {
          success: true,
          decision: { poolId: "pool-08", decisionId: "decision-08" },
        };
      return { success: true, pool: { id: "pool-08" } };
    });
    const apiPost = apiPostMock as unknown as QuestionPoolApiPost;
    const identity = { workspaceId: "brand-08", sessionId: "session-08" };

    await loadLatestQuestionPool(apiPost, identity, "旗舰产品");
    await confirmQuestionPool(apiPost, identity, {
      poolId: "pool-08",
      expectedRevision: 0,
      questions: [],
    });

    expect(apiPostMock.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [
        "/api/xiaojing/question-pools/latest",
        { ...identity, productLine: "旗舰产品" },
      ],
      [
        "/api/xiaojing/question-pools/confirm",
        {
          ...identity,
          poolId: "pool-08",
          expectedRevision: 0,
          questions: [],
        },
      ],
    ]);
    expect(apiPostMock.mock.calls.flat().join(" ")).not.toContain("/chat");
  });
});
