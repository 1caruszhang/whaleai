export const PENDING_SESSION_PREFIX = 'pending-';

/** Check if a sessionId is a pending (placeholder) session */
export function isPendingSessionId(sessionId: string | null | undefined): boolean {
    return sessionId?.startsWith(PENDING_SESSION_PREFIX) ?? false;
}
