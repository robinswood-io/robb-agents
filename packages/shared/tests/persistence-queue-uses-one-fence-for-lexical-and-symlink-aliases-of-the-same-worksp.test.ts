/**
 * Tests for SessionPersistenceQueue in sessions/persistence-queue.ts
 *
 * Key behavior: Writes to the same session must be serialized to prevent
 * race conditions when rapid successive flushes write to the same .tmp file.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { captureSessionPersistenceRootIdentity, captureSessionPersistenceRootPath, SessionPersistenceQueue } from "../src/sessions/persistence-queue.ts";
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

  it('uses one fence for lexical and symlink aliases of the same workspace root', async () => {
    const sessionId = 'aliased-root';
    const root = join(testDir, 'canonical-workspace');
    const symlink = join(testDir, 'workspace-symlink');
    mkdirSync(root, { recursive: true });
    const filesystemAlias = process.platform === 'win32' ? join(root, '.') : symlink;
    if (process.platform !== 'win32') symlinkSync(root, symlink, 'dir');
    queue = new SessionPersistenceQueue(60_000);

    queue.enqueue(createTestSession(sessionId, filesystemAlias, 'pending-through-alias'));
    await queue.retire(sessionId, join(root, '.'));

    expect(queue.isRetired(sessionId, root)).toBe(true);
    expect(queue.isRetired(sessionId, filesystemAlias)).toBe(true);
    expect(queue.hasPending(sessionId, root)).toBe(false);
    expect(() => queue.enqueue(createTestSession(sessionId, root, 'late-through-real-path')))
      .toThrow(`Session persistence is retired: ${sessionId}`);

    queue.reactivate(sessionId, filesystemAlias);
    queue.enqueue(createTestSession(sessionId, root, 'restored'));
    await queue.flush(sessionId, join(root, '.'));
    expect(loadSession(root, sessionId)?.sdkSessionId).toBe('restored');
  });

  it('separates queued writes when a workspace symlink is retargeted', async () => {
    if (process.platform === 'win32') return;

    const sessionId = 'retargeted-workspace';
    const rootA = join(testDir, 'retarget-a');
    const rootB = join(testDir, 'retarget-b');
    const alias = join(testDir, 'retarget-alias');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    symlinkSync(rootA, alias, 'dir');
    queue = new SessionPersistenceQueue(60_000);

    queue.enqueue(createTestSession(sessionId, alias, 'target-a'));
    unlinkSync(alias);
    symlinkSync(rootB, alias, 'dir');
    queue.enqueue(createTestSession(sessionId, alias, 'target-b'));

    await Promise.all([
      queue.flush(sessionId, rootA),
      queue.flush(sessionId, alias),
    ]);
    expect(loadSession(rootA, sessionId)?.sdkSessionId).toBe('target-a');
    expect(loadSession(rootB, sessionId)?.sdkSessionId).toBe('target-b');
  });

  it('keeps an explicitly captured session identity on the original symlink target', async () => {
    if (process.platform === 'win32') return;

    const sessionId = 'captured-retargeted-workspace';
    const rootA = join(testDir, 'captured-retarget-a');
    const rootB = join(testDir, 'captured-retarget-b');
    const alias = join(testDir, 'captured-retarget-alias');
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    symlinkSync(rootA, alias, 'dir');
    queue = new SessionPersistenceQueue(60_000);

    const persistenceRootPath = captureSessionPersistenceRootPath(alias);
    expect(persistenceRootPath).toBe(realpathSync.native(rootA));
    queue.enqueue(
      createTestSession(sessionId, alias, 'target-a-pending'),
      persistenceRootPath,
    );

    unlinkSync(alias);
    symlinkSync(rootB, alias, 'dir');

    expect(queue.hasPending(sessionId, persistenceRootPath)).toBe(true);
    expect(queue.hasPending(sessionId, alias)).toBe(false);
    await queue.retire(sessionId, persistenceRootPath);

    expect(queue.hasPending(sessionId, persistenceRootPath)).toBe(false);
    expect(queue.isRetired(sessionId, persistenceRootPath)).toBe(true);
    expect(queue.isRetired(sessionId, alias)).toBe(false);
    expect(loadSession(rootA, sessionId)).toBeNull();
    expect(loadSession(rootB, sessionId)).toBeNull();
  });

  it('rejects a retargeted sessions container before writing outside the workspace', () => {
    if (process.platform === 'win32') return;

    const workspace = join(testDir, 'sessions-container-workspace');
    const outside = join(testDir, 'sessions-container-outside');
    mkdirSync(join(workspace, 'sessions'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    const identity = captureSessionPersistenceRootIdentity(workspace);
    rmSync(join(workspace, 'sessions'), { recursive: true });
    symlinkSync(outside, join(workspace, 'sessions'), 'dir');

    queue = new SessionPersistenceQueue(60_000);
    expect(() => queue.enqueue(
      createTestSession('container-redirect', workspace, 'must-not-leak'),
      identity.workspaceRootPath,
      identity,
    )).toThrow('Session persistence directory');
    expect(existsSync(join(outside, 'container-redirect', 'session.jsonl'))).toBe(false);
  });

  it('rejects a session-directory symlink before writing its target', () => {
    if (process.platform === 'win32') return;

    const workspace = join(testDir, 'session-link-workspace');
    const outside = join(testDir, 'session-link-outside');
    const sessionId = 'session-link';
    mkdirSync(join(workspace, 'sessions'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(workspace, 'sessions', sessionId), 'dir');
    const identity = captureSessionPersistenceRootIdentity(workspace);

    queue = new SessionPersistenceQueue(60_000);
    expect(() => queue.enqueue(
      createTestSession(sessionId, workspace, 'must-not-leak'),
      identity.workspaceRootPath,
      identity,
    )).toThrow(`Session directory for ${sessionId}`);
    expect(existsSync(join(outside, 'session.jsonl'))).toBe(false);
  });

  it('rejects a physical session directory replaced after enqueue', async () => {
    const workspace = join(testDir, 'session-replacement-workspace');
    const sessionId = 'session-replacement';
    const sessionPath = join(workspace, 'sessions', sessionId);
    mkdirSync(sessionPath, { recursive: true });
    const identity = captureSessionPersistenceRootIdentity(workspace);
    queue = new SessionPersistenceQueue(60_000);
    queue.enqueue(
      createTestSession(sessionId, workspace, 'must-not-move'),
      identity.workspaceRootPath,
      identity,
    );

    rmSync(sessionPath, { recursive: true });
    mkdirSync(sessionPath, { recursive: true });
    await expect(queue.flush(sessionId, identity.workspaceRootPath))
      .rejects.toThrow(`Session directory for ${sessionId} was replaced`);
    expect(existsSync(join(sessionPath, 'session.jsonl'))).toBe(false);
  });

  it('rejects promotion when the captured workspace directory is replaced mid-write', async () => {
    if (process.platform === 'win32') return;

    const sessionId = 'replaced-root-mid-write';
    const workspace = join(testDir, 'replace-live-root');
    const movedWorkspace = join(testDir, 'replace-moved-root');
    mkdirSync(workspace, { recursive: true });
    const identity = captureSessionPersistenceRootIdentity(workspace);
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
    queue.enqueue(
      createTestSession(sessionId, workspace, 'must-stay-on-old-root'),
      identity.workspaceRootPath,
      identity,
    );

    const flush = queue.flush(sessionId, identity.workspaceRootPath);
    await tempWritten;
    renameSync(workspace, movedWorkspace);
    const replacementFile = join(workspace, 'sessions', sessionId, 'session.jsonl');
    mkdirSync(join(workspace, 'sessions', sessionId), { recursive: true });
    const replacementBytes = '{"replacement":true}\n';
    writeFileSync(replacementFile, replacementBytes);
    releaseTempWrite();

    await expect(flush).rejects.toThrow('Session persistence root was replaced')
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes);
    expect(existsSync(`${replacementFile}.tmp`)).toBe(false);
    expect(queue.hasPending(sessionId, identity.workspaceRootPath)).toBe(false);
  });

  it('does not recover a live temp write through either side of a workspace symlink', async () => {
    if (process.platform === 'win32') return;

    const root = join(testDir, 'active-write-root');
    const symlink = join(testDir, 'active-write-symlink');
    mkdirSync(root, { recursive: true });
    symlinkSync(root, symlink, 'dir');

    const directions = [
      { label: 'alias-to-real', writerRoot: symlink, readerRoot: root },
      { label: 'real-to-alias', writerRoot: root, readerRoot: symlink },
    ];
    for (const { label, writerRoot, readerRoot } of directions) {
      const sessionId = `active-${label}`;
      let tempWriteCount = 0;
      let releaseTempWrite!: () => void;
      const tempWriteGate = new Promise<void>(resolve => { releaseTempWrite = resolve; });
      let notifyTempWritten!: () => void;
      const tempWritten = new Promise<void>(resolve => { notifyTempWritten = resolve; });
      queue = new SessionPersistenceQueue(60_000, {
        afterTempWrite: async id => {
          if (id !== sessionId || ++tempWriteCount !== 2) return;
          notifyTempWritten();
          await tempWriteGate;
        },
      });

      queue.enqueue(createTestSession(sessionId, writerRoot, 'first'));
      await queue.flush(sessionId, writerRoot);
      queue.enqueue(createTestSession(sessionId, writerRoot, 'second'));
      const flush = queue.flush(sessionId, writerRoot);
      await tempWritten;
      try {
        // Recovery through the other spelling must see that this .tmp belongs
        // to a live writer and leave it untouched.
        expect(loadSession(readerRoot, sessionId)?.sdkSessionId).toBe('first');
        expect(existsSync(join(writerRoot, 'sessions', sessionId, 'session.jsonl.tmp'))).toBe(true);
      } finally {
        releaseTempWrite();
        await flush;
      }
      expect(loadSession(readerRoot, sessionId)?.sdkSessionId).toBe('second');
    }
  });

  it('uses one case-folded session fence only on a case-insensitive workspace volume', async () => {
    const upperId = 'Case-Alias';
    const lowerId = upperId.toLowerCase();
    queue = new SessionPersistenceQueue(60_000);
    queue.enqueue(createTestSession(upperId, testDir, 'pending-upper'));
    const volumeIsCaseInsensitive = existsSync(join(testDir, 'SESSIONS'));

    await queue.retire(lowerId, testDir);

    if (volumeIsCaseInsensitive) {
      expect(queue.isRetired(upperId, testDir)).toBe(true);
      expect(() => queue.enqueue(createTestSession(lowerId, testDir, 'late-lower')))
        .toThrow(`Session persistence is retired: ${lowerId}`);
    } else {
      expect(queue.isRetired(upperId, testDir)).toBe(false);
      expect(queue.isRetired(lowerId, testDir)).toBe(true);
      queue.cancel(upperId, testDir);
    }
  });

  it('does not infer session case behavior from an alternate-case workspace symlink', async () => {
    const workspace = join(testDir, 'probea');
    const misleadingAlias = join(testDir, 'probeA');
    mkdirSync(join(workspace, 'sessions'), { recursive: true });

    // A case-insensitive volume cannot host both spellings. The preceding test
    // covers that behavior; this fixture targets case-sensitive volumes where
    // probing a parent component could be fooled by a symlink.
    if (existsSync(misleadingAlias)) return;
    symlinkSync(workspace, misleadingAlias, 'dir');

    const upperId = 'Case-Sensitive-ID';
    const lowerId = upperId.toLowerCase();
    queue = new SessionPersistenceQueue(60_000);
    queue.enqueue(createTestSession(upperId, workspace, 'pending-upper'));
    await queue.retire(lowerId, workspace);

    expect(queue.isRetired(upperId, workspace)).toBe(false);
    expect(queue.isRetired(lowerId, workspace)).toBe(true);
    queue.cancel(upperId, workspace);
  });

  it('releases a global slot after a failed write so later sessions can flush', async () => {
    queue = new SessionPersistenceQueue(500, { beforeWrite: id => {
      if (id === 'failing') throw new Error('fixture write failure');
    } });
    for (const id of ['failing', 'healthy-a', 'healthy-b']) queue.enqueue(createTestSession(id, testDir, id));
    await expect(queue.flushAll()).rejects.toThrow('fixture write failure');
    expect(existsSync(join(testDir, 'sessions', 'failing', 'session.jsonl'))).toBe(false);
    for (const id of ['healthy-a', 'healthy-b']) {
      expect(loadSession(testDir, id)?.sdkSessionId).toBe(id);
    }
  });

  it('rejects the exact forced flush on a post-temp write failure and remains reusable', async () => {
    let fail = true;
    queue = new SessionPersistenceQueue(500, { afterTempWrite: () => {
      if (fail) throw new Error('fixture rename boundary failure');
    } });
    queue.enqueue(createTestSession('test-session', testDir, 'rejected'));

    await expect(queue.flush('test-session')).rejects.toThrow('fixture rename boundary failure');
    expect(existsSync(join(testDir, 'sessions', 'test-session', 'session.jsonl'))).toBe(false);
    expect(queue.getLastWrittenSignature('test-session')).toBeUndefined();

    fail = false;
    queue.enqueue(createTestSession('test-session', testDir, 'recovered'));
    await queue.flush('test-session');
    expect(loadSession(testDir, 'test-session')?.sdkSessionId).toBe('recovered');
  });
});
