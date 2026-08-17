import {
  Archive,
  BookOpenCheck,
  GitBranch,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { loadBrandHistory } from "@/api/brandHistoryClient";
import type { BrandWorkspace } from "@/api/brandWorkspaceClient";
import type {
  BrandHistoryProjection,
  BrandHistoryReference,
} from "../../../shared/geo/brandHistory";

interface Props {
  workspace: BrandWorkspace | null;
}

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

function References({
  title,
  references,
}: {
  title: string;
  references: BrandHistoryReference[];
}) {
  if (references.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-medium text-[var(--ink-muted)]">{title}</p>
      <ul className="mt-1 space-y-1 text-xs text-[var(--ink-subtle)]">
        {references.map((reference, index) => (
          <li
            key={`${reference.kind}:${reference.id}:${reference.revision ?? index}`}
            className="break-all"
          >
            {referenceLabel(reference)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 品牌档案整页的只读正文：挂载即读取，跟随当前选中品牌随 key 重挂载。 */
function BrandArchiveBody({ workspaceId }: { workspaceId: string }) {
  const [history, setHistory] = useState<BrandHistoryProjection | null>(null);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs leading-5 text-[var(--ink-muted)]">
          来源与使用关系来自 BrandWorkspace 持久化记录。
        </p>
        <button
          type="button"
          aria-label="刷新品牌档案"
          disabled={loading}
          onClick={() => void refresh()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] disabled:opacity-50"
        >
          <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

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

      {history &&
        history.knowledgeVersions.length === 0 &&
        history.artifacts.length === 0 && (
          <div className="rounded-xl border border-dashed border-[var(--line)] p-4 text-sm leading-6 text-[var(--ink-muted)]">
            暂无已批准的知识或产物。草稿和待确认版本不会出现在这里。
          </div>
        )}

      {history && history.knowledgeVersions.length > 0 && (
        <section aria-label="品牌知识版本">
          <div className="flex items-center gap-2">
            <BookOpenCheck className="h-4 w-4 text-[var(--success)]" />
            <h2 className="text-sm font-semibold">用户批准知识</h2>
          </div>
          <div className="mt-2 space-y-2">
            {history.knowledgeVersions.map((version) => (
              <article
                key={version.version}
                className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <p className="text-sm font-semibold">知识版本 v{version.version}</p>
                  <time className="text-[var(--ink-subtle)]">
                    {new Date(version.createdAt).toLocaleString()}
                  </time>
                </div>
                <p className="mt-1 break-all text-[var(--ink-subtle)]">
                  批准 Session：{version.actorSessionId}
                </p>
                <ul className="mt-2 space-y-2">
                  {version.facts.map((fact) => (
                    <li
                      key={`${fact.factKey}:${fact.factVersion}`}
                      className="rounded-lg bg-[var(--paper-inset)] p-3"
                    >
                      <p className="break-words font-medium">
                        {fact.factKey} · fact v{fact.factVersion}
                      </p>
                      <p className="mt-1 break-words text-[var(--ink-muted)]">
                        {displayFactValue(fact.normalizedValueJson, fact.unit)}
                      </p>
                      {fact.sources.length > 0 && (
                        <div className="mt-2">
                          <p className="font-medium text-[var(--ink-muted)]">来源证据</p>
                          <ul className="mt-1 space-y-1 text-[var(--ink-subtle)]">
                            {fact.sources.map((source, index) => (
                              <li
                                key={`${source.materialId ?? source.origin}:${index}`}
                                className="break-words"
                              >
                                {source.origin}
                                {source.materialId ? ` · ${source.materialId}` : ""}：
                                {source.excerpt}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <References title="被以下产物使用" references={version.usedBy} />
              </article>
            ))}
          </div>
        </section>
      )}

      {history && history.artifacts.length > 0 && (
        <section aria-label="已批准产物">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold">已批准产物</h2>
          </div>
          <div className="mt-2 space-y-2">
            {history.artifacts.map((artifact) => (
              <article
                key={`${artifact.kind}:${artifact.id}:${artifact.revision ?? "none"}`}
                className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-1">
                  <p className="break-words text-sm font-semibold">{artifact.kind}</p>
                  <span className="text-[var(--success)]">{artifact.status}</span>
                </div>
                <p className="mt-1 break-all text-[var(--ink-muted)]">
                  {artifact.id}
                  {artifact.revision == null ? "" : ` · revision ${artifact.revision}`}
                </p>
                <p className="mt-1 break-all text-[var(--ink-subtle)]">
                  Operation {artifact.operationId} · Session {artifact.sessionId}
                </p>
                <References title="来源" references={artifact.sourceRefs} />
                <References title="被以下产物使用" references={artifact.usedBy} />
              </article>
            ))}
          </div>
        </section>
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
        <header>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
              <Archive className="h-5 w-5 text-[var(--accent)]" />
            </span>
            <div>
              <h1 className="text-xl font-semibold">品牌档案</h1>
              <p className="mt-0.5 text-sm text-[var(--ink-muted)]">
                当前品牌：{workspace.name}
              </p>
            </div>
          </div>
          <p className="mt-3 text-xs leading-5 text-[var(--ink-muted)]">
            只读档案：仅展示用户已批准或已经固化的知识版本与产物血缘。
          </p>
        </header>

        <BrandArchiveBody key={workspace.id} workspaceId={workspace.id} />
      </div>
    </main>
  );
});
