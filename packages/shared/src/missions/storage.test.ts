import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
