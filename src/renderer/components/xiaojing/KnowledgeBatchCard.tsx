import { Check, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTabApi } from '@/context/TabContext';
import { isEnterpriseProfileField } from '../../../shared/geo/enterpriseProfile';
import {
  buildKnowledgeFieldRows,
  KNOWLEDGE_CARD_MAX_CANDIDATES,
  parseKnowledgeCandidatesCard,
  type KnowledgeBatchDecisionItem,
  type KnowledgeBatchDecisionItemResult,
  type KnowledgeCardCandidate,
  type KnowledgeCandidatesCardData,
  type KnowledgeFieldRow,
} from '../../../shared/geo/knowledgeCard';

/** 通知右侧工作台"品牌知识·当前权威"面板刷新（同一 renderer 内的事件）。 */
export const KNOWLEDGE_DECIDED_EVENT = 'xiaojing:knowledge-decided';

export { parseKnowledgeCandidatesCard };

/**
 * 行内裁决的本地暂存，按候选 id 键控：卡片 3s 轮询用新 data 投影重建后原样保留
 * （ADR 0003）。逐行「确认」是纯视觉糖；冲突二选一在整卡确认前可改。
 */
type KnowledgeConflictChoice = 'adopt-new' | 'keep-current';

interface CandidateState {
  confirmed: boolean;
  conflictChoice: KnowledgeConflictChoice | undefined;
  outcome: 'pending' | 'settled' | 'failed';
  settledStatus?: string;
  error?: string;
}

/** 本地无暂存时的缺省：直接采信 payload 状态——materials/status 重建的卡就是权威快照。 */
function defaultStateOf(candidate: KnowledgeCardCandidate): CandidateState {
  const undecided = candidate.status === 'awaiting-confirmation' || candidate.status === 'conflict';
  return {
    confirmed: false,
    conflictChoice: undefined,
    outcome: undecided ? 'pending' : 'settled',
    settledStatus: undecided ? undefined : candidate.status,
  };
}

/** 分层默认（ADR 0003）：conflict 显式二选一；inferred（含未知 provenance）待确认；extracted/asked 已就绪。 */
function candidateTier(candidate: KnowledgeCardCandidate): 'ready' | 'inferred' | 'conflict' {
  if (candidate.status === 'conflict') return 'conflict';
  const provenance = candidate.source.profileProvenance;
  return provenance === 'extracted' || provenance === 'asked' ? 'ready' : 'inferred';
}

/** 字符串/字符串数组按顿号连成可扫读的行内摘要，其余 JSON 保持紧凑原文。 */
function formatValueForDisplay(raw: string, unit?: string | null): string {
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') text = parsed;
    else if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      text = parsed.join('、');
    } else {
      text = JSON.stringify(parsed);
    }
  } catch {
    // 解析失败保持原文展示。
  }
  return unit ? `${text} ${unit}` : text;
}

function provenanceLabelKey(candidate: KnowledgeCardCandidate): string {
  const provenance = candidate.source.profileProvenance;
  if (provenance === 'extracted' || provenance === 'asked' || provenance === 'inferred') {
    return `knowledgeCard.provenance.${provenance}`;
  }
  return 'knowledgeCard.provenance.inferred';
}

interface KnowledgeBatchCardProps {
  data: KnowledgeCandidatesCardData;
  /** 面板内嵌时通知宿主刷新；聊天内不传，靠全局事件刷新工作台。 */
  onDecided?: () => void;
}

