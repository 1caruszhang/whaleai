import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  GeoOperationProjection,
  GeoOperationStep,
} from "../../../shared/geo/operation";
import XiaojingGeoOperationPanel from "./XiaojingGeoOperationPanel";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  load: vi.fn(),
  loadOne: vi.fn(),
  control: vi.fn(),
  choose: vi.fn(),
  articleProps: vi.fn(),
  publishProps: vi.fn(),
  monitorProps: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17", toolCompleteCount: 3 }),
}));

vi.mock("@/api/geoOperationClient", () => ({
  loadGeoOperations: mocks.load,
  loadGeoOperation: mocks.loadOne,
  controlGeoOperation: mocks.control,
  chooseNextRoundKnowledge: mocks.choose,
}));

vi.mock("./XiaojingMaterialImportPanel", () => ({
  default: () => <section aria-label="材料导入卡片" />,
}));
vi.mock("./XiaojingQuestionPoolPanel", () => ({
  default: () => <section aria-label="问题池卡片" />,
}));
vi.mock("./XiaojingGeoBaselinePanel", () => ({
  default: () => <section aria-label="基线证据卡片" />,
}));
vi.mock("./XiaojingTopicPlanPanel", () => ({
  default: () => <section aria-label="内容计划卡片" />,
}));
vi.mock("./XiaojingArticleGenerationPanel", () => ({
  default: (props: { operationId?: string }) => {
    mocks.articleProps(props);
    return <section aria-label="文章审核卡片" />;
  },
}));
vi.mock("./XiaojingDistributionPlanPanel", () => ({
  default: () => <section aria-label="渠道计划卡片" />,
}));
vi.mock("./XiaojingPublishSchedulerPanel", () => ({
  default: (props: { executionId?: string }) => {
    mocks.publishProps(props);
    return <section aria-label="发布确认卡片" />;
  },
}));
vi.mock("./XiaojingPostPublishMonitoringPanel", () => ({
  default: (props: { planId?: string }) => {
    mocks.monitorProps(props);
    return <section aria-label="监测结果卡片" />;
  },
}));
vi.mock("./XiaojingRealGeoDashboard", () => ({
  default: () => <section aria-label="GEO 仪表盘卡片" />,
}));

const workspace = {
  id: "brand-17",
  name: "鲸跃科技",
  productLines: ["旗舰产品"],
  rootPath: "/brands/brand-17",
  createdAt: "2026-08-15T00:00:00Z",
  updatedAt: "2026-08-15T00:00:00Z",
};

function step(overrides: Partial<GeoOperationStep>): GeoOperationStep {
  return {
    id: "step",
    title: "步骤",
    capability: "content-production",
    status: "pending",
    requiresConfirmation: false,
    irreversible: false,
    retryUnit: "operation",
    condition: null,
    confirmation: null,
    ...overrides,
  };
}

function operation(
  overrides: Partial<GeoOperationProjection> = {},
): GeoOperationProjection {
  return {
    id: "operation-17",
    workspaceId: workspace.id,
    sessionId: "session-17",
    kind: "article-generation",
    goal: "直接生成一篇知识文章",
    status: "running",
    steps: [
      step({
        id: "generate-articles",
        title: "生成文章",
        capability: "content-production",
        status: "running",
      }),
      step({
        id: "confirm-articles",
        title: "审核文章",
        capability: "content-production",
        status: "pending",
      }),
    ],
    inputRefs: [{ kind: "knowledge-version", id: "7", revision: 7 }],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    revision: 4,
    executionGeneration: 1,
    executionSidecarGeneration: 18,
    queueReason: null,
    queuePosition: null,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:01:00Z",
    terminalAt: null,
    ...overrides,
  };
}

