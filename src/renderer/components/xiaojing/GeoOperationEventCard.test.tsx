import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithTheme as render } from "@/test/renderWithTheme";
import { planGeoOperation } from "../../../shared/geo/operation";
import type { GeoOperationProjection } from "../../../shared/geo/operation";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  loadGeoOperation: vi.fn(),
  controlGeoOperation: vi.fn(),
  agentResponding: false,
  queueListener: null as null | ((event: { payload: unknown }) => void),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({
    sessionId: "session-17",
    isLoading: mocks.agentResponding,
  }),
}));

vi.mock("@/api/geoOperationClient", () => ({
  loadGeoOperation: mocks.loadGeoOperation,
  controlGeoOperation: mocks.controlGeoOperation,
}));

vi.mock("@/utils/tauriListen", () => ({
  listenWithCleanup: vi.fn(
    async (
      _event: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      mocks.queueListener = handler;
      return { unlisten: vi.fn(), isRegistered: () => true };
    },
  ),
}));

vi.mock("@/utils/browserMock", () => ({
  isTauriEnvironment: () => true,
}));

vi.mock("./GeoOperationGatePanels", () => ({
  default: ({ operation }: { operation: { id: string } }) => (
    <div data-geo-gate-stub={operation.id} />
  ),
}));

import GeoOperationEventCard, {
  parseGeoOperationEventCard,
} from "./GeoOperationEventCard";

const operation = {
  id: "operation-17",
  workspaceId: "brand-17",
  sessionId: "session-17",
  goal: "生成三篇文章",
  status: "awaiting-confirmation",
  revision: 4,
  executionSidecarGeneration: 18,
  steps: [
    { id: "generate", title: "生成文章", status: "succeeded", capability: "content-production" },
    {
      id: "confirm",
      title: "确认文章",
      status: "awaiting-confirmation",
      capability: "content-production",
      confirmation: {
        kind: "article-approval",
        authority: "brand-workspace",
        title: "审核并批准文章",
        summary: "草稿、事实与双质量门结果必须由你审核。",
      },
    },
  ],
} as unknown as GeoOperationProjection;

const runningOperation = {
  ...operation,
  status: "running",
  revision: 7,
  checkpoint: {
    activeStepId: "generate",
    completedStepIds: [],
    completedUnitRefs: [],
    safeToResume: true,
    savedAt: "2026-08-15T00:02:00Z",
  },
} as unknown as GeoOperationProjection;

const queueEvent = (
  permit: Record<string, unknown>,
  sessionId = "session-17",
) => ({
  payload: {
    workspaceId: "brand-17",
    sessionId,
    permit,
  },
});

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.loadGeoOperation.mockReset();
  mocks.loadGeoOperation.mockResolvedValue(operation);
  mocks.controlGeoOperation.mockReset();
  mocks.agentResponding = false;
  mocks.queueListener = null;
});

