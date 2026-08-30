import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

function isBlockedAddress(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost'
    || value === '127.0.0.1'
    || value.startsWith('127.')
    || value === '0.0.0.0'
    || value.startsWith('10.')
    || value.startsWith('192.168.')
    || value.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value)
    || value === '::'
    || value === '::0'
    || value === '::1'
    || value.startsWith('::ffff:')
    || /^f[cd][0-9a-f]{2}:/.test(value)
    || value.startsWith('fe80:');
}

export function isUrlSchemeSafe(parsed: URL): { ok: true } | { ok: false; reason: string } {
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported URL scheme: ${parsed.protocol}` };
  }
  if (isBlockedAddress(parsed.hostname)) {
    return { ok: false, reason: `Blocked private or loopback host: ${parsed.hostname}` };
  }
  return { ok: true };
}

/** Resolve once, reject private answers, then pin the validated addresses. */
export async function buildSsrfGuardedDispatcher(parsed: URL): Promise<Agent | undefined> {
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return undefined;
  const all = await lookup(host, { all: true });
  if (all.length === 0) {
    throw new Error('URL resolves to a private or loopback address');
  }
  // 代理客户端 TUN/fake-IP 环境（Clash 系）会给所有外网域名同时返回 fake
  // IPv6（fdfe::/8 ULA 段），误中私有地址判定而整域拒绝——而连接 fake
  // IPv4 经系统 TUN 出网正是该环境的正常上网路径。优先按 IPv4 判定与
  // 钉定；无 IPv4 时回落全量判定，内网/回环/元数据段的防护口径不变。
  const v4 = all.filter(({ family }) => family === 4);
  const addresses = v4.length > 0 ? v4 : all;
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('URL resolves to a private or loopback address');
  }
  const pinned = addresses.map(({ address, family }) => ({ address, family }));
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => callback(null, pinned),
    },
  });
}
