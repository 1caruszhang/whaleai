/**
 * GD-1 regression — per-process unified log files (unified_logging.md:3).
 *
 * The spec promises "带日期、PID 和 nonce 的有界文件" per process: the Rust
 * desktop shell and every Session Sidecar each own a distinct bounded file.
 * Before this fix every process wrote the same `unified-<date>.log`, so K
 * concurrent writers each tracked only their own bytes against the 50MB cap
 * and one process' rename-rotation churned the file out from under the others.
 *
 * Isolation mirrors `unified-logger-bounded.integration.test.ts`: logUtils is
 * mocked to a per-run tmpdir before UnifiedLogger imports it.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const { TEST_LOGS_ROOT, TEST_LOGS_DIR } = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}`.replace(/\/+$/, '')
    + `/xiaojing-unified-perprocess-test-${process.pid}-${Date.now()}`;
  return { TEST_LOGS_ROOT: root, TEST_LOGS_DIR: `${root}/logs` };
});

vi.mock('../logUtils', () => ({
  XIAOJING_DIR: TEST_LOGS_ROOT,
  LOGS_DIR: TEST_LOGS_DIR,
  ensureLogsDir: () => {
    if (!existsSync(TEST_LOGS_DIR)) {
      mkdirSync(TEST_LOGS_DIR, { recursive: true });
    }
  },
}));

import type { LogEntry } from '../../shared/types/log';
import { localTimestamp } from '../../shared/logTime';

function makeEntry(message: string): LogEntry {
  return {
    source: 'node',
    level: 'info',
    message,
    timestamp: localTimestamp(),
  };
}

/** Fresh module instance with its own per-process tag (nonce is minted at
 *  module birth, so two imports model two booted writer processes). */
async function importLogger() {
  const mod = await import('../UnifiedLogger');
  return mod as typeof import('../UnifiedLogger');
}

afterAll(() => {
  try {
    rmSync(TEST_LOGS_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
});

it('writes to a per-process file named unified-<date>-<pid>-<nonce>.log', async () => {
  const logger = await importLogger();
  logger.appendUnifiedLog(makeEntry('[per-process] write'));
  logger._flushUnifiedLogForTests();

  const files = readdirSync(TEST_LOGS_DIR).filter(
    (f) => f.startsWith('unified-') && f.endsWith('.log'),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    // unified-YYYY-MM-DD-<pid>-<nonce>.log — pid numeric, nonce alnum.
    expect(f).toMatch(/^unified-\d{4}-\d{2}-\d{2}-\d+-[0-9a-z]{4,12}\.log$/);
  }
});

it('two writer instances never share one file (no cross-process collision)', async () => {
  const a = await importLogger();
  vi.resetModules();
  // Re-establish the mock for the fresh module graph.
  vi.doMock('../logUtils', () => ({
    XIAOJING_DIR: TEST_LOGS_ROOT,
    LOGS_DIR: TEST_LOGS_DIR,
    ensureLogsDir: () => {
      if (!existsSync(TEST_LOGS_DIR)) {
        mkdirSync(TEST_LOGS_DIR, { recursive: true });
      }
    },
  }));
  const b = await importLogger();

  a.appendUnifiedLog(makeEntry('[writer-a]'));
  b.appendUnifiedLog(makeEntry('[writer-b]'));
  a._flushUnifiedLogForTests();
  b._flushUnifiedLogForTests();

  const pathA = a.getActiveUnifiedLogPath();
  const pathB = b.getActiveUnifiedLogPath();
  expect(pathA).toBeTruthy();
  expect(pathB).toBeTruthy();
  expect(pathA).not.toBe(pathB);
  expect(join(pathB!, '..')).toBe(join(pathA!, '..'));
});
