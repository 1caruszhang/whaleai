import { Check, ChevronDown, ChevronRight, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTabApi } from '@/context/TabContext';
import { isEnterpriseProfileField } from '../../../shared/geo/enterpriseProfile';
import {
  buildKnowledgeFieldRows,
  KNOWLEDGE_CARD_MAX_CANDIDATES,
  competitorSourceLinks,
  knowledgeFieldKeyOfPredicate,
  parseKnowledgeCandidatesCard,
  type KnowledgeBatchDecisionItem,
  type KnowledgeBatchDecisionItemResult,
  type KnowledgeCardCandidate,
  type KnowledgeCandidatesCardData,
  type KnowledgeFieldRow,
} from '../../../shared/geo/knowledgeCard';
import GateCardFooter, { GateCardSuccess } from './GateCardFooter';

/** 通知右侧工作台"品牌知识·当前权威"面板刷新（同一 renderer 内的事件）。 */
export const KNOWLEDGE_DECIDED_EVENT = 'xiaojing:knowledge-decided';

export { parseKnowledgeCandidatesCard };

/**
 * 行内裁决的本地暂存，按候选 id 键控：卡片 3s 轮询用新 data 投影重建后原样保留
 * （ADR 0003）。逐行「确认」是纯视觉糖；冲突二选一在整卡确认前可改；「更改」
 * 暂存编辑值（adopt-edited 载荷），整卡确认前不落库。
 */
type KnowledgeConflictChoice = 'adopt-new' | 'keep-current';

/**
 * 摘录文本按 URL 切分渲染：竞品证据行的「（来源：<url>）」留痕可直接点开
 * 复核原文；非 URL 段保持纯文本。摘录来自服务端证据拼接，不自己构造链接。
 */
function ExcerptText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(https?:\/\/[^\s，。、；）)」』】］…》]+)/)
        .map((part, index) =>
          part.startsWith('http://') || part.startsWith('https://')
            ? (
              <a
                key={index}
                href={part}
                target="_blank"
                rel="noreferrer"
                className="break-all underline"
                data-excerpt-source-link={part}
              >
                {part}
              </a>
            )
            : <span key={index}>{part}</span>,
        )}
    </>
  );
}

interface CandidateState {
  confirmed: boolean;
  conflictChoice: KnowledgeConflictChoice | undefined;
  /** 行内「更改」的暂存编辑值（数组/标量按候选原值形状解析）；随整卡确认提交 adopt-edited。 */
  editedValue?: unknown;
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

/**
 * 服务端侧候选内容指纹（ADR 0003「服务端胜」）：值、单位、provenance 与
 * 状态任一变化即视为服务端修订（聊天改/删/增）落地，该行本地暂存失效。
 */
function serverFingerprintOf(candidate: KnowledgeCardCandidate): string {
  return [
    candidate.status,
    candidate.normalizedValueJson,
    candidate.unit ?? '',
    candidate.source.profileProvenance ?? '',
  ].join('|');
}

/** 分层默认（ADR 0003）：conflict 显式二选一；inferred（含未知 provenance）待确认；extracted/asked 已就绪。 */
function candidateTier(candidate: KnowledgeCardCandidate): 'ready' | 'inferred' | 'conflict' {
  if (candidate.status === 'conflict') return 'conflict';
  const provenance = candidate.source.profileProvenance;
  return provenance === 'extracted' || provenance === 'asked' ? 'ready' : 'inferred';
}

/** 字符串/字符串数组按顿号连成可扫读的行内摘要，其余 JSON 保持紧凑原文。 */
function plainTextOfValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join('、');
  }
  return JSON.stringify(value);
}

function formatValueForDisplay(raw: string, unit?: string | null): string {
  const text = plainTextOfValue(parseCandidateValue(raw));
  return unit ? `${text} ${unit}` : text;
}

/** 值 → 胶囊文本数组：数组值一值一胶囊（紧凑扫读），标量单胶囊；unit 逐项追加。 */
function displayValueTexts(raw: string, unit?: string | null): string[] {
  const parsed = parseCandidateValue(raw);
  const suffix = unit ? ` ${unit}` : '';
  if (Array.isArray(parsed)) {
    return parsed.map((item) => plainTextOfValue(item) + suffix);
  }
  return [plainTextOfValue(parsed) + suffix];
}

