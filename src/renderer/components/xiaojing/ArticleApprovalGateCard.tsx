import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCcw,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  approveArticle,
  discardArticle,
  editArticle,
  loadArticleBody,
  loadLatestArticleOperation,
  retryArticle,
} from "@/api/articleGenerationClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  ARTICLE_BODY_MAX_BYTES,
  type ArticleOperationProjection,
  type ArticleProjection,
} from "../../../shared/geo/articleGeneration";
import { unwrapToolResultText } from "../../../shared/toolResult";
import { ARTICLE_STATUS_LABELS } from "./articleStatusLabels";
import ArticleBodyPreview from "./ArticleBodyPreview";
import GateCardFooter, { GateCardSuccess } from "./GateCardFooter";
import { CONTENT_TYPE_LABELS } from "./contentTypeLabels";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 文章批准卡：内容由 generate_articles 的工具结果携带。用户在卡上
 * 展开/收起正文、直接编辑稿件、逐篇勾选后批准所选（走既有 /articles/edit
 * 与 /articles/approve，CAS revision）；批准后 reminder 通知 agent 继续。
 *
 * 「要哪些、不要哪些」（票 #34）：待审稿默认全选，取消勾选的篇目不随
 * 「批准所选」提交；明确不要的稿（含风险阻断与失败稿）可逐篇「不要这篇」
 * 弃用为终态（/articles/discard），不进分发计划，剩余篇目收束后操作走出
 * 批准门。选择存「取消勾选集合」——新进入待审的稿（如重试落定）自动全选。
 *
 * 展开的默认态是渲染预览（#16 / ADR-0008 Decision 6）：正文按 markdown
 * 渲染，material-image:// 占位符经材料内容取回换本地 blob，配图位置在
 * 批准前即可验收；「编辑源文」切回可编辑文本域，删占位符行即删图。
 *
 * 编辑保存的是 user-edited 新版本（revision+1，回到 draft_ready），「批准
 * 所选」逐篇提交，expectedRevision 取合并后的最新投影——用户刚编辑过的
 * 文章按新 revision 批准，编辑后的稿件才是进入分发计划的事实依据。批准
 * 结果以服务端返回投影为准（审校不过会回落 rejected，不显示已批准）。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订后的文章以新版本与
 * draft_ready 状态重渲染（正文缓存按 revision 失效、展开态自动重拉），
 * 批准继续走既有审批门。
 *
 * 失败篇目的「重试本篇」是 fire-and-forget：retry 路由校验后立即返回
 * claim 前旧快照（返回值不进 overrides——同 revision 会被合并规则压住
 * 轮询），行内「重新生成中」由本地重试票据呈现；轮询投递 attempt 已
 * 递增且落定（新草稿/再失败）的投影时自动退出等待，超过 5 分钟未落定
 * 给兜底提示并恢复重试入口。
 */
export interface ArticleApprovalGateCardData {
  kind: "article-operation";
  operation: ArticleOperationProjection;
}

function isOperation(value: unknown): value is ArticleOperationProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArticleOperationProjection>;
  return typeof candidate.id === "string" && Array.isArray(candidate.articles);
}

function parseEnvelope(value: unknown): ArticleApprovalGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parseArticleApprovalGateCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: unknown;
    operation?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parseArticleApprovalGateCard(text) : null;
  }
  if (
    envelope.kind === "article-operation" &&
    isOperation(envelope.operation)
  ) {
    return { kind: "article-operation", operation: envelope.operation };
  }
  return null;
}

export function parseArticleApprovalGateCard(
  result: string,
): ArticleApprovalGateCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

/** 可弃用状态（票 #34）：明确不要的稿进入终态；approved 与在途态不可弃。 */
const DISCARDABLE_STATUSES: ReadonlySet<ArticleProjection["status"]> = new Set([
  "draft_ready",
  "generation_failed",
  "rejected",
]);

/** 重试票据：点击「重试本篇」时记下基线 attempt 与起始时间，落定判定在父卡。 */
interface RetryTicket {
  articleId: string;
  baseAttempt: number;
  startedAt: number;
}

