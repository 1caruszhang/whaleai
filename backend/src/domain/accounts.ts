import { randomUUID } from 'node:crypto';
import type { BackendDeps } from '../deps';
import type { SqlClient } from '../db/client';
import type { AccountRow, AccountStatus } from './types';
import { AppError } from '../errors';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { revokeAccountSessions, startSession, type StartedSession } from '../auth/sessions';
import { applyAccountLedgerDelta, frozenPointsFor } from './ledger';

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
  adminNote: string;
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
      admin_note: string;
    }>(
      'SELECT id, phone, status, balance, must_change_password, created_at, admin_note FROM accounts ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit],
    )
    .map(row => ({
      id: row.id,
      phone: row.phone,
      status: row.status,
      balance: row.balance,
      mustChangePassword: row.must_change_password === 1,
      createdAt: row.created_at,
      adminNote: row.admin_note,
    }));
}

// ── 票 47：JSON 账号列表（q/page/sort 参数化，200 条硬上限随分页改造移除）──

export interface AdminAccountBrand {
  workspaceId: string;
  name: string;
}

/** JSON 列表行：余额三口径、对话隐藏额度、品牌集镜像与最近活跃（会话聚合）。 */
export interface AdminAccountListRow {
  id: string;
  phone: string;
  displayName: string;
  status: AccountStatus;
  mustChangePassword: boolean;
  balance: { total: number; frozen: number; available: number };
  chatQuota: { totalPoints: number; usedMilli: number };
  brands: AdminAccountBrand[];
  /** auth_sessions 聚合 MAX(last_seen_at)；从未登录（无会话行）为 null。 */
  lastActiveAt: string | null;
  createdAt: string;
}

export type AdminAccountSort = 'created' | 'balance' | 'active';

