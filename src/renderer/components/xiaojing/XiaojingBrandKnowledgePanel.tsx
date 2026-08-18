import {
  BookOpenCheck,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { loadBrandHistory } from "@/api/brandHistoryClient";
import type {
  BrandHistoryProjection,
  BrandKnowledgeHistoryFact,
} from "../../../shared/geo/brandHistory";
import { KNOWLEDGE_DECIDED_EVENT } from "./KnowledgeBatchCard";

interface Props {
  workspaceId: string;
}

interface FactLabel {
  subject: string;
  predicate: string;
}

/** factKey 是 canonical JSON identity；解析出可读的 subject/predicate 展示。 */
function parseFactKey(factKey: string): FactLabel {
  try {
    const parsed = JSON.parse(factKey) as {
      subject?: unknown;
      predicate?: unknown;
    };
    if (typeof parsed.subject === "string" && typeof parsed.predicate === "string") {
      return { subject: parsed.subject, predicate: parsed.predicate };
    }
  } catch {
    // 非 JSON 键保持原文截断展示。
  }
  return { subject: factKey.slice(0, 80), predicate: "" };
}

function displayFactValue(raw: string, unit?: string | null): string {
  try {
    const value: unknown = JSON.parse(raw);
    const rendered = typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.join("、")
        : JSON.stringify(value);
    return unit ? `${rendered} ${unit}` : rendered;
  } catch {
    return unit ? `${raw} ${unit}` : raw;
  }
}

function FactItem({ fact }: { fact: BrandKnowledgeHistoryFact }) {
  const label = parseFactKey(fact.factKey);
  return (
    <li className="rounded-md bg-[var(--paper-elevated)] p-2">
      <p className="break-words font-medium text-[var(--ink)]">
        {label.subject}
        {label.predicate ? ` / ${label.predicate}` : ""}
      </p>
      <p className="mt-1 break-words text-[var(--ink-muted)]">
        {displayFactValue(fact.normalizedValueJson, fact.unit)}
      </p>
      <p className="mt-1 text-[var(--ink-subtle)]">
        fact v{fact.factVersion} · {fact.sources.length} 份依据
      </p>
    </li>
  );
}

/** 右侧工作台的权威知识投影：只显示聊天确认卡裁决后的当前事实。 */
export default memo(function XiaojingBrandKnowledgePanel({ workspaceId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<BrandHistoryProjection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await loadBrandHistory(workspaceId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  const toggle = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      if (next && !history && !loading) void refresh();
      return next;
    });
  }, [history, loading, refresh]);

  // 任意确认卡（批量或单条）裁决成功后立即刷新权威投影。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      void refresh();
    };
    window.addEventListener(KNOWLEDGE_DECIDED_EVENT, handler);
    return () => window.removeEventListener(KNOWLEDGE_DECIDED_EVENT, handler);
  }, [refresh, workspaceId]);

  const latestVersion = history?.knowledgeVersions.reduce<typeof history.knowledgeVersions[number] | null>(
    (latest, version) => (!latest || version.version > latest.version ? version : latest),
    null,
  ) ?? null;

  return (
    <section
      className="mt-4 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]"
      aria-label="品牌知识当前权威"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 p-3 text-left"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <BookOpenCheck className="h-4 w-4 shrink-0 text-[var(--success)]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">品牌知识</span>
          <span className="mt-0.5 block text-xs text-[var(--ink-muted)]">
            {latestVersion
              ? `当前权威事实 · 知识版本 v${latestVersion.version}`
              : "在聊天确认卡片里裁决后显示"}
          </span>
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[var(--ink-subtle)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--ink-subtle)]" />
        )}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-[var(--line-subtle)] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs leading-5 text-[var(--ink-muted)]">
              只有用户在确认卡片裁决过的事实才会出现在这里。
            </p>
            <button
              type="button"
              aria-label="刷新品牌知识"
              disabled={loading}
              onClick={() => void refresh()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>

          {loading && !history && (
            <div aria-live="polite" className="flex items-center gap-2 rounded-lg bg-[var(--paper-inset)] p-3 text-xs text-[var(--ink-muted)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取品牌知识…
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-lg bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]">
              <p className="break-words">{error}</p>
              <button type="button" onClick={() => void refresh()} className="mt-2 font-medium underline">
                重试
              </button>
            </div>
          )}

          {!loading && !error && !latestVersion && (
            <div className="rounded-lg border border-dashed border-[var(--line)] p-3 text-xs leading-5 text-[var(--ink-muted)]">
              暂无已确认知识。导入品牌材料后，在聊天里的确认卡片上裁决，确认结果会出现在这里。
            </div>
          )}

          {latestVersion && (
            <>
              <p className="text-xs text-[var(--ink-subtle)]">
                v{latestVersion.version} · {latestVersion.facts.length} 条事实 ·
                确认于 {new Date(latestVersion.createdAt).toLocaleString()}
              </p>
              <ul className="space-y-2">
                {latestVersion.facts.map((fact) => (
                  <FactItem key={`${fact.factKey}:${fact.factVersion}`} fact={fact} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
});
