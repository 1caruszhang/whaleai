import { describe, expect, it } from 'vitest';

import {
  KnowledgeAuthority,
  classifyKnowledgeCandidate,
  normalizeFactKey,
  normalizeFactValue,
  type KnowledgeAuthorityPort,
  type KnowledgeCandidate,
  type KnowledgeCurrentFact,
} from './knowledge-authority';

function current(overrides: Partial<KnowledgeCurrentFact> = {}): KnowledgeCurrentFact {
  return {
    key: normalizeFactKey({ subject: '品牌', predicate: '价格' }),
    normalizedValueJson: '100',
    unit: 'cny',
    version: 3,
    confirmedBy: 'user-1',
    confirmedAt: '2026-08-15T00:00:00.000Z',
    sources: [],
    ...overrides,
  };
}

type CandidateSubmission = Parameters<KnowledgeAuthorityPort['submit']>[0];

function fakePort(active: KnowledgeCurrentFact | null): KnowledgeAuthorityPort & {
  submissions: CandidateSubmission[];
} {
  const submissions: CandidateSubmission[] = [];
  return {
    submissions,
    current: async () => active,
    submit: async (request) => {
      submissions.push(request);
      return { id: 'candidate-1', status: request.disposition, current: active, proposedAt: 'now', baseVersion: request.expectedCurrentVersion, ...request } as KnowledgeCandidate;
    },
    candidate: async () => { throw new Error('not needed'); },
    decide: async () => { throw new Error('not needed'); },
    revise: async () => { throw new Error('not needed'); },
  };
}

type DecisionRequest = Parameters<KnowledgeAuthorityPort['decide']>[0];

/** decide 策略测试端口：固定候选，记录决策请求。 */
function decidePort(candidateOverrides: Partial<KnowledgeCandidate> = {}): KnowledgeAuthorityPort & {
  decisions: DecisionRequest[];
} {
  const decisions: DecisionRequest[] = [];
  const candidate: KnowledgeCandidate = {
    id: 'candidate-edit-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    key: normalizeFactKey({ subject: '品牌', predicate: '价格' }),
    valueJson: '"100 元"',
    normalizedValueJson: '"100元"',
    unit: null,
    source: { excerpt: '价格 100 元', confidence: 0.9 },
    origin: 'model-inferred',
    intent: 'knowledge-update',
    status: 'conflict',
    baseVersion: 2,
    proposedAt: '2026-08-15T00:00:00Z',
    current: null,
    ...candidateOverrides,
  };
  return {
    decisions,
    current: async () => candidate.current ?? null,
    submit: async () => { throw new Error('not needed'); },
    candidate: async (id) => (id === candidate.id ? candidate : { ...candidate, id }),
    decide: async (request) => {
      decisions.push(request);
      return {
        candidateId: request.candidateId,
        factKey: candidate.key.identity,
        decision: request.decision,
        status: 'adopted',
        current: null,
        knowledgeVersion: 4,
        affectedArtifacts: [],
      };
    },
    revise: async () => { throw new Error('not needed'); },
  };
}

type RevisionRequest = Parameters<KnowledgeAuthorityPort['revise']>[0];

