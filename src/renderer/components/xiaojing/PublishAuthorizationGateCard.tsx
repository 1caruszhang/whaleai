import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  confirmPublishExecution,
  loadLatestPublishExecution,
  loadPublishExecution,
  loadPublishOrderStatuses,
  startPublishExecution,
} from "@/api/publishSchedulerClient";
import { AccountApiContext, AccountStateContext } from "@/context/AccountContext";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  PublishExecutionProjection,
  PublishItemProjection,
  PublishOrderStatusEntry,
} from "../../../shared/geo/publishScheduler";
import { cnyToPoints } from "../../../shared/geo/points";
import {
  publishOrderRefundsPoints,
  publishOrderStatusActive,
  publishOrderStatusLabel,
} from "../../../shared/geo/publishScheduler";
import { unwrapToolResultText } from "../../../shared/toolResult";
import {
  orderStage,
  orderStatusTone,
  ossStage,
  PUBLISH_STAGE_TONE_CLASS,
  type PublishStageBadge,
} from "./publishStageStatus";
import PublishOrderScreenshot from "./PublishOrderScreenshot";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 付费发布授权卡：内容由 prepare_publish 的工具结果携带。不可逆授权与
 * 启动发布只能由用户在本卡完成（走 Rust UI 命令，Agent 无权跨越）；
 * 与工作台面板共用同一授权端点。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订（预算/排期）重算确认
 * 摘要，卡片采信新摘要并重置不可逆确认勾选，用户必须重新核对后授权。
 * 启动后进入「发布状态」视图（参考 js_ai 的监控卡设计）：逐条目呈现
 * OSS 上传与超级媒介订单两段状态，非终态期间继续轮询并支持手动刷新。
 *
 * 票 09：待决区展示逐渠道点数单价与总价（服务端算好，倍率不进
 * renderer）；启动后的订单视图叠加渠道订单状态投影（查单即对账，计费
 * 权威在网关）：状态流转、发布链接、经 sanitize 栈渲染的渠道回传截图；
 * 拒稿/取消/退款时联动刷新账号余额投影，让点数退回可见。
 */
export interface PublishAuthorizationGateCardData {
  kind: "publish-execution";
  execution: PublishExecutionProjection;
}

function isExecution(value: unknown): value is PublishExecutionProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublishExecutionProjection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.status === "string" &&
    Array.isArray(candidate.items)
  );
}

function parseEnvelope(value: unknown): PublishAuthorizationGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parsePublishAuthorizationGateCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: unknown;
    execution?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parsePublishAuthorizationGateCard(text) : null;
  }
  if (
    envelope.kind === "publish-execution" &&
    isExecution(envelope.execution)
  ) {
    return { kind: "publish-execution", execution: envelope.execution };
  }
  return null;
}

export function parsePublishAuthorizationGateCard(
  result: string,
): PublishAuthorizationGateCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

const KIND_LABEL = { media: "媒体", "we-media": "自媒体" } as const;

const EXECUTION_STATUS_LABEL: Record<PublishExecutionProjection["status"], string> =
  {
    "awaiting-confirmation": "待独立确认",
    confirmed: "已确认，尚未开始",
    running: "执行中",
    scheduled: "已排期，等待调度",
    "partially-succeeded": "部分成功",
    succeeded: "已提交完成",
    failed: "执行失败",
    superseded: "已被新预览替代",
    "reconciliation-required": "需要人工核对",
  };

/** 启动后的非终态：继续轮询直至调度器收敛到终态。 */
const POST_START_ACTIVE = new Set<PublishExecutionProjection["status"]>([
  "running",
  "scheduled",
  "partially-succeeded",
  "reconciliation-required",
]);

/** 订单投影可见的执行状态：执行终态后渠道状态仍会流转（退款/补发）。 */
const ORDER_VIEW_STATUSES = new Set<PublishExecutionProjection["status"]>([
  ...POST_START_ACTIVE,
  "succeeded",
  "failed",
]);

function progressFingerprint(execution: PublishExecutionProjection): string {
  return [
    execution.revision,
    execution.status,
    execution.items
      .map(
        (item) =>
          `${item.status}:${item.objectUrl ? 1 : 0}:${item.externalOrderId ?? "-"}:${item.attempts}:${item.uploadAttempts}:${item.nextAttemptAt ?? "-"}`,
      )
      .join("|"),
  ].join(":");
}

