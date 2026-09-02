import { describe, expect, it } from 'vitest';

import {
  competitorSourceLinks,
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

describe('竞品类卡片投影的摘录上限（来源链接不齐全回归 2026-08-31）', () => {
  it('keeps every brand url segment alive through the card projection', () => {
    // 实跑：1746 字竞品摘录被 300 字上限截到 301 字，6 家只剩第 1 家有
    // 链接。竞品类投影放宽到 2000 字，非竞品类维持 300 字。
    const names = ['广州蒸旺餐饮管理有限公司', '张仔纪（广州）餐饮管理有限公司', '蒸宫主现蒸排骨饭'];
    const segment = (name: string) =>
      `${name}（广东）：${'证据'.repeat(60)}（来源：https://mill.example/${names.indexOf(name)}）`;
    const excerpt = names.map(segment).join(' … ');
    const projected = toKnowledgeCardCandidate({
      id: 'c1', workspaceId: 'w', sessionId: 's',
      key: { subject: '品牌', predicate: 'enterprise-profile.competitors', scopeJson: '{"entityScope":"brand"}' },
      valueJson: JSON.stringify(names), normalizedValueJson: JSON.stringify(names),
      status: 'awaiting-confirmation', baseVersion: 0, origin: 'model-inferred',
      source: { excerpt, confidence: 0.5, profileProvenance: 'inferred' },
    });
    const links = competitorSourceLinks(projected.source.excerpt);
    expect([...links.keys()]).toEqual(names);
    // 超过 2000 字仍截断（防载荷膨胀），非竞品类仍按 300 字紧凑复核。
    expect(projected.source.excerpt.length).toBeLessThanOrEqual(2_001);
  });
});

describe('competitorSourceLinks（竞品证据摘录 → 每品牌来源链接）', () => {
  it('parses per-brand name and source url from the enrichment excerpt format', () => {
    const links = competitorSourceLinks(
      '张仔纪（广州）餐饮管理有限公司（广东）：干蒸菜服务商汇总（来源：http://m.toutiao.com/group/1）'
      + ' … 街坊蒸神（顺德）：封神探店帖（来源：https://www.sohu.com/a/1_2）',
    );
    expect(links.get('张仔纪（广州）餐饮管理有限公司')).toBe('http://m.toutiao.com/group/1');
    expect(links.get('街坊蒸神')).toBe('https://www.sohu.com/a/1_2');
  });

  it('skips segments without a url and tolerates empty excerpts', () => {
    expect(competitorSourceLinks('某品牌（广州）：无链接证据').size).toBe(0);
    expect(competitorSourceLinks('').size).toBe(0);
    expect(competitorSourceLinks(null).size).toBe(0);
    expect(competitorSourceLinks(undefined).size).toBe(0);
  });
});

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

  it('projects the candidate resolution moment for card-level completion timestamps (票 08)', () => {
    // resolvedAt 是主确认卡「完成时刻」的唯一权威源：Rust 决策事务内写入
    // knowledge_fact_candidates.resolved_at，投影原样透传不换算。
    const projected = toKnowledgeCardCandidate(source({ resolvedAt: '2026-09-02T05:04:03Z' }));
    expect(projected.resolvedAt).toBe('2026-09-02T05:04:03Z');
    // 未裁决候选不带该字段；显式 null 原样保留（缺省而非伪值）。
    expect(toKnowledgeCardCandidate(source()).resolvedAt).toBeUndefined();
    expect(toKnowledgeCardCandidate(source({ resolvedAt: null })).resolvedAt).toBeNull();
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
    // 490 条 products + 其余 15 个已知字段各 1 条（共 505，超总量 5 条）：
    // 不设单字段上限——products 按自然分布拿到 485 条，其余每类保住 1 个格子，
    // 溢出只落在 products 上。
    const otherFields = [
      'fullName', 'shortNames', 'addresses', 'serviceArea', 'industry',
      'relatedBrands', 'competitors', 'potentialCompetitors', 'targetCustomers', 'coreAdvantages',
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
    expect(new Set(selectedFields).size).toBe(16);
    expect(selectedFields.filter((field) => field === 'products').length).toBe(485);
    expect(card?.overflowCount).toBe(5);
    expect(card?.overflowByField).toEqual({ products: 5 });
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

  it('strips legacy metadata headers from competitor excerpts and projects names only', () => {
    // ADR-0007：竞品行只显示名称——旧候选摘录中的版本化审计头剥掉、不投影
    // 任何展示元数据；新事实摘录是纯证据文本，无头即原样。
    const projected = toKnowledgeCardCandidate(source({
      predicate: 'enterprise-profile.competitors',
      valueJson: '["成实外教育","为明教育"]',
      normalizedValueJson: '["成实外教育","为明教育"]',
      source: {
        materialId: 'material-1',
        excerpt: '[[xiaojing-competitor-details:v1]][{"name":"成实外教育","region":"成都","similarBusiness":"民办中学教育"}]\n成都民办中学排名提到成实外教育和为明教育',
        confidence: 0.5,
        profileProvenance: 'inferred',
      },
    }));

    expect('competitorDetails' in projected).toBe(false);
    expect(projected.source.excerpt).toBe('成都民办中学排名提到成实外教育和为明教育');
    expect(projected.source.excerpt).not.toContain('xiaojing-competitor-details');
  });

  it('strips the metadata marker from malformed headers instead of leaking it into the excerpt', () => {
    // 头部被截断/坏 JSON 时拿不到展示元数据，但审计标记（DESIGN.md：不得
    // 出现在值或来源证据 UI 中）不能跟着原始摘录漏进卡片。
    const projected = toKnowledgeCardCandidate(source({
      predicate: 'enterprise-profile.competitors',
      source: {
        materialId: 'material-1',
        excerpt: '[[xiaojing-competitor-details:v1]]{"name":"成实外教育"\n成都民办中学排名提到成实外教育',
        confidence: 0.5,
        profileProvenance: 'inferred',
      },
    }));
    expect(projected.source.excerpt).toBe('成都民办中学排名提到成实外教育');
    expect(projected.source.excerpt).not.toContain('xiaojing-competitor-details');
    expect('competitorDetails' in projected).toBe(false);
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

  // ADR-0007 两层名单：数据两层、卡面一栏——potentialCompetitors 候选并入
  // competitors 行（行键只剩 competitors），行内直接层在前、潜在层在后。
  it('merges potential competitors into the single competitors row, direct tier first', () => {
    const card = buildKnowledgeCandidatesCardData(
      { id: 'material-1', displayName: '资料.md' },
      [
        source({ id: 'c-potential-first-payload', predicate: 'enterprise-profile.potentialCompetitors' }),
        source({ id: 'c-fullname', predicate: 'enterprise-profile.fullName' }),
        source({ id: 'c-competitors', predicate: 'enterprise-profile.competitors' }),
        source({ id: 'c-potential', predicate: 'enterprise-profile.potentialCompetitors' }),
      ].map(toKnowledgeCardCandidate),
    );
    const rows = buildKnowledgeFieldRows(card!);
    expect(rows.map((row) => row.field)).toEqual(['fullName', 'competitors']);
    expect(rows[1].candidates.map((candidate) => candidate.id))
      .toEqual(['c-competitors', 'c-potential-first-payload', 'c-potential']);
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
