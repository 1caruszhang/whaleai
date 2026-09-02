import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import { GEO_NEXT_STEP_GUIDES } from '../geo/operation-progress';
import { MATERIAL_COLLECTION_CONTRACT } from '../../shared/geo/materialRequestCard';
import { buildSystemPrompt } from '../system-prompt';
import { configureXiaojingGeo, createXiaojingGeoServer } from './xiaojing-geo-tool';

/**
 * 材料收集契约的协议侧（geo-plan-normalization 票 03），MCP 协议级验证：
 * 契约话术逐字落在三处——request_brand_material 工具描述、next-step 单表
 * 的 collect-materials 条目、系统提示词材料段（模式对齐问题池复用契约的
 * xiaojing-geo-question-pool-reuse 先例）。触发条件 (1) 不携带知识状态
 * 限定词——「更新知识」轮次（品牌有确认知识但明确要更新）收到
 * collect-materials 的 next-step 信封时按计划调用即可，信封与工具描述
 * 不再打架；计划外两个入口（用户点名补材料、不可直读二进制附件）保留。
 */
describe('material-collection contract over a live MCP server', () => {
  it('states the contract verbatim in the tool description, the next-step table and the system prompt', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-material-contract-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-material-contract',
      workspace: 'C:/ws/brand-a',
    });
    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'material-contract-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const described = (await client.listTools()).tools.find(
        (tool) => tool.name === 'request_brand_material',
      )?.description;
      expect(described).toBeDefined();
      // 第一处：工具描述逐字含契约。
      expect(described).toContain(MATERIAL_COLLECTION_CONTRACT);
      // 触发条件 (1) 的知识状态限定词不得回归（票 03 去限定词）。
      expect(described).not.toContain('no confirmed knowledge');
      expect(described).not.toContain('too thin for the goal');
      // 计划外入口保留且不受影响。
      expect(described).toContain('the user explicitly asks to add brand material');
      expect(described).toContain(
        'the user attached a binary file that read_session_file cannot parse',
      );
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
    // 第二处：next-step 单表条目逐字含契约（信封引述即同源）。
    expect(GEO_NEXT_STEP_GUIDES['collect-materials']!.guidance).toContain(
      MATERIAL_COLLECTION_CONTRACT,
    );
    // 第三处：系统提示词材料段逐字含契约。
    expect(buildSystemPrompt()).toContain(MATERIAL_COLLECTION_CONTRACT);
  });
});
