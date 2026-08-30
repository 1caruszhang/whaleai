import { describe, expect, it } from 'vitest';

import {
  decodeCompetitorEvidence,
  formatCompetitorFactValue,
} from './competitorDetails';

/** ADR-0007：编码已退役，存量头以字面构造（读侧兼容是唯一的持久契约）。 */
function legacyHeader(details: string, evidence: string): string {
  return `[[xiaojing-competitor-details:v1]]${details}\n${evidence}`;
}

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

  it('decodes details and evidence from well-formed legacy headers', () => {
    expect(decodeCompetitorEvidence(legacyHeader(
      '[{"name":"云帆信息","region":"成都","similarBusiness":"智能客服"}]',
      '成都智能客服榜单提到云帆信息',
    ))).toEqual({
      details: [{ name: '云帆信息', region: '成都', similarBusiness: '智能客服' }],
      evidence: '成都智能客服榜单提到云帆信息',
    });
  });

  it('returns the excerpt as-is when no legacy header is present (new facts)', () => {
    expect(decodeCompetitorEvidence('云帆信息（成都）：榜单快照证据'))
      .toEqual({ details: [], evidence: '云帆信息（成都）：榜单快照证据' });
  });
});

describe('formatCompetitorFactValue', () => {
  it('merges per-source metadata and keeps unknown names as plain names', () => {
    const excerpts = [
      legacyHeader(
        '[{"name":"云帆信息","region":"成都","similarBusiness":"智能客服"}]',
        '来源一',
      ),
      legacyHeader(
        '[{"name":"星河智能","region":"绵阳","similarBusiness":"智能客服"}]',
        '来源二',
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
