import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { managementApi } from '../utils/management-api-client';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import { GEO_NEXT_STEP_GUIDES } from '../geo/operation-progress';
import {
  QUESTION_POOL_REUSE_CONTRACT,
  QUESTION_POOL_REUSE_OUTCOME,
  type QuestionPoolProjection,
} from '../../shared/geo/questionPool';
import { configureXiaojingGeo, createXiaojingGeoServer } from './xiaojing-geo-tool';

/**
 * 问题池复用契约的协议侧（ADR-0011 Decision 3 / 票 #32），MCP 协议级验证：
 * 契约话术逐字落在三处——工具描述、复用命中的结果信封（outcome +
 * proceed）、next-step 单表的对应条目；复用命中时信封携带
 * outcome=reused-confirmed-pool，未确认池到达时不携带。Rust 端点以
 * managementApi mock 模拟，无真实网络。
 */

function poolOf(overrides: Partial<QuestionPoolProjection>): QuestionPoolProjection {
  return {
    id: 'pool-reuse-32',
    attemptId: null,
    operationId: 'operation-32',
    workspaceId: 'brand-a',
    knowledgeVersion: 7,
    productLine: '汽车音响改装',
    targetRegion: '成都',
    generationParameters: {
      policyVersion: 'xiaojing-content-prompt-v1',
      candidateLimit: 20,
      recentSelectionLimit: 20,
      priorityThresholds: { highAtSum: 150, mediumAtSum: 100 },
    },
    status: 'confirmed',
    revision: 3,
    keywords: [],
    questions: [],
    sourceEvidence: [],
    checkpoints: [],
    reused: true,
    createdAt: '2026-08-30T00:00:00Z',
    updatedAt: '2026-08-30T00:10:00Z',
    ...overrides,
  } as QuestionPoolProjection;
}

const reusedContext = {
  knowledgeVersion: 7,
  brandName: '目标品牌',
  productLines: ['汽车音响改装'],
  facts: [],
  recentSelectedQuestions: [],
  keywordLibrary: [],
};

async function withClient(
  routes: Record<string, Record<string, unknown>>,
  run: (client: Client, calls: unknown[][]) => Promise<void>,
): Promise<void> {
  process.env.XIAOJING_SIDECAR_ID = 'sidecar-pool-reuse-it';
  configureXiaojingGeo({}, {
    sessionId: 'session-pool-reuse',
    workspace: 'C:/ws/brand-a',
  });
  const calls: unknown[][] = [];
  vi.mocked(managementApi).mockImplementation(
    async (path: string, _method: unknown, body?: unknown) => {
      calls.push([path, body]);
      const response = routes[path];
      if (!response) return { ok: false, error: `unrouted:${path}` };
      return response;
    },
  );
  const config = await createXiaojingGeoServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverTransport);
  const client = new Client({ name: 'pool-reuse-client', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    await run(client, calls);
  } finally {
    await client.close();
    await config.instance.close();
    delete process.env.XIAOJING_SIDECAR_ID;
  }
}

