import { describe, expect, it } from 'vitest';

import {
  buildKnowledgeCandidatesCardData,
  buildKnowledgeFieldRows,
  KNOWLEDGE_CARD_EXCERPT_MAX_CHARS,
  KNOWLEDGE_CARD_MAX_CANDIDATES,
  knowledgeFieldKeyOfPredicate,
  parseKnowledgeCandidatesCard,
  toKnowledgeCardCandidate,
  type KnowledgeCardCandidate,
  type KnowledgeCardCandidateSource,
} from './knowledgeCard';

/** 顶层 `predicate` 便捷覆盖会同步进 `key.predicate`（字段行分组按它归组）。 */
function source(
  overrides: Partial<KnowledgeCardCandidateSource> & { predicate?: string } = {},
): KnowledgeCardCandidateSource {
  const { predicate = 'enterprise-profile.fullName', ...rest } = overrides;
  const defaults: KnowledgeCardCandidateSource = {
    id: 'candidate-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    key: {
      subject: '鲸跃科技',
      predicate,
      scopeJson: '{"entityScope":"brand"}',
      effectiveFrom: null,
      effectiveTo: null,
    },
    valueJson: '"鲸跃科 技"',
    normalizedValueJson: '"鲸跃科 技"',
    unit: null,
    status: 'awaiting-confirmation',
    baseVersion: 0,
    origin: 'model-inferred',
    source: {
      materialId: 'material-1',
      excerpt: '公司全称：鲸跃科技',
      confidence: 0.96,
      profileProvenance: 'extracted',
    },
    current: null,
  };
  return {
    ...defaults,
    ...rest,
    key: { ...defaults.key, ...(rest.key ?? {}) },
  };
}

