import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { managementApi } from '../utils/management-api-client';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import {
  planGeoOperation,
  type GeoOperationProjection,
  type GeoOperationStep,
} from '../../shared/geo/operation';
import { GEO_STAGE_ORDER_GATED_TOOLS } from '../geo/stage-order-gate';
import type { QuestionPoolProjection } from '../../shared/geo/questionPool';
import { configureXiaojingGeo, createXiaojingGeoServer } from './xiaojing-geo-tool';

/**
 * 顺序闸的 MCP 协议级行为（票 #05，spec 2026-09-02 决策 4）：五个有后果
 * 阶段工具的入口校验经真实 server + 内存 transport 验证——越序调用在
 * 任何业务工作（真实 Provider 花费）之前被结构化指路拒绝，拒绝信封复用
 * next-step 引述结构；无操作时 freestyle 被拒并指路先建操作；接管后的
 * 轮次不误拒；只读查询与材料工具不经闸。Rust 端点以 managementApi mock
 * 模拟，无真实网络。
 */

function planSteps(input: Parameters<typeof planGeoOperation>[0]): GeoOperationStep[] {
  return structuredClone(planGeoOperation(input).steps);
}

/** 标记计划序上到 lastSucceededId（含）的步骤为已走完。 */
function progressedThrough(
  steps: GeoOperationStep[],
  lastSucceededId: string,
): GeoOperationStep[] {
  const last = steps.findIndex((step) => step.id === lastSucceededId);
  expect(last).toBeGreaterThanOrEqual(0);
  return steps.map((step, index) =>
    index <= last ? { ...step, status: 'succeeded' as const } : { ...step },
  );
}

function gateOperation(
  steps: GeoOperationStep[],
  overrides: Partial<GeoOperationProjection> = {},
): GeoOperationProjection {
  return {
    id: 'op-gate-it',
    workspaceId: 'brand-a',
    sessionId: 'session-gate-it',
    kind: 'full-optimization',
    goal: '一轮完整的 GEO 优化',
    status: 'running',
    steps,
    inputRefs: [],
    artifactRefs: [],
    checkpoint: null,
    pendingConfirmation: null,
    error: null,
    sourceOperationId: null,
    updateKnowledge: null,
    revision: 7,
    executionGeneration: 1,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:10:00Z',
    terminalAt: null,
    ...overrides,
  };
}

const STAGE_TOOL_ARGUMENTS: Record<string, Record<string, unknown>> = {
  run_question_pool: { productLine: '汽车音响改装', targetRegion: '成都' },
  plan_topics: {},
  generate_articles: {},
  plan_distribution: { targetAudience: '本地车主' },
  prepare_publish: {},
};

