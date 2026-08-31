import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  articleProps: vi.fn(),
  publishProps: vi.fn(),
  monitorProps: vi.fn(),
  knowledgeProps: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17", toolCompleteCount: 3 }),
}));

vi.mock("@/api/geoOperationClient", () => ({
  loadGeoOperations: mocks.load,
  loadGeoOperation: mocks.loadOne,
}));

vi.mock("./XiaojingBrandKnowledgePanel", () => ({
  default: (props: { workspaceId?: string; refreshKey?: number }) => {
    mocks.knowledgeProps(props);
    return <section aria-label="品牌知识卡片" />;
  },
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

/** 六个共享阶段各一条最小步骤，便于断言骨架按阶段分组。 */
function fullOptimizationSteps(
  active: Partial<GeoOperationStep> = {},
): GeoOperationStep[] {
  return [
    step({
      id: "confirm-knowledge",
      capability: "brand-knowledge",
      status: "succeeded",
    }),
    step({
      id: "confirm-question-selection",
      capability: "question-opportunities",
      status: "succeeded",
    }),
    step({
      id: "plan-topics",
      capability: "content-planning",
      status: "running",
      ...active,
    }),
    step({
      id: "confirm-distribution",
      capability: "distribution-planning",
      status: "pending",
    }),
    step({
      id: "confirm-publish",
      capability: "publishing",
      status: "pending",
    }),
    step({
      id: "confirm-monitoring",
      capability: "monitoring",
      status: "pending",
    }),
  ];
}

const PHASE_ROWS = [
  "品牌知识",
  "问题机会",
  "内容生产",
  "渠道计划",
  "发布",
  "监测",
] as const;

function phaseRow(title: string) {
  return screen.getByRole("button", { name: new RegExp(title) });
}

describe("XiaojingGeoOperationPanel", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.load.mockReset();
    mocks.loadOne.mockReset();
    mocks.articleProps.mockReset();
    mocks.publishProps.mockReset();
    mocks.monitorProps.mockReset();
    mocks.knowledgeProps.mockReset();
  });

  it("expands only the phase the focused operation is in and collapses the rest", async () => {
    mocks.load.mockResolvedValue([
      operation({
        kind: "full-optimization",
        goal: "完成本轮 GEO 全链路优化",
        steps: fullOptimizationSteps(),
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByRole("region", { name: "当前 GEO 操作" });
    // 当前阶段（内容生产）展开渲染产物，其余五阶段收起为单行。
    expect(phaseRow("内容生产")).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "内容计划卡片" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "文章审核卡片" }),
    ).toBeInTheDocument();
    for (const title of PHASE_ROWS.filter((name) => name !== "内容生产")) {
      expect(phaseRow(title)).toHaveAttribute("aria-expanded", "false");
    }
    expect(
      screen.queryByRole("region", { name: "问题池卡片" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "渠道计划卡片" }),
    ).not.toBeInTheDocument();
  });

  it("expands a collapsed phase row on click to review its products, one at a time", async () => {
    mocks.load.mockResolvedValue([
      operation({
        kind: "full-optimization",
        goal: "完成本轮 GEO 全链路优化",
        steps: fullOptimizationSteps(),
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    await screen.findByRole("region", { name: "当前 GEO 操作" });

    fireEvent.click(phaseRow("问题机会"));
    expect(phaseRow("问题机会")).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "问题池卡片" }),
    ).toBeInTheDocument();
    // 手风琴单开：回看其它阶段时原展开阶段收起。
    expect(phaseRow("内容生产")).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "文章审核卡片" }),
    ).not.toBeInTheDocument();
  });

  it("marks paused and failed phases with status dot text on the phase rows", async () => {
    mocks.load.mockResolvedValue([
      operation({
        kind: "full-optimization",
        goal: "发布阶段失败的全链路操作",
        status: "failed",
        steps: [
          step({ id: "k", capability: "brand-knowledge", status: "succeeded" }),
          step({
            id: "confirm-publish",
            capability: "publishing",
            status: "failed",
          }),
        ],
        error: {
          code: "geo_publish_failed",
          message: "渠道上传失败",
          retryable: true,
        },
      }),
      operation({
        id: "operation-paused",
        goal: "暂停中的文章操作",
        status: "paused",
        steps: [
          step({
            id: "generate-articles",
            capability: "content-production",
            status: "running",
          }),
        ],
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    await screen.findByRole("region", { name: "当前 GEO 操作" });

    // 终态失败操作不保持聚焦：骨架先落在仍活跃的暂停操作上。
    expect(screen.getByText("暂停中的文章操作")).toBeInTheDocument();
    expect(phaseRow("内容生产")).toHaveTextContent("已暂停");

    fireEvent.click(screen.getByRole("button", { name: "切换 GEO 操作" }));
    fireEvent.click(
      screen.getByRole("button", { name: "失败 · 发布阶段失败的全链路操作" }),
    );
    expect(
      await screen.findByText("发布阶段失败的全链路操作"),
    ).toBeInTheDocument();
    // 出错阶段行以状态点+文字表达；失败明细不在此展开（细节在聊天进度卡）。
    expect(phaseRow("发布")).toHaveTextContent("失败");
    expect(screen.queryByText("渠道上传失败")).not.toBeInTheDocument();
  });

  it("follows the focused operation when switching, including its current phase", async () => {
    mocks.load.mockResolvedValue([
      operation(),
      operation({
        id: "operation-monitor",
        goal: "监测已发布内容",
        steps: [
          step({
            id: "collect-monitoring-evidence",
            capability: "monitoring",
            status: "running",
          }),
        ],
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    await screen.findByRole("region", { name: "当前 GEO 操作" });
    expect(phaseRow("内容生产")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "切换 GEO 操作" }));
    fireEvent.click(
      screen.getByRole("button", { name: "进行中 · 监测已发布内容" }),
    );
    expect(await screen.findByText("监测已发布内容")).toBeInTheDocument();
    // 「目前所在阶段」跟随聚焦操作切换到监测阶段。
    expect(phaseRow("监测")).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "监测结果卡片" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "GEO 仪表盘卡片" }),
    ).toBeInTheDocument();
    // 内容阶段无步骤，收起为单行并标「已跳过」。
    const contentRow = phaseRow("内容生产");
    expect(contentRow).toHaveAttribute("aria-expanded", "false");
    expect(contentRow).toHaveTextContent("已跳过");
  });

  it("focuses the exact operation and expands the deep-linked artifact phase from a notification locator", async () => {
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
    // 深链落点：发布阶段展开并渲染精确产物。
    expect(phaseRow("发布")).toHaveAttribute("aria-expanded", "true");
    expect(mocks.publishProps).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "execution-exact",
      }),
    );
    expect(
      await screen.findByRole("region", { name: "发布确认卡片" }),
    ).toBeInTheDocument();
    expect(mocks.articleProps).not.toHaveBeenCalled();
  });

  // 深链聚焦 pin 每个 nonce 只消费一次：用户手动切换操作后，
  // 轮询刷新不得把聚焦抢回深链操作。
  it("keeps a manual operation switch after the deep-link focus pin is consumed", async () => {
    const target = operation({
      id: "operation-target",
      goal: "精确发布目标",
      steps: [step({ capability: "content-production", status: "running" })],
    });
    const other = operation({
      id: "operation-other",
      goal: "监测另一个操作",
      steps: [
        step({
          id: "collect-monitoring-evidence",
          capability: "monitoring",
          status: "running",
        }),
      ],
    });
    mocks.load.mockResolvedValue([target, other]);
    const view = render(
      <XiaojingGeoOperationPanel
        workspace={workspace}
        navigationTarget={{
          workspaceId: workspace.id,
          sessionId: "session-17",
          operationId: target.id,
          card: "geo-operation",
          artifact: { kind: "operation", id: target.id },
          nonce: 1,
        }}
      />,
    );

    expect(await screen.findByText("精确发布目标")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "切换 GEO 操作" }));
    fireEvent.click(
      screen.getByRole("button", { name: "进行中 · 监测另一个操作" }),
    );
    expect(await screen.findByText("监测另一个操作")).toBeInTheDocument();

    // 触发一次轮询刷新（同列表返回），聚焦必须保持在手动选择上。先冲刷
    // passive effects，确保 visibilitychange 监听器已挂载再派发事件。
    await act(async () => {});
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    expect(screen.getByText("监测另一个操作")).toBeInTheDocument();
    expect(screen.queryByText("精确发布目标")).not.toBeInTheDocument();
    view.unmount();
  });

  it("renders products strictly by phase membership for a direct article intent", async () => {
    mocks.load.mockResolvedValue([operation()]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByRole("region", { name: "当前 GEO 操作" });
    expect(phaseRow("内容生产")).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("region", { name: "文章审核卡片" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "问题池卡片" }),
    ).not.toBeInTheDocument();
    // 直接意图未覆盖的阶段仍渲染为收起单行，标「已跳过」。
    for (const title of PHASE_ROWS.filter((name) => name !== "内容生产")) {
      const row = phaseRow(title);
      expect(row).toHaveAttribute("aria-expanded", "false");
      expect(row).toHaveTextContent("已跳过");
    }
  });

  // 票 28：过程块只剩聊天进度卡一个现场——工作台骨架不再重复
  // 阶段总览 grid、执行步骤列表、checkpoint、pending/error 与原始产物引用明细。
  it("keeps process detail blocks out of the workbench skeleton", async () => {
    mocks.load.mockResolvedValue([
      operation({
        kind: "full-optimization",
        goal: "带恢复检查点的全链路操作",
        status: "recovering",
        steps: fullOptimizationSteps({
          id: "plan-topics",
          status: "running",
        }),
        checkpoint: {
          activeStepId: "plan-topics",
          completedStepIds: ["confirm-knowledge"],
          completedUnitRefs: [],
          safeToResume: true,
          savedAt: "2026-08-15T00:02:00Z",
        },
        pendingConfirmation: {
          kind: "topic-plan",
          authority: "brand-workspace",
          title: "确认内容计划",
          summary: "只有已批准的主题计划项会进入文章生成。",
        },
        artifactRefs: [
          { kind: "question-pool", id: "pool-long-reference-17", revision: 3 },
        ],
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByRole("region", { name: "当前 GEO 操作" });
    for (const region of [
      "GEO 阶段总览",
      "当前操作步骤",
      "恢复检查点",
      "待确认事项",
      "操作产物",
    ]) {
      expect(
        screen.queryByRole("region", { name: region }),
      ).not.toBeInTheDocument();
    }
    expect(
      screen.queryByText("pool-long-reference-17"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/最小执行步骤/)).not.toBeInTheDocument();
    // 六个阶段行仍在，恢复态以状态徽标表达。
    expect(screen.getByText("恢复中")).toBeInTheDocument();
    for (const title of PHASE_ROWS) {
      expect(phaseRow(title)).toBeInTheDocument();
    }
  });

  // 票 27：材料导入的发起动作收敛到聊天输入区与会话附件路线，
  // 工作台（含材料/知识步骤）不得再挂任何材料导入面板。
  it("renders no material import surface for the material and knowledge steps", async () => {
    mocks.load.mockResolvedValue([
      operation({
        goal: "收集品牌材料",
        steps: [
          step({
            id: "collect-materials",
            title: "收集品牌材料",
            capability: "brand-material-import",
            status: "awaiting-confirmation",
          }),
        ],
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByRole("region", { name: "当前 GEO 操作" });
    expect(phaseRow("品牌知识")).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("region", { name: "品牌材料" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "品牌材料导入" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("选择文件")).not.toBeInTheDocument();
  });

  // 票 25：过程控制与排队/恢复横幅只有聊天进度卡一个入口，
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
  });

  it("defers the next-round knowledge branch to the chat", async () => {
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
    // 下一轮知识分支改由聊天内 Agent 提问并记录；工作台不再提供平行按钮。
    expect(screen.getByText(/请回到聊天作答/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "沿用当前知识" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "待确认事项" }),
    ).not.toBeInTheDocument();
  });

  it("renders the confirmed brand knowledge inside the knowledge phase body", async () => {
    mocks.load.mockResolvedValue([
      operation({
        goal: "收集品牌材料",
        steps: [
          step({
            id: "collect-materials",
            title: "收集品牌材料",
            capability: "brand-material-import",
            status: "awaiting-confirmation",
          }),
        ],
      }),
    ]);
    render(<XiaojingGeoOperationPanel workspace={workspace} />);

    await screen.findByRole("region", { name: "当前 GEO 操作" });
    // 品牌知识数据直接落在骨架「品牌知识」阶段展开体里（不再于切换器
    // 与骨架之间挂独立面板），并拿到刷新信号。
    const body = screen.getByRole("region", { name: "品牌知识产物" });
    const knowledgeCard = screen.getByRole("region", { name: "品牌知识卡片" });
    expect(body).toContainElement(knowledgeCard);
    expect(mocks.knowledgeProps).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "brand-17", refreshKey: 3 }),
    );
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

    render(<XiaojingGeoOperationPanel workspace={workspace} />);
    expect(await screen.findByText("恢复中")).toBeInTheDocument();
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
    // 冲刷 passive effects：visibilitychange 监听器挂载完成后事件才可靠派发。
    await act(async () => {});
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(mocks.load).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("恢复中")).toBeInTheDocument();
    expect(mocks.load).toHaveBeenCalledTimes(2);
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
    // 空态引导去聊天发起操作。
    const empty = await screen.findByRole("region", { name: "GEO 操作空状态" });
    expect(empty).toHaveTextContent(/在聊天中/);

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
