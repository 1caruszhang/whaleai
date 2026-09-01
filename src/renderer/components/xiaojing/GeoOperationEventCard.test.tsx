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

// 真实 mid-run 投影（ADR-0011）：工作步骤 running 带量化进度，
// 后续确认门尚未停靠（pending）——状态行报「正在生成文章 3/5」，
// 不把远未停靠的门标成「当前」。
const runningOperation = {
  ...operation,
  status: "running",
  revision: 7,
  steps: [
    {
      ...operation.steps[0],
      status: "running",
      progress: { current: 3, total: 5 },
    },
    { ...operation.steps[1], status: "pending" },
  ],
  checkpoint: {
    activeStepId: "generate",
    completedStepIds: [],
    completedUnitRefs: [],
    safeToResume: true,
    savedAt: "2026-08-15T00:02:00Z",
  },
} as unknown as GeoOperationProjection;

// 停靠计划认可门的完整优化计划：完整卡只在计划边界（认可门/终态）渲染。
const parkedFullPlan = (() => {
  const plan = planGeoOperation({
    intent: "full-optimization",
    goal: "完整 GEO 优化",
  });
  return {
    ...operation,
    id: "operation-full",
    goal: "完整 GEO 优化",
    steps: plan.steps,
  } as unknown as GeoOperationProjection;
})();

// 放行后的 running 投影：认可门已过、首个工作步骤进行中。
const releasedFullPlan = {
  ...parkedFullPlan,
  status: "running",
  revision: 5,
  steps: parkedFullPlan.steps.map((step, index) => ({
    ...step,
    status: index === 0 ? "succeeded" : index === 1 ? "running" : step.status,
  })),
} as unknown as GeoOperationProjection;

