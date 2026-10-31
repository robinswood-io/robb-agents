import type { SessionRuntimeState } from '../SessionManager/runtime-state.ts';

type PendingPermission = Parameters<SessionRuntimeState['pendingPermissionRequests']['set']>[1];

/** A complete inert record for tests that exercise permission cleanup. */
export function permissionMetadataFixture(
  sessionId: string,
  overrides: Partial<PendingPermission> = {},
): PendingPermission {
  const timeout = setTimeout(() => {}, 0);
  clearTimeout(timeout);
  return {
    sessionId,
    processingGeneration: 0,
    requestedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    request: { requestId: 'fixture', sessionId, toolName: 'Bash', description: 'Offline permission fixture' },
    timeout,
    ...overrides,
  };
}
