import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme } from '@/test/renderWithTheme';
import Chat from './Chat';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  hasMessages: false,
}));

vi.mock('@/context/TabContext', () => ({
  useTabState: () => ({
    workspacePath: '/brands/brand-19',
    sessionId: 'session-26',
    messages: mocks.hasMessages
      ? [{ id: 'message-1', role: 'user', content: '上一条消息' }]
      : [],
    streamingMessage: null,
    isLoading: false,
    isSessionLoading: false,
    sessionRestoreError: null,
    isConnected: true,
    agentError: null,
    setAgentError: vi.fn(),
    systemNotice: null,
    setSystemNotice: vi.fn(),
    pendingAskUserQuestion: null,
    respondAskUserQuestion: vi.fn(),
    sendMessage: mocks.sendMessage,
    stopResponse: vi.fn(),
    retryCurrentSessionRestore: vi.fn(),
  }),
}));

vi.mock('@/components/SimpleChatInput', () => ({
  default: () => <div data-chat-input-stub />,
}));

vi.mock('@/components/Message', () => ({
  default: ({ message }: { message: { id: string } }) => (
    <div data-message-stub={message.id} />
  ),
}));

vi.mock('@/context/FileActionContext', () => ({
  FileActionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useWorkspaceChangeSignal', () => ({
  useWorkspaceChangeSignal: () => 0,
}));

describe('Chat empty-state starter suggestions', () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue(true);
    mocks.hasMessages = false;
  });

  it('sends the preset message through the normal chat send path on click', () => {
    renderWithTheme(<Chat sessionTitle="小鲸科技" />);

    fireEvent.click(
      screen.getByRole('button', { name: /问题机会发现/ }),
    );

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      '请为当前品牌挖掘 GEO 问题机会，先确认行业、地域和重点产品线。',
      undefined,
      undefined,
    );
  });

  it('shows the suggestions only while the conversation is empty', () => {
    const { unmount } = renderWithTheme(<Chat sessionTitle="小鲸科技" />);
    expect(
      screen.getByRole('button', { name: /完整 GEO 优化/ }),
    ).toBeInTheDocument();
    unmount();

    mocks.hasMessages = true;
    renderWithTheme(<Chat sessionTitle="小鲸科技" />);

    expect(screen.queryByText('告诉小鲸你想先完成哪一步 GEO 工作。')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /完整 GEO 优化/ }),
    ).not.toBeInTheDocument();
  });
});
