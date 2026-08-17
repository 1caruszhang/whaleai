import { SearchCheck } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { loadLatestQuestionPool } from "@/api/brandQuestionPoolClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import type {
  QuestionPoolProjection,
} from "../../../shared/geo/questionPool";
import { isPendingSessionId } from "../../../shared/constants";

interface XiaojingQuestionPoolPanelProps {
  workspaceId: string;
  /** 会话内工具推进后的产物刷新信号（票 29：面板只读化后的刷新联动）。 */
  refreshKey?: number;
}

const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" } as const;
const KEYWORD_CATEGORY_LABEL = {
  core: "核心词",
  scene: "场景词",
  longtail: "长尾词",
} as const;
const KEYWORD_HEAT_LABEL = { high: "高", medium: "中", low: "低" } as const;

/**
 * 票 29：问题池阶段面板是纯只读投影。生成、勾选、编辑与确认只出现在
 * 聊天里的确认卡片（QuestionPoolGateCard）上，这里不再存在第二套交互。
 */
export default memo(function XiaojingQuestionPoolPanel({
  workspaceId,
  refreshKey = 0,
}: XiaojingQuestionPoolPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [pool, setPool] = useState<QuestionPoolProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  useEffect(() => {
    let active = true;
    if (!hasRealSession || !sessionId) {
      queueMicrotask(() => {
        if (active) setPool(null);
      });
      return () => {
        active = false;
      };
    }
    // 不按产品线过滤：投影面板展示会话最新权威问题池。
    void loadLatestQuestionPool(apiPost, { workspaceId, sessionId })
      .then((latest) => {
        if (!active) return;
        setError(null);
        setPool(latest);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [apiPost, hasRealSession, refreshKey, sessionId, workspaceId]);

  const selectedCount =
    pool?.questions.filter((question) => question.selected).length ?? 0;

  return (
    <section
      aria-label="关键词与问题池"
      className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
    >
      <div className="flex items-start gap-2">
        <SearchCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
        <div>
          <h3 className="text-sm font-medium">关键词与问题池</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--ink-muted)]">
            生成与确认在聊天卡片上完成；这里展示当前权威结果。
          </p>
        </div>
      </div>

      {!hasRealSession && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          请先建立真实 Session，再查看本轮问题。
        </p>
      )}

      {error && (
        <p className="mt-2 break-words rounded-lg bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}

      {hasRealSession && !pool && !error && (
        <p className="mt-3 text-center text-xs text-[var(--ink-subtle)]">
          暂无问题池；在聊天中发起后这里展示结果。
        </p>
      )}

      {pool && (
        <div className="mt-3" role="region" aria-label="问题池选择">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              知识 v{pool.knowledgeVersion}
            </span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              {pool.targetRegion}
            </span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
              {pool.reused ? "已复用" : "新生成"}
            </span>
            <span className="ml-auto">
              已选 {selectedCount}/{pool.questions.length}
            </span>
          </div>
          {pool.keywords.length > 0 && (
            <div
              className="mt-2 rounded-lg bg-[var(--paper-inset)] p-2"
              aria-label="本次挖掘的搜索词"
            >
              <p className="text-xs font-medium text-[var(--ink-muted)]">
                本次联网挖掘的搜索词（已用于生成下列问题，确认时请一并审阅）
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {pool.keywords.map((keyword) => (
                  <span
                    key={keyword.id}
                    className="rounded-full bg-[var(--paper)] px-2 py-0.5 text-xs"
                  >
                    {KEYWORD_CATEGORY_LABEL[keyword.category]} · {keyword.term}
                    <span className="text-[var(--ink-subtle)]">
                      {" "}
                      · 热度{KEYWORD_HEAT_LABEL[keyword.heat]}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-2 space-y-2">
            {pool.questions.map((question) => (
              <article
                key={question.id}
                className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-5">{question.text}</p>
                    <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                      {PRIORITY_LABEL[question.score.priority]}优先级 · 相关{" "}
                      {question.score.relevance} · 最近池相似{" "}
                      {question.score.recentPoolSimilarity} · 潜力{" "}
                      {question.score.optimizationPotential}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>

          {pool.checkpoints.length > 0 && (
            <p className="mt-2 text-xs leading-4 text-[var(--ink-subtle)]">
              checkpoint：
              {pool.checkpoints
                .map(
                  (checkpoint) =>
                    `${checkpoint.stage}:${checkpoint.status}#${checkpoint.attemptNumber}`,
                )
                .join(" · ")}
            </p>
          )}
        </div>
      )}
    </section>
  );
});