describe('knowledge candidates card contract', () => {
  it('parses only well-formed batch card payloads', () => {
    const card = buildKnowledgeCandidatesCardData(
      { id: 'material-1', displayName: '资料.md' },
      [toKnowledgeCardCandidate(source())],
    );
    expect(card).not.toBeNull();
    expect(parseKnowledgeCandidatesCard(JSON.stringify(card))).toMatchObject({
      kind: 'knowledge-candidates-card',
      material: { displayName: '资料.md' },
    });
    expect(parseKnowledgeCandidatesCard('not-json')).toBeNull();
    expect(parseKnowledgeCandidatesCard(JSON.stringify({ kind: 'other' }))).toBeNull();
    expect(parseKnowledgeCandidatesCard(JSON.stringify({
      kind: 'knowledge-candidates-card',
      requiresUserDecision: true,
      candidates: [],
    }))).toBeNull();
  });

  it('解析生产投影的 MCP content blocks 包装形态（回归）', () => {
    const card = buildKnowledgeCandidatesCardData(
      { id: 'material-1', displayName: '行乐音改信息.txt' },
      [toKnowledgeCardCandidate(source())],
    );
    // agent-session applyToolResults 对非字符串 content 整体 stringify。
    const wrapped = JSON.stringify([{ type: 'text', text: JSON.stringify(card) }]);
    expect(parseKnowledgeCandidatesCard(wrapped)).toMatchObject({
      kind: 'knowledge-candidates-card',
      candidates: [{ id: 'candidate-1' }],
    });
  });

  it('projects candidates with normalized optional fields and keeps the current conflict value', () => {
    const projected = toKnowledgeCardCandidate(source({
      current: {
        normalizedValueJson: '"鲸跃科技有限公司"',
        unit: null,
        version: 2,
        confirmedBy: 'user-1',
        confirmedAt: '2026-08-15T00:00:00Z',
      },
      source: {
        materialId: undefined,
        excerpt: '推断',
        confidence: 0.4,
        profileProvenance: 'unknown-token' as 'extracted',
      },
    }));
    const expected: KnowledgeCardCandidate = {
      id: 'candidate-1',
      workspaceId: 'brand-1',
      sessionId: 'session-1',
      key: {
        subject: '鲸跃科技',
        predicate: 'enterprise-profile.fullName',
        scopeJson: '{"entityScope":"brand"}',
        effectiveFrom: null,
        effectiveTo: null,
      },
      normalizedValueJson: '"鲸跃科 技"',
      unit: null,
      status: 'awaiting-confirmation',
      baseVersion: 0,
      origin: 'model-inferred',
      source: { materialId: null, excerpt: '推断', confidence: 0.4, profileProvenance: null },
      current: {
        normalizedValueJson: '"鲸跃科技有限公司"',
        unit: null,
        version: 2,
        confirmedBy: 'user-1',
        confirmedAt: '2026-08-15T00:00:00Z',
      },
    };
    expect(projected).toEqual(expected);
  });

  it('builds no card without candidates and caps large batches at the total transport bound', () => {
    expect(buildKnowledgeCandidatesCardData(null, [])).toBeNull();
    const many = Array.from({ length: KNOWLEDGE_CARD_MAX_CANDIDATES + 7 }, (_, index) =>
      toKnowledgeCardCandidate(source({ id: `candidate-${index}` })));
    const card = buildKnowledgeCandidatesCardData({ id: 'material-1', displayName: '大材料' }, many);
    expect(card?.candidates).toHaveLength(KNOWLEDGE_CARD_MAX_CANDIDATES);
    expect(card?.overflowCount).toBe(7);
    expect(card?.overflowByField).toEqual({ fullName: 7 });
  });

  it('keeps natural per-field distribution and only guarantees one slot per field over the bound', () => {
    // 490 条 products + 其余 14 个已知字段各 1 条（共 504，超总量 4 条）：
    // 不设单字段上限——products 按自然分布拿到 486 条，其余每类保住 1 个格子，
    // 溢出只落在 products 上。
    const otherFields = [
      'fullName', 'shortNames', 'addresses', 'serviceArea', 'industry',
      'relatedBrands', 'competitors', 'targetCustomers', 'coreAdvantages',
      'trustEndorsements', 'customerPainPoints', 'customerCases', 'contactInfo', 'derivedKeywords',
    ];
    const candidates = [
      ...Array.from({ length: 490 }, (_, index) =>
        source({ id: `c-products-${index}`, predicate: 'enterprise-profile.products' })),
      ...otherFields.map((field) =>
        source({ id: `c-${field}`, predicate: `enterprise-profile.${field}` })),
    ].map(toKnowledgeCardCandidate);
    const card = buildKnowledgeCandidatesCardData({ id: 'material-1', displayName: '大材料' }, candidates);
    const selectedFields = card!.candidates.map(
      (candidate) => knowledgeFieldKeyOfPredicate(candidate.key.predicate));
    expect(new Set(selectedFields).size).toBe(15);
    expect(selectedFields.filter((field) => field === 'products').length).toBe(486);
    expect(card?.overflowCount).toBe(4);
    expect(card?.overflowByField).toEqual({ products: 4 });
  });

  it('trims the excerpt to a review-sized quote and omits the duplicated raw value', () => {
    // 卡片 JSON 是工具结果正文、随转录进 Agent 上下文：摘录截为复核引用片段
    // （完整摘录留库审计），原始 valueJson 与 normalized 值重复、不再进载荷。
    const projected = toKnowledgeCardCandidate(source({
      source: { materialId: 'material-1', excerpt: '依'.repeat(500), confidence: 0.9, profileProvenance: 'extracted' },
    }));
    expect(projected.source.excerpt).toBe(`${'依'.repeat(KNOWLEDGE_CARD_EXCERPT_MAX_CHARS)}…`);
    expect('valueJson' in projected).toBe(false);
  });

  it('groups candidates into fixed-order field rows, merging same-field candidates', () => {
    const card = buildKnowledgeCandidatesCardData(
      { id: 'material-1', displayName: '资料.md' },
      [
        source({ id: 'c-products', predicate: 'enterprise-profile.products' }),
        source({ id: 'c-fullname' }),
        // 同字段、不同 scope/subject 的多值合并进同一行。
        source({
          id: 'c-products-line',
          predicate: 'enterprise-profile.products',
          key: {
            subject: '鲸跃科技/电动车',
            predicate: 'enterprise-profile.products',
            scopeJson: '{"entityScope":"product-line","productLine":"电动车"}',
            effectiveFrom: null,
            effectiveTo: null,
          },
        }),
        source({ id: 'c-custom', predicate: 'crm.seatCount' }),
      ].map(toKnowledgeCardCandidate),
    );
    const rows = buildKnowledgeFieldRows(card!);
    // 固定字段序：fullName 先于 products；未知 predicate 按首现顺序排在已知字段之后。
    expect(rows.map((row) => row.field)).toEqual(['fullName', 'products', 'crm.seatCount']);
    expect(rows[1].candidates.map((candidate) => candidate.id))
      .toEqual(['c-products', 'c-products-line']);
    expect(rows.every((row) => row.overflowCount === 0)).toBe(true);
  });

  // 回归：knowledge identity 入库时 predicate 被统一小写化（serviceArea →
  // servicearea），分组键必须大小写不敏感归一为规范字段 token；否则
  // 「服务区域」会以 `enterprise-profile.servicearea` 裸 key 单独成行。
  it('normalizes lowercased profile predicates onto the canonical field rows', () => {
    const card = buildKnowledgeCandidatesCardData(
      { id: 'material-1', displayName: '资料.md' },
      [
        source({ id: 'c-addresses', predicate: 'enterprise-profile.addresses' }),
        source({ id: 'c-servicearea', predicate: 'enterprise-profile.servicearea' }),
        source({ id: 'c-servicearea-camel', predicate: 'enterprise-profile.serviceArea' }),
      ].map(toKnowledgeCardCandidate),
    );
    const rows = buildKnowledgeFieldRows(card!);
    expect(rows.map((row) => row.field)).toEqual(['addresses', 'serviceArea']);
    expect(rows[1].candidates.map((candidate) => candidate.id))
      .toEqual(['c-servicearea', 'c-servicearea-camel']);
  });

  it('attributes truncated overflow to the specific field rows instead of a card-level count', () => {
    // 2 条 fullName + 55 条 products（超总量 7 条）：products 按自然分布占满
    // 剩余预算，fullName 不受影响；溢出全部归因到 products。
    const candidates = [
      ...Array.from({ length: 2 }, (_, index) =>
        source({ id: `c-fullname-${index}` })),
      ...Array.from({ length: KNOWLEDGE_CARD_MAX_CANDIDATES + 5 }, (_, index) =>
        source({ id: `c-products-${index}`, predicate: 'enterprise-profile.products' })),
    ].map(toKnowledgeCardCandidate);
    const card = buildKnowledgeCandidatesCardData({ id: 'material-1', displayName: '大材料' }, candidates);
    expect(card?.overflowCount).toBe(7);
    expect(card?.overflowByField).toEqual({ products: 7 });
    const rows = buildKnowledgeFieldRows(card!);
    expect(rows.find((row) => row.field === 'fullName')?.overflowCount).toBe(0);
    expect(rows.find((row) => row.field === 'products')?.overflowCount).toBe(7);
  });
});
