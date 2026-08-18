/** True inside a packaged Tauri WebView. */
export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI__' in window
    || '__TAURI_INTERNALS__' in window
    || window.location.protocol === 'tauri:'
    || (window.location.protocol === 'https:' && window.location.hostname === 'tauri.localhost');
}

/** Browser development mode uses the local Sidecar at port 3000. */
export function isBrowserDevMode(): boolean {
  return !isTauriEnvironment()
    && typeof window !== 'undefined'
    && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
}

export function mockGetServerUrl(): string {
  return 'http://127.0.0.1:3000';
}
