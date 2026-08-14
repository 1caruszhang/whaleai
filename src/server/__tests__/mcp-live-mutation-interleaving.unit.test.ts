import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauth = vi.hoisted(() => {
  let release!: (headers: Record<string, string>) => void;
  let credentialListener: ((change: {
    serverId: string;
    tokenRevision: number;
    status: 'available' | 'expired' | 'missing';
  }) => void) | undefined;
  return {
    resolveAuthHeaders: vi.fn(() => new Promise<Record<string, string>>((resolve) => {
      release = resolve;
    })),
    release: (headers: Record<string, string> = {}) => release(headers),
    onOAuthCredentialChange: vi.fn((listener: typeof credentialListener) => {
      credentialListener = listener;
      return () => { credentialListener = undefined; };
    }),
    emitCredentialChange: (change: Parameters<NonNullable<typeof credentialListener>>[0]) => {
      credentialListener?.(change);
    },
  };
});

vi.mock('../mcp-oauth', () => ({
  resolveAuthHeaders: oauth.resolveAuthHeaders,
  onOAuthCredentialChange: oauth.onOAuthCredentialChange,
}));

import {
  ensureSdkMcpInSync,
  initializeAgent,
} from '../agent-session';
import { NO_CHANNEL_DELIVERY } from '../session-core/channel-delivery';
import {
  getQueryMcpMutation,
  getQueryMcpPrewarmOwner,
  resetLifecycleForTest,
  setQueryMcpPrewarmOwner,
  setQuerySession,
} from '../builtin-session/lifecycle';
import {
  resetConfigForTest,
  setCurrentMcpServers,
  setFrozenSdkMcpFingerprint,
  snapshotConfig,
} from '../builtin-session/config';
import {
  beginPromotedItem,
  resetQueueForTest,
} from '../builtin-session/queue';

describe('live Query MCP mutation/promotion ordering', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetLifecycleForTest();
    resetQueueForTest();
    resetConfigForTest();
    await initializeAgent('/tmp/myagents-mcp-live-mutation-interleaving', null, undefined, {
      preWarmDisabled: true,
    });
  });

  it('publishes the mutation owner before async map build so later promotion is rejected', async () => {
    const setMcpServers = vi.fn();
    const query = {
      setMcpServers,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('old');
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'old',
      requiredServerIds: ['old'],
    });
    setCurrentMcpServers([{
      id: 'delayed-http',
      name: 'delayed-http',
      isBuiltin: false,
      type: 'http',
      url: 'https://example.com/mcp',
      command: '',
      args: [],
    }]);

    const synchronization = ensureSdkMcpInSync();
    await vi.waitFor(() => {
      expect(oauth.resolveAuthHeaders).toHaveBeenCalledOnce();
      expect(getQueryMcpMutation()).not.toBeNull();
    });

    beginPromotedItem({
      id: 'promotion-after-mutation-claim',
      message: { role: 'user', content: [{ type: 'text', text: 'run task' }] },
      messageText: 'run task',
      wasQueued: false,
      resolve: () => undefined,
      channelDelivery: NO_CHANNEL_DELIVERY,
    });
    oauth.release();

    await expect(getQueryMcpMutation()!.promise).resolves.toMatchObject({
      ok: false,
      reason: 'deferred',
    });
    await expect(synchronization).resolves.toBe(false);

    expect(setMcpServers).not.toHaveBeenCalled();
    expect(getQueryMcpPrewarmOwner()).toBeNull();
    expect(snapshotConfig().deferredRestartReasons).toContain('mcp');
  });

  it('ignores disabled-server revision events but reads the latest credential when later enabled', async () => {
    const setMcpServers = vi.fn(async () => ({
      added: ['later-enabled'],
      removed: [],
      errors: {},
    }));
    const query = {
      setMcpServers,
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    } as never;
    setQuerySession(query);
    setFrozenSdkMcpFingerprint('old');
    setQueryMcpPrewarmOwner({
      query,
      fingerprint: 'old',
      requiredServerIds: ['old'],
    });

    oauth.emitCredentialChange({
      serverId: 'later-enabled',
      tokenRevision: 2,
      status: 'available',
    });
    expect(snapshotConfig().deferredRestartReasons).toEqual([]);

    setCurrentMcpServers([{
      id: 'later-enabled',
      name: 'later-enabled',
      isBuiltin: false,
      type: 'http',
      url: 'https://example.com/mcp',
      command: '',
      args: [],
    }]);
    const synchronization = ensureSdkMcpInSync();
    await vi.waitFor(() => expect(oauth.resolveAuthHeaders).toHaveBeenCalledOnce());
    oauth.release({ Authorization: 'Bearer latest-persisted-token' });
    await expect(synchronization).resolves.toBe(true);

    expect(setMcpServers).toHaveBeenCalledWith({
      'later-enabled': expect.objectContaining({
        headers: { Authorization: 'Bearer latest-persisted-token' },
      }),
    });
  });

  it('drops an unregistered remote MCP before credential or transport resolution for Xiaojing', async () => {
    const previous = process.env.XIAOJING_MAIN_AGENT;
    process.env.XIAOJING_MAIN_AGENT = '1';
    try {
      const setMcpServers = vi.fn(async () => ({ added: [], removed: ['old'], errors: {} }));
      const query = {
        setMcpServers,
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(),
      } as never;
      setQuerySession(query);
      setFrozenSdkMcpFingerprint('old');
      setQueryMcpPrewarmOwner({ query, fingerprint: 'old', requiredServerIds: ['old'] });
      setCurrentMcpServers([{
        id: 'unregistered-remote',
        name: 'unregistered-remote',
        isBuiltin: false,
        type: 'http',
        url: 'https://example.com/mcp',
        command: '',
        args: [],
      }]);

      await expect(ensureSdkMcpInSync()).resolves.toBe(true);
      expect(oauth.resolveAuthHeaders).not.toHaveBeenCalled();
      expect(setMcpServers).toHaveBeenCalledWith({
        'xiaojing-geo': expect.objectContaining({
          name: 'xiaojing-geo',
          type: 'sdk',
        }),
      });
    } finally {
      if (previous === undefined) delete process.env.XIAOJING_MAIN_AGENT;
      else process.env.XIAOJING_MAIN_AGENT = previous;
    }
  });
});
