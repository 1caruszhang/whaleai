import { basename } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 票 #45 评审修复的协议侧回归：单条 /knowledge/decide 裁决（单卡
// KnowledgeConflictCard 的提交面）采纳品牌 scope 竞品事实后，必须与
// decide-batch 一样触发自动续跑钩子——两条裁决面等价，走单卡确认的用户
// 才拿得到「确认后自动续跑」。知识权威、进度里程碑、消息投递与续跑钩子
// 全部 mock，无真实网络与磁盘。

const seamMocks = vi.hoisted(() => ({
  enqueueUserMessage: vi.fn(),
  decide: vi.fn(),
  recordMilestone: vi.fn(),
  quoteNextStep: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('../agent-session', () => ({
  enqueueUserMessage: seamMocks.enqueueUserMessage,
  getSessionId: () => 'session-ranking-resume',
}));

vi.mock('../geo/knowledge-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../geo/knowledge-authority')>();
  return {
    ...actual,
    createKnowledgeAuthority: () => ({ decide: seamMocks.decide }),
  };
});

vi.mock('../geo/operation-progress', () => ({
  recordGeoOperationMilestone: seamMocks.recordMilestone,
  quoteGeoNextStepForGateKind: seamMocks.quoteNextStep,
}));

vi.mock('../xiaojing-reminder-send', () => ({
  sendXiaojingMessage: seamMocks.enqueueUserMessage,
}));

vi.mock('../geo/ranking-competitor-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../geo/ranking-competitor-gate')>();
  return {
    ...actual,
    resumeRankingGenerationAfterKnowledgeDecision: seamMocks.resume,
  };
});

let workspace: string;
let handleXiaojingKnowledgeRoute: typeof import('../routes/xiaojing-knowledge')['handleXiaojingKnowledgeRoute'];
let sessionRankingCompetitorGate: typeof import('../geo/ranking-competitor-gate')['sessionRankingCompetitorGate'];

beforeAll(async () => {
  workspace = `C:/ws/brand-ranking-resume-${Date.now()}`;
  vi.resetModules();
  ({ handleXiaojingKnowledgeRoute } = await import('../routes/xiaojing-knowledge'));
  ({ sessionRankingCompetitorGate } = await import('../geo/ranking-competitor-gate'));
});

beforeEach(() => {
  vi.clearAllMocks();
  seamMocks.enqueueUserMessage.mockResolvedValue({ success: true });
  seamMocks.quoteNextStep.mockResolvedValue(null);
  seamMocks.recordMilestone.mockResolvedValue(undefined);
  seamMocks.resume.mockResolvedValue({ resumed: false });
});

async function callDecide(decision: string, currentKey: Record<string, unknown> | null) {
  seamMocks.decide.mockResolvedValue({
    candidateId: 'c-ranking',
    factKey: 'brand|enterprise-profile.competitors|{"entityScope":"brand"}|',
    status: 'adopted',
    resolvedAt: '2026-09-10T05:04:03Z',
    current: currentKey ? { key: currentKey, version: 2 } : null,
    knowledgeVersion: 4,
  });
  const response = await handleXiaojingKnowledgeRoute(
    '/api/xiaojing/knowledge/decide',
    new Request('http://127.0.0.1:1/api/xiaojing/knowledge/decide', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: basename(workspace),
        sessionId: 'session-ranking-resume',
        candidateId: 'c-ranking',
        decision,
        expectedCurrentVersion: 1,
      }),
      headers: { 'Content-Type': 'application/json' },
    }),
    { workspacePath: workspace },
  );
  expect(response).not.toBeNull();
  return (await response!.json()) as Record<string, unknown>;
}

describe('single knowledge decide triggers the ranking auto-resume hook (票 #45)', () => {
  it('fires the hook after adopting a brand-scope competitor fact', async () => {
    const json = await callDecide('adopt-new', {
      predicate: 'enterprise-profile.competitors',
      scopeJson: '{"entityScope":"brand"}',
    });
    expect(json.success).toBe(true);
    expect(seamMocks.resume).toHaveBeenCalledTimes(1);
    expect(seamMocks.resume).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: basename(workspace),
      sessionId: 'session-ranking-resume',
      gate: sessionRankingCompetitorGate('session-ranking-resume'),
    }));
  });

  it('does not fire the hook for rejections or non-competitor facts', async () => {
    await callDecide('reject', {
      predicate: 'enterprise-profile.competitors',
      scopeJson: '{"entityScope":"brand"}',
    });
    await callDecide('adopt-new', {
      predicate: 'enterprise-profile.fullname',
      scopeJson: '{"entityScope":"brand"}',
    });
    expect(seamMocks.resume).not.toHaveBeenCalled();
  });
});