function provenanceLabelKey(candidate: KnowledgeCardCandidate): string {
  const provenance = candidate.source.profileProvenance;
  if (provenance === 'extracted' || provenance === 'asked' || provenance === 'inferred') {
    return `knowledgeCard.provenance.${provenance}`;
  }
  return 'knowledgeCard.provenance.inferred';
}

function parseCandidateValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function candidateBaseValue(candidate: KnowledgeCardCandidate): unknown {
  return parseCandidateValue(candidate.normalizedValueJson);
}

/** 候选当前值（或已暂存编辑）→ 编辑框文本：字符串数组顿号连接，标量保持原文。 */
function editableTextOf(candidate: KnowledgeCardCandidate, state: CandidateState): string {
  return plainTextOfValue(
    state.editedValue !== undefined ? state.editedValue : candidateBaseValue(candidate),
  );
}

/** 候选原值是字符串数组 → 编辑框按顿号切分回多值；标量整体为字符串。 */
function isArrayShapedCandidate(candidate: KnowledgeCardCandidate): boolean {
  return Array.isArray(candidateBaseValue(candidate));
}

/** 两层竞品行（ADR-0007）共享的胶囊排版形态：品牌名可换行陈列。 */
function isCompetitorTierField(field: string): boolean {
  return field === 'competitors' || field === 'potentialCompetitors';
}

function parseEditedInput(text: string, candidate: KnowledgeCardCandidate): unknown {
  if (isArrayShapedCandidate(candidate)) {
    return text.split('、').map((item) => item.trim()).filter((item) => item.length > 0);
  }
  if (typeof candidateBaseValue(candidate) === 'string') {
    return text.trim();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.trim();
  }
}

/** 行内「更改」的一条暂存编辑（按候选 id 键控进本地 state）。 */
interface CandidateEdit {
  candidate: KnowledgeCardCandidate;
  value: unknown;
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

  // 服务端胜（ADR 0003）：轮询重建的候选若在服务端被修订（聊天改/删/增改
  // 变值/来源/状态），该行本地暂存（编辑值、冲突选择、视觉确认）按候选 id
  // 失效并回落 payload 投影；内容未变的轮询不触碰本地暂存。指纹更新在
  // effect 内完成、setState 走函数式更新，不把 ref 写进渲染路径。
  const serverSeenRef = useRef<Record<string, string>>({});
  useEffect(() => {
    const invalidated: KnowledgeCardCandidate[] = [];
    for (const candidate of candidates) {
      const fingerprint = serverFingerprintOf(candidate);
      const seen = serverSeenRef.current[candidate.id];
      serverSeenRef.current[candidate.id] = fingerprint;
      if (seen !== undefined && seen !== fingerprint) invalidated.push(candidate);
    }
    if (invalidated.length === 0) return;
    setStates((current) => {
      const next = { ...current };
      for (const candidate of invalidated) {
        next[candidate.id] = defaultStateOf(candidate);
      }
      return next;
    });
  }, [candidates]);

  const activeCandidates = useMemo(
    () => candidates.filter((candidate) => stateOf(candidate).outcome !== 'settled'),
    [candidates, stateOf],
  );
  // 已「更改」的冲突候选由编辑值裁决（adopt-edited），不再要求二选一。
  const unresolvedConflictCount = activeCandidates.filter(
    (candidate) => candidate.status === 'conflict'
      && stateOf(candidate).editedValue === undefined
      && !stateOf(candidate).conflictChoice,
  ).length;
  const failedCount = activeCandidates.filter(
    (candidate) => stateOf(candidate).outcome === 'failed',
  ).length;
  const allSettled = activeCandidates.length === 0;
  const canSubmit = activeCandidates.length > 0 && unresolvedConflictCount === 0 && !busy;

