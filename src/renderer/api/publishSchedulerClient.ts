import type {
  PublishExecutionConfirmInput,
  PublishExecutionProjection,
  PublishExecutionStartInput,
} from "../../shared/geo/publishScheduler";
import { invoke } from "@tauri-apps/api/core";

export type PublishSchedulerApiPost = <T>(
  path: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
) => Promise<T>;

interface PublishSchedulerResponse {
  success: boolean;
  execution?: PublishExecutionProjection | null;
  error?: string;
}

function requireExecution(
  response: PublishSchedulerResponse,
): PublishExecutionProjection {
  if (!response.success || !response.execution) {
    throw new Error(response.error ?? "publish_execution_not_found");
  }
  return response.execution;
}

/** Latest-execution read stays on the Rust IPC data plane: the query is
 *  workspace-wide, so the brand-level 「效果」 page can show the monitoring
 *  freeze source before any chat session of the brand is open. */
export function loadLatestPublishExecution(
  workspaceId: string,
): Promise<PublishExecutionProjection | null> {
  return invoke("cmd_publish_execution_latest_ui", { workspaceId });
}

export function loadPublishExecution(
  apiPost: PublishSchedulerApiPost,
  identity: { workspaceId: string; sessionId: string },
  executionId: string,
): Promise<PublishExecutionProjection> {
  return apiPost<PublishSchedulerResponse>(
    "/api/xiaojing/publish-scheduler/get",
    { ...identity, executionId },
  ).then(requireExecution);
}

export function confirmPublishExecution(
  identity: { workspaceId: string; sessionId: string },
  input: PublishExecutionConfirmInput,
): Promise<PublishExecutionProjection> {
  return invoke<PublishExecutionProjection>("cmd_publish_execution_confirm_ui", {
    ...identity,
    input,
  });
}

export function startPublishExecution(
  identity: { workspaceId: string; sessionId: string },
  input: PublishExecutionStartInput,
): Promise<PublishExecutionProjection> {
  return invoke<PublishExecutionProjection>("cmd_publish_execution_start_ui", {
    ...identity,
    input,
  });
}