function payloadOf(result: unknown) {
  const { content } = result as { content?: unknown };
  const text =
    (content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

async function descriptionOf(client: Client): Promise<string> {
  const tools = await client.listTools();
  const described = tools.tools.find((tool) => tool.name === 'run_question_pool')
    ?.description;
  expect(described).toBeDefined();
  return described as string;
}

describe('run_question_pool reuse contract over a live MCP server', () => {
  it('states the reuse contract verbatim in the tool description and the next-step table', async () => {
    await withClient({}, async (client) => {
      // 三处同一话术（ADR-0011 Decision 3）的静态两处：工具描述与
      // next-step 单表条目逐字含 QUESTION_POOL_REUSE_CONTRACT；第三处
      //（结果信封 proceed）由下方复用命中的调用用例断言。
      const description = await descriptionOf(client);
      expect(description).toContain(QUESTION_POOL_REUSE_CONTRACT);
      expect(
        GEO_NEXT_STEP_GUIDES['generate-question-pool']!.guidance,
      ).toContain(QUESTION_POOL_REUSE_CONTRACT);

      // 「从问题池选择」条目存在性（票 02 归一验收）：不更新知识的计划
      // （全链或下一轮入口同形）首工作步停在这道门，决策回执信封必须引得
      // 到——条目缺失会把 agent 卡在「计划让选池、信封不指路」的断链上；
      // guidance 与问题池复用契约同源。
      const selectGuide = GEO_NEXT_STEP_GUIDES['select-next-question-pool'];
      expect(selectGuide).toBeDefined();
      expect(selectGuide!.tool).toBe('run_question_pool');
      expect(selectGuide!.guidance).toContain(QUESTION_POOL_REUSE_CONTRACT);
    });
  });

  it('returns outcome=reused-confirmed-pool with the proceed hint when a confirmed pool is reused', async () => {
    const pool = poolOf({ status: 'confirmed', reused: true });
    await withClient(
      {
        '/api/brand-question-pools/prepare': {
          ok: true,
          preparation: { kind: 'reused', context: reusedContext, attempt: null, pool },
        },
      },
      async (client, calls) => {
        const result = await client.callTool({
          name: 'run_question_pool',
          arguments: {
            productLine: '汽车音响改装',
            targetRegion: '成都',
            idempotencyKey: 'agent-pool-reuse-32',
          },
        });
        const payload = payloadOf(result);
        expect(payload.kind).toBe('question-pool');
        expect(payload.outcome).toBe(QUESTION_POOL_REUSE_OUTCOME);
        expect(payload.proceed).toContain(QUESTION_POOL_REUSE_CONTRACT);
        // 修订口径（2026-09-01）：复用停卡重选——proceed 要求停在问题门等
        // 用户的卡片确认，而不是「无需再确认、直接前进」。
        expect(payload.proceed).toContain("park at the question gate");
        expect(payload.pool).toMatchObject({ id: 'pool-reuse-32', status: 'confirmed' });
        // 复用即收尾：prepare 一次后没有任何 stage claim / persist 调用。
        const poolRoutes = calls.filter(([path]) =>
          String(path).startsWith('/api/brand-question-pools/'),
        );
        expect(poolRoutes).toEqual([
          ['/api/brand-question-pools/prepare', {
            workspaceId: 'brand-a',
            sessionId: 'session-pool-reuse',
            sidecarId: 'sidecar-pool-reuse-it',
            payload: {
              workspaceId: 'brand-a',
              sessionId: 'session-pool-reuse',
              productLine: '汽车音响改装',
              targetRegion: '成都',
              generationParameters: {
                policyVersion: 'xiaojing-content-prompt-v1',
                candidateLimit: 20,
                recentSelectionLimit: 20,
                priorityThresholds: { highAtSum: 150, mediumAtSum: 100 },
              },
              idempotencyKey: 'agent-pool-reuse-32',
              reuseExisting: true,
              retry: false,
            },
          }],
        ]);
      },
    );
  });

  it('keeps the plain envelope without outcome while the pool awaits selection', async () => {
    const pool = poolOf({ status: 'awaiting-selection', reused: true });
    await withClient(
      {
        '/api/brand-question-pools/prepare': {
          ok: true,
          preparation: { kind: 'reused', context: reusedContext, attempt: null, pool },
        },
      },
      async (client) => {
        const result = await client.callTool({
          name: 'run_question_pool',
          arguments: {
            productLine: '汽车音响改装',
            targetRegion: '成都',
            idempotencyKey: 'agent-pool-pending-32',
          },
        });
        const payload = payloadOf(result);
        // 待决池走正常确认卡流程：不携带复用 outcome（proceed 提示会误导
        // 模型越过待停靠的问题门）。
        expect(payload.kind).toBe('question-pool');
        expect(payload.outcome).toBeUndefined();
        expect(payload.proceed).toBeUndefined();
        expect(payload.pool).toMatchObject({ status: 'awaiting-selection' });
      },
    );
  });
});
