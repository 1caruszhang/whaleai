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

export async function loadLatestPublishExecution(
  apiPost: PublishSchedulerApiPost,
  identity: { workspaceId: string; sessionId: string },
): Promise<PublishExecutionProjection | null> {
  const response = await apiPost<PublishSchedulerResponse>(
    "/api/xiaojing/publish-scheduler/latest",
    identity,
  );
  if (!response.success) {
    throw new Error(response.error ?? "publish_execution_latest_failed");
  }
  return response.execution ?? null;
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
