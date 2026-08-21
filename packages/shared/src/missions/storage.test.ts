import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openConfinedRegularFile } from './confined-file.ts';
import { missionFixture } from './schema.test.ts';
import {
  appendMissionEvents,
  loadMissionSnapshot,
  missionJournalPath,
  readMissionEvents,
} from './storage.ts';

describe('mission journal', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mission-journal-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reconstructs the same state and rejects stale writers', () => {
    const spec = missionFixture();
    appendMissionEvents(root, spec.id, [{ kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec }], 0);
    appendMissionEvents(root, spec.id, [
      { kind: 'mission-status-changed', at: '2026-08-18T10:00:01.000Z', status: 'running' },
    ], 1);
    expect(loadMissionSnapshot(root, spec.id)?.status).toBe('running');
    expect(loadMissionSnapshot(root, spec.id)?.revision).toBe(2);
    expect(() => appendMissionEvents(root, spec.id, [
      { kind: 'mission-status-changed', at: '2026-08-18T10:00:02.000Z', status: 'paused', reason: 'pause' },
    ], 1)).toThrow(/revision conflict/);
  });

  it('fails closed on tampering', () => {
    const spec = missionFixture();
    appendMissionEvents(root, spec.id, [{ kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec }], 0);
    const path = missionJournalPath(root, spec.id);
    writeFileSync(path, readFileSync(path, 'utf-8').replace('Mission demo', 'Mission falsifiée'));
    expect(() => readMissionEvents(root, spec.id)).toThrow(/checksum mismatch/);
  });

  it('rejects mission ids that could escape the workspace mission root', () => {
    expect(() => readMissionEvents(root, '../outside')).toThrow(/Invalid mission id/);
  });

  it('refuses a symlinked mission directory without creating an outside journal', () => {
    const spec = missionFixture();
    const outside = mkdtempSync(join(tmpdir(), 'mission-journal-outside-'));
    mkdirSync(join(root, 'missions'));
    symlinkSync(outside, join(root, 'missions', spec.id), 'dir');
    try {
      expect(() => appendMissionEvents(root, spec.id, [
        { kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec },
      ], 0)).toThrow(/symbolic link|real directory/);
      expect(existsSync(join(outside, 'events.jsonl'))).toBe(false);
      expect(existsSync(join(outside, 'events.jsonl.lock'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a symlinked journal for both reads and appends', () => {
    const spec = missionFixture();
    appendMissionEvents(root, spec.id, [
      { kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec },
    ], 0);
    const journal = missionJournalPath(root, spec.id);
    const outside = join(mkdtempSync(join(tmpdir(), 'mission-journal-outside-')), 'target.jsonl');
    writeFileSync(outside, 'outside-sentinel\n');
    unlinkSync(journal);
    symlinkSync(outside, journal);
    try {
      expect(() => readMissionEvents(root, spec.id)).toThrow(/symbolic link/);
      expect(() => appendMissionEvents(root, spec.id, [
        { kind: 'mission-status-changed', at: '2026-08-18T10:00:01.000Z', status: 'running' },
      ], 1)).toThrow(/symbolic link/);
      expect(readFileSync(outside, 'utf-8')).toBe('outside-sentinel\n');
    } finally {
      rmSync(join(outside, '..'), { recursive: true, force: true });
    }
  });

  it('refuses a hard-linked journal and leaves the shared inode unchanged', () => {
    const spec = missionFixture();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'mission-hardlink-outside-'));
    const outside = join(outsideRoot, 'target.jsonl');
    writeFileSync(outside, 'outside-sentinel\n');
    mkdirSync(join(root, 'missions', spec.id), { recursive: true });
    linkSync(outside, missionJournalPath(root, spec.id));
    try {
      expect(() => readMissionEvents(root, spec.id)).toThrow(/exactly one hard link/);
      expect(() => appendMissionEvents(root, spec.id, [
        { kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec },
      ], 0)).toThrow(/exactly one hard link/);
      expect(readFileSync(outside, 'utf-8')).toBe('outside-sentinel\n');
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('detects a final-component swap while keeping reads pinned to the opened inode', () => {
    const path = join(root, 'proof.txt');
    const parked = join(root, 'proof.original.txt');
    const outside = join(mkdtempSync(join(tmpdir(), 'mission-swap-outside-')), 'outside.txt');
    writeFileSync(path, 'trusted');
    writeFileSync(outside, 'untrusted');
    const handle = openConfinedRegularFile(root, path, { flags: constants.O_RDONLY });
    try {
      renameSync(path, parked);
      symlinkSync(outside, path);
      expect(readFileSync(handle.descriptor, 'utf-8')).toBe('trusted');
      expect(() => handle.assertStillBound()).toThrow(/symbolic link|changed/);
    } finally {
      handle.close();
      rmSync(join(outside, '..'), { recursive: true, force: true });
    }
  });

  it('ignores and repairs an interrupted final append', () => {
    const spec = missionFixture();
    appendMissionEvents(root, spec.id, [{ kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec }], 0);
    appendFileSync(missionJournalPath(root, spec.id), '{"kind":"mission-status');
    expect(readMissionEvents(root, spec.id)).toHaveLength(1);
    appendMissionEvents(root, spec.id, [
      { kind: 'mission-status-changed', at: '2026-08-18T10:00:01.000Z', status: 'running' },
    ], 1);
    expect(loadMissionSnapshot(root, spec.id)?.status).toBe('running');
    expect(readFileSync(missionJournalPath(root, spec.id), 'utf-8')).not.toContain('{"kind":"mission-status\n');
  });

  it('never projects a prefix of an interrupted multi-event transaction', () => {
    const spec = missionFixture();
    appendMissionEvents(root, spec.id, [{ kind: 'mission-created', at: '2026-08-18T10:00:00.000Z', spec }], 0);
    const path = missionJournalPath(root, spec.id);
    appendMissionEvents(root, spec.id, [
      { kind: 'mission-status-changed', at: '2026-08-18T10:00:01.000Z', status: 'running' },
      { kind: 'mission-status-changed', at: '2026-08-18T10:00:02.000Z', status: 'paused', reason: 'pause' },
    ], 1);
    const text = readFileSync(path, 'utf-8');
    const transactionStart = text.indexOf('\n') + 1;
    writeFileSync(path, text.slice(0, transactionStart + 80));
    const recovered = loadMissionSnapshot(root, spec.id);
    expect(recovered?.revision).toBe(1);
    expect(recovered?.status).toBe('draft');
  });
});
