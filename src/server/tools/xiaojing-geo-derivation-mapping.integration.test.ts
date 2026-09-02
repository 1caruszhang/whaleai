import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import { buildSystemPrompt } from '../system-prompt';
import { configureXiaojingGeo, createXiaojingGeoServer } from './xiaojing-geo-tool';

/**
 * 起点推导选项到创建/接管动作映射的协议侧（geo-plan-normalization 票 06），
 * MCP 协议级验证：f74ce69e 实证断裂——「继续上轮」选项是接管语义，模型却
 * 新建了操作；根因之一是 start_geo_operation 描述把 continue last round
 * 列进了「随创建带 startingPointReason」的推导结果枚举。两侧描述与系统
 * 提示词现在三方一致：继续上轮只路由 takeover_geo_operation，开新一轮
 * 创建首选显式带 updateKnowledge=false（票 02 归一兜底，答案不得省略）。
 */
describe('starting-point pick → action mapping over a live MCP server', () => {
  it('keeps start_geo_operation free of the continue-last-round pick and deflection intact', async () => {
    process.env.XIAOJING_SIDECAR_ID = 'sidecar-derivation-mapping-it';
    configureXiaojingGeo({}, {
      sessionId: 'session-derivation-mapping',
      workspace: 'C:/ws/brand-a',
    });
    const config = await createXiaojingGeoServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await config.instance.connect(serverTransport);
    const client = new Client({ name: 'derivation-mapping-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      const startDescription = tools.find(
        (tool) => tool.name === 'start_geo_operation',
      )?.description;
      const takeoverDescription = tools.find(
        (tool) => tool.name === 'takeover_geo_operation',
      )?.description;
      expect(startDescription).toBeDefined();
      expect(takeoverDescription).toBeDefined();

      // 创建侧不再把 continue last round 列进随创建带理由的推导枚举，
      // 并显式把该选择指离本工具（改调接管）。
      expect(startDescription).not.toContain('continue last round /');
      expect(startDescription).toContain(
        'Never call this tool for the continue-last-round pick',
      );
      expect(startDescription).toContain('call takeover_geo_operation instead');
      // 开新一轮的首选路径：创建显式带 updateKnowledge=false，答案不得省略。
      expect(startDescription).toContain("pass updateKnowledge=false explicitly");
      expect(startDescription).toContain('the preferred path');
      expect(startDescription).toContain('must not be omitted');
      // 与票 02 归一零矛盾：描述承认两入口同形（归一兜底）。
      expect(startDescription).toContain('identical step shape');

      // 接管侧：起点推导的继续上轮选项就是那次整卡确认，选定即调本工具。
      expect(takeoverDescription).toContain(
        'The continue-last-round option in the starting-point derivation question IS that one whole-card confirmation',
      );
      expect(takeoverDescription).toContain(
        'routing that pick into start_geo_operation (creating a new round) is the wrong action',
      );
    } finally {
      await client.close();
      await config.instance.close();
      delete process.env.XIAOJING_SIDECAR_ID;
    }
  });

  // 引用一致性（票 06）：两侧描述与系统提示词对同一映射各执一词时模型才会
  // 现场排序——三方关键约束同屏锁定。
  it('keeps the prompt side consistent with both tool descriptions on the exclusive mapping', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('接管信号，不是新开轮次信号');
    expect(prompt).toContain('新建操作是错误动作');
    expect(prompt).toContain('updateKnowledge 传 false');
    expect(prompt).toContain('首选非强制');
  });
});
