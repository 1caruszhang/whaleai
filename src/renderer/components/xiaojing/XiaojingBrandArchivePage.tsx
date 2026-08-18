import {
  Archive,
  BookOpenCheck,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadBrandHistory } from "@/api/brandHistoryClient";
import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import type {
  BrandArtifactHistoryItem,
  BrandHistoryProjection,
  BrandHistoryReference,
  BrandKnowledgeHistoryFact,
  BrandKnowledgeHistoryVersion,
} from "../../../shared/geo/brandHistory";
import { canonicalEnterpriseProfileField } from "../../../shared/geo/enterpriseProfile";

interface Props {
  workspace: BrandWorkspace | null;
}

/** 产物 kind 的中文展示名；未知 kind 回退原始值，不伪造翻译。 */
const ARTIFACT_KIND_LABELS: Record<string, string> = {
  "question-pool": "问题池",
  baseline: "GEO 基线",
  "topic-plan": "选题计划",
  "approved-article": "已批准文章",
  "distribution-plan": "分发计划",
  "publish-execution": "发布执行",
  "monitor-plan": "监测计划",
};

/** 产物 status 的中文展示名；未知 status 回退原始值并以中性样式呈现。 */
const ARTIFACT_STATUS_LABELS: Record<string, string> = {
  approved: "已批准",
  confirmed: "已确认",
  succeeded: "已成功",
  partial: "部分成功",
};

const PROFILE_PREDICATE_PREFIX = "enterprise-profile.";

function referenceLabel(reference: BrandHistoryReference): string {
  return `${reference.kind} · ${reference.id}${
    reference.revision == null ? "" : ` · revision ${reference.revision}`
  }`;
}

