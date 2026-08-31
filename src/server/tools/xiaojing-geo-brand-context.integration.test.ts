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

/**
 * 跨 Session 状态盲区回归（MCP 协议级）：新 Session 的 agent 第一个动作
 * 是经真实 MCP server 调用 inspect_brand_context，必须一次拿到 Rust 持久的
 * 品牌状态摘要（含第一轮已确认的 5 家竞品），而不是向用户重新征集；
 * 另一用例覆盖 ADR-0010 Decision 3 的跨会话未完成轮次元信息（五要素，
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
      // 无未完成轮次：未走到的 /unfinished 端点按 absent 降级，摘要与
      // 现状回归一致（AC3：既有跨会话状态盲区回归不破）。
      expect(payload.workspaceState).toMatchObject({
        kind: 'brand-workspace-state',
        brandName: '目标品牌',
        confirmedCompetitors: ['竞品甲', '竞品乙', '竞品丙', '竞品丁', '竞品戊'],
        questionPool: { present: true, state: { questionCount: 3 } },
        articles: { present: true, state: { articleCount: 2, approvedCount: 2 } },
        distributionPlan: { present: true, state: { status: 'confirmed' } },
        publish: { present: true, state: { status: 'scheduled' } },
        unfinishedOperations: { present: false },
      });
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });

  it('returns unfinished cross-session operation metadata with the five elements and no bodies', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-brand-context-it';
    // 新 Session：上一轮在另一个 Session 做到文章批准门，草稿审到一半。
    configureXiaojingGeo({}, {
      sessionId: 'session-round-two',
      workspace: 'C:/ws/brand-a',
    });
    vi.mocked(managementApi).mockImplementation(
      async (path: string): Promise<Record<string, unknown>> => {
        // 只路由 /unfinished：其余阶段读取降级为 absent，不影响本断言。
        const routes: Record<string, Record<string, unknown>> = {
          '/api/brand-geo-operations/unfinished': {
            ok: true,
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
      const result = await client.callTool({ name: 'inspect_brand_context', arguments: {} });
      const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
      const payload = JSON.parse(text) as {
        workspaceState: {
          unfinishedOperations:
            | { present: false }
            | {
                present: true;
                state: { operations: unknown[] };
              };
        };
      };

      // 元信息五要素一次到手：类型、卡住步骤/阶段、待审数量、所属会话、时间。
      expect(payload.workspaceState.unfinishedOperations).toEqual({
        present: true,
        state: {
          operations: [
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
            },
          ],
        },
      });

      // 摘要不含草稿正文与聊天记录（AC2）：整份工具输出没有任何正文字段
      // 或会话转录（其他阶段本就被路由为 absent）。
      expect(text).not.toMatch(/body|transcript|messages/i);
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });
});