/** 修订策略测试端口：固定候选，记录修订请求并模拟 Rust 侧落库结果。 */
function revisionPort(candidateOverrides: Partial<KnowledgeCandidate> = {}): KnowledgeAuthorityPort & {
  revisions: RevisionRequest[];
} {
  const revisions: RevisionRequest[] = [];
  const candidate: KnowledgeCandidate = {
    id: 'candidate-revise-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    key: normalizeFactKey({ subject: '品牌', predicate: 'enterprise-profile.industry' }),
    valueJson: '"汽车改装"',
    normalizedValueJson: '"汽车改装"',
    unit: null,
    source: { excerpt: '行业：汽车改装', confidence: 0.9, profileProvenance: 'inferred' },
    origin: 'model-inferred',
    intent: 'knowledge-update',
    status: 'awaiting-confirmation',
    baseVersion: 0,
    proposedAt: '2026-08-15T00:00:00Z',
    current: null,
    ...candidateOverrides,
  };
  return {
    revisions,
    current: async () => candidate.current ?? null,
    submit: async () => { throw new Error('not needed'); },
    candidate: async (id) => (id === candidate.id ? candidate : { ...candidate, id }),
    decide: async () => { throw new Error('not needed'); },
    revise: async (request) => {
      revisions.push(request);
      if (request.action === 'add') {
        const submission = request.submission!;
        return {
          id: 'candidate-added-1',
          status: submission.disposition,
          current: null,
          proposedAt: 'now',
          baseVersion: submission.expectedCurrentVersion,
          ...submission,
        } as KnowledgeCandidate;
      }
      return {
        ...candidate,
        ...(request.action === 'modify'
          ? {
              valueJson: request.valueJson ?? candidate.valueJson,
              normalizedValueJson: request.normalizedValueJson ?? candidate.normalizedValueJson,
              unit: request.unit ?? null,
              source: { ...candidate.source, profileProvenance: 'asked' },
            }
          : {}),
        status: request.action === 'delete' ? 'rejected' : 'awaiting-confirmation',
      };
    },
  };
}

describe('KnowledgeAuthority policy', () => {
  it('uses subject/predicate/scope/effective time as the deterministic fact identity', () => {
    const cn = normalizeFactKey({ subject: ' 品牌 ', predicate: '价格', scope: { region: 'CN' } });
    const us = normalizeFactKey({ subject: '品牌', predicate: '价格', scope: { region: 'US' } });
    const future = normalizeFactKey({ subject: '品牌', predicate: '价格', scope: { region: 'CN' }, effectiveFrom: '2027-01-01' });
    expect(new Set([cn.identity, us.identity, future.identity]).size).toBe(3);
    expect(cn.subject).toBe('品牌');
    expect(cn.scopeJson).toBe('{"region":"CN"}');
  });

  it('normalizes equivalent values and units before comparing', () => {
    expect(normalizeFactValue(' 旗舰   产品 ', '人民币')).toEqual({
      valueJson: '" 旗舰   产品 "',
      normalizedValueJson: '"旗舰 产品"',
      unit: 'cny',
    });
  });

  it('keeps equal sources behind confirmation and flags unequal values as conflicts', () => {
    expect(classifyKnowledgeCandidate(current(), '100', 'cny', 'user-stated', 'knowledge-update')).toBe('awaiting-confirmation');
    expect(classifyKnowledgeCandidate(current(), '120', 'cny', 'user-stated', 'knowledge-update')).toBe('conflict');
  });

  it('never lets model inference or ordinary chat mutate authority even when the value matches', async () => {
    const port = fakePort(current());
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    const candidate = await authority.propose({
      rawInput: '聊天里推测价格可能还是 100 元',
      origin: 'model-inferred',
      intent: 'chat-observation',
      key: { subject: '品牌', predicate: '价格' },
      value: 100,
      unit: '元',
      source: { excerpt: '推测价格可能还是 100 元', confidence: 0.6 },
    });
    expect(candidate.status).toBe('awaiting-confirmation');
    expect(port.submissions[0].disposition).toBe('awaiting-confirmation');
  });

  it('normalizes the user-edited value before submitting an adopt-edited decision', async () => {
    const port = decidePort();
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    await authority.decide({
      candidateId: 'candidate-edit-1',
      decision: 'adopt-edited',
      expectedCurrentVersion: 2,
      actorId: 'desktop-user',
      editedValue: [' 旗舰   产品 ', '高端 版本'],
    });
    expect(port.decisions[0]).toMatchObject({
      candidateId: 'candidate-edit-1',
      decision: 'adopt-edited',
      editedNormalizedValueJson: '["旗舰 产品","高端 版本"]',
    });
  });

  it('rejects adopt-edited without a value and other decisions carrying one', async () => {
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, decidePort());
    await expect(authority.decide({
      candidateId: 'candidate-edit-1',
      decision: 'adopt-edited',
      expectedCurrentVersion: 2,
      actorId: 'desktop-user',
    })).rejects.toThrow('adopt-edited requires an edited value');
    await expect(authority.decide({
      candidateId: 'candidate-edit-1',
      decision: 'adopt-new',
      expectedCurrentVersion: 2,
      actorId: 'desktop-user',
      editedValue: '95',
    })).rejects.toThrow('editedValue is only valid for adopt-edited');
  });

  it('hydrates only candidates owned by the current brand session', async () => {
    const port = decidePort();
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    await expect(authority.candidate('candidate-edit-1')).resolves.toMatchObject({ id: 'candidate-edit-1' });
    const foreign = new KnowledgeAuthority({ workspaceId: 'brand-2', sessionId: 'session-1' }, port);
    await expect(foreign.candidate('candidate-edit-1')).rejects.toThrow('does not belong to the current brand Session');
  });
});

