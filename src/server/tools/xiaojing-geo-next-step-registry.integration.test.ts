import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import { GEO_NEXT_STEP_GUIDES } from '../geo/operation-progress';
import { configureXiaojingGeo, createXiaojingGeoServer } from './xiaojing-geo-tool';

/**
 * next-step 单表与 MCP 工具注册表的一致性（ADR-0011 Decision 2，票 #30）：
 * 决策回执信封引述的工具名必须真实存在于 xiaojing-geo 注册表——信封引述
 * 一个不存在的工具会把 agent 卡在「照单执行却无处可调」的死锁里。经真实
 * MCP server 的 listTools 枚举注册表（协议级，不靠源码静态扫描）。
 */
describe('GEO_NEXT_STEP_GUIDES vs the live MCP tool registry', () => {
  it('every tool quoted by the next-step table is really registered', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-next-step-registry-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-next-step-registry',
      workspace: 'C:/ws/brand-a',
    });

    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'registry-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const registered = new Set(
        (await client.listTools()).tools.map((tool) => tool.name),
      );
      // 注册表本身非空，避免空集把断言变成恒真。
      expect(registered.size).toBeGreaterThan(0);

      const quoted = new Set(
        Object.values(GEO_NEXT_STEP_GUIDES).map((guide) => guide.tool),
      );
      expect(quoted).toEqual(
        new Set([
          'request_brand_material',
          'choose_next_round_knowledge',
          'run_question_pool',
          'plan_topics',
          'generate_articles',
          'plan_distribution',
          'prepare_publish',
        ]),
      );
      const missing = [...quoted].filter((tool) => !registered.has(tool));
      expect(missing).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
