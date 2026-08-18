import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashRefreshToken,
  issueRefreshToken,
  signAccessToken,
  signAdminToken,
  verifyAccessToken,
  verifyAdminToken,
} from '../src/auth/tokens';
import { openSqlDatabase } from '../src/db/client';
import { migrateDatabase } from '../src/db/migrations';

const SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef';
// jose 按真实时钟校验 exp：签发用例取真实当前时刻，过期用例取过去时刻。
const NOW = Date.now();
const PAST = Date.parse('2020-01-01T00:00:00.000Z');

describe('JWT issuance and verification', () => {
  it('roundtrips account access tokens with their claims', async () => {
    const token = await signAccessToken(
      SECRET,
      { accountId: 'acc-1', sessionId: 'ses-1', passwordVersion: 3 },
      7200,
      NOW,
    );
    const verified = await verifyAccessToken(SECRET, token);
    expect(verified).toEqual({
      ok: true,
      claims: { accountId: 'acc-1', sessionId: 'ses-1', passwordVersion: 3 },
    });
  });

  it('rejects tokens signed with a different secret or malformed input', async () => {
    const token = await signAccessToken(
      SECRET,
      { accountId: 'acc-1', sessionId: 'ses-1', passwordVersion: 1 },
      7200,
      NOW,
    );
    expect((await verifyAccessToken('another-secret-32-chars-long-enough!!!', token)).ok).toBe(false);
    expect((await verifyAccessToken(SECRET, 'garbage.token.value')).ok).toBe(false);
  });

  it('expires access tokens once the TTL passes', async () => {
    const token = await signAccessToken(
      SECRET,
      { accountId: 'acc-1', sessionId: 'ses-1', passwordVersion: 1 },
      10,
      PAST,
    );
    const late = await verifyAccessToken(SECRET, token);
    expect(late).toEqual({ ok: false, reason: 'expired' });
  });

  it('keeps admin and account audiences from crossing over', async () => {
    const adminToken = await signAdminToken(SECRET, 3600, NOW);
    const accountToken = await signAccessToken(
      SECRET,
      { accountId: 'acc-1', sessionId: 'ses-1', passwordVersion: 1 },
      3600,
      NOW,
    );
    expect((await verifyAdminToken(SECRET, adminToken)).ok).toBe(true);
    expect((await verifyAdminToken(SECRET, accountToken)).ok).toBe(false);
    expect((await verifyAccessToken(SECRET, adminToken)).ok).toBe(false);
  });
});

describe('refresh tokens', () => {
  it('issues unique opaque tokens whose hash is secret-dependent', () => {
    const a = issueRefreshToken();
    const b = issueRefreshToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.raw.startsWith('xr_')).toBe(true);
    expect(a.raw.length).toBeGreaterThan(40);

    expect(hashRefreshToken(SECRET, a.raw)).toBe(hashRefreshToken(SECRET, a.raw));
    expect(hashRefreshToken(SECRET, a.raw)).not.toBe(hashRefreshToken('other-secret-32-chars-long-enough!!!', a.raw));
    expect(hashRefreshToken(SECRET, a.raw)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('migrations', () => {
  it('is idempotent and creates all core tables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xiaojing-backend-migrate-'));
    const db = openSqlDatabase(join(dir, 'migrate.sqlite'));
    try {
      const applied = migrateDatabase(db);
      expect(applied).toEqual([
        '0001_accounts_sessions_ledger',
        '0002_billing_permits',
        '0003_ledger_entry_seq',
        '0004_chat_usage_metering',
        '0005_provider_usage_metering',
      ]);
      expect(migrateDatabase(db)).toEqual([]);

      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", [])
        .map(row => row.name);
      for (const expected of [
        'accounts',
        'auth_sessions',
        'refresh_tokens',
        'ledger_entries',
        'billing_permits',
        'permit_unit_reports',
        'chat_usage_records',
        'provider_usage_records',
        'schema_migrations',
      ]) {
        expect(tables).toContain(expected);
      }
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