describe("GeoOperationEventCard", () => {
  it("parses exact operation MCP results but rejects arbitrary JSON", () => {
    expect(
      parseGeoOperationEventCard(
        JSON.stringify({
          kind: "geo-operation",
          operation,
        }),
      )?.operations,
    ).toEqual([operation]);
    expect(
      parseGeoOperationEventCard(JSON.stringify({ kind: "other", operation })),
    ).toBeNull();
  });

  it("renders a structured internal event without a user-message role", () => {
    const { container } = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [operation] }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "GEO 优化进度" }),
    ).toBeInTheDocument();
    expect(screen.getByText("生成三篇文章")).toBeInTheDocument();
    expect(screen.getByText(/不是用户发送的消息/)).toBeInTheDocument();
    expect(document.querySelector('[data-message-role="user"]')).toBeNull();
    expect(container.querySelectorAll("[data-geo-gate-stub]").length).toBe(1);
  });

  // 计划播报：卡片必须展示权威步骤清单与当前停靠的确认门，
  // 不依赖模型在正文里复述计划。
  it("broadcasts the authoritative step plan and the gate it stops at", () => {
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [operation] }}
      />,
    );

    expect(screen.getByRole("list", { name: "GEO 操作步骤计划" })).toBeInTheDocument();
    expect(screen.getByText("生成文章")).toBeInTheDocument();
    expect(
      screen.getByText(/审核并批准文章 — 停在待确认门/),
    ).toBeInTheDocument();
    expect(screen.getByText(/草稿、事实与双质量门结果必须由你审核/)).toBeInTheDocument();
  });

  // 18 步按阶段分组展示：阶段行给出每阶段的完成度与状态，
  // 唯一待确认的门在阶段行和步骤行上都可见，不再淹没在全量清单里。
  it("groups the full 18-step plan under the six spoken stages", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const full = {
      ...operation,
      id: "operation-full",
      goal: "完整 GEO 优化",
      steps: plan.steps.map((step) =>
        step.id === "confirm-knowledge"
          ? { ...step, status: "awaiting-confirmation" as const }
          : step,
      ),
    } as unknown as GeoOperationProjection;

    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [full] }}
      />,
    );

    const list = screen.getByRole("list", { name: "GEO 操作步骤计划" });
    for (const header of [
      "品牌知识 · 0/3",
      "问题机会 · 0/2",
      "内容生产 · 0/4",
      "渠道计划 · 0/2",
      "发布 · 0/3",
      "监测 · 0/4",
    ]) {
      expect(within(list).getByText(new RegExp(header))).toBeInTheDocument();
    }
    expect(screen.getByText(/0\/18 步/)).toBeInTheDocument();
    // 首个确认门在步骤行上仍然完整可见。
    expect(screen.getByText(/确认品牌知识变更 — 停在待确认门/)).toBeInTheDocument();
  });

  // 回归：revision 是内部乐观锁版本号，属于工程术语，
  // 不得出现在用户可见的卡片文案里。
  it("does not surface the internal revision counter", () => {
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [operation] }}
      />,
    );

    expect(screen.queryByText(/revision/)).toBeNull();
  });

  it("shows the Rust-owned queue reason and exact FIFO position", () => {
    render(
      <GeoOperationEventCard
        data={{
          kind: "geo-operation",
          operations: [
            {
              ...operation,
              status: "queued",
              queuePosition: 3,
              queueReason: "全局重型 Provider 并发已达上限（5）",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText(/排队位置 3/)).toHaveTextContent(
      "全局重型 Provider 并发已达上限（5）",
    );
  });

  // 回归 GD-13：交互面板只挂在最新一张进度卡片上，
  // 历史卡片不重复渲染确认界面。
  it("mounts the gate interaction host on the newest card only", () => {
    const first = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [operation] }}
      />,
    );
    expect(first.container.querySelectorAll("[data-geo-gate-stub]").length).toBe(
      1,
    );

    const second = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation-projection", operations: [operation] }}
      />,
    );
    expect(
      second.container.querySelectorAll("[data-geo-gate-stub]").length,
    ).toBe(1);
    expect(first.container.querySelectorAll("[data-geo-gate-stub]").length).toBe(
      0,
    );
  });

  it("mounts no gate host for terminal operations", () => {
    const { container } = render(
      <GeoOperationEventCard
        data={{
          kind: "geo-operation",
          operations: [
            { ...operation, status: "succeeded" },
          ],
        }}
      />,
    );
    expect(container.querySelectorAll("[data-geo-gate-stub]").length).toBe(0);
  });

  // agent 回合（思考/工具/正文）进行中，历史卡片挂起交互：
  // 卡片等小鲸说完判断与建议后才承载操作，不与 agent 各走各的。
  it("suspends the gate host while the agent turn is responding", () => {
    mocks.agentResponding = true;
    const { container } = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [operation] }}
      />,
    );
    expect(container.querySelectorAll("[data-geo-gate-stub]").length).toBe(0);
  });

  // 回归：inspect_geo_operations 空列表是合法权威结果，此前 parse 返回
  // null 导致掉回裸工具行（用户只看到 MCP FQN 和 `{}` 输入）。
  it("parses an empty projection list into empty-state card data", () => {
    expect(
      parseGeoOperationEventCard(
        JSON.stringify({
          kind: "geo-operation-projection",
          result: [],
        }),
      ),
    ).toEqual({ kind: "geo-operation-projection", operations: [] });
    expect(
      parseGeoOperationEventCard(
        JSON.stringify({ kind: "geo-operation-projection", result: "junk" }),
      ),
    ).toBeNull();
  });

  it("renders an explicit empty state instead of falling back to the raw tool row", () => {
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation-projection", operations: [] }}
      />,
    );

    expect(screen.getByText("当前会话还没有 GEO 操作记录。")).toBeInTheDocument();
  });

  // 操作生命周期控制只生活在聊天进度卡上（ticket 25）：
  // 按操作状态呈现按钮，并沿用既有控制端点提交 revision CAS。
  it("hosts lifecycle controls on the host card and submits with revision CAS", async () => {
    const paused = {
      ...runningOperation,
      status: "paused",
      revision: 8,
    } as unknown as GeoOperationProjection;
    mocks.loadGeoOperation.mockResolvedValue(runningOperation);
    // 控制提交成功后，轮询真相切换为暂停后的投影，避免测试内竞态。
    mocks.controlGeoOperation.mockImplementation(async () => {
      mocks.loadGeoOperation.mockResolvedValue(paused);
      return paused;
    });
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [runningOperation] }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    await waitFor(() =>
      expect(mocks.controlGeoOperation).toHaveBeenCalledWith(
        mocks.apiPost,
        { workspaceId: "brand-17", sessionId: "session-17" },
        {
          operationId: "operation-17",
          expectedRevision: 7,
          action: "pause",
        },
      ),
    );
    // 控制响应是权威投影：卡片立即切换到暂停后的状态。
    expect(await screen.findByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "暂停" }),
    ).not.toBeInTheDocument();
  });

  it("adapts control buttons to paused, failed and terminal states", () => {
    const paused = {
      ...runningOperation,
      status: "paused",
    } as unknown as GeoOperationProjection;
    mocks.loadGeoOperation.mockResolvedValue(paused);
    const first = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [paused] }}
      />,
    );
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "暂停" }),
    ).not.toBeInTheDocument();
    first.unmount();

    const failed = {
      ...runningOperation,
      status: "failed",
      error: { code: "provider_failed", message: "生成中断", retryable: true },
    } as unknown as GeoOperationProjection;
    mocks.loadGeoOperation.mockResolvedValue(failed);
    const second = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [failed] }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "重试失败单元" }),
    ).toBeInTheDocument();
    // failed 已是终态：只剩重试，不再提供取消。
    expect(
      screen.queryByRole("button", { name: "取消" }),
    ).not.toBeInTheDocument();
    second.unmount();

    const succeeded = {
      ...runningOperation,
      status: "succeeded",
    } as unknown as GeoOperationProjection;
    mocks.loadGeoOperation.mockResolvedValue(succeeded);
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [succeeded] }}
      />,
    );
    expect(screen.queryByRole("button", { name: "取消" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重试失败单元" }),
    ).not.toBeInTheDocument();
  });

  it("disables all controls while a submission is in flight and surfaces failures", async () => {
    mocks.loadGeoOperation.mockResolvedValue(runningOperation);
    let rejectControl: ((reason?: unknown) => void) | undefined;
    mocks.controlGeoOperation.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectControl = reject;
        }),
    );
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [runningOperation] }}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    const cancel = await screen.findByRole("button", { name: "取消" });
    expect(cancel).toBeDisabled();
    expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();

    act(() => {
      rejectControl?.(new Error("geo_operation_revision_conflict"));
    });
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("geo_operation_revision_conflict");
    // 失败后按钮恢复可用，用户可以直接重试或改选其它动作。
    expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();
  });

  it("shows the checkpoint recovery hint while recovering", () => {
    const recovering = {
      ...runningOperation,
      status: "recovering",
    } as unknown as GeoOperationProjection;
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [recovering] }}
      />,
    );

    expect(
      screen.getByText(/正在从已保存 checkpoint 恢复/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
  });

  // provider 排队提示迁移到聊天进度卡区域：数据通道仍是
  // geo-provider-queue-updated Tauri 事件，不新增 SSE 事件。
  it("renders the provider queue banner on the host card from queue events", async () => {
    mocks.loadGeoOperation.mockResolvedValue(runningOperation);
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [runningOperation] }}
      />,
    );
    await screen.findByRole("button", { name: "取消" });

    // 其它 Session 的排队事件与本卡无关。
    act(() => {
      mocks.queueListener?.(
        queueEvent(
          {
            state: "queued",
            requestId: "req-other",
            queueReason: null,
            queuePosition: 1,
            concurrencyLimit: 5,
          },
          "session-other",
        ),
      );
    });
    expect(screen.queryByText(/重型 Provider 排队位置/)).toBeNull();

    act(() => {
      mocks.queueListener?.(
        queueEvent({
          state: "queued",
          requestId: "req-1",
          queueReason: "全局重型 Provider 并发已达上限（5）",
          queuePosition: 2,
          concurrencyLimit: 5,
        }),
      );
    });
    expect(await screen.findByText(/重型 Provider 排队位置 2/)).toHaveTextContent(
      "全局重型 Provider 并发已达上限（5）",
    );

    // permit 获得后横幅消失，恢复安静。
    act(() => {
      mocks.queueListener?.(
        queueEvent({
          state: "acquired",
          requestId: "req-1",
          queueReason: null,
          queuePosition: null,
          concurrencyLimit: 5,
        }),
      );
    });
    await waitFor(() =>
      expect(screen.queryByText(/重型 Provider 排队位置/)).toBeNull(),
    );
  });

  it("keeps the inline queue line as the single queue hint while the operation itself is queued", async () => {
    const queued = {
      ...runningOperation,
      status: "queued",
      queuePosition: 3,
      queueReason: "全局重型 Provider 并发已达上限（5）",
    } as unknown as GeoOperationProjection;
    mocks.loadGeoOperation.mockResolvedValue(queued);
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [queued] }}
      />,
    );

    expect(await screen.findByText(/排队位置 3/)).toBeInTheDocument();
    act(() => {
      mocks.queueListener?.(
        queueEvent({
          state: "queued",
          requestId: "req-1",
          queueReason: null,
          queuePosition: 1,
          concurrencyLimit: 5,
        }),
      );
    });
    // 操作自身排队时，位置/原因已由内联行表达，不再叠加 provider 横幅。
    expect(screen.queryByText(/重型 Provider 排队位置/)).toBeNull();
  });
});
