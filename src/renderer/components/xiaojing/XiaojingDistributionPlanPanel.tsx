import { AlertTriangle, CheckCircle2, Radar } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { loadLatestDistributionPlan } from "@/api/distributionPlanClient";
import { useTabApi, useTabState } from "@/context/TabContext";
import { isPendingSessionId } from "../../../shared/constants";
import {
  domainToBrand,
  registeredDomain,
} from "../../../shared/geo/channelRecall";
import type {
  DistributionPlanProjection,
  DistributionRecallPath,
} from "../../../shared/geo/distributionPlan";
import { cnyToPoints } from "../../../shared/geo/points";

interface XiaojingDistributionPlanPanelProps {
  workspaceId: string;
  /** 会话内工具推进后的产物刷新信号（票 29：面板只读化后的刷新联动）。 */
  refreshKey?: number;
}

const KIND_LABEL = { media: "媒体", "we-media": "自媒体" } as const;
/** 召回路命中的展示词（与四路召回契约 passive/active/fallback/preference 一一对应，与聊天卡片同词表）。 */
const PATH_LABEL = {
  passive: "被动召回",
  active: "主动召回",
  fallback: "保底召回",
  preference: "偏好召回",
} as const;

/** 召回来源 chip：matched = 该来源产出了至少一条命中证据。 */
export interface RecallSourceChip {
  key: string;
  title: string;
  subtitle: string | null;
  matched: boolean;
  /** 被动路专属：来源归属的问题文本与引用 URL（三字段证据行）。 */
  question?: string;
  url?: string | null;
  /** 被动路专属：引用的站点名（豆包 site_name）。 */
  siteName?: string | null;
  /** 主动路专属：LLM 推荐理由（原始回答关键信息）。 */
  reason?: string | null;
}

/** 单路召回展示视图：召回来源 + 匹配后渠道（高亮）。 */
export interface RecallPathView {
  path: DistributionRecallPath;
  label: string;
  sources: RecallSourceChip[];
  matchedChannels: Array<{
    key: string;
    name: string;
    kindLabel: string;
    evidence: string;
  }>;
}

function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  // 渠道名取注册域名（m.toutiao.com → toutiao.com），与召回匹配的口径一致。
  return registeredDomain(url) ?? hostOnly(url);
}

