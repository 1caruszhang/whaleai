import { describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { buildSsrfGuardedDispatcher } from './ssrf';
import { lookup as mockedLookup } from 'node:dns/promises';

describe('buildSsrfGuardedDispatcher（fake-IP 代理环境兼容）', () => {
  it('allows hosts whose fake-IP v6 would trip the private-range check but v4 is routable', async () => {
    // Clash 系 TUN/fake-IP 环境：外网域名同时返回 198.18.x fake v4 与
    // fdfe:: fake v6——v6 误中 ULA 私网判定曾整域拒绝（正文抓取 0/8 事故）。
    vi.mocked(mockedLookup).mockResolvedValue([
      { address: '198.18.1.190', family: 4 },
      { address: 'fdfe:dcba:9876::1be', family: 6 },
    ] as never);
    await expect(
      buildSsrfGuardedDispatcher(new URL('https://www.example.com/a')),
    ).resolves.toBeTypeOf('object');
  });

  it('still blocks private v4 even when a fake-IP v6 accompanies it', async () => {
    vi.mocked(mockedLookup).mockResolvedValue([
      { address: '10.0.0.5', family: 4 },
      { address: 'fdfe:dcba:9876::1', family: 6 },
    ] as never);
    await expect(
      buildSsrfGuardedDispatcher(new URL('https://internal.example/a')),
    ).rejects.toThrow('private or loopback');
  });

  it('falls back to all families when only v6 exists (protection intact)', async () => {
    vi.mocked(mockedLookup).mockResolvedValue([
      { address: 'fdfe:dcba:9876::1', family: 6 },
    ] as never);
    await expect(
      buildSsrfGuardedDispatcher(new URL('https://v6only.example/a')),
    ).rejects.toThrow('private or loopback');
  });
});
