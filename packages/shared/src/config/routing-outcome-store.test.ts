import { describe, expect, it } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingOutcomeStore } from './routing-outcome-store.ts';

const outcome = (id: string) => ({
  id, connectionSlug: 'local', difficulty: 'simple' as const, status: 'success' as const,
  durationMs: 10, workspaceId: 'workspace-1', missionId: 'mission-1', sessionId: 'session-1',
});

describe('RoutingOutcomeStore', () => {
  it('fsyncs, deduplicates, filters, and compacts privacy-minimal outcomes', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-routing-outcomes-'));
    const store = new RoutingOutcomeStore(root, 2);
    expect(store.record(outcome('event-1'))).toBe(true);
    expect(store.record(outcome('event-1'))).toBe(false);
    expect(store.record({ ...outcome('event-2'), missionId: 'mission-2' })).toBe(true);
    expect(store.record(outcome('event-3'))).toBe(true);
    expect(store.read().map(({ id }) => id)).toEqual(['event-2', 'event-3']);
    expect(store.read({ missionId: 'mission-1' }).map(({ id }) => id)).toEqual(['event-3']);
  });

  it('ignores only an interrupted final append', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-routing-tail-'));
    const store = new RoutingOutcomeStore(root);
    store.record(outcome('event-1'));
    appendFileSync(store.filePath, '{"id":');
    expect(store.read()).toEqual([outcome('event-1')]);
    expect(store.record(outcome('event-2'))).toBe(true);
    expect(store.read().map(({ id }) => id)).toEqual(['event-1', 'event-2']);
  });
});
