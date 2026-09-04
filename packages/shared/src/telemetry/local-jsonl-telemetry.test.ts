import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

  it('rotates before crossing the configured byte budget', async () => {
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
    expect(persisted).toContain('new-event');
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(260);
  });
});
