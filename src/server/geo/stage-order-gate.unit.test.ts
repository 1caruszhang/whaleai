import { describe, expect, it } from 'vitest';
import {
  planGeoOperation,
  type GeoOperationProjection,
  type GeoOperationStep,
} from '../../shared/geo/operation';
import { GEO_NEXT_STEP_GUIDES, quoteGeoNextStep } from './operation-progress';
import {
  assessStageToolOrder,
  GEO_STAGE_ORDER_GATED_TOOLS,
  type GeoStageOrderRejection,
} from './stage-order-gate';

/**
 * 顺序闸的纯裁决（票 #05，spec 2026-09-02 决策 4）：五个有后果阶段工具
 * 的入口校验——放行口径是「任一本会话非终态操作的当前步恰引述被调工具」，
 * 越序拒绝复用 next-step 引述结构（当前步 + 应调工具 + 一句话指引），
 * 无非终态操作指路先建操作；用户门与外部通道步骤以 heldStep 拒绝并指引
 * 等待。步骤形状全部取自 planGeoOperation 的真实计划，不手抄 step-id。
 */

function planSteps(input: Parameters<typeof planGeoOperation>[0]): GeoOperationStep[] {
  return structuredClone(planGeoOperation(input).steps);
}

/** 标记计划序上到 lastSucceededId（含）的步骤为已走完。 */
function progressedThrough(
  steps: GeoOperationStep[],
  lastSucceededId: string,
): GeoOperationStep[] {
  const last = steps.findIndex((step) => step.id === lastSucceededId);
  expect(last).toBeGreaterThanOrEqual(0);
  return steps.map((step, index) =>
    index <= last ? { ...step, status: 'succeeded' as const } : { ...step },
  );
}

function operationOf(
  steps: GeoOperationStep[],
  overrides: Partial<GeoOperationProjection> = {},
): GeoOperationProjection {
  return {
    id: 'op-gate-1',
    workspaceId: 'brand-a',
    sessionId: 'session-gate',
    kind: 'full-optimization',
    goal: '一轮完整的 GEO 优化',
    status: 'running',
    steps,
    inputRefs: [],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    updateKnowledge: null,
    revision: 7,
    executionGeneration: 1,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:10:00Z',
    terminalAt: null,
    ...overrides,
  };
}

function outOfOrder(
  rejection: GeoStageOrderRejection | null,
): Extract<GeoStageOrderRejection, { error: 'geo_stage_tool_out_of_order' }> {
  expect(rejection).not.toBeNull();
  expect(rejection!.kind).toBe('geo-stage-order-gate');
  expect(rejection!.ok).toBe(false);
  expect(rejection!.error).toBe('geo_stage_tool_out_of_order');
  return rejection as Extract<
    GeoStageOrderRejection,
    { error: 'geo_stage_tool_out_of_order' }
  >;
}

describe('GEO_STAGE_ORDER_GATED_TOOLS scope', () => {
  it('pins the gate to exactly the five consequential stage tools', () => {
    // 只读查询（inspect_*）与材料类工具（request/import/retry_brand_material）
    // 不在列：闸不拦「先重读操作状态」与计划外补材料。
    expect([...GEO_STAGE_ORDER_GATED_TOOLS]).toEqual([
      'run_question_pool',
      'plan_topics',
      'generate_articles',
      'plan_distribution',
      'prepare_publish',
    ]);
  });
});

