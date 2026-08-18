import { Check, GitBranch, ShieldCheck, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useTabApi } from '@/context/TabContext';
import { unwrapToolResultText } from '../../../shared/toolResult';
import { KNOWLEDGE_DECIDED_EVENT } from './KnowledgeBatchCard';

type Decision = 'keep-current' | 'adopt-new' | 'split-scope' | 'reject-candidate';

export interface KnowledgeConflictCardData {
  kind: 'knowledge-conflict-card';
  requiresUserDecision: true;
  candidate: {
    id: string;
    workspaceId: string;
    sessionId: string;
    key: {
      subject: string;
      predicate: string;
      scopeJson: string;
      effectiveFrom?: string | null;
      effectiveTo?: string | null;
    };
    normalizedValueJson: string;
    unit?: string | null;
    status: 'awaiting-confirmation' | 'conflict';
    baseVersion: number;
    current?: {
      normalizedValueJson: string;
      unit?: string | null;
      version: number;
      confirmedBy: string;
      confirmedAt: string;
    } | null;
    source: { materialId?: string | null; excerpt: string; confidence: number };
  };
}

export function parseKnowledgeConflictCard(result: string): KnowledgeConflictCardData | null {
  try {
    // MCP 结果是 content blocks 包装（`[{type:'text',text:...}]`），先剥壳。
    const parsed = JSON.parse(unwrapToolResultText(result)) as KnowledgeConflictCardData;
    if (parsed.kind === 'knowledge-conflict-card'
      && parsed.requiresUserDecision === true
      && typeof parsed.candidate?.id === 'string'
      && typeof parsed.candidate?.workspaceId === 'string'
      && typeof parsed.candidate?.sessionId === 'string') return parsed;
  } catch {
    // Unknown tool results continue through the generic renderer.
  }
  return null;
}

function displayValue(valueJson: string, unit?: string | null): string {
  let value = valueJson;
  try {
    const parsed = JSON.parse(valueJson);
    value = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    // Keep the stored standardized JSON text visible if it is unreadable.
  }
  return unit ? `${value} ${unit}` : value;
}

function parseScope(text: string): Record<string, string | number | boolean | null> {
  const parsed = JSON.parse(text || '{}') as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('范围必须是 JSON 对象');
  }
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('范围值只能是字符串、数字、布尔值或 null');
    }
  }
  return parsed as Record<string, string | number | boolean | null>;
}

