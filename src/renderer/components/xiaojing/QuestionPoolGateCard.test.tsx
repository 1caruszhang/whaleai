import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuestionPoolProjection } from "../../../shared/geo/questionPool";
import { renderWithTheme as render } from "@/test/renderWithTheme";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  confirm: vi.fn(),
  latest: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17" }),
}));

vi.mock("@/api/brandQuestionPoolClient", () => ({
  confirmQuestionPool: mocks.confirm,
  loadLatestQuestionPool: mocks.latest,
}));

import QuestionPoolGateCard, {
  parseQuestionPoolGateCard,
} from "./QuestionPoolGateCard";

const pool = {
  id: "pool-17",
  operationId: "operation-17",
  workspaceId: "brand-17",
  sessionId: "session-17",
  knowledgeVersion: 9,
  productLine: "车载音响",
  targetRegion: "成都",
  status: "awaiting-selection",
  revision: 2,
  keywords: [
    { id: "kw-1", term: "成都车载音响改装", category: "core", heat: "high", platform: "doubao" },
    { id: "kw-2", term: "成都 汽车隔音 多少钱", category: "longtail", heat: "medium", platform: "doubao" },
  ],
  questions: [
    {
      id: "q-1",
      text: "成都车载音响改装哪家好？",
      selected: true,
      recommended: true,
      score: {
        mode: "pred-1",
        relevance: 90,
        recentPoolSimilarity: 10,
        optimizationPotential: 60,
        priorityTotal: 160,
        priority: "high",
        formula: "traceable",
        policyVersion: "js-ai-dev-pred-1-v1",
      },
      evidence: [],
    },
    {
      id: "q-2",
      text: "成都汽车隔音多少钱？",
      selected: false,
      recommended: false,
      score: {
        mode: "pred-1",
        relevance: 70,
        recentPoolSimilarity: 5,
        optimizationPotential: 40,
        priorityTotal: 115,
        priority: "medium",
        formula: "traceable",
        policyVersion: "js-ai-dev-pred-1-v1",
      },
      evidence: [],
    },
  ],
} as unknown as QuestionPoolProjection;

function wrappedResult(): string {
  // 生产投影形态：MCP content blocks 数组壳。
  return JSON.stringify([
    { type: "text", text: JSON.stringify({ kind: "question-pool", pool }) },
  ]);
}

beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.latest.mockReset();
});

describe("QuestionPoolGateCard", () => {
  it("parses only exact run_question_pool envelopes", () => {
    expect(parseQuestionPoolGateCard(wrappedResult())?.pool.id).toBe("pool-17");
    expect(parseQuestionPoolGateCard(JSON.stringify({ kind: "other" }))).toBeNull();
  });

  it("shows mined keywords and confirms the selection through the pool endpoint", async () => {
    mocks.confirm.mockResolvedValue({ poolId: "pool-17", revision: 3 });
    render(<QuestionPoolGateCard data={{ kind: "question-pool", pool }} />);

    const card = screen.getByRole("region", { name: "问题池确认" });
    const keywordBlock = within(card).getByLabelText("本次挖掘的搜索词");
    expect(within(keywordBlock).getByText(/成都车载音响改装/)).toBeInTheDocument();
    expect(within(keywordBlock).getByText(/核心词/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("checkbox", { name: "选择 成都汽车隔音多少钱？" }));
    fireEvent.click(within(card).getByRole("button", { name: /确认本轮问题（2）/ }));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const [, identity, input] = mocks.confirm.mock.calls[0];
    expect(identity).toEqual({ workspaceId: "brand-17", sessionId: "session-17" });
    expect(input).toMatchObject({ poolId: "pool-17", expectedRevision: 2 });
    expect(
      await screen.findByText(/本轮问题已确认/),
    ).toBeInTheDocument();
  });

  it("keeps the gate user-owned and surfaces CAS failures for retry", async () => {
    mocks.confirm.mockRejectedValue(new Error("question_pool_revision_conflict"));
    render(<QuestionPoolGateCard data={{ kind: "question-pool", pool }} />);

    fireEvent.click(screen.getByRole("button", { name: /确认本轮问题/ }));
    await waitFor(() =>
      expect(screen.getByText(/question_pool_revision_conflict/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/本轮问题已确认/)).not.toBeInTheDocument();
  });

  it("re-renders chat revisions on the 3s poll with server-wins per question", async () => {
    vi.useFakeTimers();
    try {
      // 服务端修订：q-1 文本被改、q-2 被删、新增 q-user-1；revision 递增。
      const revised = {
        ...pool,
        revision: 3,
        keywords: [
          ...pool.keywords,
          { id: "kw-user-1", term: "成都贴隐形车衣", category: "scene", heat: "low", platform: "doubao" },
        ],
        questions: [
          { ...pool.questions[0], text: "成都车载音响改装推荐哪家？" },
          {
            id: "q-user-1",
            text: "成都贴隐形车衣要多少钱？",
            selected: false,
            recommended: false,
            score: pool.questions[0].score,
            evidence: [],
          },
        ],
      } as unknown as QuestionPoolProjection;
      mocks.latest.mockResolvedValue(revised);
      mocks.confirm.mockResolvedValue({ poolId: "pool-17", revision: 4 });
      const view = render(
        <QuestionPoolGateCard data={{ kind: "question-pool", pool }} />,
      );

      // 本地暂存：把 q-2 勾上（内容未被服务端改动的行应保留本地勾选）。
      fireEvent.click(view.getByRole("checkbox", { name: "选择 成都汽车隔音多少钱？" }));

      await vi.advanceTimersByTimeAsync(3_100);
      expect(mocks.latest).toHaveBeenCalled();

      // 服务端修订落地：新文本、新增行、新搜索词呈现；被删行消失。
      await vi.waitFor(() =>
        expect(view.getByText(/成都车载音响改装推荐哪家？/)).toBeInTheDocument(),
      );
      expect(view.getByText(/成都贴隐形车衣要多少钱？/)).toBeInTheDocument();
      const keywordBlock = view.getByLabelText("本次挖掘的搜索词");
      expect(within(keywordBlock).getByText(/成都贴隐形车衣/)).toBeInTheDocument();
      expect(view.queryByText(/成都汽车隔音多少钱？/)).not.toBeInTheDocument();
      expect(view.queryByText(/成都车载音响改装哪家好？/)).not.toBeInTheDocument();

      // 服务端已删除 q-2：本地勾选随之消失，仅剩服务端 q-1（默认选中）与
      // 新增 q-user-1（默认未选）。
      fireEvent.click(view.getByRole("button", { name: /确认本轮问题（1）/ }));
      await vi.waitFor(() =>
        expect(mocks.confirm).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ expectedRevision: 3 }),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
