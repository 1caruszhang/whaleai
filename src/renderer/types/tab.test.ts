import { describe, expect, it } from 'vitest';

import { buildChatFlipPatch, createNewTab } from './tab';

describe('focused tab contract', () => {
  it('opens chat only with a concrete Session identity', () => {
    const tab = buildChatFlipPatch(createNewTab(), {
      workspacePath: '/brands/acme',
      sessionId: 'session-1',
      title: 'Acme',
      initialMessage: { text: '开始 GEO 诊断' },
    });
    expect(tab).toMatchObject({
      view: 'chat',
      workspacePath: '/brands/acme',
      sessionId: 'session-1',
      initialMessage: { text: '开始 GEO 诊断' },
    });
  });

  it('rejects a chat without a Session identity', () => {
    expect(() => buildChatFlipPatch(createNewTab(), {
      workspacePath: '/brands/acme',
      sessionId: '',
      title: 'Acme',
    })).toThrow('Session id');
  });
});
