/**
 * 批量知识确认卡契约：材料导入产出的候选由聊天内的结构化卡片裁决
 * （单条提议仍走 propose_brand_fact 的 knowledge-conflict-card）。
 * Server 从 MaterialImport 结果构造；renderer 在聊天 tool 结果与品牌材料
 * 面板两处渲染同一卡片组件，决策统一经会话 decide 路由提交。
 */

import { unwrapToolResultText } from '../toolResult';
import {
  canonicalEnterpriseProfileField,
  ENTERPRISE_PROFILE_FIELDS,
  PROFILE_PREDICATE_PREFIX,
} from './enterpriseProfile';
import {
  decodeCompetitorEvidence,
  type CompetitorDisplayDetail,
} from './competitorDetails';

export type KnowledgeCardDecision =
  | 'keep-current'
  | 'adopt-new'
  | 'adopt-edited'
  | 'reject-candidate';

export interface KnowledgeCardSource {
  materialId?: string | null;
  excerpt: string;
  confidence: number;
  profileProvenance?: 'extracted' | 'asked' | 'inferred' | null;
}

export interface KnowledgeCardCurrent {
  normalizedValueJson: string;
  unit?: string | null;
  version: number;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface KnowledgeCardCandidate {
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
  status:
    | 'awaiting-confirmation'
    | 'conflict'
    | 'adopted'
    | 'kept-current'
    | 'split-scope'
    | 'rejected';
  baseVersion: number;
  origin: string;
  source: KnowledgeCardSource;
  /** 仅用于竞品确认卡展示；权威事实值仍是纯名称数组。 */
  competitorDetails?: CompetitorDisplayDetail[];
  current?: KnowledgeCardCurrent | null;
}

export interface KnowledgeCandidatesCardData {
  kind: 'knowledge-candidates-card';
  requiresUserDecision: true;
  material?: { id: string; displayName: string } | null;
  candidates: KnowledgeCardCandidate[];
  /** 超出卡片上限的候选数；这些候选仍待确认，需逐条提议或重试导入。 */
  overflowCount?: number;
  /**
   * 被截断候选按字段行分组键的归属计数（键同 {@link knowledgeFieldKeyOfPredicate}）。
   * 溢出提示挂在具体字段行内，不再呈现卡级总数。
   */
  overflowByField?: Partial<Record<string, number>>;
}

/** 卡片内携带的候选总量上限：约束 tool 结果与转录体积。真实批次典型 15–30 条，
 * 500 是宽余量，溢出机制只作极端兜底。各字段候选数按材料自然分布（全称 1 条、
 * 产品/地址多条），不设单字段上限。 */
export const KNOWLEDGE_CARD_MAX_CANDIDATES = 500;

/** 卡片投影的单条摘录上限：卡片 JSON 是工具结果正文、随转录进 Agent 上下文，
 * 只携带复核所需的引用片段；完整摘录留在 KnowledgeAuthority 候选与审计里。 */
export const KNOWLEDGE_CARD_EXCERPT_MAX_CHARS = 300;

export function parseKnowledgeCandidatesCard(
  raw: string,
): KnowledgeCandidatesCardData | null {
  try {
    // MCP 结果可能是 content blocks 包装（`[{type:'text',text:...}]`），先剥壳。
    const parsed = JSON.parse(unwrapToolResultText(raw)) as KnowledgeCandidatesCardData;
    if (
      parsed?.kind === 'knowledge-candidates-card'
      && parsed.requiresUserDecision === true
      && Array.isArray(parsed.candidates)
      && parsed.candidates.length > 0
      && parsed.candidates.every(
        (candidate) =>
          typeof candidate?.id === 'string'
          && typeof candidate.workspaceId === 'string'
          && typeof candidate.sessionId === 'string',
      )
    ) {
      return parsed;
    }
  } catch {
    // 未知工具结果走通用渲染。
  }
  return null;
}

export interface KnowledgeBatchDecisionItem {
  candidateId: string;
  decision: KnowledgeCardDecision;
  expectedCurrentVersion: number;
  /** adopt-edited 必填：用户在卡片里编辑后的值（发送前归一化）。 */
  editedValue?: unknown;
}

export interface KnowledgeBatchDecisionItemResult {
  candidateId: string;
  ok: boolean;
  status?: string;
  error?: string;
}

/** 服务端 KnowledgeCandidate 的结构化子集；投影为卡片候选，剥离 identity 与来源明细。 */
export interface KnowledgeCardCandidateSource {
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
  valueJson: string;
  normalizedValueJson: string;
  unit?: string | null;
  status: KnowledgeCardCandidate["status"];
  baseVersion: number;
  origin: string;
  source: {
    materialId?: string | null;
    excerpt: string;
    confidence: number;
    profileProvenance?: string | null;
  };
  current?: {
    normalizedValueJson: string;
    unit?: string | null;
    version: number;
    confirmedBy?: string;
    confirmedAt?: string;
  } | null;
}

/** 卡片投影摘录：复核引用片段 + 截断省略号；原始值（valueJson）与完整摘录
 * 不进卡片载荷，避免与 normalized 值重复、把工具结果正文撑大。 */
function projectExcerpt(excerpt: string): string {
  return excerpt.length > KNOWLEDGE_CARD_EXCERPT_MAX_CHARS
    ? `${excerpt.slice(0, KNOWLEDGE_CARD_EXCERPT_MAX_CHARS)}…`
    : excerpt;
}

export function toKnowledgeCardCandidate(
  candidate: KnowledgeCardCandidateSource,
): KnowledgeCardCandidate {
  const competitorSource = knowledgeFieldKeyOfPredicate(candidate.key.predicate) === 'competitors'
    ? decodeCompetitorEvidence(candidate.source.excerpt)
    : { details: [], evidence: candidate.source.excerpt };
  return {
    id: candidate.id,
    workspaceId: candidate.workspaceId,
    sessionId: candidate.sessionId,
    key: {
      subject: candidate.key.subject,
      predicate: candidate.key.predicate,
      scopeJson: candidate.key.scopeJson,
      effectiveFrom: candidate.key.effectiveFrom ?? null,
      effectiveTo: candidate.key.effectiveTo ?? null,
    },
    normalizedValueJson: candidate.normalizedValueJson,
    unit: candidate.unit ?? null,
    status: candidate.status,
    baseVersion: candidate.baseVersion,
    origin: candidate.origin,
    source: {
      materialId: candidate.source.materialId ?? null,
      excerpt: projectExcerpt(competitorSource.evidence),
      confidence: candidate.source.confidence,
      profileProvenance:
        candidate.source.profileProvenance === "extracted"
          || candidate.source.profileProvenance === "asked"
          || candidate.source.profileProvenance === "inferred"
          ? candidate.source.profileProvenance
          : null,
    },
    ...(competitorSource.details.length > 0
      ? { competitorDetails: competitorSource.details }
      : {}),
    current: candidate.current
      ? {
        normalizedValueJson: candidate.current.normalizedValueJson,
        unit: candidate.current.unit ?? null,
        version: candidate.current.version,
        ...(candidate.current.confirmedBy !== undefined
          ? { confirmedBy: candidate.current.confirmedBy }
          : {}),
        ...(candidate.current.confirmedAt !== undefined
          ? { confirmedAt: candidate.current.confirmedAt }
          : {}),
      }
      : null,
  };
}

/** 构造批量确认卡数据；无候选返回 null（调用方回落到原始结果渲染）。
 * 候选按材料自然分布进卡，不设单字段配额；仅当总量超过上限时，先保底
 * 每个出现的字段 1 条（防大容量字段把其他类整类挤掉），再按 payload 自然
 * 顺序填充至总量上限；未进卡的候选按字段归因进 overflowByField。 */
export function buildKnowledgeCandidatesCardData(
  material: { id: string; displayName: string } | null,
  candidates: KnowledgeCardCandidate[],
): KnowledgeCandidatesCardData | null {
  if (candidates.length === 0) return null;
  if (candidates.length <= KNOWLEDGE_CARD_MAX_CANDIDATES) {
    return {
      kind: 'knowledge-candidates-card',
      requiresUserDecision: true,
      material,
      candidates,
    };
  }
  const byField = new Map<string, KnowledgeCardCandidate[]>();
  for (const candidate of candidates) {
    const field = knowledgeFieldKeyOfPredicate(candidate.key.predicate);
    const group = byField.get(field);
    if (group) group.push(candidate);
    else byField.set(field, [candidate]);
  }
  const selected = new Set<KnowledgeCardCandidate>();
  for (const group of byField.values()) {
    if (selected.size >= KNOWLEDGE_CARD_MAX_CANDIDATES) break;
    selected.add(group[0]);
  }
  for (const candidate of candidates) {
    if (selected.size >= KNOWLEDGE_CARD_MAX_CANDIDATES) break;
    selected.add(candidate);
  }
  const overflowByField: Record<string, number> = {};
  for (const [field, group] of byField) {
    const taken = group.reduce((count, candidate) => count + (selected.has(candidate) ? 1 : 0), 0);
    const overflow = group.length - taken;
    if (overflow > 0) overflowByField[field] = overflow;
  }
  const overflowCount = candidates.length - selected.size;
  return {
    kind: 'knowledge-candidates-card',
    requiresUserDecision: true,
    material,
    candidates: candidates.filter((candidate) => selected.has(candidate)),
    overflowCount,
    overflowByField,
  };
}

/** predicate → 字段行分组键：已知 Profile 字段归一为规范字段 token，其余保持 predicate 原文。 */
export function knowledgeFieldKeyOfPredicate(predicate: string): string {
  if (predicate.startsWith(PROFILE_PREDICATE_PREFIX)) {
    // 入库 predicate 已被小写化（identity 归一化契约），必须大小写不敏感匹配，
    // 否则 `enterprise-profile.servicearea` 与 `addresses` 会被当成两个不相干字段。
    const canonical = canonicalEnterpriseProfileField(
      predicate.slice(PROFILE_PREDICATE_PREFIX.length),
    );
    if (canonical) return canonical;
  }
  return predicate;
}

/** 字段行复核卡的行投影：同一 Profile 字段的候选（含跨 scope 多值）合并为一行。 */
export interface KnowledgeFieldRow {
  /** 分组键：已知 Profile 字段为字段 token（如 `products`），其余为完整 predicate。 */
  field: string;
  /** 行内候选，保持 payload 顺序。 */
  candidates: KnowledgeCardCandidate[];
  /** 被卡片上限截断、未进入本行的该字段候选数。 */
  overflowCount: number;
}

/**
 * 字段行分组投影（ADR 0003）：候选按企业 Profile 固定字段序分行，同字段多值合并；
 * 未知 predicate 的行按首现顺序排在全部已知字段之后。
 */
export function buildKnowledgeFieldRows(
  data: Pick<KnowledgeCandidatesCardData, 'candidates' | 'overflowByField'>,
): KnowledgeFieldRow[] {
  const fieldIndex = new Map<string, number>();
  const grouped = new Map<string, KnowledgeCardCandidate[]>();
  let unknownOrder = 0;
  for (const candidate of data.candidates) {
    const field = knowledgeFieldKeyOfPredicate(candidate.key.predicate);
    if (!fieldIndex.has(field)) {
      const known = (ENTERPRISE_PROFILE_FIELDS as readonly string[]).indexOf(field);
      fieldIndex.set(field, known >= 0
        ? known
        : ENTERPRISE_PROFILE_FIELDS.length + unknownOrder++);
    }
    const existing = grouped.get(field);
    if (existing) existing.push(candidate);
    else grouped.set(field, [candidate]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => fieldIndex.get(left)! - fieldIndex.get(right)!)
    .map(([field, candidates]) => ({
      field,
      candidates,
      overflowCount: data.overflowByField?.[field] ?? 0,
    }));
}
