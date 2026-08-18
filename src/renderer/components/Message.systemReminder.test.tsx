/**
 * 决策回执 reminder 的自然语言投影：阀门确认后自动入队的结构化信封
 * 不得以 XML 扁平文本（UUID/枚举串）出现在用户气泡里。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: vi.fn() }),
}));

vi.mock('@/context/TabContext', () => ({
  useTabApi: () => ({ apiPost: vi.fn() }),
  useTabState: () => ({}),
}));

import Message from './Message';
import type { Message as MessageType } from '@/types/chat';
import { buildGeoOperationEventReminder } from '../../shared/systemReminder';
import { renderWithTheme } from '@/test/renderWithTheme';

afterEach(() => cleanup());

function userMessage(content: string): MessageType {
  return {
    id: 'user-1',
    role: 'user',
    content,
    timestamp: new Date('2026-08-16T14:27:00Z'),
  };
}

describe('Message 决策回执投影', () => {
  it('计划认可回执渲染为「认可本次计划」，不出现 UUID 与机器串', () => {
    const reminder = buildGeoOperationEventReminder({
      workspaceId: 'ff545fb2-9915-48b5-b93b-36ccd5d0db90',
      sessionId: '40dba1b8-9b16-403b-92cc-7b236f43b7f4',
      operationId: 'f25f07b2-03b2-4441-a03f-390bc77ec49a',
      revision: 2,
      action: 'confirm-step:acknowledge-plan',
      status: 'ready',
    });
    renderWithTheme(<Message message={userMessage(reminder)} />);

    const label = screen.getByText('认可本次计划');
    const bubble = label.closest('[data-message-role="user"]');
    expect(bubble).not.toBeNull();
    expect(bubble?.querySelector('[data-system-reminder]')).toHaveAttribute(
      'data-system-reminder',
      'XIAOJING_GEO_OPERATION_EVENT',
    );
    // 机器串只保留在 title 诊断属性里，不能进入可见文本。
    expect(screen.queryByText(/ff545fb2/)).not.toBeInTheDocument();
    expect(screen.queryByText(/confirm-step/)).not.toBeInTheDocument();
    expect(screen.queryByText(/system-reminder/)).not.toBeInTheDocument();
  });

  it('控制类回执按动作渲染自然语言', () => {
    const reminder = buildGeoOperationEventReminder({
      workspaceId: 'w',
      sessionId: 's',
      operationId: 'op-1',
      revision: 3,
      action: 'pause',
      status: 'paused',
    });
    render(<Message message={userMessage(reminder)} />);
    expect(screen.getByText('暂停 GEO 操作')).toBeInTheDocument();
  });

  it('真实用户输入不受投影影响，仍走 Markdown 气泡', () => {
    renderWithTheme(<Message message={userMessage('认可本次计划，请开始执行')} />);
    const bubble = screen.getByText(/认可本次计划，请开始执行/).closest('[data-message-role="user"]');
    expect(bubble?.querySelector('[data-system-reminder]')).toBeNull();
  });
});
