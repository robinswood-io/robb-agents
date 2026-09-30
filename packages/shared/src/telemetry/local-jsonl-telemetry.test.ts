import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalJsonlTelemetrySink } from './execution-telemetry.ts';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('LocalJsonlTelemetrySink', () => {
  it('persists allowlisted operational fields and strips runtime payloads', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const sink = new LocalJsonlTelemetrySink(filePath);
    await sink.emit({
      schemaVersion: 1,
      eventId: 'evt-1',
      timestamp: 42,
      name: 'tool.completed',
      correlation: { workspaceId: 'w', sessionId: 's', toolCallId: 't' },
      toolName: 'Read',
      durationMs: 12,
      secretSentinel: 'must-not-persist',
    } as any);

    const persisted = await readFile(filePath, 'utf8');
    expect(persisted).toContain('tool.completed');
    expect(persisted).toContain('durationMs');
    expect(persisted).not.toContain('must-not-persist');
  });

  it('rotates before crossing the configured byte budget without discarding the previous window', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const sink = new LocalJsonlTelemetrySink(filePath, 260);
    const event = (eventId: string) => ({
      schemaVersion: 1 as const,
      eventId,
      timestamp: 42,
      name: 'tool.completed' as const,
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    });
    await sink.emit(event('old-event'));
    await sink.emit(event('new-event'));

    const persisted = await readFile(filePath, 'utf8');
    const archived = await readFile(`${filePath}.1`, 'utf8');
    expect(persisted).toContain('new-event');
    expect(persisted).not.toContain('old-event');
    expect(archived).toContain('old-event');
    expect(archived).not.toContain('new-event');
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(260);
    expect(Buffer.byteLength(archived)).toBeLessThanOrEqual(260);
  });

  it('serializes concurrent writes across rotation and retains every complete record', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const sink = new LocalJsonlTelemetrySink(filePath, 400);
    const events = Array.from({ length: 3 }, (_, index) => ({
      schemaVersion: 1 as const,
      eventId: `event-${index}`,
      timestamp: 42 + index,
      name: 'tool.completed' as const,
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    }));

    await Promise.all(events.map(event => sink.emit(event)));

    const records = `${await readFile(`${filePath}.1`, 'utf8')}${await readFile(filePath, 'utf8')}`
      .trim().split('\n').map(line => JSON.parse(line) as { eventId: string });
    expect(records.map(record => record.eventId)).toEqual(events.map(event => event.eventId));
    expect(Buffer.byteLength(await readFile(filePath))).toBeLessThanOrEqual(400);
    expect(Buffer.byteLength(await readFile(`${filePath}.1`))).toBeLessThanOrEqual(400);
  });

  it('shares serialization across sink instances targeting the same path', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const maxBytes = 260;
    const event = (eventId: string) => ({
      schemaVersion: 1 as const,
      eventId,
      timestamp: 42,
      name: 'tool.completed' as const,
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    });

    await Promise.all([
      new LocalJsonlTelemetrySink(filePath, maxBytes).emit(event('sink-a')),
      new LocalJsonlTelemetrySink(filePath, maxBytes).emit(event('sink-b')),
    ]);

    const active = await readFile(filePath, 'utf8');
    const archived = await readFile(`${filePath}.1`, 'utf8');
    const records = `${archived}${active}`.trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.eventId).sort()).toEqual(['sink-a', 'sink-b']);
    expect(Buffer.byteLength(active)).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(archived)).toBeLessThanOrEqual(maxBytes);
  });

  it('repairs an interrupted final JSON record before appending', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const maxBytes = 500;
    await writeFile(filePath, '{"legacy":"complete"}\n{"legacy":"interrupted"');
    await writeFile(`${filePath}.1`, '{"archived":"complete"}\n{"archived":"interrupted"');

    await new LocalJsonlTelemetrySink(filePath, maxBytes).emit({
      schemaVersion: 1,
      eventId: 'after-repair',
      timestamp: 42,
      name: 'tool.completed',
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    });

    const persisted = await readFile(filePath, 'utf8');
    const records = persisted.trim().split('\n').map(line => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ legacy: 'complete' });
    expect(records[1].eventId).toBe('after-repair');
    const archived = await readFile(`${filePath}.1`, 'utf8');
    expect(archived.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { archived: 'complete' },
    ]);
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(maxBytes);
  });

  it('tightens existing active and archive permissions to owner-only', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    await writeFile(filePath, '{"legacy":"active"}\n');
    await writeFile(`${filePath}.1`, '{"legacy":"archive"}\n');
    await chmod(filePath, 0o644);
    await chmod(`${filePath}.1`, 0o644);

    await new LocalJsonlTelemetrySink(filePath, 1_000).emit({
      schemaVersion: 1,
      eventId: 'permission-repair',
      timestamp: 42,
      name: 'tool.completed',
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    });

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(`${filePath}.1`)).mode & 0o777).toBe(0o600);
  });

  it('refuses symlinked parents, symlinked leaves, and hard-linked leaves', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const workspace = join(directory, 'workspace');
    const outside = join(directory, 'outside');
    const victim = join(outside, 'victim.txt');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(victim, 'ORIGINAL');
    const event = {
      schemaVersion: 1 as const,
      eventId: 'must-not-escape',
      timestamp: 42,
      name: 'tool.completed' as const,
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    };

    const parentAttackRoot = join(workspace, 'parent-attack');
    await mkdir(parentAttackRoot);
    await symlink(outside, join(parentAttackRoot, 'telemetry'), 'dir');
    await expect(new LocalJsonlTelemetrySink(
      join(parentAttackRoot, 'telemetry', 'events.jsonl'), 1_000, parentAttackRoot,
    ).emit(event)).rejects.toThrow();

    const leafAttackRoot = join(workspace, 'leaf-attack');
    await mkdir(join(leafAttackRoot, 'telemetry'), { recursive: true });
    await symlink(victim, join(leafAttackRoot, 'telemetry', 'events.jsonl'));
    await expect(new LocalJsonlTelemetrySink(
      join(leafAttackRoot, 'telemetry', 'events.jsonl'), 1_000, leafAttackRoot,
    ).emit(event)).rejects.toThrow();

    const hardlinkAttackRoot = join(workspace, 'hardlink-attack');
    await mkdir(join(hardlinkAttackRoot, 'telemetry'), { recursive: true });
    await link(victim, join(hardlinkAttackRoot, 'telemetry', 'events.jsonl'));
    await expect(new LocalJsonlTelemetrySink(
      join(hardlinkAttackRoot, 'telemetry', 'events.jsonl'), 1_000, hardlinkAttackRoot,
    ).emit(event)).rejects.toThrow();

    expect(await readFile(victim, 'utf8')).toBe('ORIGINAL');
  });

  it('drops an oversized record whole and keeps later rotation valid and bounded', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const maxBytes = 280;
    const sink = new LocalJsonlTelemetrySink(filePath, maxBytes);
    const event = (eventId: string, toolName = 'Read') => ({
      schemaVersion: 1 as const,
      eventId,
      timestamp: 42,
      name: 'tool.completed' as const,
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName,
      durationMs: 12,
    });

    await sink.emit(event('old-event'));
    await sink.emit(event('oversized-event', 'x'.repeat(maxBytes)));
    await sink.emit(event('new-event'));

    const persisted = await readFile(filePath, 'utf8');
    const archived = await readFile(`${filePath}.1`, 'utf8');
    const records = `${archived}${persisted}`.trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.eventId)).toEqual(['old-event', 'new-event']);
    expect(`${archived}${persisted}`).not.toContain('oversized-event');
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(archived)).toBeLessThanOrEqual(maxBytes);
  });

  it('removes legacy oversized active and archive files without persisting partial JSON', async () => {
    directory = await mkdtemp(join(tmpdir(), 'robb-local-telemetry-'));
    const filePath = join(directory, 'events.jsonl');
    const maxBytes = 220;
    await writeFile(filePath, `${JSON.stringify({ legacy: 'x'.repeat(maxBytes) })}\n`);
    await writeFile(`${filePath}.1`, `${JSON.stringify({ legacy: 'y'.repeat(maxBytes) })}\n`);

    const sink = new LocalJsonlTelemetrySink(filePath, maxBytes);
    await sink.emit({
      schemaVersion: 1,
      eventId: 'bounded-event',
      timestamp: 42,
      name: 'tool.completed',
      correlation: { workspaceId: 'w', sessionId: 's' },
      toolName: 'Read',
      durationMs: 12,
    });

    const persisted = await readFile(filePath, 'utf8');
    expect(JSON.parse(persisted).eventId).toBe('bounded-event');
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(maxBytes);
    await expect(stat(`${filePath}.1`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