/** 重生成正常 1–2 分钟；超过该阈值视为「时间较长」，提示但不中断等待与轮询。 */
const RETRY_SLOW_HINT_MS = 5 * 60_000;
/** 兜底计时的重渲染粒度。 */
const RETRY_TICK_MS = 15_000;

/** 正文缓存按 revision 失效：文章被编辑或聊天修订后，展开时重新拉取。 */
interface ArticleBodyCache {
  revision: number;
  body: string;
}

function ArticleRow({
  operation,
  article,
  retrying,
  selected,
  onToggleSelect,
  onArticleChange,
  onRetryStart,
}: {
  operation: ArticleOperationProjection;
  article: ArticleProjection;
  retrying: { slow: boolean } | null;
  /** 待审稿的批准勾选态（票 #34）：非待审稿为 null，不渲染 checkbox。 */
  selected: boolean | null;
  onToggleSelect: (article: ArticleProjection) => void;
  onArticleChange: (updated: ArticleProjection) => void;
  onRetryStart: (
    article: ArticleProjection,
    outcome: "claimed" | "observed",
  ) => void;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [expanded, setExpanded] = useState(false);
  const [bodyCache, setBodyCache] = useState<ArticleBodyCache | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 弃用两步确认：终态动作先转「确认不要」，防误触（票 #34）。
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // 每个版本只自动拉一次正文：失败不无限重试，收起再展开重置（允许手动重试）。
  const triedRevisionRef = useRef<number | null>(null);
  // 在途标记走 ref：loadingBody 若进依赖会因 effect 内 setState 自我取消。
  const bodyInFlightRef = useRef(false);
  const review = article.currentVersion?.review ?? null;
  const bodyReady =
    bodyCache !== null && bodyCache.revision === article.revision;
  const canEdit = article.status === "draft_ready" && bodyReady;
  // revision=0（无版本行）的失败稿没有正文可读，提供「查看正文」只会命中
  // article_version_not_found；恢复入口是单篇重试而不是读正文。
  const hasVersion = article.currentVersion !== null;

  // 展开即取正文；缓存按 revision 失效——聊天闸门修订产出新版本（3s 轮询
  // 到达）或本卡编辑保存后，展开态下自动重拉，修订对占位符的增删在卡片
  // 重渲染中立即可见（#16）。取数走 ref 读取的最新 apiPost（稳定规则）。
  useEffect(() => {
    if (!expanded) {
      triedRevisionRef.current = null;
      return;
    }
    if (editing || bodyReady || bodyInFlightRef.current) return;
    if (triedRevisionRef.current === article.revision) return;
    triedRevisionRef.current = article.revision;
    bodyInFlightRef.current = true;
    let cancelled = false;
    setLoadingBody(true);
    setError(null);
    loadArticleBody(
      apiPost,
      { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
      { operationId: operation.id, articleId: article.id },
    )
      .then((projection) => {
        if (!cancelled) {
          setBodyCache({
            revision: projection.revision,
            body: projection.body,
          });
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        bodyInFlightRef.current = false;
        setLoadingBody(false);
      });
    return () => {
      cancelled = true;
      bodyInFlightRef.current = false;
    };
  }, [
    apiPost,
    article.id,
    article.revision,
    bodyReady,
    editing,
    expanded,
    operation.id,
    operation.workspaceId,
    sessionId,
  ]);

  const toggleBody = () => {
    if (editing) return;
    setExpanded((current) => !current);
  };

  const startEditing = () => {
    if (!canEdit || editing) return;
    setDraft(bodyCache.body);
    setEditing(true);
    setError(null);
  };

  const saveEdit = async () => {
    if (busy || !editing) return;
    const trimmed = draft.trim();
    const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";
    // 服务端 edit 校验正文首行 === `# ${title}`；先在本地给出可读错误。
    const titleMatch = /^# (\S.*)$/.exec(firstLine);
    if (!titleMatch) {
      setError("正文第一行必须保持「# 标题」格式（# 后一个空格）。");
      return;
    }
    if (new TextEncoder().encode(trimmed).byteLength > ARTICLE_BODY_MAX_BYTES) {
      setError("正文超过大小上限（256KB）。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await editArticle(
        apiPost,
        { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
        {
          operationId: operation.id,
          articleId: article.id,
          expectedRevision: article.revision,
          title: titleMatch[1].trim(),
          body: trimmed,
        },
      );
      setBodyCache({ revision: updated.revision, body: trimmed });
      setEditing(false);
      onArticleChange(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const retryFailed = async () => {
    if (busy || article.status !== "generation_failed") return;
    setBusy(true);
    setError(null);
    try {
      // fire-and-forget：路由校验后立即返回 claim 前旧快照（重生成全程
      // 1–2 分钟，同步等待会撞代理超时）；返回值不进 overrides——同
      // revision 会被合并规则压住轮询到的落定态，等待态由父卡重试票据
      // 呈现，drafting → draft_ready/generation_failed 由 /articles/latest
      // 轮询（3s）自动追上。
      await retryArticle(
        apiPost,
        { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
        {
          operationId: operation.id,
          articleId: article.id,
          expectedRevision: article.revision,
        },
      );
      onRetryStart(article, "claimed");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message === "article_retry_in_progress") {
        // 本卡票据已丢（卡片重挂载等）但服务端确有重试在跑：同样进入
        // 等待态，计时沿用既有节奏。
        setError("重试已在进行中，完成后卡片会自动更新");
        onRetryStart(article, "observed");
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  // 弃用（票 #34）：终态动作，两步确认防误触；CAS 失败把服务端错误原样
  // 呈现（多为并发修订后的 revision 冲突，轮询会带来新投影）。
  const discardThis = async () => {
    if (busy || !DISCARDABLE_STATUSES.has(article.status)) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await discardArticle(
        apiPost,
        { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
        {
          operationId: operation.id,
          articleId: article.id,
          expectedRevision: article.revision,
        },
      );
      setConfirmingDiscard(false);
      onArticleChange(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2">
      <div className="flex items-start gap-2">
        {selected !== null && !editing && (
          <input
            type="checkbox"
            aria-label={`选择批准 ${article.currentVersion?.title ?? article.requestedTitle}`}
            checked={selected}
            onChange={() => onToggleSelect(article)}
            className="mt-1"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5">
            {article.currentVersion?.title ?? article.requestedTitle}
          </p>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {CONTENT_TYPE_LABELS[article.contentType]} ·{" "}
            {retrying ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                重新生成中
              </span>
            ) : (
              ARTICLE_STATUS_LABELS[article.status]
            )}
            {article.approvedRevision ? " · 已有正式稿" : ""}
            {article.currentVersion?.origin === "user-edited"
              ? " · 已编辑"
              : ""}
          </p>
          {/* 等待期间收起重试前的旧失败原因；超时兜底单独一行提示。 */}
          {retrying?.slow && (
            <p className="mt-1 text-xs text-[var(--warning)]">
              生成时间较长，可稍候；也可再点一次重试。
            </p>
          )}
          {article.failureReason && !retrying && (
            <p className="mt-1 break-words text-xs text-[var(--error)]">
              {article.failureReason}
            </p>
          )}
          {review && (
            // ADR-0009 Decision 6：blocking 与 advisory 分区。blocking 是
            // 「为何不能通过」；advisory（硬主张无依据、广告法禁词）不阻断
            // 批准，单独列出供发布前人工处理——即使审核已通过也照常展示。
            <>
              {review.issues.some((issue) => issue.severity === "blocking") && (
                <ul className="mt-1 list-disc pl-4 text-xs text-[var(--error)]">
                  {review.issues
                    .filter((issue) => issue.severity === "blocking")
                    .map((issue, index) => (
                      <li key={`blocking-${issue.category}-${index}`}>
                        {issue.message}
                      </li>
                    ))}
                </ul>
              )}
              {review.issues.some((issue) => issue.severity !== "blocking") && (
                <ul className="mt-1 list-disc pl-4 text-xs text-[var(--warning, orange)]">
                  <li className="list-none text-[var(--ink-muted)]">
                    发布前建议人工处理（不影响批准）：
                  </li>
                  {review.issues
                    .filter((issue) => issue.severity !== "blocking")
                    .map((issue, index) => (
                      <li key={`advisory-${issue.category}-${index}`}>
                        {issue.message}
                      </li>
                    ))}
                </ul>
              )}
            </>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {hasVersion && (
              <button
                type="button"
                onClick={toggleBody}
                disabled={editing}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--accent)] disabled:opacity-50"
                aria-expanded={expanded}
                aria-label={`查看正文 ${article.currentVersion?.title ?? article.requestedTitle}`}
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {expanded ? "收起正文" : "查看正文"}
              </button>
            )}
            {article.status === "generation_failed" && (
              <button
                type="button"
                onClick={() => {
                  void retryFailed();
                }}
                disabled={busy || (retrying !== null && !retrying.slow)}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--accent)] disabled:opacity-50"
                aria-label={`重试本篇 ${article.currentVersion?.title ?? article.requestedTitle}`}
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                重试本篇
              </button>
            )}
            {canEdit && !editing && (
              <button
                type="button"
                onClick={startEditing}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--accent)]"
                aria-label={`编辑源文 ${article.currentVersion?.title ?? article.requestedTitle}`}
              >
                <SquarePen className="h-3 w-3" />
                编辑源文
              </button>
            )}
            {DISCARDABLE_STATUSES.has(article.status) &&
              !editing &&
              !retrying &&
              (confirmingDiscard ? (
                <span className="flex items-center gap-1 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      void discardThis();
                    }}
                    disabled={busy}
                    className="flex items-center gap-1 rounded bg-[var(--error-bg)] px-2 py-1 text-[var(--error)] disabled:opacity-50"
                    aria-label={`确认不要 ${article.currentVersion?.title ?? article.requestedTitle}`}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Trash2 className="h-3 w-3" />
                    )}
                    确认不要
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDiscard(false)}
                    disabled={busy}
                    className="rounded px-2 py-1 text-[var(--ink-muted)] disabled:opacity-50"
                  >
                    算了
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDiscard(true)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--ink-muted)]"
                  aria-label={`不要这篇 ${article.currentVersion?.title ?? article.requestedTitle}`}
                >
                  <Trash2 className="h-3 w-3" />
                  不要这篇
                </button>
              ))}
            {article.status === "approved" && (
              <span className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--success)]">
                <CheckCircle2 className="h-3 w-3" /> 已批准
              </span>
            )}
            {article.status === "discarded" && (
              <span className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--ink-subtle)]">
                <Trash2 aria-hidden className="h-3 w-3" /> 已弃用，不进入分发
              </span>
            )}
          </div>
          {loadingBody && (
            <p className="mt-1 flex items-center gap-1 text-xs text-[var(--ink-muted)]">
              <Loader2 className="h-3 w-3 animate-spin" /> 正文加载中…
            </p>
          )}
          {expanded && editing && (
            <div className="mt-2 space-y-2">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label={`编辑源文输入 ${article.currentVersion?.title ?? article.requestedTitle}`}
                className="h-56 w-full resize-y overflow-auto rounded bg-[var(--paper-inset)] p-2 font-mono text-xs leading-5"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void saveEdit();
                  }}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                  保存修改
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                  className="rounded px-2 py-1.5 text-xs text-[var(--ink-muted)] disabled:opacity-50"
                >
                  取消
                </button>
              </div>
              <p className="text-xs leading-4 text-[var(--ink-subtle)]">
                保存会产生新的编辑版本并回到待审核状态；批准时以编辑后的正文为准。
              </p>
            </div>
          )}
          {expanded && !editing && bodyReady && (
            // 预览默认态（#16）：正文按 markdown 渲染，material-image 占位符经
            // 材料内容取回换本地 blob；切到「编辑源文」才回到可编辑文本域。
            <ArticleBodyPreview
              body={bodyCache.body}
              workspaceId={operation.workspaceId}
              className="mt-2 max-h-72 overflow-auto rounded bg-[var(--paper-inset)] p-2 text-xs leading-5"
            />
          )}
          {error && (
            <p
              role="alert"
              className="mt-1 break-words text-xs text-[var(--error)]"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

export default function ArticleApprovalGateCard({
  data,
}: {
  data: ArticleApprovalGateCardData;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const [refreshed, setRefreshed] = useState<ArticleOperationProjection | null>(
    null,
  );
  // 本卡发起的编辑/批准结果按文章 id 覆盖服务端投影；revision 更高者胜，
  // 避免本地新版本被上一次轮询的旧投影冲掉。重试返回的 claim 前旧快照
  // 不进这张表——同 revision 会压住轮询到的 drafting/落定态。
  const [overrides, setOverrides] = useState<Map<string, ArticleProjection>>(
    () => new Map(),
  );
  // 重试票据：点击「重试本篇」后按文章 id 记录基线 attempt 与起始时间。
  const [retryTickets, setRetryTickets] = useState<Map<string, RetryTicket>>(
    () => new Map(),
  );
  // 兜底计时的当前时刻；有票据时按 RETRY_TICK_MS 周期重渲染。
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [approving, setApproving] = useState(false);
  const [approveFailures, setApproveFailures] = useState<string[]>([]);
  // 批准选择（票 #34）存「取消勾选集合」：默认全选，后到的新待审稿（如
  // 重试落定）自动入选，不需要与投影同步的 effect；编辑/修订不重置选择。
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const operation = refreshed ?? data.operation;
  const articles = operation.articles.map((article) => {
    const override = overrides.get(article.id);
    return override && override.revision >= article.revision
      ? override
      : article;
  });
  const articlesById = new Map(
    articles.map((article) => [article.id, article]),
  );
  const pending = articles.filter(
    (article) => article.status === "draft_ready",
  );
  // 批准选择（票 #34）：待审稿减去取消勾选集合即本轮提交集，提交按钮
  // 的计数与 approvePending 共用同一派生，默认全选。
  const selectedPending = pending.filter(
    (article) => !deselectedIds.has(article.id),
  );
  const approvedCount = articles.filter(
    (article) => article.status === "approved",
  ).length;
  const discardedCount = articles.filter(
    (article) => article.status === "discarded",
  ).length;
  const allApproved = articles.length > 0 && approvedCount === articles.length;
  const hasTerminalFailure = articles.some(
    (article) =>
      article.status === "rejected" || article.status === "generation_failed",
  );
  // 票据落定判定与行内等待态派生：合并投影里 attempt 越过票据基线且已
  // 不在 drafting，即重试出了结果（新草稿或再失败）——当次渲染即按落定
  // 态显示；落定票据留在表里但不参与任何判定（下次重试覆盖），无需
  // effect 清理。
  const retryingInfo = new Map<string, { slow: boolean }>();
  for (const ticket of retryTickets.values()) {
    const article = articlesById.get(ticket.articleId);
    const settled =
      article !== undefined &&
      article.generationAttempt > ticket.baseAttempt &&
      article.status !== "drafting";
    if (!settled) {
      retryingInfo.set(ticket.articleId, {
        slow: nowMs - ticket.startedAt >= RETRY_SLOW_HINT_MS,
      });
    }
  }
  const hasLiveRetry = retryingInfo.size > 0;
  useEffect(() => {
    if (!hasLiveRetry) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), RETRY_TICK_MS);
    return () => window.clearInterval(timer);
  }, [hasLiveRetry]);
  useGateCardRefresh<ArticleOperationProjection>({
    // 票据在途或投影里有 drafting（整卡重挂载后的服务端生成中态）时也要
    // 轮询：整批无 draft_ready 时重试结果只有这条通道能送达卡片。
    enabled:
      hasRealSession &&
      (pending.length > 0 ||
        articles.some((article) => article.status === "drafting") ||
        hasLiveRetry),
    projectionId: data.operation.id,
    initialFingerprint: data.operation.updatedAt,
    fingerprintOf: (latest) => latest.updatedAt,
    fetchLatest: () =>
      loadLatestArticleOperation(apiPost, {
        workspaceId: data.operation.workspaceId,
        sessionId: sessionId ?? "",
      }),
    onChange: setRefreshed,
  });

  const applyArticle = useCallback((updated: ArticleProjection) => {
    setOverrides((current) => new Map(current).set(updated.id, updated));
  }, []);

  // claimed=真重试已受理（重置计时）；observed=服务端报在途且本卡没有
  // 票据时补票（已有票据原样保留，兜底计时不被一次无效点击重置）。
  const retryStarted = useCallback(
    (article: ArticleProjection, outcome: "claimed" | "observed") => {
      setRetryTickets((current) => {
        if (outcome === "observed" && current.has(article.id)) return current;
        return new Map(current).set(article.id, {
          articleId: article.id,
          baseAttempt: article.generationAttempt,
          startedAt: Date.now(),
        });
      });
    },
    [],
  );

  // 勾选开关只翻转「取消勾选集合」成员资格（票 #34）。
  const toggleSelect = useCallback((article: ArticleProjection) => {
    setDeselectedIds((current) => {
      const next = new Set(current);
      if (next.has(article.id)) {
        next.delete(article.id);
      } else {
        next.add(article.id);
      }
      return next;
    });
  }, []);

  // 逐篇提交勾选的待审稿（每篇一次 CAS + 一次 reminder，等价于逐个点击
  // 既有批准按钮）；单篇失败不阻断其余稿件，失败清单在卡上汇总（票 #34：
  // 未勾选篇目不提交，留在待审由用户后续批准或弃用）。
  const approvePending = async () => {
    if (!hasRealSession || approving || selectedPending.length === 0) return;
    setApproving(true);
    setApproveFailures([]);
    const failures: string[] = [];
    for (const article of selectedPending) {
      try {
        const updated = await approveArticle(
          apiPost,
          { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
          {
            operationId: operation.id,
            articleId: article.id,
            expectedRevision: article.revision,
          },
        );
        applyArticle(updated);
      } catch (cause) {
        failures.push(
          `《${article.currentVersion?.title ?? article.requestedTitle}》：${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
    setApproveFailures(failures);
    setApproving(false);
  };

  return (
    <section
      aria-label="文章审核批准"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-article-gate-card={operation.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          知识 v{operation.knowledgeVersion}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {operation.sourceKind === "direct" ? "直达任务" : "来自已确认计划"}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {operation.articles.length} 篇
        </span>
        <span className="ml-auto">
          已批准 {approvedCount}/{operation.articles.length}
          {discardedCount > 0 ? ` · 已弃用 ${discardedCount}` : ""}
        </span>
      </div>
      <div className="mt-2 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {articles.map((article) => (
          <ArticleRow
            key={article.id}
            operation={operation}
            article={article}
            retrying={retryingInfo.get(article.id) ?? null}
            selected={
              article.status === "draft_ready"
                ? !deselectedIds.has(article.id)
                : null
            }
            onToggleSelect={toggleSelect}
            onArticleChange={applyArticle}
            onRetryStart={retryStarted}
          />
        ))}
      </div>
      {/* 无待批稿时的等待/终态说明留在正文区；页脚只在可操作时给按钮。 */}
      {!allApproved &&
        pending.length === 0 &&
        (hasTerminalFailure ? (
          <p className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2 text-xs leading-4 text-[var(--ink-muted)]">
            仍有文章被风险阻断或生成失败；生成失败的篇目可在上方逐篇重试，风险阻断的稿件可在对话中让小鲸修改后重新生成，或直接「不要这篇」弃用。
          </p>
        ) : discardedCount > 0 ? (
          <p className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2 text-xs leading-4 text-[var(--ink-muted)]">
            已全部处理：批准 {approvedCount} 篇、弃用 {discardedCount}{" "}
            篇；弃用的稿件不进入分发计划。
          </p>
        ) : (
          <p className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2 text-xs leading-4 text-[var(--ink-muted)]">
            等待文章生成完成…
          </p>
        ))}
      {approveFailures.length > 0 && (
        <div
          role="alert"
          className="mt-2 rounded-lg bg-[var(--error-bg)] p-2 text-xs leading-4 text-[var(--error)]"
        >
          <p>部分文章未能批准：</p>
          <ul className="mt-1 list-disc pl-4">
            {approveFailures.map((failure, index) => (
              <li key={index}>{failure}</li>
            ))}
          </ul>
        </div>
      )}
      <GateCardFooter note="批准后进入分发计划">
        {allApproved ? (
          <GateCardSuccess>已全部批准（{approvedCount} 篇）</GateCardSuccess>
        ) : pending.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              void approvePending();
            }}
            disabled={approving || !hasRealSession || selectedPending.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
          >
            {approving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            批准所选（{selectedPending.length} 篇）
          </button>
        ) : discardedCount > 0 ? (
          <GateCardSuccess>
            已全部处理（批准 {approvedCount} · 弃用 {discardedCount}）
          </GateCardSuccess>
        ) : null}
      </GateCardFooter>
    </section>
  );
}
