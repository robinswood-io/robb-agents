import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nodeDeps } from "./schema.ts";
import { parseTaskYaml, serializeTaskYaml, saveTaskSpec, loadTaskSpec, appendRunLog, readRunLog, writeNodeOutput, readNodeOutput, listTaskSlugs, listTaskRunSlugs, writeRunContextSnapshot, readRunContextSnapshot, writeRunSpecSnapshot, readRunSpecSnapshot, runDir, type RunLogEntry } from "./storage.ts";
import { parsed } from "./testing/schema-fixture.ts";

describe('storage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tasks-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a spec through task.yaml', () => {
    const spec = parsed();
    saveTaskSpec(root, spec);

    expect(listTaskSlugs(root)).toEqual(['demo']);

    const loaded = loadTaskSpec(root, 'demo');
    expect(loaded?.valid).toBe(true);
    expect(loaded?.spec?.id).toBe('demo');
    expect(loaded?.spec?.nodes.map((n) => n.id)).toEqual(['audit', 'design', 'impl']);
    expect(nodeDeps(loaded!.spec!.nodes[1]!)).toEqual(['audit']);
  });

  it('serializes to parseable yaml', () => {
    const yaml = serializeTaskYaml(parsed());
    const reparsed = parseTaskYaml(yaml);
    expect(reparsed.valid).toBe(true);
    expect(reparsed.spec?.title).toBe('Demo chain');
  });

  it('reports invalid yaml without throwing', () => {
    const res = parseTaskYaml(':\n  - [unbalanced');
    expect(res.valid).toBe(false);
    expect(res.errors[0]?.message).toContain('Invalid YAML');
  });

  it('rejects task, run, and node identifiers that escape their storage roots', () => {
    expect(() => loadTaskSpec(root, '../outside')).toThrow(/Invalid task slug/);
    expect(() => readRunLog(root, 'demo', '../outside')).toThrow(/Invalid task run id/);
    expect(() => readNodeOutput(root, 'demo', 'r1', '../outside')).toThrow(/Invalid task node id/);
  });

  it('appends and reads the run log in order', () => {
    const entries: RunLogEntry[] = [
      { t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: 'demo', runId: 'r1' },
      { t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'audit' },
      { t: '2026-06-07T00:00:02.000Z', kind: 'node-spawned', nodeId: 'audit', sessionId: 's-audit' },
      { t: '2026-06-07T00:00:03.000Z', kind: 'node-finished', nodeId: 'audit', sessionId: 's-audit', state: 'done' },
    ];
    for (const e of entries) appendRunLog(root, 'demo', 'r1', e);
    expect(readRunLog(root, 'demo', 'r1')).toEqual(entries);
  });

  it('detects tampering in the checksummed run log', () => {
    appendRunLog(root, 'demo', 'r1', {
      t: '2026-06-01T00:00:00.000Z',
      kind: 'run-started',
      taskId: 'demo',
      runId: 'r1',
    });
    appendRunLog(root, 'demo', 'r1', {
      t: '2026-06-01T00:00:01.000Z',
      kind: 'run-paused',
    });

    const path = join(runDir(root, 'demo', 'r1'), 'run-log.jsonl');
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first["kind"] = 'run-stopped';
    lines[0] = JSON.stringify(first);
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');

    expect(() => readRunLog(root, 'demo', 'r1')).toThrow('integrity');
  });

  it('recovers valid entries when only the final JSONL record is partial', () => {
    const entry: RunLogEntry = {
      t: '2026-06-01T00:00:00.000Z',
      kind: 'run-started',
      taskId: 'demo',
      runId: 'r1',
    };
    appendRunLog(root, 'demo', 'r1', entry);
    appendFileSync(join(runDir(root, 'demo', 'r1'), 'run-log.jsonl'), '{"t":"partial"', 'utf8');

    expect(readRunLog(root, 'demo', 'r1')).toEqual([entry]);
    const resumed: RunLogEntry = { t: '2026-06-01T00:00:01.000Z', kind: 'run-paused' };
    appendRunLog(root, 'demo', 'r1', resumed);
    expect(readRunLog(root, 'demo', 'r1')).toEqual([entry, resumed]);
  });

  it('recovers an orphaned run-log lock left by a crashed writer', () => {
    const first: RunLogEntry = {
      t: '2026-06-01T00:00:00.000Z',
      kind: 'run-started',
      taskId: 'demo',
      runId: 'r1',
    };
    appendRunLog(root, 'demo', 'r1', first);
    const lockPath = join(runDir(root, 'demo', 'r1'), 'run-log.jsonl.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, createdAt: '2026-06-01T00:00:00.000Z' }), 'utf8');

    const resumed: RunLogEntry = { t: '2026-06-01T00:00:01.000Z', kind: 'run-resumed' };
    appendRunLog(root, 'demo', 'r1', resumed);

    expect(readRunLog(root, 'demo', 'r1')).toEqual([first, resumed]);
  });

  it('keeps a run spec snapshot immutable once created', () => {
    const original = parsed();
    writeRunSpecSnapshot(root, 'demo', 'r1', original);
    const edited = { ...original, title: 'Edited after start' };

    expect(() => writeRunSpecSnapshot(root, 'demo', 'r1', edited)).toThrow('immutable');
    expect(readRunSpecSnapshot(root, 'demo', 'r1')).toEqual(original);
  });

  it('keeps JSON-safe run parameters immutable for exact recovery', () => {
    const context = { params: { env: 'prod', limit: 3, flags: ['safe'] }, verifyOnComplete: false };
    writeRunContextSnapshot(root, 'demo', 'r1', context);

    expect(readRunContextSnapshot(root, 'demo', 'r1')).toEqual(context);
    expect(() => writeRunContextSnapshot(root, 'demo', 'r1', {
      params: { env: 'staging' },
      verifyOnComplete: false,
    })).toThrow('immutable');
    expect(() => writeRunContextSnapshot(root, 'demo', 'r2', {
      params: { invalid: undefined },
      verifyOnComplete: true,
    })).toThrow('corrupt');
  });

  it('discovers retained run directories after task.yaml removal', () => {
    saveTaskSpec(root, parsed());
    appendRunLog(root, 'demo', 'r1', {
      t: '2026-06-01T00:00:00.000Z',
      kind: 'run-started',
      taskId: 'demo',
      runId: 'r1',
    });
    rmSync(join(root, 'tasks', 'demo', 'task.yaml'));

    expect(listTaskSlugs(root)).toEqual([]);
    expect(listTaskRunSlugs(root)).toEqual(['demo']);
  });

  it('writes and reads per-node output', () => {
    writeNodeOutput(root, 'demo', 'r1', 'audit', { text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'missing')).toBeNull();
  });
});