export default function KnowledgeBatchCard({ data, onDecided }: KnowledgeBatchCardProps) {
  const { t } = useTranslation('chat');
  const { apiPost } = useTabApi();
  // useMemo 稳定数组身份：水合 effect 与回调依赖不随渲染抖动（react_stability_rules）。
  const candidates = useMemo(
    () => data.candidates.slice(0, KNOWLEDGE_CARD_MAX_CANDIDATES),
    [data],
  );
  const fieldRows = useMemo(
    () => buildKnowledgeFieldRows({
      candidates,
      overflowByField: data.overflowByField,
    }),
    [candidates, data.overflowByField],
  );
  const [states, setStates] = useState<Record<string, CandidateState>>(() =>
    Object.fromEntries(candidates.map((candidate) => [candidate.id, defaultStateOf(candidate)])));
  // 字段行复核卡默认展开：扫固定字段序的行即可完成复核（ADR 0003）。
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const identity = useMemo(() => ({
    workspaceId: candidates[0]?.workspaceId ?? '',
    sessionId: candidates[0]?.sessionId ?? '',
  }), [candidates]);

  const stateOf = useCallback(
    (candidate: KnowledgeCardCandidate): CandidateState =>
      states[candidate.id] ?? defaultStateOf(candidate),
    [states],
  );

  // 会话重载后按 id 水合真实状态：已裁决的行直接呈现结果，不重复给按钮。
  // 只随挂载执行一次；candidates/identity 经 ref 读取，避免 3s 轮询重建 data
  // 抖动依赖、把在途水合响应当取消丢弃（react_stability_rules 规则 2/5）。
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const hydrationRef = useRef(false);
  useEffect(() => {
    if (hydrationRef.current) return;
    const current = identityRef.current;
    if (!current.workspaceId || !current.sessionId) return;
    hydrationRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiPost<{
          success: boolean;
          candidates?: Array<KnowledgeCardCandidate | null>;
        }>('/api/xiaojing/knowledge/candidates', {
          ...current,
          candidateIds: candidatesRef.current.map((candidate) => candidate.id),
        });
        if (cancelled || !response.success || !Array.isArray(response.candidates)) return;
        const requested = candidatesRef.current;
        setStates((prev) => {
          const next = { ...prev };
          response.candidates!.forEach((candidate, index) => {
            if (!candidate) return;
            if (candidate.status === 'awaiting-confirmation' || candidate.status === 'conflict') return;
            const local = requested[index];
            if (local) {
              next[local.id] = { ...defaultStateOf(local), outcome: 'settled', settledStatus: candidate.status };
            }
          });
          return next;
        });
      } catch {
        // 水合失败保持待确认渲染；提交时的 CAS 会兜底。
      }
    })();
    return () => { cancelled = true; };
  }, [apiPost]);

  const activeCandidates = useMemo(
    () => candidates.filter((candidate) => stateOf(candidate).outcome !== 'settled'),
    [candidates, stateOf],
  );
  const unresolvedConflictCount = activeCandidates.filter(
    (candidate) => candidate.status === 'conflict' && !stateOf(candidate).conflictChoice,
  ).length;
  const failedCount = activeCandidates.filter(
    (candidate) => stateOf(candidate).outcome === 'failed',
  ).length;
  const allSettled = activeCandidates.length === 0;
  const canSubmit = activeCandidates.length > 0 && unresolvedConflictCount === 0 && !busy;

  const patchState = useCallback((candidate: KnowledgeCardCandidate, patch: Partial<CandidateState>) => {
    setStates((current) => ({
      ...current,
      [candidate.id]: { ...(current[candidate.id] ?? defaultStateOf(candidate)), ...patch },
    }));
  }, []);

  /** AI 补全行的纯视觉确认：只把该行未决补全候选翻成已确认徽章，不产生独立提交。 */
  const confirmRow = useCallback((row: KnowledgeFieldRow) => {
    setStates((current) => {
      const next = { ...current };
      for (const candidate of row.candidates) {
        if (candidateTier(candidate) !== 'inferred') continue;
        if ((current[candidate.id] ?? defaultStateOf(candidate)).outcome === 'settled') continue;
        next[candidate.id] = { ...(current[candidate.id] ?? defaultStateOf(candidate)), confirmed: true };
      }
      return next;
    });
  }, []);

  const chooseConflict = useCallback((candidate: KnowledgeCardCandidate, choice: KnowledgeConflictChoice) => {
    patchState(candidate, { conflictChoice: choice });
  }, [patchState]);

  const submitDecisions = useCallback(async (targets: KnowledgeCardCandidate[]) => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const decisions: KnowledgeBatchDecisionItem[] = targets.map((candidate) => ({
        candidateId: candidate.id,
        // 整卡全量采纳（ADR 0003）：非冲突行一律 adopt-new（含从未逐条查看的补全行）；
        // 冲突行按用户内联选择。canSubmit 已保证无未选择冲突，兜底保守保留当前值。
        decision: candidate.status === 'conflict'
          ? (stateOf(candidate).conflictChoice ?? 'keep-current')
          : 'adopt-new',
        expectedCurrentVersion: candidate.current?.version ?? candidate.baseVersion,
      }));
      const response = await apiPost<{
        success: boolean;
        error?: string;
        results?: KnowledgeBatchDecisionItemResult[];
      }>('/api/xiaojing/knowledge/decide-batch', {
        ...identity,
        decisions,
      });
      if (!response.results) {
        throw new Error(response.error ?? t('knowledgeCard.submitFailed'));
      }
      setStates((current) => {
        const next = { ...current };
        for (const result of response.results ?? []) {
          const local = candidatesRef.current.find((candidate) => candidate.id === result.candidateId);
          if (!local) continue;
          if (result.ok) {
            next[result.candidateId] = {
              ...(current[result.candidateId] ?? defaultStateOf(local)),
              outcome: 'settled',
              settledStatus: result.status,
              error: undefined,
            };
          } else {
            next[result.candidateId] = {
              ...(current[result.candidateId] ?? defaultStateOf(local)),
              outcome: 'failed',
              error: result.error,
            };
          }
        }
        return next;
      });
      if (response.results.some((result) => result.ok)) {
        window.dispatchEvent(new CustomEvent(KNOWLEDGE_DECIDED_EVENT, {
          detail: { workspaceId: identity.workspaceId },
        }));
        onDecided?.();
      }
      if (response.results.some((result) => !result.ok)) {
        setSubmitError(t('knowledgeCard.partialFailure'));
      }
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, apiPost, identity, onDecided, stateOf, t]);

  return (
    <section
      className={`overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] transition-opacity ${
        allSettled ? 'opacity-60' : ''
      }`}
      data-knowledge-batch-card={identity.workspaceId}
      data-settled={allSettled}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 border-b border-[var(--line-subtle)] px-4 py-3 text-left hover:bg-[var(--hover-bg)]"
      >
        <div className={`mt-0.5 rounded-lg p-2 ${allSettled
          ? 'bg-[var(--paper-inset)] text-[var(--ink-subtle)]'
          : 'bg-[var(--accent-warm-subtle)] text-[var(--accent)]'}`}>
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--ink)]">
            {t('knowledgeCard.title')}
            {allSettled && (
              <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-normal text-[var(--ink-subtle)]">
                {t('knowledgeCard.settledBadge')}
              </span>
            )}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            {[
              data.material ? t('knowledgeCard.sourceMaterial', { name: data.material.displayName }) : null,
              t('knowledgeCard.candidateCount', { count: candidates.length }),
              t('knowledgeCard.headerSuffix'),
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
        {open
          ? <ChevronDown className="mt-1.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
          : <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />}
      </button>

      {open && (
      <div className="space-y-2.5 px-4 py-3">
        {fieldRows.map((row) => (
          <FieldRow
            key={row.field}
            row={row}
            stateOf={stateOf}
            busy={busy}
            onConfirmRow={confirmRow}
            onChoose={chooseConflict}
            onRetry={(targets) => { void submitDecisions(targets); }}
          />
        ))}

        {submitError && (
          <p role="alert" className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
            {submitError}
          </p>
        )}

        {allSettled ? (
          <p className="flex items-center gap-1.5 text-xs text-[var(--success)]">
            <Check className="h-3.5 w-3.5" />
            {t('knowledgeCard.allSettledNote')}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => { void submitDecisions(activeCandidates); }}
              className="rounded-md bg-[var(--button-dark-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-dark-text)] disabled:opacity-50"
            >
              {busy
                ? t('knowledgeCard.submitting')
                : failedCount > 0
                  ? t('knowledgeCard.retryFailed', { count: activeCandidates.length })
                  : t('knowledgeCard.confirmAll', { count: activeCandidates.length })}
            </button>
            {unresolvedConflictCount > 0 && (
              <span className="text-[var(--warning)]">
                {t('knowledgeCard.unresolvedConflictHint', { count: unresolvedConflictCount })}
              </span>
            )}
          </div>
        )}

        <p className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs text-[var(--ink-muted)]">
          <span className="font-medium text-[var(--ink-secondary)]">{t('knowledgeCard.impactLabel')}</span>
          {t('knowledgeCard.impactNote')}
        </p>
      </div>
      )}
    </section>
  );
}

