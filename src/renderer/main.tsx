import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

import AppErrorBoundary from './components/AppErrorBoundary';
import { ToastProvider } from './components/Toast';
import { ImagePreviewProvider } from './context/ImagePreviewContext';
import { XiaojingI18nSync } from './i18n/I18nLanguageSync';
import {
  primeXiaojingThemeRuntime,
  XiaojingThemeRuntime,
} from './theme';
import { installMacFunctionKeyGuard } from './utils/macFunctionKeyGuard';
import { installTextCorrectionPolicy } from './utils/textCorrectionPolicy';

import './i18n';
import './index.css';

let tauriWindowLabel: string | undefined;
try {
  tauriWindowLabel = getCurrentWebviewWindow().label;
} catch {
  tauriWindowLabel = undefined; // browser dev mode — no Tauri runtime
}

function describeBootError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`.slice(0, 2000);
  return String(error).slice(0, 2000);
}

function reportBootEvent(stage: string, detail?: string): void {
  try {
    const internals = (globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: { invoke?: (command: string, payload: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== 'function') return;
    void Promise.resolve(internals.invoke('cmd_record_renderer_boot_event', {
      stage,
      windowLabel: tauriWindowLabel ?? 'browser',
      detail,
    })).catch(() => {});
  } catch {
    // Boot diagnostics are observational and must never become startup state.
  }
}

reportBootEvent('renderer-entry-evaluated');

// Optional Theme packages are inline-only and validated before activation.
// Prime the validated bootstrap snapshot before React's first paint. A broken
// snapshot/package is diagnostic, not permission to strand the window blank.
try {
  primeXiaojingThemeRuntime();
  reportBootEvent('theme-renderer-bootstrap-complete');
} catch (error) {
  reportBootEvent('theme-renderer-bootstrap-failed', describeBootError(error));
}

// Block macOS WKWebView's NSEvent function-key tofu leak globally —
// see utils/macFunctionKeyGuard.ts. Must run before React mounts so the
// document-level capture handler is attached when the first input fires.
installMacFunctionKeyGuard();
installTextCorrectionPolicy();

// Block native "Reload / Inspect Element" context menu in production.
// Keep native menu for: input fields, text selection, contenteditable, links, images, media.
if (!import.meta.env.DEV) {
  document.addEventListener('contextmenu', (e) => {
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'A' || tag === 'IMG'
      || tag === 'VIDEO' || tag === 'AUDIO' || el.isContentEditable) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
}

const root = createRoot(document.getElementById('root')!);
reportBootEvent('react-root-created');

function BootCommitMarker() {
  React.useEffect(() => {
    reportBootEvent('react-commit');
  }, []);
  return null;
}

// A dev-server restart orphans the HMR timestamps (?t=...) the webview still
// holds, so the lazy import rejects with "Failed to fetch dynamically imported
// module". In dev, retry exactly once via a full reload (fresh index.html →
// fresh module graph); if the reload itself fails to boot App, fall through to
// the AppErrorBoundary. Prod keeps the original failure untouched.
const LAZY_APP_RELOADED_KEY = 'renderer.lazyAppReloaded';

const App = React.lazy(async () => {
  try {
    const appModule = await import('./App');
    sessionStorage.removeItem(LAZY_APP_RELOADED_KEY);
    return appModule;
  } catch (error) {
    if (!import.meta.env.DEV || sessionStorage.getItem(LAZY_APP_RELOADED_KEY)) {
      throw error;
    }
    sessionStorage.setItem(LAZY_APP_RELOADED_KEY, '1');
    window.location.reload();
    // Keep React on the Suspense fallback while the reload is in flight.
    return new Promise<typeof import('./App')>(() => {});
  }
});

// 鲸杉geo只有一个主产品窗口；Theme runtime owns its renderer bridge.
root.render(
  <AppErrorBoundary>
    <BootCommitMarker />
    <XiaojingThemeRuntime ownsMainWindowBridge>
      <XiaojingI18nSync />
      <ToastProvider>
        <ImagePreviewProvider>
          <React.Suspense fallback={null}>
            <App />
          </React.Suspense>
        </ImagePreviewProvider>
      </ToastProvider>
    </XiaojingThemeRuntime>
  </AppErrorBoundary>
);
