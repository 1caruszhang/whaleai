import { describe, expect, it } from 'vitest';

import type { GeoOperationProjection } from '../../shared/geo/operation';
import type { DistributionPlanProjection } from '../../shared/geo/distributionPlan';
import type { PublishExecutionProjection } from '../../shared/geo/publishScheduler';
import {
  accountTokenCacheFingerprint,
  distributionPlanCardProjection,
  geoOperationControlFailure,
  geoOperationProjectionPayload,
  planDistributionBudgetCny,
  publishExecutionCardProjection,
} from './xiaojing-geo-tool';

function operation(overrides: Partial<GeoOperationProjection> = {}): GeoOperationProjection {
  return {
    id: 'op-1',
    workspaceId: 'brand-1',
    sessionId: 'session-1',
    kind: 'full-optimization',
    goal: '完整优化',
    status: 'ready',
    steps: [],
    inputRefs: [],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    revision: 1,
    executionGeneration: 0,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    terminalAt: null,
    ...overrides,
  };
}

describe('accountTokenCacheFingerprint', () => {
  it('hashes the raw token into a stable 16-hex fingerprint', () => {
    const fingerprint = accountTokenCacheFingerprint('account-token-secret-1');
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain('account-token-secret-1');
    // 同 token 同指纹（实例复用），不同 token 不同指纹（轮换后重建）。
    expect(accountTokenCacheFingerprint('account-token-secret-1')).toBe(fingerprint);
    expect(accountTokenCacheFingerprint('account-token-secret-2')).not.toBe(fingerprint);
  });

  it('maps a missing token to an empty fingerprint', () => {
    expect(accountTokenCacheFingerprint(undefined)).toBe('');
    expect(accountTokenCacheFingerprint('')).toBe('');
  });
});

describe('geoOperationProjectionPayload', () => {
  it('attaches a modeling hint exactly when the session list is empty', () => {
    const empty = geoOperationProjectionPayload([]);
    expect(empty.kind).toBe('geo-operation-projection');
    expect(empty.result).toEqual([]);
    expect(typeof empty.hint).toBe('string');
    expect(empty.hint).toContain('start_geo_operation');
  });

  it('keeps non-empty lists and single-operation reads hint-free', () => {
    const listed = geoOperationProjectionPayload([operation()]);
    expect(listed.hint).toBeUndefined();
    expect(listed.result).toHaveLength(1);

    const single = geoOperationProjectionPayload(operation({ id: 'op-2' }));
    expect(single.hint).toBeUndefined();
    expect(single.result).toMatchObject({ id: 'op-2' });
  });
});

describe('geoOperationControlFailure', () => {
  it('keeps the Rust error verbatim and adds a recovery hint for invalid transitions', () => {
    const failure = geoOperationControlFailure(
      new Error('geo_operation_transition_invalid:ready (valid control actions: pause, cancel)'),
    );
    expect(failure).toMatchObject({
      kind: 'geo-operation-control',
      ok: false,
      error: 'geo_operation_transition_invalid:ready (valid control actions: pause, cancel)',
    });
    expect(failure.hint).toContain('合法的控制动作');
    expect(failure.hint).toContain('inspect_geo_operations');
  });

  it('guides terminal operations toward a new operation instead of more control calls', () => {
    const failure = geoOperationControlFailure(new Error('geo_operation_already_terminal'));
    expect(failure.hint).toContain('start_geo_operation');
  });

  it('points stale revisions back to a fresh inspect read', () => {
    const failure = geoOperationControlFailure(new Error('geo_operation_revision_conflict'));
    expect(failure.hint).toContain('revision');
  });

  it('falls back to a generic inspect-first hint for unknown errors', () => {
    const failure = geoOperationControlFailure('sidecar lock poisoned');
    expect(failure).toMatchObject({ kind: 'geo-operation-control', ok: false, error: 'sidecar lock poisoned' });
    expect(failure.hint).toContain('inspect_geo_operations');
  });
});

