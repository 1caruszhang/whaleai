import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runLogRetentionSweep } from './log-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 4, 3, 12, 0, 0);
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'xiaojing-log-retention-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeFile(name: string, ageDays: number): void {
  const path = join(scratch, name);
  writeFileSync(path, 'diagnostic');
  const timestamp = (NOW - ageDays * DAY_MS) / 1000;
  utimesSync(path, timestamp, timestamp);
}

describe('unified log retention', () => {
  it('deletes expired unified logs and leaves unrelated files untouched', () => {
    makeFile('unified-2026-04-01.log', 32);
    makeFile('unified-2026-05-01.log', 2);
    makeFile('2026-04-01-legacy.log', 32);

    const result = runLogRetentionSweep({ logsDir: scratch, now: NOW });

    expect(readdirSync(scratch).sort()).toEqual([
      '2026-04-01-legacy.log',
      'unified-2026-05-01.log',
    ]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ source: 'unified', scanned: 2, ageDeleted: 1 });
  });

  it('returns an empty unified result when the directory is absent', () => {
    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
    const result = runLogRetentionSweep({ logsDir: scratch, now: NOW });
    expect(result.sources).toEqual([expect.objectContaining({ source: 'unified', scanned: 0 })]);
  });
});
