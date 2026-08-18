import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
  isExternalUrl: (url: string) => /^https?:\/\//i.test(url),
}));

import Markdown from './Markdown';

describe('Markdown web links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' } as Selection);
  });

  it('opens an ordinary click with the system handler', () => {
    render(<Markdown>[Example](https://example.com)</Markdown>);

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('keeps Cmd/Ctrl click on the same system handler', () => {
    render(<Markdown>[Example](https://example.com)</Markdown>);

    fireEvent.click(screen.getByRole('link', { name: 'Example' }), { ctrlKey: true });

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
  });
});