interface FieldRowProps {
  row: KnowledgeFieldRow;
  stateOf: (candidate: KnowledgeCardCandidate) => CandidateState;
  busy: boolean;
  onConfirmRow: (row: KnowledgeFieldRow) => void;
  onChoose: (candidate: KnowledgeCardCandidate, choice: KnowledgeConflictChoice) => void;
  onRetry: (targets: KnowledgeCardCandidate[]) => void;
}

/** 字段行：同字段多值合并展示；徽章与控件按分层默认派生，摘录与置信度收进展开详情。 */
function FieldRow({ row, stateOf, busy, onConfirmRow, onChoose, onRetry }: FieldRowProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const fieldText = isEnterpriseProfileField(row.field)
    ? t(`knowledgeCard.fields.${row.field}`)
    : row.field;
  const active = row.candidates.filter(
    (candidate) => stateOf(candidate).outcome !== 'settled',
  );
  const settled = row.candidates.filter(
    (candidate) => stateOf(candidate).outcome === 'settled',
  );
  const conflicts = active.filter((candidate) => candidate.status === 'conflict');
  const awaitingConfirm = active.filter(
    (candidate) => candidateTier(candidate) === 'inferred' && !stateOf(candidate).confirmed,
  );
  const failed = active.filter((candidate) => stateOf(candidate).outcome === 'failed');
  // 失败行优先于分层徽章：需要重试的行不能显示绿色的「已就绪」。
  const tier = active.length === 0
    ? 'settled'
    : failed.length > 0
      ? 'failed'
      : conflicts.length > 0
        ? 'conflict'
        : awaitingConfirm.length > 0
          ? 'pending'
          : 'ready';
  const summary = row.candidates
    .map((candidate) => formatValueForDisplay(candidate.normalizedValueJson, candidate.unit))
    .join('；');

  return (
    <article
      className="rounded-lg border border-[var(--line-subtle)] p-3 text-xs"
      data-field-row={row.field}
      data-row-tier={tier}
      data-candidate-expanded={expanded}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="shrink-0 font-medium text-[var(--ink)]">{fieldText}</span>
          <span className="min-w-0 flex-1 truncate text-[var(--ink-secondary)]" title={summary}>
            {summary}
          </span>
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />}
        </button>

        {tier === 'failed' && (
          <>
            <span className="rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-xs text-[var(--error)]">
              {t('knowledgeCard.badgeFailed')}
            </span>
            <button
              type="button"
              disabled={busy}
              aria-label={t('knowledgeCard.rowRetryAria', { field: fieldText })}
              onClick={() => onRetry(failed)}
              className="rounded-md border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
            >
              {t('knowledgeCard.rowRetry')}
            </button>
          </>
        )}
        {tier === 'ready' && (
          <span className="rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-xs text-[var(--success)]">
            {t('knowledgeCard.badgeReady')}
          </span>
        )}
        {tier === 'pending' && (
          <>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
              {t('knowledgeCard.badgePending')}
            </span>
            <button
              type="button"
              aria-label={t('knowledgeCard.rowConfirmAria', { field: fieldText })}
              onClick={() => onConfirmRow(row)}
              className="rounded-md border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
            >
              {t('knowledgeCard.rowConfirm')}
            </button>
          </>
        )}
        {conflicts.map((candidate) => {
          const choice = stateOf(candidate).conflictChoice;
          return (
            <span
              key={candidate.id}
              role="group"
              aria-label={t('knowledgeCard.conflictChoiceAria', { field: fieldText })}
              className="flex items-center gap-1.5"
            >
              <span className="rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-xs text-[var(--warning)]">
                {t('knowledgeCard.badgeConflict')}
              </span>
              <ConflictChoiceButton
                pressed={choice === 'adopt-new'}
                text={t('knowledgeCard.adoptNew')}
                ariaLabel={t('knowledgeCard.adoptNewAria', { field: fieldText })}
                onClick={() => onChoose(candidate, 'adopt-new')}
              />
              <ConflictChoiceButton
                pressed={choice === 'keep-current'}
                text={t('knowledgeCard.keepCurrent')}
                ariaLabel={t('knowledgeCard.keepCurrentAria', { field: fieldText })}
                onClick={() => onChoose(candidate, 'keep-current')}
              />
            </span>
          );
        })}
        {settled.map((candidate) => {
          const status = stateOf(candidate).settledStatus ?? '';
          const resultKey = `knowledgeCard.results.${status}`;
          const resultLabel = t(resultKey);
          return (
            <span
              key={candidate.id}
              className="inline-flex items-center gap-1 text-[var(--ink-subtle)]"
              data-candidate-result={candidate.id}
            >
              <Check className="h-3 w-3 text-[var(--success)]" />
              {resultLabel === resultKey ? status : resultLabel}
            </span>
          );
        })}
      </div>

      {row.overflowCount > 0 && (
        <p className="mt-1.5 text-xs text-[var(--ink-subtle)]">
          {t('knowledgeCard.overflowHint', { count: row.overflowCount })}
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 border-t border-[var(--line-subtle)] pt-2">
          {row.candidates.map((candidate) => {
            const state = stateOf(candidate);
            return (
              <div
                key={candidate.id}
                data-candidate-row={candidate.id}
                className="space-y-1 text-[var(--ink-muted)]"
              >
                <p className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[var(--ink-secondary)]">{candidate.key.subject}</span>
                  <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">
                    {t(provenanceLabelKey(candidate))}
                  </span>
                  <span>
                    {t('knowledgeCard.confidencePercent', {
                      value: Math.round(candidate.source.confidence * 100),
                    })}
                  </span>
                </p>
                {candidate.source.excerpt && (
                  <p className="break-words">
                    {t('knowledgeCard.excerptLabel', { excerpt: candidate.source.excerpt })}
                  </p>
                )}
                {candidate.current && (
                  <p>
                    {t('knowledgeCard.currentValue', {
                      version: candidate.current.version,
                      value: formatValueForDisplay(
                        candidate.current.normalizedValueJson,
                        candidate.current.unit,
                      ),
                    })}
                  </p>
                )}
                {state.outcome === 'failed' && state.error && (
                  <p role="alert" className="break-words text-[var(--error)]">
                    {t('knowledgeCard.rowFailed', { error: state.error })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

interface ConflictChoiceButtonProps {
  pressed: boolean;
  text: string;
  ariaLabel: string;
  onClick: () => void;
}

/** 冲突行内联二选一按钮；选中态用 accent 高亮并保留 aria-pressed 供键盘/读屏分辨。 */
function ConflictChoiceButton({ pressed, text, ariaLabel, onClick }: ConflictChoiceButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 ${
        pressed
          ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]'
          : 'border-[var(--line)] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]'
      }`}
    >
      {text}
    </button>
  );
}
