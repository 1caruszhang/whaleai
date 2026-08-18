import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TopicPlanProjection } from "../../../shared/geo/topicPlan";
import { renderWithTheme as render } from "@/test/renderWithTheme";

const mocks = vi.hoisted(() => ({ apiPost: vi.fn(), confirm: vi.fn() }));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17" }),
}));

vi.mock("@/api/topicPlanClient", () => ({
  confirmTopicPlan: mocks.confirm,
}));

import TopicPlanGateCard, {
  parseTopicPlanGateCard,
} from "./TopicPlanGateCard";

const plan = {
  id: "plan-17",
  workspaceId: "brand-17",
  sessionId: "session-17",
  knowledgeVersion: 9,
  questionPoolId: "pool-17",
  status: "draft",
  revision: 1,
  reused: false,
  topics: [{ id: "topic-1", name: "车载音响选购" }],
  items: [
    {
      id: "item-1",
      topicId: "topic-1",
      sourceQuestionIds: ["q-1"],
      contentType: "guide",
      typeSelectionReason: "选购决策类问题适合指南。",
      title: "成都车载音响选购指南",
      titleCandidates: [],
      titleRationale: {
        selectedTitle: "成都车载音响选购指南",
        ruleTrace: "",
        maxSimilarity: null,
        threshold: 0,
      },
      plannedFacts: [],
      deduplication: { maxSimilarity: null, threshold: 0 },
      userEdited: false,
      approvalStatus: "draft",
      origin: "model",
    },
    {
      id: "item-2",
      topicId: "topic-1",
      sourceQuestionIds: ["q-2"],
      contentType: "showcase",
      typeSelectionReason: "品牌实力问题适合品牌详情。",
      title: "行乐音改品牌详情",
      titleCandidates: [],
      titleRationale: {
        selectedTitle: "行乐音改品牌详情",
        ruleTrace: "",
        maxSimilarity: null,
        threshold: 0,
      },
      plannedFacts: [],
      deduplication: { maxSimilarity: null, threshold: 0 },
      userEdited: false,
      approvalStatus: "draft",
      origin: "model",
    },
  ],
} as unknown as TopicPlanProjection;

function wrappedResult(): string {
  return JSON.stringify([
    { type: "text", text: JSON.stringify({ kind: "topic-plan", plan }) },
  ]);
}

beforeEach(() => {
  mocks.confirm.mockReset();
});

describe("TopicPlanGateCard", () => {
  it("parses only exact plan_topics envelopes", () => {
    expect(parseTopicPlanGateCard(wrappedResult())?.plan.id).toBe("plan-17");
    expect(parseTopicPlanGateCard(JSON.stringify({ kind: "other" }))).toBeNull();
  });

  it("renders items unapproved by default and confirms the checked selection", async () => {
    mocks.confirm.mockResolvedValue({
      planId: "plan-17",
      decisionId: "decision-17",
      revision: 2,
      selectedItemIds: ["item-1"],
      questionPoolId: "pool-17",
      questionPoolRevision: 3,
      knowledgeVersion: 9,
    });
    render(<TopicPlanGateCard data={{ kind: "topic-plan", plan }} />);

    const card = screen.getByRole("region", { name: "内容计划确认" });
    expect(within(card).getByText(/已批准 0\/2/)).toBeInTheDocument();

    fireEvent.click(
      within(card).getByRole("checkbox", { name: "批准 成都车载音响选购指南" }),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: /确认内容计划（1）/ }),
    );

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const [, identity, input] = mocks.confirm.mock.calls[0];
    expect(identity).toEqual({ workspaceId: "brand-17", sessionId: "session-17" });
    expect(input).toMatchObject({
      planId: "plan-17",
      expectedRevision: 1,
      selectedItemIds: ["item-1"],
    });
    expect(await screen.findByText(/内容计划已确认/)).toBeInTheDocument();
  });
});
