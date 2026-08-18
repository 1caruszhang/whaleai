import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriWindow = vi.hoisted(() => ({
  focusListener: undefined as ((event: { payload: boolean }) => void) | undefined,
  onFocusChanged: vi.fn(),
  unlisten: vi.fn(),
}));
const notification = vi.hoisted(() => ({ consumePendingNotificationClick: vi.fn() }));

vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => true }));
vi.mock('@/utils/closeLayer', () => ({ dismissTopmost: () => false }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));
vi.mock('@/services/notificationService', () => notification);
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onFocusChanged: tauriWindow.onFocusChanged }),
}));

import { useWindowLifecycle } from './useWindowLifecycle';

describe('useWindowLifecycle focus projection', () => {
  beforeEach(() => {
    tauriWindow.focusListener = undefined;
    tauriWindow.onFocusChanged.mockReset();
    tauriWindow.unlisten.mockReset();
    tauriWindow.onFocusChanged.mockImplementation(async (listener) => {
      tauriWindow.focusListener = listener;
      return tauriWindow.unlisten;
    });
    notification.consumePendingNotificationClick.mockReset();
  });

  it('projects native focus before consuming a notification click', async () => {
    notification.consumePendingNotificationClick.mockResolvedValue(true);
    const onWindowFocusChanged = vi.fn();
    const onWindowFocused = vi.fn();
    renderHook(() => useWindowLifecycle({ onWindowFocusChanged, onWindowFocused }));
    await waitFor(() => expect(tauriWindow.focusListener).toBeDefined());

    act(() => tauriWindow.focusListener?.({ payload: false }));
    expect(onWindowFocusChanged).toHaveBeenLastCalledWith(false);

    act(() => tauriWindow.focusListener?.({ payload: true }));
    expect(onWindowFocusChanged).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(notification.consumePendingNotificationClick).toHaveBeenCalledTimes(1));
    expect(onWindowFocused).not.toHaveBeenCalled();
  });

  it('runs the focused callback when no notification click is consumed', async () => {
    notification.consumePendingNotificationClick.mockResolvedValue(false);
    const onWindowFocused = vi.fn();
    renderHook(() => useWindowLifecycle({ onWindowFocused }));
    await waitFor(() => expect(tauriWindow.focusListener).toBeDefined());

    act(() => tauriWindow.focusListener?.({ payload: true }));
    await waitFor(() => expect(onWindowFocused).toHaveBeenCalledTimes(1));
  });
});
