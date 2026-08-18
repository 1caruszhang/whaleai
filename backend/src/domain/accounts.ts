import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { AccountRow, AccountStatus } from './types';
import { AppError } from '../errors';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { revokeAccountSessions, startSession, type StartedSession } from '../auth/sessions';
import { applyAccountLedgerDelta } from './ledger';

// 登录时手机号不存在的分支也做一次等代价 scrypt 校验，避免通过响应耗时枚举已注册手机号。
let timingEqualizerHash: string | undefined;

function equalizerHash(): string {
  timingEqualizerHash ??= hashPassword(`timing-equalizer-${randomUUID()}`);
  return timingEqualizerHash;
}

export function findAccountById(db: SqlClient, id: string): AccountRow | undefined {
  return db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id]);
}

export function findAccountByPhone(db: SqlClient, phone: string): AccountRow | undefined {
  return db.get<AccountRow>('SELECT * FROM accounts WHERE phone = ?', [phone]);
}

/** 运营页账号列表行（不含密码哈希等内部字段）。 */
export interface AdminAccountListItem {
  id: string;
  phone: string;
  status: AccountStatus;
  balance: number;
  mustChangePassword: boolean;
  createdAt: string;
}

/** 运营列表视图：最新建号在前，内测期量级小，单页上限由调用方定。 */
export function listAccounts(db: SqlClient, limit: number): AdminAccountListItem[] {
  return db
    .all<{
      id: string;
      phone: string;
      status: AccountStatus;
      balance: number;
      must_change_password: number;
      created_at: string;
    }>(
      'SELECT id, phone, status, balance, must_change_password, created_at FROM accounts ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit],
    )
    .map(row => ({
      id: row.id,
      phone: row.phone,
      status: row.status,
      balance: row.balance,
      mustChangePassword: row.must_change_password === 1,
      createdAt: row.created_at,
    }));
}

/**
 * 运营停用/启用（票 10）。停用同时吊销账号全部会话（refresh 立即失效；
 * access JWT 由 requireAccountAuth 的 status 检查拦截），余额与流水不动。
 */
export function setAccountStatus(
  deps: BackendDeps,
  accountId: string,
  status: AccountStatus,
): AccountRow {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  const nowIso = new Date(deps.now()).toISOString();
  deps.db.transaction(() => {
    deps.db.run('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      nowIso,
      accountId,
    ]);
    if (status === 'disabled') revokeAccountSessions(deps, accountId, 'admin_disabled');
  });
  const updated = findAccountById(deps.db, accountId);
  if (!updated) throw new AppError('internal_error', '状态更新后读不到账号行。', 500);
  return updated;
}

/** 对外账号投影：密码哈希/版本等内部字段不出领域层。 */
export function accountProjection(account: AccountRow) {
  return {
    id: account.id,
    phone: account.phone,
    status: account.status,
    mustChangePassword: account.must_change_password === 1,
    points: account.balance,
  };
}

/**
 * 运营建号：账号（首登必须改密）与开通赠送（默认 500 点）在同一事务落账，
 * 赠点经账本入账通道产生 grant 流水。余额变动只走 ledger 模块的成对路径。
 */
export function createAccountWithGrant(
  deps: BackendDeps,
  input: { phone: string; password: string },
): AccountRow {
  const nowIso = new Date(deps.now()).toISOString();
  const accountId = randomUUID();
  const grant = deps.config.signupGrantPoints;
  try {
    deps.db.transaction(() => {
      deps.db.run(
        `INSERT INTO accounts (id, phone, password_hash, password_version, status, must_change_password, balance, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'active', 1, 0, ?, ?)`,
        [accountId, input.phone, hashPassword(input.password), nowIso, nowIso],
      );
      applyAccountLedgerDelta(deps, accountId, grant, 'grant', '开通赠送');
    });
  } catch (error) {
    if (deps.db.isUniqueViolation(error)) {
      throw new AppError('phone_taken', '该手机号已开通账号。', 409);
    }
    throw error;
  }
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('internal_error', '建号后读不到账号行。', 500);
  return account;
}

export interface LoginResult {
  account: AccountRow;
  session: StartedSession;
}

export function login(deps: BackendDeps, phone: string, password: string): LoginResult {
  const account = findAccountByPhone(deps.db, phone);
  // 先判停用再验密码：停用账号无论密码对错都得到同一 403，
  // 不给「停用账号上试密码」的预言机。
  if (account && account.status !== 'active') {
    throw new AppError('account_disabled', '账号已停用，请联系运营。', 403);
  }
  const passwordOk = verifyPassword(password, account?.password_hash ?? equalizerHash());
  if (!account || !passwordOk) {
    throw new AppError('invalid_credentials', '手机号或密码不正确。', 401);
  }
  return { account, session: startSession(deps, account.id) };
}

/**
 * 首登改密 / 主动改密共用：校验当前密码后原子地换哈希、password_version+1
 * （旧 JWT 的 pv 失配即拒绝）、清除首登标记，并吊销全部既有会话，最后
 * 返回一个全新会话，客户端立即切换到新 token 对。
 */
export function changeAccountPassword(
  deps: BackendDeps,
  accountId: string,
  currentPassword: string,
  newPassword: string,
): LoginResult {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('invalid_token', '账号不存在。', 401);
  if (!verifyPassword(currentPassword, account.password_hash)) {
    throw new AppError('invalid_credentials', '当前密码不正确。', 401);
  }
  if (currentPassword === newPassword) {
    throw new AppError('same_password', '新密码不能与当前密码相同。', 400);
  }
  const nowIso = new Date(deps.now()).toISOString();
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE accounts
       SET password_hash = ?, password_version = password_version + 1, must_change_password = 0, updated_at = ?
       WHERE id = ?`,
      [hashPassword(newPassword), nowIso, accountId],
    );
    revokeAccountSessions(deps, accountId, 'password_changed');
  });
  const updated = findAccountById(deps.db, accountId);
  if (!updated) throw new AppError('internal_error', '改密后读不到账号行。', 500);
  return { account: updated, session: startSession(deps, accountId) };
}
