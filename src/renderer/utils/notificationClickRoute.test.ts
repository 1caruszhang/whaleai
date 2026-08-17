import { describe, expect, test } from "vitest";

import { resolveNotificationClickRoute } from "./notificationClickRoute";

describe("resolveNotificationClickRoute", () => {
  test("prioritizes a complete exact GEO locator over stale tab hints", () => {
    expect(resolveNotificationClickRoute({
      notificationId: "geo:publish-failed:19",
      tabId: "stale",
      geoLocator: {
        workspaceId: " brand-19 ",
        sessionId: "session-19",
        operationId: "operation-19",
        card: "publish-execution",
        artifact: { kind: "publish-execution", id: "execution-19" },
      },
    }, () => false)).toEqual({
      type: "open-geo",
      notificationId: "geo:publish-failed:19",
      landing: "chat-gate",
      locator: {
        workspaceId: "brand-19",
        sessionId: "session-19",
        operationId: "operation-19",
        card: "publish-execution",
        artifact: { kind: "publish-execution", id: "execution-19" },
      },
    });
  });

  // 票 32：监测告警深链的落点是「效果」整页的具体监测计划，
  // 不再进入聊天 Tab 的工作台监测卡。
  test("routes monitoring alerts to the effect-page monitor landing", () => {
    expect(resolveNotificationClickRoute({
      notificationId: "geo:monitoring-completed:brand-19:session-19:operation-19:plan-19",
      geoLocator: {
        workspaceId: "brand-19",
        sessionId: "session-19",
        operationId: "operation-19",
        card: "post-publish-monitoring",
        artifact: { kind: "monitor-plan", id: "plan-19" },
      },
    }, () => false)).toEqual({
      type: "open-geo",
      notificationId: "geo:monitoring-completed:brand-19:session-19:operation-19:plan-19",
      landing: "effect-monitor",
      locator: {
        workspaceId: "brand-19",
        sessionId: "session-19",
        operationId: "operation-19",
        card: "post-publish-monitoring",
        artifact: { kind: "monitor-plan", id: "plan-19" },
      },
    });
  });

  test("rejects empty or incomplete GEO locators instead of retaining a future target", () => {
    expect(resolveNotificationClickRoute({
      geoLocator: {
        workspaceId: "brand-19",
        sessionId: " ",
        operationId: "operation-19",
        card: "geo-operation",
        artifact: { kind: "operation", id: "operation-19" },
      },
    }, () => false)).toEqual({ type: "none" });
  });

  test("selects an existing tab when tabId is still live", () => {
    expect(
      resolveNotificationClickRoute(
        { tabId: "tab-a", sessionId: "session-a", workspacePath: "/workspace" },
        (tabId, sessionId) => tabId === "tab-a" && sessionId === "session-a",
      ),
    ).toEqual({ type: "select-tab", tabId: "tab-a", sessionId: "session-a" });
  });

  test("opens the session when a live tab no longer owns the notification session", () => {
    expect(
      resolveNotificationClickRoute(
        { tabId: "tab-a", sessionId: "session-a", workspacePath: "/workspace" },
        (tabId, sessionId) => tabId === "tab-a" && sessionId === "session-b",
      ),
    ).toEqual({
      type: "open-session",
      sessionId: "session-a",
      workspacePath: "/workspace",
    });
  });

  test("opens the session when the notification has no live tab target", () => {
    expect(
      resolveNotificationClickRoute(
        {
          tabId: "stale-tab",
          sessionId: "session-a",
          workspacePath: "/workspace",
        },
        () => false,
      ),
    ).toEqual({
      type: "open-session",
      sessionId: "session-a",
      workspacePath: "/workspace",
    });
  });

  test("returns none for notifications without a routable target", () => {
    expect(
      resolveNotificationClickRoute({ tabId: "missing-tab" }, () => false),
    ).toEqual({ type: "none" });
  });
});
