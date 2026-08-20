import { homedir, platform } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAppDataDir, resolveLocalDataDir } from './app-data-dir';

describe('getAppDataDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the app-owned local data root injected by the desktop process', () => {
    vi.stubEnv('XIAOJING_DATA_ROOT', 'C:\\Users\\tester\\AppData\\Local\\Xiaojing');

    expect(getAppDataDir()).toBe(resolve('C:\\Users\\tester\\AppData\\Local\\Xiaojing'));
  });

  it('uses only the platform local-data convention in production fallback mode', () => {
    vi.stubEnv('XIAOJING_DATA_ROOT', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');

    const dataDir = getAppDataDir();

    expect(dataDir).toBe(resolveLocalDataDir(platform(), process.env, homedir()));
  });
});

describe('resolveLocalDataDir', () => {
  it('matches the Windows LOCALAPPDATA authority', () => {
    expect(resolveLocalDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, 'C:\\Users\\test'))
      .toBe(join('C:\\Users\\test\\AppData\\Local', 'Xiaojing'));
  });

  it('matches the macOS and Linux local-data conventions', () => {
    expect(resolveLocalDataDir('darwin', {}, '/Users/test'))
      .toBe(join('/Users/test', 'Library', 'Application Support', 'Xiaojing'));
    expect(resolveLocalDataDir('linux', { XDG_DATA_HOME: '/data/local' }, '/home/test'))
      .toBe(join('/data/local', 'Xiaojing'));
  });
});
