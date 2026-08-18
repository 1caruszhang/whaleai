import { describe, expect, it } from 'vitest';

import type { Tab } from '@/types/tab';
import { deserializeTabs, hydratePersistedState, serializeTabs } from './tabPersistence';

function chat(id: string, sessionId: string): Tab {
  return { id, sessionId, workspacePath: `/brands/${id}`, view: 'chat', title: id };
}

describe('multi-Session tab persistence', () => {
  it('round-trips multiple real Sessions and drops non-chat surfaces', () => {
    const state = serializeTabs([
      chat('a', 'session-a'),
      { id: 'welcome', workspacePath: null, sessionId: null, view: 'welcome', title: '品牌工作台' },
      chat('b', 'session-b'),
    ], 'b');
    const parsed = deserializeTabs(JSON.stringify(state));
    const hydrated = hydratePersistedState(parsed!);
    expect(hydrated.tabs.map((tab) => tab.sessionId)).toEqual(['session-a', 'session-b']);
    expect(hydrated.activeTabId).toBe('b');
  });

  it('deduplicates the same Session identity', () => {
    const state = serializeTabs([chat('a', 'session-a'), chat('b', 'session-a')], 'a');
    expect(state?.tabs).toHaveLength(1);
  });
});
