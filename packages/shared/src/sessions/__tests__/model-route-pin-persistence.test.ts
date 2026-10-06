import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, loadSession } from '../storage.ts';
import { SESSION_PERSISTENT_FIELDS } from '../types.ts';
import { pickSessionFields } from '../utils.ts';

describe('session persistence: explicit route provenance', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('persists both model and reasoning pin state', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('modelRoutePinned');
    expect(SESSION_PERSISTENT_FIELDS).toContain('connectionRoutePinned');
    expect(SESSION_PERSISTENT_FIELDS).toContain('thinkingLevelPinned');
    expect(pickSessionFields({ id: 'pinned', modelRoutePinned: true }).modelRoutePinned).toBe(true);
    expect(pickSessionFields({ id: 'automatic', modelRoutePinned: false }).modelRoutePinned).toBe(false);
    expect(pickSessionFields({ id: 'connection', connectionRoutePinned: true }).connectionRoutePinned).toBe(true);
    expect(pickSessionFields({ id: 'thinking', thinkingLevelPinned: true }).thinkingLevelPinned).toBe(true);
    expect(pickSessionFields({ id: 'adaptive', thinkingLevelPinned: false }).thinkingLevelPinned).toBe(false);
  });

  it('round-trips an explicit connection and reasoning pin before the first message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-route-pin-'));
    roots.push(root);
    const created = await createSession(root, {
      llmConnection: 'explicit-connection',
      connectionRoutePinned: true,
      thinkingLevel: 'xhigh',
      thinkingLevelPinned: true,
    });

    expect(loadSession(root, created.id)).toMatchObject({
      llmConnection: 'explicit-connection',
      connectionRoutePinned: true,
      thinkingLevel: 'xhigh',
      thinkingLevelPinned: true,
    });
  });
});
