/**
 * Filesystem utilities — centralizes patterns that have platform-specific quirks.
 *
 * This file belongs to the "pit of success" family (alongside local_http / process_cmd /
 * proxy_config in Rust): call sites default to the correct behavior without each author
 * needing to remember the underlying trap.
 */

import { mkdirSync } from 'fs';

/**
 * Ensure a directory exists, creating parents as needed. Safe to call when the directory
 * already exists — works uniformly across platform/runtime combinations.
 *
 * Only `EEXIST` is treated as success. Permissions, disk-full and invalid-path
 * failures still propagate to the lifecycle owner.
 *
 * ⚠️ Do NOT use as a lock-directory primitive (mkdir-as-mutex pattern). Lock dirs
 * WANT `EEXIST` to throw so the caller knows another process holds the lock. For
 * those, call `mkdirSync(path, { mode: 0o700 })` directly (no `recursive` flag).
 */
export function ensureDirSync(path: string): void {
    try {
        mkdirSync(path, { recursive: true });
    } catch (err) {
        // EEXIST is benign concurrent directory creation. Everything else is a real failure.
        // (permissions, disk full, invalid path) and must not be swallowed.
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return;
        throw err;
    }
}
