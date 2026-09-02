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
} from '../../shared/geo/operation';
import { configureXiaojingGeo, createXiaojingGeoServer } from './xiaojing-geo-tool';

/**
 * 跳过出口的协议侧（geo-plan-normalization 票 07），MCP 协议级验证：
 * (1) 计划停在 collect-materials 时发出的材料请求卡携带操作锚点
 * （operationId + revision）——跳过动作的操作身份由此贯通，卡片不再只是
 * 上传入口；(2) 计划外补材料（无停泊操作）出卡不携带锚点，入口不受
 * 影响；(3) skip_material_collection 工具走既有 replace-plan 动作：载荷
 * 携带 material-collection-skip 场景、剥离知识段剩余步骤的替换步骤与
 * updateKnowledge=false。Rust 端点以 managementApi mock 模拟，无真实网络。
 */

/** 停在材料收集步骤的全链轮：认可门成功，collect-materials ready。 */
function parkedAtMaterialCollection(): GeoOperationProjection {
  const steps = planGeoOperation({
    intent: 'full-optimization',
    goal: '一轮完整的 GEO 优化',
  }).steps.map((step, index) =>
    index === 0
      ? { ...step, status: 'succeeded' as const }
      : index === 1
        ? { ...step, status: 'ready' as const }
        : { ...step },
  );
  return {
    id: 'op-skip-07',
    workspaceId: 'brand-skip',
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
    updateKnowledge: true,
    revision: 7,
    executionGeneration: 1,
    executionSidecarGeneration: null,
    queueReason: null,
    queuePosition: null,
    createdAt: '2026-09-02T00:00:00Z',
    updatedAt: '2026-09-02T00:10:00Z',
    terminalAt: null,
  };
}

/** 跳过后的持久化形态：知识段剥离，从 generate-question-pool 续接。 */
function operationAfterSkip(): GeoOperationProjection {
  const steps = parkedAtMaterialCollection().steps
    .filter((step) => !['collect-materials', 'extract-facts', 'confirm-knowledge'].includes(step.id))
    .map((step, index) => ({
      ...step,
      status: index === 1 ? ('ready' as const) : step.status,
    }));
  return { ...parkedAtMaterialCollection(), steps, status: 'ready', updateKnowledge: false, revision: 8 };
}

async function withClient(
  routes: Record<string, Record<string, unknown>>,
  run: (client: Client, calls: unknown[][]) => Promise<void>,
): Promise<void> {
  process.env.XIAOJING_SIDECAR_ID = 'sidecar-skip-exit-it';
  configureXiaojingGeo({}, {
    sessionId: 'session-skip-exit',
    workspace: 'C:/ws/brand-skip',
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
  const client = new Client({ name: 'skip-exit-client', version: '1.0.0' });
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

describe('material-collection skip exit over a live MCP server', () => {
  it('embeds the parked operation anchor in the material request card', async () => {
    const parked = parkedAtMaterialCollection();
    await withClient(
      {
        '/api/brand-geo-operations/list': { ok: true, operations: [parked] },
      },
      async (client) => {
        const result = await client.callTool({
          name: 'request_brand_material',
          arguments: { reason: '按计划停在材料收集步骤，请补充品牌材料。' },
        });
        const payload = payloadOf(result);
        expect(payload.kind).toBe('material-request-card');
        expect(payload.requiresUserDecision).toBe(true);
        // 操作身份贯通（票 07 易错点）：卡片携带停泊操作的 CAS 锚点。
        expect(payload.skipTarget).toEqual({
          operationId: 'op-skip-07',
          expectedRevision: 7,
        });
      },
    );
  });

  it('issues the card without a skip anchor when no operation parks at material collection', async () => {
    await withClient(
      {
        '/api/brand-geo-operations/list': { ok: true, operations: [] },
      },
      async (client) => {
        const result = await client.callTool({
          name: 'request_brand_material',
          arguments: { reason: '用户主动要求补充品牌材料。' },
        });
        const payload = payloadOf(result);
        // 计划外补材料入口不受影响：卡片照常发出，只是没有跳过动作。
        expect(payload.kind).toBe('material-request-card');
        expect(payload.skipTarget).toBeNull();
      },
    );
  });

  it('skips through the existing replace-plan action with the skip cause and stripped steps', async () => {
    const parked = parkedAtMaterialCollection();
    const replaced = operationAfterSkip();
    await withClient(
      {
        '/api/brand-geo-operations/get': { ok: true, operation: parked },
        '/api/brand-geo-operations/mutate': { ok: true, operation: replaced },
      },
      async (client, calls) => {
        const result = await client.callTool({
          name: 'skip_material_collection',
          arguments: { operationId: 'op-skip-07', expectedRevision: 7 },
        });
        const payload = payloadOf(result);
        expect(payload.kind).toBe('geo-operation');
        expect(payload.operation).toMatchObject({
          id: 'op-skip-07',
          status: 'ready',
          updateKnowledge: false,
        });

        const mutateCalls = calls.filter(([path]) =>
          path === '/api/brand-geo-operations/mutate');
        expect(mutateCalls).toHaveLength(1);
        const body = (mutateCalls[0]![1] as Record<string, unknown>).payload as Record<string, unknown>;
        expect(body.action).toBe('replace-plan');
        // 场景载荷让 Rust 守卫按跳过形态校验，不与分支决策停卡混用。
        expect(body.replacementReason).toBe('material-collection-skip');
        // 跳过即本轮不更新知识：决策随替换一次落库。
        expect(body.updateKnowledge).toBe(false);
        const steps = body.replacementSteps as Array<{ id: string }>;
        expect(steps.map((step) => step.id)).not.toContain('collect-materials');
        expect(steps.map((step) => step.id)).not.toContain('extract-facts');
        expect(steps.map((step) => step.id)).not.toContain('confirm-knowledge');
        // 已完成的认可门保留，后续段原样跟随。
        expect(steps[0]!.id).toBe('acknowledge-plan');
        expect(steps[1]!.id).toBe('generate-question-pool');
      },
    );
  });
});
