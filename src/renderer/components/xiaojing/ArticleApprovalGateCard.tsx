import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  SquarePen,
} from "lucide-react";
import { useCallback, useState } from "react";

import {
  approveArticle,
  editArticle,
  loadArticleBody,
  loadLatestArticleOperation,
} from "@/api/articleGenerationClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  ARTICLE_BODY_MAX_BYTES,
  type ArticleOperationProjection,
  type ArticleProjection,
} from "../../../shared/geo/articleGeneration";
import { unwrapToolResultText } from "../../../shared/toolResult";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 文章批准卡：内容由 generate_articles 的工具结果携带。用户在卡上
 * 展开/收起正文、直接编辑稿件并整卡批准（走既有 /articles/edit 与
 * /articles/approve，CAS revision）；批准后 reminder 通知 agent 继续。
 *
 * 编辑保存的是 user-edited 新版本（revision+1，回到 draft_ready），整卡
 * 「批准并继续」逐篇提交，expectedRevision 取合并后的最新投影——用户刚
 * 编辑过的文章按新 revision 批准，编辑后的稿件才是进入分发计划的事实
 * 依据。批准结果以服务端返回投影为准（审校不过会回落 rejected，不显示
 * 已批准）。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订后的文章以新版本与
 * draft_ready 状态重渲染，批准继续走既有审批门。
 */
export interface ArticleApprovalGateCardData {
  kind: "article-operation";
  operation: ArticleOperationProjection;
}

function isOperation(value: unknown): value is ArticleOperationProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArticleOperationProjection>;
  return (
    typeof candidate.id === "string" &&
    Array.isArray(candidate.articles)
  );
}