async function withClient(
  routes: Record<string, Record<string, unknown>>,
  run: (client: Client, calls: unknown[][]) => Promise<void>,
): Promise<void> {
  process.env.XIAOJING_SIDECAR_ID = 'sidecar-order-gate-it';
  configureXiaojingGeo({}, {
    sessionId: 'session-gate-it',
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
  const client = new Client({ name: 'order-gate-client', version: '1.0.0' });
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

describe('stage-tool order gate over a live MCP server', () => {
  it('covers exactly the five stage tools, all really registered', async () => {
    await withClient({}, async (client) => {
      const registered = new Set(
        (await client.listTools()).tools.map((tool) => tool.name),
      );
      for (const tool of GEO_STAGE_ORDER_GATED_TOOLS) {
        expect(registered.has(tool)).toBe(true);
      }
    });
  });

  it('rejects every out-of-order stage call before any business work, quoting the real current step', async () => {
    // 计划刚放行、当前步是收集品牌材料：五个阶段工具全部越序，拒绝信封
    // 引述应调工具 request_brand_material（f74ce69e 的分叉场景）。
    const operation = gateOperation(
      progressedThrough(
        planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }),
        'acknowledge-plan',
      ),
    );
    await withClient(
      { '/api/brand-geo-operations/list': { ok: true, operations: [operation] } },
      async (client, calls) => {
        for (const tool of GEO_STAGE_ORDER_GATED_TOOLS) {
          const result = await client.callTool({
            name: tool,
            arguments: STAGE_TOOL_ARGUMENTS[tool] ?? {},
          });
          const payload = payloadOf(result);
          expect(payload).toMatchObject({
            kind: 'geo-stage-order-gate',
            ok: false,
            error: 'geo_stage_tool_out_of_order',
            tool,
          });
          expect(payload.nextStep).toEqual({
            stepId: 'collect-materials',
            tool: 'request_brand_material',
            guidance: expect.any(String),
            planRevision: 7,
          });
          expect(payload.hint).toContain('request_brand_material');
        }
        // 只发生会话作用域的操作读取（每个被闸工具恰好一次）：没有任何
        // 阶段业务路由被触达（问题池/计划/文章/分发/发布预览的真实
        // Provider 花费零发生）。
        expect(calls).toEqual(
          Array.from({ length: GEO_STAGE_ORDER_GATED_TOOLS.length }, () => [
            '/api/brand-geo-operations/list',
            {
              workspaceId: 'brand-a',
              sessionId: 'session-gate-it',
              sidecarId: 'sidecar-order-gate-it',
              payload: {},
            },
          ]),
        );
      },
    );
  });

  it('rejects an out-of-order generate_articles call before its mutual-exclusion input validation (registered deviation)', async () => {
    // 票 01 唯一登记的行为偏离（spec 2026-09-03 决策 2）：闸上移注册缝后
    // 无条件先于 handler 一切工作（含纯入参解析）——「互斥入参错误 ×
    // 越序调用」交叉点从 isError 校验错（'never both'）变为闸拒绝信封。
    // 越序＋坏入参时给指路信封比给校验错更有用；校验语义本身在闸放行
    // 后原样生效（xiaojing-geo-brand-context.integration.test.ts）。
    const operation = gateOperation(
      progressedThrough(
        planSteps({ intent: 'full-optimization', goal: '一轮完整的 GEO 优化' }),
        'acknowledge-plan',
      ),
    );
    await withClient(
      { '/api/brand-geo-operations/list': { ok: true, operations: [operation] } },
      async (client, calls) => {
        const result = await client.callTool({
          name: 'generate_articles',
          arguments: {
            planId: 'plan-1',
            direct: { count: 1, themes: ['主题'], contentType: 'guide', constraints: '无' },
          },
        });
        const payload = payloadOf(result);
        // 信封口径与既有越序用例一致：结构化指路，不是校验 isError。
        expect(payload).toMatchObject({
          kind: 'geo-stage-order-gate',
          ok: false,
          error: 'geo_stage_tool_out_of_order',
          tool: 'generate_articles',
        });
        expect(payload.nextStep).toEqual({
          stepId: 'collect-materials',
          tool: 'request_brand_material',
          guidance: expect.any(String),
          planRevision: 7,
        });
        const text =
          (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
        expect(text).not.toContain('never both');
        // 闸先于一切业务工作：恰一次操作列表查询，零业务路由触达。
        expect(calls).toEqual([
          [
            '/api/brand-geo-operations/list',
            {
              workspaceId: 'brand-a',
              sessionId: 'session-gate-it',
              sidecarId: 'sidecar-order-gate-it',
              payload: {},
            },
          ],
        ]);
      },
    );
  });

  it('rejects freestyle stage calls with no operations and points to creating one', async () => {
    await withClient(
      { '/api/brand-geo-operations/list': { ok: true, operations: [] } },
      async (client, calls) => {
        for (const tool of GEO_STAGE_ORDER_GATED_TOOLS) {
          const result = await client.callTool({
            name: tool,
            arguments: STAGE_TOOL_ARGUMENTS[tool] ?? {},
          });
          const payload = payloadOf(result);
          expect(payload).toMatchObject({
            kind: 'geo-stage-order-gate',
            ok: false,
            error: 'geo_stage_tool_requires_operation',
            tool,
          });
          expect(payload.hint).toContain('start_geo_operation');
        }
        const businessCalls = calls.filter(([path]) =>
          String(path) !== '/api/brand-geo-operations/list',
        );
        expect(businessCalls).toEqual([]);
      },
    );
  });

  it('does not reject a taken-over round: the matching current step lets the business path run', async () => {
    // 接管后的复用轮（sessionId 已归本会话）：当前步 select-next-question-pool
    // 恰引述 run_question_pool——放行，业务真实推进到问题池 prepare。
    const operation = gateOperation(
      progressedThrough(
        planSteps({ intent: 'next-round-optimization', goal: '下一轮优化', updateKnowledge: false }),
        'acknowledge-plan',
      ),
      {
        kind: 'next-round-optimization',
        updateKnowledge: false,
        takenOverFromSessionId: 'session-previous-owner',
        takenOverAt: '2026-09-02T00:08:00Z',
      },
    );
    const pool = {
      id: 'pool-order-gate',
      status: 'confirmed',
      reused: true,
    } as QuestionPoolProjection;
    const reusedContext = {
      knowledgeVersion: 7,
      brandName: '目标品牌',
      productLines: ['汽车音响改装'],
      facts: [],
      recentSelectedQuestions: [],
      keywordLibrary: [],
    };
    await withClient(
      {
        '/api/brand-geo-operations/list': { ok: true, operations: [operation] },
        '/api/brand-question-pools/prepare': {
          ok: true,
          preparation: { kind: 'reused', context: reusedContext, attempt: null, pool },
        },
      },
      async (client, calls) => {
        const result = await client.callTool({
          name: 'run_question_pool',
          arguments: { productLine: '汽车音响改装', targetRegion: '成都' },
        });
        const payload = payloadOf(result);
        // 业务路径真实放行：拿到问题池信封，而不是拒绝。
        expect(payload.kind).toBe('question-pool');
        expect(payload.pool).toMatchObject({ id: 'pool-order-gate' });
        // 闸的查找口径：会话作用域 list（payload 缺省即 includeAllSessions
        // 不放宽），先于任何业务调用。
        const listCalls = calls.filter(
          ([path]) => path === '/api/brand-geo-operations/list',
        );
        expect(listCalls.length).toBeGreaterThanOrEqual(1);
        expect(listCalls[0]).toEqual([
          '/api/brand-geo-operations/list',
          {
            workspaceId: 'brand-a',
            sessionId: 'session-gate-it',
            sidecarId: 'sidecar-order-gate-it',
            payload: {},
          },
        ]);
        expect(
          calls.some(([path]) => path === '/api/brand-question-pools/prepare'),
        ).toBe(true);
      },
    );
  });

  it('fails closed when the operations list read errors: unavailable envelope, zero business calls', async () => {
    // 闸的安全姿态（票 01 补钉，此前全仓零覆盖）：操作状态读不到就无从
    // 裁决顺序——五个阶段工具全部被 fail-closed 拒绝并指路重读，绝不
    // 半执行（真实 Provider 花费零发生）。
    await withClient(
      { '/api/brand-geo-operations/list': { ok: false, error: 'rust_management_unreachable' } },
      async (client, calls) => {
        for (const tool of GEO_STAGE_ORDER_GATED_TOOLS) {
          const result = await client.callTool({
            name: tool,
            arguments: STAGE_TOOL_ARGUMENTS[tool] ?? {},
          });
          const payload = payloadOf(result);
          expect(payload).toMatchObject({
            kind: 'geo-stage-order-gate',
            ok: false,
            error: 'geo_stage_order_unavailable',
            tool,
          });
          expect(payload.hint).toContain('inspect_geo_operations');
        }
        // 每个被闸工具恰好一次操作列表查询（全部报错），零业务路由触达。
        expect(calls).toEqual(
          Array.from({ length: GEO_STAGE_ORDER_GATED_TOOLS.length }, () => [
            '/api/brand-geo-operations/list',
            {
              workspaceId: 'brand-a',
              sessionId: 'session-gate-it',
              sidecarId: 'sidecar-order-gate-it',
              payload: {},
            },
          ]),
        );
      },
    );
  });

  it('keeps read-only queries and material tools ungated', async () => {
    // 同样「无操作」的状态下：只读查询照常应答（保护「先重读操作状态」
    // 纪律畅通），材料请求卡照常发卡（计划外补材料是合法入口）。
    await withClient(
      { '/api/brand-geo-operations/list': { ok: true, operations: [] } },
      async (client) => {
        const inspect = await client.callTool({
          name: 'inspect_geo_operations',
          arguments: {},
        });
        expect(payloadOf(inspect)).toMatchObject({ kind: 'geo-operation-projection' });

        const material = await client.callTool({
          name: 'request_brand_material',
          arguments: { reason: '补充品牌资料' },
        });
        expect(payloadOf(material)).toMatchObject({ kind: 'material-request-card' });
      },
    );
  });
});
