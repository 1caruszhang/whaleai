import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import type { AdminLoginThrottle } from '../auth/admin-login-throttle';
import { timingSafeStringEqual } from '../auth/passwords';
import {
  accountProjection,
  adminAccountProjection,
  createAccountWithGrant,
  findAccountById,
  listAdminAccounts,
  setAccountStatus,
  type AdminAccountSort,
} from '../domain/accounts';
import { applyAccountLedgerDelta, balanceSnapshot, listLedgerEntries } from '../domain/ledger';
import { listChatUsageRecords } from '../domain/chat-usage';
import { AppError } from '../errors';
import { signAdminToken, verifyAdminToken } from '../auth/tokens';
import { parseJsonBody, readBearerToken } from './request';
import { passwordSchema, phoneSchema } from './schemas';

/** 运营凭证：/admin/login 用运营密码（仅存环境变量）换短时 JWT。 */
function requireAdminAuth(deps: BackendDeps) {
  return createMiddleware(async (c, next) => {
    const token = readBearerToken(c.req.header('Authorization'));
    if (!token) throw new AppError('invalid_token', '缺少运营凭证。', 401);
    const verified = await verifyAdminToken(deps.config.authSecret, token, deps.now());
    if (!verified.ok) {
      throw new AppError(
        verified.reason === 'expired' ? 'token_expired' : 'invalid_token',
        verified.reason === 'expired' ? '运营凭证已过期，请重新登录。' : '运营凭证无效。',
        401,
      );
    }
    await next();
  });
}

const adminLoginSchema = z.object({ password: passwordSchema });

/** 建号（票 47 起）：可选用户名（≤64 字符、不参与登录），校验口径与 SSR 表单一致。 */
const createAccountSchema = z.object({
  phone: phoneSchema,
  initialPassword: z.string().min(8, '初始密码至少 8 位').max(128),
  displayName: z.string().trim().max(64, '用户名最长 64 字符').optional(),
});

/** 停用/启用（票 47 JSON 化）：语义复用既有 SSR 表单，停用即时吊销全部会话。 */
const accountStatusSchema = z.object({ status: z.enum(['active', 'disabled']) });

const accountIdSchema = z.string().min(1, 'accountId 不能为空').max(64);

/** 分页整数查询参数：缺省回落默认值；非整数/越界报 400。 */
function parseQueryInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = z.coerce
    .number()
    .int()
    .min(min, `${name} 必须是 ${min}–${max} 的整数。`)
    .max(max, `${name} 必须是 ${min}–${max} 的整数。`)
    .safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation_error', parsed.error.issues[0]?.message ?? `${name} 无效。`, 400);
  }
  return parsed.data;
}

/** 充值入账：运营核对对公转账后点数入账，备注落流水。 */
const topupSchema = z.object({
  accountId: accountIdSchema,
  points: z.number().int().min(1, '充值点数必须为正').max(10_000_000),
  note: z.string().max(500).optional(),
});

/** 运营调点：可正可负，必须带备注；只能动用未冻结余额。 */
const adjustSchema = z.object({
  accountId: accountIdSchema,
  delta: z.number().int().min(-10_000_000).max(10_000_000).refine(v => v !== 0, {
    message: '调点数不能为 0',
  }),
  note: z.string().min(1, '调点必须带备注').max(500),
});