function hostOnly(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** 引用标题尾部的账号后缀（「xxx_有趣的橙子sGq」→「有趣的橙子sGq」）。 */
function authorSuffixOf(title: string): string | null {
  const match = title.match(/[_｜|]([^\s_｜|·]{2,30})$/);
  return match ? (match[1] ?? null) : null;
}

/** 被动来源按渠道（注册域名）聚合：让「一个渠道多条引用」直接可见。 */
export interface PassiveChannelGroup {
  key: string;
  /** 渠道显示名：品牌优先；组内账号后缀一致时附带（如「今日头条 · 深氪新消费」）。 */
  label: string;
  domain: string | null;
  citations: RecallSourceChip[];
  /** 该渠道覆盖的问题文本集合（跨问交集的可见口径）。 */
  questions: Set<string>;
  matched: boolean;
}

export function groupPassiveSourcesByChannel(
  sources: ReadonlyArray<RecallSourceChip>,
): PassiveChannelGroup[] {
  const groups = new Map<string, PassiveChannelGroup>();
  for (const source of sources) {
    const domain = registeredDomain(source.url ?? null);
    const key = domain ?? source.url ?? source.key;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: "",
        domain,
        citations: [],
        questions: new Set<string>(),
        matched: false,
      };
      groups.set(key, group);
    }
    group.citations.push(source);
    if (source.question) group.questions.add(source.question);
    group.matched = group.matched || source.matched;
  }
  for (const group of groups.values()) {
    // 组名优先级：豆包 site_name（组内一致时）> 品牌表 > 注册域名；
    // 组内账号后缀一致时附带（如「今日头条 · 深氪新消费」）。
    const siteNames = [
      ...new Set(
        group.citations
          .map((citation) => citation.siteName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    ];
    const brand = group.domain ? domainToBrand(group.domain) : undefined;
    const suffixes = [
      ...new Set(
        group.citations
          .map((citation) => authorSuffixOf(citation.title))
          .filter((suffix): suffix is string => suffix !== null),
      ),
    ];
    const account = suffixes.length === 1 ? suffixes[0] : undefined;
    const base =
      siteNames.length === 1
        ? (siteNames[0] as string)
        : (brand ?? group.domain ?? "未知渠道");
    group.label = account ? `${base} · ${account}` : base;
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.questions.size - left.questions.size ||
      right.citations.length - left.citations.length,
  );
}

/**
 * 由权威投影推导四路召回展示：被动来源=问题探测引用、主动来源=全局召回
 * 原始渠道、偏好来源=生效名单快照；来源与命中渠道通过 evidence.reference
 * （逗号分隔的 questionId / recall:渠道名 / preference:名单名）互相关联。
 */
export function buildRecallPathViews(
  plan: DistributionPlanProjection,
): RecallPathView[] {
  const matchedQuestions = new Set<string>();
  const matchedRecallTitles = new Set<string>();
  const matchedPreferenceNames = new Set<string>();
  const matchedFallbackRules = new Set<string>();
  const matchedChannels = new Map<
    DistributionRecallPath,
    RecallPathView["matchedChannels"]
  >();
  for (const candidate of plan.candidates) {
    for (const evidence of candidate.evidence) {
      const list = matchedChannels.get(evidence.path) ?? [];
      list.push({
        key: `${candidate.kind}:${candidate.resourceId}`,
        name: candidate.name,
        kindLabel: KIND_LABEL[candidate.kind],
        evidence: evidence.label,
      });
      matchedChannels.set(evidence.path, list);
      for (const part of evidence.reference.split(",")) {
        const reference = part.trim();
        if (evidence.path === "passive" && reference) {
          matchedQuestions.add(reference);
        } else if (evidence.path === "active" && reference) {
          matchedRecallTitles.add(reference.replace(/^recall:/, ""));
        } else if (evidence.path === "preference" && reference) {
          matchedPreferenceNames.add(reference.replace(/^preference:/, ""));
        } else if (evidence.path === "fallback" && reference) {
          matchedFallbackRules.add(reference.split(":", 1)[0] ?? "");
        }
      }
    }
  }
  const view = (
    path: DistributionRecallPath,
    sources: RecallSourceChip[],
  ): RecallPathView => ({
    path,
    label: PATH_LABEL[path],
    sources,
    matchedChannels: matchedChannels.get(path) ?? [],
  });
  return [
    view(
      "passive",
      plan.questionSources.map((source) => ({
        key: source.id,
        title: source.title,
        subtitle: hostOfUrl(source.url),
        matched: matchedQuestions.has(source.questionId),
        question: source.question,
        url: source.url,
        siteName: source.siteName ?? null,
      })),
    ),
    view(
      "active",
      (plan.activeRecallSources ?? []).map((source) => ({
        key: `active:${source.title}:${source.url ?? ""}`,
        title: source.title,
        subtitle: hostOfUrl(source.url),
        matched: matchedRecallTitles.has(source.title),
        reason: source.reason ?? null,
      })),
    ),
    view("fallback", [
      {
        key: "fallback:industry",
        title: `行业类目「${plan.industry}」`,
        subtitle: null,
        matched: matchedFallbackRules.has("industry"),
      },
      {
        key: "fallback:audience",
        title: `目标人群「${plan.targetAudience}」`,
        subtitle: null,
        matched: matchedFallbackRules.has("audience"),
      },
    ]),
    view(
      "preference",
      (plan.preferenceChannelNames ?? []).map((name) => ({
        key: `preference:${name}`,
        title: name,
        subtitle: null,
        matched: matchedPreferenceNames.has(name),
      })),
    ),
  ];
}

/** 四路召回复盘：来源 chip 命中高亮，匹配渠道 accent 高亮；无交互，纯展示。 */
function RecallBreakdown({ plan }: { plan: DistributionPlanProjection }) {
  const views = useMemo(() => buildRecallPathViews(plan), [plan]);
  return (
    <div className="space-y-2 rounded-xl border border-[var(--line-subtle)] p-2">
      <p className="font-semibold">四路召回结果</p>
      {views.map((item) => (
        <article
          key={item.path}
          aria-label={`${item.label}来源与匹配`}
          className="rounded-lg bg-[var(--paper-inset)] p-2"
        >
          <p className="flex items-center justify-between">
            <span className="font-medium">{item.label}</span>
            <span className="text-[var(--ink-subtle)]">
              来源 {item.sources.length} · 匹配渠道{" "}
              {item.matchedChannels.length}
            </span>
          </p>
          {item.path === "passive" ? (
            item.sources.length === 0 ? (
              <p className="mt-1 text-[var(--ink-subtle)]">无召回来源</p>
            ) : (
              <>
                <p className="mt-1 text-[var(--ink-subtle)]">
                  召回来源（按渠道分组，跨问覆盖多的渠道在前）：
                </p>
                <ul className="mt-0.5 space-y-1">
                  {groupPassiveSourcesByChannel(item.sources).map((group) => (
                    <li
                      key={group.key}
                      className={`rounded border px-1.5 py-1 ${
                        group.matched
                          ? "border-[var(--accent)] bg-[var(--accent-warm-subtle)]"
                          : "border-[var(--line-subtle)]"
                      }`}
                    >
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          className={`font-medium ${
                            group.matched ? "text-[var(--accent)]" : ""
                          }`}
                        >
                          {group.matched ? "✓ " : ""}
                          {group.label}
                        </span>
                        <span className="text-[var(--ink-subtle)]">
                          {group.citations.length} 条引用 · 覆盖{" "}
                          {group.questions.size} 个问题
                          {group.domain ? ` · ${group.domain}` : ""}
                        </span>
                      </p>
                      <ul className="mt-0.5 space-y-0.5 pl-2">
                        {group.citations.map((citation) => (
                          <li
                            key={citation.key}
                            className="flex flex-wrap items-baseline gap-x-2"
                          >
                            {citation.question && (
                              <span className="max-w-full truncate text-[var(--ink-subtle)]">
                                问题：{citation.question}
                              </span>
                            )}
                            {citation.url && (
                              <a
                                href={citation.url}
                                target="_blank"
                                rel="noreferrer"
                                className="max-w-full truncate text-[var(--accent)] underline decoration-dotted underline-offset-2"
                                title={citation.title}
                              >
                                {citation.title}
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : item.path === "active" ? (
            item.sources.length === 0 ? (
              <p className="mt-1 text-[var(--ink-subtle)]">无召回来源</p>
            ) : (
              <>
                <p className="mt-1 text-[var(--ink-subtle)]">召回来源：</p>
                <ul className="mt-0.5 space-y-1">
                  {item.sources.map((source) => (
                    <li
                      key={source.key}
                      className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border px-1.5 py-1 ${
                        source.matched
                          ? "border-[var(--accent)] bg-[var(--accent-warm-subtle)]"
                          : "border-[var(--line-subtle)]"
                      }`}
                    >
                      <span
                        className={`shrink-0 font-medium ${
                          source.matched ? "text-[var(--accent)]" : ""
                        }`}
                      >
                        {source.matched ? "✓ " : ""}
                        {source.title}
                        {source.subtitle ? ` · ${source.subtitle}` : ""}
                      </span>
                      {source.reason && (
                        <span
                          className="max-w-full truncate text-[var(--ink-subtle)]"
                          title={source.reason}
                        >
                          理由：{source.reason}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : (
            <>
              <p className="mt-1 text-[var(--ink-subtle)]">召回来源：</p>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {item.sources.length === 0 && (
                  <span className="text-[var(--ink-subtle)]">无召回来源</span>
                )}
                {item.sources.map((source) => (
                  <span
                    key={source.key}
                    className={`max-w-full truncate rounded border px-1.5 py-0.5 ${
                      source.matched
                        ? "border-[var(--accent)] bg-[var(--accent-warm-subtle)] text-[var(--accent)]"
                        : "border-[var(--line-subtle)] text-[var(--ink-muted)]"
                    }`}
                    title={source.subtitle ?? source.title}
                  >
                    {source.matched ? "✓ " : ""}
                    {source.title}
                    {source.subtitle ? ` · ${source.subtitle}` : ""}
                  </span>
                ))}
              </div>
            </>
          )}
          {item.matchedChannels.length > 0 && (
            <div className="mt-1">
              <p className="text-[var(--ink-subtle)]">
                匹配渠道（资源池命中，与上方召回来源经证据对齐关联）：
              </p>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {item.matchedChannels.map((channel) => (
                  <span
                    key={channel.key}
                    className="rounded border border-[var(--accent)] bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 font-medium text-[var(--accent)]"
                    title={channel.evidence}
                  >
                    {channel.kindLabel} · {channel.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function localDateTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 票 29：分发阶段面板是纯只读投影。渠道发现、候选勾选、映射编辑与
 * 确认只出现在聊天里的卡片（DistributionGateCard）上。
 */
export default memo(function XiaojingDistributionPlanPanel({
  workspaceId,
  refreshKey = 0,
}: XiaojingDistributionPlanPanelProps) {
  const { apiPost } = useTabApi();
  const { sessionId } = useTabState();
  const [plan, setPlan] = useState<DistributionPlanProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasRealSession = Boolean(sessionId && !isPendingSessionId(sessionId));
  const identity = useMemo(
    () => (sessionId ? { workspaceId, sessionId } : null),
    [sessionId, workspaceId],
  );

  useEffect(() => {
    if (!hasRealSession || !identity) return;
    let active = true;
    void loadLatestDistributionPlan(apiPost, identity)
      .then((latest) => {
        if (!active) return;
        setError(null);
        setPlan(latest);
      })
      .catch((cause) => {
        if (!active) return;
        setPlan(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [apiPost, hasRealSession, identity, refreshKey]);

  return (
    <section
      aria-label="渠道发现与分发计划"
      className="mt-4 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)]"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-4 py-3">
        <Radar className="h-4 w-4 text-[var(--accent)]" />
        <h3 className="text-sm font-semibold">渠道发现与分发计划</h3>
      </div>

      <div className="space-y-3 p-4 text-xs">
        {!hasRealSession && (
          <p className="text-[var(--ink-muted)]">
            等待真实会话后加载分发计划。
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-[var(--error-bg)] p-2 text-[var(--error)]"
          >
            {error}
          </p>
        )}
        {hasRealSession && !plan && !error && (
          <p className="leading-5 text-[var(--ink-muted)]">
            暂无分发计划；渠道发现与计划确认在聊天中的卡片上发起与完成。
          </p>
        )}

        {plan && plan.status !== "confirmed" && (
          <p className="rounded-lg bg-[var(--paper-inset)] p-2 leading-5 text-[var(--ink-muted)]">
            分发计划尚未确认；渠道候选、映射与预算请在聊天中的确认卡片上
            审阅，确认后这里展示计划内容。
          </p>
        )}

        {plan && plan.status !== "discovering" && (
          <RecallBreakdown plan={plan} />
        )}

        {plan && plan.status === "confirmed" && (
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-[var(--hover-bg)] p-2">
              <span>
                {plan.providerSnapshot.provider} ·{" "}
                {plan.providerState === "available"
                  ? "目录快照可用"
                  : "能力不可用"}
              </span>
              <span>rev {plan.revision}</span>
            </div>
            {plan.candidates.length === 0 && (
              <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-2 text-[var(--warning)]">
                <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                没有真实可用候选；未生成替代或随机渠道。
              </div>
            )}
            {plan.candidates.map((candidate) => (
              <article
                key={`${candidate.kind}:${candidate.resourceId}`}
                className="rounded-xl border border-[var(--line)] p-3"
              >
                <div>
                  <span className="block font-semibold">
                    {KIND_LABEL[candidate.kind]} · {candidate.name}
                    {plan.selectedResourceIds.includes(candidate.resourceId) &&
                      "（已选）"}
                  </span>
                  <span className="text-[var(--ink-muted)]">
                    所需点数：
                    {candidate.estimatedPriceCny === null
                      ? "点数待定"
                      : `${cnyToPoints(candidate.estimatedPriceCny)} 点`}
                  </span>
                </div>
                <p className="mt-2 text-[var(--ink-muted)]">
                  召回路命中：
                  {candidate.pathHits
                    .map(
                      (path) =>
                        `${PATH_LABEL[path] ?? path}（${
                          candidate.evidence.find((item) => item.path === path)
                            ?.label ?? ""
                        }）`,
                    )
                    .join("；")}
                </p>
                {candidate.fitReasons.length > 0 && (
                  <p className="mt-2">
                    适配：{candidate.fitReasons.join("；")}
                  </p>
                )}
              </article>
            ))}

            <div className="space-y-2">
              <p className="font-semibold">文章 → 渠道映射</p>
              {plan.articles.map((article) => {
                const assignment = plan.assignments.find(
                  (item) => item.articleId === article.id,
                );
                return (
                  <div key={article.id} className="block">
                    <span className="mb-1 block truncate text-[var(--ink-muted)]">
                      {article.title}
                    </span>
                    <span className="block">
                      {assignment
                        ? (plan.candidates.find(
                            (candidate) =>
                              candidate.resourceId === assignment.resourceId,
                          )?.name ?? "未分配")
                        : "未分配"}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <span>预算：{cnyToPoints(plan.budgetCny)} 点</span>
              <span>发布时间：{localDateTime(plan.publishStartAt)}</span>
            </div>
            <p className="flex items-center gap-2 rounded-lg bg-[var(--success-bg)] p-2 text-[var(--success)]">
              <CheckCircle2 className="h-4 w-4" />
              计划已确认；尚未扣费、下单或发布。
            </p>
            <p className="text-[var(--ink-subtle)]">
              本步骤只确认推荐与分配计划。任何付费、下单或发布仍需后续独立确认。
            </p>
          </div>
        )}
      </div>
    </section>
  );
});
