import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { managementApi } from '../utils/management-api-client';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import {
  brandWorkspaceStateSummary,
  configureXiaojingGeo,
  createXiaojingGeoServer,
} from './xiaojing-geo-tool';
import { planGeoOperation } from '../../shared/geo/operation';

/**
 * 跨 Session 状态盲区回归（MCP 协议级）：新 Session 的 agent 第一个动作
 * 是经真实 MCP server 调用 inspect_brand_context，必须一次拿到 Rust 持久的
 * 品牌状态摘要（含第一轮已确认的 5 家竞品），而不是向用户重新征集；
 * 另一用例覆盖 ADR-0010 Decision 3 的跨会话未完成轮次元信息（六要素，
 * 只读，不含草稿正文与聊天记录）。Rust 端点以 managementApi mock 模拟，
 * 无真实网络。
 */
describe('inspect_brand_context over a live MCP server', () => {
  it('returns the persisted workspace state summary to a fresh session', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-brand-context-it';
    // 新 Session：sessionId 与第一轮不同，聊天上下文完全空白。
    configureXiaojingGeo({}, {
      sessionId: 'session-round-two',
      workspace: 'C:/ws/brand-a',
    });
    vi.mocked(managementApi).mockImplementation(
      async (path: string): Promise<Record<string, unknown>> => {
        const routes: Record<string, Record<string, unknown>> = {
          '/api/brand-materials/context': {
            ok: true,
            context: {
              workspaceId: 'brand-a',
              brandName: '目标品牌',
              productLines: ['汽车音响改装'],
            },
          },
          '/api/brand-knowledge/current': {
            ok: true,
            current: {
              normalizedValueJson: '["竞品甲","竞品乙","竞品丙","竞品丁","竞品戊"]',
            },
          },
          '/api/brand-question-pools/latest': {
            ok: true,
            pool: {
              status: 'confirmed',
              productLine: '汽车音响改装',
              targetRegion: '成都',
              questions: [{}, {}, {}],
              updatedAt: '2026-08-27T10:00:00Z',
            },
          },
          '/api/brand-topic-plans/latest': {
            ok: true,
            plan: {
              status: 'confirmed',
              productLine: '汽车音响改装',
              topics: [{}],
              updatedAt: '2026-08-27T11:00:00Z',
            },
          },
          '/api/brand-articles/latest': {
            ok: true,
            operation: {
              status: 'completed',
              articles: [
                { approvedVersion: { id: 'v1' } },
                { approvedVersion: { id: 'v2' } },
              ],
              updatedAt: '2026-08-27T12:00:00Z',
            },
          },
          '/api/brand-distribution-plans/latest': {
            ok: true,
            plan: {
              status: 'confirmed',
              industry: '汽车后市场',
              updatedAt: '2026-08-27T13:00:00Z',
            },
          },
          '/api/brand-publish-scheduler/latest': {
            ok: true,
            execution: {
              status: 'scheduled',
              publishStartAt: '2026-08-28T09:00:00Z',
              updatedAt: '2026-08-27T14:00:00Z',
            },
          },
        };
        const response = routes[path];
        if (!response) return { ok: false, error: `unrouted:${path}` };
        return response;
      },
    );

    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'integration-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const inspect = tools.tools.find((tool) => tool.name === 'inspect_brand_context');
      expect(inspect).toBeDefined();

      const result = await client.callTool({ name: 'inspect_brand_context', arguments: {} });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      const payload = JSON.parse(text) as {
        workspaceState: Awaited<ReturnType<typeof brandWorkspaceStateSummary>>;
      };

      // 摘要一次到位：agent 不需要再问竞品，也不需要重读任何阶段产物。
      // 票 #10 修订：摘要不再携带未完成轮次——他轮信息在场会诱发起点
      // 推导的现场取舍；轮次元信息只经点名续轮查询（inspect_geo_operations
      // includeUnfinishedRounds）按需读取。
      expect(payload.workspaceState).toMatchObject({
        kind: 'brand-workspace-state',
        brandName: '目标品牌',
        confirmedCompetitors: ['竞品甲', '竞品乙', '竞品丙', '竞品丁', '竞品戊'],
        questionPool: { present: true, state: { questionCount: 3 } },
        articles: { present: true, state: { articleCount: 2, approvedCount: 2 } },
        distributionPlan: { present: true, state: { status: 'confirmed' } },
        publish: { present: true, state: { status: 'scheduled' } },
      });
      expect(payload.workspaceState && 'unfinishedOperations' in payload.workspaceState).toBe(false);
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });

  it('serves the named-continuation unfinished-rounds query via inspect_geo_operations, not the summary', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-brand-context-it';
    // 新 Session：上一轮在另一个 Session 做到文章批准门，草稿审到一半。
    configureXiaojingGeo({}, {
      sessionId: 'session-round-two',
      workspace: 'C:/ws/brand-a',
    });
    vi.mocked(managementApi).mockImplementation(
      async (path: string): Promise<Record<string, unknown>> => {
        const routes: Record<string, Record<string, unknown>> = {
          '/api/brand-geo-operations/unfinished': {
            ok: true,
            total: 2,
            operations: [
              {
                id: 'op-round-one',
                sessionId: 'session-round-one',
                kind: 'full-optimization',
                goal: '一轮完整 GEO 优化',
                status: 'awaiting-confirmation',
                stuckStep: {
                  id: 'confirm-articles',
                  title: '批准文章',
                  capability: 'content-production',
                  status: 'awaiting-confirmation',
                },
                pendingConfirmation: {
                  kind: 'article-approval',
                  authority: 'brand-workspace',
                  title: '批准文章',
                  summary: 'confirm article-approval',
                },
                pendingReviewCount: 3,
                createdAt: '2026-08-30T09:00:00Z',
                updatedAt: '2026-08-31T18:00:00Z',
                // 票 #04：该轮不更新品牌知识——查询必须如实呈现复用轮。
                updateKnowledge: false,
              },
              {
                // 无主轮（票 10 验收实证）：sessionId null 原样透传。
                id: 'op-ownerless',
                sessionId: null,
                kind: 'next-round-optimization',
                goal: '新一轮内容优化到发布',
                status: 'awaiting-confirmation',
                stuckStep: {
                  id: 'select-next-question-pool',
                  title: '从问题池选择',
                  capability: 'question-opportunities',
                  status: 'awaiting-confirmation',
                },
                pendingConfirmation: null,
                pendingReviewCount: 0,
                createdAt: '2026-08-30T09:00:00Z',
                updatedAt: '2026-08-31T19:00:00Z',
              },
            ],
          },
        };
        const response = routes[path];
        if (!response) return { ok: false, error: `unrouted:${path}` };
        return response;
      },
    );

    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'integration-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      // 摘要侧不携带任何轮次（只路由了 /unfinished：brand context 其余
      // absent——若摘要仍消费该端点，这里会出现 unfinishedOperations）。
      const summaryResult = await client.callTool({ name: 'inspect_brand_context', arguments: {} });
      const summaryText = (summaryResult.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(summaryText).not.toContain('unfinishedOperations');
      expect(summaryText).not.toContain('op-round-one');

      // 点名续轮查询一次到手：元信息六要素 + 展示阶段；无主轮 sessionId=null；
      // updateKnowledge 缺省为 null（不臆断）、显式 false 为复用轮。
      const result = await client.callTool({
        name: 'inspect_geo_operations',
        arguments: { includeUnfinishedRounds: true },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      const payload = JSON.parse(text) as {
        kind: string;
        total: number;
        truncatedCount: number;
        rounds: Array<Record<string, unknown>>;
      };
      expect(payload.kind).toBe('geo-operation-unfinished-rounds');
      expect(payload.total).toBe(2);
      expect(payload.truncatedCount).toBe(0);
      expect(payload.rounds).toEqual([
        {
          operationId: 'op-round-one',
          sessionId: 'session-round-one',
          kind: 'full-optimization',
          goal: '一轮完整 GEO 优化',
          status: 'awaiting-confirmation',
          stuckStep: {
            id: 'confirm-articles',
            title: '批准文章',
            capability: 'content-production',
            status: 'awaiting-confirmation',
            phase: { id: 'content', title: '内容生产' },
          },
          pendingConfirmation: { kind: 'article-approval', title: '批准文章' },
          pendingReviewCount: 3,
          createdAt: '2026-08-30T09:00:00Z',
          updatedAt: '2026-08-31T18:00:00Z',
          updateKnowledge: false,
        },
        {
          operationId: 'op-ownerless',
          sessionId: null,
          kind: 'next-round-optimization',
          goal: '新一轮内容优化到发布',
          status: 'awaiting-confirmation',
          stuckStep: {
            id: 'select-next-question-pool',
            title: '从问题池选择',
            capability: 'question-opportunities',
            status: 'awaiting-confirmation',
            phase: { id: 'questions', title: '问题机会' },
          },
          pendingConfirmation: null,
          pendingReviewCount: 0,
          createdAt: '2026-08-30T09:00:00Z',
          updatedAt: '2026-08-31T19:00:00Z',
          updateKnowledge: null,
        },
      ]);

      // 查询不含草稿正文与聊天记录：整份工具输出没有任何正文字段。
      expect(text).not.toMatch(/body|transcript|messages/i);
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });

  it('answers an unchanged re-read with a slim envelope and returns full after state changes', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-brand-context-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-dedup',
      workspace: 'C:/ws/brand-a',
    });
    let poolUpdatedAt = '2026-08-27T10:00:00Z';
    vi.mocked(managementApi).mockImplementation(
      async (path: string): Promise<Record<string, unknown>> => {
        const routes: Record<string, Record<string, unknown>> = {
          '/api/brand-materials/context': {
            ok: true,
            context: {
              workspaceId: 'brand-a',
              brandName: '目标品牌',
              productLines: ['汽车音响改装'],
            },
          },
          '/api/brand-question-pools/latest': {
            ok: true,
            pool: {
              status: 'confirmed',
              productLine: '汽车音响改装',
              targetRegion: '成都',
              questions: [{}, {}],
              updatedAt: poolUpdatedAt,
            },
          },
        };
        const response = routes[path];
        if (!response) return { ok: false, error: `unrouted:${path}` };
        return response;
      },
    );

    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'integration-client', version: '1.0.0' });
    await client.connect(clientTransport);
    const readPayload = async (): Promise<Record<string, unknown>> => {
      const result = await client.callTool({ name: 'inspect_brand_context', arguments: {} });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      return JSON.parse(text) as Record<string, unknown>;
    };
    try {
      // 第一次读：全量摘要。
      const first = await readPayload();
      expect(first.kind ?? first.workspaceState).toBeDefined();

      // 状态未变的重读：瘦身信封，不再把整份摘要塞进对话历史。
      const second = await readPayload();
      expect(second).toEqual({
        kind: 'brand-workspace-state-unchanged',
        note: expect.any(String),
      });

      // 状态一变（问题池更新）：序列化不一致，自动回到全量返回。
      poolUpdatedAt = '2026-08-31T09:00:00Z';
      const third = await readPayload();
      expect(third.kind).toBeUndefined();
      expect(third.workspaceState).toMatchObject({
        questionPool: { present: true, state: { updatedAt: '2026-08-31T09:00:00Z' } },
      });
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });
});

