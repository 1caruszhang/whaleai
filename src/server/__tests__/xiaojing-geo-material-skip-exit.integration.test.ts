import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { planGeoOperation, type GeoOperationProjection } from '../../shared/geo/operation';

// geo-plan-normalization 票 07 的服务端链路回归：材料请求卡「跳过材料
// 收集」提交到 HTTP 路由后，走既有 replace-plan 计划替换动作剥离知识段
// 剩余步骤，并注入携带正确下一步引述的 XIAOJING_GEO_OPERATION_EVENT
// 决策回执信封唤醒 agent 续接——与知识分支决策（choose-next-round）同构。
// 在路由处理器接缝上断言：身份闸先于任何服务调用返回 403；替换成功后
// 信封引述替换后计划的首个未完成步骤；revision 冲突 409 且不投递信封。
// GEO 服务与用户消息入队全部 mock，默认测试不依赖真实网络与真实密钥。

const skipMocks = vi.hoisted(() => ({
  enqueueUserMessage: vi.fn(),
  skipMaterialCollection: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  enqueueUserMessage: skipMocks.enqueueUserMessage,
  getSessionId: () => 'session-skip-exit',
}));

vi.mock('../geo/operation', () => ({
  createGeoOperationService: () => ({
    skipMaterialCollection: skipMocks.skipMaterialCollection,
  }),
}));

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let handleXiaojingGeoOperationsRoute: typeof import('../routes/xiaojing-geo-operations')['handleXiaojingGeoOperationsRoute'];

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-skip-exit-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-skip-exit-ws-'));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
  vi.resetModules();
  ({ handleXiaojingGeoOperationsRoute } = await import('../routes/xiaojing-geo-operations'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  skipMocks.enqueueUserMessage.mockResolvedValue({ accepted: true });
});

/**
 * 跳过后的真实计划投影：全链计划剥离知识段三步，认可门已成功，替换后
 * 从 generate-question-pool（ready）续接。Rust 侧 advance_operation 会把
 * 首个 pending 步骤置 ready——这里按替换后的持久化形态构造。
 */
function operationAfterSkip(): GeoOperationProjection {
  const steps = planGeoOperation({
    intent: 'full-optimization',
    goal: '一轮完整的 GEO 优化',
  }).steps
    .filter((step) => !['collect-materials', 'extract-facts', 'confirm-knowledge'].includes(step.id))
    .map((step, index) => ({
      ...step,
      status: index === 0 ? ('succeeded' as const) : index === 1 ? ('ready' as const) : step.status,
    }));
  return {
    id: 'op-skip-07',
    workspaceId: 'brand-skip-exit',
    sessionId: 'session-skip-exit',
    kind: 'full-optimization',
    goal: '一轮完整的 GEO 优化',
    status: 'ready',
    steps,
    inputRefs: [],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    updateKnowledge: false,
    revision: 8,
    executionGeneration: 1,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:10:00Z',
    terminalAt: null,
  };
}

function post(pathname: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function callSkipRoute(payload: Record<string, unknown>) {
  const pathname = '/api/xiaojing/geo-operations/skip-material-collection';
  const response = await handleXiaojingGeoOperationsRoute(
    pathname,
    post(pathname, payload),
    { workspacePath: workspace },
  );
  expect(response).not.toBeNull();
  return {
    status: response!.status,
    body: await response!.json() as Record<string, unknown>,
  };
}

function identityPayload(extra: Record<string, unknown>): Record<string, unknown> {
  return { workspaceId: basename(workspace), sessionId: 'session-skip-exit', ...extra };
}

describe('material-collection skip exit route', () => {
  it('replaces the plan, returns the operation, and injects a decision receipt quoting the post-skip next step', async () => {
    const replaced = operationAfterSkip();
    skipMocks.skipMaterialCollection.mockResolvedValueOnce(replaced);

    const { status, body } = await callSkipRoute(identityPayload({
      operationId: 'op-skip-07',
      expectedRevision: 7,
    }));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.operation).toMatchObject({
      id: 'op-skip-07',
      updateKnowledge: false,
    });
    // 计划替换经服务 seam 提交：operationId + revision CAS。
    expect(skipMocks.skipMaterialCollection).toHaveBeenCalledTimes(1);
    expect(skipMocks.skipMaterialCollection).toHaveBeenCalledWith({
      operationId: 'op-skip-07',
      expectedRevision: 7,
    });
    // 决策回执信封：唤醒 agent 从跳过后的真实下一步续接。
    expect(body.notificationQueued).toBe(true);
    expect(skipMocks.enqueueUserMessage).toHaveBeenCalledTimes(1);
    const [text] = skipMocks.enqueueUserMessage.mock.calls[0] as [string, unknown];
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('<XIAOJING_GEO_OPERATION_EVENT>');
    expect(text).toContain('<action>skip-material-collection</action>');
    expect(text).toContain('<operation-id>op-skip-07</operation-id>');
    expect(text).toContain('<revision>8</revision>');
    expect(text).toContain('<status>ready</status>');
    // 引述与跳过后的真实计划一致：知识段已剥离，当前步是问题池生成。
    expect(text).toContain('<next-step>');
    expect(text).toContain('<step-id>generate-question-pool</step-id>');
    expect(text).toContain('<tool>run_question_pool</tool>');
    expect(text).toContain('<plan-revision>8</plan-revision>');
    expect(text).not.toContain('collect-materials');
  });

  it('rejects mismatched identity with 403 before any service call or receipt', async () => {
    const { status, body } = await callSkipRoute({
      workspaceId: 'not-this-workspace',
      sessionId: 'not-this-session',
      operationId: 'op-skip-07',
      expectedRevision: 7,
    });

    expect(status).toBe(403);
    expect(body.success).toBe(false);
    expect(body.error).toBe('geo_operation_identity_mismatch');
    expect(skipMocks.skipMaterialCollection).not.toHaveBeenCalled();
    expect(skipMocks.enqueueUserMessage).not.toHaveBeenCalled();
  });

  it('maps revision conflicts to 409 and never injects a receipt for a failed replacement', async () => {
    skipMocks.skipMaterialCollection.mockRejectedValueOnce(
      new Error('revision_conflict: stale expectedRevision'),
    );

    const { status, body } = await callSkipRoute(identityPayload({
      operationId: 'op-skip-07',
      expectedRevision: 1,
    }));

    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.error).toContain('revision_conflict');
    expect(skipMocks.enqueueUserMessage).not.toHaveBeenCalled();
  });

  it('surfaces invalid skip targets as 400 without a receipt', async () => {
    skipMocks.skipMaterialCollection.mockRejectedValueOnce(
      new Error('geo_operation_material_skip_invalid'),
    );

    const { status, body } = await callSkipRoute(identityPayload({
      operationId: 'op-past-knowledge',
      expectedRevision: 3,
    }));

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('geo_operation_material_skip_invalid');
    expect(skipMocks.enqueueUserMessage).not.toHaveBeenCalled();
  });
});
