import {
  Check,
  CircleStop,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  SearchCheck,
  Trash2,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import {
  cancelQuestionPool,
  confirmQuestionPool,
  generateQuestionPool,
  loadLatestQuestionPool,
} from "@/api/brandQuestionPoolClient";
import CustomSelect from "@/components/CustomSelect";
import { useTabApi, useTabState } from "@/context/TabContext";
import {
  QUESTION_POOL_POLICY_VERSION,
  type QuestionPoolProjection,
  type QuestionPoolQuestion,
} from "../../../shared/geo/questionPool";
import { isPendingSessionId } from "../../../shared/constants";

interface XiaojingQuestionPoolPanelProps {
  workspaceId: string;
  productLines: string[];
}

type PanelStatus =
  | "idle"
  | "loading"
  | "generating"
  | "cancelling"
  | "confirming"
  | "failed";

function newId(prefix: string): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function manualQuestion(text: string): QuestionPoolQuestion {
  return {
    id: newId("q-user"),
    text,
    selected: true,
    recommended: false,
    score: {
      mode: "pred-1",
      relevance: 50,
      recentPoolSimilarity: 0,
      optimizationPotential: 50,
      priorityTotal: 100,
      priority: "medium",
      formula: "user-added; neutral PRED-1 score until the next generated pool",
      policyVersion: QUESTION_POOL_POLICY_VERSION,
    },
    evidence: [
      { kind: "user-added", reference: "desktop-user", excerpt: text },
    ],
  };
}

const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" } as const;

export default memo(function XiaojingQuestionPoolPanel({
  workspaceId,
  productLines,
}: XiaojingQuestionPoolPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [productLine, setProductLine] = useState(productLines[0] ?? "");
  const [targetRegion, setTargetRegion] = useState("");
  const [pool, setPool] = useState<QuestionPoolProjection | null>(null);
  const [questions, setQuestions] = useState<QuestionPoolQuestion[]>([]);
  const [newQuestion, setNewQuestion] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  const applyPool = useCallback((next: QuestionPoolProjection | null) => {
    setPool(next);
    setQuestions(next?.questions ?? []);
    if (next?.targetRegion) setTargetRegion(next.targetRegion);
    if (next?.productLine) setProductLine(next.productLine);
  }, []);

  useEffect(() => {
    let active = true;
    if (!hasRealSession || !sessionId || !productLine) {
      queueMicrotask(() => {
        if (active) applyPool(null);
      });
      return () => {
        active = false;
      };
    }
    queueMicrotask(() => {
      if (!active) return;
      setStatus("loading");
      setError(null);
    });
    void loadLatestQuestionPool(
      apiPost,
      { workspaceId, sessionId },
      productLine,
    )
      .then((latest) => {
        if (active) applyPool(latest);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setStatus("idle");
      });
    return () => {
      active = false;
    };
  }, [apiPost, applyPool, hasRealSession, productLine, sessionId, workspaceId]);

  const runGeneration = useCallback(
    async (retry = false) => {
      if (!hasRealSession || !sessionId || !productLine || !targetRegion.trim())
        return;
      const requestKey =
        retry && attemptKey ? attemptKey : newId("question-pool-attempt");
      setAttemptKey(requestKey);
      setStatus("generating");
      setError(null);
      try {
        const next = await generateQuestionPool(
          apiPost,
          { workspaceId, sessionId },
          {
            productLine,
            targetRegion: targetRegion.trim(),
            idempotencyKey: requestKey,
            retry,
          },
        );
        applyPool(next);
        setStatus("idle");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("failed");
      }
    },
    [
      apiPost,
      applyPool,
      attemptKey,
      hasRealSession,
      productLine,
      sessionId,
      targetRegion,
      workspaceId,
    ],
  );

  const cancel = useCallback(async () => {
    if (!sessionId || !attemptKey) return;
    setStatus("cancelling");
    try {
      const cancelled = await cancelQuestionPool(
        apiPost,
        { workspaceId, sessionId },
        attemptKey,
      );
      applyPool(cancelled);
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [apiPost, applyPool, attemptKey, sessionId, workspaceId]);

  const updateQuestion = useCallback(
    (id: string, patch: Partial<QuestionPoolQuestion>) => {
      setQuestions((current) =>
        current.map((question) =>
          question.id === id ? { ...question, ...patch } : question,
        ),
      );
    },
    [],
  );

  const addQuestion = useCallback(() => {
    const text = newQuestion.trim();
    if (!text) return;
    setQuestions((current) => [...current, manualQuestion(text)]);
    setNewQuestion("");
  }, [newQuestion]);

  const confirm = useCallback(async () => {
    if (!sessionId || !pool || !questions.some((question) => question.selected))
      return;
    setStatus("confirming");
    setError(null);
    try {
      const decision = await confirmQuestionPool(
        apiPost,
        { workspaceId, sessionId },
        {
          poolId: pool.id,
          expectedRevision: pool.revision,
          questions,
        },
      );
      setPool((current) =>
        current
          ? {
              ...current,
              questions,
              status: "confirmed",
              revision: decision.revision,
            }
          : current,
      );
      setStatus("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("failed");
    }
  }, [apiPost, pool, questions, sessionId, workspaceId]);

  const busy = ["loading", "generating", "cancelling", "confirming"].includes(
    status,
  );
  const selectedCount = questions.filter(
    (question) => question.selected,
  ).length;

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
            同一知识版本优先加载已确认池；没有时才联网挖词并生成问题。
          </p>
        </div>
      </div>

      {!hasRealSession && (
        <p className="mt-3 rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
          请先建立真实 Session，再生成或选择本轮问题。
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="text-xs font-medium text-[var(--ink-muted)]">
          产品线
          <CustomSelect
            value={productLine}
            options={productLines.map((line) => ({ value: line, label: line }))}
            onChange={setProductLine}
            placeholder="请选择"
            disabled={!hasRealSession || busy}
            size="toolbar"
            className="mt-1 w-full"
          />
        </div>
        <label className="text-xs font-medium text-[var(--ink-muted)]">
          目标地域
          <input
            value={targetRegion}
            onChange={(event) => setTargetRegion(event.target.value)}
            disabled={!hasRealSession || busy}
            placeholder="如：成都"
            className="mt-1 h-9 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)] disabled:opacity-50"
          />
        </label>
      </div>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => {
            void runGeneration(false);
          }}
          disabled={
            !hasRealSession || busy || !productLine || !targetRegion.trim()
          }
          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
        >
          {status === "generating" && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
          加载或生成问题池
        </button>
        {status === "generating" && (
          <button
            type="button"
            onClick={() => {
              void cancel();
            }}
            className="flex items-center gap-1 rounded-md px-2 text-sm font-medium text-[var(--error)] hover:bg-[var(--paper-inset)]"
          >
            <CircleStop className="h-3.5 w-3.5" />
            取消
          </button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-lg bg-[var(--error)]/10 p-2 text-xs text-[var(--error)]">
          <p className="break-words">{error}</p>
          {attemptKey && (
            <button
              type="button"
              onClick={() => {
                void runGeneration(true);
              }}
              disabled={busy}
              className="mt-1 flex items-center gap-1 font-medium"
            >
              <RotateCcw className="h-3 w-3" />
              从失败步骤重试
            </button>
          )}
        </div>
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
              已选 {selectedCount}/{questions.length}
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {questions.map((question) => (
              <article
                key={question.id}
                className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={question.selected}
                    onChange={(event) =>
                      updateQuestion(question.id, {
                        selected: event.target.checked,
                      })
                    }
                    aria-label={`选择 ${question.text}`}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    {editingId === question.id ? (
                      <input
                        value={question.text}
                        onChange={(event) =>
                          updateQuestion(question.id, {
                            text: event.target.value,
                          })
                        }
                        aria-label={`编辑 ${question.id}`}
                        className="h-8 w-full rounded-md border border-[var(--accent)] bg-[var(--paper)] px-2 text-sm outline-none"
                      />
                    ) : (
                      <p className="text-sm leading-5">{question.text}</p>
                    )}
                    <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                      {PRIORITY_LABEL[question.score.priority]}优先级 · 相关{" "}
                      {question.score.relevance} · 最近池相似{" "}
                      {question.score.recentPoolSimilarity} · 潜力{" "}
                      {question.score.optimizationPotential}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingId((current) =>
                        current === question.id ? null : question.id,
                      )
                    }
                    aria-label={`${editingId === question.id ? "完成编辑" : "编辑"} ${question.text}`}
                    className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                  >
                    {editingId === question.id ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setQuestions((current) =>
                        current.filter((item) => item.id !== question.id),
                      )
                    }
                    aria-label={`删除 ${question.text}`}
                    className="rounded p-1 text-[var(--error)] hover:bg-[var(--paper-inset)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="mt-2 flex gap-2">
            <input
              value={newQuestion}
              onChange={(event) => setNewQuestion(event.target.value)}
              placeholder="补充一个问题"
              className="h-9 min-w-0 flex-1 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={addQuestion}
              disabled={!newQuestion.trim()}
              aria-label="新增问题"
              className="flex h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-[var(--accent)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              新增
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              void confirm();
            }}
            disabled={
              busy ||
              selectedCount === 0 ||
              questions.some((question) => !question.text.trim())
            }
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
          >
            {status === "confirming" && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            确认本轮问题（{selectedCount}）
          </button>

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
