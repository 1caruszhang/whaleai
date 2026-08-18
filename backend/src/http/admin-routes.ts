import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import { accountProjection, createAccountWithGrant } from '../domain/accounts';
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

function timingSafePasswordEqual(actual: string, expected: string): boolean {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

const adminLoginSchema = z.object({ password: passwordSchema });

const createAccountSchema = z.object({
  phone: phoneSchema,
  initialPassword: z.string().min(8, '初始密码至少 8 位').max(128),
});

export function createAdminRoutes(deps: BackendDeps) {
  const routes = new Hono();
  const requireAdmin = requireAdminAuth(deps);

  routes.post('/admin/login', async c => {
    const body = await parseJsonBody(c, adminLoginSchema);
    if (!timingSafePasswordEqual(body.password, deps.config.adminPassword)) {
      throw new AppError('invalid_credentials', '运营密码不正确。', 401);
    }
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

  return routes;
}
