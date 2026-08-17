import { describe, expect, it } from 'vitest';

import type { Tab } from '@/types/tab';
import { tabContentKind } from './tabContentKind';

const tab = (view: Tab['view']): Tab => ({
  id: view,
  workspacePath: view === 'chat' ? '/brands/acme' : null,
  sessionId: view === 'chat' ? 'session-1' : null,
  view,
  title: view,
});

describe('focused tab content', () => {
  it('dispatches the complete product route table', () => {
    expect(tabContentKind(tab('welcome'), false)).toBe('welcome');
    expect(tabContentKind(tab('settings'), false)).toBe('settings');
    expect(tabContentKind(tab('brand-archive'), false)).toBe('brand-archive');
    expect(tabContentKind(tab('chat'), false)).toBe('chat');
  });
});
