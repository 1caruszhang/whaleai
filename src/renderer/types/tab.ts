import type { ImageAttachment } from '@/components/SimpleChatInput';

export interface InitialMessage {
  text: string;
  images?: ImageAttachment[];
}

export interface Tab {
  id: string;
  workspacePath: string | null;
  sessionId: string | null;
  view: 'welcome' | 'chat' | 'settings' | 'brand-archive' | 'brand-effect';
  title: string;
  isGenerating?: boolean;
  hasUnread?: boolean;
  initialMessage?: InitialMessage;
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
}

export const MAX_TABS = 12;

export function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getFolderName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

export function createNewTab(): Tab {
  return {
    id: generateTabId(),
    workspacePath: null,
    sessionId: null,
    view: 'welcome',
    title: '新标签页',
  };
}

export function buildChatFlipPatch(
  tab: Tab,
  fields: {
    workspacePath: string;
    sessionId: string;
    title: string;
    initialMessage?: InitialMessage;
  },
): Tab {
  if (!fields.sessionId) throw new Error('buildChatFlipPatch requires a Session id');
  return {
    ...tab,
    workspacePath: fields.workspacePath,
    sessionId: fields.sessionId,
    view: 'chat',
    title: fields.title,
    ...(fields.initialMessage ? { initialMessage: fields.initialMessage } : {}),
  };
}
