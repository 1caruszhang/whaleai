import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";

import {
  confirmQuestionPool,
  loadLatestQuestionPool,
  regenerateQuestionPool,
} from "@/api/brandQuestionPoolClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  QUESTION_POOL_REUSE_OUTCOME,
  type QuestionPoolProjection,
  type QuestionPoolQuestion,
} from "../../../shared/geo/questionPool";
import { unwrapToolResultText } from "../../../shared/toolResult";
import GateCardFooter, { GateCardSuccess } from "./GateCardFooter";
import { useGateCardRefresh } from "./useGateCardRefresh";

/**
 * 题库确认卡（GD-13 agent 驱动闸门模板）：内容由 run_question_pool 的
 * 工具结果携带——agent 没发起该阶段，卡片就不存在。用户在卡上审阅
 * 挖掘词、勾选问题并确认；确认走与面板相同的 /question-pools/confirm
 * 端点（CAS revision），成功后 reminder 通知 agent 继续。
 *
 * 复用契约（ADR-0011 Decision 3，2026-09-01 修订）：复用命中的已确认池
 * 信封携带 outcome=reused-confirmed-pool——卡片进入重选模式（预勾上次的
 * 选择），用户为本轮重选并确认；「重新生成问题池」按钮强制重新挖掘
 * （真实 provider 花费），成功后以正常待决流程呈现新池。问题门只在用户
 * 的卡片确认后放行。
 *
 * 待决期间每 3s 轮询 /latest（票 38）：聊天修订（改/删/增搜索词与候选
 * 问题）按服务端胜合并——文本被改的行采信服务端值，未改行保留本地勾选。
 */
export interface QuestionPoolGateCardData {
  kind: "question-pool";
  /** 复用标记只认已知值：未知 outcome 按旧信封处理（只读展示）。 */
  outcome?: typeof QUESTION_POOL_REUSE_OUTCOME;
  pool: QuestionPoolProjection;
}

function isPool(value: unknown): value is QuestionPoolProjection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QuestionPoolProjection>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.questions) &&
    Array.isArray(candidate.keywords)
  );
}