describe('KnowledgeAuthority array supplement merge', () => {
  const arrayCurrent = (items: string[], overrides: Partial<KnowledgeCurrentFact> = {}): KnowledgeCurrentFact =>
    current({ normalizedValueJson: JSON.stringify(items), unit: null, ...overrides });

  it('classifies array-vs-array differences as supplements, never conflicts', () => {
    const base = arrayCurrent(['隐形车衣', '改色膜']);
    expect(classifyKnowledgeCandidate(base, '["隐形车衣","改色膜","太阳膜"]', null, 'model-inferred', 'knowledge-update')).toBe('awaiting-confirmation');
    expect(classifyKnowledgeCandidate(base, '["改色膜"]', null, 'user-stated', 'knowledge-update')).toBe('awaiting-confirmation');
  });

  it('keeps scalar differences and type mismatches as conflicts', () => {
    expect(classifyKnowledgeCandidate(current(), '120', 'cny', 'user-stated', 'knowledge-update')).toBe('conflict');
    // 一边数组一边标量：类型不一致，仍走冲突二选一
    expect(classifyKnowledgeCandidate(arrayCurrent(['隐形车衣']), '"隐形车衣"', null, 'user-stated', 'knowledge-update')).toBe('conflict');
    expect(classifyKnowledgeCandidate(current(), '["100"]', null, 'user-stated', 'knowledge-update')).toBe('conflict');
  });

  it('rewrites an array candidate to the deduped union, current order first', async () => {
    const port = fakePort(arrayCurrent(['隐形车衣', '改色膜']));
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    const candidate = await authority.propose({
      rawInput: '材料补充核心产品',
      origin: 'model-inferred',
      intent: 'knowledge-update',
      key: { subject: '品牌', predicate: 'enterprise-profile.core-products' },
      value: [' 改色膜 ', '太阳膜'],
      source: { excerpt: '核心产品：改色膜、太阳膜', confidence: 0.8 },
    });
    // 「 改色膜 」规范化后与 current 去重，新增「太阳膜」追加在旧值之后
    expect(candidate.status).toBe('awaiting-confirmation');
    expect(port.submissions[0]).toMatchObject({
      disposition: 'awaiting-confirmation',
      valueJson: '["隐形车衣","改色膜","太阳膜"]',
      normalizedValueJson: '["隐形车衣","改色膜","太阳膜"]',
    });
  });

  it('falls back to the same-value path when the candidate adds nothing new', async () => {
    const port = fakePort(arrayCurrent(['隐形车衣', '改色膜']));
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    await authority.propose({
      rawInput: '重复补充核心产品',
      origin: 'model-inferred',
      intent: 'knowledge-update',
      key: { subject: '品牌', predicate: 'enterprise-profile.core-products' },
      value: ['改色膜', ' 隐形车衣 '],
      source: { excerpt: '核心产品：改色膜、隐形车衣', confidence: 0.8 },
    });
    // 并集与 current 完全相同（顺序也回落到 current 原序）→ 沿用既有
    // same 逻辑：仍落待确认候选，整卡确认后仅合并来源、不升事实版本。
    expect(port.submissions[0]).toMatchObject({
      disposition: 'awaiting-confirmation',
      normalizedValueJson: '["隐形车衣","改色膜"]',
    });
  });

  it('adopt-new of an array supplement lands the union as the new current', async () => {
    const base = arrayCurrent(['隐形车衣'], { version: 2 });
    let stored: KnowledgeCandidate | null = null;
    const port: KnowledgeAuthorityPort = {
      current: async () => base,
      submit: async (request) => {
        stored = {
          id: 'candidate-merge-1',
          status: request.disposition,
          proposedAt: 'now',
          baseVersion: request.expectedCurrentVersion,
          current: base,
          ...request,
        } as KnowledgeCandidate;
        return stored;
      },
      candidate: async () => stored!,
      // 模拟 Rust adopt-new：异值采纳写候选值并升版本
      decide: async (request) => ({
        candidateId: request.candidateId,
        factKey: stored!.key.identity,
        decision: request.decision,
        status: 'adopted',
        current: { ...base, normalizedValueJson: stored!.normalizedValueJson, version: base.version + 1 },
        knowledgeVersion: 5,
        affectedArtifacts: [],
      }),
      revise: async () => { throw new Error('not needed'); },
    };
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    const candidate = await authority.propose({
      rawInput: '补充核心产品太阳膜',
      origin: 'model-inferred',
      intent: 'knowledge-update',
      key: { subject: '品牌', predicate: 'enterprise-profile.core-products' },
      value: ['隐形车衣', '太阳膜'],
      source: { excerpt: '核心产品：隐形车衣、太阳膜', confidence: 0.8 },
    });
    expect(candidate.status).toBe('awaiting-confirmation');
    const result = await authority.decide({
      candidateId: candidate.id,
      decision: 'adopt-new',
      expectedCurrentVersion: 2,
      actorId: 'desktop-user',
    });
    expect(result.current?.normalizedValueJson).toBe('["隐形车衣","太阳膜"]');
    expect(result.current?.version).toBe(3);
  });

  it('merges array values on revision add as well', async () => {
    const port = revisionPort({ current: arrayCurrent(['隐形车衣']) });
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    await authority.revise({
      action: 'add',
      key: { subject: '品牌', predicate: 'enterprise-profile.core-products' },
      value: ['隐形车衣', '太阳膜'],
      reason: '加一条核心产品：太阳膜',
      actorId: 'desktop-user',
    });
    expect(port.revisions[0].submission).toMatchObject({
      disposition: 'awaiting-confirmation',
      normalizedValueJson: '["隐形车衣","太阳膜"]',
    });
  });
});

