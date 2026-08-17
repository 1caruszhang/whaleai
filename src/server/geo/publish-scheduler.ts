import type { PublishExecutionProjection } from "../../shared/geo/publishScheduler";
import { managementApi } from "../utils/management-api-client";

export interface PublishSchedulerPort {
  latest(): Promise<PublishExecutionProjection | null>;
  get(executionId: string): Promise<PublishExecutionProjection>;
  preview(planId?: string): Promise<PublishExecutionProjection>;
  /**
   * 聊天修订（ADR 0003，票 38）：仅作用于 awaiting-confirmation 的执行，
   * 只允许调整预算、发布开始时间与逐项排期；Rust 重算确认摘要并写审计。
   */
  revise(input: {
    executionId: string;
    expectedRevision: number;
    budgetCny?: number;
    publishStartAt?: string;
    itemUpdates?: Array<{ itemId: string; scheduledAt: string }>;
    actorId: "desktop-user";
    reason: string;
  }): Promise<PublishExecutionProjection>;
}

function persistenceError(result: Record<string, unknown>): Error {
  return new Error(
    typeof result.error === "string"
      ? result.error
      : "publish_scheduler_persistence_failed",
  );
}

export class RustPublishSchedulerPort implements PublishSchedulerPort {
  constructor(
    private readonly identity: {
      workspaceId: string;
      sessionId: string;
      sidecarId: string;
    },
  ) {}

  private async post(
    path: string,
    payload: object,
  ): Promise<PublishExecutionProjection | null> {
    const result = await managementApi(path, "POST", {
      ...this.identity,
      payload,
    });
    if (result.ok !== true) throw persistenceError(result);
    return (result.execution as PublishExecutionProjection | null) ?? null;
  }

  latest(): Promise<PublishExecutionProjection | null> {
    return this.post("/api/brand-publish-scheduler/latest", {});
  }

  async get(executionId: string): Promise<PublishExecutionProjection> {
    const execution = await this.post("/api/brand-publish-scheduler/get", {
      executionId,
    });
    if (!execution) throw new Error("publish_execution_not_found");
    return execution;
  }

  async preview(planId?: string): Promise<PublishExecutionProjection> {
    const execution = await this.post("/api/brand-publish-scheduler/preview", {
      planId,
    });
    if (!execution) throw new Error("publish_execution_not_found");
    return execution;
  }

  async revise(
    input: Parameters<PublishSchedulerPort["revise"]>[0],
  ): Promise<PublishExecutionProjection> {
    const execution = await this.post(
      "/api/brand-publish-scheduler/revise",
      input,
    );
    if (!execution) throw new Error("publish_execution_not_found");
    return execution;
  }
}

export function createPublishSchedulerPort(identity: {
  workspaceId: string;
  sessionId: string;
}): PublishSchedulerPort {
  const sidecarId = process.env.XIAOJING_SIDECAR_ID?.trim();
  if (!sidecarId) {
    throw new Error("PublishScheduler requires an authenticated Sidecar identity");
  }
  return new RustPublishSchedulerPort({ ...identity, sidecarId });
}
