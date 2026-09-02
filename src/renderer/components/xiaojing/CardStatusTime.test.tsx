import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CardStatusTime, {
  cardTimestampCompletedLabel,
  CARD_TIMESTAMP_GENERATING_LABEL,
  formatCardCompletionTime,
} from './CardStatusTime';

describe('CardStatusTime（卡片时间戳两态，geo-plan-normalization 票 08）', () => {
  it('formats completion moments in the chat-message timestamp convention (local YYYY-MM-DD HH:mm:ss)', () => {
    // 本地钟面 2026-09-02 05:04:03 的时刻：Date 构造器按本地时区解释，
    // toISOString 得到对应 UTC 瞬间，格式化后必须还原同一本地钟面。
    const iso = new Date(2026, 8, 2, 5, 4, 3).toISOString();
    expect(formatCardCompletionTime(iso)).toBe('2026-09-02 05:04:03');
  });

  it('returns an empty string for missing or unparseable moments so the slot stays hidden', () => {
    expect(formatCardCompletionTime(undefined)).toBe('');
    expect(formatCardCompletionTime(null)).toBe('');
    expect(formatCardCompletionTime('')).toBe('');
    expect(formatCardCompletionTime('not-a-date')).toBe('');
  });

  it('renders the generating state word without any clock time', () => {
    render(<CardStatusTime state="generating" />);

    const slot = screen.getByText(CARD_TIMESTAMP_GENERATING_LABEL);
    expect(slot).toHaveAttribute('data-card-timestamp', 'generating');
    expect(slot.textContent).not.toMatch(/\d/);
  });

  it('renders the settled state with the raw authoritative moment and the formatted completion label', () => {
    render(<CardStatusTime state="settled" completedAt="2026-09-02T05:04:03Z" />);

    const slot = screen.getByText(cardTimestampCompletedLabel(
      formatCardCompletionTime('2026-09-02T05:04:03Z'),
    ));
    expect(slot).toHaveAttribute('data-card-timestamp', 'settled');
    expect(slot).toHaveAttribute('data-completed-at', '2026-09-02T05:04:03Z');
  });

  it('renders nothing when settled but no authoritative moment exists (honest absence over a fabricated time)', () => {
    const { container } = render(<CardStatusTime state="settled" />);

    expect(container.querySelector('[data-card-timestamp]')).toBeNull();
  });

  it('lets i18n callers override both labels without falling back to the shared defaults', () => {
    render(
      <CardStatusTime
        state="settled"
        completedAt="2026-09-02T05:04:03Z"
        generatingLabel="Generating"
        completedLabel={(time) => `Completed at ${time}`}
      />,
    );

    expect(screen.getByText(/Completed at /)).toBeInTheDocument();
    expect(screen.queryByText(/^完成于/)).not.toBeInTheDocument();
  });
});
