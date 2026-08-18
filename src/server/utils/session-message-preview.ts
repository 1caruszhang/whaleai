import type { SessionMessage } from '../types/session';

export const CLIENT_MESSAGE_INLINE_MAX_BYTES = 256 * 1024;

function utf8Size(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Size(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Size(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, Math.max(0, low - 1))}…`;
}

export function shrinkSessionMessageForClient(message: SessionMessage): SessionMessage {
  if (utf8Size(message.content) <= CLIENT_MESSAGE_INLINE_MAX_BYTES) return message;
  const truncationBanner = '这条历史消息过大，界面仅显示截断内容。\n\n';
  return {
    ...message,
    content: truncateUtf8(`${truncationBanner}${message.content}`, CLIENT_MESSAGE_INLINE_MAX_BYTES),
  };
}

export function shrinkSessionMessagesForClient(messages: SessionMessage[]): SessionMessage[] {
  return messages.map(shrinkSessionMessageForClient);
}
