import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSession, loadSession, saveSession, unarchiveSession, updateSessionMetadata } from '../storage.ts';
import type { StoredSession } from '../types.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('clears only the requested metadata and persists the clear across reload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robb-metadata-clear-'));
  roots.push(root);
  const session: StoredSession = {
    id: 'metadata-clear', workspaceRootPath: root, createdAt: 1, lastUsedAt: 1,
    name: 'Preserved title', messages: [], lastReadMessageId: 'old-read-marker',
    sharedUrl: 'https://example.test/shared', sharedId: 'old-share',
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  };
  await saveSession(session, root);
  await updateSessionMetadata(root, session.id, { hasUnread: true, lastReadMessageId: undefined });
  const unread = loadSession(root, session.id);
  expect(unread?.hasUnread).toBe(true);
  expect(unread?.lastReadMessageId).toBeUndefined();
  expect(unread?.sharedId).toBe('old-share');
  await updateSessionMetadata(root, session.id, { sharedId: undefined, sharedUrl: undefined });
  const revoked = loadSession(root, session.id);
  expect(revoked?.sharedId).toBeUndefined();
  expect(revoked?.sharedUrl).toBeUndefined();
  expect(revoked?.name).toBe('Preserved title');
  expect(revoked?.hasUnread).toBe(true);
});


it('removes the archive timestamp when reopening a session without changing its content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'robb-unarchive-clear-'));
  roots.push(root);
  const session: StoredSession = {
    id: 'unarchive-clear', workspaceRootPath: root, createdAt: 1, lastUsedAt: 1,
    name: 'Preserved title', messages: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  };
  await saveSession(session, root);
  await archiveSession(root, session.id);
  const archived = loadSession(root, session.id);
  expect(archived?.isArchived).toBe(true);
  expect(archived?.archivedAt).toBeNumber();
  await unarchiveSession(root, session.id);
  const reopened = loadSession(root, session.id);
  expect(reopened?.isArchived).toBe(false);
  expect(reopened?.archivedAt).toBeUndefined();
  expect(reopened?.name).toBe(session.name);
  expect(reopened?.messages).toEqual(session.messages);
});
