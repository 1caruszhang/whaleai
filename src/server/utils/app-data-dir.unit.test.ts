import { homedir } from 'os';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getAppDataDir } from './app-data-dir';

describe('getAppDataDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the app-owned local data root injected by the desktop process', () => {
    vi.stubEnv('XIAOJING_DATA_ROOT', 'C:\\Users\\tester\\AppData\\Local\\Xiaojing');

    expect(getAppDataDir()).toBe(resolve('C:\\Users\\tester\\AppData\\Local\\Xiaojing'));
  });

  it('never discovers the legacy home directory in production fallback mode', () => {
    vi.stubEnv('XIAOJING_DATA_ROOT', '');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');

    const dataDir = getAppDataDir();

    expect(dataDir).toBe(join(homedir(), 'Xiaojing'));
    expect(dataDir).not.toContain('.myagents');
  });
});
