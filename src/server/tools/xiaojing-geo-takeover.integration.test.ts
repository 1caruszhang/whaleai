import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { managementApi } from '../utils/management-api-client';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import {
  configureXiaojingGeo,
  createXiaojingGeoServer,
  geoOperationControlFailure,
} from './xiaojing-geo-tool';

/**
 * 接管（ADR-0010）的 MCP 协议级行为（票 #26）：经真实 server + 内存
 * transport 验证 takeover_geo_operation 工具——一次调用完成整卡确认后的
 * 所有权转移（不产生第二确认入口/中间确认态），运行中守卫与 CAS 单赢家
 * 的拒绝以可转述的结构化结果（ok:false + hint）返回，原会话控制失败提示
 * 被哪次会话接管。Rust 端点以 managementApi mock 模拟，无真实网络。
 */
describe('takeover_geo_operation over a live MCP server', () => {
  async function withClient(
    routes: Record<string, Record<string, unknown>>,
    run: (client: Client, calls: unknown[][]) => Promise<void>,
  ): Promise<void> {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-takeover-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-round-two',
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
    const client = new Client({ name: 'takeover-client', version: '1.0.0' });
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

  it('performs the whole ownership transfer in one call with the authenticated envelope', async () => {
    const receipt = {
      operation: {
        id: 'op-round-one',
        sessionId: 'session-round-two',
        status: 'awaiting-confirmation',
        revision: 4,
        takenOverFromSessionId: 'session-round-one',
        takenOverAt: '2026-09-01T09:00:00Z',
      },
      previousOwnerSessionId: 'session-round-one',
      takenOverAt: '2026-09-01T09:00:00Z',
      transferredArticleOperations: 1,
      transferredQuestionPools: 1,
    };
    await withClient(
      {
        '/api/brand-geo-operations/takeover': { ok: true, takeover: receipt },
      },
      async (client, calls) => {
        const result = await client.callTool({
          name: 'takeover_geo_operation',
          arguments: { operationId: 'op-round-one', expectedRevision: 3 },
        });
        // 一次调用即完成转移：成功投影携带回执（接管后所有者、留痕、随行
        // 工作集计数）；不存在中间确认态或第二步确认工具。
        expect(payloadOf(result)).toEqual({
          kind: 'geo-operation-takeover',
          ok: true,
          takeover: receipt,
        });
        // 信封与负载与 Rust 端点契约一致：Sidecar 身份 + 当前 Session。
        expect(calls).toEqual([
          [
            '/api/brand-geo-operations/takeover',
            {
              workspaceId: 'brand-a',
              sessionId: 'session-round-two',
              sidecarId: 'sidecar-takeover-it',
              payload: { operationId: 'op-round-one', expectedRevision: 3 },
            },
          ],
        ]);
      },
    );
  });

  it('relays the running guard as a structured, user-facing reason', async () => {
    await withClient(
      {
        '/api/brand-geo-operations/takeover': {
          ok: false,
          error:
            'geo_operation_takeover_running:running (the owning session is still executing this round; it must pause or finish first)',
        },
      },
      async (client) => {
        const result = await client.callTool({
          name: 'takeover_geo_operation',
          arguments: { operationId: 'op-live', expectedRevision: 2 },
        });
        const payload = payloadOf(result) as {
          kind: string;
          ok: boolean;
          error: string;
          hint: string;
        };
        // 可转述：不是 throw 出去的 isError 单行文本。
        expect(payload.kind).toBe('geo-operation-takeover');
        expect(payload.ok).toBe(false);
        expect(payload.error).toContain('geo_operation_takeover_running:running');
        expect(payload.hint).toContain('暂停');
        expect(payload.hint).toContain('原会话');
      },
    );
  });

  it('names the winning session when a concurrent takeover already won the CAS', async () => {
    await withClient(
      {
        '/api/brand-geo-operations/takeover': {
          ok: false,
          error:
            'geo_operation_takeover_conflict:taken_over_by=session-winner (another session took over this round first)',
        },
      },
      async (client) => {
        const result = await client.callTool({
          name: 'takeover_geo_operation',
          arguments: { operationId: 'op-raced', expectedRevision: 5 },
        });
        const payload = payloadOf(result) as {
          ok: boolean;
          error: string;
          hint: string;
        };
        expect(payload.ok).toBe(false);
        expect(payload.error).toContain('taken_over_by=session-winner');
        expect(payload.hint).toContain('抢先');
      },
    );
  });

  it('tells the previous owner which session took over when it tries to control the round', () => {
    const failure = geoOperationControlFailure(
      new Error(
        'geo_operation_session_mismatch:taken_over_by=session-round-two',
      ),
    );
    expect(failure.kind).toBe('geo-operation-control');
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain('taken_over_by=session-round-two');
    expect(failure.hint).toContain('已被另一个会话接管');
    expect(failure.hint).toContain('停止对该操作的一切控制');
  });
});
