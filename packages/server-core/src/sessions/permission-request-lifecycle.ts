export const DEFAULT_PERMISSION_REQUEST_TTL_SECONDS = 5 * 60;
export const MIN_PERMISSION_REQUEST_TTL_SECONDS = 10;
export const MAX_PERMISSION_REQUEST_TTL_SECONDS = 60 * 60;
/** Lets the permission TTL callback deny and persist its terminal handoff before
 * the automatic-recovery inactivity watchdog tears down the same turn. */
export const PERMISSION_EXPIRY_WATCHDOG_GRACE_MS = 1_000;

export function resolvePermissionRequestTtlMs(requestedSeconds?: number): number {
  const seconds = Number.isFinite(requestedSeconds)
    ? Math.floor(requestedSeconds as number)
    : DEFAULT_PERMISSION_REQUEST_TTL_SECONDS;
  return Math.min(
    Math.max(seconds, MIN_PERMISSION_REQUEST_TTL_SECONDS),
    MAX_PERMISSION_REQUEST_TTL_SECONDS,
  ) * 1000;
}

export function pendingPermissionCanReplay(
  requestedAt: number,
  expiresAt: number,
  nowMs = Date.now(),
): boolean {
  return requestedAt <= nowMs && nowMs < expiresAt;
}

export function pendingPermissionWatchdogRemainingMs(
  expiresAt: number,
  nowMs = Date.now(),
): number {
  return expiresAt + PERMISSION_EXPIRY_WATCHDOG_GRACE_MS - nowMs;
}