function displayFactValue(raw: string, unit?: string | null): string {
  try {
    const value: unknown = JSON.parse(raw);
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${rendered}${unit ? ` ${unit}` : ""}`;
  } catch {
    return `${raw}${unit ? ` ${unit}` : ""}`;
  }
}

/** 血缘引用胶囊：chip 文本保持完整引用串（kind · id · revision N）。 */
function ReferenceChips({
  title,
  references,
}: {
  title: string;
  references: BrandHistoryReference[];
}) {
  if (references.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-[var(--ink-muted)]">{title}</span>
      {references.map((reference, index) => (
        <span
          key={`${reference.kind}:${reference.id}:${reference.revision ?? index}`}
          className="break-all rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-subtle)]"
        >
          {referenceLabel(reference)}
        </span>
      ))}
    </div>
  );
}

/** 单条档案字段：字段名走 knowledgeCard.fields 中文词表（与知识确认卡同源），
 *  非档案字段的 factKey 回退原文；来源证据以引文样式弱化为证。 */
function ArchiveFactRow({ fact }: { fact: BrandKnowledgeHistoryFact }) {
  const { t } = useTranslation("chat");
  const field = canonicalEnterpriseProfileField(
    fact.factKey.startsWith(PROFILE_PREDICATE_PREFIX)
      ? fact.factKey.slice(PROFILE_PREDICATE_PREFIX.length)
      : fact.factKey,
  );
  const label =
    field == null
      ? fact.factKey
      : t(`knowledgeCard.fields.${field}`, { defaultValue: fact.factKey });

  return (
    <div className="rounded-lg bg-[var(--paper-inset)] p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium text-[var(--ink-muted)]">{label}</p>
        <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
          fact v{fact.factVersion}
        </span>
      </div>
      <p className="mt-1 break-words text-sm font-medium">
        {displayFactValue(fact.normalizedValueJson, fact.unit)}
      </p>
      {fact.sources.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-[var(--ink-muted)]">来源证据</p>
          <ul className="mt-1 space-y-1">
            {fact.sources.map((source, index) => (
              <li
                key={`${source.materialId ?? source.origin}:${index}`}
                className="break-words border-l-2 border-[var(--line)] pl-2 text-xs leading-5 text-[var(--ink-subtle)]"
              >
                {source.origin}
                {source.materialId ? ` · ${source.materialId}` : ""}：
                {source.excerpt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 知识版本卡：最新版本默认展开，历史版本收起为摘要行，点击显式展开
 *  （DESIGN.md：长内容使用摘要和显式展开）。 */
function KnowledgeVersionCard({
  version,
  defaultOpen,
}: {
  version: BrandKnowledgeHistoryVersion;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <article className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-xl p-4 text-left hover:bg-[var(--paper-inset)]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        )}
        <span className="text-sm font-semibold">知识版本 v{version.version}</span>
        <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
          {version.facts.length} 条字段
        </span>
        <time className="ml-auto shrink-0 text-xs text-[var(--ink-subtle)]">
          {new Date(version.createdAt).toLocaleString()}
        </time>
      </button>
      {open && (
        <div className="border-t border-[var(--line)] p-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {version.facts.map((fact) => (
              <ArchiveFactRow
                key={`${fact.factKey}:${fact.factVersion}`}
                fact={fact}
              />
            ))}
          </div>
          <p className="mt-3 break-all text-xs leading-4 text-[var(--ink-subtle)]">
            批准 Session：{version.actorSessionId}
          </p>
          <ReferenceChips title="被以下产物使用" references={version.usedBy} />
        </div>
      )}
    </article>
  );
}

/** 产物卡：中文类型标题 + raw kind 徽章（排障） + 状态徽章；溯源标识
 *  降级为最小号次级信息，血缘引用以胶囊呈现。 */
function ArtifactCard({ artifact }: { artifact: BrandArtifactHistoryItem }) {
  const kindLabel = ARTIFACT_KIND_LABELS[artifact.kind] ?? artifact.kind;
  const statusLabel = ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status;
  const knownStatus = artifact.status in ARTIFACT_STATUS_LABELS;

  return (
    <article className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">{kindLabel}</p>
        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-subtle)]">
          {artifact.kind}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            knownStatus
              ? "bg-[var(--success-bg)] text-[var(--success)]"
              : "bg-[var(--paper-inset)] text-[var(--ink-subtle)]"
          }`}
        >
          {statusLabel}
        </span>
        <time className="ml-auto text-xs text-[var(--ink-subtle)]">
          {new Date(artifact.createdAt).toLocaleString()}
        </time>
      </div>
      <p className="mt-2 break-all text-xs text-[var(--ink-muted)]">
        {artifact.id}
        {artifact.revision == null ? "" : ` · revision ${artifact.revision}`}
      </p>
      <p className="mt-1 break-all text-xs leading-4 text-[var(--ink-subtle)]">
        Operation {artifact.operationId} · Session {artifact.sessionId}
        {artifact.knowledgeVersion == null
          ? ""
          : ` · 知识版本 v${artifact.knowledgeVersion}`}
      </p>
      <ReferenceChips title="来源" references={artifact.sourceRefs} />
      <ReferenceChips title="被以下产物使用" references={artifact.usedBy} />
    </article>
  );
}

/** 概览磁贴：只读统计，不承载动作。档案字段数取最新版本的 facts 数。 */
function ArchiveMetrics({
  knowledgeVersions,
  artifactCount,
}: {
  knowledgeVersions: BrandKnowledgeHistoryVersion[];
  artifactCount: number;
}) {
  const tiles = [
    { label: "知识版本", value: knowledgeVersions.length },
    { label: "最新档案字段", value: knowledgeVersions[0]?.facts.length ?? 0 },
    { label: "已批准产物", value: artifactCount },
  ];
  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3"
        >
          <p className="text-xl font-semibold tabular-nums leading-6">{tile.value}</p>
          <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{tile.label}</p>
        </div>
      ))}
    </div>
  );
}

/** 品牌档案整页的只读正文（含页头与刷新）：挂载即读取，跟随当前选中品牌
 *  随 key 重挂载。知识版本按 version 倒序返回，首个即最新。 */