  // 按类分格（GD 反馈演进）：每类字段一格，格内已就绪（材料原文/用户补充）与
  // 待确认（推断/冲突/失败）候选并存；含待确认内容的类排网格前部（组内保持
  // 固定字段序）。行内视觉确认不改变归组，整卡裁决落地（settled）才重排。
  const { orderedRows, pendingFieldCount } = useMemo(() => {
    const cellNeedsReview = (row: KnowledgeFieldRow): boolean =>
      row.candidates.some((candidate) => {
        const state = stateOf(candidate);
        if (state.outcome === 'settled') return false;
        if (state.outcome === 'failed') return true;
        const tier = candidateTier(candidate);
        return tier === 'conflict' || tier === 'inferred';
      });
    const pending = fieldRows.filter(cellNeedsReview);
    return {
      orderedRows: [...pending, ...fieldRows.filter((row) => !pending.includes(row))],
      pendingFieldCount: pending.length,
    };
  }, [fieldRows, stateOf]);

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

  /** 行内「更改」保存：只暂存进本地 state（按候选 id 键控），不产生任何服务端请求。 */
  const stageEdits = useCallback((edits: CandidateEdit[]) => {
    setStates((current) => {
      const next = { ...current };
      for (const { candidate, value } of edits) {
        next[candidate.id] = {
          ...(current[candidate.id] ?? defaultStateOf(candidate)),
          editedValue: value,
          conflictChoice: undefined,
        };
      }
      return next;
    });
  }, []);

