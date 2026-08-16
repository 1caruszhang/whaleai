/**
 * UnifiedLogger — Pattern 6 (Buffered async writer + bounded logs).
 *
 * Persists merged React/Node/Rust logs to the application unified log.
 *
 * Current invariants:
 *   - Uses an in-memory queue drained by a
 *     100ms flusher. Bounded queue size; overflow bumps a drop counter
 *     that emits a single warning every 60s.
 *   - The flusher uses a single `openSync` + batched `writeSync` +
 *     `closeSync` per drain — far cheaper than per-entry sync write.
 *   - Per-file 50MB cap → rotate to `unified-<date>-<pid>-<nonce>.<iso>.log`;
 *     the active file itself is per-process (`unified-<date>-<pid>-<nonce>.log`)
 *     so concurrent writers (Rust shell + sibling Sidecars) never share one
 *     file's size accounting or rotation.
 *   - Directory budget + age retention live in `./log-retention.ts`
 *     so unified + per-session logs share one coherent
 *     policy. This module owns the active-write path (queue, flush,
 *     rotation) only.
 *   - Process exit / SIGINT / SIGTERM hook drains the queue using the
 *     same batched openSync/writeSync path, so we don't lose entries at
 *     shutdown without resorting to a per-entry sync write.
 *   - Exposes `getRecentLogLines(n)` for the crash dumper to capture
 *     last-N tail lines into the crash log bundle.
 *
 * Console callers enqueue through `logger.ts`.
 */

