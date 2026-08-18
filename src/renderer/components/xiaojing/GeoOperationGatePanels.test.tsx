import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithTheme as render } from "@/test/renderWithTheme";
import type { GeoOperationProjection } from "../../../shared/geo/operation";
import GeoOperationGatePanels from "./GeoOperationGatePanels";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  confirmGeoOperationStep: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-17", isLoading: false }),
}));

vi.mock("@/api/geoOperationClient", () => ({
  confirmGeoOperationStep: mocks.confirmGeoOperationStep,
}));

function operationWithStep(
  step: {
    id: string;
    capability: string;
    status?: string;
    confirmation?: Record<string, unknown>;
  },
  overrides: Partial<GeoOperationProjection> = {},
): GeoOperationProjection {
  return {
    id: "operation-17",
    workspaceId: "brand-17",
    sessionId: "session-17",
    goal: "完整 GEO 优化",
    status: "awaiting-confirmation",
    revision: 4,
    steps: [
      {
        id: step.id,
        title: "当前步骤",
        capability: step.capability,
        status: (step.status ?? "awaiting-confirmation") as never,
        ...(step.confirmation ? { confirmation: step.confirmation } : {}),
      },
    ],
    ...overrides,
  } as unknown as GeoOperationProjection;
}

beforeEach(() => {
  mocks.apiPost.mockReset();
  mocks.confirmGeoOperationStep.mockReset();
});

describe("GeoOperationGatePanels", () => {
  // 「下一轮是否更新知识」是 Agent 在聊天里提问的决策
  // （choose_next_round_knowledge），不是面板闸门。
  it("renders no panel for the next-round knowledge decision step", () => {
    const { container } = render(
      <GeoOperationGatePanels
        operation={operationWithStep({
          id: "decide-knowledge-refresh",
          capability: "brand-knowledge",
        })}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  // 票 27：粘贴/URL/文件导入的发起动作收敛到聊天输入区的材料导入入口，
  // 会话附件路线保持；材料/知识步骤不再在闸门卡下挂导入面板。
  it("renders no import panel for the material and knowledge steps", () => {
    for (const capability of ["brand-material-import", "brand-knowledge"]) {
      const { container } = render(
        <GeoOperationGatePanels
          operation={operationWithStep({
            id: "collect-materials",
            capability,
          })}
        />,
      );
      expect(container.innerHTML).toBe("");
    }
  });

  it("renders no panel for unknown capabilities", () => {
    const { container } = render(
      <GeoOperationGatePanels
        operation={operationWithStep({
          id: "mystery",
          capability: "not-a-capability",
        })}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  // 计划放行门是唯一挂在进度卡本体的确认面板：一次点击放行整份计划，
  // 提交沿用既有 confirm-step 端点与 revision CAS。
  it("renders the plan acknowledgement panel and submits via confirm-step", async () => {
    mocks.confirmGeoOperationStep.mockResolvedValue(
      operationWithStep({ id: "gone", capability: "brand-knowledge" }),
    );
    const onGateConfirmed = vi.fn();
    render(
      <GeoOperationGatePanels
        operation={operationWithStep({
          id: "acknowledge-plan",
          capability: "brand-material-import",
          confirmation: {
            kind: "plan-ack",
            authority: "geo-operation",
            title: "认可本轮计划",
            summary: "查看上方阶段与步骤计划后放行；各阶段的产物仍会停在各自的确认门。",
          },
        })}
        onGateConfirmed={onGateConfirmed}
      />,
    );

    expect(screen.getByText("认可本轮计划")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "认可计划并开始" }));

    await waitFor(() =>
      expect(mocks.confirmGeoOperationStep).toHaveBeenCalledWith(
        mocks.apiPost,
        { workspaceId: "brand-17", sessionId: "session-17" },
        {
          operationId: "operation-17",
          expectedRevision: 4,
          stepId: "acknowledge-plan",
        },
      ),
    );
    await waitFor(() => expect(onGateConfirmed).toHaveBeenCalledOnce());
  });

  it("surfaces confirm failures without refreshing the host card", async () => {
    mocks.confirmGeoOperationStep.mockRejectedValue(
      new Error("revision_conflict"),
    );
    const onGateConfirmed = vi.fn();
    render(
      <GeoOperationGatePanels
        operation={operationWithStep({
          id: "acknowledge-plan",
          capability: "monitoring",
          confirmation: {
            kind: "plan-ack",
            authority: "geo-operation",
            title: "认可本轮计划",
            summary: "查看上方阶段与步骤计划后放行。",
          },
        })}
        onGateConfirmed={onGateConfirmed}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "认可计划并开始" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("revision_conflict"),
    );
    expect(onGateConfirmed).not.toHaveBeenCalled();
  });
});
