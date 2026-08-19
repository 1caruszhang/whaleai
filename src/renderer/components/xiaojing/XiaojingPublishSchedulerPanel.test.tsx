import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishExecutionProjection } from "../../../shared/geo/publishScheduler";
import XiaojingPublishSchedulerPanel from "./XiaojingPublishSchedulerPanel";

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  latest: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({ sessionId: "session-13" }),
}));

vi.mock("@/api/publishSchedulerClient", () => ({
  loadLatestPublishExecution: mocks.latest,
  loadPublishExecution: mocks.get,
}));

function execution(
  overrides: Partial<PublishExecutionProjection> = {},
): PublishExecutionProjection {
  return {
    id: "execution-13",
    operationId: "operation-13",
    workspaceId: "brand-13",
    createdBySessionId: "session-other",
    distributionPlanId: "plan-12",
    distributionPlanRevision: 5,
    policyVersion: "js-ai-dev-deterministic-publish-v1",
    revision: 1,
    status: "awaiting-confirmation",
    budgetCny: 500,
    estimatedSpendCny: 88,
    totalPricePoints: 1408,
    publishStartAt: "2026-08-20T02:00:00Z",
    irreversibleImpact: "上传批准正文并可能创建付费订单，渠道受理后不可由本应用撤销。",
    confirmationDigest: "digest-exact",
    providerSnapshot: {
      objectStorage: {
        provider: "aliyun-oss",
        endpointFamily: "oss-v1-put",
        configured: true,
        configurationFingerprint: "oss-fingerprint",
      },
      distribution: {
        provider: "超级媒介",
        endpointFamily: "chaojimeijie-order-api",
        configured: true,
        configurationFingerprint: "distribution-fingerprint",
      },
    },
    items: [
      {
        id: "item-13",
        revision: 1,
        sequence: 1,
        article: {
          articleId: "article-11",
          approvedRevision: 3,
          approvedBodySha256: "a".repeat(64),
          title: "新能源车主如何选择汽车音响",
          bodyBytes: 2048,
          bodySummary: "这是经过事实、一致性和广告法双质量门审核的最终批准正文摘要。",
        },
        channel: {
          resourceId: 8,
          kind: "media",
          name: "汽车产业观察",
          estimatedPriceCny: 88,
          publishedRate: 92,
          pricePoints: 1408,
        },
        scheduledAt: "2026-08-20T02:00:00Z",
        status: "pending",
        idempotencyKey: "article-article-11-channel-8-v3",
        externalRequestSn: "publish-item-1234567890abcdef12345678",
        payloadHash: "b".repeat(64),
        objectKey: "articles/brand-13/article-11/approved.html",
        objectUrl: null,
        externalOrderId: null,
        externalContentId: null,
        attempts: 0,
        uploadAttempts: 0,
        nextAttemptAt: null,
        startedAt: null,
        finishedAt: null,
        requestSummary: {
          articleId: "article-11",
          approvedRevision: 3,
          approvedBodySha256: "a".repeat(64),
          resourceId: 8,
          scheduledAt: "2026-08-20T02:00:00Z",
          plannedObjectUrl:
            "https://cdn.example.test/articles/brand-13/article-11/approved.html",
          estimatedPriceCny: 88,
        },
        failureCode: null,
        failureReason: null,
      },
    ],
    confirmedAt: null,
    executionStartedAt: null,
    finishedAt: null,
    createdAt: "2026-08-15T00:00:00Z",
    updatedAt: "2026-08-15T00:00:00Z",
    ...overrides,
  };
}

