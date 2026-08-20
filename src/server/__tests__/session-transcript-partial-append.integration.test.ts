import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '../types/session';

const appendFault = vi.hoisted(() => ({ failNext: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    appendFileSync(path: Parameters<typeof actual.appendFileSync>[0], data: Parameters<typeof actual.appendFileSync>[1]) {
      if (!appendFault.failNext) return actual.appendFileSync(path, data);
      appendFault.failNext = false;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      actual.appendFileSync(path, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      throw new Error('simulated partial append');
    },
  };
});

type SessionStoreModule = typeof import('../SessionStore');
let testHome: string;
let originalHome: string | undefined;
let originalDataRoot: string | undefined;
let store: SessionStoreModule;

const row: SessionMessage = {
  id: 'user-1',
  role: 'user',
  content: 'partial append recovery',
  timestamp: '2026-08-05T00:00:00.000Z',
};

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'xiaojing-partial-append-'));
  originalHome = process.env.HOME;
  originalDataRoot = process.env.XIAOJING_DATA_ROOT;
  process.env.HOME = testHome;
  // homedir() ignores HOME on Windows; XIAOJING_DATA_ROOT is the portable override.
  process.env.XIAOJING_DATA_ROOT = join(testHome, 'Xiaojing');
  vi.resetModules();
  store = await import('../SessionStore');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDataRoot === undefined) delete process.env.XIAOJING_DATA_ROOT;
  else process.env.XIAOJING_DATA_ROOT = originalDataRoot;
  rmSync(testHome, { recursive: true, force: true });
});

describe('Session transcript partial append convergence', () => {
  it('truncates a provable operation prefix back to the old EOF and returns a usable cursor', async () => {
    const session = await store.createSession('/tmp/partial-append');
    const snapshot = await store.loadSessionTranscript(session.id);
    appendFault.failNext = true;

    const failed = await store.appendSessionMessages(session.id, snapshot.cursor, [row]);
    expect(failed).toMatchObject({ ok: false, reason: 'write-error' });
    if (failed.ok || !failed.cursor) return;
    const path = join(testHome, 'Xiaojing', 'sessions', `${session.id}.jsonl`);
    expect(readFileSync(path)).toHaveLength(0);

    const retry = await store.appendSessionMessages(session.id, failed.cursor, [row]);
    expect(retry).toMatchObject({ ok: true, action: 'appended', totalCount: 1 });
    expect((await store.loadSessionTranscript(session.id)).messages).toEqual([row]);
  });
});