describe('generate_articles latest-confirmed-plan fallback over a live MCP server', () => {
  it('forwards an empty call to the start port with topicPlanId null (Rust picks latest confirmed plan)', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-articles-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-articles',
      workspace: 'C:/ws/brand-a',
    });
    const startCalls: Array<Record<string, unknown>> = [];
    // 捕获 start 的请求体：空参必须以 topicPlanId: null 落到端口，
    // 由 Rust「最新 confirmed plan」回落裁决，而不是工具层报错。
    // start 成功后服务按规格回读自身（get_article_operation），一并路由。
    // 顺序闸（票 #05）放行形态：本会话操作当前步 = generate-articles，
    // 空参调用是计划内的当前阶段。
    const gateSteps = planGeoOperation({
      intent: 'article-generation',
      goal: '写文章',
    }).steps.map((step) =>
      step.id === 'generate-articles'
        ? { ...step, status: 'ready' as const }
        : { ...step, status: 'succeeded' as const },
    );
    vi.mocked(managementApi).mockImplementation(
      async (path: string, _method?: string, body?: Record<string, unknown>) => {
        if (path === '/api/brand-articles/start' && body) startCalls.push(body);
        const operation = {
          id: 'article-op-1',
          workspaceId: 'brand-a',
          createdBySessionId: 'session-articles',
          sourceKind: 'confirmed-topic-plan',
          topicPlanId: null,
          topicPlanRevision: null,
          knowledgeVersion: 3,
          policyVersion: 'xiaojing-content-prompt-v9',
          status: 'running',
          articles: [],
          createdAt: '2026-09-01T00:00:00Z',
          updatedAt: '2026-09-01T00:00:00Z',
        };
        const routes: Record<string, Record<string, unknown>> = {
          '/api/brand-articles/start': { ok: true, operation },
          '/api/brand-articles/operation/get': { ok: true, operation },
          '/api/brand-geo-operations/list': {
            ok: true,
            operations: [
              {
                id: 'op-articles-it',
                sessionId: 'session-articles',
                kind: 'article-generation',
                goal: '写文章',
                status: 'running',
                steps: gateSteps,
                revision: 3,
                createdAt: '2026-09-01T00:00:00Z',
                updatedAt: '2026-09-01T00:00:00Z',
              },
            ],
          },
        };
        const response = routes[path];
        if (!response) return { ok: false, error: `unrouted:${path}` };
        return response;
      },
    );

    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'integration-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'generate_articles', arguments: {} });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(result.isError).toBeFalsy();
      expect(startCalls).toHaveLength(1);
      expect(startCalls[0].payload).toMatchObject({
        sourceKind: 'confirmed-topic-plan',
        directSpec: null,
      });
      // planId 缺席（undefined 序列化后字段消失）→ Rust Option<String> 为
      // None →「最新 confirmed plan」回落。显式 null/字符串都会钉住 plan。
      const payload = startCalls[0].payload as Record<string, unknown>;
      expect(payload.topicPlanId ?? null).toBeNull();
      expect(JSON.parse(text)).toMatchObject({ kind: 'article-operation' });
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });

  it('rejects planId and direct together with an actionable error', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-articles-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-articles',
      workspace: 'C:/ws/brand-a',
    });
    // 顺序闸已在注册缝先于入参校验（票 01 唯一登记的窄偏离）：本测试钉
    // 的是互斥入参校验语义本身，必须让闸先放行——操作当前步停在
    // generate-articles（与上一用例同形态），handler 才会跑到纯校验。
    // 「互斥入参 × 越序/读不到状态」交叉点的新口径（闸拒绝信封优先）
    // 由 xiaojing-geo-stage-order-gate.integration.test.ts 守护。
    const gateSteps = planGeoOperation({
      intent: 'article-generation',
      goal: '写文章',
    }).steps.map((step) =>
      step.id === 'generate-articles'
        ? { ...step, status: 'ready' as const }
        : { ...step, status: 'succeeded' as const },
    );
    vi.mocked(managementApi).mockImplementation(
      async (path: string): Promise<Record<string, unknown>> => {
        if (path === '/api/brand-geo-operations/list') {
          return {
            ok: true,
            operations: [
              {
                id: 'op-articles-validation',
                sessionId: 'session-articles',
                kind: 'article-generation',
                goal: '写文章',
                status: 'running',
                steps: gateSteps,
                revision: 3,
                createdAt: '2026-09-01T00:00:00Z',
                updatedAt: '2026-09-01T00:00:00Z',
              },
            ],
          };
        }
        return { ok: false, error: 'unrouted' };
      },
    );

    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'integration-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: 'generate_articles',
        arguments: {
          planId: 'plan-1',
          direct: {
            count: 1,
            themes: ['主题'],
            contentType: 'guide',
            constraints: '无',
          },
        },
      });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      expect(result.isError).toBe(true);
      expect(text).toContain('never both');
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });
});