describe('assessStageToolOrder allow path', () => {
  it('allows the tool quoted for the current step of a full-chain round', () => {
    const operation = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'confirm-knowledge'),
    );
    // 知识链走完 → 当前步 generate-question-pool → run_question_pool 放行。
    expect(assessStageToolOrder('run_question_pool', [operation])).toBeNull();
  });

  it('allows the reuse-round pool-selection step (no-knowledge-update shape)', () => {
    const operation = operationOf(
      progressedThrough(
        planSteps({ intent: 'next-round-optimization', goal: '下一轮优化', updateKnowledge: false }),
        'acknowledge-plan',
      ),
      { updateKnowledge: false },
    );
    // 归一（票 02）后的首工作步 select-next-question-pool 也引述
    // run_question_pool——复用停卡重选是合法当前步。
    expect(assessStageToolOrder('run_question_pool', [operation])).toBeNull();
  });

  it('does not reject a taken-over round: ownership is the session-scoped list', () => {
    // 接管后 Rust 把操作 sessionId 改到本会话，会话作用域 list 自然带它；
    // 闸只裁决「名单内操作的当前步」，不按历史所有者误拒（票 #05）。
    const operation = operationOf(
      progressedThrough(
        planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化', updateKnowledge: false }),
        'acknowledge-plan',
      ),
      { takenOverFromSessionId: 'session-old', takenOverAt: '2026-09-02T00:08:00Z' },
    );
    expect(assessStageToolOrder('run_question_pool', [operation])).toBeNull();
  });

  it('stays lenient across concurrent rounds: any matching current step allows', () => {
    const olderAtQuestions = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'confirm-knowledge'),
      { id: 'op-older', updatedAt: '2026-09-02T00:05:00Z' },
    );
    const newerAtTopics = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'confirm-question-selection'),
      { id: 'op-newer', updatedAt: '2026-09-02T00:09:00Z' },
    );
    // 多轮并存从宽：任一当前步匹配即放行，闸拒绝明显越序、不做单选仲裁。
    expect(assessStageToolOrder('run_question_pool', [newerAtTopics, olderAtQuestions])).toBeNull();
    expect(assessStageToolOrder('plan_topics', [newerAtTopics, olderAtQuestions])).toBeNull();
  });
});

