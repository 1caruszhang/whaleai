import { homedir, platform } from 'os';
import { join, resolve } from 'path';

/**
 * Canonical Node-side Xiaojing data root.
 *
 * Production Sidecars always receive XIAOJING_DATA_ROOT from Rust. The HOME
 * fallback exists only for isolated Node tests that bind a temporary HOME
 * before importing storage modules; production never discovers legacy data.
 */
export function getAppDataDir(): string {
  const injected = process.env.XIAOJING_DATA_ROOT?.trim();
  if (injected) return resolve(injected);
  // Existing isolated storage tests intentionally construct a temporary
  // `.myagents` fixture. Keep that test-only seam without allowing production
  // startup to discover the user's historical directory.
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return join(homedir(), '.myagents');
  }
  return resolveLocalDataDir(platform(), process.env, homedir());
}

export function resolveLocalDataDir(
  currentPlatform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  if (currentPlatform === 'win32') {
    return join(environment.LOCALAPPDATA || join(homeDirectory, 'AppData', 'Local'), 'Xiaojing');
  }
  if (currentPlatform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', 'Xiaojing');
  }
  return join(environment.XDG_DATA_HOME || join(homeDirectory, '.local', 'share'), 'Xiaojing');
}
