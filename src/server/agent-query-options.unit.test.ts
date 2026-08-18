import { describe, expect, it } from 'vitest';

import { buildAgentQueryOptions } from './agent-query-options';
import { XIAOJING_MAIN_AGENT } from '../shared/xiaojing-main-agent-policy';

const SDK_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

function build(overrides: Partial<Parameters<typeof buildAgentQueryOptions>[0]> = {}) {
  return buildAgentQueryOptions({
    abortController: new AbortController(),
    cwd: '/tmp/workspace',
    sessionId: 'session-1',
    resume: false,
    geoServer: { type: 'stdio' } as never,
    env: {},
    systemPrompt: 'prompt',
    canUseTool: async () => ({ behavior: 'allow' }),
    ...overrides,
  });
}

describe('buildAgentQueryOptions', () => {
  it('sources permissionMode from the policy table and stays a legal SDK mode', () => {
    const options = build();
    expect(options.permissionMode).toBe(XIAOJING_MAIN_AGENT.permissionMode);
    expect(SDK_PERMISSION_MODES).toContain(options.permissionMode);
  });

  it('sources model, effort, builtin tools and the GEO MCP server from the policy table', () => {
    const options = build();
    expect(options.model).toBe(XIAOJING_MAIN_AGENT.model);
    expect(options.effort).toBe(XIAOJING_MAIN_AGENT.reasoningEffort);
    expect(options.tools).toEqual([...XIAOJING_MAIN_AGENT.builtinTools]);
    expect(Object.keys(options.mcpServers ?? {})).toEqual([
      XIAOJING_MAIN_AGENT.geoMcpServerId,
    ]);
  });

  it('keeps thinking disabled: the DeepSeek endpoint never emits Claude thinking blocks', () => {
    expect(build().thinking).toEqual({ type: 'disabled' });
  });

  it('switches between creating and resuming the SDK session by sessionId', () => {
    expect(build({ resume: false })).toMatchObject({ sessionId: 'session-1' });
    expect(build({ resume: true })).toMatchObject({ resume: 'session-1' });
  });
});
