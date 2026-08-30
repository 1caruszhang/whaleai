export interface CompetitorDisplayDetail {
  name: string;
  region: string;
  similarBusiness: string;
}

const COMPETITOR_DETAILS_PREFIX = '[[xiaojing-competitor-details:v1]]';
const COMPETITOR_DETAILS_LIMIT = 20;

function normalizeDetails(input: unknown): CompetitorDisplayDetail[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: CompetitorDisplayDetail[] = [];
  for (const item of input.slice(0, COMPETITOR_DETAILS_LIMIT)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const holder = item as Record<string, unknown>;
    const name = typeof holder.name === 'string' ? holder.name.trim() : '';
    const region = typeof holder.region === 'string' ? holder.region.trim() : '';
    const similarBusiness = typeof holder.similarBusiness === 'string'
      ? holder.similarBusiness.trim()
      : '';
    const token = name.toLocaleLowerCase('zh-CN');
    if (!name || !region || !similarBusiness || seen.has(token)) continue;
    seen.add(token);
    result.push({ name, region, similarBusiness });
  }
  return result;
}

/**
 * ADR-0007 元数据退役：`[[xiaojing-competitor-details:v1]]` 审计头已停止
 * 新增编码（新竞品事实只存名称），本模块仅保留读侧——品牌知识面板与品牌
 * 档案页对存量事实的摘录解码出旧三元组做兼容展示；新事实无头即纯名称。
 */
export function decodeCompetitorEvidence(excerpt: string): {
  details: CompetitorDisplayDetail[];
  evidence: string;
} {
  if (!excerpt.startsWith(COMPETITOR_DETAILS_PREFIX)) {
    return { details: [], evidence: excerpt };
  }
  const lineEnd = excerpt.indexOf('\n', COMPETITOR_DETAILS_PREFIX.length);
  // 头部畸形/截断/规范化后为空时退回纯证据文本：审计标记不得出现在
  // 值或来源证据 UI 中（DESIGN.md），宁可丢展示元数据也不泄漏标记。
  const evidence = lineEnd >= 0 ? excerpt.slice(lineEnd + 1) : '';
  try {
    const details = normalizeDetails(JSON.parse(
      excerpt.slice(COMPETITOR_DETAILS_PREFIX.length, lineEnd >= 0 ? lineEnd : undefined),
    ) as unknown);
    if (details.length === 0) return { details: [], evidence };
    return { details, evidence };
  } catch {
    return { details: [], evidence };
  }
}

/** 已确认事实可能合并多份来源；按来源顺序合并展示元数据，后到来源覆盖同名旧值。 */
export function collectCompetitorDetails(
  excerpts: readonly string[],
): CompetitorDisplayDetail[] {
  const merged = new Map<string, CompetitorDisplayDetail>();
  for (const excerpt of excerpts) {
    for (const detail of decodeCompetitorEvidence(excerpt).details) {
      merged.set(detail.name.toLocaleLowerCase('zh-CN'), detail);
    }
  }
  return [...merged.values()];
}

/** 纯名称权威值 + 来源元数据 → 用户可读的持久三元组；旧事实无元数据时保持名称。 */
export function formatCompetitorDisplayNames(
  names: readonly string[],
  details: readonly CompetitorDisplayDetail[],
): string[] {
  const byName = new Map(details.map((detail) => [
    detail.name.toLocaleLowerCase('zh-CN'),
    detail,
  ]));
  return names.map((name) => {
    const detail = byName.get(name.trim().toLocaleLowerCase('zh-CN'));
    return detail
      ? `${detail.name}｜${detail.region}｜${detail.similarBusiness}`
      : name;
  });
}

/**
 * 权威名称数组 + 事实的全部来源 excerpt → 持久三元组展示。聊天卡、品牌知识
 * 面板与品牌档案页共用本投影：无元数据的名称保持原样，绝不错误挂接。
 */
export function formatCompetitorFactValue(
  names: readonly string[],
  excerpts: readonly string[],
): string[] {
  return formatCompetitorDisplayNames(names, collectCompetitorDetails(excerpts));
}
