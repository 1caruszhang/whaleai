import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GeoNavigationTarget } from '../../shared/geo/notification';
import Chat from './Chat';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sessionLoading: false,
  messages: [] as Array<{ id: string; gateOperationId?: string }>,
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: vi.fn() }),
  useTabState: () => ({
    workspacePath: '/brands/brand-19',
    sessionId: 'session-19',
    messages: mocks.messages,
    streamingMessage: null,
    isLoading: false,
    isSessionLoading: mocks.sessionLoading,
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
  // 桩内按消息元数据渲染闸门卡元素，模拟工具结果卡在滚动容器内的挂载。
  default: ({ message }: { message: { id: string; gateOperationId?: string } }) => (
    <div data-message-stub={message.id}>
      {message.gateOperationId ? (
        <div data-geo-gate-panels={message.gateOperationId} />
      ) : null}
    </div>
  ),
}));

vi.mock('@/context/FileActionContext', () => ({
  FileActionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useWorkspaceChangeSignal', () => ({
  useWorkspaceChangeSignal: () => 0,
}));

function navigationTarget(nonce: number): GeoNavigationTarget {
  return {
    workspaceId: 'brand-19',
    sessionId: 'session-19',
    operationId: 'operation-19',
    card: 'geo-operation',
    artifact: { kind: 'operation', id: 'operation-19' },
    nonce,
  };
}

describe('Chat notification deep-link gate scrolling (ticket 32)', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: unknown;

  beforeEach(() => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue(true);
    mocks.sessionLoading = false;
    mocks.messages = [{ id: 'message-1', gateOperationId: 'operation-19' }];
    scrollIntoView = vi.fn();
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  it('scrolls the transcript to the gate card of the located operation once per nonce', () => {
    const view = render(
      <Chat sessionTitle="小鲸科技" navigationTarget={navigationTarget(1)} />,
    );
    expect(screen.getByText((_, element) => element?.getAttribute('data-geo-gate-panels') === 'operation-19')).toBeInTheDocument();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center' }),
    );

    // 同一 nonce 的重渲染不得重复滚动。
    view.rerender(
      <Chat sessionTitle="小鲸科技" navigationTarget={navigationTarget(1)} />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // 新的深链（新 nonce）再次定位。
    view.rerender(
      <Chat sessionTitle="小鲸科技" navigationTarget={navigationTarget(2)} />,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView as typeof HTMLElement.prototype.scrollIntoView;
  });

  // 深链常在冷启动恢复会话时到达：滚动容器尚未挂载，恢复完成后必须补定位。
  it('locates the gate card after session restore finishes', () => {
    mocks.sessionLoading = true;
    const view = render(
      <Chat sessionTitle="小鲸科技" navigationTarget={navigationTarget(1)} />,
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    mocks.sessionLoading = false;
    view.rerender(
      <Chat sessionTitle="小鲸科技" navigationTarget={navigationTarget(1)} />,
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView as typeof HTMLElement.prototype.scrollIntoView;
  });

  it('does not scroll without a navigation target', () => {
    render(<Chat sessionTitle="小鲸科技" />);
    expect(scrollIntoView).not.toHaveBeenCalled();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView as typeof HTMLElement.prototype.scrollIntoView;
  });
});
