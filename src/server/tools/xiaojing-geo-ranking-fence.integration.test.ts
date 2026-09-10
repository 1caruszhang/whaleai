import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { managementApi } from '../utils/management-api-client';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

/**
 * 票 #45 评审修复的协议侧回归：confirm_ranking_competitors 的接线层必须
 * 在「部分采纳」（采纳后仍不足 5 家）时推进门卡围栏——曾经只推进了 gate
 * 层（advanceFence 有实现有单测）却没接线，同一条用户消息可以一轮一轮把
 * 「顺带提到」的名字全部直采纳，测试若只调 gate 方法会掩盖该缺口，故本
 * 文件经 MCP InMemoryTransport 打真实工具处理器。知识权威经管理面 mock，
 * 会话 transcript 经 SessionStore mock，无真实网络与磁盘。
 */

const sessionId = 'session-ranking-fence-it';
const workspace = 'C:/ws/brand-ranking-fence';
const workspaceId = 'brand-ranking-fence';

const transcriptMocks = vi.hoisted(() => ({
  load: vi.fn(),
}));

vi.mock('../SessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../SessionStore')>();
  return { ...actual, loadSessionTranscript: transcriptMocks.load };
});

import {
  configureXiaojingGeo,
  createXiaojingGeoServer,
} from './xiaojing-geo-tool';
import { sessionRankingCompetitorGate } from '../geo/ranking-competitor-gate';

async function withClient(
  routes: Record<string, (body: Record<string, unknown>) => Record<string, unknown>>,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  process.env.XIAOJING_SIDECAR_ID = 'sidecar-ranking-fence-it';
  configureXiaojingGeo({}, { sessionId, workspace });
  vi.mocked(managementApi).mockImplementation(
    async (path: string, _method: unknown, body?: unknown) => {
      const handler = routes[path];
      if (!handler) return { ok: false, error: `unrouted:${path}` };
      return handler((body ?? {}) as Record<string, unknown>);
    },
  );
  const config = await createXiaojingGeoServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverTransport);
  const client = new Client({ name: 'ranking-fence-client', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await config.instance.close();
    delete process.env.XIAOJING_SIDECAR_ID;
  }
}

function payloadOf(result: unknown) {
  const { content } = result as { content?: unknown };
  const text = (content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

/** 已确认 3 家直接竞品的品牌知识库（按 factKey 分流的管理面 mock）。 */
function knowledgeRoutes(decideResult: Record<string, unknown>) {
  return {
    '/api/brand-knowledge/current': (body: Record<string, unknown>) => {
      const factKey = String((body.payload as Record<string, unknown>)?.factKey ?? '');
      if (factKey.includes('enterprise-profile.potentialcompetitors')) {
        return { ok: true, current: null };
      }
      if (factKey.includes('enterprise-profile.competitors')) {
        return {
          ok: true,
          current: { normalizedValueJson: '["竞品甲","竞品乙","竞品丙"]', version: 3 },
        };
      }
      return { ok: true, current: null };
    },
    '/api/brand-knowledge/candidate/submit': () => ({
      ok: true,
      candidate: { id: 'candidate-ranking', baseVersion: 3, workspaceId, sessionId },
    }),
    '/api/brand-knowledge/candidate/get': () => ({
      ok: true,
      candidate: { id: 'candidate-ranking', baseVersion: 3, workspaceId, sessionId },
    }),
    '/api/brand-knowledge/candidate/decide': () => ({ ok: true, result: decideResult }),
  };
}

describe('confirm_ranking_competitors fence wiring over a live MCP server', () => {
  beforeEach(() => {
    transcriptMocks.load.mockResolvedValue({
      messages: [
        { id: 'user-1', role: 'user', content: '帮我生成排行榜文章' },
        { id: 'assistant-1', role: 'assistant', content: '已确认竞品不足，请补充。' },
        { id: 'user-2', role: 'user', content: '补充竞品丁，另外聊天里提到过竞品戊' },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('advances the fence after partial adoption so the same message cannot authorize a second round', async () => {
    // 采纳后 4 < 5：部分采纳分支。修复前该分支直接返回、围栏不动，
    // user-2 这条消息还能再授权采纳「竞品戊」。
    const gate = sessionRankingCompetitorGate(sessionId);
    gate.clear();
    gate.issue({
      subject: '目标品牌',
      source: {
        kind: 'direct',
        count: 1,
        themes: ['本地服务六家对比'],
        contentType: 'ranking',
        constraints: '',
      },
      issuedAfterUserMessageId: 'user-1',
    });

    await withClient(
      knowledgeRoutes({
        current: { normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁"]' },
      }),
      async (client) => {
        const first = payloadOf(await client.callTool({
          name: 'confirm_ranking_competitors',
          arguments: { names: ['竞品丁'] },
        }));
        expect(first).toMatchObject({ confirmedCount: 4, readyForRanking: false });
        // 接线层（而非 gate 层）推进了围栏。
        expect(gate.pendingChallenge()).toMatchObject({ issuedAfterUserMessageId: 'user-2' });

        // 同一条消息再想采纳「顺带提到」的竞品戊：必须被拒绝。
        const second = await client.callTool({
          name: 'confirm_ranking_competitors',
          arguments: { names: ['竞品戊'] },
        }).catch((error: unknown) => error);
        expect(JSON.stringify(second)).toContain(
          'ranking_competitor_confirmation_user_reply_required',
        );
      },
    );
    gate.clear();
  });
});
