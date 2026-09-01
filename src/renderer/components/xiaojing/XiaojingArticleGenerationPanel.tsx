import { Eye, FilePenLine, Loader2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  loadArticleOperation,
  loadArticleBody,
  loadLatestArticleOperation,
} from "@/api/articleGenerationClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  type ArticleBodyProjection,
  type ArticleOperationProjection,
  type ArticleProjection,
} from "../../../shared/geo/articleGeneration";
import { ARTICLE_STATUS_LABELS } from "./articleStatusLabels";
import { CONTENT_TYPE_LABELS } from "./contentTypeLabels";
import ArticleBodyPreview from "./ArticleBodyPreview";

interface XiaojingArticleGenerationPanelProps {
  workspaceId: string;
  operationId?: string;
  /** 会话内工具推进后的产物刷新信号（票 29：面板只读化后的刷新联动）。 */
  refreshKey?: number;
}

/**
 * 票 29：文章阶段面板是纯只读投影。生成、编辑、重试与批准只出现在
 * 聊天里的卡片（ArticleApprovalGateCard）上；这里只展示用户已批准的
 * 文章与批准稿正文，未确认的过程产物留在聊天卡片。
 */
export default memo(function XiaojingArticleGenerationPanel({
  workspaceId,
  operationId,
  refreshKey = 0,
}: XiaojingArticleGenerationPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [operation, setOperation] = useState<ArticleOperationProjection | null>(
    null,
  );
  const [busyArticleId, setBusyArticleId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<ArticleBodyProjection | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  const identity = useMemo(
    () => (sessionId ? { workspaceId, sessionId } : null),
    [sessionId, workspaceId],
  );

  useEffect(() => {
    let active = true;
    if (!hasRealSession || !identity)
      return () => {
        active = false;
      };
    void (
      operationId
        ? loadArticleOperation(apiPost, identity, operationId)
        : loadLatestArticleOperation(apiPost, identity)
    )
      .then((latest) => {
        if (!active) return;
        setError(null);
        setOperation(latest);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [apiPost, hasRealSession, identity, operationId, refreshKey]);

  const viewApproved = useCallback(
    async (article: ArticleProjection) => {
      if (!identity) return;
      setBusyArticleId(article.id);
      setError(null);
      try {
        const body = await loadArticleBody(apiPost, identity, {
          operationId: article.operationId,
          articleId: article.id,
          approved: true,
        });
        setOpened(body);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyArticleId(null);
      }
    },
    [apiPost, identity],
  );

  const approvedArticles =
    operation?.articles.filter((article) => article.approvedRevision) ?? [];
  const pendingCount = operation
    ? operation.articles.length - approvedArticles.length
    : 0;

  return (
    <section
      aria-label="文章生成与审核"
      className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
    >
      <div className="flex items-start gap-2">
        <FilePenLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div>
          <h3 className="text-sm font-medium">文章生成、审校与批准</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--ink-muted)]">
            生成与批准在聊天卡片上完成；这里只展示已批准的文章与批准稿正文。
          </p>
        </div>
      </div>

      {!hasRealSession && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          请先建立真实 Session。
        </p>
      )}

      {error && (
        <p className="mt-2 break-words rounded-lg bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}

      {hasRealSession && !operation && !error && (
        <p className="mt-3 text-center text-xs text-[var(--ink-subtle)]">
          暂无文章任务；在聊天中发起后这里展示结果。
        </p>
      )}

      {operation && approvedArticles.length === 0 && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          尚无已批准文章；草稿的审阅与批准请回到聊天中的确认卡片完成，批准后这里展示。
        </p>
      )}

      {operation && approvedArticles.length > 0 && (
        <div className="mt-3">
          <div className="flex flex-wrap gap-1 text-xs text-[var(--ink-muted)]">
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              知识 v{operation.knowledgeVersion}
            </span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              {operation.sourceKind === "direct" ? "直达任务" : "已确认计划"}
            </span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              已批准 {approvedArticles.length} 篇
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {approvedArticles.map((article) => {
              const rowBusy = busyArticleId === article.id;
              return (
                <article
                  key={article.id}
                  className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {article.currentVersion?.title ??
                          article.requestedTitle}
                      </p>
                      <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        {CONTENT_TYPE_LABELS[article.contentType]} ·{" "}
                        {ARTICLE_STATUS_LABELS[article.status]} · v
                        {article.revision}
                        {article.approvedRevision
                          ? ` · 正式稿 v${article.approvedRevision}`
                          : ""}
                      </p>
                    </div>
                    {rowBusy && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {article.approvedRevision && (
                      <button
                        type="button"
                        onClick={() => void viewApproved(article)}
                        disabled={rowBusy}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-emerald-700 disabled:opacity-40"
                      >
                        <Eye className="h-3 w-3" />
                        查看批准稿
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          {pendingCount > 0 && (
            <p className="mt-2 text-xs leading-4 text-[var(--ink-subtle)]">
              另有 {pendingCount}{" "}
              篇生成或审阅中的文章，过程与结果请在聊天卡片查看。
            </p>
          )}
        </div>
      )}

      {opened?.approved && (
        <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
          <p className="text-xs font-medium text-emerald-700">
            批准稿 v{opened.revision}（只读）
          </p>
          {/* #16 / ADR-0008：批准稿是渲染态（与发布产物同构的图文复核），
              material-image 占位符经材料内容取回换本地 blob 显示。 */}
          <ArticleBodyPreview
            body={opened.body}
            workspaceId={workspaceId}
            className="mt-2 max-h-64 overflow-auto text-xs leading-5"
          />
        </div>
      )}
    </section>
  );
});
