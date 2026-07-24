import { describe, expect, it } from 'bun:test';
import { buildMissionControlSnapshot, exportMissionReportMarkdown, planMissionReplay } from './mission-control.ts';
import { parseTaskSpec } from './schema.ts';
import type { RunLogEntry } from './storage.ts';

function missionSpec() {
  const parsed = parseTaskSpec({
    id: 'launch',
    title: 'Launch campaign',
    goal: 'Publish an audited campaign',
    token_budget: 10_000,
    mission: {
      inputs: [{ name: 'brief', sensitivity: 'confidential' }],
      deliverables: [{ name: 'campaign', format: 'markdown' }],
      budget: { max_tokens: 10_000, max_cost: 8, currency: 'EUR' },
      deadline: '2026-08-01T12:00:00+02:00',
      policy: {
        impact_level: 'high',
        require_high_impact_approval: true,
        replay_external_mutations: false,
        owner: 'alice',
        validator: 'bob',
      },
    },
    nodes: [
      { id: 'draft', prompt: 'Draft', effect: 'workspace-write' },
      {
        id: 'publish',
        prompt: 'Publish',
        depends_on: ['draft'],
        effect: 'external-mutation',
        approval: true,
      },
    ],
  });
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data;
}

describe('mission control', () => {
  it('projects progress, pending approvals, blockers, and next action from the durable log', () => {
    const log: RunLogEntry[] = [
      { t: '2026-07-23T08:00:00.000Z', kind: 'run-started', taskId: 'launch', runId: 'r1' },
      { t: '2026-07-23T08:01:00.000Z', kind: 'node-scheduled', nodeId: 'draft' },
      {
        t: '2026-07-23T08:02:00.000Z',
        kind: 'node-finished',
        nodeId: 'draft',
        sessionId: 's1',
        state: 'done',
      },
      {
        t: '2026-07-23T08:03:00.000Z',
        kind: 'approval-requested',
        requestId: 'approval-r1-publish',
        nodeId: 'publish',
        reason: 'External publication changes customer-visible state.',
        impact: 'high',
        owner: 'bob',
      },
    ];
    const snapshot = buildMissionControlSnapshot(missionSpec(), 'r1', log, { tokensUsed: 1234, costUsed: 1.25 });
    expect(snapshot.status).toBe('waiting-approval');
    expect(snapshot.progress).toEqual({ total: 2, completed: 1, failed: 0, running: 0, pending: 1, percent: 50 });
    expect(snapshot.approvals[0]?.status).toBe('pending');
    expect(snapshot.blockers[0]?.owner).toBe('bob');
    expect(snapshot.nextActions).toContain('Resolve pending approval');
    expect(snapshot.evaluation).toMatchObject({
      status: 'pending',
      acceptance: 'not-evaluated',
      evaluatedNodes: 1,
      successfulNodes: 1,
      nodeSuccessRate: 100,
    });
    expect(snapshot.cost).toMatchObject({
      status: 'within-budget',
      currency: 'EUR',
      used: 1.25,
      limit: 8,
      percentUsed: 15.6,
    });
    const report = exportMissionReportMarkdown(snapshot);
    expect(report).toContain('# Mission report — Launch campaign');
    expect(report).toContain('## Evaluation');
    expect(report).toContain('## Cost');
  });

  it('uses workspace budget fallbacks and reports a failed acceptance without inflating quality', () => {
    const spec = missionSpec();
    delete spec.token_budget;
    if (spec.mission) delete spec.mission.budget;
    const log: RunLogEntry[] = [
      { t: '2026-07-23T08:00:00.000Z', kind: 'run-started', taskId: 'launch', runId: 'r2' },
      {
        t: '2026-07-23T08:01:00.000Z',
        kind: 'node-finished',
        nodeId: 'draft',
        sessionId: 's1',
        state: 'failed',
        reason: 'Missing source evidence',
      },
      {
        t: '2026-07-23T08:02:00.000Z',
        kind: 'verdict',
        result: 'fail',
        reason: 'Acceptance criteria were not met',
        nodes: ['draft'],
      },
    ];
    const snapshot = buildMissionControlSnapshot(spec, 'r2', log, {
      tokensUsed: 8_100,
      costUsed: 4.25,
      maxTokens: 10_000,
      maxCost: 5,
      currency: 'USD',
      warningPercent: 80,
    });
    expect(snapshot.budget.maxTokens).toBe(10_000);
    expect(snapshot.evaluation).toMatchObject({
      status: 'failing',
      acceptance: 'fail',
      evaluatedNodes: 1,
      successfulNodes: 0,
      failedNodes: 1,
      nodeSuccessRate: 0,
    });
    expect(snapshot.evaluation.failures).toEqual([
      'Acceptance criteria were not met',
      'draft: Missing source evidence',
    ]);
    expect(snapshot.cost).toMatchObject({
      status: 'warning',
      used: 4.25,
      limit: 5,
      remaining: 0.75,
      percentUsed: 85,
    });
  });

  it('reuses confirmed work and blocks ambiguous or external mutations by default', () => {
    const log: RunLogEntry[] = [
      {
        t: '2026-07-23T08:00:00.000Z',
        kind: 'node-checkpoint',
        nodeId: 'draft',
        idempotencyKey: 'draft-1',
        status: 'confirmed',
        proofHash: 'abc',
      },
      {
        t: '2026-07-23T08:01:00.000Z',
        kind: 'node-checkpoint',
        nodeId: 'publish',
        idempotencyKey: 'publish-1',
        status: 'executing',
      },
    ];
    const plan = planMissionReplay(
      missionSpec(),
      'r1',
      log,
      (nodeId) => (nodeId === 'draft' ? { text: 'ready' } : null),
    );
    expect(plan.nodes).toEqual([
      {
        nodeId: 'draft',
        action: 'reuse',
        reason: 'Confirmed output is reusable without executing the node.',
        effect: 'workspace-write',
      },
      {
        nodeId: 'publish',
        action: 'block',
        reason: 'Execution began but was not confirmed; provider state must be reconciled first.',
        effect: 'external-mutation',
      },
    ]);
    expect(plan.safeByDefault).toBe(true);
    expect(plan.blockedNodeIds).toEqual(['publish']);
  });
});
