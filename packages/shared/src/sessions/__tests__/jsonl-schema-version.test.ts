import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnsupportedSessionHeaderVersionError,
  readSessionHeader,
  readSessionHeaderAsync,
  readSessionJsonl,
  writeSessionJsonl,
} from '../jsonl.ts';
import type { StoredSession } from '../types.ts';

const roots: string[] = [];

function sessionFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'session-header-schema-'));
  roots.push(root);
  return join(root, 'session.jsonl');
}

function legacyHeader() {
  return {
    id: 'session-1',
    workspaceRootPath: '/tmp/workspace',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
  };
}

function emptyTokenUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session JSONL schema envelope', () => {
  it('lazily migrates a legacy unversioned header in memory', () => {
    const path = sessionFile();
    writeFileSync(path, `${JSON.stringify(legacyHeader())}\n`);

    expect(readSessionHeader(path)).toMatchObject({
      schemaVersion: 1,
      id: 'session-1',
      tokenUsage: emptyTokenUsage(),
    });
    expect(readSessionJsonl(path)).toMatchObject({
      id: 'session-1',
      messages: [],
      tokenUsage: emptyTokenUsage(),
    });
    // Lazy migration is rollback-safe: disk changes only on the next ordinary save.
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBeUndefined();
  });

  it('rejects a future header without rewriting it', () => {
    const path = sessionFile();
    writeFileSync(path, `${JSON.stringify({ ...legacyHeader(), schemaVersion: 2 })}\n`);

    expect(() => readSessionHeader(path)).toThrow(UnsupportedSessionHeaderVersionError);
    expect(() => readSessionJsonl(path)).toThrow(UnsupportedSessionHeaderVersionError);
    expect(JSON.parse(readFileSync(path, 'utf8')).schemaVersion).toBe(2);
  });

  it('rejects a future header at the direct write boundary without rewriting it', () => {
    const path = sessionFile();
    const future = `${JSON.stringify({ ...legacyHeader(), schemaVersion: 2 })}\n`;
    writeFileSync(path, future);
    const session: StoredSession = {
      id: 'session-1',
      workspaceRootPath: '/tmp/workspace',
      createdAt: 1,
      lastUsedAt: 2,
      messages: [],
      tokenUsage: emptyTokenUsage(),
    };

    expect(() => writeSessionJsonl(path, session)).toThrow(UnsupportedSessionHeaderVersionError);
    expect(readFileSync(path, 'utf8')).toBe(future);
  });

  it('keeps the async reader compatible with large headers and future-version rejection', async () => {
    const path = sessionFile();
    writeFileSync(path, `${JSON.stringify({ ...legacyHeader(), name: 'x'.repeat(16_384) })}\n`);
    expect(await readSessionHeaderAsync(path)).toMatchObject({ schemaVersion: 1, id: 'session-1' });

    const future = `${JSON.stringify({ ...legacyHeader(), schemaVersion: 2 })}\n`;
    writeFileSync(path, future);
    await expect(readSessionHeaderAsync(path)).rejects.toBeInstanceOf(UnsupportedSessionHeaderVersionError);
    expect(readFileSync(path, 'utf8')).toBe(future);
  });

  it('emits schema version 1 on every atomic session write', () => {
    const path = sessionFile();
    const session: StoredSession = {
      id: 'session-1',
      workspaceRootPath: '/tmp/workspace',
      createdAt: 1,
      lastUsedAt: 2,
      messages: [],
      tokenUsage: emptyTokenUsage(),
    };
    writeSessionJsonl(path, session);

    expect(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]!)).toMatchObject({
      schemaVersion: 1,
      id: 'session-1',
    });
  });

  it('rejects a malformed new write without creating a session file', () => {
    const path = sessionFile();
    const invalidSession = {
      id: 'session-1',
      workspaceRootPath: '/tmp/workspace',
      createdAt: 1,
      lastUsedAt: 2,
      messages: [],
    } as unknown as StoredSession;

    expect(() => writeSessionJsonl(path, invalidSession)).toThrow(/tokenUsage/);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});
