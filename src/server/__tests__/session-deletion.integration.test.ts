import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type SessionStoreModule = typeof import('../SessionStore');

let home: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let store: SessionStoreModule;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'xiaojing-session-deletion-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  store = await import('../SessionStore');
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('SessionStore deletion authority', () => {
  it('removes only the selected session and refuses a stale writer that would resurrect it', async () => {
    const deleted = await store.createSession('/tmp/brand-a', { title: 'Delete me' });
    const retained = await store.createSession('/tmp/brand-b', { title: 'Keep me' });
    const deletedSnapshot = await store.loadSessionTranscript(deleted.id);
    const retainedSnapshot = await store.loadSessionTranscript(retained.id);
    const timestamp = '2026-08-16T00:00:00.000Z';

    const deletedAppend = await store.appendSessionMessages(deleted.id, deletedSnapshot.cursor, [{
      id: 'deleted-message',
      role: 'user',
      content: 'before deletion',
      timestamp,
    }]);
    const retainedAppend = await store.appendSessionMessages(retained.id, retainedSnapshot.cursor, [{
      id: 'retained-message',
      role: 'user',
      content: 'retained transcript',
      timestamp,
    }]);
    expect(deletedAppend.ok).toBe(true);
    expect(retainedAppend.ok).toBe(true);
    if (!deletedAppend.ok) throw new Error('expected deleted-session append to succeed');

    store.saveAttachment(deleted.id, 'image-1', 'image.png', 'aGVsbG8=', 'image/png');
    expect(await store.deleteSession(deleted.id, { kind: 'user-delete' })).toEqual({ deleted: true });

    const staleAppend = await store.appendSessionMessages(deleted.id, deletedAppend.cursor, [{
      id: 'late-message',
      role: 'assistant',
      content: 'must not resurrect',
      timestamp,
    }]);

    expect(staleAppend).toMatchObject({ ok: false, reason: 'stale-cursor' });
    expect(store.getSessionMetadata(deleted.id)).toBeNull();
    expect(store.getSessionData(deleted.id)).toBeNull();
    expect(existsSync(join(home, 'Xiaojing', 'sessions', `${deleted.id}.jsonl`))).toBe(false);
    expect(existsSync(join(home, 'Xiaojing', 'attachments', deleted.id))).toBe(false);

    expect(store.getSessionData(retained.id)).toMatchObject({
      id: retained.id,
      title: 'Keep me',
      messages: [{ id: 'retained-message', content: 'retained transcript' }],
    });
  });
});
