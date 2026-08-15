import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { QuestionPoolProjection } from "../../../shared/geo/questionPool";
import XiaojingGeoWorkbench from "./XiaojingGeoWorkbench";

const mocks = vi.hoisted(() => ({
  sessionId: "session-08",
  apiPost: vi.fn(),
  latest: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/brandQuestionPoolClient", () => ({
  loadLatestQuestionPool: mocks.latest,
  generateQuestionPool: mocks.generate,
  cancelQuestionPool: mocks.cancel,
  confirmQuestionPool: mocks.confirm,
}));

const workspace = {
  id: "brand-08",
  name: "鲸跃科技",
  productLines: ["旗舰产品", "企业服务"],
  rootPath: "C:\\Xiaojing\\brands\\brand-08",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

function pool(
  overrides: Partial<QuestionPoolProjection> = {},
): QuestionPoolProjection {
  return {
    id: "pool-08",
    attemptId: "attempt-08",
    operationId: "operation-08",
    workspaceId: workspace.id,
    knowledgeVersion: 7,
    productLine: "旗舰产品",
    targetRegion: "成都",
    generationParameters: {
      policyVersion: "js-ai-dev-pred-1-v1",
      candidateLimit: 20,
      recentSelectionLimit: 20,
      priorityThresholds: { highAtSum: 150, mediumAtSum: 100 },
    },
    status: "confirmed",
    revision: 1,
    keywords: [
      {
        id: "kw-1",
        term: "成都汽车改装",
        category: "core",
        heat: "high",
        platform: "doubao",
      },
    ],
    questions: [
      {
        id: "q-1",
        text: "成都汽车改装哪家好？",
        selected: true,
        recommended: true,
        score: {
          mode: "pred-1",
          relevance: 90,
          recentPoolSimilarity: 20,
          optimizationPotential: 40,
          priorityTotal: 130,
          priority: "medium",
          formula: "traceable",
          policyVersion: "js-ai-dev-pred-1-v1",
        },
        evidence: [
          {
            kind: "keyword-search",
            reference: "kw-1",
            excerpt: "成都汽车改装",
          },
        ],
      },
      {
        id: "q-2",
        text: "锦江区汽车隔音推荐哪家？",
        selected: false,
        recommended: false,
        score: {
          mode: "pred-1",
          relevance: 80,
          recentPoolSimilarity: 0,
          optimizationPotential: 50,
          priorityTotal: 130,
          priority: "medium",
          formula: "traceable",
          policyVersion: "js-ai-dev-pred-1-v1",
        },
        evidence: [
          {
            kind: "keyword-search",
            reference: "kw-2",
            excerpt: "锦江区汽车隔音",
          },
        ],
      },
    ],
    sourceEvidence: [
      { kind: "knowledge-fact", reference: "7:industry", excerpt: "汽车改装" },
    ],
    checkpoints: [
      {
        stage: "keyword-search",
        status: "completed",
        attemptNumber: 1,
        billingKey: "a:k",
        inputHash: "a".repeat(64),
      },
      {
        stage: "question-generation",
        status: "completed",
        attemptNumber: 1,
        billingKey: "a:q",
        inputHash: "b".repeat(64),
      },
    ],
    reused: true,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    ...overrides,
  };
}

function renderWorkbench() {
  return render(
    <XiaojingGeoWorkbench
      currentWorkspace={workspace}
      onOpenWorkspace={vi.fn(async () => true)}
      materialImportEnabled
    />,
  );
}

describe("reachable structured question-pool workbench", () => {
  beforeEach(() => {
    localStorage.removeItem("xiaojing:geo-workbench-collapsed");
    mocks.sessionId = "session-08";
    for (const mock of Object.values(mocks).filter(
      (value) => typeof value === "function",
    )) {
      (mock as ReturnType<typeof vi.fn>).mockReset();
    }
    mocks.latest.mockResolvedValue(pool());
    mocks.confirm.mockResolvedValue({
      poolId: "pool-08",
      decisionId: "decision-08",
      decision: "confirm-selection",
      expectedRevision: 1,
      revision: 2,
      knowledgeVersion: 7,
      questions: [],
      selectedQuestionIds: [],
      actorId: "desktop-user",
      decidedAt: "2026-08-15T00:02:00Z",
    });
  });

  it("loads a valid pool without regenerating, then supports select/edit/delete/add and structured confirm", async () => {
    renderWorkbench();
    const region = await screen.findByRole("region", { name: "问题池选择" });

    expect(mocks.latest).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-08", sessionId: "session-08" },
      "旗舰产品",
    );
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(within(region).getByText("已复用")).toBeInTheDocument();
    expect(within(region).getByText("知识 v7")).toBeInTheDocument();
    expect(
      within(region).getByText(/keyword-search:completed#1/),
    ).toBeInTheDocument();

    fireEvent.click(
      within(region).getByRole("checkbox", {
        name: "选择 锦江区汽车隔音推荐哪家？",
      }),
    );
    fireEvent.click(
      within(region).getByRole("button", { name: "编辑 成都汽车改装哪家好？" }),
    );
    fireEvent.change(
      within(region).getByRole("textbox", { name: "编辑 q-1" }),
      {
        target: { value: "成都汽车音响升级哪家好？" },
      },
    );
    fireEvent.click(
      within(region).getByRole("button", {
        name: "删除 锦江区汽车隔音推荐哪家？",
      }),
    );
    fireEvent.change(within(region).getByPlaceholderText("补充一个问题"), {
      target: { value: "成都汽车隔音怎么选？" },
    });
    fireEvent.click(within(region).getByRole("button", { name: "新增问题" }));
    fireEvent.click(
      within(region).getByRole("button", { name: /确认本轮问题/ }),
    );

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    const [, identity, input] = mocks.confirm.mock.calls[0];
    expect(identity).toEqual({
      workspaceId: "brand-08",
      sessionId: "session-08",
    });
    expect(input).toMatchObject({ poolId: "pool-08", expectedRevision: 1 });
    expect(
      input.questions.map((question: { text: string }) => question.text),
    ).toEqual(["成都汽车音响升级哪家好？", "成都汽车隔音怎么选？"]);
    expect(screen.queryByText(/typed user message/i)).not.toBeInTheDocument();
  });

  it("generates only after required product/region input and can cancel the active attempt", async () => {
    mocks.latest.mockResolvedValue(null);
    let resolveGenerate!: (value: QuestionPoolProjection) => void;
    mocks.generate.mockReturnValue(
      new Promise<QuestionPoolProjection>((resolve) => {
        resolveGenerate = resolve;
      }),
    );
    mocks.cancel.mockResolvedValue(
      pool({ status: "cancelled", reused: false }),
    );
    renderWorkbench();

    await waitFor(() => expect(mocks.latest).toHaveBeenCalled());
    const generateButton = screen.getByRole("button", {
      name: "加载或生成问题池",
    });
    expect(generateButton).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("如：成都"), {
      target: { value: "成都" },
    });
    expect(generateButton).toBeEnabled();
    fireEvent.click(generateButton);

    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledTimes(1));
    const generatedInput = mocks.generate.mock.calls[0][2];
    expect(mocks.cancel.mock.calls[0][2]).toBe(generatedInput.idempotencyKey);
    resolveGenerate(pool({ reused: false }));
  });

  it("retries with the same attempt key and the retry flag", async () => {
    mocks.latest.mockResolvedValue(null);
    mocks.generate
      .mockRejectedValueOnce(new Error("question_pool_provider_failed"))
      .mockResolvedValueOnce(pool({ reused: false }));
    renderWorkbench();
    await waitFor(() => expect(mocks.latest).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText("如：成都"), {
      target: { value: "成都" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加载或生成问题池" }));
    await screen.findByText("question_pool_provider_failed");
    fireEvent.click(screen.getByRole("button", { name: "从失败步骤重试" }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1][2]).toMatchObject({
      idempotencyKey: mocks.generate.mock.calls[0][2].idempotencyKey,
      retry: true,
    });
  });
});
