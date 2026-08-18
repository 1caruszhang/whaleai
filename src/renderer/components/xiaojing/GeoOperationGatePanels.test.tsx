import { describe, expect, it } from "vitest";

import { renderWithTheme as render } from "@/test/renderWithTheme";
import type { GeoOperationProjection } from "../../../shared/geo/operation";
import GeoOperationGatePanels from "./GeoOperationGatePanels";

function operationWithStep(step: {
  id: string;
  capability: string;
  status?: string;
}): GeoOperationProjection {
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
      },
    ],
  } as unknown as GeoOperationProjection;
}

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
});
