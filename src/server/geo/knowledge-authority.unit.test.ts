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
});
