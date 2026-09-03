import { BookOpenCheck, Loader2, RefreshCcw } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { loadBrandHistory } from "@/api/brandHistoryClient";
import type {
  BrandHistoryProjection,
  BrandKnowledgeHistoryFact,
} from "../../../shared/geo/brandHistory";
import { formatCompetitorFactValue } from '../../../shared/geo/competitorRoster';
import {
  canonicalEnterpriseProfileField,
  PROFILE_PREDICATE_PREFIX,
} from "../../../shared/geo/enterpriseProfile";
import { KNOWLEDGE_DECIDED_EVENT } from "./KnowledgeBatchCard";

interface Props {
  workspaceId: string;
  /** 会话内工具推进后的产物刷新信号（与其他阶段产物面板同款联动）。 */
  refreshKey?: number;
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

/**
 * 数组值逐项展示（竞品经明细格式化，普通数组按项拆分）；非数组与解析
 * 失败回落为单串。逐项徽章替代顿号长串：关键词/竞品列表动辄十几项，
 * 连排一行既难扫读也撑破卡片。
 */
function factValueEntries(
  fact: BrandKnowledgeHistoryFact,
  predicate: string,
): string[] | string {
  const { normalizedValueJson: raw, unit } = fact;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      Array.isArray(value)
      && value.every((item): item is string => typeof item === "string")
    ) {
      const isCompetitors = canonicalEnterpriseProfileField(
        predicate.startsWith(PROFILE_PREDICATE_PREFIX)
          ? predicate.slice(PROFILE_PREDICATE_PREFIX.length)
          : predicate,
      ) === "competitors";
      const items = isCompetitors
        ? formatCompetitorFactValue(
          value,
          fact.sources.map((source) => source.excerpt),
        )
        : value;
      return unit ? items.map((item) => `${item} ${unit}`) : items;
    }
    const rendered = typeof value === "string"
      ? value
      : JSON.stringify(value);
    return unit ? `${rendered} ${unit}` : rendered;
  } catch {
    return unit ? `${raw} ${unit}` : raw;
  }
}

/** predicate → 可读标签：企业 Profile 字段映射 i18n 字段名（大小写不敏感归一），其余保留原文。 */
function factPredicateLabel(predicate: string, t: TFunction): string {
  if (predicate.startsWith(PROFILE_PREDICATE_PREFIX)) {
    const canonical = canonicalEnterpriseProfileField(
      predicate.slice(PROFILE_PREDICATE_PREFIX.length),
    );
    if (canonical) return t(`knowledgeCard.fields.${canonical}`);
  }
  return predicate;
}

/** 徽章折叠阈值：超出部分收进「+N 更多」，展开查看全量。 */
const CHIP_PREVIEW_LIMIT = 8;

function FactItem({ fact }: { fact: BrandKnowledgeHistoryFact }) {
  const { t } = useTranslation('chat');
  const label = parseFactKey(fact.factKey);
  const [expanded, setExpanded] = useState(false);
  const value = factValueEntries(fact, label.predicate);
  const entries = Array.isArray(value) ? value : null;
  const hiddenCount = entries && !expanded
    ? Math.max(0, entries.length - CHIP_PREVIEW_LIMIT)
    : 0;
  return (
    <li className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-[var(--ink)]">
          {label.subject}
          {label.predicate ? ` / ${factPredicateLabel(label.predicate, t)}` : ""}
        </p>
        <span className="shrink-0 pt-0.5 text-xs text-[var(--ink-subtle)]">
          v{fact.factVersion} · {fact.sources.length} 份依据
        </span>
      </div>
      {entries === null ? (
        <p className="mt-1.5 break-words leading-5 text-[var(--ink-muted)]">{value}</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(expanded ? entries : entries.slice(0, CHIP_PREVIEW_LIMIT)).map((entry, index) => (
            <span
              key={`${index}:${entry}`}
              className="max-w-full break-words rounded-lg bg-[var(--paper-inset)] px-2 py-1 text-xs leading-4 text-[var(--ink)]"
            >
              {entry}
            </span>
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-lg border border-dashed border-[var(--line)] px-2 py-1 text-xs leading-4 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
            >
              +{hiddenCount} 更多
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * 「品牌知识」阶段展开体的权威知识投影：只显示聊天确认卡裁决后的当前
 * 事实。标题由阶段行表达，这里只承载数据体；随阶段展开挂载即加载，
 * 材料导入与知识确认仍只在聊天卡片上发起。
 */
export default memo(function XiaojingBrandKnowledgePanel({
  workspaceId,
  refreshKey = 0,
}: Props) {
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

  // 展开体挂载即取数；工具推进（refreshKey）后与其他阶段面板同步刷新。
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

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
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3"
      aria-label="品牌知识当前权威"
    >
      <div className="flex items-start gap-2">
        <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">当前权威事实</h3>
          <p className="mt-1 text-xs leading-4 text-[var(--ink-muted)]">
            材料导入与知识确认在聊天中的卡片上完成；只有用户裁决过的事实才会出现在这里。
          </p>
        </div>
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
        <div aria-live="polite" className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--paper-inset)] p-3 text-xs text-[var(--ink-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在读取品牌知识…
        </div>
      )}

      {error && (
        <div role="alert" className="mt-3 rounded-lg bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]">
          <p className="break-words">{error}</p>
          <button type="button" onClick={() => void refresh()} className="mt-2 font-medium underline">
            重试
          </button>
        </div>
      )}

      {!loading && !error && !latestVersion && (
        <div className="mt-3 rounded-lg border border-dashed border-[var(--line)] p-3 text-xs leading-5 text-[var(--ink-muted)]">
          暂无已确认知识。导入品牌材料后，在聊天里的确认卡片上裁决，确认结果会出现在这里。
        </div>
      )}

      {latestVersion && (
        <>
          <p className="mt-3 text-xs text-[var(--ink-subtle)]">
            知识版本 v{latestVersion.version} · {latestVersion.facts.length} 条事实 ·
            确认于 {new Date(latestVersion.createdAt).toLocaleString()}
          </p>
          <ul className="mt-2 space-y-2">
            {latestVersion.facts.map((fact) => (
              <FactItem key={`${fact.factKey}:${fact.factVersion}`} fact={fact} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
});
