import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendRunLog,
  saveTaskSpec,
  writeNodeOutput,
  writeRunSpecSnapshot,
} from './storage.ts';
import {
  buildDurableTaskSnapshot,
  ensureDurableTaskMetadata,
  loadDurableTaskMetadata,
  updateDurableTaskMetadata,
} from './durable-task.ts';
import type { TaskSpec } from './schema.ts';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'robb-durable-task-'));
}

function spec(): TaskSpec {
  return {
    id: 'durable-example',
    title: 'Durable example',
    goal: 'Deliver a verified result',
    acceptance_criteria: 'The final verification passes.',
    runner: 'conduct',
    executor: { agent: 'quality-agent', wrapper: 'mission-wrapper' },
    nodes: [
      { id: 'collect', prompt: 'Collect', kind: 'session', effect: 'read' },
      { id: 'publish', prompt: 'Publish', kind: 'session', depends_on: ['collect'], effect: 'workspace-write' },
    ],
  };
}

describe('durable task product object', () => {
  it('lazily migrates legacy task.yaml metadata without rewriting the spec', () => {
    const root = workspace();
    saveTaskSpec(root, spec());

    const metadata = ensureDurableTaskMetadata(root, 'durable-example', {
      orchestratorSessionId: 'session-orchestrator',
    });

    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.revision).toBe(1);
    expect(loadDurableTaskMetadata(root, 'durable-example')).toEqual(metadata);
  });

  it('materializes graph, sessions, verified result, evidence, and next action', () => {
    const root = workspace();
    const task = spec();
    saveTaskSpec(root, task);
    ensureDurableTaskMetadata(root, task.id, { orchestratorSessionId: 'orch-1' });
    writeRunSpecSnapshot(root, task.id, 'run-1', task);
    mkdirSync(join(root, 'tasks', task.id, 'runs', 'run-1'), { recursive: true });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:00.000Z', kind: 'run-started', taskId: task.id, runId: 'run-1', orchestratorSessionId: 'orch-1' });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:01.000Z', kind: 'node-scheduled', nodeId: 'collect' });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:02.000Z', kind: 'node-spawned', nodeId: 'collect', sessionId: 'child-1' });
    writeNodeOutput(root, task.id, 'run-1', 'collect', { text: 'Collected' });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:03.000Z', kind: 'node-checkpoint', nodeId: 'collect', idempotencyKey: 'key', status: 'confirmed', proofHash: 'proof' });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:04.000Z', kind: 'node-finished', nodeId: 'collect', sessionId: 'child-1', state: 'done' });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:05.000Z', kind: 'verdict', result: 'pass' });
    appendRunLog(root, task.id, 'run-1', { t: '2026-08-12T10:00:06.000Z', kind: 'run-completed' });

    const snapshot = buildDurableTaskSnapshot(root, task.id, task);

    expect(snapshot.description).toBe(task.goal);
    expect(snapshot.status).toBe('completed');
    expect(snapshot.graph.edges).toEqual([{ from: 'collect', to: 'publish' }]);
    expect(snapshot.graph.nodes[0]?.sessionId).toBe('child-1');
    expect(snapshot.graph.nodes[0]?.proofHash).toBe('proof');
    expect(snapshot.result.verification).toBe('verified');
    expect(snapshot.result.output).toBe('Collected');
    expect(snapshot.userEvidence.userVerification).toStartWith('PASS');
    expect(snapshot.linkedSessions.orchestratorSessionId).toBe('orch-1');
    expect(snapshot.nextAction).toBe('Export mission report');
  });

  it('archives without deleting evidence and increments the optimistic revision', () => {
    const root = workspace();
    saveTaskSpec(root, spec());
    const first = ensureDurableTaskMetadata(root, 'durable-example');
    const archived = updateDurableTaskMetadata(root, 'durable-example', {
      archived: true,
      nextAction: 'Retain for audit',
      externalRefs: { craftTaskId: 'craft-123' },
    }, '2026-08-12T12:00:00.000Z');

    expect(archived.revision).toBe(first.revision + 1);
    expect(archived.archivedAt).toBe('2026-08-12T12:00:00.000Z');
    expect(archived.externalRefs.craftTaskId).toBe('craft-123');
    expect(buildDurableTaskSnapshot(root, 'durable-example', spec()).status).toBe('archived');
  });

  it('rejects a stale cockpit write with an optimistic revision conflict', () => {
    const root = workspace();
    saveTaskSpec(root, spec());
    const current = ensureDurableTaskMetadata(root, 'durable-example');
    updateDurableTaskMetadata(root, 'durable-example', {
      expectedRevision: current.revision,
      nextAction: 'Review',
    });

    expect(() => updateDurableTaskMetadata(root, 'durable-example', {
      expectedRevision: current.revision,
      nextAction: 'Stale overwrite',
    })).toThrow('revision conflict');
    expect(loadDurableTaskMetadata(root, 'durable-example')?.nextAction).toBe('Review');
  });
});
