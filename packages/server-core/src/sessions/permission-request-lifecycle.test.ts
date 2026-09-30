import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PERMISSION_REQUEST_TTL_SECONDS,
  MAX_PERMISSION_REQUEST_TTL_SECONDS,
  MIN_PERMISSION_REQUEST_TTL_SECONDS,
  PERMISSION_EXPIRY_WATCHDOG_GRACE_MS,
  pendingPermissionCanReplay,
  pendingPermissionWatchdogRemainingMs,
  resolvePermissionRequestTtlMs,
} from './permission-request-lifecycle.ts';

describe('permission request lifecycle', () => {
  it('uses a bounded default TTL', () => {
    expect(resolvePermissionRequestTtlMs()).toBe(DEFAULT_PERMISSION_REQUEST_TTL_SECONDS * 1000);
    expect(resolvePermissionRequestTtlMs(1)).toBe(MIN_PERMISSION_REQUEST_TTL_SECONDS * 1000);
    expect(resolvePermissionRequestTtlMs(99_999)).toBe(MAX_PERMISSION_REQUEST_TTL_SECONDS * 1000);
  });

  it('replays only live requests', () => {
    expect(pendingPermissionCanReplay(100, 300, 200)).toBe(true);
    expect(pendingPermissionCanReplay(100, 300, 300)).toBe(false);
    expect(pendingPermissionCanReplay(250, 300, 200)).toBe(false);
  });

  it('keeps the watchdog behind the permission expiry callback by a bounded grace', () => {
    expect(pendingPermissionWatchdogRemainingMs(300, 100)).toBe(
      200 + PERMISSION_EXPIRY_WATCHDOG_GRACE_MS,
    );
    expect(pendingPermissionWatchdogRemainingMs(300, 300 + PERMISSION_EXPIRY_WATCHDOG_GRACE_MS)).toBe(0);
  });
});
