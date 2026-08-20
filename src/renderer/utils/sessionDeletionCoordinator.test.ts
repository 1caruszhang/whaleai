import { describe, expect, it, vi } from 'vitest';

import type { SessionDeleteResult } from '@/api/tauriClient';
import type { Tab } from '@/types/tab';
import { deleteSessionThroughAppOwner } from './sessionDeletionCoordinator';

function chatTab(id: string, sessionId: string): Tab {
    return { id, sessionId, view: 'chat' } as Tab;
}

function input(overrides: Partial<Parameters<typeof deleteSessionThroughAppOwner>[0]> = {}) {
    return {
        sessionId: 'session-1',
        getTabs: () => [] as readonly Tab[],
        terminateTabsForSession: vi.fn(),
        hasPersistentOwners: vi.fn(async () => ({ hasPersistentOwners: false })),
        handoffMountedSessionActivity: vi.fn(async () => ({ started: false, sessionId: 'session-1' })),
        stopSseProxy: vi.fn(async () => undefined),
        deletePersistedSession: vi.fn(async () => ({ deleted: true }) as SessionDeleteResult),
        ...overrides,
    };
}

describe('deleteSessionThroughAppOwner', () => {
    it.each(['busy-replying', 'monitor-active'] as const)(
        'routes the persistent-owner preflight refusal as %s',
        async (reason) => {
            const args = input({
                hasPersistentOwners: vi.fn(async () => ({ hasPersistentOwners: true, reason })),
            });

            await expect(deleteSessionThroughAppOwner(args)).resolves.toEqual({
                deleted: false,
                reason,
            });
            expect(args.handoffMountedSessionActivity).not.toHaveBeenCalled();
            expect(args.deletePersistedSession).not.toHaveBeenCalled();
            expect(args.terminateTabsForSession).not.toHaveBeenCalled();
        },
    );

    it('falls back to in-use when the preflight carries no reason', async () => {
        const args = input({
            hasPersistentOwners: vi.fn(async () => ({ hasPersistentOwners: true })),
        });

        await expect(deleteSessionThroughAppOwner(args)).resolves.toEqual({
            deleted: false,
            reason: 'in-use',
        });
    });

    it('reports a mounted busy turn as busy-replying', async () => {
        const args = input({
            getTabs: () => [chatTab('tab-1', 'session-1')],
            handoffMountedSessionActivity: vi.fn(async () => ({ started: true, sessionId: 'session-1' })),
        });

        await expect(deleteSessionThroughAppOwner(args)).resolves.toEqual({
            deleted: false,
            reason: 'busy-replying',
        });
        expect(args.deletePersistedSession).not.toHaveBeenCalled();
        expect(args.terminateTabsForSession).not.toHaveBeenCalled();
    });

    it('preserves the fenced Rust refusal reason verbatim', async () => {
        const args = input({
            deletePersistedSession: vi.fn(async () => (
                { deleted: false, reason: 'monitor-active' } as SessionDeleteResult
            )),
        });

        await expect(deleteSessionThroughAppOwner(args)).resolves.toEqual({
            deleted: false,
            reason: 'monitor-active',
        });
        expect(args.terminateTabsForSession).not.toHaveBeenCalled();
    });

    it('deletes an idle session without mounted tabs', async () => {
        const args = input();

        await expect(deleteSessionThroughAppOwner(args)).resolves.toEqual({ deleted: true });
        expect(args.deletePersistedSession).toHaveBeenCalledWith('session-1', []);
        expect(args.terminateTabsForSession).not.toHaveBeenCalled();
    });
});