  const submitDecisions = useCallback(async (targets: KnowledgeCardCandidate[]) => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const decisions: KnowledgeBatchDecisionItem[] = targets.map((candidate) => {
        const state = stateOf(candidate);
        const base = {
          candidateId: candidate.id,
          expectedCurrentVersion: candidate.current?.version ?? candidate.baseVersion,
        };
        // 整卡全量采纳（ADR 0003）：非冲突行一律 adopt-new（含从未逐条查看的补全行）；
        // 冲突行按用户内联选择；被「更改」的行携带暂存编辑值提交 adopt-edited。
        if (state.editedValue !== undefined) {
          return { ...base, decision: 'adopt-edited' as const, editedValue: state.editedValue };
        }
        return {
          ...base,
          decision: candidate.status === 'conflict'
            ? (state.conflictChoice ?? 'keep-current')
            : 'adopt-new' as const,
        };
      });
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

  const submitLabel = busy
    ? t('knowledgeCard.submitting')
    : failedCount > 0
      ? t('knowledgeCard.retryFailed', { count: activeCandidates.length })
      : t('knowledgeCard.confirmAll', { count: activeCandidates.length });
  const submitAll = () => { void submitDecisions(activeCandidates); };

  return (
    <section
      className={`overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] transition-opacity ${
        allSettled ? 'opacity-60' : ''
      }`}
      data-knowledge-batch-card={identity.workspaceId}
      data-settled={allSettled}
    >
      <div className={`flex items-start gap-2 border-[var(--line-subtle)] px-4 py-3 ${open ? 'border-b' : ''}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-1 py-1 text-left hover:bg-[var(--hover-bg)]"
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
                pendingFieldCount > 0
                  ? t('knowledgeCard.categorySummary', { fields: fieldRows.length, pending: pendingFieldCount })
                  : t('knowledgeCard.categorySummaryReady', { fields: fieldRows.length }),
                t('knowledgeCard.headerSuffix'),
              ].filter(Boolean).join(' · ')}
            </p>
          </div>
          {open
            ? <ChevronDown className="mt-1.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
            : <ChevronRight className="mt-1.5 h-4 w-4 shrink-0 text-[var(--ink-muted)]" />}
        </button>
      </div>

      {open && (
      <div className="space-y-2.5 px-4 py-3">
        {/* 候选正文限高内滚（GD 反馈）：卡片出现在输入区导入面板等不参与聊天
            滚动的容器里时，超长批次不能把内容推出窗口底边；头部确认按钮与
            底部影响说明固定在滚动区外，浏览全部候选始终可达。 */}
        <div
          data-knowledge-grid
          className="grid max-h-[60vh] auto-rows-min grid-cols-1 gap-3 overflow-y-auto pr-1 md:grid-cols-2"
        >
          {orderedRows.map((row) => (
            <FieldRow
              key={row.field}
              row={row}
              stateOf={stateOf}
              busy={busy}
              onConfirmRow={confirmRow}
              onChoose={chooseConflict}
              onStageEdits={stageEdits}
              onRetry={(targets) => { void submitDecisions(targets); }}
            />
          ))}
        </div>

        {submitError && (
          <p role="alert" className="rounded-lg bg-[var(--error-bg)] px-3 py-2 text-xs text-[var(--error)]">
            {submitError}
          </p>
        )}

        {unresolvedConflictCount > 0 && (
          <p className="text-xs text-[var(--warning)]">
            {t('knowledgeCard.unresolvedConflictHint', { count: unresolvedConflictCount })}
          </p>
        )}

        <p className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 text-xs text-[var(--ink-muted)]">
          <span className="font-medium text-[var(--ink-secondary)]">{t('knowledgeCard.impactLabel')}</span>
          {t('knowledgeCard.impactNote')}
        </p>
      </div>
      )}

      {/* 整卡确认固定页脚右下（闸门卡统一规范）：卡片折叠时页脚仍在，
          主操作不因收起候选列表而消失；确认后原位变成功态。 */}
      <div className="px-4 pb-3">
        <GateCardFooter>
          {allSettled ? (
            <GateCardSuccess>{t('knowledgeCard.allSettledNote')}</GateCardSuccess>
          ) : (
            <button
              type="button"
              data-knowledge-confirm-cta
              disabled={!canSubmit}
              onClick={submitAll}
              className="rounded-md bg-[var(--button-dark-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-dark-text)] disabled:opacity-50"
            >
              {submitLabel}
            </button>
          )}
        </GateCardFooter>
      </div>
    </section>
  );
}

interface FieldRowProps {
  row: KnowledgeFieldRow;
  stateOf: (candidate: KnowledgeCardCandidate) => CandidateState;
  busy: boolean;
  onConfirmRow: (row: KnowledgeFieldRow) => void;
  onChoose: (candidate: KnowledgeCardCandidate, choice: KnowledgeConflictChoice) => void;
  onStageEdits: (edits: CandidateEdit[]) => void;
  onRetry: (targets: KnowledgeCardCandidate[]) => void;
}

/** 候选值胶囊：胶囊承载字段值本身（已就绪列 muted、待确认列高亮），字段名在行头。 */
function ValuePill({
  text,
  muted,
  wrap = false,
}: {
  text: string;
  muted?: boolean;
  wrap?: boolean;
}) {
  return (
    <span
      title={text}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${
        wrap ? 'max-w-full' : 'max-w-[280px]'
      } ${
        muted
          ? 'border-[var(--line-subtle)] bg-[var(--paper-inset)] text-[var(--ink-muted)]'
          : 'border-[var(--line)] bg-[var(--paper)] text-[var(--ink)]'
      }`}
    >
      <span className={wrap ? 'whitespace-normal break-words' : 'truncate'}>{text}</span>
    </span>
  );
}

/**
 * 字段行：同字段多候选合并为一组；候选值以胶囊呈现，徽章与控件按分层默认
 * 派生到具体胶囊上（ADR 0003），摘录与置信度收进展开详情。
 */
function FieldRow({ row, stateOf, busy, onConfirmRow, onChoose, onStageEdits, onRetry }: FieldRowProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const fieldText = isEnterpriseProfileField(row.field)
    ? t(`knowledgeCard.fields.${row.field}`)
    : row.field;
  // ADR-0007 两层名单：潜在竞品并入竞品栏，仅当行内确有潜在候选时说明
  // 补位语义（纯直接层的竞品行不打扰）。
  const rowHasPotential = row.candidates.some(
    (candidate) => knowledgeFieldKeyOfPredicate(candidate.key.predicate) === 'potentialCompetitors',
  );
  const fieldNote = rowHasPotential
    ? t(`knowledgeCard.fieldNotes.potentialCompetitors`)
    : '';
  const active = row.candidates.filter(
    (candidate) => stateOf(candidate).outcome !== 'settled',
  );
  const isEdited = (candidate: KnowledgeCardCandidate) =>
    stateOf(candidate).editedValue !== undefined;
  const edited = active.filter(isEdited);
  const conflicts = active.filter(
    (candidate) => candidate.status === 'conflict' && !isEdited(candidate),
  );
  const awaitingConfirm = active.filter(
    (candidate) => candidateTier(candidate) === 'inferred'
      && !stateOf(candidate).confirmed
      && !isEdited(candidate),
  );
  const failed = active.filter((candidate) => stateOf(candidate).outcome === 'failed');
  // 失败行优先于分层徽章：需要重试的行不能显示绿色的「已就绪」。
  const tier = active.length === 0
    ? 'settled'
    : failed.length > 0
      ? 'failed'
      : edited.length === active.length
        ? 'user-edited'
        : conflicts.length > 0
          ? 'conflict'
          : awaitingConfirm.length > 0
            ? 'pending'
            : 'ready';
  // 类内状态摘要（与胶囊徽章同口径）：已就绪 = 材料原文/用户补充/视觉确认，
  // 待确认 = 推断未确认/冲突/失败。
  const pendingCount = active.filter((candidate) => {
    const state = stateOf(candidate);
    if (state.outcome === 'failed') return true;
    if (isEdited(candidate)) return false;
    if (candidate.status === 'conflict') return true;
    return candidateTier(candidate) === 'inferred' && !state.confirmed;
  }).length;
  const readyCount = active.length - pendingCount;
  /** 候选当前值（或已暂存编辑）→ 胶囊文本数组：数组值一值一胶囊。
   * ADR-0007：竞品行只显示名称，不再合并「地域｜业务」展示元数据。 */
  const candidateValueTexts = (candidate: KnowledgeCardCandidate) => {
    const state = stateOf(candidate);
    const raw = state.editedValue !== undefined
      ? JSON.stringify(state.editedValue)
      : candidate.normalizedValueJson;
    return displayValueTexts(raw, candidate.unit);
  };

  /** 候选生效值（含已暂存编辑）：✕ 剔除与空值说明共用同一口径。 */
  const effectiveValueOf = (candidate: KnowledgeCardCandidate) => {
    const state = stateOf(candidate);
    return state.editedValue !== undefined
      ? state.editedValue
      : candidateBaseValue(candidate);
  };

  /** 数组值逐项 ✕（ADR-0007）：剔除一项 = 暂存「数组减一」，随整卡确认以
   * adopt-edited 提交；胶囊文本与数组项一一对应，按索引定位。 */
  const removeArrayItem = (candidate: KnowledgeCardCandidate, index: number) => {
    const value = effectiveValueOf(candidate);
    if (!Array.isArray(value)) return;
    onStageEdits([{ candidate, value: value.filter((_, itemIndex) => itemIndex !== index) }]);
  };

  /** 空值数组候选（无锚跳过提示行 / 必审说明行）：胶囊区直接显示摘录文本
   * 作被动说明，不要求用户展开详情才能看到原因（ADR-0007 零主动询问）。 */
  const isEmptyArrayCandidate = (candidate: KnowledgeCardCandidate): boolean => {
    const value = effectiveValueOf(candidate);
    return Array.isArray(value) && value.length === 0;
  };

  const startEditing = () => {
    setDrafts(Object.fromEntries(
      active.map((candidate) => [candidate.id, editableTextOf(candidate, stateOf(candidate))]),
    ));
    setEditing(true);
  };

  const saveEdits = () => {
    // 只暂存实际改动的候选：未改动的输入保持原裁决路径（adopt-new/二选一），
    // 不把从未编辑过的值误标为用户补充来源。
    onStageEdits(active.flatMap((candidate) => {
      const value = parseEditedInput(drafts[candidate.id] ?? '', candidate);
      return JSON.stringify(value) === JSON.stringify(candidateBaseValue(candidate))
        ? []
        : [{ candidate, value }];
    }));
    setEditing(false);
  };

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
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="shrink-0 font-medium text-[var(--ink)]">{fieldText}</span>
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />}
        </button>
        {readyCount > 0 && (
          <span
            data-row-chip="ready"
            className="shrink-0 rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-xs text-[var(--success)]"
          >
            {t('knowledgeCard.rowReadyCount', { count: readyCount })}
          </span>
        )}
        {pendingCount > 0 && (
          <span
            data-row-chip="pending"
            className="shrink-0 rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-xs text-[var(--warning)]"
          >
            {t('knowledgeCard.rowPendingCount', { count: pendingCount })}
          </span>
        )}
        {active.length > 0 && (
          <button
            type="button"
            disabled={busy}
            aria-label={t('knowledgeCard.rowEditAria', { field: fieldText })}
            onClick={() => (editing ? setEditing(false) : startEditing())}
            className="rounded-md border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
          >
            {t('knowledgeCard.rowEdit')}
          </button>
        )}
      </div>

