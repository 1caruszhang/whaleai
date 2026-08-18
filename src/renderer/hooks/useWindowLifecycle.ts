import { useEffect, useRef } from 'react';
import { emit } from '@tauri-apps/api/event';
import { isTauriEnvironment } from '@/utils/browserMock';
import { dismissTopmost } from '@/utils/closeLayer';
import { consumePendingNotificationClick } from '@/services/notificationService';
import { listenWithCleanup } from '@/utils/tauriListen';

interface WindowLifecycleOptions {
  onExitRequested?: () => Promise<boolean>;
  onCmdWCloseTab?: () => void;
  onWindowFocused?: () => void;
  onWindowFocusChanged?: (focused: boolean) => void;
}

export function useWindowLifecycle(options: WindowLifecycleOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlistenFocusChanged: (() => void) | null = null;
    const ac = new AbortController();

    const setupListeners = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();
        unlistenFocusChanged = await window.onFocusChanged(({ payload: focused }) => {
          if (ac.signal.aborted) return;
          optionsRef.current.onWindowFocusChanged?.(focused);
          if (focused) {
            void (async () => {
              const consumedNotificationClick = await consumePendingNotificationClick();
              if (!ac.signal.aborted && !consumedNotificationClick) {
                optionsRef.current.onWindowFocused?.();
              }
            })();
          }
        });
        if (ac.signal.aborted) {
          unlistenFocusChanged?.();
          unlistenFocusChanged = null;
          return;
        }

        void listenWithCleanup('window:cmd-w', () => {
          if (dismissTopmost()) return;
          if (document.querySelector('.fixed.inset-0[class*="backdrop-blur"]')) return;
          optionsRef.current.onCmdWCloseTab?.();
        }, ac.signal);

        void listenWithCleanup('window:close-requested', async () => {
          const canExit = await optionsRef.current.onExitRequested?.() ?? true;
          if (canExit) await emit('window:confirm-exit');
        }, ac.signal);
      } catch (error) {
        console.error('[useWindowLifecycle] Failed to set up listeners:', error);
      }
    };

    void setupListeners();
    return () => {
      ac.abort();
      unlistenFocusChanged?.();
    };
  }, []);
}
