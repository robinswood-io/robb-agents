import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PERMISSION_REQUEST_TTL_SECONDS,
  MAX_PERMISSION_REQUEST_TTL_SECONDS,
  MIN_PERMISSION_REQUEST_TTL_SECONDS,
  pendingPermissionCanReplay,
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
});