describe('assessStageToolOrder out-of-order rejection', () => {
  it('rejects a skipped-ahead call with the next-step quotation of the real current step (f74ce69e)', () => {
    // 计划刚放行、当前步是收集品牌材料，模型却直奔问题池——f74ce69e 实证
    // 的分叉场景：业务层曾放行越序调用而状态机纹丝不动。
    const operation = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'acknowledge-plan'),
    );
    const rejection = outOfOrder(assessStageToolOrder('run_question_pool', [operation]));
    // 拒绝信封逐字复用 next-step 引述结构（当前步 + 应调工具 + 指引）。
    expect(rejection.tool).toBe('run_question_pool');
    expect(rejection.nextStep).toEqual(quoteGeoNextStep(operation));
    expect(rejection.nextStep).toEqual({
      stepId: 'collect-materials',
      tool: 'request_brand_material',
      guidance: GEO_NEXT_STEP_GUIDES['collect-materials']!.guidance,
      planRevision: 7,
    });
    expect(rejection.heldStep).toBeUndefined();
    expect(rejection.hint).toContain('request_brand_material');
  });

  it('quotes a failed current step so the rejection guides a retry, not a skip', () => {
    const steps = progressedThrough(planSteps({ intent: 'article-generation', goal: '写三篇文章' }), 'generate-articles');
    const failed = steps.map((step) =>
      step.id === 'generate-articles' ? { ...step, status: 'failed' as const } : step,
    );
    const rejection = outOfOrder(assessStageToolOrder('plan_topics', [operationOf(failed)]));
    expect(rejection.nextStep).toMatchObject({
      stepId: 'generate-articles',
      tool: 'generate_articles',
    });
  });

  it('rejects before the plan acknowledgement gate releases with a held user gate', () => {
    // 新操作先停计划认可门：门放行前任何阶段工具都不得开跑（工具描述的
    // 既有纪律由闸兜底）。
    const operation = operationOf(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }));
    const rejection = outOfOrder(assessStageToolOrder('run_question_pool', [operation]));
    expect(rejection.nextStep).toBeUndefined();
    expect(rejection.heldStep).toEqual({
      stepId: 'acknowledge-plan',
      title: '认可本轮计划',
      awaitingUser: true,
    });
    expect(rejection.hint).toContain('用户');
  });

  it('rejects while an artifact confirmation gate is parked with a held user gate', () => {
    const operation = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'generate-articles'),
    );
    // 文章已生成、当前步是确认文章的用户门——分发计划直奔越序。
    const rejection = outOfOrder(assessStageToolOrder('plan_distribution', [operation]));
    expect(rejection.heldStep).toEqual({
      stepId: 'confirm-articles',
      title: '确认文章',
      awaitingUser: true,
    });
    expect(rejection.hint).toContain('确认门');
  });

  it('routes the held-gate hint to the product UI for Rust-UI confirmation authorities', () => {
    const operation = operationOf(
      progressedThrough(planSteps({ intent: 'monitoring', goal: '发布后监测' }), 'configure-monitoring'),
      { kind: 'monitoring' },
    );
    // 监测激活的 authority 是 post-publish-monitor（Rust UI），授权面不在
    // 聊天卡片——指路不得把模型引去等一张不存在的聊天卡。
    const rejection = outOfOrder(assessStageToolOrder('prepare_publish', [operation]));
    expect(rejection.heldStep).toEqual({
      stepId: 'confirm-monitoring',
      title: '确认监测计划',
      awaitingUser: true,
    });
    expect(rejection.hint).toContain('产品界面');
    // 不把模型引去等一张不存在的聊天卡：不得出现「在聊天卡片上放行」式指路。
    expect(rejection.hint).not.toContain('聊天卡片上放行');
  });

  it('rejects with a non-user held step when the frontier belongs to another channel', () => {
    const operation = operationOf(
      progressedThrough(planSteps({ intent: 'monitoring', goal: '发布后监测' }), 'confirm-monitoring'),
      { kind: 'monitoring' },
    );
    // 监测链由用户界面/自动里程碑推进，不是聊天工具步：发布预览越序时
    // 指引等待而不是虚构可调工具。
    const rejection = outOfOrder(assessStageToolOrder('prepare_publish', [operation]));
    expect(rejection.nextStep).toBeUndefined();
    expect(rejection.heldStep).toMatchObject({
      stepId: 'collect-monitoring-evidence',
      awaitingUser: false,
    });
  });

  it('anchors the rejection quotation on the most recently updated round', () => {
    const olderAtMaterials = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'acknowledge-plan'),
      { id: 'op-older', updatedAt: '2026-09-02T00:05:00Z' },
    );
    const newerAtTopics = operationOf(
      progressedThrough(planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }), 'confirm-question-selection'),
      { id: 'op-newer', updatedAt: '2026-09-02T00:09:00Z' },
    );
    // 谁都没停在问题池时，引述锚定 updatedAt 最新的轮次（与按门类引述
    // 同一先例），不引述旧轮的步骤。
    const rejection = outOfOrder(
      assessStageToolOrder('run_question_pool', [olderAtMaterials, newerAtTopics]),
    );
    expect(rejection.nextStep).toMatchObject({ stepId: 'plan-topics', tool: 'plan_topics' });
  });
});

describe('assessStageToolOrder requires-operation rejection', () => {
  const freestyle = assessStageToolOrder('generate_articles', []);

  it('rejects freestyle stage calls with no operations and points to start_geo_operation', () => {
    expect(freestyle).toMatchObject({
      kind: 'geo-stage-order-gate',
      ok: false,
      error: 'geo_stage_tool_requires_operation',
      tool: 'generate_articles',
    });
    expect(freestyle!.hint).toContain('start_geo_operation');
    expect(freestyle!.hint).toContain('inspect_geo_operations');
  });

  it('treats terminal-only history the same as no operations', () => {
    const succeeded = operationOf(
      planSteps({ intent: 'question-opportunities', goal: '一轮问题机会' }).map(
        (step) => ({ ...step, status: 'succeeded' as const }),
      ),
      { status: 'succeeded', terminalAt: '2026-09-02T00:20:00Z' },
    );
    expect(assessStageToolOrder('run_question_pool', [succeeded])).toMatchObject({
      error: 'geo_stage_tool_requires_operation',
    });
  });
});
