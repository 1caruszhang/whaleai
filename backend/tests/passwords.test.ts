import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords';

describe('scrypt password hashing', () => {
  it('roundtrips a password and rejects wrong input', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('wrong password', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash so identical passwords differ', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('same-password', b)).toBe(true);
  });

  it('fails closed on malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(verifyPassword('x', 'scrypt$not$numeric$params$Salt$Hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$0$0$0$%%not-base64%%$%%not-base64%%')).toBe(false);
  });
});
