import { describe, expect, it } from 'vitest';

import {
  decodeCompetitorEvidence,
  encodeCompetitorEvidence,
  formatCompetitorFactValue,
} from './competitorDetails';

describe('encodeCompetitorEvidence', () => {
  it('clamps the evidence text so the encoded excerpt stays within the caller budget', () => {
    const encoded = encodeCompetitorEvidence(
      [{ name: '云帆信息', region: '成都', similarBusiness: '智能客服' }],
      '证'.repeat(500),
      120,
    );
    expect(encoded.length).toBeLessThanOrEqual(120);
    expect(encoded.startsWith('[[xiaojing-competitor-details:v1]]')).toBe(true);
    expect(encoded).toContain('"region":"成都"');
    expect(decodeCompetitorEvidence(encoded).evidence.length).toBeGreaterThan(0);
  });

  it('returns the plain trimmed evidence when no details survive normalization', () => {
    expect(
      encodeCompetitorEvidence([], '  证据文本  ', 4_000),
    ).toBe('证据文本');
  });
});

describe('decodeCompetitorEvidence', () => {
  it('keeps malformed headers out of the projected evidence', () => {
    // 头部坏 JSON / 截断：展示元数据弃用，审计标记不得漏出（DESIGN.md）。
    expect(decodeCompetitorEvidence(
      '[[xiaojing-competitor-details:v1]]{"name":\n真实证据文本',
    )).toEqual({ details: [], evidence: '真实证据文本' });

    // 规范化后无有效条目：同样只回退纯证据文本。
    expect(decodeCompetitorEvidence(
      '[[xiaojing-competitor-details:v1]][{"name":" ","region":"成都","similarBusiness":"x"}]\n证据',
    )).toEqual({ details: [], evidence: '证据' });

    // 只有头部、没有换行：不存在证据部分，宁空不漏标记。
    expect(decodeCompetitorEvidence('[[xiaojing-competitor-details:v1]]{bad'))
      .toEqual({ details: [], evidence: '' });
  });

  it('round-trips details and evidence for well-formed headers', () => {
    const encoded = encodeCompetitorEvidence(
      [{ name: '云帆信息', region: '成都', similarBusiness: '智能客服' }],
      '成都智能客服榜单提到云帆信息',
      4_000,
    );
    expect(decodeCompetitorEvidence(encoded)).toEqual({
      details: [{ name: '云帆信息', region: '成都', similarBusiness: '智能客服' }],
      evidence: '成都智能客服榜单提到云帆信息',
    });
  });
});

describe('formatCompetitorFactValue', () => {
  it('merges per-source metadata and keeps unknown names as plain names', () => {
    const excerpts = [
      encodeCompetitorEvidence(
        [{ name: '云帆信息', region: '成都', similarBusiness: '智能客服' }],
        '来源一',
        4_000,
      ),
      encodeCompetitorEvidence(
        [{ name: '星河智能', region: '绵阳', similarBusiness: '智能客服' }],
        '来源二',
        4_000,
      ),
      '旧事实来源：仅审计文本，无元数据头',
    ];
    expect(formatCompetitorFactValue(
      ['云帆信息', '新锐科技', '星河智能'],
      excerpts,
    )).toEqual([
      '云帆信息｜成都｜智能客服',
      '新锐科技',
      '星河智能｜绵阳｜智能客服',
    ]);
  });
});