describe("XiaojingGeoOperationPanel", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.load.mockReset();
    mocks.loadOne.mockReset();
    mocks.control.mockReset();
    mocks.choose.mockReset();
    mocks.articleProps.mockReset();
    mocks.publishProps.mockReset();
    mocks.monitorProps.mockReset();
  });

  it("focuses the exact Operation and concrete structured card from a notification locator", async () => {
    const target = operation({
      id: "operation-target",
      goal: "精确发布目标",
      steps: [step({ capability: "content-production", status: "running" })],
    });
    mocks.load.mockResolvedValue([operation()]);
    mocks.loadOne.mockResolvedValue(target);
    render(
      <XiaojingGeoOperationPanel
        workspace={workspace}
        navigationTarget={{
          workspaceId: workspace.id,
          sessionId: "session-17",
          operationId: target.id,
          card: "publish-execution",
          artifact: { kind: "publish-execution", id: "execution-exact" },
          nonce: 1,
        }}
      />,
    );

    expect(await screen.findByText("精确发布目标")).toBeInTheDocument();
    expect(mocks.loadOne).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: workspace.id, sessionId: "session-17" },
      "operation-target",
      expect.any(AbortSignal),
    );
    const card = screen.getByRole("region", { name: "当前步骤结果展示" });
    expect(card).toHaveAttribute("data-geo-navigation-card", "publish-execution");
    expect(card).toHaveAttribute("data-geo-navigation-artifact", "execution-exact");
    expect(mocks.publishProps).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-exact",
    }));
    expect(mocks.articleProps).not.toHaveBeenCalled();
  });

  it("keeps a direct article intent on its real minimal steps", async () => {
    mocks.load.mockResolvedValue([operation()]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    const current = await screen.findByRole("region", {
      name: "当前 GEO 操作",
    });
    expect(
      within(current).getByText("直接生成一篇知识文章"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "当前操作步骤" }),
    ).toHaveTextContent("2 步");
    expect(
      screen.queryByRole("region", { name: "GEO 阶段总览" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "文章审核卡片" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "问题池卡片" }),
    ).not.toBeInTheDocument();
  });

  it("shows all six phases only for the full workflow and keeps recovery details usable", async () => {
    const capabilities: GeoOperationStep["capability"][] = [
      "brand-knowledge",
      "question-opportunities",
      "content-planning",
      "distribution-planning",
      "publishing",
      "monitoring",
    ];
    mocks.load.mockResolvedValue([
      operation({
        kind: "full-optimization",
        goal: "完成本轮 GEO 全链路优化",
        status: "recovering",
        steps: capabilities.map((capability, index) =>
          step({
            id: `full-${index}`,
            title: `阶段 ${index + 1}`,
            capability,
            status: index === 0 ? "running" : "pending",
          }),
        ),
        checkpoint: {
          activeStepId: "full-0",
          completedStepIds: ["collect-materials"],
          completedUnitRefs: [],
          safeToResume: true,
          savedAt: "2026-08-15T00:02:00Z",
        },
        artifactRefs: [
          { kind: "question-pool", id: "pool-long-reference-17", revision: 3 },
        ],
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    const phases = await screen.findByRole("region", {
      name: "GEO 阶段总览",
    });
    expect(within(phases).getAllByRole("listitem")).toHaveLength(6);
    // 恢复与控制入口已迁往聊天进度卡；工作台只保留恢复检查点投影。
    expect(
      screen.queryByText(/正在从已保存 checkpoint 恢复/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "恢复检查点" }),
    ).toHaveTextContent("已保存安全恢复点");
    expect(screen.getByRole("region", { name: "操作产物" })).toHaveTextContent(
      "pool-long-reference-17",
    );
  });

  // Ticket 25：过程控制与排队/恢复横幅只有聊天进度卡一个入口，
  // 工作台操作卡不得残留任何控制按钮与横幅。
  it("renders the operation card as a read-only projection without controls or queue banners", async () => {
    mocks.load.mockResolvedValue([
      operation({
        status: "running",
        checkpoint: {
          activeStepId: "generate-articles",
          completedStepIds: [],
          completedUnitRefs: [],
          safeToResume: true,
          savedAt: "2026-08-15T00:02:00Z",
        },
      }),
      operation({
        id: "operation-queued",
        goal: "排队中的操作",
        status: "queued",
        queueReason: "全局重型 Provider 并发已达上限（5）",
        queuePosition: 2,
      }),
      operation({
        id: "operation-recovering",
        goal: "恢复中的操作",
        status: "recovering",
        checkpoint: {
          activeStepId: "generate-articles",
          completedStepIds: [],
          completedUnitRefs: [],
          safeToResume: true,
          savedAt: "2026-08-15T00:03:00Z",
        },
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByRole("region", { name: "当前 GEO 操作" });
    for (const control of ["暂停", "恢复", "重试失败单元", "取消"]) {
      expect(
        screen.queryByRole("button", { name: control }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.queryByText(/重型 Provider 排队位置/),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换 GEO 操作" }));
    fireEvent.click(
      screen.getByRole("button", { name: "排队中 · 排队中的操作" }),
    );
    expect(await screen.findByText("排队中的操作")).toBeInTheDocument();
    expect(screen.queryByText(/排队位置/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换 GEO 操作" }));
    fireEvent.click(
      screen.getByRole("button", { name: "恢复中 · 恢复中的操作" }),
    );
    expect(await screen.findByText("恢复中的操作")).toBeInTheDocument();
    expect(
      screen.queryByText(/正在从已保存 checkpoint 恢复/),
    ).not.toBeInTheDocument();
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it("defers the next-round knowledge branch to the chat and surfaces retryable failures", async () => {
    const nextRound = operation({
      kind: "next-round-optimization",
      status: "awaiting-confirmation",
      goal: "开始下一轮优化",
      steps: [
        step({
          id: "decide-knowledge-refresh",
          title: "选择是否更新品牌知识",
          capability: "brand-knowledge",
          status: "awaiting-confirmation",
        }),
      ],
      pendingConfirmation: {
        kind: "next-round-knowledge",
        authority: "brand-workspace",
        title: "是否先更新品牌知识",
        summary: "请选择沿用当前知识，或先更新知识。",
      },
    });
    mocks.load.mockResolvedValue([nextRound]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByText("开始下一轮优化");
    expect(
      screen.queryByRole("region", { name: "GEO 阶段总览" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "待确认事项" }),
    ).toHaveTextContent("是否先更新品牌知识");
    // 下一轮知识分支改由聊天内 Agent 提问并记录；工作台不再提供平行按钮。
    expect(screen.getByText(/请回到聊天作答/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "沿用当前知识" }),
    ).not.toBeInTheDocument();
  });

  it("keeps background work alive across workbench unmount and reloads persisted state", async () => {
    mocks.load
      .mockResolvedValueOnce([
        operation({
          status: "queued",
          queueReason: "全局重型 Provider 并发已达上限（5）",
          queuePosition: 2,
        }),
      ])
      .mockResolvedValueOnce([
        operation({
          status: "recovering",
          revision: 5,
          executionGeneration: 3,
          checkpoint: {
            activeStepId: "generate-articles",
            completedStepIds: [],
            completedUnitRefs: [],
            safeToResume: true,
            savedAt: "2026-08-15T01:00:00Z",
            executionGeneration: 2,
            sidecarGeneration: 41,
            activeRetryUnit: "article",
            activeUnitId: "article-18",
          },
        }),
      ]);

    const first = render(<XiaojingGeoOperationPanel workspace={workspace} />);
    // 排队状态由状态徽标表达，位置与原因横幅在聊天进度卡上。
    expect(await screen.findByText("排队中")).toBeInTheDocument();
    expect(screen.queryByText(/排队位置/)).not.toBeInTheDocument();
    first.unmount();
    expect(mocks.control).not.toHaveBeenCalled();

    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    expect(await screen.findByText("恢复中")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "恢复检查点" }),
    ).toHaveTextContent("已保存安全恢复点");
    expect(mocks.control).not.toHaveBeenCalled();
  });

  it("does not stop work while hidden and refreshes persisted state when the app becomes visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    mocks.load
      .mockResolvedValueOnce([operation({ status: "running" })])
      .mockResolvedValueOnce([
        operation({
          status: "recovering",
          revision: 5,
          checkpoint: {
            activeStepId: "generate-articles",
            completedStepIds: [],
            completedUnitRefs: [],
            safeToResume: true,
            savedAt: "2026-08-15T01:10:00Z",
          },
        }),
      ]);

    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    expect(await screen.findByText("直接生成一篇知识文章")).toBeInTheDocument();
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.control).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("恢复中")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.control).not.toHaveBeenCalled();
    visibilitySpy.mockRestore();
  });

  it("supports loading, empty, and recoverable read-failure states", async () => {
    let resolveInitial:
      | ((operations: GeoOperationProjection[]) => void)
      | undefined;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise<GeoOperationProjection[]>((resolve) => {
          resolveInitial = resolve;
        }),
    );
    const view = render(<XiaojingGeoOperationPanel workspace={workspace} />);
    expect(screen.getByText(/正在读取当前 GEO 操作/)).toBeInTheDocument();
    resolveInitial?.([]);
    expect(
      await screen.findByRole("region", { name: "GEO 操作空状态" }),
    ).toBeInTheDocument();

    view.unmount();
    mocks.load
      .mockRejectedValueOnce(new Error("operation snapshot unavailable"))
      .mockResolvedValueOnce([]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "operation snapshot unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "重试读取操作" }));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3));
    expect(
      await screen.findByRole("region", { name: "GEO 操作空状态" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
