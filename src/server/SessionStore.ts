/**
 * SessionStore owns the durable session index, append-only chat transcripts,
 * and chat attachments. Product features do not write these files directly.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  SessionData,
  SessionMessage,
  SessionMetadata,
  SessionStats,
} from './types/session';
import { createSessionMetadata, generateSessionTitle } from './types/session';
import { workspacePathsEqual } from '../shared/workspacePath';
import { getAppDataDir } from './utils/app-data-dir';
import { ensureDirSync } from './utils/fs-utils';
import { withFileLock } from './utils/file-lock';

const DATA_DIR = getAppDataDir();
const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
const SESSIONS_TMP_FILE = join(DATA_DIR, 'sessions.json.tmp');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments');
const SESSIONS_LOCK_FILE = join(DATA_DIR, 'sessions.lock');
const SESSION_LOCKS_DIR = join(DATA_DIR, 'session-locks');
const LOCK_OPTIONS = { timeoutMs: 5_000, staleMs: 30_000 };

type TranscriptFileIdentity = Readonly<{
  exists: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  endsWithNewline: boolean;
}>;

const transcriptCursorState: unique symbol = Symbol('TranscriptWriteCursor');

export type TranscriptWriteCursor = Readonly<{
  persistedMessageCount: number;
  [transcriptCursorState]: Readonly<{
    sessionId: string;
    file: TranscriptFileIdentity;
  }>;
}>;

export type SessionTranscriptSnapshot = Readonly<{
  messages: SessionMessage[];
  cursor: TranscriptWriteCursor;
  hasMalformedRows: boolean;
}>;

export type AppendSessionMessagesResult =
  | {
      ok: true;
      action: 'appended';
      count: number;
      totalCount: number;
      cursor: TranscriptWriteCursor;
    }
  | {
      ok: false;
      reason: 'stale-cursor' | 'unindexed-create-refused' | 'write-error' | 'storage-consistency-error';
      error: string;
      cursor?: TranscriptWriteCursor;
    };

class CorruptSessionsIndexError extends Error {}

function ensureStorage(): void {
  ensureDirSync(DATA_DIR);
  ensureDirSync(SESSIONS_DIR);
  ensureDirSync(ATTACHMENTS_DIR);
}

function isValidSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9-]{1,99}$/.test(sessionId);
}

function sessionFile(sessionId: string): string {
  if (!isValidSessionId(sessionId)) throw new Error(`Invalid session ID: ${sessionId}`);
  return join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

async function withSessionsLock<T>(operation: () => Promise<T>): Promise<T> {
  ensureStorage();
  return withFileLock({ lockPath: SESSIONS_LOCK_FILE, ...LOCK_OPTIONS }, operation);
}

async function withTranscriptLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  ensureStorage();
  ensureDirSync(SESSION_LOCKS_DIR);
  return withFileLock({
    lockPath: join(SESSION_LOCKS_DIR, `${sessionId}.jsonl.lock`),
    ...LOCK_OPTIONS,
  }, operation);
}

function isMetadata(value: unknown): value is SessionMetadata {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<SessionMetadata>;
  return typeof row.id === 'string'
    && typeof row.workspacePath === 'string'
    && typeof row.title === 'string'
    && typeof row.createdAt === 'string'
    && typeof row.lastActiveAt === 'string';
}

function parseIndex(content: string): SessionMetadata[] {
  let value: unknown;
  try {
    value = JSON.parse(content.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new CorruptSessionsIndexError(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(value) || value.some(row => !isMetadata(row))) {
    throw new CorruptSessionsIndexError('sessions.json must contain only session metadata rows');
  }
  return value;
}

function salvageIndex(content: string): SessionMetadata[] {
  try {
    const value = JSON.parse(content.replace(/^\uFEFF/, '')) as unknown;
    if (Array.isArray(value)) return value.filter(isMetadata);
  } catch {
    // A structural scan below preserves each complete top-level object.
  }

  const rows: SessionMetadata[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const row = JSON.parse(content.slice(start, index + 1)) as unknown;
          if (isMetadata(row)) rows.push(row);
        } catch {
          // Ignore an incomplete row.
        }
        start = -1;
      }
    }
  }
  return [...new Map(rows.map(row => [row.id, row])).values()];
}

function readIndexStrict(): SessionMetadata[] {
  if (!existsSync(SESSIONS_FILE)) return [];
  return parseIndex(readFileSync(SESSIONS_FILE, 'utf8'));
}

function readIndexForDisplay(): SessionMetadata[] {
  try {
    return readIndexStrict();
  } catch {
    return existsSync(SESSIONS_FILE) ? salvageIndex(readFileSync(SESSIONS_FILE, 'utf8')) : [];
  }
}

function nextCorruptBackupPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let index = 0; index < 1_000; index += 1) {
    const suffix = index === 0 ? '' : `-${index}`;
    const candidate = join(DATA_DIR, `sessions.json.corrupt-${stamp}${suffix}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error('Unable to allocate sessions.json backup path');
}

function writeIndex(rows: SessionMetadata[]): void {
  const content = JSON.stringify(rows, null, 2);
  writeFileSync(SESSIONS_TMP_FILE, content, 'utf8');
  renameSync(SESSIONS_TMP_FILE, SESSIONS_FILE);
}

function readIndexForWrite(): SessionMetadata[] {
  try {
    return readIndexStrict();
  } catch (error) {
    if (!(error instanceof CorruptSessionsIndexError)) throw error;
    const corrupt = readFileSync(SESSIONS_FILE, 'utf8');
    let recovered = salvageIndex(corrupt);
    if (existsSync(SESSIONS_TMP_FILE)) {
      try {
        const tempIsCurrent = statSync(SESSIONS_TMP_FILE).mtimeMs >= statSync(SESSIONS_FILE).mtimeMs;
        if (tempIsCurrent) recovered = parseIndex(readFileSync(SESSIONS_TMP_FILE, 'utf8'));
      } catch {
        // Ignore a stale or malformed interrupted temp write.
      }
    }
    renameSync(SESSIONS_FILE, nextCorruptBackupPath());
    writeIndex(recovered);
    return recovered;
  }
}

function transcriptIdentity(path: string): TranscriptFileIdentity {
  if (!existsSync(path)) {
    return { exists: false, dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0, endsWithNewline: false };
  }
  const stats = statSync(path);
  let endsWithNewline = false;
  if (stats.size > 0) {
    const handle = openSync(path, 'r');
    try {
      const byte = Buffer.allocUnsafe(1);
      readSync(handle, byte, 0, 1, stats.size - 1);
      endsWithNewline = byte[0] === 0x0a;
    } finally {
      closeSync(handle);
    }
  }
  return {
    exists: true,
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    endsWithNewline,
  };
}

function sameIdentity(left: TranscriptFileIdentity, right: TranscriptFileIdentity): boolean {
  return left.exists === right.exists
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.endsWithNewline === right.endsWithNewline;
}

function cursorFor(
  sessionId: string,
  persistedMessageCount: number,
  file: TranscriptFileIdentity,
): TranscriptWriteCursor {
  return Object.freeze({
    persistedMessageCount,
    [transcriptCursorState]: Object.freeze({ sessionId, file }),
  });
}

function readSnapshot(path: string): { messages: SessionMessage[]; hasMalformedRows: boolean } {
  if (!existsSync(path)) return { messages: [], hasMalformedRows: false };
  const messages: SessionMessage[] = [];
  let hasMalformedRows = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as unknown;
      if (message && typeof message === 'object') messages.push(message as SessionMessage);
      else hasMalformedRows = true;
    } catch {
      hasMalformedRows = true;
    }
  }
  return { messages, hasMalformedRows };
}

function appendedSuffixMatches(
  path: string,
  before: TranscriptFileIdentity,
  after: TranscriptFileIdentity,
  bytes: Buffer,
  allowPrefix: boolean,
): boolean {
  if (!after.exists || after.size < before.size) return false;
  const appendedLength = after.size - before.size;
  if (allowPrefix ? appendedLength <= 0 || appendedLength >= bytes.length : appendedLength !== bytes.length) {
    return false;
  }
  const handle = openSync(path, 'r');
  try {
    const actual = Buffer.allocUnsafe(appendedLength);
    readSync(handle, actual, 0, appendedLength, before.size);
    return actual.equals(bytes.subarray(0, appendedLength));
  } finally {
    closeSync(handle);
  }
}

export function getAllSessionMetadata(): SessionMetadata[] {
  ensureStorage();
  return readIndexForDisplay().sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
}

export function getSessionsByWorkspacePath(workspacePath: string): SessionMetadata[] {
  return getAllSessionMetadata().filter(session => workspacePathsEqual(session.workspacePath, workspacePath));
}

export function getSessionMetadata(sessionId: string): SessionMetadata | null {
  return getAllSessionMetadata().find(session => session.id === sessionId) ?? null;
}

export async function saveSessionMetadata(session: SessionMetadata): Promise<void> {
  await withSessionsLock(async () => {
    const rows = readIndexForWrite();
    const index = rows.findIndex(row => row.id === session.id);
    if (index >= 0) rows[index] = session;
    else rows.push(session);
    writeIndex(rows);
  });
}

export async function createSession(
  workspacePath: string,
  snapshot: Partial<Pick<SessionMetadata, 'title' | 'lastActiveAt'>> = {},
): Promise<SessionMetadata> {
  const session = createSessionMetadata(workspacePath, snapshot);
  await saveSessionMetadata(session);
  return session;
}

function canonicalActivityTime(current: string, incoming: string | undefined): string {
  if (!incoming) return current;
  const parsed = Date.parse(incoming);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== incoming) return current;
  const currentTime = Date.parse(current);
  return Number.isFinite(currentTime) && parsed < currentTime ? current : incoming;
}

export async function updateSessionMetadata(
  sessionId: string,
  updates: Partial<Pick<SessionMetadata,
    | 'title'
    | 'titleSource'
    | 'lastActiveAt'
    | 'sdkSessionId'
    | 'stats'
    | 'lastMessagePreview'
  >>,
  precondition?: (current: SessionMetadata) => boolean,
): Promise<SessionMetadata | null> {
  let result: SessionMetadata | null = null;
  await withSessionsLock(async () => {
    const rows = readIndexForWrite();
    const index = rows.findIndex(row => row.id === sessionId);
    if (index < 0 || (precondition && !precondition(rows[index]))) return;
    const current = rows[index];
    result = {
      ...current,
      ...updates,
      lastActiveAt: canonicalActivityTime(current.lastActiveAt, updates.lastActiveAt),
    };
    rows[index] = result;
    writeIndex(rows);
  });
  return result;
}

export async function updateSessionTitleFromMessage(sessionId: string, message: string): Promise<void> {
  await updateSessionMetadata(
    sessionId,
    { title: generateSessionTitle(message), titleSource: 'default' },
    current => current.title === 'New Chat' && current.titleSource !== 'user',
  );
}

export function calculateSessionStats(messages: readonly SessionMessage[]): SessionStats {
  return messages.reduce<SessionStats>((stats, message) => {
    if (message.role === 'user') stats.messageCount += 1;
    if (message.usage) {
      stats.totalInputTokens += message.usage.inputTokens;
      stats.totalOutputTokens += message.usage.outputTokens;
      stats.totalCacheReadTokens = (stats.totalCacheReadTokens ?? 0) + (message.usage.cacheReadTokens ?? 0);
      stats.totalCacheCreationTokens = (stats.totalCacheCreationTokens ?? 0) + (message.usage.cacheCreationTokens ?? 0);
    }
    return stats;
  }, { messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0 });
}

async function updateProjectionAfterAppend(sessionId: string, messages: readonly SessionMessage[]): Promise<void> {
  const delta = calculateSessionStats(messages);
  const latestUser = [...messages].reverse().find(message => message.role === 'user');
  const now = messages.at(-1)?.timestamp ?? new Date().toISOString();
  await withSessionsLock(async () => {
    const rows = readIndexForWrite();
    const index = rows.findIndex(row => row.id === sessionId);
    if (index < 0) return;
    const current = rows[index];
    const stats = current.stats ?? { messageCount: 0, totalInputTokens: 0, totalOutputTokens: 0 };
    rows[index] = {
      ...current,
      lastActiveAt: canonicalActivityTime(current.lastActiveAt, now),
      lastMessagePreview: latestUser
        ? latestUser.content.replace(/\s+/g, ' ').trim().slice(0, 160)
        : current.lastMessagePreview,
      stats: {
        messageCount: stats.messageCount + delta.messageCount,
        totalInputTokens: stats.totalInputTokens + delta.totalInputTokens,
        totalOutputTokens: stats.totalOutputTokens + delta.totalOutputTokens,
        totalCacheReadTokens: (stats.totalCacheReadTokens ?? 0) + (delta.totalCacheReadTokens ?? 0),
        totalCacheCreationTokens: (stats.totalCacheCreationTokens ?? 0) + (delta.totalCacheCreationTokens ?? 0),
      },
    };
    writeIndex(rows);
  });
}

export async function loadSessionTranscript(sessionId: string): Promise<SessionTranscriptSnapshot> {
  return withTranscriptLock(sessionId, async () => {
    const path = sessionFile(sessionId);
    const snapshot = readSnapshot(path);
    return {
      ...snapshot,
      cursor: cursorFor(sessionId, snapshot.messages.length, transcriptIdentity(path)),
    };
  });
}

export async function appendSessionMessages(
  sessionId: string,
  cursor: TranscriptWriteCursor,
  messages: readonly SessionMessage[],
): Promise<AppendSessionMessagesResult> {
  if (messages.length === 0) {
    return { ok: true, action: 'appended', count: 0, totalCount: cursor.persistedMessageCount, cursor };
  }
  try {
    return await withTranscriptLock(sessionId, async () => {
      const path = sessionFile(sessionId);
      const expected = cursor[transcriptCursorState];
      const current = transcriptIdentity(path);
      if (expected.sessionId !== sessionId) {
        return { ok: false, reason: 'stale-cursor', error: 'Cursor belongs to another session' };
      }
      const prefix = current.exists && current.size > 0 && !current.endsWithNewline ? '\n' : '';
      const bytes = Buffer.from(prefix + messages.map(row => JSON.stringify(row)).join('\n') + '\n');
      if (!sameIdentity(expected.file, current)) {
        if (appendedSuffixMatches(path, expected.file, current, bytes, false)) {
          return {
            ok: true,
            action: 'appended',
            count: messages.length,
            totalCount: cursor.persistedMessageCount + messages.length,
            cursor: cursorFor(sessionId, cursor.persistedMessageCount + messages.length, current),
          };
        }
        return { ok: false, reason: 'stale-cursor', error: 'Session transcript changed after the cursor was issued' };
      }
      if (!current.exists && !getSessionMetadata(sessionId)) {
        return {
          ok: false,
          reason: 'unindexed-create-refused',
          error: 'Session metadata is missing; refused to create transcript',
          cursor,
        };
      }
      try {
        appendFileSync(path, bytes);
      } catch (error) {
        const afterFailure = transcriptIdentity(path);
        if (appendedSuffixMatches(path, current, afterFailure, bytes, false)) {
          const next = cursorFor(sessionId, cursor.persistedMessageCount + messages.length, afterFailure);
          try { await updateProjectionAfterAppend(sessionId, messages); } catch { /* transcript is authoritative */ }
          return { ok: true, action: 'appended', count: messages.length, totalCount: next.persistedMessageCount, cursor: next };
        }
        if (appendedSuffixMatches(path, current, afterFailure, bytes, true)) {
          truncateSync(path, current.size);
          return {
            ok: false,
            reason: 'write-error',
            error: error instanceof Error ? error.message : String(error),
            cursor: cursorFor(sessionId, cursor.persistedMessageCount, transcriptIdentity(path)),
          };
        }
        return { ok: false, reason: 'storage-consistency-error', error: error instanceof Error ? error.message : String(error) };
      }
      const after = transcriptIdentity(path);
      if (!appendedSuffixMatches(path, current, after, bytes, false)) {
        return { ok: false, reason: 'storage-consistency-error', error: 'Append did not produce the expected durable suffix' };
      }
      try { await updateProjectionAfterAppend(sessionId, messages); } catch { /* transcript is authoritative */ }
      const next = cursorFor(sessionId, cursor.persistedMessageCount + messages.length, after);
      return { ok: true, action: 'appended', count: messages.length, totalCount: next.persistedMessageCount, cursor: next };
    });
  } catch (error) {
    return { ok: false, reason: 'write-error', error: error instanceof Error ? error.message : String(error), cursor };
  }
}

