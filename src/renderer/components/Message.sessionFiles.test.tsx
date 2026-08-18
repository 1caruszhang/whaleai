/**
 * 用户消息里的会话文件 @token 契约（ADR-0001）：
 * 发送方把 chip 序列化为 `@xiaojing_files/<sessionId>/<name>` 拼进文本；
 * 渲染端必须剥离 token 并显示为文件 chip，token 本身不得泄漏进正文。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: vi.fn() }),
}));

import Message from './Message';
import { buildSessionFileToken } from '../../shared/sessionFileReference';
import type { Message as MessageType } from '@/types/chat';

afterEach(() => cleanup());

function userMessage(content: string): MessageType {
  return {
    id: 'm1',
    role: 'user',
    content,
    timestamp: new Date('2026-08-16T12:00:00Z'),
  };
}

describe('Message 会话文件渲染', () => {
  it('剥离 @token 并渲染文件 chip，正文保留其余文字', () => {
    const token = buildSessionFileToken('xiaojing_files/s1/若如初见.md');
    render(<Message message={userMessage(`帮我看一下${token} 然后给建议`)} />);

    const chips = screen.getByTestId('user-session-files');
    expect(chips.textContent).toContain('若如初见.md');
    expect(screen.getByTitle('xiaojing_files/s1/若如初见.md')).toBeInTheDocument();

    const article = screen.getByRole('article');
    expect(article.textContent).toContain('帮我看一下');
    expect(article.textContent).toContain('然后给建议');
    expect(article.textContent).not.toContain('@xiaojing_files');
  });

  it('没有 token 的普通消息不渲染 chip 区块', () => {
    render(<Message message={userMessage('普通消息')} />);
    expect(screen.queryByTestId('user-session-files')).not.toBeInTheDocument();
    expect(screen.getByRole('article').textContent).toContain('普通消息');
  });

  it('仅文件无文字的消息渲染 chip 且正文为空不报错', () => {
    const token = buildSessionFileToken('xiaojing_files/s1/b.md');
    render(<Message message={userMessage(token)} />);
    expect(screen.getByTestId('user-session-files').textContent).toContain('b.md');
    expect(screen.getByRole('article').textContent).not.toContain('@xiaojing_files');
  });
});