/**
 * 聊天价格脱敏回归：plan_distribution / prepare_publish 的转录投影只携带
 * 点数字段——CNY 金额（*Cny）与 ¥ 符号一律不进聊天，模型只能引用点数。
 */
describe('transcript card projections keep CNY out of chat', () => {
  it('distributionPlanCardProjection converts budget and candidate prices to points', () => {
    const plan = {
      id: 'plan-1',
      status: 'draft',
      revision: 1,
      budgetCny: 1000,
      workspaceId: 'brand-1',
      publishStartAt: '2026-08-20T02:00:00Z',
      selectedResourceIds: [8],
      blockingIssues: [],
      articles: [{ id: 'article-1' }],
      assignments: [],
      candidates: [
        {
          resourceId: 8,
          kind: 'media',
          name: '汽车产业观察',
          estimatedPriceCny: 88,
          pathHits: ['passive'],
          fitReasons: [],
          evidence: [{ path: 'passive', label: '真实问题来源域名命中' }],
        },
        {
          resourceId: 9,
          kind: 'we-media',
          name: '车主生活圈',
          estimatedPriceCny: null,
          pathHits: [],
          fitReasons: [],
          evidence: [],
        },
      ],
    } as unknown as DistributionPlanProjection;

    const card = distributionPlanCardProjection(plan);
    expect(card.budgetPoints).toBe(16000);
    expect(card.candidates[0]?.estimatedPricePoints).toBe(1408);
    expect(card.candidates[1]?.estimatedPricePoints).toBeNull();

    const json = JSON.stringify({ kind: 'distribution-plan', plan: card });
    expect(json).not.toContain('Cny');
    expect(json).not.toContain('¥');
  });

  it('publishExecutionCardProjection strips every CNY field from the preview', () => {
    const execution = {
      id: 'exec-1',
      revision: 1,
      status: 'awaiting-confirmation',
      workspaceId: 'brand-1',
      distributionPlanId: 'plan-1',
      publishStartAt: '2026-08-20T02:00:00Z',
      confirmationDigest: 'digest-1',
      irreversibleImpact: '将付费并向外部渠道发布，不可撤销。',
      totalPricePoints: 1408,
      budgetCny: 1000,
      estimatedSpendCny: 88,
      items: [
        {
          id: 'item-1',
          status: 'pending',
          scheduledAt: '2026-08-20T02:00:00Z',
          article: { title: '成都汽车音响改装怎么选', bodySummary: '批准稿摘要。' },
          channel: {
            resourceId: 8,
            kind: 'media',
            name: '汽车产业观察',
            estimatedPriceCny: 88,
            pricePoints: 1408,
          },
          requestSummary: { estimatedPriceCny: 88 },
        },
      ],
    } as unknown as PublishExecutionProjection;

    const preview = publishExecutionCardProjection(execution);
    expect(preview.budgetPoints).toBe(16000);
    expect(preview.totalPricePoints).toBe(1408);
    expect(preview.items[0]?.channel.pricePoints).toBe(1408);
    expect(preview.confirmationDigest).toBe('digest-1');

    const json = JSON.stringify({ kind: 'publish-execution', execution: preview });
    expect(json).not.toContain('Cny');
    expect(json).not.toContain('¥');
    expect(json).not.toContain('estimatedPrice');
    expect(json).not.toContain('estimatedSpend');
  });
});

describe('planDistributionBudgetCny', () => {
  it('defaults to the product default budget when no points are given', () => {
    expect(planDistributionBudgetCny(undefined)).toBe(1_000);
  });

  it('converts a points budget cap back to internal CNY', () => {
    // 16000 点 → ¥1000；聊天边界只携带点数，换算倍率不进转录。
    expect(planDistributionBudgetCny(16_000)).toBe(1_000);
    expect(planDistributionBudgetCny(0)).toBe(0);
  });
});