export function getSessionDataFromMetadata(metadata: SessionMetadata): SessionData {
  const path = sessionFile(metadata.id);
  const messages = readSnapshot(path).messages;
  return { ...metadata, messages };
}

export function getSessionData(sessionId: string): SessionData | null {
  const metadata = getSessionMetadata(sessionId);
  return metadata ? getSessionDataFromMetadata(metadata) : null;
}

export async function deleteSession(
  sessionId: string,
  intent: { kind: 'user-delete' },
): Promise<{ deleted: true } | { deleted: false; reason: 'not-found' | 'io-error' }> {
  if (intent.kind !== 'user-delete') return { deleted: false, reason: 'io-error' };
  try {
    return await withTranscriptLock(sessionId, async () => withSessionsLock(async () => {
      const rows = readIndexForWrite();
      const index = rows.findIndex(row => row.id === sessionId);
      if (index < 0) return { deleted: false, reason: 'not-found' } as const;
      writeIndex(rows.filter(row => row.id !== sessionId));
      const transcriptPath = sessionFile(sessionId);
      if (existsSync(transcriptPath)) unlinkSync(transcriptPath);
      const attachmentDir = join(ATTACHMENTS_DIR, sessionId);
      if (existsSync(attachmentDir)) rmSync(attachmentDir, { recursive: true, force: true });
      return { deleted: true } as const;
    }));
  } catch {
    return { deleted: false, reason: 'io-error' };
  }
}

export function saveAttachment(
  sessionId: string,
  attachmentId: string,
  _fileName: string,
  base64Data: string,
  mimeType: string,
): string {
  if (!isValidSessionId(sessionId) || !/^[A-Za-z0-9-]{1,128}$/.test(attachmentId)) {
    throw new Error('Invalid attachment identity');
  }
  ensureStorage();
  const directory = join(ATTACHMENTS_DIR, sessionId);
  ensureDirSync(directory);
  const extension = ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
  } as Record<string, string>)[mimeType] ?? 'bin';
  const relativePath = `${sessionId}/${attachmentId}.${extension}`;
  writeFileSync(join(ATTACHMENTS_DIR, relativePath), Buffer.from(base64Data, 'base64'));
  return relativePath;
}

export function getAttachmentPath(relativePath: string): string {
  return join(ATTACHMENTS_DIR, relativePath);
}