export interface AdminAccountListResult {
  accounts: AdminAccountListRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** LIKE 包含匹配的字面量转义：% _ \ 是通配符，按字面处理（ESCAPE '\'）。 */
function escapeLikePattern(raw: string): string {
  return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

const ACCOUNT_LIST_SORT_ORDER: Record<AdminAccountSort, string> = {
  created: 'a.created_at DESC, a.id DESC',
  balance: 'a.balance DESC, a.created_at DESC, a.id DESC',
  // 最近活跃倒序；从未登录（NULL）排最后（SQLite 默认 NULL 最小，显式
  // NULLS LAST 与 PG 默认行为对齐，两种方言同义）。
  active: 'last_active_at DESC NULLS LAST, a.created_at DESC, a.id DESC',
};

/**
 * 运营账号列表（票 47）：q 命中手机号或用户名（LIKE 包含、字面转义），
 * page/pageSize 参数化分页，sort 三种排序（默认建号倒序）。行字段含余额
 * 三口径（frozen 复用 frozenPointsFor 的 permit+订单两条冻结通道口径）、
 * 对话隐藏额度（totalPoints 来自配置，usedMilli 为旁路计量累计）、品牌集
 * 镜像（本票表恒空，票 50 起写入）与最近活跃。所有 SQL 保持 ANSI 形态，
 * 迁 PG 时由 pg 版 SqlClient 直接重放。
 */
export function listAdminAccounts(
  deps: BackendDeps,
  params: { q: string; page: number; pageSize: number; sort: AdminAccountSort },
): AdminAccountListResult {
  const db = deps.db;
  const pattern = `%${escapeLikePattern(params.q)}%`;
  const where = "(? = '' OR a.phone LIKE ? ESCAPE '\\' OR a.display_name LIKE ? ESCAPE '\\')";
  const likeParams = [params.q, pattern, pattern];
  const total =
    db.get<{ total: number }>(`SELECT COUNT(*) AS total FROM accounts a WHERE ${where}`, likeParams)
      ?.total ?? 0;
  const rows = db.all<{
    id: string;
    phone: string;
    display_name: string;
    status: AccountStatus;
    must_change_password: number;
    balance: number;
    chat_quota_used_milli: number;
    created_at: string;
    last_active_at: string | null;
  }>(
    `SELECT a.id, a.phone, a.display_name, a.status, a.must_change_password,
            a.balance, a.chat_quota_used_milli, a.created_at,
            (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.account_id = a.id) AS last_active_at
     FROM accounts a
     WHERE ${where}
     ORDER BY ${ACCOUNT_LIST_SORT_ORDER[params.sort]}
     LIMIT ? OFFSET ?`,
    [...likeParams, params.pageSize, (params.page - 1) * params.pageSize],
  );
  const ids = rows.map(row => row.id);
  const brandsByAccount = new Map<string, AdminAccountBrand[]>();
  for (const row of rows) brandsByAccount.set(row.id, []);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    // 品牌集排序依据：name 升序（SQLite BINARY 按 UTF-8 字节序），与 workspace
    // 写入顺序无关，保证同账号行字段在分页/重查之间稳定。spec 未规定顺序，
    // 前端如另有偏好按此契约对齐（见 admin-accounts-list.test.ts 行字段用例）。
    for (const brand of db.all<{ account_id: string; workspace_id: string; name: string }>(
      `SELECT account_id, workspace_id, name FROM account_brands WHERE account_id IN (${placeholders})
       ORDER BY account_id, name`,
      ids,
    )) {
      brandsByAccount.get(brand.account_id)?.push({
        workspaceId: brand.workspace_id,
        name: brand.name,
      });
    }
  }
  return {
    accounts: rows.map(row => {
      const frozen = frozenPointsFor(db, row.id);
      return {
        id: row.id,
        phone: row.phone,
        displayName: row.display_name,
        status: row.status,
        mustChangePassword: row.must_change_password === 1,
        balance: { total: row.balance, frozen, available: row.balance - frozen },
        chatQuota: {
          totalPoints: deps.config.chatHiddenQuotaPoints,
          usedMilli: row.chat_quota_used_milli,
        },
        brands: brandsByAccount.get(row.id) ?? [],
        lastActiveAt: row.last_active_at,
        createdAt: row.created_at,
      };
    }),
    total,
    page: params.page,
    pageSize: params.pageSize,
  };
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

/** 运营备注：账号归属标识的设置/清除（空串即清除），不动其余任何字段。 */
export function setAccountNote(deps: BackendDeps, accountId: string, note: string): void {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  const nowIso = new Date(deps.now()).toISOString();
  deps.db.run('UPDATE accounts SET admin_note = ?, updated_at = ? WHERE id = ?', [
    note,
    nowIso,
    accountId,
  ]);
  if (!findAccountById(deps.db, accountId)) {
    throw new AppError('internal_error', '备注更新后读不到账号行。', 500);
  }
}

/**
 * 用户名设置/清除（票 49）：displayName 已由路由 schema trim 并校验 ≤64，
 * 空串即清除（与 null 同义，契约在路由层收口）。display_name 只经 /admin
 * 读写，不参与登录；不动其余任何字段。
 */
export function setAccountDisplayName(
  deps: BackendDeps,
  accountId: string,
  displayName: string,
): AccountRow {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  const nowIso = new Date(deps.now()).toISOString();
  deps.db.run('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?', [
    displayName,
    nowIso,
    accountId,
  ]);
  const updated = findAccountById(deps.db, accountId);
  if (!updated) throw new AppError('internal_error', '用户名更新后读不到账号行。', 500);
  return updated;
}

/**
 * 品牌集服务端镜像整组替换（票 50）：PUT /auth/me/brands 的领域落点。
 * 客户端全量快照是唯一权威，故在同一事务内 DELETE 该账号全部
 * account_brands 行再 INSERT 新快照——重复 PUT 结果一致（幂等），多设备
 * 同账号后写覆盖。字段校验（workspaceId 1..64、name 非空 ≤64、每账号
 * ≤100 条、workspaceId 去重）在路由 schema 收口；表内 CHECK 只兜底。
 * 停用账号由 requireAccountAuth 先行 403 拦截（品牌集冻结在最后状态），
 * 本函数不再重复判断状态。
 */
export function replaceAccountBrands(
  deps: BackendDeps,
  accountId: string,
  brands: AdminAccountBrand[],
): void {
  deps.db.transaction(() => {
    deps.db.run('DELETE FROM account_brands WHERE account_id = ?', [accountId]);
    for (const brand of brands) {
      deps.db.run(
        'INSERT INTO account_brands (account_id, workspace_id, name) VALUES (?, ?, ?)',
        [accountId, brand.workspaceId, brand.name],
      );
    }
  });
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

/** 运营侧账号投影：用户投影 + 用户名（display_name 只经 /admin 读写）。 */
export function adminAccountProjection(account: AccountRow) {
  return {
    ...accountProjection(account),
    displayName: account.display_name,
  };
}

/**
 * 运营建号：账号（首登必须改密）与开通赠送（默认 500 点）在同一事务落账，
 * 赠点经账本入账通道产生 grant 流水。余额变动只走 ledger 模块的成对路径。
 * displayName 可选（≤64 由路由 schema 校验）；空串与缺省同义，不参与登录。
 */
export function createAccountWithGrant(
  deps: BackendDeps,
  input: { phone: string; password: string; displayName?: string },
): AccountRow {
  const nowIso = new Date(deps.now()).toISOString();
  const accountId = randomUUID();
  const grant = deps.config.signupGrantPoints;
  try {
    deps.db.transaction(() => {
      deps.db.run(
        `INSERT INTO accounts (id, phone, display_name, password_hash, password_version, status, must_change_password, balance, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'active', 1, 0, ?, ?)`,
        [accountId, input.phone, input.displayName ?? '', hashPassword(input.password), nowIso, nowIso],
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

/**
 * 运营重置密码：不校验旧密码（运营本就不持有），也不做新旧相同检查
 * （那等于给运营一个试探用户当前密码的预言机）。与用户自助改密同参地
 * 换哈希、password_version+1（旧 JWT 的 pv 失配即拒绝）、吊销全部会话；
 * 区别在于置 must_change_password=1——复用建号即有的「下次登录强制改密」
 * 语义，运营告知的临时密码用一次即换。运营侧不签发用户会话。
 */
export function adminResetAccountPassword(
  deps: BackendDeps,
  accountId: string,
  newPassword: string,
): void {
  const account = findAccountById(deps.db, accountId);
  if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
  const nowIso = new Date(deps.now()).toISOString();
  deps.db.transaction(() => {
    deps.db.run(
      `UPDATE accounts
       SET password_hash = ?, password_version = password_version + 1, must_change_password = 1, updated_at = ?
       WHERE id = ?`,
      [hashPassword(newPassword), nowIso, accountId],
    );
    revokeAccountSessions(deps, accountId, 'admin_password_reset');
  });
  if (!findAccountById(deps.db, accountId)) {
    throw new AppError('internal_error', '重置密码后读不到账号行。', 500);
  }
}