describe('KnowledgeAuthority chat revision', () => {
  it('modifies a pending candidate through the normalization pipeline', async () => {
    const port = revisionPort();
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    const outcome = await authority.revise({
      action: 'modify',
      candidateId: 'candidate-revise-1',
      value: [' 汽车   改装 ', '贴膜'],
      reason: '行业改成汽车后市场装具',
      actorId: 'desktop-user',
    });
    expect(port.revisions[0]).toMatchObject({
      action: 'modify',
      candidateId: 'candidate-revise-1',
      actorId: 'desktop-user',
      reason: '行业改成汽车后市场装具',
      valueJson: '[" 汽车   改装 ","贴膜"]',
      normalizedValueJson: '["汽车 改装","贴膜"]',
    });
    expect(outcome).toMatchObject({ action: 'modify', candidateId: 'candidate-revise-1', status: 'awaiting-confirmation' });
  });

  it('normalizes the unit on modify and falls back to the candidate unit', async () => {
    const port = revisionPort();
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    await authority.revise({
      action: 'modify',
      candidateId: 'candidate-revise-1',
      value: 100,
      unit: '人民币',
      reason: '价格改成 100',
      actorId: 'desktop-user',
    });
    expect(port.revisions[0]).toMatchObject({ unit: 'cny', normalizedValueJson: '100' });
  });

  it('accepts conflict candidates for revision but rejects terminal ones', async () => {
    const conflict = new KnowledgeAuthority(
      { workspaceId: 'brand-1', sessionId: 'session-1' },
      revisionPort({ status: 'conflict', current: current() }),
    );
    await expect(conflict.revise({
      action: 'modify',
      candidateId: 'candidate-revise-1',
      value: '汽车后市场装具',
      reason: '行业改成汽车后市场装具',
      actorId: 'desktop-user',
    })).resolves.toMatchObject({ status: 'awaiting-confirmation' });

    const adopted = new KnowledgeAuthority(
      { workspaceId: 'brand-1', sessionId: 'session-1' },
      revisionPort({ status: 'adopted' }),
    );
    await expect(adopted.revise({
      action: 'modify',
      candidateId: 'candidate-revise-1',
      value: '汽车后市场装具',
      reason: '行业改成汽车后市场装具',
      actorId: 'desktop-user',
    })).rejects.toThrow('knowledge candidate is no longer pending');
    await expect(adopted.revise({
      action: 'delete',
      candidateId: 'candidate-revise-1',
      reason: '删掉这条',
      actorId: 'desktop-user',
    })).rejects.toThrow('knowledge candidate is no longer pending');
  });

  it('revises only candidates owned by the current brand session', async () => {
    const port = revisionPort();
    const foreign = new KnowledgeAuthority({ workspaceId: 'brand-2', sessionId: 'session-1' }, port);
    await expect(foreign.revise({
      action: 'delete',
      candidateId: 'candidate-revise-1',
      reason: '删掉这条',
      actorId: 'desktop-user',
    })).rejects.toThrow('does not belong to the current brand Session');
    expect(port.revisions).toHaveLength(0);
  });

  it('deletes a pending candidate and forwards the user instruction as the audit reason', async () => {
    const port = revisionPort();
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    const outcome = await authority.revise({
      action: 'delete',
      candidateId: 'candidate-revise-1',
      reason: '删掉核心产品第三条',
      actorId: 'desktop-user',
    });
    expect(port.revisions[0]).toMatchObject({
      action: 'delete',
      candidateId: 'candidate-revise-1',
      actorId: 'desktop-user',
      reason: '删掉核心产品第三条',
    });
    expect(outcome).toMatchObject({ action: 'delete', status: 'rejected' });
  });

  it('adds a user-stated asked candidate through propose semantics', async () => {
    const port = revisionPort();
    const authority = new KnowledgeAuthority({ workspaceId: 'brand-1', sessionId: 'session-1' }, port);
    const outcome = await authority.revise({
      action: 'add',
      key: { subject: '品牌', predicate: 'enterprise-profile.core-products' },
      value: ['隐形车衣'],
      reason: '加一条核心产品：隐形车衣',
      actorId: 'desktop-user',
      materialId: 'material-1',
    });
    expect(port.revisions).toHaveLength(1);
    expect(port.revisions[0]).toMatchObject({
      action: 'add',
      actorId: 'desktop-user',
      reason: '加一条核心产品：隐形车衣',
      submission: {
        workspaceId: 'brand-1',
        sessionId: 'session-1',
        rawInput: '加一条核心产品：隐形车衣',
        origin: 'user-stated',
        intent: 'knowledge-update',
        normalizedValueJson: '["隐形车衣"]',
        disposition: 'awaiting-confirmation',
        source: {
          materialId: 'material-1',
          profileProvenance: 'asked',
          confidence: 1,
        },
      },
    });
    expect(outcome).toMatchObject({ action: 'add', candidateId: 'candidate-added-1', status: 'awaiting-confirmation' });
  });

  it('rejects revisions without the user instruction', async () => {
    const authority = new KnowledgeAuthority(
      { workspaceId: 'brand-1', sessionId: 'session-1' },
      revisionPort(),
    );
    await expect(authority.revise({
      action: 'delete',
      candidateId: 'candidate-revise-1',
      reason: '   ',
      actorId: 'desktop-user',
    })).rejects.toThrow('knowledge revision requires the user\'s explicit instruction');
  });
});
