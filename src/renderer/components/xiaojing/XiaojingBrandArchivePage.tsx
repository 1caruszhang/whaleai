import {
  Archive,
  BookOpenCheck,
  ChevronDown,
  ChevronRight,
  GitBranch,
  History,
  Loader2,
  Quote,
  RefreshCcw,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
import type { EnterpriseProfileField } from "../../../shared/geo/enterpriseProfile";
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

/**
 * 「当前档案」看板的语义 widget 分格：13 类 Profile 字段按关注点聚合，
 * 每格一个 mono 微标签锚点；非 Profile 字段落入「其他事实」兜底格。
 */
interface ProfileWidgetDef {
  id: string;
  zh: string;
  code: string;
  fields: EnterpriseProfileField[];
}

const PROFILE_WIDGETS: ProfileWidgetDef[] = [
  {
    id: "identity",
    zh: "品牌身份",
    code: "BRAND IDENTITY // PROFILE",
    fields: ["fullName", "shortNames", "industry", "serviceArea"],
  },
  {
    id: "contact",
    zh: "联系与地址",
    code: "CONTACT // ADDRESSES",
    fields: ["contactInfo", "addresses"],
  },
  {
    id: "products",
    zh: "产品矩阵",
    code: "PRODUCTS // MATRIX",
    fields: ["products"],
  },
  {
    id: "advantages",
    zh: "核心优势",
    code: "ADVANTAGES // EDGE",
    fields: ["coreAdvantages"],
  },
  {
    id: "audience",
    zh: "目标客户与痛点",
    code: "AUDIENCE // PAIN POINTS",
    fields: ["targetCustomers", "customerPainPoints"],
  },
  {
    id: "competitive",
    zh: "竞品与关联品牌",
    code: "COMPETITIVE // LANDSCAPE",
    fields: ["competitors", "relatedBrands"],
  },
  {
    id: "cases",
    zh: "客户案例",
    code: "CASES // PROOF",
    fields: ["customerCases"],
  },
  {
    id: "trust",
    zh: "信任背书",
    code: "TRUST // ENDORSEMENTS",
    fields: ["trustEndorsements"],
  },
  {
    id: "keywords",
    zh: "衍生关键词",
    code: "KEYWORDS // DERIVED",
    fields: ["derivedKeywords"],
  },
];

function profileFieldOf(factKey: string): EnterpriseProfileField | null {
  return canonicalEnterpriseProfileField(
    factKey.startsWith(PROFILE_PREDICATE_PREFIX)
      ? factKey.slice(PROFILE_PREDICATE_PREFIX.length)
      : factKey,
  );
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
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-[var(--ink-muted)]">{title}</span>
      {references.map((reference, index) => (
        <span
          key={`${reference.kind}:${reference.id}:${reference.revision ?? index}`}
          className="break-all rounded-full bg-[var(--paper-inset)] px-2 py-0.5 font-mono text-xs text-[var(--ink-subtle)]"
        >
          {referenceLabel(reference)}
        </span>
      ))}
    </div>
  );
}

/** 字段值是主角：JSON 数组渲染为胶囊集，标量渲染为正文文本。 */
function FactValue({ fact }: { fact: BrandKnowledgeHistoryFact }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fact.normalizedValueJson);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) {
    const items = parsed.map((item) =>
      typeof item === "string" ? item : JSON.stringify(item),
    );
    if (items.length === 0) {
      return <p className="text-sm text-[var(--ink-subtle)]">—</p>;
    }
    return (
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item, index) => (
          <li
            key={`${item}:${index}`}
            className="rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-2 py-0.5 text-xs"
          >
            {item}
            {fact.unit ? ` ${fact.unit}` : ""}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="break-words text-sm font-medium">
      {displayFactValue(fact.normalizedValueJson, fact.unit)}
    </p>
  );
}

/**
 * 语义 widget 卡：mono 微标签 + 中文标题，字段值为唯一主角；「来源证据」
 * 默认不渲染，由卡片角落的入口显式展开（弱化为证）。
 */
