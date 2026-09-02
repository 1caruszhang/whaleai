import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// geo-plan-normalization 票 08 的服务端接缝回归：主确认卡「完成时刻」的
// 数据链——Rust 决策事务写入的 resolved_at 经管理面投影与 decide-batch
// 路由原样透传（results[].settledAt），水合路由经 toKnowledgeCardCandidate
// 投影 resolvedAt。渲染侧只消费这两个字段，不在 Node/前端另行打点，杜绝
// 与权威投影不一致的第二时间源。GEO 服务与消息投递全部 mock，默认测试
// 不依赖真实网络与真实密钥。

const seamMocks = vi.hoisted(() => ({
  enqueueUserMessage: vi.fn(),
  decide: vi.fn(),
  candidate: vi.fn(),
  recordMilestone: vi.fn(),
  quoteNextStep: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  enqueueUserMessage: seamMocks.enqueueUserMessage,
  getSessionId: () => 'session-settled-at',
}));

vi.mock('../geo/knowledge-authority', () => ({
  createKnowledgeAuthority: () => ({
    decide: seamMocks.decide,
    candidate: seamMocks.candidate,
  }),
}));

vi.mock('../geo/operation-progress', () => ({
  recordGeoOperationMilestone: seamMocks.recordMilestone,
  quoteGeoNextStepForGateKind: seamMocks.quoteNextStep,
}));

vi.mock('../xiaojing-reminder-send', () => ({
  sendXiaojingMessage: seamMocks.enqueueUserMessage,
}));

let testHome: string;
let workspace: string;
let originalHome: string | undefined;
let handleXiaojingKnowledgeRoute: typeof import('../routes/xiaojing-knowledge')['handleXiaojingKnowledgeRoute'];

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-settled-at-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'xiaojing-settled-at-ws-'));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
  vi.resetModules();
  ({ handleXiaojingKnowledgeRoute } = await import('../routes/xiaojing-knowledge'));
});

afterAll(() => {
  process.env.HOME = originalHome;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  seamMocks.enqueueUserMessage.mockResolvedValue({ success: true });
  seamMocks.quoteNextStep.mockResolvedValue(null);
  seamMocks.recordMilestone.mockResolvedValue(undefined);
});

function post(pathname: string, body: Record<string, unknown>): Request {
  return new Request(`http://127.0.0.1:1${pathname}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function callRoute(pathname: string, body: Record<string, unknown>) {
  const response = await handleXiaojingKnowledgeRoute(pathname, post(pathname, body), {
    workspacePath: workspace,
  });
  expect(response).not.toBeNull();
  return {
    status: response!.status,
    json: (await response!.json()) as Record<string, unknown>,
  };
}

describe('knowledge decided-at seam (ticket 08)', () => {
  it('decide-batch 透传每条裁决的落库时刻 settledAt，缺值时为 null 而非伪造', async () => {
    seamMocks.decide.mockImplementation(async (input: { candidateId: string }) => ({
      candidateId: input.candidateId,
      factKey: 'brand|price|{}|',
      decision: 'adopt-new',
      status: 'adopted',
      resolvedAt: input.candidateId === 'c-with-time' ? '2026-09-02T05:04:03Z' : undefined,
      current: null,
      knowledgeVersion: 1,
      affectedArtifacts: [],
    }));

    const { status, json } = await callRoute('/api/xiaojing/knowledge/decide-batch', {
      workspaceId: basenameOf(workspace),
      sessionId: 'session-settled-at',
      decisions: [
        { candidateId: 'c-with-time', decision: 'adopt-new', expectedCurrentVersion: 0 },
        { candidateId: 'c-without-time', decision: 'adopt-new', expectedCurrentVersion: 0 },
      ],
    });

    expect(status).toBe(200);
    const results = json.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      candidateId: 'c-with-time',
      ok: true,
      status: 'adopted',
      settledAt: '2026-09-02T05:04:03Z',
    });
    expect(results[1]).toMatchObject({ candidateId: 'c-without-time', ok: true, settledAt: null });
  });

  it('candidates 水合投影携带 resolvedAt，供重挂载的已裁决卡显示完成时刻', async () => {
    seamMocks.candidate.mockResolvedValue({
      id: 'c-hydrated',
      workspaceId: basenameOf(workspace),
      sessionId: 'session-settled-at',
      key: {
        subject: '鲸跃科技',
        predicate: 'enterprise-profile.fullName',
        scopeJson: '{"entityScope":"brand"}',
        effectiveFrom: null,
        effectiveTo: null,
        identity: 'brand|enterprise-profile.fullname|{"entityscope":"brand"}||',
      },
      valueJson: '"鲸跃科技"',
      normalizedValueJson: '"鲸跃科技"',
      unit: null,
      status: 'adopted',
      baseVersion: 0,
      proposedAt: '2026-09-02T05:00:00Z',
      resolvedAt: '2026-09-02T05:04:03Z',
      origin: 'model-inferred',
      source: {
        materialId: 'material-1',
        excerpt: '公司全称：鲸跃科技',
        confidence: 0.96,
        profileProvenance: 'extracted',
      },
      current: null,
    });

    const { status, json } = await callRoute('/api/xiaojing/knowledge/candidates', {
      workspaceId: basenameOf(workspace),
      sessionId: 'session-settled-at',
      candidateIds: ['c-hydrated'],
    });

    expect(status).toBe(200);
    const candidates = json.candidates as Array<Record<string, unknown> | null>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: 'c-hydrated',
      status: 'adopted',
      resolvedAt: '2026-09-02T05:04:03Z',
    });
  });

  it('身份不匹配的请求仍被 403 闸在服务调用之前', async () => {
    const { status } = await callRoute('/api/xiaojing/knowledge/decide-batch', {
      workspaceId: 'someone-else',
      sessionId: 'session-settled-at',
      decisions: [{ candidateId: 'c-x', decision: 'adopt-new', expectedCurrentVersion: 0 }],
    });

    expect(status).toBe(403);
    expect(seamMocks.decide).not.toHaveBeenCalled();
  });
});

/** basename 的本地引用（避免与 node:path 的具名导入在 mock 边界上纠缠）。 */
function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}
