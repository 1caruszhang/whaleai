import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  deleteSessionIfUnowned: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../tauriClient', () => ({
  deleteSessionIfUnowned: mocks.deleteSessionIfUnowned,
}));

import { createSession, deleteSession, updateSession } from '../sessionClient';

describe('Session persistence client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(true);
    mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: true });
  });

  it('creates and renames metadata through the Rust owner', async () => {
    const metadata = {
      id: 'session-1',
      workspacePath: '/brand/a',
      title: 'Brand A',
      createdAt: '2026-08-16T00:00:00Z',
      lastActiveAt: '2026-08-16T00:00:00Z',
    };
    mocks.invoke.mockResolvedValueOnce(metadata).mockResolvedValueOnce(true);

    await expect(createSession('/brand/a', 'Brand A')).resolves.toEqual(metadata);
    await expect(updateSession('session-1', { title: 'Renamed' })).resolves.toEqual(
      expect.objectContaining({ id: 'session-1', title: 'Renamed' }),
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'cmd_create_session_metadata', {
      workspacePath: '/brand/a',
      title: 'Brand A',
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'cmd_update_session_title', {
      sessionId: 'session-1',
      title: 'Renamed',
    });
  });

  it('delegates deletion to the fenced Rust owner boundary', async () => {
    await expect(deleteSession('session-1', ['tab-a'])).resolves.toEqual({ deleted: true });
    expect(mocks.deleteSessionIfUnowned).toHaveBeenCalledWith('session-1', ['tab-a']);
  });

  it('carries brand confirmation into the same lifecycle fence', async () => {
    const admission = { workspaceId: 'brand-a', confirmationToken: 'confirmed-token' };
    await expect(deleteSession('session-1', ['tab-a'], admission)).resolves.toEqual({ deleted: true });
    expect(mocks.deleteSessionIfUnowned).toHaveBeenCalledWith('session-1', ['tab-a'], admission);
  });

  it.each(['in-use', 'authority-unavailable', 'not-found'] as const)(
    'preserves the %s refusal reason',
    async (reason) => {
      mocks.deleteSessionIfUnowned.mockResolvedValue({ deleted: false, reason });
      await expect(deleteSession('session-1')).resolves.toEqual({ deleted: false, reason });
    },
  );

  it('maps invocation failure to an unexpected refusal', async () => {
    mocks.deleteSessionIfUnowned.mockRejectedValue(new Error('unavailable'));
    await expect(deleteSession('session-1')).resolves.toEqual({
      deleted: false,
      reason: 'unexpected',
    });
  });
});
