import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ColumnResizer from './ColumnResizer';

function renderResizer(props: Partial<ComponentProps<typeof ColumnResizer>> = {}) {
  const handlers = {
    onResizeBy: vi.fn(),
    onResizeCommit: vi.fn(),
    onReset: vi.fn(),
    onResizeStart: vi.fn(),
  };
  render(<ColumnResizer ariaLabel="调整宽度" {...handlers} {...props} />);
  return { handle: screen.getByRole('separator', { name: '调整宽度' }), handlers };
}

describe('ColumnResizer', () => {
  it('emits incremental deltas while dragging and commits once on release', () => {
    const { handle, handlers } = renderResizer();

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
    expect(handlers.onResizeStart).toHaveBeenCalledTimes(1);
    expect(handlers.onResizeCommit).not.toHaveBeenCalled();

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 116 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 108 });
    expect(handlers.onResizeBy).toHaveBeenNthCalledWith(1, 16);
    expect(handlers.onResizeBy).toHaveBeenNthCalledWith(2, -8);

    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(handlers.onResizeCommit).toHaveBeenCalledTimes(1);
  });

  it('commits on cancelled drags so the width is not left un-persisted', () => {
    const { handle, handlers } = renderResizer();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(handlers.onResizeCommit).toHaveBeenCalledTimes(1);
  });

  it('ignores non-primary buttons and non-arrow keys', () => {
    const { handle, handlers } = renderResizer();
    fireEvent.pointerDown(handle, { button: 2, pointerId: 1, clientX: 0 });
    expect(handlers.onResizeStart).not.toHaveBeenCalled();

    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(handlers.onResizeBy).not.toHaveBeenCalled();
    expect(handlers.onResizeCommit).not.toHaveBeenCalled();
  });

  it('nudges 8px per arrow key and commits each step', () => {
    const { handle, handlers } = renderResizer();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handlers.onResizeBy).toHaveBeenCalledWith(8);
    expect(handlers.onResizeCommit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handlers.onResizeBy).toHaveBeenLastCalledWith(-8);
    expect(handlers.onResizeCommit).toHaveBeenCalledTimes(2);
  });

  it('resets on double click', () => {
    const { handle, handlers } = renderResizer();
    fireEvent.dblClick(handle);
    expect(handlers.onReset).toHaveBeenCalledTimes(1);
  });

  it('exposes vertical separator semantics for keyboard users', () => {
    const { handle } = renderResizer();
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('tabindex', '0');
  });
});
