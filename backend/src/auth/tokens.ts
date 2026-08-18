import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, errors, jwtVerify, type JWTPayload } from 'jose';

const ISSUER = 'xiaojing-backend';
const CLIENT_AUDIENCE = 'xiaojing-client';
const ADMIN_AUDIENCE = 'xiaojing-admin';

export interface AccessTokenClaims {
  accountId: string;
  sessionId: string;
  passwordVersion: number;
}

export type TokenVerifyFailure = { ok: false; reason: 'expired' | 'invalid' };
export type TokenVerifySuccess<T> = { ok: true; claims: T };

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function signHmacJwt(
  secret: string,
  claims: Record<string, unknown>,
  options: { subject: string; audience: string; ttlSeconds: number; nowMs: number },
): Promise<string> {
  const nowSeconds = Math.floor(options.nowMs / 1000);
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.subject)
    .setIssuer(ISSUER)
    .setAudience(options.audience)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + options.ttlSeconds)
    .sign(secretKey(secret));
}

async function verifyHmacJwt(
  secret: string,
  token: string,
  audience: string,
): Promise<{ ok: true; payload: JWTPayload } | TokenVerifyFailure> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { issuer: ISSUER, audience });
    return { ok: true, payload };
  } catch (error) {
    if (error instanceof errors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

export async function signAccessToken(
  secret: string,
  claims: AccessTokenClaims,
  ttlSeconds: number,
  nowMs: number,
): Promise<string> {
  return await signHmacJwt(secret, { sid: claims.sessionId, pv: claims.passwordVersion }, {
    subject: claims.accountId,
    audience: CLIENT_AUDIENCE,
    ttlSeconds,
    nowMs,
  });
}

export async function verifyAccessToken(
  secret: string,
  token: string,
): Promise<TokenVerifySuccess<AccessTokenClaims> | TokenVerifyFailure> {
  const verified = await verifyHmacJwt(secret, token, CLIENT_AUDIENCE);
  if (!verified.ok) return verified;
  const { sub, sid, pv } = verified.payload;
  if (typeof sub !== 'string' || typeof sid !== 'string' || typeof pv !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, claims: { accountId: sub, sessionId: sid, passwordVersion: pv } };
}

export async function signAdminToken(
  secret: string,
  ttlSeconds: number,
  nowMs: number,
): Promise<string> {
  return await signHmacJwt(secret, { role: 'admin' }, {
    subject: 'admin',
    audience: ADMIN_AUDIENCE,
    ttlSeconds,
    nowMs,
  });
}

export async function verifyAdminToken(
  secret: string,
  token: string,
): Promise<TokenVerifySuccess<{ role: 'admin' }> | TokenVerifyFailure> {
  const verified = await verifyHmacJwt(secret, token, ADMIN_AUDIENCE);
  if (!verified.ok) return verified;
  if (verified.payload.role !== 'admin') return { ok: false, reason: 'invalid' };
  return { ok: true, claims: { role: 'admin' } };
}

/**
 * refresh token 是不透明随机串（32 字节 base64url），库里只存
 * HMAC-SHA256(AUTH_SECRET, raw)——数据库泄露也拼不出可用 token。
 */
export function issueRefreshToken(): { id: string; raw: string } {
  return { id: randomUUID(), raw: `xr_${randomBytes(32).toString('base64url')}` };
}

export function hashRefreshToken(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}
