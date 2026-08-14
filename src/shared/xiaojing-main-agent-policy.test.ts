import { describe, expect, it } from 'vitest';

import {
  XIAOJING_MAIN_AGENT,
  isXiaojingMainAgentMcpServer,
  isXiaojingMainAgentTool,
} from './xiaojing-main-agent-policy';

describe('Xiaojing main Agent policy', () => {
  it('pins the only supported provider, model and reasoning effort', () => {
    expect(XIAOJING_MAIN_AGENT).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    });
  });

  it('admits only Xiaojing GEO capabilities and host questions', () => {
    expect(isXiaojingMainAgentMcpServer('xiaojing-geo')).toBe(true);
    expect(isXiaojingMainAgentMcpServer('playwright')).toBe(false);
    expect(isXiaojingMainAgentTool('mcp__xiaojing-geo__audit_brand')).toBe(true);
    expect(isXiaojingMainAgentTool('AskUserQuestion')).toBe(true);
    expect(isXiaojingMainAgentTool('Bash')).toBe(false);
    expect(isXiaojingMainAgentTool('Read')).toBe(false);
    expect(isXiaojingMainAgentTool('mcp__github__create_issue')).toBe(false);
  });
});
