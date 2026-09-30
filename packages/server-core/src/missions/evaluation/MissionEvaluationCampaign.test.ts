import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MissionSpecSchema,
  missionJournalPath,
  type MissionSpec,
} from '@craft-agent/shared/missions';
import { MissionController } from '../MissionController.ts';
import { evaluateMissionJournal } from './MissionEvaluation.ts';
import { loadMissionEvaluationCorpus, runMissionEvaluationCampaign } from './MissionEvaluationCampaign.ts';

function integrityFixture(): MissionSpec {
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: 'integrity-eval',
    title: 'Integrity evaluation',
    objective: 'Refuser un journal altéré',
    acceptanceCriteria: [{ id: 'mission-ok', description: 'Le journal reste intègre.' }],
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'plan', systemPrompt: 'Planifier.' },
      { id: 'worker', role: 'worker', specialty: 'travail', systemPrompt: 'Exécuter.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'qualité', systemPrompt: 'Contrôler.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'global', systemPrompt: 'Superviser.' },
    ],
    policy: {},
    workItems: [
      {
        id: 'objective-one', kind: 'objective', title: 'Objectif',
        acceptanceCriteria: [{ id: 'objective-ok', description: 'Objectif conforme.' }],
      },
      {
        id: 'task-one', kind: 'task', title: 'Tâche', prompt: 'Exécuter.',
        parentId: 'objective-one', objectiveId: 'objective-one',
        acceptanceCriteria: [{ id: 'task-ok', description: 'Tâche conforme.' }],
      },
    ],
  });
}

describe('Mission evaluation campaign', () => {
  const roots: string[] = [];
  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('promotes only when every deterministic quality, recovery, and safety gate passes', async () => {
    const corpus = loadMissionEvaluationCorpus();
    const report = await runMissionEvaluationCampaign(corpus);

    expect(corpus.scenarios).toHaveLength(8);
    expect(report.promotion.eligible).toBe(true);
    expect(report.scenarios.every((scenario) => scenario.passed)).toBe(true);
    expect(report.kpis).toMatchObject({
      scenarioPassRate: 1,
      expectedCompletionRate: 1,
      correctionConvergenceRate: 1,
      recoveryFidelityRate: 1,
      telemetryCoverageRate: 1,
      guardrailFailures: 0,
      falseCompletions: 0,
      duplicateDispatches: 0,
    });
    expect(report.scenarios.find((scenario) => scenario.id === 'reserved-dispatch-recovery')?.checks)
      .toContainEqual(expect.objectContaining({ id: 'reserved-dispatch-reused', passed: true }));
    expect(report.scenarios.find((scenario) => scenario.id === 'happy-path')?.checks)
      .toContainEqual(expect.objectContaining({ id: 'origin-report-exactly-once', passed: true }));
  });

  it('reports a blocking journal-integrity failure instead of evaluating corrupted state', () => {
    const root = mkdtempSync(join(tmpdir(), 'mission-eval-integrity-'));
    roots.push(root);
    const controller = new MissionController({ workspaceRoot: root });
    controller.createMission(integrityFixture());
    const path = missionJournalPath(root, 'integrity-eval');
    const journal = readFileSync(path, 'utf-8');
    writeFileSync(path, journal.replace('Integrity evaluation', 'Integrity evaluatioN'), 'utf-8');

    const result = evaluateMissionJournal(root, 'integrity-eval', { requireTelemetry: true });

    expect(result.status).toBe('journal-error');
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'journal-integrity', passed: false }));
    expect(result.error).toMatch(/checksum mismatch/);
  });
});
