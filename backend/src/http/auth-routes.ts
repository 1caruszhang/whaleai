import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { BackendDeps } from '../deps';
import {
  accountProjection,
  changeAccountPassword,
  findAccountById,
  login,
} from '../domain/accounts';
import type { AccountRow } from '../domain/types';
import { AppError } from '../errors';
import {
  findRefreshTokenOwner,
  revokeSession,
  rotateRefreshToken,
} from '../auth/sessions';
import { signAccessToken, verifyAccessToken } from '../auth/tokens';
import { parseJsonBody, readBearerToken } from './request';
import { passwordSchema, phoneSchema, refreshTokenSchema } from './schemas';
import type { BackendEnv } from './app';

/** 账号 access JWT 校验：签名/过期 → 账号存在且未停用 → pv 与当前密码版本一致。 */
export function requireAccountAuth(deps: BackendDeps) {
  return createMiddleware<BackendEnv>(async (c, next) => {
    const token = readBearerToken(c.req.header('Authorization'));
    if (!token) throw new AppError('invalid_token', '缺少 Bearer 凭证。', 401);

    const verified = await verifyAccessToken(deps.config.authSecret, token, deps.now());
    if (!verified.ok) {
      throw new AppError(
        verified.reason === 'expired' ? 'token_expired' : 'invalid_token',
        verified.reason === 'expired' ? '登录凭证已过期，请刷新或重新登录。' : '登录凭证无效。',
        401,
      );
    }

    const account = findAccountById(deps.db, verified.claims.accountId);
    if (!account) throw new AppError('invalid_token', '登录凭证无效。', 401);
    if (account.status !== 'active') {
      throw new AppError('account_disabled', '账号已停用，请联系运营。', 403);
    }
    if (verified.claims.passwordVersion !== account.password_version) {
      // 改密后旧 JWT 立即失效（pv 失配），比决策允许的「2h 内自然过期」更严。
      throw new AppError('stale_token', '密码已修改，请使用新凭证。', 401);
    }

    c.set('account', account);
    await next();
  });
}

const loginSchema = z.object({ phone: phoneSchema, password: passwordSchema });

const changePasswordSchema = z.object({
  currentPassword: passwordSchema,
  newPassword: z.string().min(8, '新密码至少 8 位').max(128, '新密码过长'),
});

const logoutSchema = z.object({ refreshToken: refreshTokenSchema });

async function tokenPairResponse(
  deps: BackendDeps,
  account: AccountRow,
  session: { sessionId: string; refreshRaw: string },
) {
  return {
    accessToken: await signAccessToken(
      deps.config.authSecret,
      { accountId: account.id, sessionId: session.sessionId, passwordVersion: account.password_version },
      deps.config.accessTokenTtlSeconds,
      deps.now(),
    ),
    refreshToken: session.refreshRaw,
    tokenType: 'Bearer',
    expiresIn: deps.config.accessTokenTtlSeconds,
    account: accountProjection(account),
  };
}

export function createAuthRoutes(deps: BackendDeps) {
  const routes = new Hono<BackendEnv>();
  const requireAccount = requireAccountAuth(deps);

  routes.post('/auth/login', async c => {
    const body = await parseJsonBody(c, loginSchema);
    const { account, session } = login(deps, body.phone, body.password);
    return c.json(await tokenPairResponse(deps, account, session));
  });

  routes.post('/auth/refresh', async c => {
    const body = await parseJsonBody(c, z.object({ refreshToken: refreshTokenSchema }));
    const rotation = rotateRefreshToken(deps, body.refreshToken);
    if (rotation.status === 'rotated') {
      const account = findAccountById(deps.db, rotation.accountId);
      if (!account) throw new AppError('invalid_refresh', 'refresh token 无效。', 401);
      return c.json(
        await tokenPairResponse(deps, account, {
          sessionId: rotation.sessionId,
          refreshRaw: rotation.refreshRaw,
        }),
      );
    }
    if (rotation.status === 'reuse_detected') {
      throw new AppError('refresh_reuse_detected', 'refresh token 已被使用，会话已吊销，请重新登录。', 401);
    }
    if (rotation.status === 'expired') {
      throw new AppError('refresh_expired', '登录已过期，请重新登录。', 401);
    }
    if (rotation.status === 'account_disabled') {
      throw new AppError('account_disabled', '账号已停用，请联系运营。', 403);
    }
    throw new AppError('invalid_refresh', 'refresh token 无效。', 401);
  });

  routes.get('/auth/me', requireAccount, c => {
    return c.json({ account: accountProjection(c.get('account')) });
  });

  routes.post('/auth/change-password', requireAccount, async c => {
    const body = await parseJsonBody(c, changePasswordSchema);
    const { account, session } = changeAccountPassword(
      deps,
      c.get('account').id,
      body.currentPassword,
      body.newPassword,
    );
    return c.json(await tokenPairResponse(deps, account, session));
  });

  routes.post('/auth/logout', requireAccount, async c => {
    const body = await parseJsonBody(c, logoutSchema);
    const owner = findRefreshTokenOwner(deps, body.refreshToken);
    if (owner && owner.accountId === c.get('account').id) {
      revokeSession(deps, owner.sessionId, 'logout');
    }
    return c.json({ ok: true });
  });

  return routes;
}