// 票 29：面板退化为纯只读投影——预览/不可逆授权/启动/失败项重试只有
// 聊天卡片一套实现（授权走 Rust UI 命令），组件测试只断言只读渲染。
describe("XiaojingPublishSchedulerPanel read-only projection", () => {
  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.latest.mockReset().mockResolvedValue(execution());
    mocks.get.mockReset().mockResolvedValue(execution({ id: "execution-exact" }));
  });

  it("loads a notification-targeted execution by exact id instead of latest", async () => {
    render(<XiaojingPublishSchedulerPanel workspaceId="brand-13" executionId="execution-exact" />);
    await screen.findByRole("region", { name: "确定性发布计划" });
    expect(mocks.get).toHaveBeenCalledWith(
      mocks.apiPost,
      { workspaceId: "brand-13", sessionId: "session-13" },
      "execution-exact",
    );
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("shows exact approved body summary, channel, price, budget and schedule", async () => {
    render(<XiaojingPublishSchedulerPanel workspaceId="brand-13" />);
    const panel = await screen.findByRole("region", { name: "确定性发布计划" });
    expect(within(panel).getByText("新能源车主如何选择汽车音响")).toBeInTheDocument();
    expect(within(panel).getByText(/批准 revision 3/)).toBeInTheDocument();
    expect(within(panel).getByText(/最终批准正文摘要/)).toBeInTheDocument();
    expect(within(panel).getByText(/汽车产业观察/)).toBeInTheDocument();
    expect(within(panel).getByText(/预计 ¥88.00 \/ 预算 ¥500.00/)).toBeInTheDocument();
  });

  // 参照 js_ai 的发布状态设计：每个发布项展示 OSS 上传与超级媒介订单
  // 两段徽章，随调度器推进刷新。
  it("renders per-item OSS and order stage badges", async () => {
    const base = execution();
    mocks.latest.mockResolvedValue(
      execution({
        status: "running",
        items: [
          base.items[0]!,
          {
            ...base.items[0]!,
            id: "item-submitted",
            status: "submitted" as const,
            objectUrl: "https://oss.example/ops/article-1.html",
            externalOrderId: "SN-20260820-003",
          },
        ],
      }),
    );
    render(<XiaojingPublishSchedulerPanel workspaceId="brand-13" />);
    const panel = await screen.findByRole("region", { name: "确定性发布计划" });
    expect(within(panel).getAllByText("OSS 未上传")).toHaveLength(1);
    expect(within(panel).getAllByText("订单未提交")).toHaveLength(1);
    expect(within(panel).getAllByText("OSS 已上传")).toHaveLength(1);
    expect(within(panel).getAllByText("订单已提交")).toHaveLength(1);
    expect(
      within(panel).getByText(/外部订单：SN-20260820-003/),
    ).toBeInTheDocument();
  });

  // GD-13 回归：付费发布授权是不可逆操作，面板只展示不可逆影响说明，
  // 授权交互只出现在聊天卡片。
  it("surfaces the irreversible impact without authorization controls", async () => {
    render(<XiaojingPublishSchedulerPanel workspaceId="brand-13" />);
    const panel = await screen.findByRole("region", {
      name: "确定性发布计划",
    });
    expect(
      await within(panel).findByText(/渠道受理后不可由本应用撤销/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText(/请回到聊天中的确认卡片核对并完成授权/),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      within(panel).queryByLabelText(
        "确认最终文章渠道预算排期和不可逆影响",
      ),
    ).not.toBeInTheDocument();
  });

  it("directs confirmed executions to the chat card instead of a start button", async () => {
    mocks.latest.mockResolvedValue(execution({ status: "confirmed" }));
    render(<XiaojingPublishSchedulerPanel workspaceId="brand-13" />);
    const panel = await screen.findByRole("region", {
      name: "确定性发布计划",
    });
    expect(
      await within(panel).findByText(/请在聊天中的确认卡片启动发布/),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
  });

  it("reports executions without retry affordances for failed items", async () => {
    mocks.latest.mockResolvedValue(
      execution({
        status: "partially-succeeded",
        items: execution().items.map((item) => ({
          ...item,
          status: "failed-retryable" as const,
          failureReason: "渠道受理超时",
        })),
      }),
    );
    render(<XiaojingPublishSchedulerPanel workspaceId="brand-13" />);
    const panel = await screen.findByRole("region", {
      name: "确定性发布计划",
    });
    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
  });

  it("reloads the projection when the session tool signal advances", async () => {
    const { rerender } = render(
      <XiaojingPublishSchedulerPanel workspaceId="brand-13" refreshKey={0} />,
    );
    await screen.findByRole("region", { name: "确定性发布计划" });
    expect(mocks.latest).toHaveBeenCalledTimes(1);

    rerender(
      <XiaojingPublishSchedulerPanel workspaceId="brand-13" refreshKey={1} />,
    );
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledTimes(2));
  });
});
