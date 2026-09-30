export const DEFAULT_PERMISSION_REQUEST_TTL_SECONDS = 5 * 60;
export const MIN_PERMISSION_REQUEST_TTL_SECONDS = 10;
export const MAX_PERMISSION_REQUEST_TTL_SECONDS = 60 * 60;

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