export default function KnowledgeConflictCard({ data }: { data: KnowledgeConflictCardData }) {
  const { apiPost } = useTabApi();
  const { candidate } = data;
  const [busy, setBusy] = useState<Decision | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  const [scopeJson, setScopeJson] = useState(candidate.key.scopeJson || '{}');
  const [effectiveFrom, setEffectiveFrom] = useState(candidate.key.effectiveFrom ?? '');
  const [effectiveTo, setEffectiveTo] = useState(candidate.key.effectiveTo ?? '');
  const expectedVersion = candidate.current?.version ?? candidate.baseVersion;
  const confidence = useMemo(() => `${Math.round(candidate.source.confidence * 100)}%`, [candidate.source.confidence]);

  const submit = async (decision: Decision) => {
    if (busy || resolved) return;
    setBusy(decision);
    setError(null);
    try {
      const splitKey = decision === 'split-scope' ? {
        subject: candidate.key.subject,
        predicate: candidate.key.predicate,
        scope: parseScope(scopeJson),
        effectiveFrom: effectiveFrom || null,
        effectiveTo: effectiveTo || null,
      } : undefined;
      const response = await apiPost<{ success: boolean; error?: string; result?: { status: string } }>(
        '/api/xiaojing/knowledge/decide',
        {
          workspaceId: candidate.workspaceId,
          sessionId: candidate.sessionId,
          candidateId: candidate.id,
          decision,
          expectedCurrentVersion: expectedVersion,
          splitKey,
        },
      );
      if (!response.success) throw new Error(response.error ?? '知识裁决失败');
      setResolved(response.result?.status ?? decision);
      setShowSplit(false);
      window.dispatchEvent(new CustomEvent(KNOWLEDGE_DECIDED_EVENT, {
        detail: { workspaceId: candidate.workspaceId },
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]" data-knowledge-conflict-card={candidate.id}>
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2.5">
        <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-sm font-semibold">品牌事实待确认</span>
        <span className="ml-auto rounded-full bg-[var(--accent-warm-subtle)] px-2 py-0.5 text-xs text-[var(--accent)]">
          {candidate.status === 'conflict' ? '检测到冲突' : '新增建议'}
        </span>
      </div>
      <div className="space-y-3 p-3 text-xs">
        <div className="text-[var(--ink-muted)]">
          <span className="font-medium text-[var(--ink)]">{candidate.key.subject}</span>
          <span className="mx-1.5">/</span>{candidate.key.predicate}
        </div>
        {candidate.current && (
          <div className="rounded-lg bg-[var(--paper-inset)] p-2.5">
            <div className="text-[var(--ink-subtle)]">当前权威值 · v{candidate.current.version}</div>
            <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--ink)]">{displayValue(candidate.current.normalizedValueJson, candidate.current.unit)}</div>
          </div>
        )}
        <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--accent-warm-subtle)] p-2.5">
          <div className="text-[var(--ink-muted)]">候选值 · 置信度 {confidence}</div>
          <div className="mt-1 whitespace-pre-wrap text-sm font-medium text-[var(--ink)]">{displayValue(candidate.normalizedValueJson, candidate.unit)}</div>
          <blockquote className="mt-2 border-l-2 border-[var(--accent)]/40 pl-2 text-[var(--ink-muted)]">{candidate.source.excerpt}</blockquote>
        </div>

        {showSplit && (
          <div className="space-y-2 rounded-lg border border-[var(--line)] p-2.5">
            <label className="block text-[var(--ink-muted)]">新范围（JSON 对象）
              <textarea value={scopeJson} onChange={(event) => setScopeJson(event.target.value)} rows={2}
                className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 font-mono text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[var(--ink-muted)]">生效开始
                <input value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} placeholder="YYYY-MM-DD"
                  className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
              </label>
              <label className="text-[var(--ink-muted)]">生效结束
                <input value={effectiveTo} onChange={(event) => setEffectiveTo(event.target.value)} placeholder="可留空"
                  className="mt-1 w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
              </label>
            </div>
            <button type="button" disabled={busy !== null} onClick={() => { void submit('split-scope'); }}
              className="rounded-md bg-[var(--button-dark-bg)] px-2.5 py-1.5 text-[var(--button-dark-text)] disabled:opacity-50">
              确认拆分范围
            </button>
          </div>
        )}

        {resolved ? (
          <div className="flex items-center gap-1.5 text-[var(--success)]"><Check className="h-3.5 w-3.5" />裁决已提交并记录审计：{resolved}</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!candidate.current || busy !== null} onClick={() => { void submit('keep-current'); }} className="rounded-md border border-[var(--line)] px-2 py-1.5 disabled:opacity-40">保留当前值</button>
            <button type="button" disabled={busy !== null} onClick={() => { void submit('adopt-new'); }} className="rounded-md bg-[var(--button-dark-bg)] px-2 py-1.5 text-[var(--button-dark-text)] disabled:opacity-50">采用新值</button>
            <button type="button" disabled={busy !== null} onClick={() => setShowSplit((value) => !value)} className="flex items-center justify-center gap-1 rounded-md border border-[var(--line)] px-2 py-1.5 disabled:opacity-50"><GitBranch className="h-3.5 w-3.5" />拆分范围</button>
            <button type="button" disabled={busy !== null} onClick={() => { void submit('reject-candidate'); }} className="flex items-center justify-center gap-1 rounded-md border border-[var(--line)] px-2 py-1.5 text-[var(--error)] disabled:opacity-50"><X className="h-3.5 w-3.5" />拒绝候选</button>
          </div>
        )}
        {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
      </div>
    </section>
  );
}
