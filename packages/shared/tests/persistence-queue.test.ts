/**
 * Tests for SessionPersistenceQueue in sessions/persistence-queue.ts
 *
 * Key behavior: Writes to the same session must be serialized to prevent
 * race conditions when rapid successive flushes write to the same .tmp file.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionPersistenceQueue } from "../src/sessions/persistence-queue.ts";
import { loadSession } from "../src/sessions/storage.ts";
import { createTestSession } from "./testing/persistence-queue-fixture.ts";

describe('SessionPersistenceQueue', () => {
  let testDir: string;

  let queue: SessionPersistenceQueue;

  beforeEach(() => {
    // Create a unique test directory
    testDir = join(tmpdir(), `persistence-queue-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // Create sessions subdirectory structure
    mkdirSync(join(testDir, 'sessions', 'test-session'), { recursive: true });
    // Use 0ms debounce for immediate writes in tests
    queue = new SessionPersistenceQueue(0);
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('writes session to disk', async () => {
    const session = createTestSession('test-session', testDir, 'sdk-123');
    queue.enqueue(session);
    await queue.flush('test-session');

    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    const header = JSON.parse(content.split('\n')[0]!);
    expect(header.sdkSessionId).toBe('sdk-123');
  });

  it('serializes concurrent flushes for the same session', async () => {
    // This test verifies the fix for the race condition where
    // clearSessionForRecovery() + onSdkSessionIdUpdate() would
    // both flush rapidly and corrupt each other's writes.

    // Simulate the problematic sequence:
    // 1. First write with sdkSessionId = undefined (clearing)
    const session1 = createTestSession('test-session', testDir, undefined);
    queue.enqueue(session1);
    const flush1 = queue.flush('test-session');

    // 2. Second write with new sdkSessionId (before first completes)
    const session2 = createTestSession('test-session', testDir, 'new-thread-id');
    queue.enqueue(session2);
    const flush2 = queue.flush('test-session');

    // Wait for both to complete
    await Promise.all([flush1, flush2]);

    // The final file should have the NEWER data (new-thread-id)
    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    const content = readFileSync(filePath, 'utf-8');
    const header = JSON.parse(content.split('\n')[0]!);

    // Before the fix, this could randomly be undefined due to race condition
    expect(header.sdkSessionId).toBe('new-thread-id');
  });

  it('serializes a debounce-timer write with an explicit flush', async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>(resolve => { releaseFirstWrite = resolve; });
    let notifyFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>(resolve => { notifyFirstWriteStarted = resolve; });
    let writeStarts = 0;

    queue = new SessionPersistenceQueue(0, {
      beforeWrite: async () => {
        writeStarts += 1;
        if (writeStarts === 1) {
          notifyFirstWriteStarted();
          await firstWriteGate;
        }
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'timer-write'));
    await firstWriteStarted;

    queue.enqueue(createTestSession('test-session', testDir, 'flushed-write'));
    const flush = queue.flush('test-session');
    await Bun.sleep(10);
    expect(writeStarts).toBe(1);

    releaseFirstWrite();
    await flush;

    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]!);
    expect(writeStarts).toBe(2);
    expect(header.sdkSessionId).toBe('flushed-write');
  });

  it('keeps an active temp file intact while session storage reads the primary', async () => {
    queue.enqueue(createTestSession('test-session', testDir, 'initial'));
    await queue.flush('test-session');

    let releaseTempWrite!: () => void;
    const tempWriteGate = new Promise<void>(resolve => { releaseTempWrite = resolve; });
    let notifyTempWritten!: () => void;
    const tempWritten = new Promise<void>(resolve => { notifyTempWritten = resolve; });

    queue = new SessionPersistenceQueue(0, {
      afterTempWrite: async () => {
        notifyTempWritten();
        await tempWriteGate;
      },
    });

    queue.enqueue(createTestSession('test-session', testDir, 'updated'));
    const flush = queue.flush('test-session');
    await tempWritten;

    const filePath = join(testDir, 'sessions', 'test-session', 'session.jsonl');
    expect(existsSync(`${filePath}.tmp`)).toBe(true);
    expect(loadSession(testDir, 'test-session')?.sdkSessionId).toBe('initial');
    expect(existsSync(`${filePath}.tmp`)).toBe(true);

    releaseTempWrite();
    await flush;

    const header = JSON.parse(readFileSync(filePath, 'utf-8').split('\n')[0]!);
    expect(header.sdkSessionId).toBe('updated');
  });

  it('allows parallel writes to different sessions', async () => {
    // Different sessions should write in parallel without blocking each other
    mkdirSync(join(testDir, 'sessions', 'session-a'), { recursive: true });
    mkdirSync(join(testDir, 'sessions', 'session-b'), { recursive: true });

    const sessionA = createTestSession('session-a', testDir, 'id-a');
    const sessionB = createTestSession('session-b', testDir, 'id-b');

    queue.enqueue(sessionA);
    queue.enqueue(sessionB);

    // Flush both in parallel
    await Promise.all([
      queue.flush('session-a'),
      queue.flush('session-b'),
    ]);

    // Both should be written correctly
    const contentA = readFileSync(
      join(testDir, 'sessions', 'session-a', 'session.jsonl'),
      'utf-8'
    );
    const contentB = readFileSync(
      join(testDir, 'sessions', 'session-b', 'session.jsonl'),
      'utf-8'
    );

    expect(JSON.parse(contentA.split('\n')[0]!).sdkSessionId).toBe('id-a');
    expect(JSON.parse(contentB.split('\n')[0]!).sdkSessionId).toBe('id-b');
  });

  it('bounds serialization and temp writes across sessions while flushAll waits for every rename', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let notifyTwoStarted!: () => void;
    const twoStarted = new Promise<void>(resolve => { notifyTwoStarted = resolve; });
    let starts = 0;
    queue = new SessionPersistenceQueue(500, { beforeWrite: async () => {
      starts++;
      if (starts === 2) notifyTwoStarted();
      await gate;
    } });
    const ids = Array.from({ length: 8 }, (_, i) => `bounded-${i}`);
    for (const id of ids) queue.enqueue(createTestSession(id, testDir, id));
    let finished = false;
    const flushed = queue.flushAll().then(() => { finished = true; });
    try {
      await twoStarted;
      await Bun.sleep(10);
      expect(starts).toBe(2);
      expect(finished).toBe(false);
    } finally {
      release();
      await flushed;
    }
    expect(starts).toBe(ids.length);
    expect(finished).toBe(true);
    for (const id of ids) {
      const file = join(testDir, 'sessions', id, 'session.jsonl');
      expect(JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!).sdkSessionId).toBe(id);
      expect(existsSync(`${file}.tmp`)).toBe(false);
    }
  });

  it('flushAll drains a new session identity enqueued while an earlier pass is active', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { notifyFirstStarted = resolve; });
    queue = new SessionPersistenceQueue(60_000, { beforeWrite: async id => {
      if (id !== 'first') return;
      notifyFirstStarted();
      await firstGate;
    } });

    queue.enqueue(createTestSession('first', testDir, 'first-value'));
    const flushed = queue.flushAll();
    await firstStarted;
    queue.enqueue(createTestSession('arrived-during-flush', testDir, 'late-value'));
    releaseFirst();
    await flushed;

    expect(queue.pendingCount).toBe(0);
    expect(loadSession(testDir, 'first')?.sdkSessionId).toBe('first-value');
    expect(loadSession(testDir, 'arrived-during-flush')?.sdkSessionId).toBe('late-value');
  });

  it('coalesces queued snapshots and honors cancellation while other sessions hold both slots', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let notifyTwoStarted!: () => void;
    const twoStarted = new Promise<void>(resolve => { notifyTwoStarted = resolve; });
    let starts = 0;
    queue = new SessionPersistenceQueue(500, { beforeWrite: async () => {
      starts++;
      if (starts === 2) notifyTwoStarted();
      await gate;
    } });
    for (const id of ['slot-a', 'slot-b', 'waiting', 'cancelled']) {
      queue.enqueue(createTestSession(id, testDir, 'old'));
    }
    const flushed = queue.flushAll();
    try {
      await twoStarted;
      expect(queue.hasPending('waiting')).toBe(true);
      queue.enqueue(createTestSession('waiting', testDir, 'newest'));
      queue.cancel('cancelled');
    } finally {
      release();
      await flushed;
    }
    const file = join(testDir, 'sessions', 'waiting', 'session.jsonl');
    expect(JSON.parse(readFileSync(file, 'utf-8').split('\n')[0]!).sdkSessionId).toBe('newest');
    expect(existsSync(join(testDir, 'sessions', 'cancelled', 'session.jsonl'))).toBe(false);
    expect(queue.pendingCount).toBe(0);
  });

  it('retires a session only after its active writer drains and rejects late snapshots', async () => {
    const sessionId = 'retiring';
    let releaseTempWrite!: () => void;
    const tempWriteGate = new Promise<void>(resolve => { releaseTempWrite = resolve; });
    let notifyTempWritten!: () => void;
    const tempWritten = new Promise<void>(resolve => { notifyTempWritten = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      afterTempWrite: async id => {
        if (id !== sessionId) return;
        notifyTempWritten();
        await tempWriteGate;
      },
    });

    queue.enqueue(createTestSession(sessionId, testDir, 'in-flight'));
    const flush = queue.flush(sessionId);
    await tempWritten;

    let retirementResolved = false;
    const retirement = queue.retire(sessionId).then(() => { retirementResolved = true; });
    await Bun.sleep(10);
    expect(queue.isRetired(sessionId)).toBe(true);
    expect(retirementResolved).toBe(false);
    expect(() => queue.enqueue(createTestSession(sessionId, testDir, 'late')))
      .toThrow(`Session persistence is retired: ${sessionId}`);

    releaseTempWrite();
    await Promise.all([flush, retirement]);
    expect(retirementResolved).toBe(true);

    queue.reactivate(sessionId);
    queue.enqueue(createTestSession(sessionId, testDir, 'restored-after-failed-delete'));
    await queue.flush(sessionId);
    expect(loadSession(testDir, sessionId)?.sdkSessionId).toBe('restored-after-failed-delete');

    await queue.retire(sessionId);

    const sessionDir = join(testDir, 'sessions', sessionId);
    rmSync(sessionDir, { recursive: true, force: true });
    await Bun.sleep(10);
    expect(existsSync(sessionDir)).toBe(false);
    expect(() => queue.enqueue(createTestSession(sessionId, testDir, 'after-delete')))
      .toThrow(`Session persistence is retired: ${sessionId}`);
    expect(() => queue.reactivate(sessionId))
      .toThrow(`Session directory for ${sessionId} was replaced`);
    expect(queue.isRetired(sessionId)).toBe(true);
  });

  it('keeps one tombstone when the first writer creates a previously missing workspace root', async () => {
    const sessionId = 'Fresh-Root-Session';
    const freshRoot = join(testDir, 'brand-new-workspace');
    let releaseTempWrite!: () => void;
    const tempWriteGate = new Promise<void>(resolve => { releaseTempWrite = resolve; });
    let notifyTempWritten!: () => void;
    const tempWritten = new Promise<void>(resolve => { notifyTempWritten = resolve; });
    queue = new SessionPersistenceQueue(60_000, {
      afterTempWrite: async id => {
        if (id !== sessionId) return;
        notifyTempWritten();
        await tempWriteGate;
      },
    });

    expect(existsSync(freshRoot)).toBe(false);
    queue.enqueue(createTestSession(sessionId, freshRoot, 'in-flight'));
    const flush = queue.flush(sessionId, freshRoot);
    await tempWritten;

    let retirementResolved = false;
    const retirement = queue.retire(sessionId, freshRoot).then(() => { retirementResolved = true; });
    try {
      // A mismatched identity returns after one internal microtask; two turns
      // prove that retirement is instead waiting on the blocked writer.
      await Promise.resolve();
      await Promise.resolve();
      expect(retirementResolved).toBe(false);
      expect(queue.isRetired(sessionId, freshRoot)).toBe(true);
    } finally {
      releaseTempWrite();
      await Promise.all([flush, retirement]);
    }

    const volumeIsCaseInsensitive = existsSync(join(freshRoot, 'SESSIONS'));
    rmSync(freshRoot, { recursive: true, force: true });
    const lateRoot = volumeIsCaseInsensitive ? join(testDir, 'BRAND-NEW-WORKSPACE') : freshRoot;
    const lateSessionId = volumeIsCaseInsensitive ? sessionId.toLowerCase() : sessionId;
    expect(() => queue.enqueue(createTestSession(lateSessionId, lateRoot, 'late-after-delete')))
      .toThrow(`Session persistence is retired: ${lateSessionId}`);
    expect(existsSync(freshRoot)).toBe(false);
    expect(existsSync(lateRoot)).toBe(false);
  });

  it('keeps ordinary cancellation reusable for metadata reconciliation', async () => {
    const sessionId = 'cancel-reuse';
    queue = new SessionPersistenceQueue(60_000);
    queue.enqueue(createTestSession(sessionId, testDir, 'stale'));
    queue.cancel(sessionId);
    expect(queue.isRetired(sessionId)).toBe(false);

    queue.enqueue(createTestSession(sessionId, testDir, 'fresh'));
    await queue.flush(sessionId);
    expect(loadSession(testDir, sessionId)?.sdkSessionId).toBe('fresh');
  });

  it('isolates identical session IDs across workspace roots', async () => {
    const sessionId = 'same-id';
    const rootA = join(testDir, 'workspace-a');
    const rootB = join(testDir, 'workspace-b');
    queue = new SessionPersistenceQueue(60_000);
    queue.enqueue(createTestSession(sessionId, rootA, 'root-a'));
    queue.enqueue(createTestSession(sessionId, rootB, 'root-b'));

    await Promise.all([
      queue.flush(sessionId, rootA),
      queue.flush(sessionId, rootB),
    ]);
    expect(loadSession(rootA, sessionId)?.sdkSessionId).toBe('root-a');
    expect(loadSession(rootB, sessionId)?.sdkSessionId).toBe('root-b');
    await expect(queue.flush(sessionId)).rejects
      .toThrow(`Ambiguous session persistence identity; workspace root is required: ${sessionId}`);

    await queue.retire(sessionId, rootA);
    expect(queue.isRetired(sessionId, rootA)).toBe(true);
    expect(queue.isRetired(sessionId, rootB)).toBe(false);
    expect(() => queue.enqueue(createTestSession(sessionId, rootA, 'late-a')))
      .toThrow(`Session persistence is retired: ${sessionId}`);

    queue.enqueue(createTestSession(sessionId, rootB, 'new-root-b'));
    await queue.flush(sessionId, rootB);
    expect(loadSession(rootB, sessionId)?.sdkSessionId).toBe('new-root-b');
  });

  it('does not merge distinct canonical roots that differ only by case when session names fold', async () => {
    const sessionId = 'same-case-folded-id';
    const rootUpper = join(testDir, 'CaseDistinctRoot');
    const rootLower = join(testDir, 'casedistinctroot');
    mkdirSync(rootUpper, { recursive: true });
    mkdirSync(rootLower, { recursive: true });

    // A globally case-insensitive volume cannot host the adversarial topology.
    // Linux filesystems with per-directory case folding can, and exercise this
    // branch in CI; ordinary macOS behavior is covered by the alias tests below.
    if (realpathSync.native(rootUpper) === realpathSync.native(rootLower)) return;

    queue = new SessionPersistenceQueue(60_000, {
      caseInsensitiveWorkspaceRoot: () => true,
    });
    queue.enqueue(createTestSession(sessionId, rootUpper, 'upper-root'));
    queue.enqueue(createTestSession(sessionId, rootLower, 'lower-root'));

    await Promise.all([
      queue.flush(sessionId.toUpperCase(), rootUpper),
      queue.flush(sessionId.toUpperCase(), rootLower),
    ]);
    expect(loadSession(rootUpper, sessionId)?.sdkSessionId).toBe('upper-root');
    expect(loadSession(rootLower, sessionId)?.sdkSessionId).toBe('lower-root');
    await expect(queue.flush(sessionId)).rejects
      .toThrow(`Ambiguous session persistence identity; workspace root is required: ${sessionId}`);
  });
});
