/**
 * Shared utilities for logging system
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { ensureDirSync } from './utils/fs-utils';
import { getAppDataDir } from './utils/app-data-dir';

export const XIAOJING_DIR = getAppDataDir();
export const LOGS_DIR = join(XIAOJING_DIR, 'logs');
// Retention policy moved to `./log-retention.ts` (#121, 2026-05). Keeping a
// re-export of LOGS_DIR + ensureLogsDir as the only API of this module.

/**
 * Ensure logs directory exists
 */
export function ensureLogsDir(): void {
  if (!existsSync(XIAOJING_DIR)) {
    ensureDirSync(XIAOJING_DIR);
  }
  if (!existsSync(LOGS_DIR)) {
    ensureDirSync(LOGS_DIR);
  }
}
