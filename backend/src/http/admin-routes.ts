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
  setAccountDisplayName,
  setAccountStatus,
  type AdminAccountSort,
} from '../domain/accounts';
import { applyAccountLedgerDelta, balanceSnapshot, listLedgerEntries } from '../domain/ledger';
import { listChatUsageRecords } from '../domain/chat-usage';
import { listPermitHistory } from '../domain/permits';
import { listPublishOrdersForAccount, publishOrderProjection } from '../domain/publish-orders';
import { listProviderUsageRecords, providerUsageRecordProjection } from '../domain/provider-usage';
import { adminOverviewStats } from '../domain/admin-stats';
import {
  DistributionUpstream,
  type UpstreamCallResult,
} from '../gateway/distribution-upstream';
import { AppError } from '../errors';
import { signAdminToken, verifyAdminToken } from '../auth/tokens';
import { parseJsonBody, readBearerToken } from './request';
import { setAdminSessionCookie } from './admin-pages';
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

/** 建号（票 47 起）：可选用户名（≤64 字符、不参与登录），校验口径与既有建号契约一致。 */
const createAccountSchema = z.object({
  phone: phoneSchema,
  initialPassword: z.string().min(8, '初始密码至少 8 位').max(128),
  displayName: z.string().trim().max(64, '用户名最长 64 字符').optional(),
});

/** 停用/启用（票 47 JSON 化）：停用即时吊销全部会话。 */
const accountStatusSchema = z.object({ status: z.enum(['active', 'disabled']) });

/**
 * 用户名设置/清空（票 49）：displayName 必填字段，null 与空串同义（清空），
 * 非空 trim 后 ≤64 字符。契约：清空后 accounts.display_name 落空串。
 */
const displayNameSchema = z.object({
  displayName: z
    .string()
    .trim()
    .max(64, '用户名最长 64 字符')
    .nullable(),
});

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