function BrandArchiveBody({ workspace }: { workspace: BrandWorkspace }) {
  const [history, setHistory] = useState<BrandHistoryProjection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await loadBrandHistory(workspace.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [workspace.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isEmpty =
    history != null &&
    history.knowledgeVersions.length === 0 &&
    history.artifacts.length === 0;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
            <Archive className="h-5 w-5 text-[var(--accent)]" />
          </span>
          <div>
            <h1 className="text-xl font-semibold">品牌档案</h1>
            <p className="mt-0.5 text-sm text-[var(--ink-muted)]">
              当前品牌：{workspace.name}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-[var(--ink-muted)]">
              只读档案：仅展示已批准或已固化的知识版本与产物血缘，来源与使用关系来自
              BrandWorkspace 持久化记录。
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="刷新品牌档案"
          disabled={loading}
          onClick={() => void refresh()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </header>

      {loading && !history && (
        <div
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-sm text-[var(--ink-muted)]"
        >
          <Loader2 className="h-4 w-4 animate-spin" /> 正在读取品牌档案…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-[var(--line)] bg-[var(--error-bg)] p-4 text-sm text-[var(--error)]"
        >
          <p className="break-words">{error}</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 font-medium underline"
          >
            重试
          </button>
        </div>
      )}

      {isEmpty && (
        <div className="rounded-2xl border border-dashed border-[var(--line)] p-8 text-center">
          <BookOpenCheck className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
            暂无已批准的知识或产物。草稿和待确认版本不会出现在这里。
          </p>
        </div>
      )}

      {history && !isEmpty && (
        <>
          <ArchiveMetrics
            knowledgeVersions={history.knowledgeVersions}
            artifactCount={history.artifacts.length}
          />

          {history.knowledgeVersions.length > 0 && (
            <section aria-label="品牌知识版本">
              <div className="flex items-center gap-2">
                <BookOpenCheck className="h-4 w-4 text-[var(--success)]" />
                <h2 className="text-sm font-semibold">用户批准知识</h2>
              </div>
              <div className="mt-2 space-y-2">
                {history.knowledgeVersions.map((version, index) => (
                  <KnowledgeVersionCard
                    key={version.version}
                    version={version}
                    defaultOpen={index === 0}
                  />
                ))}
              </div>
            </section>
          )}

          {history.artifacts.length > 0 && (
            <section aria-label="已批准产物">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-[var(--accent)]" />
                <h2 className="text-sm font-semibold">已批准产物</h2>
              </div>
              <div className="mt-2 space-y-2">
                {history.artifacts.map((artifact) => (
                  <ArtifactCard
                    key={`${artifact.kind}:${artifact.id}:${artifact.revision ?? "none"}`}
                    artifact={artifact}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 「品牌档案」一级入口整页：品牌级只读投影，呈现知识版本史与已批准产物
 * 血缘。跟随当前选中品牌，不依赖任何 Session；除读取（刷新/重试）外不
 * 提供任何确认或动作入口。
 */
export default memo(function XiaojingBrandArchivePage({ workspace }: Props) {
  if (!workspace) {
    return (
      <main
        className="flex h-full items-center justify-center overflow-y-auto bg-[var(--paper)] px-8 py-12 text-[var(--ink)]"
        data-xiaojing-brand-archive="empty"
      >
        <div className="w-full max-w-xl rounded-2xl border border-dashed border-[var(--line)] p-8 text-center">
          <Archive className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <h1 className="mt-3 text-base font-semibold">品牌档案</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            先在左侧选择品牌，即可查看该品牌的知识版本史与已批准产物血缘。
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      className="h-full overflow-y-auto bg-[var(--paper)] px-8 py-10 text-[var(--ink)]"
      data-xiaojing-brand-archive={workspace.id}
    >
      <div className="mx-auto w-full max-w-4xl">
        <BrandArchiveBody key={workspace.id} workspace={workspace} />
      </div>
    </main>
  );
});
