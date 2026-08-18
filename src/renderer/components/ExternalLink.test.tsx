import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

vi.mock('@/utils/openExternal', () => ({
  openExternal: mocks.openExternal,
}));

import ExternalLink from './ExternalLink';

describe('ExternalLink primary action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as Selection);
  });

  it('opens HTTP links with the system handler', () => {
    render(<ExternalLink href="https://example.com">Example</ExternalLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('uses the system handler for an explicit Cmd/Ctrl click', () => {
    render(<ExternalLink href="https://example.com">Example</ExternalLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Example' }), { metaKey: true });

    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('does not open while the link text is selected', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'Example',
    } as Selection);
    render(<ExternalLink href="https://example.com">Example</ExternalLink>);

    fireEvent.click(screen.getByRole('link', { name: 'Example' }));

    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
