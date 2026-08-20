import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PublishExecutionProjection,
  PublishItemProjection,
  PublishOrderStatusEntry,
} from "../../../shared/geo/publishScheduler";
import PublishAuthorizationGateCard from "./PublishAuthorizationGateCard";

const mocks = vi.hoisted(() => ({
  sessionId: "session-42",
  confirm: vi.fn(),
  start: vi.fn(),
  resume: vi.fn(),
  latest: vi.fn(),
  byId: vi.fn(),
  orders: vi.fn(),
  // 账号投影（票 06）：卡片只读余额与刷新动作；points 原地变更生效。
  refresh: vi.fn(),
  accountState: { points: 500 } as { points: number | null },
}));

vi.mock("@/context/TabContext", () => ({
  useTabApi: () => ({ apiPost: vi.fn() }),
  useTabState: () => ({ sessionId: mocks.sessionId }),
}));

vi.mock("@/context/AccountContext", async () => {
  const { createContext } = await import("react");
  return {
    AccountApiContext: createContext({ refresh: mocks.refresh }),
    AccountStateContext: createContext(mocks.accountState),
  };
});

vi.mock("@/api/publishSchedulerClient", () => ({
  confirmPublishExecution: mocks.confirm,
  startPublishExecution: mocks.start,
  resumeReconciledExecution: mocks.resume,
  loadLatestPublishExecution: mocks.latest,
  loadPublishExecution: mocks.byId,
  loadPublishOrderStatuses: mocks.orders,
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
    // ¥142.00 × 1.6 → 2272 点（ceil(14200×4/25)）。
    pricePoints: 2272,
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
    totalPricePoints: 2272,
    publishStartAt: "2026-08-20T02:00:00Z",
    irreversibleImpact: "将付费并向外部渠道发布，不可撤销。",
    confirmationDigest: "digest-1",
    providerSnapshot: {
      objectStorage: {
        provider: "aliyun-oss",
        endpointFamily: "gateway-oss-put",
        configured: true,
        configurationFingerprint: "fp-oss",
      },
      distribution: {
        provider: "超级媒介",
        endpointFamily: "gateway-order-api",
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

function orderEntry(
  overrides: Partial<PublishOrderStatusEntry> = {},
): PublishOrderStatusEntry {
  return {
    itemId: "item-1",
    sn: "xj-order-sn-1",
    kind: "media",
    status: 3,
    url: null,
    screenshot: null,
    publishedAt: null,
    ...overrides,
  };
}

const submittedItem: PublishItemProjection = {
  ...item,
  status: "submitted",
  objectUrl: "https://oss.example/ops/exec-1/article-1.html",
  externalOrderId: "SN-20260820-001",
};

describe("PublishAuthorizationGateCard", () => {
  beforeEach(() => {
    mocks.confirm.mockReset();
    mocks.start.mockReset();
    mocks.resume.mockReset();
    mocks.byId.mockReset();
    mocks.refresh.mockReset();
    mocks.accountState.points = 500;
    // 待决期轮询拉不到新投影，卡片保持本地状态；订单投影默认空列表。
    mocks.latest.mockReset().mockResolvedValue(null);
    mocks.orders.mockReset().mockResolvedValue([]);
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
        items: [submittedItem],
      }),
    );
    const card = screen.getByRole("region", { name: "付费发布授权" });
    expect(
      within(card).getByText(/1 个发布项均已由超级媒介受理/),
    ).toBeInTheDocument();
    expect(within(card).getByText("订单已提交")).toBeInTheDocument();
    // 票 09：执行终态后渠道状态仍会流转（退款/补发），保留手动刷新。
    expect(
      within(card).getByRole("button", { name: "刷新发布状态" }),
    ).toBeInTheDocument();
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

  // ── 票 09：点数定价展示 ─────────────────────────────────────────────
  it("shows per-channel point prices and the total without service-fee wording", () => {
    renderCard(execution());
    const card = screen.getByRole("region", { name: "付费发布授权" });

    // ¥142.00 × 1.6 → 2272 点（服务端算好投影，卡片只展示）。
    expect(within(card).getByText(/单价 2272 点/)).toBeInTheDocument();
    expect(within(card).getByText(/合计 2272 点/)).toBeInTheDocument();
    // 汇总行点数化：预计取 totalPricePoints；预算按公式换算
    // （¥1000 → 16000 点），不再出现 ¥ 金额。
    expect(
      within(card).getByText(/预计 2272 点 \/ 预算 16000 点/),
    ).toBeInTheDocument();
    expect(card.textContent ?? "").not.toContain("¥");
    // 界面不出现「服务费」字样（含 60% 服务费不单列）。
    expect(within(card).queryByText(/服务费/)).toBeNull();
    expect(card.textContent ?? "").not.toContain("服务费");
  });

  // ── 票 09：订单列表、状态流转与发布链接 ─────────────────────────────
  it("lists gateway order status with the publish link and follows transitions", async () => {
    mocks.orders.mockResolvedValue([
      orderEntry({ status: 3, url: "https://news.example/article-1" }),
    ]);
    renderCard(execution({ status: "running", revision: 4 }));
    const card = screen.getByRole("region", { name: "付费发布授权" });

    // 进入订单视图即拉一次首屏投影。
    expect(await within(card).findByText("发布中")).toBeInTheDocument();
    expect(
      within(card).getByRole("link", { name: "发布链接" }),
    ).toHaveAttribute("href", "https://news.example/article-1");

    // 手动刷新后渠道状态推进为已发布。
    mocks.orders.mockResolvedValue([
      orderEntry({
        status: 4,
        url: "https://news.example/article-1",
        publishedAt: "2026-08-21T08:30:00Z",
      }),
    ]);
    mocks.byId.mockResolvedValue(execution({ status: "running", revision: 5 }));
    fireEvent.click(within(card).getByRole("button", { name: "刷新发布状态" }));
    expect(await within(card).findByText("已发布")).toBeInTheDocument();
    expect(within(card).queryByText("发布中")).toBeNull();
    await waitFor(() =>
      expect(mocks.orders).toHaveBeenCalledWith(
        expect.anything(),
        { workspaceId: "brand-1", sessionId: "session-42" },
        "exec-1",
      ),
    );
  });

  // ── 票 09：渠道回传截图经 sanitize 栈渲染 ───────────────────────────
  it("renders the channel screenshot through the sanitize stack", async () => {
    mocks.orders.mockResolvedValue([
      orderEntry({
        status: 4,
        url: "https://news.example/article-1",
        screenshot:
          '<p>收录截图正文</p><script>alert("pwned")</script>' +
          '<img src="https://cdn.example/shot.png" onerror="alert(1)">',
      }),
    ]);
    renderCard(execution({ status: "succeeded", revision: 9, items: [submittedItem] }));
    const card = screen.getByRole("region", { name: "付费发布授权" });

    fireEvent.click(
      await within(card).findByRole("button", { name: "查看渠道回传截图" }),
    );
    const shot = await within(card).findByText("收录截图正文");
    expect(shot).toBeInTheDocument();
    // 恶意脚本与事件处理器被清洗（DOM 层面不存在）。
    expect(document.querySelector("script")).toBeNull();
    const image = document.querySelector(
      "[data-publish-order-screenshot] img",
    );
    expect(image?.getAttribute("src")).toBe("https://cdn.example/shot.png");
    expect(image?.getAttribute("onerror")).toBeNull();
  });

  // ── 票 09：拒稿/取消/退款 → 对应状态 + 点数退回的余额变化 ───────────
  it.each([
    { status: 2 as const, label: "已拒稿" },
    { status: 5 as const, label: "已取消" },
    { status: 7 as const, label: "已退款" },
  ])(
    "shows the $label order with refunded points and a refreshed balance ($status)",
    async ({ status, label }) => {
      mocks.orders.mockResolvedValue([orderEntry({ status })]);
      const { unmount } = renderCard(
        execution({ status: "running", revision: 4, items: [submittedItem] }),
      );
      const card = screen.getByRole("region", { name: "付费发布授权" });

      expect(await within(card).findByText(label)).toBeInTheDocument();
      expect(
        within(card).getByText(
          "该订单点数已按原路退回 2272 点，当前余额 500 点。",
        ),
      ).toBeInTheDocument();
      // 点数退回后联动刷新账号余额投影（票 06 权威在 Rust/网关）。
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
      unmount();
      cleanup();
    },
  );

  it("does not refresh the balance for non-refund order states", async () => {
    mocks.orders.mockResolvedValue([orderEntry({ status: 4 })]);
    renderCard(execution({ status: "running", revision: 4, items: [submittedItem] }));
    const card = screen.getByRole("region", { name: "付费发布授权" });

    expect(await within(card).findByText("已发布")).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(
      within(card).queryByText(/已按原路退回/),
    ).toBeNull();
  });

  // ── 票 40：reconciliation-required 的对账恢复通道 ────────────────────
  it("offers resume on reconciliation-required and applies the refreshed projection", async () => {
    mocks.resume.mockResolvedValue(
      execution({ status: "scheduled", revision: 6 }),
    );
    renderCard(
      execution({
        status: "reconciliation-required",
        revision: 5,
        items: [
          {
            ...item,
            status: "reconciliation-required",
            failureCode: "provider-configuration-changed",
            failureReason: "Provider 配置指纹已变化，禁止沿旧幂等键执行",
          },
        ],
      }),
    );
    const card = screen.getByRole("region", { name: "付费发布授权" });

    // 说明文案 + 恢复按钮只在需要人工核对时出现。
    expect(
      within(card).getByText(/登录态与渠道配置一致时，可安全恢复/),
    ).toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole("button", { name: "恢复执行" }),
    );

    await waitFor(() =>
      expect(mocks.resume).toHaveBeenCalledWith(
        { workspaceId: "brand-1", sessionId: "session-42" },
        { executionId: "exec-1", expectedRevision: 5 },
      ),
    );
    // 采信服务端权威投影：恢复后执行回到已排期，恢复入口消失，余额投影刷新。
    expect(await within(card).findByText("已排期，等待调度")).toBeInTheDocument();
    expect(
      within(card).queryByRole("button", { name: "恢复执行" }),
    ).toBeNull();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
  });

  it("surfaces resume rejection without leaving the reconciled state", async () => {
    mocks.resume.mockRejectedValue(new Error("publish_provider_unavailable"));
    renderCard(
      execution({ status: "reconciliation-required", revision: 5 }),
    );
    const card = screen.getByRole("region", { name: "付费发布授权" });

    fireEvent.click(
      within(card).getByRole("button", { name: "恢复执行" }),
    );
    expect(
      await within(card).findByText("publish_provider_unavailable"),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("需要人工核对"),
    ).toBeInTheDocument();
  });
});