import {
  closeSync,
  existsSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from 'fs';
import { join } from 'path';

import type { LogEntry } from '../shared/types/log';
import { LOGS_DIR, ensureLogsDir } from './logUtils';
import { localDate } from '../shared/logTime';
import { runLogRetentionSweep } from './log-retention';

// ── Tunables (Pattern 6 §6.3.5) ────────────────────────────────────────
const FLUSH_INTERVAL_MS = 100;
/** Hard cap on in-memory queue length. Overflow increments drop counter. */
const QUEUE_MAX_ENTRIES = 1000;
/** Per-file size cap before rotation. */
const PER_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB
/** Drop-warning emit interval (only emits if dropped > 0 since last warn). */
const DROP_WARN_INTERVAL_MS = 60_000;
/** In-memory ring buffer for crash-log tail capture. */
const RECENT_LINES_CAPACITY = 200;
// Directory budget + retention floor live in `./log-retention.ts`. This
// module focuses on the active-write path (queue, flush, rotation); it
// hands off cleanup decisions to the unified retention sweep.

// ── State ───────────────────────────────────────────────────────────────
let currentDate: string | null = null;
let currentFilePath: string | null = null;
let currentFileSize = 0;

/**
 * Per-process file tag: `<pid>-<nonce>`. The unified_logging spec promises
 * each process (Rust shell + every Session Sidecar) writes its own bounded
 * file; a shared `unified-<date>.log` made K writers each track only their
 * own bytes against the size cap and let one process' rename-rotation churn
 * the file out from under the others. The nonce is minted once per process
 * so two boots that reuse a pid still never collide.
 */
const PROCESS_LOG_TAG = `${process.pid}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

const queue: string[] = [];
let dropped = 0;
let lastDropWarnAt = 0;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let exitHookInstalled = false;

/** Tail ring buffer for crash dumps (kept separate from the flush queue). */
const recentLines: string[] = [];

// ── Date / path resolution ─────────────────────────────────────────────
function getLogFilePath(): string {
  const today = localDate();
  if (currentDate !== today) {
    currentDate = today;
    currentFilePath = join(LOGS_DIR, `unified-${today}-${PROCESS_LOG_TAG}.log`);
    // Refresh size cache on day rollover.
    try {
      currentFileSize = existsSync(currentFilePath) ? statSync(currentFilePath).size : 0;
    } catch {
      currentFileSize = 0;
    }
  }
  return currentFilePath!;
}

// ── Formatting ─────────────────────────────────────────────────────────
function formatLogEntry(entry: LogEntry): string {
  const level = entry.level.toUpperCase().padEnd(5);
  const source = entry.source.toUpperCase().padEnd(5);
  // Correlation fields are emitted as a compact bracketed suffix when
  // present — keeps existing greps for `[NODE ] [INFO ]` working while
  // making `sessionId=...` filterable. Order is fixed so log diffs stay stable.
  const tags: string[] = [];
  if (entry.sessionId) tags.push(`sid=${entry.sessionId}`);
  if (entry.turnId) tags.push(`turn=${entry.turnId}`);
  if (entry.requestId) tags.push(`req=${entry.requestId}`);
  if (entry.tabId) tags.push(`tab=${entry.tabId}`);
  if (entry.ownerId) tags.push(`owner=${entry.ownerId}`);
  const tagSuffix = tags.length ? ` [${tags.join(' ')}]` : '';
  return `${entry.timestamp} [${source}] [${level}]${tagSuffix} ${entry.message}`;
}

// ── Rotation / eviction ────────────────────────────────────────────────
function rotateIfNeeded(addBytes: number): boolean {
  if (!currentFilePath) return false;
  if (currentFileSize + addBytes <= PER_FILE_MAX_BYTES) return false;
  // Rotate: rename current to <name>.<timestamp>.log
  try {
    const ts = new Date().toISOString().replace(/[:]/g, '-');
    const dot = currentFilePath.lastIndexOf('.');
    const rotatedPath =
      dot >= 0
        ? `${currentFilePath.slice(0, dot)}.${ts}${currentFilePath.slice(dot)}`
        : `${currentFilePath}.${ts}`;
    renameSync(currentFilePath, rotatedPath);
  } catch {
    // If rotation fails, fall through — we'll keep appending.
    return false;
  }
  currentFileSize = 0;
  return true;
}

/**
 * Returns the path of the file we're currently writing to (today's
 * unified-{date}.log). Used by `log-retention` so the budget sweep never
 * evicts the file we're holding open. Null until the first flush.
 */
export function getActiveUnifiedLogPath(): string | null {
  return currentFilePath;
}

/**
 * Returns the active unified log path so retention never evicts the file
 * receiving the current batch.
 */
function getProtectedActivePaths(): ReadonlySet<string> {
  const paths = new Set<string>();
  if (currentFilePath) paths.add(currentFilePath);
  return paths;
}

// ── Flusher ────────────────────────────────────────────────────────────
function rememberRecent(line: string): void {
  recentLines.push(line);
  if (recentLines.length > RECENT_LINES_CAPACITY) {
    recentLines.splice(0, recentLines.length - RECENT_LINES_CAPACITY);
  }
}

function flushNow(): void {
  if (queue.length === 0) return;
  // Drain the queue atomically — new pushes during write go to a fresh queue.
  let lines: string[] = queue.splice(0, queue.length);
  const payload = lines.join('');
  // payload is already newline-terminated per-line.
  let didRotate = false;
  try {
    ensureLogsDir();
    const filePath = getLogFilePath();
    didRotate = rotateIfNeeded(payload.length);
    // Use a single open/write/close per flush — far cheaper than per-entry
    // sync writes because we batch up to 1000 entries.
    const fd = openSync(filePath, 'a');
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    currentFileSize += payload.length;
  } catch {
    // Re-queue on failure? No — that risks unbounded growth if the disk is
    // dead. Drop instead and let the warn timer surface it.
    dropped += lines.length;
    lines = [];
  }
  // Eager directory-budget enforcement when we just rotated. `rotateIfNeeded`
  // resets `currentFileSize` to 0 on rotation, so we MUST trigger off the
  // rotation event itself rather than checking the post-write size — checking
  // size would only fire on a single-flush > 50MB payload, which is essentially
  // never. Sweeps are stat-only and fast.
  if (didRotate) {
    runLogRetentionSweep({
      activeFilePaths: getProtectedActivePaths(),
    });
  }
}

function maybeWarnDrop(): void {
  if (dropped <= 0) return;
  const now = Date.now();
  if (now - lastDropWarnAt < DROP_WARN_INTERVAL_MS) return;
  lastDropWarnAt = now;
  // Use stderr directly so the warning itself can't recurse into the queue.
  try {
    process.stderr.write(`[UnifiedLogger] dropped ${dropped} log entries (queue saturated)\n`);
  } catch { /* ignore */ }
  dropped = 0;
}

function ensureFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushNow();
    maybeWarnDrop();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive solely for the flusher.
  if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
    (flushTimer as { unref?: () => void }).unref?.();
  }
  installExitHooks();
}

function installExitHooks(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const drain = () => {
    try {
      if (queue.length === 0) return;
      // Same batched open/write/close as the regular flusher path, just
      // run synchronously now because the process is exiting.
      const payload = queue.splice(0, queue.length).join('');
      ensureLogsDir();
      const fd = openSync(getLogFilePath(), 'a');
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    } catch { /* best effort */ }
  };
  process.on('exit', drain);
  process.on('beforeExit', drain);
  process.once('SIGINT', () => { drain(); });
  process.once('SIGTERM', () => { drain(); });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Append a log entry — non-blocking. Enqueues to an in-memory buffer
 * drained by the 100ms flusher. Drops on overflow with a counter.
 */
export function appendUnifiedLog(entry: LogEntry): void {
  const line = formatLogEntry(entry) + '\n';
  rememberRecent(line);
  if (queue.length >= QUEUE_MAX_ENTRIES) {
    dropped++;
    return;
  }
  queue.push(line);
  ensureFlusher();
}

/**
 * Append multiple log entries (batch enqueue). Same overflow semantics.
 */
export function appendUnifiedLogBatch(entries: LogEntry[]): void {
  if (entries.length === 0) return;
  for (const entry of entries) {
    const line = formatLogEntry(entry) + '\n';
    rememberRecent(line);
    if (queue.length >= QUEUE_MAX_ENTRIES) {
      dropped++;
      continue;
    }
    queue.push(line);
  }
  ensureFlusher();
}

/**
 * Internal-test hook: drain the queue synchronously. Tests use this to
 * avoid waiting on the 100ms timer.
 */
export function _flushUnifiedLogForTests(): void {
  flushNow();
}

/**
 * Drop counter accessor for tests / diagnostics. Resets to 0 once read by
 * the warn timer; tests should call before that fires.
 */
export function _getDroppedCount(): number {
  return dropped;
}

/**
 * Last-N tail lines (already newline-terminated). Used by the crash dumper
 * (`index.ts::writeCrashLog`) to embed recent unified context in the crash
 * bundle. Capacity is fixed at RECENT_LINES_CAPACITY.
 */
export function getRecentLogLines(n: number = RECENT_LINES_CAPACITY): string[] {
  if (n >= recentLines.length) return recentLines.slice();
  return recentLines.slice(recentLines.length - n);
}
