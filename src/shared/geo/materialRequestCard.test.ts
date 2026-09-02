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
      skipTarget: null,
    });
  });

  it('falls back to a default reason for blank input so the card always renders', () => {
    expect(buildMaterialRequestCardData('   ').reason).toBe('请补充品牌材料');
  });

  it('embeds the skip-exit operation anchor when the card is issued while parked at material collection', () => {
    // 跳过出口（票 07）：卡片发出时锚定停在材料收集步骤的操作身份，
    // 跳过动作据此发起 revision CAS 的计划替换。
    expect(
      buildMaterialRequestCardData('需要补充品牌材料。', {
        operationId: 'operation-07',
        expectedRevision: 7,
      }).skipTarget,
    ).toEqual({ operationId: 'operation-07', expectedRevision: 7 });
    // 计划外补材料入口：无操作可跳过，锚点为 null，卡片照常承载上传。
    expect(buildMaterialRequestCardData('需要补充品牌材料。').skipTarget).toBeNull();
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

  it('keeps parsing legacy cards without a skip target (计划外入口不受影响)', () => {
    const legacy = parseMaterialRequestCard(
      JSON.stringify({
        kind: 'material-request-card',
        requiresUserDecision: true,
        reason: '存量转录里的卡片。',
      }),
    );
    expect(legacy).not.toBeNull();
    expect(legacy?.skipTarget).toBeUndefined();
  });

  it('parses a card carrying a skip target', () => {
    const data = buildMaterialRequestCardData('按计划停在材料收集步骤。', {
      operationId: 'operation-07',
      expectedRevision: 3,
    });
    expect(parseMaterialRequestCard(JSON.stringify(data))).toEqual(data);
  });

  it('rejects malformed skip targets instead of rendering a broken skip action', () => {
    for (const skipTarget of [
      'operation-07',
      7,
      {},
      { operationId: '', expectedRevision: 3 },
      { operationId: 'operation-07' },
      { operationId: 'operation-07', expectedRevision: 0 },
      { operationId: 'operation-07', expectedRevision: 2.5 },
      { operationId: 'operation-07', expectedRevision: '3' },
    ]) {
      expect(
        parseMaterialRequestCard(
          JSON.stringify({
            kind: 'material-request-card',
            requiresUserDecision: true,
            reason: '按计划停在材料收集步骤。',
            skipTarget,
          }),
        ),
        `skipTarget=${JSON.stringify(skipTarget)}`,
      ).toBeNull();
    }
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