      {fieldNote && (
        <p
          data-field-note={row.field}
          className="mt-1 text-xs text-[var(--ink-subtle)]"
        >
          {fieldNote}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        {row.candidates.map((candidate, candidateIndex) => {
          const state = stateOf(candidate);
          // 两层竞品同栏陈列：首个潜在候选前插一个弱化「潜在」分界标签，
          // 让补位候选可辨认（行内排序保证直接层在前）。
          const isPotentialTier = knowledgeFieldKeyOfPredicate(candidate.key.predicate) === 'potentialCompetitors';
          const showPotentialDivider = isPotentialTier
            && !row.candidates.slice(0, candidateIndex).some(
              (earlier) => knowledgeFieldKeyOfPredicate(earlier.key.predicate) === 'potentialCompetitors',
            );
          const potentialDivider = showPotentialDivider ? (
            <span
              key={`${candidate.id}:potential-divider`}
              data-potential-divider
              className="text-xs text-[var(--ink-subtle)]"
            >
              {t('knowledgeCard.potentialDivider')}
            </span>
          ) : null;
          if (state.outcome === 'settled') {
            const status = state.settledStatus ?? '';
            const resultKey = `knowledgeCard.results.${status}`;
            const resultLabel = t(resultKey);
            return (
              <span key={candidate.id} className="inline-flex items-center gap-1.5">
                {potentialDivider}
                {candidateValueTexts(candidate).map((text, index) => (
                  <ValuePill
                    key={`${candidate.id}:${index}`}
                    text={text}
                    muted
                    wrap={isCompetitorTierField(row.field)}
                  />
                ))}
                <span
                  className="inline-flex items-center gap-1 text-[var(--ink-subtle)]"
                  data-candidate-result={candidate.id}
                >
                  <Check className="h-3 w-3 text-[var(--success)]" />
                  {resultLabel === resultKey ? status : resultLabel}
                </span>
              </span>
            );
          }
          const editedNow = isEdited(candidate);
          const conflict = candidate.status === 'conflict' && !editedNow;
          const isFailed = state.outcome === 'failed';
          const pendingBadge = candidateTier(candidate) === 'inferred'
            && !state.confirmed && !editedNow && !isFailed;
          const readyBadge = !editedNow && !isFailed && !conflict && !pendingBadge;
          return (
            <span
              key={candidate.id}
              className="inline-flex flex-wrap items-center gap-1.5"
              data-candidate-capsule={candidate.id}
            >
              {potentialDivider}
              {isFailed && (
                <span className="rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-xs text-[var(--error)]">
                  {t('knowledgeCard.badgeFailed')}
                </span>
              )}
              {readyBadge && (
                <span className="rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-xs text-[var(--success)]">
                  {t('knowledgeCard.badgeReady')}
                </span>
              )}
              {editedNow && (
                <span
                  className="rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-xs text-[var(--success)]"
                  data-candidate-user-edited={candidate.id}
                >
                  {t('knowledgeCard.badgeUserEdited')}
                </span>
              )}
              {pendingBadge && (
                <span
                  data-candidate-pending={candidate.id}
                  className="rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-xs text-[var(--warning)]"
                >
                  {t('knowledgeCard.badgePending')}
                </span>
              )}
              {conflict && (
                <span className="rounded-full bg-[var(--warning-bg)] px-2 py-0.5 text-xs text-[var(--warning)]">
                  {t('knowledgeCard.badgeConflict')}
                </span>
              )}
              {conflict && candidate.current && (
                <>
                  {displayValueTexts(
                    candidate.current.normalizedValueJson,
                    candidate.current.unit,
                  ).map((text, index) => (
                    <ValuePill key={`current:${candidate.id}:${index}`} text={text} muted />
                  ))}
                  <span aria-hidden className="text-[var(--ink-subtle)]">→</span>
                </>
              )}
              {isEmptyArrayCandidate(candidate) && (
                <span
                  className="text-[var(--ink-muted)]"
                  data-candidate-empty-note={candidate.id}
                >
                  {candidate.source.excerpt}
                </span>
              )}
              {candidateValueTexts(candidate).map((text, index) => {
                const sourceUrl = isCompetitorTierField(row.field)
                  ? competitorSourceLinks(candidate.source.excerpt).get(text)
                  : undefined;
                return (
                <span key={`${candidate.id}:${index}`} className="inline-flex items-center gap-0.5">
                  <ValuePill text={text} wrap={isCompetitorTierField(row.field)} />
                  {sourceUrl && (
                    <a
                      href={sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      data-competitor-source-link={text}
                      className="text-[10px] leading-none text-[var(--ink-subtle)] underline hover:text-[var(--ink)]"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {t('knowledgeCard.sourceLink')}
                    </a>
                  )}
                  {isArrayShapedCandidate(candidate) && !isFailed && !editing && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('knowledgeCard.removeValueAria', { value: text })}
                      data-remove-value={`${candidate.id}:${index}`}
                      onClick={() => removeArrayItem(candidate, index)}
                      className="rounded-full p-0.5 text-[var(--ink-subtle)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
                );
              })}
              {isFailed && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t('knowledgeCard.rowRetryAria', { field: fieldText })}
                  onClick={() => onRetry(failed)}
                  className="rounded-md border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-50"
                >
                  {t('knowledgeCard.rowRetry')}
                </button>
              )}
              {pendingBadge && (
                <button
                  type="button"
                  aria-label={t('knowledgeCard.rowConfirmAria', { field: fieldText })}
                  onClick={() => onConfirmRow(row)}
                  className="rounded-md border border-[var(--line)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
                >
                  {t('knowledgeCard.rowConfirm')}
                </button>
              )}
              {conflict && (
                <>
                  <ConflictChoiceButton
                    pressed={state.conflictChoice === 'adopt-new'}
                    text={t('knowledgeCard.adoptNew')}
                    ariaLabel={t('knowledgeCard.adoptNewAria', { field: fieldText })}
                    onClick={() => onChoose(candidate, 'adopt-new')}
                  />
                  <ConflictChoiceButton
                    pressed={state.conflictChoice === 'keep-current'}
                    text={t('knowledgeCard.keepCurrent')}
                    ariaLabel={t('knowledgeCard.keepCurrentAria', { field: fieldText })}
                    onClick={() => onChoose(candidate, 'keep-current')}
                  />
                </>
              )}
            </span>
          );
        })}
      </div>

      {editing && (
        <div className="mt-2 space-y-2 border-t border-[var(--line-subtle)] pt-2">
          {active.map((candidate) => (
            <div key={candidate.id} data-candidate-edit={candidate.id} className="space-y-1">
              {active.length > 1 && (
                <span className="text-[var(--ink-secondary)]">{candidate.key.subject}</span>
              )}
              <input
                type="text"
                value={drafts[candidate.id] ?? ''}
                aria-label={active.length > 1
                  ? `${candidate.key.subject} · ${fieldText}`
                  : fieldText}
                onChange={(event) => setDrafts((current) => ({
                  ...current,
                  [candidate.id]: event.target.value,
                }))}
                className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]"
              />
              {isArrayShapedCandidate(candidate) && (
                <p className="text-xs text-[var(--ink-subtle)]">
                  {t('knowledgeCard.editArrayHint')}
                </p>
              )}
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              aria-label={t('knowledgeCard.editSaveAria', { field: fieldText })}
              onClick={saveEdits}
              className="rounded-md bg-[var(--button-dark-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-dark-text)] disabled:opacity-50"
            >
              {t('knowledgeCard.editSave')}
            </button>
            <button
              type="button"
              aria-label={t('knowledgeCard.editCancelAria', { field: fieldText })}
              onClick={() => setEditing(false)}
              className="rounded-md border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]"
            >
              {t('knowledgeCard.editCancel')}
            </button>
          </div>
        </div>
      )}

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
                    {t('knowledgeCard.excerptLabel', { excerpt: '' })}
                    <ExcerptText text={candidate.source.excerpt} />
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
