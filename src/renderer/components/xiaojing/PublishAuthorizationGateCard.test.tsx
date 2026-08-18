import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PublishExecutionProjection,
  PublishItemProjection,
} from "../../../shared/geo/publishScheduler";
import PublishAuthorizationGateCard from "./PublishAuthorizationGateCard";

const mocks = vi.hoisted(() => ({
  sessionId: "session-42",
  confirm: vi.fn(),
  start: vi.fn(),
  latest: vi.fn(),
  byId: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: vi.fn() }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/api/publishSchedulerClient", () => ({
  confirmPublishExecution: mocks.confirm,
  startPublishExecution: mocks.start,
  loadLatestPublishExecution: mocks.latest,
  loadPublishExecution: mocks.byId,
}));

const item: PublishItemProjection = {
  id: "item-1",
  revision: 1,
  sequence: 1,
  article: {
    articleId: "article-1",
    approvedRevision: 3,
    approvedBodySha256: "abc",
    title: "成都汽车音响改装怎么选",
    bodyBytes: 2048,
    bodySummary: "批准稿摘要。",
  },
  channel: {
    resourceId: 8,
    kind: "media",
    name: "汽车产业观察",
    estimatedPriceCny: 142,
    publishedRate: 0,
  },
  scheduledAt: "2026-08-20T02:00:00Z",
  status: "pending",
  idempotencyKey: "idem-1",
  externalRequestSn: "sn-1",
  payloadHash: "hash-1",
  objectKey: "ops/exec-1/article-1.html",
  objectUrl: null,
  externalOrderId: null,
  externalContentId: null,
  attempts: 0,
  uploadAttempts: 0,
  nextAttemptAt: null,
  startedAt: null,
  finishedAt: null,
  requestSummary: {
    articleId: "article-1",
    approvedRevision: 3,
    approvedBodySha256: "abc",
    resourceId: 8,
    scheduledAt: "2026-08-20T02:00:00Z",
    plannedObjectUrl: "https://oss.example/ops/exec-1/article-1.html",
    estimatedPriceCny: 142,
  },
  failureCode: null,
  failureReason: null,
};

function execution(
  overrides: Partial<PublishExecutionProjection> = {},
): PublishExecutionProjection {
  return {
    id: "exec-1",
    operationId: "operation-1",
    workspaceId: "brand-1",
    createdBySessionId: mocks.sessionId,
    distributionPlanId: "plan-1",
    distributionPlanRevision: 3,
    policyVersion: "js-ai-dev-deterministic-publish-v1",
    revision: 1,
    status: "awaiting-confirmation",
    budgetCny: 1000,
    estimatedSpendCny: 142,
    publishStartAt: "2026-08-20T02:00:00Z",
    irreversibleImpact: "将付费并向外部渠道发布，不可撤销。",
    confirmationDigest: "digest-1",
    providerSnapshot: {
      objectStorage: {
        provider: "aliyun-oss",
        endpointFamily: "oss-v1-put",
        configured: true,
        configurationFingerprint: "fp-oss",
      },
      distribution: {
        provider: "超级媒介",
        endpointFamily: "chaojimeijie-order-api",
        configured: true,
        configurationFingerprint: "fp-dist",
      },
    },
    items: [item],
    confirmedAt: null,
    executionStartedAt: null,
    finishedAt: null,
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
    ...overrides,
  };
}

function renderCard(current: PublishExecutionProjection) {
  return render(
    <PublishAuthorizationGateCard
      data={{ kind: "publish-execution", execution: current }}
    />,
  );
}

