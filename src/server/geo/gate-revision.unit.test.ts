import { describe, expect, it } from 'vitest';

import {
  dispatchGateRevision,
  gateRevisionErrorCode,
  GATE_REVISION_GATE_TYPES,
  GATE_REVISION_TOOL_DESCRIPTION,
  GATE_REVISION_TOOL_NAME,
  knowledgeGateRevisionHandler,
  registerGateRevisionHandler,
  validateGateRevisionOperations,
  type GateRevisionContext,
  type GateRevisionOpResult,
} from './gate-revision';

const context: GateRevisionContext = { workspaceId: 'brand-1', sessionId: 'session-1' };

describe('gate revision tool contract', () => {
  it('pins the tool name and the explicit-instruction deletion discipline in the description', () => {
    expect(GATE_REVISION_TOOL_NAME).toBe('revise_gate_content');
    // ADR 0003：工具描述写死「仅基于用户显式指令；不得自行判断删除」。
    expect(GATE_REVISION_TOOL_DESCRIPTION).toContain('仅基于用户显式指令');
    expect(GATE_REVISION_TOOL_DESCRIPTION).toContain('不得自行判断删除');
    expect(GATE_REVISION_TOOL_DESCRIPTION).toContain("user's explicit instruction");
  });

  it('enumerates every existing gate so later gates plug in without contract changes', () => {
    expect(GATE_REVISION_GATE_TYPES).toContain('knowledge');
    expect(GATE_REVISION_GATE_TYPES).toContain('publish-preparation');
  });
});

describe('dispatchGateRevision', () => {
  it('routes operations to the registered gate handler and aggregates per-op receipts', async () => {
    registerGateRevisionHandler('knowledge', async (operations, received) => {
      expect(received).toEqual(context);
      const results: GateRevisionOpResult[] = operations.map((operation) => ({
        action: operation.action,
        ...(operation.targetId ? { targetId: operation.targetId } : {}),
        candidateId: `resolved-${operation.targetId ?? operation.subject}`,
        ok: operation.action !== 'delete',
        status: 'awaiting-confirmation',
      }));
      return results;
    });
    const receipt = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', value: '新值', userInstruction: '行业改成汽车后市场装具' },
      { action: 'delete', targetId: 'candidate-2', userInstruction: '删掉核心产品第三条' },
    ], context);
    expect(receipt).toMatchObject({ kind: 'gate-revision', gate: 'knowledge', ok: false });
    expect(receipt.hint).toContain('已裁决的权威事实');
    expect(receipt.results).toHaveLength(2);
    expect(receipt.results[0]).toMatchObject({ action: 'modify', targetId: 'candidate-1', ok: true });
    expect(receipt.results[1]).toMatchObject({ action: 'delete', targetId: 'candidate-2', ok: false });
  });

  it('returns ok when every operation succeeds', async () => {
    registerGateRevisionHandler('knowledge', async (operations) =>
      operations.map((operation) => ({
        action: operation.action,
        ok: true,
        status: 'awaiting-confirmation',
      })),
    );
    const receipt = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', value: '新值', userInstruction: '改一下' },
    ], context);
    expect(receipt.ok).toBe(true);
    expect(receipt.hint).toBeUndefined();
  });

  it('rejects gates that have no handler yet with a structured not-available receipt', async () => {
    const receipt = await dispatchGateRevision('question-pool', [
      { action: 'delete', targetId: 'question-1', userInstruction: '删掉这个问题' },
    ], context);
    expect(receipt).toMatchObject({
      kind: 'gate-revision',
      gate: 'question-pool',
      ok: false,
      code: 'gate_revision_not_available',
    });
    expect(receipt.results).toEqual([]);
  });

  it('rejects knowledge add operations without the pending card materialId', async () => {
    // 真实知识 handler（前面的用例会临时注册测试替身，这里先恢复参考实现）。
    registerGateRevisionHandler('knowledge', knowledgeGateRevisionHandler);
    const receipt = await dispatchGateRevision('knowledge', [
      {
        action: 'add',
        subject: '品牌',
        predicate: 'enterprise-profile.core-products',
        value: ['隐形车衣'],
        userInstruction: '加一条核心产品：隐形车衣',
      },
    ], context);
    expect(receipt.ok).toBe(false);
    expect(receipt.results[0]).toMatchObject({ action: 'add', ok: false, code: 'material_required' });
    expect(receipt.results[0].error).toContain('propose_brand_fact');
  });

  it('rejects unknown gate types without touching any handler', async () => {
    const receipt = await dispatchGateRevision('billing', [], context);
    expect(receipt).toMatchObject({ kind: 'gate-revision', ok: false, code: 'gate_unknown' });
  });

  it('validates the operation list before dispatch', async () => {
    const invalid = await dispatchGateRevision('knowledge', [], context);
    expect(invalid).toMatchObject({ ok: false, code: 'operations_invalid' });

    const noTarget = await dispatchGateRevision('knowledge', [
      { action: 'delete', userInstruction: '删掉' },
    ], context);
    expect(noTarget.error).toContain('(delete) requires targetId');

    const noValue = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', userInstruction: '改一下' },
    ], context);
    expect(noValue.error).toContain('(modify) requires a value');

    const noInstruction = await dispatchGateRevision('knowledge', [
      { action: 'modify', targetId: 'candidate-1', value: 'x', userInstruction: '' },
    ], context);
    expect(noInstruction.error).toContain("user's verbatim instruction");
  });
});

describe('validateGateRevisionOperations', () => {
  it('bounds the batch size and requires complete add keys', () => {
    const tooMany = Array.from({ length: 21 }, () => ({
      action: 'delete' as const,
      targetId: 'candidate-1',
      userInstruction: '删',
    }));
    expect(validateGateRevisionOperations(tooMany)).toContain('at most 20');

    expect(
      validateGateRevisionOperations([
        { action: 'add', value: 'x', userInstruction: '加一条' },
      ]),
    ).toContain('requires a subject and predicate');
  });
});

describe('gateRevisionErrorCode', () => {
  it('maps authority rejections to structured target codes', () => {
    expect(gateRevisionErrorCode(new Error('knowledge candidate is no longer pending'))).toBe('target_not_pending');
    expect(
      gateRevisionErrorCode(new Error('knowledge candidate does not belong to the current brand Session')),
    ).toBe('target_not_in_session');
    expect(gateRevisionErrorCode(new Error('knowledge candidate not found for this Session'))).toBe('target_not_found');
    expect(gateRevisionErrorCode(new Error('boom'))).toBe('revision_rejected');
  });
});
