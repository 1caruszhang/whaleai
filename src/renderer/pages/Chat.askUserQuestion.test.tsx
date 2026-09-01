import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithTheme } from '@/test/renderWithTheme';
import Chat from './Chat';
import TabProvider from '@/context/TabProvider';

// AskUserQuestion 卡片端到端（渲染层）：SSE 事件置卡 → 点选项 → 提交 →
// POST /api/ask-user-question/respond。传输层（tauriClient / SseConnection）
// 是 mock，其余全部真实组件。锁两个行为：
//  1. 点击链路真实发出 respond POST（payload 契约）；
//  2. respond 失败（success:false / 网络错）时卡片不得冻结在页面上
//     （旧实现静默吞掉失败，卡片残挂且无任何提示——用户被迫自然语言重问）。

const mocks = vi.hoisted(() => ({
  fetchImpl: vi.fn(),
  eventHandler: null as ((eventName: string, data: unknown) => void) | null,
  statusHandler: null as ((status: string) => void) | null,
}));

vi.mock('@/api/tauriClient', () => ({
  sessionSidecarFetch: (...args: unknown[]) => mocks.fetchImpl(...args),
}));

vi.mock('@/api/SseConnection', () => ({
  createSseConnection: () => ({
    setStatusHandler: (handler: (status: string) => void) => {
      mocks.statusHandler = handler;
    },
    setEventHandler: (handler: (eventName: string, data: unknown) => void) => {
      mocks.eventHandler = handler;
    },
    connect: async () => {
      mocks.statusHandler?.('connected');
    },
    disconnect: async () => {
      mocks.statusHandler?.('disconnected');
    },
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

vi.mock('@/components/xiaojing/GeoOperationDockedStrip', () => ({
  default: () => <div data-geo-docked-strip-stub />,
}));

vi.mock('@/context/FileActionContext', () => ({
  FileActionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useWorkspaceChangeSignal', () => ({
  useWorkspaceChangeSignal: () => 0,
}));

const QUESTION_REQUEST = {
  requestId: 'req-ask-1',
  questions: [
    {
      question: '选择哪个方案继续？',
      header: '方案确认',
      multiSelect: false,
      options: [
        { label: '方案A', description: '推荐' },
        { label: '方案B', description: '' },
      ],
    },
  ],
};

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

function renderChatPage() {
  return renderWithTheme(
    <TabProvider
      tabId="tab-ask-1"
      workspacePath="/ws/brand-1"
      sessionId="session-ask-1"
      claimSessionOpeningTransition={() => () => {}}
    >
      <Chat sessionTitle="问答会话" />
    </TabProvider>,
  );
}

async function settleConnected() {
  await waitFor(() => expect(mocks.eventHandler).not.toBeNull());
  mocks.eventHandler?.('chat:init', { sessionState: 'idle' });
}

describe('AskUserQuestion card end-to-end (renderer)', () => {
  beforeEach(() => {
    mocks.fetchImpl.mockReset();
    mocks.eventHandler = null;
    mocks.statusHandler = null;
    // 默认：会话恢复成功（空会话）。
    mocks.fetchImpl.mockImplementation(async (_sessionId: string, _owner: unknown, path: string) => {
      if (typeof path === 'string' && path.startsWith('/sessions/')) {
        return jsonOk({ success: true, session: { messages: [], liveSessionState: 'idle' } });
      }
      return jsonOk({ success: true });
    });
  });

  it('submits the selected option as a respond POST and clears the card on success', async () => {
    renderChatPage();
    await settleConnected();

    mocks.eventHandler?.('ask-user-question:request', QUESTION_REQUEST);
    fireEvent.click(await screen.findByRole('button', { name: /方案A/ }));
    fireEvent.click(await screen.findByRole('button', { name: '提交' }));

    await waitFor(() => {
      const respondCall = mocks.fetchImpl.mock.calls.find(
        ([, , path]) => path === '/api/ask-user-question/respond',
      );
      expect(respondCall).toBeTruthy();
    });
    const respondCall = mocks.fetchImpl.mock.calls.find(
      ([, , path]) => path === '/api/ask-user-question/respond',
    )!;
    // SDK 契约：answers 以问题全文为键（不是索引/id），否则模型侧
    // 解析为 "The user did not answer the questions."
    expect(respondCall[3].body).toBe(
      JSON.stringify({ requestId: 'req-ask-1', answers: { '选择哪个方案继续？': '方案A' } }),
    );

    await waitFor(() => {
      expect(screen.queryByText('选择哪个方案继续？')).not.toBeInTheDocument();
    });
  });

  it('does not leave a frozen card behind when the respond POST reports failure', async () => {
    mocks.fetchImpl.mockImplementation(async (_sessionId: string, _owner: unknown, path: string) => {
      if (typeof path === 'string' && path.startsWith('/sessions/')) {
        return jsonOk({ success: true, session: { messages: [], liveSessionState: 'idle' } });
      }
      return jsonOk({ success: false });
    });

    renderChatPage();
    await settleConnected();

    mocks.eventHandler?.('ask-user-question:request', QUESTION_REQUEST);
    fireEvent.click(await screen.findByRole('button', { name: /方案A/ }));
    fireEvent.click(await screen.findByRole('button', { name: '提交' }));

    // 旧实现：success:false 既不清卡也不报错，卡片永远残挂。
    await waitFor(() => {
      expect(screen.queryByText('选择哪个方案继续？')).not.toBeInTheDocument();
    });
    expect(await screen.findByText(/该问题已失效/)).toBeInTheDocument();
  });

  it('keeps the card retryable when the respond POST throws, and clears it once the retry lands', async () => {
    let respondShouldThrow = true;
    mocks.fetchImpl.mockImplementation(async (_sessionId: string, _owner: unknown, path: string) => {
      if (typeof path === 'string' && path.startsWith('/sessions/')) {
        return jsonOk({ success: true, session: { messages: [], liveSessionState: 'idle' } });
      }
      if (respondShouldThrow) throw new Error('sidecar unreachable');
      return jsonOk({ success: true });
    });

    renderChatPage();
    await settleConnected();

    mocks.eventHandler?.('ask-user-question:request', QUESTION_REQUEST);
    fireEvent.click(await screen.findByRole('button', { name: /方案B/ }));
    fireEvent.click(await screen.findByRole('button', { name: '提交' }));

    // 网络失败 ≠ 提问失效：卡片保留、错误带重试指引，而不是冻结或撤卡。
    expect(await screen.findByText(/提交未送达/)).toBeInTheDocument();
    expect(screen.getByText('选择哪个方案继续？')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交' })).toBeEnabled();

    // 重试送达后正常撤卡。
    respondShouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => {
      expect(screen.queryByText('选择哪个方案继续？')).not.toBeInTheDocument();
    });
  });
});