function parseEnvelope(value: unknown): QuestionPoolGateCardData | null {
  if (Array.isArray(value)) {
    const text = value.find(
      (item): item is { type: string; text: string } =>
        !!item
        && typeof item === "object"
        && (item as { type?: unknown }).type === "text"
        && typeof (item as { text?: unknown }).text === "string",
    )?.text;
    return text ? parseQuestionPoolGateCard(text) : null;
  }
  if (!value || typeof value !== "object") return null;
  const envelope = value as {
    kind?: unknown;
    outcome?: unknown;
    pool?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (Array.isArray(envelope.content)) {
    const text = envelope.content.find((item) => item.type === "text")?.text;
    return text ? parseQuestionPoolGateCard(text) : null;
  }
  if (envelope.kind === "question-pool" && isPool(envelope.pool)) {
    return {
      kind: "question-pool",
      outcome:
        envelope.outcome === QUESTION_POOL_REUSE_OUTCOME
          ? QUESTION_POOL_REUSE_OUTCOME
          : undefined,
      pool: envelope.pool,
    };
  }
  return null;
}

export function parseQuestionPoolGateCard(
  result: string,
): QuestionPoolGateCardData | null {
  try {
    return parseEnvelope(JSON.parse(unwrapToolResultText(result)));
  } catch {
    return null;
  }
}

const PRIORITY_LABEL = { high: "高", medium: "中", low: "低" } as const;
const KEYWORD_CATEGORY_LABEL = {
  core: "核心词",
  scene: "场景词",
  longtail: "长尾词",
} as const;
const KEYWORD_HEAT_LABEL = { high: "高", medium: "中", low: "低" } as const;

export default function QuestionPoolGateCard({
  data,
}: {
  data: QuestionPoolGateCardData;
}) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [pool, setPool] = useState<QuestionPoolProjection>(data.pool);
  const [questions, setQuestions] = useState<QuestionPoolQuestion[]>(
    data.pool.questions,
  );
  // 复用命中（ADR-0011 Decision 3，2026-09-01 修订）：confirmed 池 + 信封
  // outcome 标记 → 重选模式，卡片预勾上次的选择等用户确认，问题门只在
  // 卡片确认后放行。无 outcome 的 confirmed 池是旧信封，保持只读展示
  // （不构成可操作对象）；awaiting-selection 起步走正常待决流程。
  const [reselect, setReselect] = useState(
    data.outcome === QUESTION_POOL_REUSE_OUTCOME && data.pool.status === "confirmed",
  );
  // 重生成成功后进入正常待决模式（新池 awaiting-selection，不携带复用标记）。
  const [initiallyConfirmed] = useState(data.pool.status === "confirmed" && !reselect);
  const [confirmed, setConfirmed] = useState(initiallyConfirmed);
  const [busy, setBusy] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCount = questions.filter((q) => q.selected).length;
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));

  // 服务端胜（票 38）：文本被服务端修订的行按服务端值重渲染；未改行保留
  // 本地勾选；被删的行消失；新增行按服务端默认呈现。若池已被确认，直接
  // 呈现确认态。
  const mergeRefreshed = useCallback((latest: QuestionPoolProjection) => {
    setPool(latest);
    if (latest.status === "confirmed") setConfirmed(true);
    setQuestions((current) => {
      const currentById = new Map(current.map((q) => [q.id, q]));
      return latest.questions.map((incoming) =>
        currentById.get(incoming.id)?.text === incoming.text
          ? (currentById.get(incoming.id) as QuestionPoolQuestion)
          : incoming,
      );
    });
  }, []);
  useGateCardRefresh<QuestionPoolProjection>({
    enabled: !confirmed && hasRealSession,
    projectionId: data.pool.id,
    initialFingerprint: String(data.pool.revision),
    fingerprintOf: (latest) => String(latest.revision),
    fetchLatest: () =>
      loadLatestQuestionPool(
        apiPost,
        { workspaceId: data.pool.workspaceId, sessionId: sessionId ?? "" },
        data.pool.productLine,
      ),
    onChange: mergeRefreshed,
  });

  const confirm = useCallback(async () => {
    if (!sessionId || !hasRealSession || busy || regenerating || selectedCount === 0) return;
    setBusy(true);
    setError(null);
    try {
      await confirmQuestionPool(
        apiPost,
        { workspaceId: pool.workspaceId, sessionId },
        {
          poolId: pool.id,
          expectedRevision: pool.revision,
          questions,
        },
      );
      setConfirmed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiPost, busy, hasRealSession, pool.id, pool.revision, pool.workspaceId, questions, regenerating, selectedCount, sessionId]);

  // 「重新生成问题池」：跳过零成本复用、强制重新联网挖掘（真实 provider
  // 花费）；成功后以正常待决流程呈现新池（问题选择在新卡上完成）。
  const regenerate = useCallback(async () => {
    if (!sessionId || !hasRealSession || regenerating || busy) return;
    setRegenerating(true);
    setError(null);
    try {
      const fresh = await regenerateQuestionPool(
        apiPost,
        { workspaceId: pool.workspaceId, sessionId },
        {
          productLine: pool.productLine,
          targetRegion: pool.targetRegion,
          idempotencyKey: `pool-regen-${crypto.randomUUID()}`,
        },
      );
      setPool(fresh);
      setQuestions(fresh.questions);
      setReselect(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRegenerating(false);
    }
  }, [apiPost, busy, hasRealSession, pool.productLine, pool.targetRegion, pool.workspaceId, regenerating, sessionId]);

  return (
    <section
      aria-label="问题池确认"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      data-question-pool-gate-card={pool.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--ink-muted)]">
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          知识 v{pool.knowledgeVersion}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {pool.productLine}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {pool.targetRegion}
        </span>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
          {pool.reused ? "已复用确认池" : "本轮新生成"}
        </span>
        <span className="ml-auto">已选 {selectedCount}/{questions.length}</span>
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
                  {" "}· 热度{KEYWORD_HEAT_LABEL[keyword.heat]}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {questions.map((question) => (
          <article
            key={question.id}
            className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2"
          >
            <div className="flex items-start gap-2">
              {!confirmed && (
                <input
                  type="checkbox"
                  aria-label={`选择 ${question.text}`}
                  checked={question.selected}
                  onChange={(event) =>
                    setQuestions((current) =>
                      current.map((item) =>
                        item.id === question.id
                          ? { ...item, selected: event.target.checked }
                          : item,
                      ),
                    )
                  }
                  className="mt-1"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-5">{question.text}</p>
                <p className="mt-1 text-xs text-[var(--ink-subtle)]">
                  {PRIORITY_LABEL[question.score.priority]}优先级 · 相关{" "}
                  {question.score.relevance} · 潜力{" "}
                  {question.score.optimizationPotential}
                  {question.recommended ? " · 推荐项" : ""}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-2 break-words rounded-lg bg-[var(--error-bg)] p-2 text-xs text-[var(--error)]">
          {error}
        </p>
      )}
      <GateCardFooter
        note={
          reselect
            ? confirmed
              ? undefined
              : "已复用此前确认的题库——请勾选本轮要覆盖的问题后确认"
            : initiallyConfirmed
              ? "已复用此前确认的题库，无需再次确认"
              : "确认后进入下一阶段"
        }
      >
        {confirmed ? (
          initiallyConfirmed ? null : (
            <GateCardSuccess>本轮问题已确认（{selectedCount}）</GateCardSuccess>
          )
        ) : (
          <>
            {reselect && (
              <button
                type="button"
                onClick={() => {
                  void regenerate();
                }}
                disabled={regenerating || busy || !hasRealSession}
                className="flex items-center gap-1.5 rounded-md bg-[var(--paper-inset)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] disabled:opacity-50"
              >
                {regenerating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                重新生成问题池
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void confirm();
              }}
              disabled={busy || regenerating || selectedCount === 0 || !hasRealSession}
              className="flex items-center gap-1.5 rounded-md bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              确认本轮问题（{selectedCount}）
            </button>
          </>
        )}
      </GateCardFooter>
    </section>
  );
}