// 放行后的 armed 窗口（ADR-0011 Decision 1）：认可门已放行（succeeded），
// 首个工作步骤 armed（ready）还未 running——正是用户放行后长时间静默
// 曾被误报成「待开始 · N/M 道闸门 · 当前：下一道门」的矛盾组合。
const armedFullPlan = {
  ...parkedFullPlan,
  status: "ready",
  revision: 6,
  steps: parkedFullPlan.steps.map((step, index) => ({
    ...step,
    status: index === 0 ? "succeeded" : index === 1 ? "ready" : step.status,
  })),
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
        data={{ kind: "geo-operation", operations: [parkedFullPlan] }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "GEO 优化进度" }),
    ).toBeInTheDocument();
    expect(screen.getByText("完整 GEO 优化")).toBeInTheDocument();
    expect(screen.getByText(/不是用户发送的消息/)).toBeInTheDocument();
    // 页脚不带「上方/下方」方位指代：多卡共存时会指错对象。
    expect(screen.queryByText(/上方卡片/)).toBeNull();
    expect(document.querySelector('[data-message-role="user"]')).toBeNull();
    expect(container.querySelectorAll("[data-geo-gate-stub]").length).toBe(1);
  });

  // 计划播报：完整卡必须展示权威步骤清单与当前停靠的认可门，
  // 不依赖模型在正文里复述计划。
  it("broadcasts the authoritative step plan and the gate it stops at", () => {
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [parkedFullPlan] }}
      />,
    );

    expect(screen.getByRole("list", { name: "GEO 操作步骤计划" })).toBeInTheDocument();
    expect(screen.getByText("收集品牌材料")).toBeInTheDocument();
    expect(
      screen.getByText(/认可本轮计划 — 停在待确认门/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/查看上方阶段与步骤计划后放行/),
    ).toBeInTheDocument();
    // 后续各阶段闸门以普通步骤行可见，状态由各自的确认卡承载。
    expect(screen.getByText("确认知识变更")).toBeInTheDocument();
    expect(screen.getByText("确认付费外部发布")).toBeInTheDocument();
  });

  // 计划认可门停靠时，认可面板是卡头主操作：渲染先于 19 步重播，
  // 与知识确认卡「整卡确认常驻卡头、不藏在长列表底部」同一原则；
  // 计划认可卡与知识确认卡同回合共存时，主操作不被长列表压底。
  it("mounts the plan-ack panel above the step replay when parked at the gate", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const full = {
      ...operation,
      id: "operation-full",
      goal: "完整 GEO 优化",
      steps: plan.steps,
    } as unknown as GeoOperationProjection;

    const { container } = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [full] }}
      />,
    );

    const panel = container.querySelector("[data-geo-gate-stub]");
    const replay = screen.getByRole("list", { name: "GEO 操作步骤计划" });
    expect(panel).not.toBeNull();
    expect(
      (panel as Element).compareDocumentPosition(replay) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // 19 步按阶段分组展示：阶段行给出每阶段的完成度与状态，
  // 计划认可门借用首步 capability 落进开头阶段并在步骤行完整可见。
  it("groups the full 19-step plan under the six spoken stages", () => {
    const plan = planGeoOperation({
      intent: "full-optimization",
      goal: "完整 GEO 优化",
    });
    const full = {
      ...operation,
      id: "operation-full",
      goal: "完整 GEO 优化",
      steps: plan.steps,
    } as unknown as GeoOperationProjection;

    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [full] }}
      />,
    );

    const list = screen.getByRole("list", { name: "GEO 操作步骤计划" });
    for (const header of [
      "品牌知识 · 0/4",
      "问题机会 · 0/2",
      "内容生产 · 0/4",
      "渠道计划 · 0/2",
      "发布 · 0/3",
      "监测 · 0/4",
    ]) {
      expect(within(list).getByText(new RegExp(header))).toBeInTheDocument();
    }
    expect(screen.getByText(/0\/19 步/)).toBeInTheDocument();
    expect(screen.getByText(/认可本轮计划 — 停在待确认门/)).toBeInTheDocument();
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
        data={{ kind: "geo-operation", operations: [parkedFullPlan] }}
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

  // 中间态快照（执行期 inspect 回合）不再重播完整计划：只保留一条轻量
  // 进度条——状态、闸门进度、生命周期控制与阀门面板；状态行从投影如实
  // 派生，running 工作步骤带量化进度时报「正在<步骤名> N/M」（ADR-0011）。
  it("renders mid-run snapshots as a compact strip without the step plan replay", async () => {
    mocks.loadGeoOperation.mockResolvedValue(runningOperation);
    const { container } = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [runningOperation] }}
      />,
    );

    expect(container.querySelector("[data-geo-operation-strip]")).not.toBeNull();
    expect(
      screen.queryByRole("list", { name: "GEO 操作步骤计划" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("GEO 操作已更新")).toBeNull();
    expect(container.querySelector("[data-geo-gate-progress]")).not.toBeNull();
    expect(
      screen.getByText(/进行中 · 正在生成文章 3\/5/),
    ).toBeInTheDocument();
    // 确认门尚未停靠：状态行不得把它标成「当前」。
    expect(screen.queryByText(/当前：/)).toBeNull();
    expect(await screen.findByRole("button", { name: "取消" })).toBeInTheDocument();
    expect(container.querySelectorAll("[data-geo-gate-stub]").length).toBe(1);
  });

  // 完整卡只在计划边界渲染：中间门停靠（非计划认可门）的快照不再展开
  // 19 步大卡——门本身由各阶段的确认卡承载，进度卡只以闸门进度条表达位置。
  it("renders mid-gate parked snapshots as the gate strip instead of the full card", () => {
    const { container } = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [operation] }}
      />,
    );

    expect(screen.queryByText("GEO 操作已更新")).toBeNull();
    expect(
      screen.queryByRole("list", { name: "GEO 操作步骤计划" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector("[data-geo-operation-strip]")).not.toBeNull();
    expect(container.querySelector("[data-geo-gate-progress]")).not.toBeNull();
    expect(
      screen.getByText(/待确认 · 0\/1 道闸门 · 当前：审核并批准文章/),
    ).toBeInTheDocument();
  });

  // ADR-0011 Decision 1 armed 窗口：工作步骤 armed（ready）且无 running
  // 时，状态行报「正在推进：<步骤名>」；操作 ready 但已放行过门时状态词
  // 报「进行中」，不再出现「待开始 · 当前：远未停靠的门」的矛盾组合。
  it("reports the armed work step after plan release instead of the far next gate", () => {
    mocks.loadGeoOperation.mockResolvedValue(armedFullPlan);
    render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [armedFullPlan] }}
      />,
    );

    expect(
      screen.getByText(/进行中 · 正在推进：收集品牌材料/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/当前：/)).toBeNull();
    expect(screen.queryByText(/待开始/)).toBeNull();
  });

  // 用户诉求回归：「GEO 操作已更新」大卡在计划放行后就地收敛为闸门进度条，
  // 历史消息里不再残留步骤计划重播。
  it("collapses the released plan card into the gate progress strip", async () => {
    mocks.loadGeoOperation.mockResolvedValue(releasedFullPlan);
    const { container } = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [parkedFullPlan] }}
      />,
    );

    // 放行前：完整卡广播计划并停靠认可门，闸门进度条随计划卡一起出现，
    // 「计划」段停在待确认（warning），不是放行后才冒出来的新元素。
    expect(screen.getByText("GEO 操作已更新")).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "GEO 操作步骤计划" }),
    ).toBeInTheDocument();
    const parkedBar = container.querySelector("[data-geo-gate-progress]");
    expect(parkedBar).not.toBeNull();
    expect(
      within(parkedBar as HTMLElement).getByText("计划").className,
    ).toContain("text-[var(--warning)]");

    // 放行后（轮询拿到 running 投影）：大卡就地收敛，同一条进度条原地推进。
    await waitFor(() =>
      expect(screen.queryByText("GEO 操作已更新")).toBeNull(),
    );
    expect(
      screen.queryByText(/不是用户发送的消息/),
    ).not.toBeInTheDocument();
    expect(container.querySelector("[data-geo-operation-steps]")).toBeNull();
    const strip = container.querySelector("[data-geo-operation-strip]");
    expect(strip).not.toBeNull();
    expect(
      within(strip as HTMLElement).getByText("计划").className,
    ).toContain("text-[var(--accent)]");
    // 首个工作步骤 running：状态行报真实执行，闸门不再被误标为「当前」。
    expect(
      screen.getByText(/进行中 · 正在收集品牌材料/),
    ).toBeInTheDocument();
    // 段 = 确认门：8 段两字短名齐全，只按闸门显示。
    for (const label of [
      "计划",
      "知识",
      "选题",
      "内容",
      "文章",
      "分发",
      "发布",
      "监测",
    ]) {
      expect(within(strip as HTMLElement).getByText(label)).toBeInTheDocument();
    }
  });

  it("keeps at most one compact strip per operation; older snapshots render nothing", async () => {
    mocks.loadGeoOperation.mockResolvedValue(runningOperation);
    const first = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation", operations: [runningOperation] }}
      />,
    );
    await screen.findByRole("button", { name: "取消" });

    const second = render(
      <GeoOperationEventCard
        data={{ kind: "geo-operation-projection", operations: [runningOperation] }}
      />,
    );
    // 最新信封承载轻量条；历史信封整条消失，不残留第二条进度条。
    await within(second.container).getByRole("button", { name: "取消" });
    expect(first.container.querySelector("button")).toBeNull();
    expect(first.container.querySelector("[data-geo-gate-stub]")).toBeNull();
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
