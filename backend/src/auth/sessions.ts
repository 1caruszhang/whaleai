import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { AuthSessionRow, RefreshTokenRow } from '../domain/types';
import { AppError } from '../errors';
import { hashRefreshToken, issueRefreshToken } from './tokens';

export interface StartedSession {
  sessionId: string;
  refreshTokenId: string;
  /** 只在签发响应中出现一次的原始 refresh token；库里只有哈希。 */
  refreshRaw: string;
}

function isoNow(deps: BackendDeps): string {
  return new Date(deps.now()).toISOString();
}

/** 登录成功后开新会话：会话与首枚 refresh token 同事务落库，30 天滑动。 */
export function startSession(deps: BackendDeps, accountId: string): StartedSession {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + deps.config.refreshTokenTtlSeconds * 1000).toISOString();
  const sessionId = randomUUID();
  const token = issueRefreshToken();
  deps.db.transaction(() => {
    deps.db.run(
      'INSERT INTO auth_sessions (id, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [sessionId, accountId, nowIso, nowIso, expiresIso],
    );
    deps.db.run(
      'INSERT INTO refresh_tokens (id, session_id, token_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [token.id, sessionId, hashRefreshToken(deps.config.authSecret, token.raw), nowIso, expiresIso],
    );
  });
  return { sessionId, refreshTokenId: token.id, refreshRaw: token.raw };
}

/** 吊销单个会话及其全部 refresh token（幂等）。 */
export function revokeSession(deps: BackendDeps, sessionId: string, reason: string): void {
  const nowIso = isoNow(deps);
  deps.db.transaction(() => {
    deps.db.run(
      'UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
      [nowIso, reason, sessionId],
    );
    deps.db.run(
      'UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL',
      [nowIso, sessionId],
    );
  });
}

/** 吊销账号下全部会话（改密、运营停用等即时失效路径）。 */
export function revokeAccountSessions(deps: BackendDeps, accountId: string, reason: string): void {
  const nowIso = isoNow(deps);
  deps.db.transaction(() => {
    deps.db.run(
      'UPDATE auth_sessions SET revoked_at = ?, revoked_reason = ? WHERE account_id = ? AND revoked_at IS NULL',
      [nowIso, reason, accountId],
    );
    deps.db.run(
      `UPDATE refresh_tokens SET revoked_at = ?
       WHERE revoked_at IS NULL AND session_id IN (SELECT id FROM auth_sessions WHERE account_id = ?)`,
      [nowIso, accountId],
    );
  });
}

export interface RefreshTokenOwner {
  sessionId: string;
  accountId: string;
}

export function findRefreshTokenOwner(deps: BackendDeps, raw: string): RefreshTokenOwner | undefined {
  const row = deps.db.get<{ session_id: string; account_id: string }>(
    `SELECT rt.session_id, s.account_id
     FROM refresh_tokens rt JOIN auth_sessions s ON s.id = rt.session_id
     WHERE rt.token_hash = ?`,
    [hashRefreshToken(deps.config.authSecret, raw)],
  );
  if (!row) return undefined;
  return { sessionId: row.session_id, accountId: row.account_id };
}

export type RefreshRotation =
  | { status: 'rotated'; accountId: string; sessionId: string; refreshRaw: string }
  | { status: 'reuse_detected' }
  | { status: 'expired' }
  | { status: 'invalid' }
  | { status: 'account_disabled' };

/**
 * refresh 滑动轮换 + 重用检测（决策票 12）：
 * - 正常路径：旧 token 标记 consumed/replaced_by，签发新 token，会话续期 30 天。
 * - 旧 token 再次出现（consumed_at 已置位）视为泄露 → 吊销整个会话，
 *   该会话此后签发的一切 refresh 全部失效，客户端只能重新登录。
 * - 已被吊销（登出/改密/停用）或未知的 token 返回 invalid，不改状态。
 */
export function rotateRefreshToken(deps: BackendDeps, raw: string): RefreshRotation {
  const token = deps.db.get<Pick<RefreshTokenRow, 'id' | 'session_id' | 'expires_at' | 'consumed_at' | 'revoked_at'>>(
    'SELECT id, session_id, expires_at, consumed_at, revoked_at FROM refresh_tokens WHERE token_hash = ?',
    [hashRefreshToken(deps.config.authSecret, raw)],
  );
  if (!token || token.revoked_at) return { status: 'invalid' };
  if (token.consumed_at) {
    revokeSession(deps, token.session_id, 'refresh_reuse');
    return { status: 'reuse_detected' };
  }

  const session = deps.db.get<Pick<AuthSessionRow, 'id' | 'account_id' | 'expires_at' | 'revoked_at'>>(
    'SELECT id, account_id, expires_at, revoked_at FROM auth_sessions WHERE id = ?',
    [token.session_id],
  );
  if (!session || session.revoked_at) return { status: 'invalid' };

  const account = deps.db.get<{ status: string }>('SELECT status FROM accounts WHERE id = ?', [
    session.account_id,
  ]);
  if (!account) return { status: 'invalid' };

  const nowMs = deps.now();
  if (nowMs >= Date.parse(token.expires_at) || nowMs >= Date.parse(session.expires_at)) {
    return { status: 'expired' };
  }
  if (account.status !== 'active') return { status: 'account_disabled' };

  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + deps.config.refreshTokenTtlSeconds * 1000).toISOString();
  const next = issueRefreshToken();
  deps.db.transaction(() => {
    const consumed = deps.db.run(
      'UPDATE refresh_tokens SET consumed_at = ?, replaced_by = ? WHERE id = ? AND consumed_at IS NULL',
      [nowIso, next.id, token.id],
    );
    if (consumed.changes !== 1) {
      // 同步单线程下不可达；保留断言防未来异步化时静默双花。
      throw new AppError('internal_error', 'refresh token 并发轮换冲突。', 500);
    }
    deps.db.run(
      'INSERT INTO refresh_tokens (id, session_id, token_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      [next.id, session.id, hashRefreshToken(deps.config.authSecret, next.raw), nowIso, expiresIso],
    );
    deps.db.run('UPDATE auth_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?', [
      expiresIso,
      nowIso,
      session.id,
    ]);
  });
  return { status: 'rotated', accountId: session.account_id, sessionId: session.id, refreshRaw: next.raw };
}
