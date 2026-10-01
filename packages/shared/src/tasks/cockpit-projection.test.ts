import { describe, expect, it } from 'bun:test';
import { projectDurableTaskToCockpits } from './cockpit-projection.ts';
import type { DurableTaskSnapshot } from './durable-task.ts';

const task = {
  schemaVersion: 1,
  id: 'task-1',
  slug: 'task-1',
  revision: 3,
  title: 'Close the books',
  description: 'Reconcile the monthly accounts.',
  acceptanceCriteria: 'All differences are explained.',
  sources: ['ledger'],
  projectId: 'finance',
  executor: { runner: 'conduct', agent: 'conductor', wrapper: 'conduct' },
  status: 'completed',
  archived: false,
  graph: { nodes: [], edges: [] },
  linkedSessions: { nodes: [] },
  latestRunId: 'run-9',
  result: { verification: 'verified', summary: 'Passed' },
  evidenceRefs: ['tasks/task-1/runs/run-9/run-log.jsonl'],
  userEvidence: {
    actionRequested: 'Reconcile',
    actionAttempted: ['Scheduled collect'],
    mutationsApplied: [],
    userVerification: 'PASS: acceptance gate recorded',
    remainingLimitations: [],
  },
  nextAction: 'Export mission report',
  externalRefs: { craftTaskId: 'craft-1' },
  visualState: { tone: 'success', label: 'Verified complete', progressPercent: 100, attentionRequired: false },
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T01:00:00.000Z',
} satisfies DurableTaskSnapshot;

describe('durable task cockpit projections', () => {
  it('keeps Robb identity and revision in every external projection', () => {
    const projections = projectDurableTaskToCockpits(task);
    expect(projections.craft.externalId).toBe('craft-1');
    expect(projections.craft.status).toBe('done');
    expect(projections.craft.metadata).toEqual({ robbTaskId: 'task-1', revision: 3, latestRunId: 'run-9' });
    expect(projections.googleTasks.status).toBe('completed');
    expect(projections.temporal.workflowId).toBe('robb-task/task-1/run-9');
    expect(projections.temporal.searchAttributes.RobbTaskId).toBe('task-1');
  });

  it('keeps an archived task non-actionable in providers without archive support', () => {
    const archived: DurableTaskSnapshot = { ...task, status: 'archived', archived: true };
    const projections = projectDurableTaskToCockpits(archived);

    expect(projections.craft.status).toBe('cancelled');
    expect(projections.googleTasks.status).toBe('completed');
  });
});
