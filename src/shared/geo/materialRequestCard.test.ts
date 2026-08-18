import { describe, expect, it } from 'vitest';

import {
  buildMaterialRequestCardData,
  MATERIAL_REQUEST_REASON_MAX_CHARS,
  parseMaterialRequestCard,
} from './materialRequestCard';

describe('buildMaterialRequestCardData', () => {
  it('trims and bounds the agent reason to the card limit', () => {
    const data = buildMaterialRequestCardData(`  ${'长'.repeat(MATERIAL_REQUEST_REASON_MAX_CHARS + 5)}  `);
    expect(data).toEqual({
      kind: 'material-request-card',
      requiresUserDecision: true,
      reason: '长'.repeat(MATERIAL_REQUEST_REASON_MAX_CHARS),
    });
  });

  it('falls back to a default reason for blank input so the card always renders', () => {
    expect(buildMaterialRequestCardData('   ').reason).toBe('请补充品牌材料');
  });
});

describe('parseMaterialRequestCard', () => {
  it('parses a well-formed tool result and unwraps content-block shells', () => {
    const data = buildMaterialRequestCardData('还没有已确认的品牌知识，先补充材料再推进计划。');
    expect(parseMaterialRequestCard(JSON.stringify(data))).toEqual(data);
    expect(
      parseMaterialRequestCard(JSON.stringify([{ type: 'text', text: JSON.stringify(data) }])),
    ).toEqual(data);
  });

  it('rejects other kinds, missing decision flag, and malformed payloads', () => {
    expect(parseMaterialRequestCard(JSON.stringify({ kind: 'knowledge-candidates-card' }))).toBeNull();
    expect(
      parseMaterialRequestCard(JSON.stringify({ kind: 'material-request-card', requiresUserDecision: false, reason: 'x' })),
    ).toBeNull();
    expect(
      parseMaterialRequestCard(JSON.stringify({ kind: 'material-request-card', requiresUserDecision: true, reason: '' })),
    ).toBeNull();
    expect(parseMaterialRequestCard('not json')).toBeNull();
  });
});
