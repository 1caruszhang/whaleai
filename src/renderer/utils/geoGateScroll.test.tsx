import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  findGeoOperationGateElement,
  scrollContainerToGeoOperationGate,
} from "./geoGateScroll";

function containerWithChildren(...children: HTMLElement[]) {
  const container = document.createElement("div");
  children.forEach((child) => container.appendChild(child));
  return container;
}

function gatePanelsHost(operationId: string) {
  const element = document.createElement("div");
  element.setAttribute("data-geo-gate-panels", operationId);
  return element;
}

function operationStepsList(operationId: string) {
  const element = document.createElement("ol");
  element.setAttribute("data-geo-operation-steps", operationId);
  return element;
}

describe("findGeoOperationGateElement", () => {
  test("prefers the interactive gate-panels host over the progress steps list", () => {
    const gate = gatePanelsHost("operation-19");
    const steps = operationStepsList("operation-19");
    const container = containerWithChildren(steps, gate);

    expect(findGeoOperationGateElement(container, "operation-19")).toBe(gate);
  });

  test("falls back to the progress steps list when no gate host is mounted", () => {
    const steps = operationStepsList("operation-19");
    const container = containerWithChildren(
      gatePanelsHost("operation-other"),
      steps,
    );

    expect(findGeoOperationGateElement(container, "operation-19")).toBe(steps);
  });

  test("matches only the exact operation id and ignores empty ids", () => {
    const container = containerWithChildren(
      gatePanelsHost("operation-19-prefix"),
      operationStepsList("operation-19-suffix"),
    );

    expect(findGeoOperationGateElement(container, "operation-19")).toBeNull();
    expect(findGeoOperationGateElement(container, "")).toBeNull();
  });
});

describe("scrollContainerToGeoOperationGate", () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("scrolls immediately when the gate card is already mounted", () => {
    const gate = gatePanelsHost("operation-19");
    const container = containerWithChildren(gate);
    const cancel = scrollContainerToGeoOperationGate(container, "operation-19");

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: "center" }),
    );
    cancel();
  });

  // 深链可能在会话恢复完成前到达：卡片出现后的一次重试必须命中并滚动。
  test("retries until the gate card appears, then stops", () => {
    const gate = gatePanelsHost("operation-19");
    const container = containerWithChildren();
    const cancel = scrollContainerToGeoOperationGate(container, "operation-19", {
      intervalMs: 100,
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    container.appendChild(gate);
    vi.advanceTimersByTime(100);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    cancel();
  });

  test("gives up after the bounded attempts and reports settle(false)", () => {
    const container = containerWithChildren();
    const onSettled = vi.fn();
    const cancel = scrollContainerToGeoOperationGate(container, "operation-19", {
      attempts: 3,
      intervalMs: 50,
      onSettled,
    });

    vi.advanceTimersByTime(10_000);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith(false);
    cancel();
  });

  test("cancel stops retries and never reports settle", () => {
    const container = containerWithChildren();
    const onSettled = vi.fn();
    const cancel = scrollContainerToGeoOperationGate(container, "operation-19", {
      attempts: 5,
      intervalMs: 50,
      onSettled,
    });

    vi.advanceTimersByTime(50);
    cancel();
    const gate = gatePanelsHost("operation-19");
    container.appendChild(gate);
    vi.advanceTimersByTime(10_000);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
