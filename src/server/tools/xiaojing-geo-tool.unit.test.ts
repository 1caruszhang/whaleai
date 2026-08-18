import { describe, expect, it } from 'vitest';

import type { GeoOperationProjection } from '../../shared/geo/operation';
import { geoOperationControlFailure, geoOperationProjectionPayload } from './xiaojing-geo-tool';

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
