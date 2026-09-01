import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrandWorkspace } from '@/api/brandWorkspaceClient';
import { CurrentWorkspaceContext } from '@/context/CurrentWorkspaceContext';
import { planGeoOperation } from '../../shared/geo/operation';
import type { GeoOperationProjection } from '../../shared/geo/operation';
import Chat from './Chat';

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  loadGeoOperations: vi.fn(),
  messages: [] as Array<{ id: string; gateOperationId?: string }>,
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: mocks.apiPost }),
  useTabState: () => ({
    workspacePath: '/brands/brand-19',
    sessionId: 'session-19',
    messages: mocks.messages,
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
    sendMessage: vi.fn(),
    stopResponse: vi.fn(),
    retryCurrentSessionRestore: vi.fn(),
  }),
}));

vi.mock('@/api/geoOperationClient', () => ({
  loadGeoOperations: mocks.loadGeoOperations,
}));

vi.mock('@/components/SimpleChatInput', () => ({
  default: () => <div data-chat-input-stub />,
}));

vi.mock('@/components/Message', () => ({
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

// 停在知识确认门的真实投影（ADR-0011）：认可计划、收集材料、提取事实
// 已完成，第四步（confirm-knowledge 确认门）真处 awaiting-confirmation，
// 操作状态随状态机同步为 awaiting-confirmation——状态行按
// 「待确认 · N/M 道闸门 · 当前：…」播报，而非执行期的「正在…」文案。
const parkedAtKnowledgeGate = (() => {
  const plan = planGeoOperation({
    intent: 'full-optimization',
    goal: '完整 GEO 优化',
  });
  return {
    id: 'operation-19',
    workspaceId: 'brand-19',
    sessionId: 'session-19',
    goal: '完整 GEO 优化',
    status: 'awaiting-confirmation',
    revision: 5,
    steps: plan.steps.map((step, index) => ({
      ...step,
      status:
        index <= 2
          ? "succeeded"
          : index === 3
            ? "awaiting-confirmation"
            : step.status,
    })),
  } as unknown as GeoOperationProjection;
})();

// 放行后的 armed 窗口（ADR-0011 Decision 1）：认可门已放行，首个工作
// 步骤 armed（ready）还未 running，操作状态回 ready——状态词报「进行中」、
// 进度报「正在推进：<步骤名>」，不把远未停靠的知识门标成「当前」。
const armedAfterPlanRelease = (() => {
  const plan = planGeoOperation({
    intent: 'full-optimization',
    goal: '完整 GEO 优化',
  });
  return {
    ...parkedAtKnowledgeGate,
    status: 'ready',
    revision: 6,
    steps: plan.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'succeeded' : index === 1 ? 'ready' : step.status,
    })),
  } as unknown as GeoOperationProjection;
})();

const workspace = {
  id: 'brand-19',
  name: '品牌十九',
  rootPath: '/brands/brand-19',
} as unknown as BrandWorkspace;

describe('Chat 常驻闸门进度条（输入框上方停靠）', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalScrollIntoView: unknown;

  beforeEach(() => {
    mocks.apiPost.mockReset();
    mocks.loadGeoOperations.mockReset();
    mocks.loadGeoOperations.mockResolvedValue([parkedAtKnowledgeGate]);
    mocks.messages = [{ id: 'message-1', gateOperationId: 'operation-19' }];
    scrollIntoView = vi.fn();
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  function renderChat() {
    return render(
      <CurrentWorkspaceContext.Provider value={workspace}>
        <Chat sessionTitle="小鲸科技" />
      </CurrentWorkspaceContext.Provider>,
    );
  }

  it('停靠条渲染于输入框上方并展示首个非终态操作的闸门进度', async () => {
    const { container } = renderChat();

    const dock = await waitFor(() =>
      screen.getByRole('button', { name: '定位当前闸门卡片' }),
    );
    expect(dock.getAttribute('data-geo-operation-dock')).toBe('operation-19');
    // 门步骤真处 awaiting-confirmation：仍报「待确认 · N/M 道闸门 · 当前：…」
    // （ADR-0011 Decision 1，现有正确行为不回归）。
    expect(
      screen.getByText(/待确认 · 1\/8 道闸门 · 当前：确认品牌知识变更/),
    ).toBeInTheDocument();

    // 常驻位置：滚动容器之下、输入框之上，不随消息滚动离开视野。
    const input = container.querySelector('[data-chat-input-stub]');
    expect(input).not.toBeNull();
    expect(
      dock.compareDocumentPosition(input as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // ADR-0011 Decision 1 armed 窗口：停靠条与进度卡共用同一派生函数，
  // 放行后的静默期同样如实报「进行中 · 正在推进：<步骤名>」，
  // 不再出现「待开始 · 当前：远未停靠的门」的矛盾组合。
  it('停靠条在放行后的 armed 窗口报正在推进的工作步骤', async () => {
    mocks.loadGeoOperations.mockResolvedValue([armedAfterPlanRelease]);
    renderChat();

    const dock = await screen.findByRole('button', {
      name: '定位当前闸门卡片',
    });
    expect(dock.getAttribute('data-geo-operation-dock')).toBe('operation-19');
    expect(
      screen.getByText(/进行中 · 正在推进：收集品牌材料/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/当前：/)).toBeNull();
    expect(screen.queryByText(/待开始/)).toBeNull();
  });

  it('点击停靠条定位到聊天内该操作的闸门卡锚点', async () => {
    renderChat();
    const dock = await screen.findByRole('button', {
      name: '定位当前闸门卡片',
    });

    fireEvent.click(dock);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center' }),
    );
    HTMLElement.prototype.scrollIntoView =
      originalScrollIntoView as typeof HTMLElement.prototype.scrollIntoView;
  });
});