/** 详情页子资源共用解析（票 49）：accountId 异形 400、未知账号 404。 */
function requireDetailAccountId(deps: BackendDeps, raw: string): string {
  const parsed = accountIdSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('validation_error', 'accountId 无效。', 400);
  if (!findAccountById(deps.db, parsed.data)) {
    throw new AppError('account_not_found', '账号不存在。', 404);
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
  // 媒介池余额与 SPA 仪表盘同一权威实现（票 10/48）：签名 /profile 代理。
  const upstream = new DistributionUpstream(deps, deps.fetchImpl ?? fetch);

  routes.post('/admin/login', async c => {
    const body = await parseJsonBody(c, adminLoginSchema);
    if (!timingSafeStringEqual(body.password, deps.config.adminPassword)) {
      // 登录节流（票 10）：连续失败递增延时，防在线爆破。
      await throttle.penalize();
      throw new AppError('invalid_credentials', '运营密码不正确。', 401);
    }
    throttle.reset();
    const adminToken = await signAdminToken(
      deps.config.authSecret,
      deps.config.adminTokenTtlSeconds,
      deps.now(),
    );
    // 票 51 桥接：/admin/session 退役后，SPA 登录同源下发 SSR 会话 cookie，
    // 保留的偏好名单页（admin-pages.ts）据此过会话门。JSON 契约不变——
    // 响应体仍是 {adminToken, tokenType, expiresIn}，仅多一个 Set-Cookie。
    setAdminSessionCookie(c, adminToken, deps.config.adminTokenTtlSeconds);
    return c.json({
      adminToken,
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
   * 200 条硬上限随本端点分页化移除；SSR 列表退役（票 51）后这是唯一列表入口。
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

  /** 停用/启用（票 47）：停用即时吊销账号全部会话。 */
  routes.post('/admin/accounts/:accountId/status', requireAdmin, async c => {
    const accountId = accountIdSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      throw new AppError('validation_error', 'accountId 无效。', 400);
    }
    const body = await parseJsonBody(c, accountStatusSchema);
    const updated = setAccountStatus(deps, accountId.data, body.status);
    return c.json({ account: adminAccountProjection(updated) });
  });

  /**
   * 用户名设置/清空（票 49）：null 与空串同义清除，非空 trim 后 ≤64 落库
   * （路由 schema 已拦截 >64 → 400）。详情页用户名编辑接本端点。
   */
  routes.post('/admin/accounts/:accountId/display-name', requireAdmin, async c => {
    const accountId = accountIdSchema.safeParse(c.req.param('accountId'));
    if (!accountId.success) {
      throw new AppError('validation_error', 'accountId 无效。', 400);
    }
    const body = await parseJsonBody(c, displayNameSchema);
    const updated = setAccountDisplayName(deps, accountId.data, body.displayName ?? '');
    return c.json({ account: adminAccountProjection(updated) });
  });

  /**
   * 仪表盘聚合（票 48）：账号总数/活跃/停用、余额总计与冻结、今日充值、
   * 今日扣点（北京时间日界）、近 30 天按日序列（空窗日补零）。
   */
  routes.get('/admin/stats/overview', requireAdmin, c => {
    return c.json(adminOverviewStats(deps.db, deps.now()));
  });

  /**
   * 媒介池余额（票 48）：SPA 仪表盘媒介池卡的权威逻辑——低余额阈值
   * 比较纯服务端；上游失败返回降级标记而非 500（「余额获取失败」降级同一
   * 语义，不阻断账号管理）。
   */
  routes.get('/admin/media-pool', requireAdmin, async c => {
    let profile: UpstreamCallResult<{ balanceCents: number }>;
    try {
      profile = await upstream.fetchProfile();
    } catch {
      // 上游不可达不阻断运营台：降级为标记而非错误。
      profile = { ok: false, response: new Response('', { status: 502 }) };
    }
    const lowBalanceCents = deps.config.adminMediaPoolLowBalanceCents;
    if (!profile.ok) {
      return c.json({ degraded: true, lowBalanceCents });
    }
    const balanceCents = profile.data.balanceCents;
    return c.json({
      degraded: false,
      balanceCents,
      lowBalanceCents,
      lowBalance: balanceCents < lowBalanceCents,
    });
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
      // 票 49：详情页余额总览与用户名编辑以本端点为主数据源，account 改用
      // 运营投影（比用户投影多 displayName；display_name 只经 /admin 读写）。
      account: adminAccountProjection(account),
      balance: balanceSnapshot(deps.db, account),
      entries,
    });
  });

  /**
   * 详情页 permit 计费数据（票 49）：沿用 listPermitHistory 的既有 domain
   * 投影（open + settled 全量、最新在前），不另造口径。
   */
  routes.get('/admin/accounts/:accountId/permits', requireAdmin, c => {
    const accountId = requireDetailAccountId(deps, c.req.param('accountId'));
    const limit = parseQueryInt(c.req.query('limit'), 'limit', 50, 1, 200);
    return c.json({ permits: listPermitHistory(deps, accountId, limit) });
  });

  /**
   * 详情页发布订单数据（票 49）：沿用 publishOrderProjection 的既有 domain
   * 投影（最新在前），不另造口径。
   */
  routes.get('/admin/accounts/:accountId/publish-orders', requireAdmin, c => {
    const accountId = requireDetailAccountId(deps, c.req.param('accountId'));
    const limit = parseQueryInt(c.req.query('limit'), 'limit', 50, 1, 200);
    const orders = listPublishOrdersForAccount(deps.db, accountId, limit).map(publishOrderProjection);
    return c.json({ orders });
  });

  /**
   * 详情页 Provider 计量数据（票 49）：camelCase 记录投影与 chat-usage 的
   * records 口径同构（最新在前），不另造口径。
   */
  routes.get('/admin/accounts/:accountId/provider-usage', requireAdmin, c => {
    const accountId = requireDetailAccountId(deps, c.req.param('accountId'));
    const limit = parseQueryInt(c.req.query('limit'), 'limit', 50, 1, 200);
    const records = listProviderUsageRecords(deps.db, accountId, limit).map(
      providerUsageRecordProjection,
    );
    return c.json({ records });
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