export function createAdminRoutes(deps: BackendDeps, throttle: AdminLoginThrottle) {
  const routes = new Hono();
  const requireAdmin = requireAdminAuth(deps);

  routes.post('/admin/login', async c => {
    const body = await parseJsonBody(c, adminLoginSchema);
    if (!timingSafeStringEqual(body.password, deps.config.adminPassword)) {
      // 与 SSR 登录同一节流实例（票 10）：连续失败递增延时，防在线爆破。
      await throttle.penalize();
      throw new AppError('invalid_credentials', '运营密码不正确。', 401);
    }
    throttle.reset();
    return c.json({
      adminToken: await signAdminToken(deps.config.authSecret, deps.config.adminTokenTtlSeconds, deps.now()),
      tokenType: 'Bearer',
      expiresIn: deps.config.adminTokenTtlSeconds,
    });
  });

  routes.post('/admin/accounts', requireAdmin, async c => {
    const body = await parseJsonBody(c, createAccountSchema);
    const account = createAccountWithGrant(deps, {
      phone: body.phone,
      password: body.initialPassword,
      displayName: body.displayName,
    });
    return c.json({ account: adminAccountProjection(account) }, 201);
  });

  /**
   * 账号列表（票 47）：q 手机号/用户名包含匹配；page/pageSize 分页
   * （默认 25、上限 100）；sort=created（默认，建号倒序）/balance/active。
   * 200 条硬上限随本端点分页化移除（SSR 页面退役前仍用旧列表，票 51）。
   */
  routes.get('/admin/accounts', requireAdmin, c => {
    const q = (c.req.query('q') ?? '').trim();
    if (Array.from(q).length > 100) {
      throw new AppError('validation_error', '搜索关键词最长 100 字。', 400);
    }
    const page = parseQueryInt(c.req.query('page'), 'page', 1, 1, 1_000_000);
    const pageSize = parseQueryInt(c.req.query('pageSize'), 'pageSize', 25, 1, 100);
    let sort: AdminAccountSort = 'created';
    const sortRaw = c.req.query('sort');
    if (sortRaw !== undefined) {
      const parsed = z.enum(['created', 'balance', 'active']).safeParse(sortRaw);
      if (!parsed.success) {
        throw new AppError('validation_error', 'sort 必须是 created/balance/active。', 400);
      }
      sort = parsed.data;
    }
    return c.json(listAdminAccounts(deps, { q, page, pageSize, sort }));
  });

  /** 停用/启用（票 47）：JSON 化既有 SSR 语义——停用即时吊销账号全部会话。 */
  routes.post('/admin/accounts/:accountId/status', requireAdmin, async c => {
    const accountId = accountIdSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      throw new AppError('validation_error', 'accountId 无效。', 400);
    }
    const body = await parseJsonBody(c, accountStatusSchema);
    const updated = setAccountStatus(deps, accountId.data, body.status);
    return c.json({ account: adminAccountProjection(updated) });
  });

  routes.post('/admin/ledger/topup', requireAdmin, async c => {
    const body = await parseJsonBody(c, topupSchema);
    const account = applyAccountLedgerDelta(
      deps,
      body.accountId,
      body.points,
      'topup',
      body.note ?? '',
    );
    return c.json({ account: accountProjection(account), balance: balanceSnapshot(deps.db, account) });
  });

  routes.post('/admin/ledger/adjust', requireAdmin, async c => {
    const body = await parseJsonBody(c, adjustSchema);
    const account = applyAccountLedgerDelta(
      deps,
      body.accountId,
      body.delta,
      'adjust',
      body.note,
    );
    return c.json({ account: accountProjection(account), balance: balanceSnapshot(deps.db, account) });
  });

  routes.get('/admin/accounts/:accountId/ledger', requireAdmin, c => {    const accountId = accountIdSchema.parse(c.req.param('accountId'));
    const account = findAccountById(deps.db, accountId);
    if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
    const limitRaw = c.req.query('limit');
    let limit = 50;
    if (limitRaw !== undefined) {
      const parsed = z.coerce.number().int().min(1).max(200).safeParse(limitRaw);
      if (!parsed.success) {
        throw new AppError('validation_error', 'limit 必须是 1–200 的整数。', 400);
      }
      limit = parsed.data;
    }
    const entries = listLedgerEntries(deps.db, accountId, limit).map(entry => ({
      id: entry.id,
      delta: entry.delta,
      balanceAfter: entry.balance_after,
      kind: entry.kind,
      note: entry.note,
      createdAt: entry.created_at,
    }));
    return c.json({
      account: accountProjection(account),
      balance: balanceSnapshot(deps.db, account),
      entries,
    });
  });

  routes.get('/admin/accounts/:accountId/chat-usage', requireAdmin, c => {
    // 运营对账面（票 04）：按请求列网关旁路 token 计量与折点。这是运营侧
    // 信息——对话隐藏额度对客户端接口不可见，此处仅供与 DeepSeek 账单对账。
    const accountId = accountIdSchema.parse(c.req.param('accountId'));
    const account = findAccountById(deps.db, accountId);
    if (!account) throw new AppError('account_not_found', '账号不存在。', 404);
    const limitRaw = c.req.query('limit');
    let limit = 50;
    if (limitRaw !== undefined) {
      const parsed = z.coerce.number().int().min(1).max(200).safeParse(limitRaw);
      if (!parsed.success) {
        throw new AppError('validation_error', 'limit 必须是 1–200 的整数。', 400);
      }
      limit = parsed.data;
    }
    return c.json({
      account: accountProjection(account),
      quotaUsedMilli: account.chat_quota_used_milli,
      records: listChatUsageRecords(deps.db, accountId, limit),
    });
  });

  return routes;
}
