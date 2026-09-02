import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TopicPlanProjection } from "../../../shared/geo/topicPlan";
import { renderWithTheme as render } from "@/test/renderWithTheme";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  confirm: vi.fn(),
  save: vi.fn(),
  regenerate: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17" }),
}));

vi.mock("@/api/topicPlanClient", () => ({
  confirmTopicPlan: mocks.confirm,
  saveTopicPlanItems: mocks.save,
  loadLatestTopicPlan: vi.fn(),
  regenerateTopicPlan: mocks.regenerate,
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
  mocks.save.mockReset();
  mocks.regenerate.mockReset();
});

describe("TopicPlanGateCard", () => {
  it("parses only exact plan_topics envelopes", () => {
    expect(parseTopicPlanGateCard(wrappedResult())?.plan.id).toBe("plan-17");
    expect(parseTopicPlanGateCard(JSON.stringify({ kind: "other" }))).toBeNull();
  });

  it("renders items unapproved by default and confirms the checked selection", async () => {
    mocks.save.mockResolvedValue({
      plan: { ...plan, revision: 2 },
      mutationId: "mutation-17",
      preservedItemIds: [],
    });
    mocks.confirm.mockResolvedValue({
      planId: "plan-17",
      decisionId: "decision-17",
      revision: 3,
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

    // 勾选批准必须先经 user-edit mutation 落盘，confirm 才会放行。
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const [, saveIdentity, saveInput] = mocks.save.mock.calls[0];
    expect(saveIdentity).toEqual({
      workspaceId: "brand-17",
      sessionId: "session-17",
    });
    expect(saveInput).toMatchObject({
      planId: "plan-17",
      expectedRevision: 1,
    });
    expect(
      saveInput.items.map((item: { id: string; approvalStatus: string }) => [
        item.id,
        item.approvalStatus,
      ]),
    ).toEqual([
      ["item-1", "approved"],
      ["item-2", "draft"],
    ]);

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const [, identity, input] = mocks.confirm.mock.calls[0];
    expect(identity).toEqual({ workspaceId: "brand-17", sessionId: "session-17" });
    expect(input).toMatchObject({
      planId: "plan-17",
      expectedRevision: 2,
      selectedItemIds: ["item-1"],
    });
    expect(await screen.findByText(/内容计划已确认/)).toBeInTheDocument();
  });

  it("skips the approval write when every checked item is already persisted approved", async () => {
    const approvedPlan = {
      ...plan,
      items: plan.items.map((item) =>
        item.id === "item-1" ? { ...item, approvalStatus: "approved" } : item,
      ),
    } as unknown as TopicPlanProjection;
    mocks.confirm.mockResolvedValue({
      planId: "plan-17",
      decisionId: "decision-18",
      revision: 2,
      selectedItemIds: ["item-1"],
      questionPoolId: "pool-17",
      questionPoolRevision: 3,
      knowledgeVersion: 9,
    });
    render(<TopicPlanGateCard data={{ kind: "topic-plan", plan: approvedPlan }} />);

    const card = screen.getByRole("region", { name: "内容计划确认" });
    expect(within(card).getByText(/已批准 1\/2/)).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole("button", { name: /确认内容计划（1）/ }),
    );

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.confirm.mock.calls[0][2]).toMatchObject({
      planId: "plan-17",
      expectedRevision: 1,
      selectedItemIds: ["item-1"],
    });
  });

  it("surfaces the approval write failure and never reaches confirm", async () => {
    mocks.save.mockRejectedValue(new Error("topic_plan_revision_conflict"));
    render(<TopicPlanGateCard data={{ kind: "topic-plan", plan }} />);

    const card = screen.getByRole("region", { name: "内容计划确认" });
    fireEvent.click(
      within(card).getByRole("checkbox", { name: "批准 成都车载音响选购指南" }),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: /确认内容计划（1）/ }),
    );

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("topic_plan_revision_conflict");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(
      within(card).getByRole("button", { name: /确认内容计划（1）/ }),
    ).toBeEnabled();
  });

  // 复用停卡重选（TOPIC_PLAN_REUSE_OUTCOME）：confirmed 计划 + outcome →
  // 重选模式——预勾上次的已批准项、未批准项只读（冻结计划只能收窄）、
  // 「沿用此计划」走 confirm（不触发 items 落盘），另有付费重生成入口。
  it("renders a reused confirmed plan pre-checked and re-confirmable", async () => {
    mocks.confirm.mockResolvedValue({ planId: "plan-17", revision: 2 });
    const reused = {
      ...plan,
      status: "confirmed",
      revision: 3,
      items: plan.items.map((item) => ({
        ...item,
        approvalStatus: item.id === "item-1" ? "approved" : "draft",
      })),
    } as unknown as TopicPlanProjection;
    render(
      <TopicPlanGateCard
        data={{ kind: "topic-plan", outcome: "reused-confirmed-plan", plan: reused }}
      />,
    );

    expect(
      screen.getByText("已复用此前确认的内容计划——预勾上次的已批准项，可收窄后沿用"),
    ).toBeInTheDocument();
    const approved = screen.getByRole("checkbox", { name: "批准 成都车载音响选购指南" });
    expect(approved).toBeChecked();
    expect(approved).toBeEnabled();
    const unapproved = screen.getByRole("checkbox", { name: "批准 行乐音改品牌详情" });
    expect(unapproved).not.toBeChecked();
    expect(unapproved).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "重新生成内容计划" }),
    ).toBeInTheDocument();

    // 沿用（勾选 ⊆ 已批准，不触发 items 落盘）：直接走 confirm；全收窄
    // 到 0 时按钮禁用（本轮至少 1 项），此处保持 1 项沿用。
    fireEvent.click(screen.getByRole("button", { name: /沿用此计划（1）/ }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const [, identity, input] = mocks.confirm.mock.calls[0];
    expect(identity).toEqual({ workspaceId: "brand-17", sessionId: "session-17" });
    expect(input.planId).toBe("plan-17");
    expect(input.selectedItemIds).toEqual(["item-1"]);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("regenerates the reused plan on demand and switches to the fresh flow", async () => {
    const reused = {
      ...plan,
      status: "confirmed",
      items: plan.items.map((item) => ({ ...item, approvalStatus: "approved" })),
    } as unknown as TopicPlanProjection;
    const fresh = { ...plan, id: "plan-18", status: "awaiting-confirmation", revision: 0 };
    mocks.regenerate.mockResolvedValue(fresh);
    render(
      <TopicPlanGateCard
        data={{ kind: "topic-plan", outcome: "reused-confirmed-plan", plan: reused }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重新生成内容计划" }));
    await waitFor(() => expect(mocks.regenerate).toHaveBeenCalledTimes(1));
    // 新计划按正常待决流程呈现：待决提示回归，主按钮恢复「确认内容计划」。
    expect(await screen.findByText("确认后进入文章生成")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新生成内容计划" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /确认内容计划（0）/ }),
    ).toBeInTheDocument();
  });
});