function StageBadge({ badge }: { badge: PublishStageBadge }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 ${PUBLISH_STAGE_TONE_CLASS[badge.tone]}`}
    >
      {badge.tone === "active" && (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      )}
      {badge.label}
    </span>
  );
}

function PublishStatusItem({
  item,
  order,
  balancePoints,
}: {
  item: PublishItemProjection;
  order?: PublishOrderStatusEntry;
  /** 余额投影（票 06）：仅在退点文案中带出，供用户核对退回后的变化。 */
  balancePoints?: number | null;
}) {
  const [showScreenshot, setShowScreenshot] = useState(false);
  const refunded = order ? publishOrderRefundsPoints(order.status) : false;
  return (
    <article
      className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
      data-publish-item={item.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium leading-5">
            {item.article.title}
          </p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {item.channel.name}（{KIND_LABEL[item.channel.kind]}）· 单价{" "}
            {item.channel.pricePoints} 点 · 排期{" "}
            {new Date(item.scheduledAt).toLocaleString()}
          </p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-subtle)]">
          <CloudUpload className="h-3 w-3" aria-hidden="true" />
        </span>
        <StageBadge badge={ossStage(item)} />
        <span className="inline-flex items-center gap-1 text-xs text-[var(--ink-subtle)]">
          <Send className="h-3 w-3" aria-hidden="true" />
        </span>
        <StageBadge badge={orderStage(item)} />
      </div>
      {item.objectUrl && (
        <a
          href={item.objectUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 block truncate text-xs text-[var(--accent)] underline"
        >
          {item.objectUrl}
        </a>
      )}
      {item.externalOrderId && (
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          超级媒介订单：{item.externalOrderId}
        </p>
      )}
      {item.failureReason && (
        <p className="mt-1 break-words text-xs text-[var(--error)]">
          {item.failureCode ? `${item.failureCode}：` : ""}
          {item.failureReason}
        </p>
      )}
      {item.status === "failed-retryable" && item.nextAttemptAt && (
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          将于 {new Date(item.nextAttemptAt).toLocaleString()} 自动重试。
        </p>
      )}
      {order && (
        <div
          className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2"
          data-publish-order={order.sn}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-[var(--ink-subtle)]">渠道订单</span>
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-4 ${PUBLISH_STAGE_TONE_CLASS[orderStatusTone(order.status)]}`}
            >
              {orderStatusTone(order.status) === "active" && (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              )}
              {publishOrderStatusLabel(order.status)}
            </span>
            {order.url && (
              <a
                href={order.url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-xs text-[var(--accent)] underline"
              >
                发布链接
              </a>
            )}
          </div>
          {refunded && (
            <p
              className="mt-1 text-xs text-[var(--ink-muted)]"
              data-publish-order-refund={order.sn}
            >
              该订单点数已按原路退回 {item.channel.pricePoints} 点
              {typeof balancePoints === "number"
                ? `，当前余额 ${balancePoints} 点`
                : ""}
              。
            </p>
          )}
          {order.publishedAt && (
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              渠道发布时间 {new Date(order.publishedAt).toLocaleString()}
            </p>
          )}
          {order.screenshot && (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => {
                  setShowScreenshot((value) => !value);
                }}
                aria-expanded={showScreenshot}
                className="rounded-lg px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--paper-elevated)]"
              >
                {showScreenshot ? "收起渠道回传截图" : "查看渠道回传截图"}
              </button>
              {showScreenshot && (
                <div className="mt-1.5">
                  <PublishOrderScreenshot html={order.screenshot} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function PublishAuthorizationGateCard({
  data,
}: {
  data: PublishAuthorizationGateCardData;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [execution, setExecution] = useState(data.execution);
  const [status, setStatus] = useState(data.execution.status);
  const [confirmedImpact, setConfirmedImpact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orders, setOrders] = useState<PublishOrderStatusEntry[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  // 账号余额投影（票 06，Rust 为权威）：只在退点文案中读取；刷新动作经
  // ref 调用，effect 依赖保持原始值（react_stability_rules 规则 3）。
  const accountState = useContext(AccountStateContext);
  const accountApi = useContext(AccountApiContext);
  const accountRefreshRef = useRef(accountApi?.refresh);
  useEffect(() => {
    accountRefreshRef.current = accountApi?.refresh;
  }, [accountApi]);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  // 修订（预算/排期）会重算确认摘要：卡片采信新投影并要求用户重新核对；
  // 已勾选的不可逆确认随之重置，防止拿旧印象确认新内容。启动后的发布
  // 进度同样走这条「服务端胜」合并。
  const mergeRefreshed = useCallback(
    (latest: PublishExecutionProjection) => {
      setExecution(latest);
      setStatus(latest.status);
      setConfirmedImpact(false);
    },
    [],
  );
  useGateCardRefresh<PublishExecutionProjection>({
    enabled:
      hasRealSession &&
      (status === "awaiting-confirmation" || POST_START_ACTIVE.has(status)),
    projectionId: data.execution.id,
    initialFingerprint: progressFingerprint(data.execution),
    fingerprintOf: progressFingerprint,
    fetchLatest: () =>
      loadLatestPublishExecution(data.execution.workspaceId),
    onChange: mergeRefreshed,
  });
  const identity = { workspaceId: execution.workspaceId, sessionId: sessionId ?? "" };
  const orderViewActive = ORDER_VIEW_STATUSES.has(status);

  // ── 渠道订单状态投影（票 09）──────────────────────────────────────────
  // 查单即对账：计费权威在网关，本卡只持展示投影；截图为用户来源 HTML，
  // 仅经 PublishOrderScreenshot 的现有 sanitize 栈渲染。
  const refreshOrders = useCallback(async () => {
    if (!sessionId || isPendingSessionId(sessionId)) return;
    try {
      const next = await loadPublishOrderStatuses(
        apiPost,
        { workspaceId: execution.workspaceId, sessionId },
        execution.id,
      );
      setOrders(next);
      setOrdersError(null);
    } catch (cause) {
      setOrdersError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [apiPost, execution.workspaceId, execution.id, sessionId]);

  // 进入订单视图时拉一次首屏投影；同一执行只做一次（重复进入靠轮询/手动刷新）。
  const ordersFetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!orderViewActive || ordersFetchedForRef.current === execution.id) return;
    ordersFetchedForRef.current = execution.id;
    void refreshOrders();
  }, [execution.id, orderViewActive, refreshOrders]);

  // 订单仍在流转（未知/待处理/发布中/退款中）时沿闸门卡 3s 周期继续轮询。
  const ordersPollEnabled =
    hasRealSession &&
    orderViewActive &&
    (orders === null ||
      (orders ?? []).some((order) => publishOrderStatusActive(order.status)));
  useGateCardRefresh<{ id: string; orders: PublishOrderStatusEntry[] }>({
    enabled: ordersPollEnabled,
    projectionId: execution.id,
    initialFingerprint: "",
    fingerprintOf: (projection) =>
      projection.orders
        .map(
          (order) =>
            `${order.sn}:${order.status ?? "-"}:${order.url ?? "-"}:${order.screenshot ? "s" : "-"}:${order.publishedAt ?? "-"}`,
        )
        .join("|"),
    fetchLatest: async () => ({
      id: execution.id,
      orders: await loadPublishOrderStatuses(apiPost, identity, execution.id),
    }),
    onChange: (projection) => {
      setOrders(projection.orders);
      setOrdersError(null);
    },
  });
  const ordersByItemId = useMemo(
    () => new Map((orders ?? []).map((order) => [order.itemId, order])),
    [orders],
  );

  // 拒稿/取消/退款：点数按原路退回（网关权威），这里刷新余额投影让变化
  // 可见；同一 sn 只触发一次，避免轮询期间重复刷新。
  const refundNotifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!orders) return;
    const fresh = orders.filter(
      (order) =>
        order.status !== null &&
        publishOrderRefundsPoints(order.status) &&
        !refundNotifiedRef.current.has(order.sn),
    );
    if (fresh.length === 0) return;
    for (const order of fresh) {
      refundNotifiedRef.current.add(order.sn);
    }
    void accountRefreshRef.current?.();
  }, [orders]);

  const confirm = async () => {
    if (busy || !confirmedImpact) return;
    setBusy(true);
    setError(null);
    try {
      const next = await confirmPublishExecution(identity, {
        executionId: execution.id,
        expectedRevision: execution.revision,
        confirmationDigest: execution.confirmationDigest,
      });
      // confirm 会把 revision+1：必须采信服务端权威投影，否则随后的
      // 「开始确定性发布」带着过期 revision 提交，被 CAS 判为冲突。
      mergeRefreshed(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await startPublishExecution(identity, {
        executionId: execution.id,
        expectedRevision: execution.revision,
      });
      mergeRefreshed(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshStatus = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // 执行投影与订单投影同刷：渠道状态（退款/发布链接）独立于执行条目流转。
      const [next] = await Promise.all([
        loadPublishExecution(apiPost, identity, execution.id),
        refreshOrders(),
      ]);
      mergeRefreshed(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const disabled = !sessionId || isPendingSessionId(sessionId);

  return (
    <section
      aria-label="付费发布授权"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-publish-gate-card={execution.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          合计 {execution.totalPricePoints} 点
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          预计 {execution.totalPricePoints} 点 / 预算 {cnyToPoints(execution.budgetCny)} 点
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {execution.items.length} 个发布项
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          计划发布 {new Date(execution.publishStartAt).toLocaleString()}
        </span>
      </div>

      <div className="mt-2 space-y-2">
        {execution.items.map((item) => (
          <article
            key={item.id}
            className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
          >
            <p className="text-sm font-medium leading-5">{item.article.title}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              {item.channel.name}（{KIND_LABEL[item.channel.kind]}）· 单价{" "}
              {item.channel.pricePoints} 点 · 排期{" "}
              {new Date(item.scheduledAt).toLocaleString()}
            </p>
            <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
              {item.article.bodySummary}
            </p>
          </article>
        ))}
      </div>

      {status === "awaiting-confirmation" && (
        <div className="mt-2 rounded-lg border border-[var(--warning)] bg-[var(--warning-bg)] p-3">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs leading-5">{execution.irreversibleImpact}</p>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs leading-5">
            <input
              type="checkbox"
              checked={confirmedImpact}
              onChange={(event) => setConfirmedImpact(event.target.checked)}
              aria-label="确认最终文章渠道预算排期和不可逆影响"
              className="mt-0.5"
            />
            我已核对上述最终批准文章、渠道、价格、预算和排期，并明确授权创建此发布执行。
          </label>
          <button
            type="button"
            onClick={() => {
              void confirm();
            }}
            disabled={!confirmedImpact || busy || disabled}
            className="mt-3 w-full rounded-lg bg-[var(--danger)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "确认中…" : "独立确认发布执行"}
          </button>
        </div>
      )}

      {status === "confirmed" && (
        <button
          type="button"
          onClick={() => {
            void start();
          }}
          disabled={busy || disabled}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          开始确定性发布
        </button>
      )}

      {POST_START_ACTIVE.has(status) && (
        <div
          className="mt-2 rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] p-2"
          data-publish-status={execution.id}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold">发布状态</span>
            <span className="rounded-full bg-[var(--paper-elevated)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
              {EXECUTION_STATUS_LABEL[status]}
            </span>
            <button
              type="button"
              onClick={() => {
                void refreshStatus();
              }}
              disabled={busy || disabled}
              aria-label="刷新发布状态"
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              />
            </button>
          </div>
          {ordersError && (
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              渠道订单状态暂不可用：{ordersError}
            </p>
          )}
          <div className="mt-2 space-y-2">
            {execution.items.map((item) => (
              <PublishStatusItem
                key={item.id}
                item={item}
                order={ordersByItemId.get(item.id)}
                balancePoints={accountState?.points ?? null}
              />
            ))}
          </div>
        </div>
      )}

      {status === "succeeded" && (
        <div
          className="mt-2 rounded-lg bg-[var(--success-bg)] p-2"
          data-publish-status={execution.id}
        >
          <div className="flex items-start gap-2">
            <p className="flex flex-1 items-center gap-2 text-sm text-[var(--success)]">
              <CheckCircle2 className="h-4 w-4" />
              {execution.items.length} 个发布项均已由超级媒介受理。
            </p>
            <button
              type="button"
              onClick={() => {
                void refreshStatus();
              }}
              disabled={busy || disabled}
              aria-label="刷新发布状态"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
              />
            </button>
          </div>
          {ordersError && (
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              渠道订单状态暂不可用：{ordersError}
            </p>
          )}
          <div className="mt-2 space-y-2">
            {execution.items.map((item) => (
              <PublishStatusItem
                key={item.id}
                item={item}
                order={ordersByItemId.get(item.id)}
                balancePoints={accountState?.points ?? null}
              />
            ))}
          </div>
        </div>
      )}

      {status === "failed" && (
        <p
          role="alert"
          className="mt-2 rounded-lg bg-[var(--error-bg)] p-2 text-sm text-[var(--error)]"
        >
          发布执行失败：失败的发布项与原因见下方状态，可在聊天中让小鲸重试失败项。
        </p>
      )}
      {status === "failed" && (
        <div className="mt-2 space-y-2">
          {/* 无订单投影时保持原行为（只列失败项）；订单可用时列出全部
              条目，让部分成功项的渠道状态与发布链接也可见。 */}
          {execution.items
            .filter((item) => orders !== null || item.status !== "submitted")
            .map((item) => (
              <PublishStatusItem
                key={item.id}
                item={item}
                order={ordersByItemId.get(item.id)}
                balancePoints={accountState?.points ?? null}
              />
            ))}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 break-words rounded-lg bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
        这是系统维护的确认卡片，不是用户发送的消息；付费、上传与外部发布的不可逆授权只能由你在此完成。
      </p>
    </section>
  );
}
