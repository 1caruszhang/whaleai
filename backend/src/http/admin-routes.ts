import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import type { AdminLoginThrottle } from '../auth/admin-login-throttle';
import { timingSafeStringEqual } from '../auth/passwords';
import { accountProjection, createAccountWithGrant, findAccountById } from '../domain/accounts';
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
    const verified = await verifyAdminToken(deps.config.authSecret, token);
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

const createAccountSchema = z.object({
  phone: phoneSchema,
  initialPassword: z.string().min(8, '初始密码至少 8 位').max(128),
});

const accountIdSchema = z.string().min(1, 'accountId 不能为空').max(64);

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
    const account = createAccountWithGrant(deps, { phone: body.phone, password: body.initialPassword });
    return c.json({ account: accountProjection(account) }, 201);
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
