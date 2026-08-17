import { CheckCircle2, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";

import {
  approveArticle,
  loadArticleBody,
  loadLatestArticleOperation,
} from "@/api/articleGenerationClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import type {
  ArticleOperationProjection,
  ArticleProjection,
} from "../../../shared/geo/articleGeneration";
import { unwrapToolResultText } from "../../../shared/toolResult";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 文章批准卡：内容由 generate_articles 的工具结果携带。用户在卡上
 * 展开正文、查看审校结果并逐篇批准（走既有 /articles/approve，CAS
 * revision）；批准后 reminder 通知 agent 继续。
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

function ArticleRow({
  operation,
  article,
}: {
  operation: ArticleOperationProjection;
  article: ArticleProjection;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [body, setBody] = useState<string | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [approved, setApproved] = useState(article.status === "approved");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const review = article.currentVersion?.review ?? null;

  const toggleBody = async () => {
    if (body !== null || loadingBody) return;
    setLoadingBody(true);
    setError(null);
    try {
      const projection = await loadArticleBody(
        apiPost,
        { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
        { operationId: operation.id, articleId: article.id },
      );
      setBody(projection.body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingBody(false);
    }
  };

  const approve = async () => {
    if (busy || approved) return;
    setBusy(true);
    setError(null);
    try {
      await approveArticle(
        apiPost,
        { workspaceId: operation.workspaceId, sessionId: sessionId ?? "" },
        {
          operationId: operation.id,
          articleId: article.id,
          expectedRevision: article.revision,
        },
      );
      setApproved(true);
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
          onClick={() => {
            void toggleBody();
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--accent)]"
          aria-expanded={body !== null}
          aria-label={`查看正文 ${article.currentVersion?.title ?? article.requestedTitle}`}
        >
          {body === null ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          查看正文
        </button>
        {!approved && article.status === "draft_ready" && (
          <button
            type="button"
            onClick={() => {
              void approve();
            }}
            disabled={busy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-emerald-700 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3 w-3" />
            )}
            审校并批准
          </button>
        )}
        {approved && (
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
      {body !== null && (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-[var(--paper-inset)] p-2 text-xs leading-5">
          {body}
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
  // 文章内容无本地暂存（批准动作即时提交），服务端修订直接派生新投影。
  const [refreshed, setRefreshed] = useState<ArticleOperationProjection | null>(
    null,
  );
  const operation = refreshed ?? data.operation;
  const pendingApproval = operation.articles.some(
    (article) => article.status === "draft_ready",
  );
  useGateCardRefresh<ArticleOperationProjection>({
    enabled: hasRealSession && pendingApproval,
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
  const approvedCount = operation.articles.filter(
    (article) => article.status === "approved",
  ).length;
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
        {operation.articles.map((article) => (
          <ArticleRow key={article.id} operation={operation} article={article} />
        ))}
      </div>
      <p className="mt-1 text-xs leading-4 text-[var(--ink-subtle)]">
        这是系统维护的确认卡片，不是用户发送的消息；只有你在此批准的稿件才会进入分发计划。
      </p>
    </section>
  );
}