describe("PublishAuthorizationGateCard", () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.start.mockReset();
    mocks.byId.mockReset();
    // 待决期轮询拉不到新投影，卡片保持本地状态。
    mocks.latest.mockReset().mockResolvedValue(null);
  });

  it("carries the server-bumped revision from confirm into start", async () => {
    mocks.confirm.mockResolvedValue(
      execution({
        status: "confirmed",
        revision: 2,
        confirmedAt: "2026-08-18T15:41:59.719Z",
      }),
    );
    mocks.start.mockResolvedValue(
      execution({
        status: "scheduled",
        revision: 3,
        confirmedAt: "2026-08-18T15:41:59.719Z",
      }),
    );
    renderCard(execution());
    const card = screen.getByRole("region", { name: "付费发布授权" });

    fireEvent.click(
      within(card).getByLabelText("确认最终文章渠道预算排期和不可逆影响"),
    );
    fireEvent.click(
      within(card).getByRole("button", { name: "独立确认发布执行" }),
    );

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith(
        { workspaceId: "brand-1", sessionId: "session-42" },
        {
          executionId: "exec-1",
          expectedRevision: 1,
          confirmationDigest: "digest-1",
        },
      ),
    );
    await waitFor(() =>
      within(card).findByRole("button", { name: "开始确定性发布" }),
    );

    // 回归：confirm 在服务端把 revision 递增到 2；开始发布必须带新
    // revision 提交，否则被 CAS 判为 publish_execution_revision_conflict。
    fireEvent.click(
      within(card).getByRole("button", { name: "开始确定性发布" }),
    );
    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        { workspaceId: "brand-1", sessionId: "session-42" },
        { executionId: "exec-1", expectedRevision: 2 },
      ),
    );
    // 启动后卡片进入「发布状态」视图，逐条目展示两段徽章。
    const statusBlock = await within(card).findByText("发布状态");
    expect(statusBlock).toBeInTheDocument();
    expect(within(card).getByText("已排期，等待调度")).toBeInTheDocument();
    expect(within(card).getByText("OSS 未上传")).toBeInTheDocument();
    expect(within(card).getByText("订单未提交")).toBeInTheDocument();
  });

  it("shows per-item OSS and chaojimeijie stage badges with manual refresh", async () => {
    mocks.byId.mockResolvedValue(
      execution({
        status: "running",
        revision: 4,
        items: [
          {
            ...item,
            status: "submitted",
            objectUrl: "https://oss.example/ops/exec-1/article-1.html",
            externalOrderId: "SN-20260820-001",
          },
        ],
      }),
    );
    renderCard(
      execution({
        status: "running",
        revision: 3,
      }),
    );
    const card = screen.getByRole("region", { name: "付费发布授权" });

    expect(within(card).getByText("OSS 未上传")).toBeInTheDocument();
    expect(within(card).getByText("订单未提交")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "刷新发布状态" }));
    await waitFor(() =>
      expect(mocks.byId).toHaveBeenCalledWith(
        expect.anything(),
        { workspaceId: "brand-1", sessionId: "session-42" },
        "exec-1",
      ),
    );
    expect(await within(card).findByText("OSS 已上传")).toBeInTheDocument();
    expect(await within(card).findByText("订单已提交")).toBeInTheDocument();
    expect(
      within(card).getByText("超级媒介订单：SN-20260820-001"),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole("link", {
        name: "https://oss.example/ops/exec-1/article-1.html",
      }),
    ).toBeInTheDocument();
  });

  it("summarizes succeeded executions with submitted order details", () => {
    renderCard(
      execution({
        status: "succeeded",
        revision: 9,
        items: [
          {
            ...item,
            status: "submitted",
            objectUrl: "https://oss.example/ops/exec-1/article-1.html",
            externalOrderId: "SN-20260820-002",
          },
        ],
      }),
    );
    const card = screen.getByRole("region", { name: "付费发布授权" });
    expect(
      within(card).getByText(/1 个发布项均已由超级媒介受理/),
    ).toBeInTheDocument();
    expect(within(card).getByText("订单已提交")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "刷新发布状态" })).not.toBeInTheDocument();
  });

  it("keeps the irreversible confirm checkbox required before confirming", () => {
    renderCard(execution());
    const card = screen.getByRole("region", { name: "付费发布授权" });

    const button = within(card).getByRole("button", {
      name: "独立确认发布执行",
    });
    expect(button).toBeDisabled();
    fireEvent.click(
      within(card).getByLabelText("确认最终文章渠道预算排期和不可逆影响"),
    );
    expect(
      within(card).getByRole("button", { name: "独立确认发布执行" }),
    ).toBeEnabled();
  });
});
