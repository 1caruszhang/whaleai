import type {
  PublishExecutionConfirmInput,
  PublishExecutionProjection,
  PublishExecutionStartInput,
  PublishOrderStatusEntry,
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

interface PublishOrderStatusResponse {
  success: boolean;
  orders?: PublishOrderStatusEntry[];
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

/**
 * 对账恢复通道（票 40）：reconciliation-required 且全部条目从未提交的
 * 执行，在登录态与渠道配置一致时可由用户安全交还给调度器。授权与重试
 * 一样只走 Rust UI 命令，Agent 无权跨越。
 */
export function resumeReconciledExecution(
  identity: { workspaceId: string; sessionId: string },
  input: PublishExecutionStartInput,
): Promise<PublishExecutionProjection> {
  return invoke<PublishExecutionProjection>("cmd_publish_execution_resume_ui", {
    ...identity,
    input,
  });
}

/**
 * 订单状态投影（票 09）：经 Session Sidecar 查询网关订单（查单即对账，
 * 计费权威在后端），renderer 只持展示投影。截图为渠道回传的用户来源
 * HTML，消费方必须走现有 sanitize 栈渲染。
 */
export function loadPublishOrderStatuses(
  apiPost: PublishSchedulerApiPost,
  identity: { workspaceId: string; sessionId: string },
  executionId: string,
): Promise<PublishOrderStatusEntry[]> {
  return apiPost<PublishOrderStatusResponse>(
    "/api/xiaojing/publish-scheduler/orders",
    { ...identity, executionId },
  ).then((response) => {
    if (!response.success || !response.orders) {
      throw new Error(response.error ?? "publish_orders_unavailable");
    }
    return response.orders;
  });
}