function parseEnvelope(value: unknown): ArticleApprovalGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
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
  if (envelope.kind === "article-operation" && isOperation(envelope.operation)) {
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

const STATUS_LABELS: Record<ArticleProjection["status"], string> = {
  planned: "排队中",
  drafting: "生成中",
  draft_ready: "草稿待审核",
  reviewing: "审校中",
  approved: "已批准",
  generation_failed: "生成失败",
  rejected: "风险阻断",
};

const TYPE_LABELS: Record<string, string> = {
  guide: "指南",
  showcase: "品牌详情",
  ranking: "对比清单",
  news: "深度新闻",
  news_light: "轻量新闻",
};

/** 正文缓存按 revision 失效：文章被编辑或聊天修订后，展开时重新拉取。 */
interface ArticleBodyCache {
  revision: number;
  body: string;
}

function ArticleRow({
  operation,
  article,
  onArticleChange,
}: {
  operation: ArticleOperationProjection;
  article: ArticleProjection;
  onArticleChange: (updated: ArticleProjection) => void;
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
  const review = article.currentVersion?.review ?? null;
  const bodyReady = bodyCache !== null && bodyCache.revision === article.revision;
  const canEdit = article.status === "draft_ready" && bodyReady;

  const ensureBody = async () => {
    if (bodyReady || loadingBody) return;
    setLoadingBody(true);
    setError(null);
    try {
      const projection = await loadArticleBody(
        apiPost,
        { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
        { operationId: operation.id, articleId: article.id },
      );
      setBodyCache({ revision: projection.revision, body: projection.body });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingBody(false);
    }
  };

  const toggleBody = () => {
    if (editing || loadingBody) return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!bodyReady) void ensureBody();
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

  return (
    <article className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2">
      <p className="text-sm font-medium leading-5">
        {article.currentVersion?.title ?? article.requestedTitle}
      </p>
      <p className="mt-1 text-xs text-[var(--ink-muted)]">
        {TYPE_LABELS[article.contentType] ?? article.contentType} ·{" "}
        {STATUS_LABELS[article.status]}
        {article.approvedRevision ? " · 已有正式稿" : ""}
        {article.currentVersion?.origin === "user-edited" ? " · 已编辑" : ""}
      </p>
      {article.failureReason && (
        <p className="mt-1 break-words text-xs text-[var(--error)]">
          {article.failureReason}
        </p>
      )}
      {review && !review.passed && (
        <ul className="mt-1 list-disc pl-4 text-xs text-[var(--error)]">
          {review.issues.map((issue, index) => (
            <li key={`${issue.category}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
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
        {canEdit && !editing && (
          <button
            type="button"
            onClick={startEditing}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--accent)]"
            aria-label={`编辑正文 ${article.currentVersion?.title ?? article.requestedTitle}`}
          >
            <SquarePen className="h-3 w-3" />
            编辑正文
          </button>
        )}
        {article.status === "approved" && (
          <span className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--success)]">
            <CheckCircle2 className="h-3 w-3" /> 已批准
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
            aria-label={`编辑正文输入 ${article.currentVersion?.title ?? article.requestedTitle}`}
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
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-[var(--paper-inset)] p-2 text-xs leading-5">
          {bodyCache.body}
        </pre>
      )}
      {error && (
        <p role="alert" className="mt-1 break-words text-xs text-[var(--error)]">
          {error}
        </p>
      )}
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
  // 避免本地新版本被上一次轮询的旧投影冲掉。
  const [overrides, setOverrides] = useState<Map<string, ArticleProjection>>(
    () => new Map(),
  );
  const [approving, setApproving] = useState(false);
  const [approveFailures, setApproveFailures] = useState<string[]>([]);
  const operation = refreshed ?? data.operation;
  const articles = operation.articles.map((article) => {
    const override = overrides.get(article.id);
    return override && override.revision >= article.revision ? override : article;
  });
  const pending = articles.filter((article) => article.status === "draft_ready");
  const approvedCount = articles.filter(
    (article) => article.status === "approved",
  ).length;
  const allApproved =
    articles.length > 0 && approvedCount === articles.length;
  const hasTerminalFailure = articles.some(
    (article) =>
      article.status === "rejected" || article.status === "generation_failed",
  );
  useGateCardRefresh<ArticleOperationProjection>({
    enabled: hasRealSession && pending.length > 0,
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

  // 逐篇提交（每篇一次 CAS + 一次 reminder，等价于逐个点击既有批准按钮）；
  // 单篇失败不阻断其余稿件，失败清单在卡上汇总。
  const approvePending = async () => {
    if (!hasRealSession || approving || pending.length === 0) return;
    setApproving(true);
    setApproveFailures([]);
    const failures: string[] = [];
    for (const article of pending) {
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
        <span className="ml-auto">已批准 {approvedCount}/{operation.articles.length}</span>
      </div>
      <div className="mt-2 space-y-2">
        {articles.map((article) => (
          <ArticleRow
            key={article.id}
            operation={operation}
            article={article}
            onArticleChange={applyArticle}
          />
        ))}
      </div>
      {allApproved ? (
        <p className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--success-bg)] p-2 text-sm text-[var(--success)]">
          <CheckCircle2 className="h-4 w-4" />
          本轮文章已全部批准（{approvedCount} 篇）；小鲸会继续制定分发计划。
        </p>
      ) : pending.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            void approvePending();
          }}
          disabled={approving || !hasRealSession}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          {approving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          批准并继续（{pending.length} 篇）
        </button>
      ) : hasTerminalFailure ? (
        <p className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2 text-xs leading-4 text-[var(--ink-muted)]">
          仍有文章被风险阻断或生成失败；可在对话中让小鲸修改后重新生成。
        </p>
      ) : (
        <p className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2 text-xs leading-4 text-[var(--ink-muted)]">
          等待文章生成完成…
        </p>
      )}
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
      <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
        这是系统维护的确认卡片，不是用户发送的消息；展开正文可直接编辑，编辑后的稿件经你在此批准才会进入分发计划。
      </p>
    </section>
  );
}
