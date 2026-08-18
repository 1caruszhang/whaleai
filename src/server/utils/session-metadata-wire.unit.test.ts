import { describe, expect, it } from 'vitest';

import { toClientSessionMetadata } from './session-metadata-wire';

describe('toClientSessionMetadata', () => {
  it('projects the safe wire shape, omits unknown storage fields and preserves storage metadata', () => {
    const metadata = {
      id: 'session-1',
      workspacePath: '/brand/acme',
      title: 'Acme GEO',
      createdAt: '2026-08-16T00:00:00.000Z',
      lastActiveAt: '2026-08-16T00:01:00.000Z',
      providerEnvJson: '{"API_KEY":"secret"}',
      stats: {
        messageCount: 3,
        totalInputTokens: 10,
        totalOutputTokens: 2,
      },
    };

    const result = toClientSessionMetadata(metadata);

    expect(result).toEqual({
      id: 'session-1',
      workspacePath: '/brand/acme',
      title: 'Acme GEO',
      createdAt: '2026-08-16T00:00:00.000Z',
      lastActiveAt: '2026-08-16T00:01:00.000Z',
      stats: {
        turnCount: 3,
        totalInputTokens: 10,
        totalOutputTokens: 2,
        totalCacheReadTokens: undefined,
        totalCacheCreationTokens: undefined,
      },
    });
    expect(metadata.stats).toHaveProperty('messageCount', 3);
    expect(metadata.providerEnvJson).toContain('secret');
    expect(result).not.toHaveProperty('providerEnvJson');
  });
});