function ProfileWidget({
  def,
  facts,
  labelOf,
}: {
  def: ProfileWidgetDef;
  facts: BrandKnowledgeHistoryFact[];
  labelOf: (factKey: string) => string;
}) {
  const [showSources, setShowSources] = useState(false);
  const sourcedFacts = facts.filter((fact) => fact.sources.length > 0);
  const sourceCount = sourcedFacts.reduce(
    (count, fact) => count + fact.sources.length,
    0,
  );

  return (
    <section
      aria-label={def.zh}
      className="ba-grid-texture rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="ba-micro-label truncate">{def.code}</p>
          <h3 className="mt-1 text-sm font-semibold">{def.zh}</h3>
        </div>
        {sourceCount > 0 && (
          <button
            type="button"
            aria-expanded={showSources}
            onClick={() => setShowSources((value) => !value)}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--line-subtle)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          >
            <Quote className="h-3 w-3" />
            证据 {sourceCount}
          </button>
        )}
      </div>
      <dl className="mt-3 space-y-3">
        {facts.map((fact) => (
          <div key={`${fact.factKey}:${fact.factVersion}`}>
            <dt className="text-xs text-[var(--ink-muted)]">
              {labelOf(fact.factKey)}
            </dt>
            <dd className="mt-1">
              <FactValue fact={fact} />
            </dd>
          </div>
        ))}
      </dl>
      {showSources && (
        <div className="mt-3 border-t border-[var(--line-subtle)] pt-3">
          <p className="text-xs font-medium text-[var(--ink-muted)]">来源证据</p>
          <ul className="mt-1 space-y-1">
            {sourcedFacts.flatMap((fact) =>
              fact.sources.map((source, index) => (
                <li
                  key={`${fact.factKey}:${source.materialId ?? source.origin}:${index}`}
                  className="break-words border-l-2 border-[var(--line)] pl-2 text-xs leading-5 text-[var(--ink-subtle)]"
                >
                  {labelOf(fact.factKey)} · {source.origin}
                  {source.materialId ? ` · ${source.materialId}` : ""}：
                  {source.excerpt}
                </li>
              )),
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

/** 第一层头部：当前品牌 + 关键计数（tabular-nums 大数字 + accent 状态点）。 */
function CurrentArchiveHero({
  workspace,
  latest,
  versionCount,
  artifactCount,
}: {
  workspace: BrandWorkspace;
  latest: BrandKnowledgeHistoryVersion | null;
  versionCount: number;
  artifactCount: number;
}) {
  const tiles = [
    { code: "FIELDS", label: "档案字段", value: latest?.facts.length ?? 0 },
    { code: "VERSIONS", label: "知识版本", value: versionCount },
    { code: "ARTIFACTS", label: "已批准产物", value: artifactCount },
  ];
  return (
    <div className="ba-grid-texture rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="ba-micro-label">BRAND ARCHIVE // CURRENT PROFILE</p>
          <div className="mt-2 flex items-center gap-2">
            <span
              aria-hidden
              className="ba-status-dot"
              data-tone={latest ? "success" : "muted"}
            />
            <h2 className="truncate text-2xl font-semibold">{workspace.name}</h2>
          </div>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">
            {latest
              ? `已确认 · 知识版本 v${latest.version} · ${new Date(latest.createdAt).toLocaleString()}`
              : "暂无已确认知识版本"}
          </p>
        </div>
        <dl className="flex shrink-0 gap-6">
          {tiles.map((tile) => (
            <div key={tile.code}>
              <dt className="ba-micro-label">
                {tile.code} · {tile.label}
              </dt>
              <dd className="mt-1 font-mono text-3xl tabular-nums leading-8">
                {tile.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

interface FactDiff {
  added: BrandKnowledgeHistoryFact[];
  removed: BrandKnowledgeHistoryFact[];
  changed: {
    before: BrandKnowledgeHistoryFact;
    after: BrandKnowledgeHistoryFact;
  }[];
}

/** 相邻版本 diff：按 factKey 对齐，比较 normalizedValueJson，纯前端计算。 */
function diffVersionFacts(
  current: BrandKnowledgeHistoryFact[],
  previous: BrandKnowledgeHistoryFact[] | null,
): FactDiff {
  const previousByKey = new Map(
    (previous ?? []).map((fact) => [fact.factKey, fact]),
  );
  const currentKeys = new Set(current.map((fact) => fact.factKey));
  const added = current.filter((fact) => !previousByKey.has(fact.factKey));
  const removed = (previous ?? []).filter((fact) => !currentKeys.has(fact.factKey));
  const changed: FactDiff["changed"] = [];
  for (const after of current) {
    const before = previousByKey.get(after.factKey);
    if (before != null && before.normalizedValueJson !== after.normalizedValueJson) {
      changed.push({ before, after });
    }
  }
  return { added, removed, changed };
}

function diffSummary(diff: FactDiff): string {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`新增 ${diff.added.length}`);
  if (diff.removed.length > 0) parts.push(`移除 ${diff.removed.length}`);
  if (diff.changed.length > 0) parts.push(`变更 ${diff.changed.length}`);
  return parts.length > 0 ? parts.join(" · ") : "无字段变化";
}

/**
 * 版本历史行：版本号 + 时间 + 与上一版的 diff 摘要；点击展开只看 diff
 * 详情（新增/移除/变更），不全量重复字段。
 */
function VersionHistoryRow({
  version,
  previous,
  labelOf,
}: {
  version: BrandKnowledgeHistoryVersion;
  previous: BrandKnowledgeHistoryVersion | null;
  labelOf: (factKey: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const diff = useMemo(
    () => diffVersionFacts(version.facts, previous?.facts ?? null),
    [version, previous],
  );

  return (
    <article className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-elevated)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg p-3 text-left hover:bg-[var(--paper-inset)]"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        )}
        <span className="shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 font-mono text-xs tabular-nums">
          v{version.version}
        </span>
        <time className="shrink-0 text-xs text-[var(--ink-subtle)]">
          {new Date(version.createdAt).toLocaleString()}
        </time>
        <span className="ml-auto shrink-0 text-xs text-[var(--ink-muted)]">
          {diffSummary(diff)}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-[var(--line-subtle)] p-3">
          {diff.added.length === 0 &&
            diff.removed.length === 0 &&
            diff.changed.length === 0 && (
              <p className="text-xs text-[var(--ink-subtle)]">
                与上一版相比无字段变化（来源合并或快照重存）。
              </p>
            )}
          {diff.added.map((fact) => (
            <div key={`added:${fact.factKey}`} className="flex items-baseline gap-2 text-xs">
              <span aria-hidden className="ba-status-dot" data-tone="success" />
              <span className="shrink-0 text-[var(--ink-muted)]">
                新增 {labelOf(fact.factKey)}
              </span>
              <span className="break-words">
                {displayFactValue(fact.normalizedValueJson, fact.unit)}
              </span>
            </div>
          ))}
          {diff.removed.map((fact) => (
            <div key={`removed:${fact.factKey}`} className="flex items-baseline gap-2 text-xs">
              <span aria-hidden className="ba-status-dot" data-tone="muted" />
              <span className="shrink-0 text-[var(--ink-muted)]">
                移除 {labelOf(fact.factKey)}
              </span>
              <span className="break-words line-through decoration-[var(--ink-subtle)]">
                {displayFactValue(fact.normalizedValueJson, fact.unit)}
              </span>
            </div>
          ))}
          {diff.changed.map(({ before, after }) => (
            <div key={`changed:${after.factKey}`} className="flex items-baseline gap-2 text-xs">
              <span aria-hidden className="ba-status-dot" />
              <span className="shrink-0 text-[var(--ink-muted)]">
                变更 {labelOf(after.factKey)}
              </span>
              <span className="break-words">
                {displayFactValue(before.normalizedValueJson, before.unit)}
                {" → "}
                {displayFactValue(after.normalizedValueJson, after.unit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

/** 第二层「版本历史」：默认收起的台账区域，展开后每版一行摘要。 */
function VersionHistorySection({
  versions,
  labelOf,
}: {
  versions: BrandKnowledgeHistoryVersion[];
  labelOf: (factKey: string) => string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section
      aria-label="版本历史"
      className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xs"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-xl p-4 text-left hover:bg-[var(--paper-inset)]"
      >
        <History className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
        <span className="min-w-0">
          <span className="ba-micro-label block truncate">
            VERSION HISTORY // LEDGER
          </span>
          <span className="mt-0.5 block text-sm font-semibold">版本历史</span>
        </span>
        <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-[var(--ink-muted)]">
          {versions.length} 版
        </span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--ink-subtle)]" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-[var(--line-subtle)] p-3">
          {versions.map((version, index) => (
            <VersionHistoryRow
              key={version.version}
              version={version}
              previous={versions[index + 1] ?? null}
              labelOf={labelOf}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function artifactStatusOf(artifact: BrandArtifactHistoryItem): {
  label: string;
  known: boolean;
} {
  return {
    label: ARTIFACT_STATUS_LABELS[artifact.status] ?? artifact.status,
    known: artifact.status in ARTIFACT_STATUS_LABELS,
  };
}

/** 产物条目：状态点 + 状态 + 时间 + 简化血缘（基于知识 vN）；UUID /
 *  Operation / Session / revision 收进「技术详情」折叠。 */
function ArtifactItemRow({ artifact }: { artifact: BrandArtifactHistoryItem }) {
  const [open, setOpen] = useState(false);
  const status = artifactStatusOf(artifact);

  return (
    <div className="rounded-lg border border-[var(--line-subtle)]">
      <div className="flex flex-wrap items-center gap-2 p-2.5 text-xs">
        <span
          aria-hidden
          className="ba-status-dot"
          data-tone={status.known ? "success" : "muted"}
        />
        <span className="font-medium">{status.label}</span>
        <time className="text-[var(--ink-subtle)]">
          {new Date(artifact.createdAt).toLocaleString()}
        </time>
        {artifact.knowledgeVersion != null && (
          <span className="text-[var(--ink-muted)]">
            基于知识 v{artifact.knowledgeVersion}
          </span>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="ml-auto shrink-0 rounded-md border border-[var(--line-subtle)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
        >
          技术详情
        </button>
      </div>
      {open && (
        <div className="border-t border-[var(--line-subtle)] p-2.5 text-xs">
          <p className="break-all font-mono leading-5 text-[var(--ink-subtle)]">
            {artifact.id}
            {artifact.revision == null ? "" : ` · revision ${artifact.revision}`}
          </p>
          <p className="mt-1 break-all font-mono leading-5 text-[var(--ink-subtle)]">
            Operation {artifact.operationId} · Session {artifact.sessionId}
          </p>
          <ReferenceChips title="来源" references={artifact.sourceRefs} />
          <ReferenceChips title="被以下产物使用" references={artifact.usedBy} />
        </div>
      )}
    </div>
  );
}

/** 第三层产物 widget：按七类分组，类型中文名 + 数量 + 最新一条状态与时间。 */
function ArtifactGroupWidget({
  kind,
  items,
}: {
  kind: string;
  items: BrandArtifactHistoryItem[];
}) {
  const [open, setOpen] = useState(false);
  const latest = items[0];
  const status = artifactStatusOf(latest);

  return (
    <section
      aria-label={ARTIFACT_KIND_LABELS[kind] ?? kind}
      className="ba-grid-texture rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="ba-micro-label truncate">{kind}</p>
          <h3 className="mt-1 text-sm font-semibold">
            {ARTIFACT_KIND_LABELS[kind] ?? kind}
          </h3>
        </div>
        <span className="shrink-0 font-mono text-2xl tabular-nums leading-7">
          {items.length}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-muted)]">
        <span
          aria-hidden
          className="ba-status-dot"
          data-tone={status.known ? "success" : "muted"}
        />
        <span>最新 {status.label}</span>
        <time className="text-[var(--ink-subtle)]">
          {new Date(latest.createdAt).toLocaleString()}
        </time>
        {latest.knowledgeVersion != null && (
          <span>基于知识 v{latest.knowledgeVersion}</span>
        )}
      </div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="mt-3 flex items-center gap-1 rounded-md border border-[var(--line-subtle)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        全部 {items.length} 条
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {items.map((artifact) => (
            <ArtifactItemRow
              key={`${artifact.kind}:${artifact.id}:${artifact.revision ?? "none"}`}
              artifact={artifact}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** 产物按 ARTIFACT_KIND_LABELS 固定序分组；未知 kind 排在已知类之后。 */
function groupArtifactsByKind(
  artifacts: BrandArtifactHistoryItem[],
): { kind: string; items: BrandArtifactHistoryItem[] }[] {
  const byKind = new Map<string, BrandArtifactHistoryItem[]>();
  for (const artifact of artifacts) {
    const group = byKind.get(artifact.kind) ?? [];
    group.push(artifact);
    byKind.set(artifact.kind, group);
  }
  const orderedKinds = [
    ...Object.keys(ARTIFACT_KIND_LABELS).filter((kind) => byKind.has(kind)),
    ...[...byKind.keys()].filter((kind) => !(kind in ARTIFACT_KIND_LABELS)),
  ];
  return orderedKinds.map((kind) => ({
    kind,
    items: (byKind.get(kind) ?? [])
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }));
}

/** 品牌档案整页的只读正文（含页头与刷新）：挂载即读取，跟随当前选中品牌
 *  随 key 重挂载。知识版本按 version 倒序返回，首个即最新。
 *  三层信息架构：当前档案看板（最新版本事实按语义 widget 分格）→
 *  版本历史（默认收起的 diff 台账）→ 产物（按七类分组的 widget）。 */
function BrandArchiveBody({ workspace }: { workspace: BrandWorkspace }) {
  const { t } = useTranslation("chat");
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

  /** 字段名走 knowledgeCard.fields 中文词表（与知识确认卡同源），
   *  非档案字段的 factKey 回退原文。 */
  const labelOf = useCallback(
    (factKey: string) => {
      const field = profileFieldOf(factKey);
      return field == null
        ? factKey
        : t(`knowledgeCard.fields.${field}`, { defaultValue: factKey });
    },
    [t],
  );

  const latest = history?.knowledgeVersions[0] ?? null;

  /** 最新版本事实按语义 widget 分格；非 Profile 字段落入兜底格。 */
  const widgets = useMemo(() => {
    if (!latest) return [];
    const byField = new Map<EnterpriseProfileField, BrandKnowledgeHistoryFact[]>();
    const others: BrandKnowledgeHistoryFact[] = [];
    for (const fact of latest.facts) {
      const field = profileFieldOf(fact.factKey);
      if (field == null) {
        others.push(fact);
        continue;
      }
      const bucket = byField.get(field) ?? [];
      bucket.push(fact);
      byField.set(field, bucket);
    }
    const grouped = PROFILE_WIDGETS.map((def) => ({
      def,
      facts: def.fields.flatMap((field) => byField.get(field) ?? []),
    })).filter((widget) => widget.facts.length > 0);
    if (others.length > 0) {
      grouped.push({
        def: {
          id: "other",
          zh: "其他事实",
          code: "OTHER FACTS // UNGROUPED",
          fields: [],
        },
        facts: others,
      });
    }
    return grouped;
  }, [latest]);

  const artifactGroups = useMemo(
    () => groupArtifactsByKind(history?.artifacts ?? []),
    [history],
  );

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
              只读档案：当前档案为最新已确认版本的看板投影，版本历史与产物血缘来自
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
          className="ba-grid-texture flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-sm text-[var(--ink-muted)]"
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
        <div className="ba-grid-texture rounded-xl border border-dashed border-[var(--line)] p-8 text-center">
          <BookOpenCheck className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <p className="mt-3 text-sm leading-6 text-[var(--ink-muted)]">
            暂无已批准的知识或产物。草稿和待确认版本不会出现在这里。
          </p>
        </div>
      )}

      {history && !isEmpty && (
        <>
          <section aria-label="当前档案" className="space-y-3">
            <CurrentArchiveHero
              workspace={workspace}
              latest={latest}
              versionCount={history.knowledgeVersions.length}
              artifactCount={history.artifacts.length}
            />
            {widgets.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {widgets.map((widget) => (
                  <ProfileWidget
                    key={widget.def.id}
                    def={widget.def}
                    facts={widget.facts}
                    labelOf={labelOf}
                  />
                ))}
              </div>
            )}
          </section>

          {history.knowledgeVersions.length > 0 && (
            <VersionHistorySection
              versions={history.knowledgeVersions}
              labelOf={labelOf}
            />
          )}

          {artifactGroups.length > 0 && (
            <section aria-label="已批准产物" className="space-y-3">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-[var(--accent)]" />
                <div>
                  <p className="ba-micro-label">ARTIFACTS // LINEAGE</p>
                  <h2 className="mt-0.5 text-sm font-semibold">已批准产物</h2>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {artifactGroups.map((group) => (
                  <ArtifactGroupWidget
                    key={group.kind}
                    kind={group.kind}
                    items={group.items}
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
 * 「品牌档案」一级入口整页：品牌级只读投影——第一层「当前档案」看板呈现
 * 最新已确认版本事实，第二层「版本历史」以 diff 台账呈现演进，第三层
 * 「产物」按类型分组呈现血缘。跟随当前选中品牌，不依赖任何 Session；
 * 除读取（刷新/重试）与展开折叠外不提供任何确认或动作入口。
 */
export default memo(function XiaojingBrandArchivePage({ workspace }: Props) {
  if (!workspace) {
    return (
      <main
        className="flex h-full items-center justify-center overflow-y-auto bg-[var(--paper)] px-8 py-12 text-[var(--ink)]"
        data-xiaojing-brand-archive="empty"
      >
        <div className="ba-grid-texture w-full max-w-xl rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-elevated)] p-8 text-center">
          <Archive className="mx-auto h-6 w-6 text-[var(--ink-subtle)]" />
          <h1 className="mt-3 text-base font-semibold">品牌档案</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--ink-muted)]">
            先在左侧选择品牌，即可查看该品牌的当前档案、知识版本史与已批准产物血缘。
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
      <div className="mx-auto w-full max-w-6xl">
        <BrandArchiveBody key={workspace.id} workspace={workspace} />
      </div>
    </main>
  );
});
