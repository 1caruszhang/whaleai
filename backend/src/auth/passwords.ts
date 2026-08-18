import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * 密码哈希用 Node 内置 scrypt（无原生编译依赖，Docker 镜像可保持精简）。
 * 存储格式：scrypt$N$r$p$salt_b64$hash_b64，参数随哈希走，便于将来调参。
 */
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [_, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const [n, r, p] = [Number(nRaw), Number(rRaw), Number(pRaw)];
  if (![n, r, p].every(v => Number.isInteger(v) && v > 0)) return false;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = scryptSync(password, salt, expected.length, { N: n, r, p });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
