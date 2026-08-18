import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  GeoOperationConfirmationKind,
  GeoOperationStep,
  GeoOperationStepStatus,
} from "../../../shared/geo/operation";
import GeoGateProgressStrip, {
  deriveGateSegments,
  findCurrentGate,
} from "./GeoGateProgressStrip";

function gateStep(
  id: string,
  status: GeoOperationStepStatus,
  kind: GeoOperationConfirmationKind,
): GeoOperationStep {
  return {
    id,
    title: `${id}步骤`,
    capability: "brand-knowledge",
    status,
    requiresConfirmation: true,
    irreversible: false,
    retryUnit: "article",
    condition: null,
    confirmation: {
      kind,
      authority: "brand-workspace",
      title: `${id}门全称`,
      summary: "闸门摘要",
    },
  };
}

function workStep(id: string): GeoOperationStep {
  return {
    id,
    title: `${id}工作步骤`,
    capability: "brand-knowledge",
    status: "pending",
    requiresConfirmation: false,
    irreversible: false,
    retryUnit: "article",
    condition: null,
    confirmation: null,
  };
}

describe("GeoGateProgressStrip", () => {
  it("derives one segment per confirmation gate in plan order", () => {
    const steps = [
      gateStep("acknowledge-plan", "succeeded", "plan-ack"),
      workStep("collect-materials"),
      gateStep("confirm-knowledge", "awaiting-confirmation", "knowledge-change"),
      workStep("generate-question-pool"),
      gateStep("confirm-question-selection", "pending", "question-selection"),
    ];

    const segments = deriveGateSegments(steps);
    expect(segments.map((segment) => segment.id)).toEqual([
      "acknowledge-plan",
      "confirm-knowledge",
      "confirm-question-selection",
    ]);
    expect(segments.map((segment) => segment.label)).toEqual([
      "计划",
      "知识",
      "选题",
    ]);
    expect(findCurrentGate(segments)?.id).toBe("confirm-knowledge");
  });

  it("maps confirmation kinds to the two-character short labels", () => {
    const kinds: Array<[GeoOperationConfirmationKind, string]> = [
      ["plan-ack", "计划"],
      ["knowledge-change", "知识"],
      ["next-round-knowledge", "下一轮"],
      ["question-selection", "选题"],
      ["baseline-probe", "基线"],
      ["topic-plan", "内容"],
      ["article-approval", "文章"],
      ["distribution-plan", "分发"],
      ["paid-publish", "发布"],
      ["external-publish", "发布"],
      ["monitoring-activation", "监测"],
    ];
    const steps = kinds.map(([kind], index) =>
      gateStep(`gate-${index}`, "pending", kind),
    );
    expect(deriveGateSegments(steps).map((segment) => segment.label)).toEqual(
      kinds.map(([, label]) => label),
    );
  });

  it("renders nothing for plans without confirmation gates", () => {
    const { container } = render(
      <GeoGateProgressStrip operationId="op-1" steps={[workStep("only")]} />,
    );
    expect(container.querySelector("[data-geo-gate-progress='op-1']")).toBeNull();
  });

  it("styles done, current, awaiting and future segments differently", () => {
    render(
      <GeoGateProgressStrip
        operationId="op-1"
        steps={[
          gateStep("acknowledge-plan", "succeeded", "plan-ack"),
          gateStep("confirm-knowledge", "running", "knowledge-change"),
          gateStep("confirm-question-selection", "pending", "question-selection"),
        ]}
      />,
    );

    const bars = Array.from(
      screen
        .getByText("计划")
        .closest("[data-geo-gate-progress='op-1']")
        ?.querySelectorAll(":scope > div > div:first-child") ?? [],
    );
    expect(bars).toHaveLength(3);
    expect(bars[0]?.className).toContain("bg-[var(--accent)]");
    expect(bars[0]?.className).not.toContain("animate-pulse");
    // 当前段（运行中）：accent + 脉冲。
    expect(bars[1]?.className).toContain("animate-pulse");
    expect(bars[1]?.className).toContain("bg-[var(--accent)]");
    // 未到段：中性线色。
    expect(bars[2]?.className).toContain("bg-[var(--line)]");
    expect(bars[2]?.className).not.toContain("animate-pulse");
  });

  it("marks the awaiting current gate in warning tone and exposes full titles via tooltip", () => {
    render(
      <GeoGateProgressStrip
        operationId="op-1"
        steps={[
          gateStep("acknowledge-plan", "succeeded", "plan-ack"),
          gateStep("confirm-knowledge", "awaiting-confirmation", "knowledge-change"),
        ]}
      />,
    );

    const awaitingBar = screen.getByText("知识").parentElement?.firstElementChild;
    expect(awaitingBar?.className).toContain("bg-[var(--warning)]");
    expect(awaitingBar?.className).toContain("animate-pulse");
    expect(screen.getByText("知识").className).toContain(
      "text-[var(--warning)]",
    );
    expect(screen.getByTitle("confirm-knowledge门全称 · 待确认")).toBeInTheDocument();
    expect(screen.getByTitle("acknowledge-plan门全称 · 已放行")).toBeInTheDocument();
  });

  it("renders a failed gate in error tone", () => {
    render(
      <GeoGateProgressStrip
        operationId="op-1"
        steps={[
          gateStep("acknowledge-plan", "succeeded", "plan-ack"),
          gateStep("confirm-knowledge", "failed", "knowledge-change"),
        ]}
      />,
    );

    const failedBar = screen.getByText("知识").parentElement?.firstElementChild;
    expect(failedBar?.className).toContain("bg-[var(--error)]");
    expect(failedBar?.className).not.toContain("animate-pulse");
    expect(screen.getByTitle("confirm-knowledge门全称 · 失败")).toBeInTheDocument();
  });

  it("renders all segments solid without pulse once every gate is released", () => {
    render(
      <GeoGateProgressStrip
        operationId="op-1"
        steps={[
          gateStep("acknowledge-plan", "succeeded", "plan-ack"),
          gateStep("confirm-knowledge", "skipped", "knowledge-change"),
        ]}
      />,
    );

    const bars = Array.from(
      document.querySelectorAll("[data-geo-gate-progress='op-1'] > div > div:first-child"),
    );
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.className).toContain("bg-[var(--accent)]");
      expect(bar.className).not.toContain("animate-pulse");
    }
    expect(findCurrentGate(deriveGateSegments([
      gateStep("acknowledge-plan", "succeeded", "plan-ack"),
      gateStep("confirm-knowledge", "skipped", "knowledge-change"),
    ]))).toBeNull();
  });
});
