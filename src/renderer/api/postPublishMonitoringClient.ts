import { invoke } from "@tauri-apps/api/core";

import type {
  PostPublishMonitorActivateInput,
  PostPublishMonitorPlanProjection,
  PostPublishMonitorPrepareInput,
  PostPublishMonitorRetryInput,
} from "../../shared/geo/postPublishMonitoring";

export function loadLatestPostPublishMonitor(
  identity: { workspaceId: string; sessionId: string },
): Promise<PostPublishMonitorPlanProjection | null> {
  return invoke("cmd_post_publish_monitor_latest_ui", identity);
}

export function loadPostPublishMonitor(
  identity: { workspaceId: string; sessionId: string },
  planId: string,
): Promise<PostPublishMonitorPlanProjection> {
  return invoke("cmd_post_publish_monitor_get_ui", {
    ...identity,
    input: { planId },
  });
}

export function preparePostPublishMonitor(
  identity: { workspaceId: string; sessionId: string },
  input: PostPublishMonitorPrepareInput,
): Promise<PostPublishMonitorPlanProjection> {
  return invoke("cmd_post_publish_monitor_prepare_ui", { ...identity, input });
}

export function activatePostPublishMonitor(
  identity: { workspaceId: string; sessionId: string },
  input: PostPublishMonitorActivateInput,
): Promise<PostPublishMonitorPlanProjection> {
  return invoke("cmd_post_publish_monitor_activate_ui", { ...identity, input });
}

export function retryPostPublishMonitorUnit(
  identity: { workspaceId: string; sessionId: string },
  input: PostPublishMonitorRetryInput,
): Promise<PostPublishMonitorPlanProjection> {
  return invoke("cmd_post_publish_monitor_retry_ui", { ...identity, input });
}
