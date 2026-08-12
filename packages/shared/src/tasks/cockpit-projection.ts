import type { DurableTaskSnapshot } from './durable-task.ts';

export interface CraftTaskProjection {
  provider: 'craft';
  externalId?: string;
  title: string;
  status: 'todo' | 'in-progress' | 'done' | 'cancelled';
  descriptionMarkdown: string;
  metadata: { robbTaskId: string; revision: number; latestRunId?: string };
}

export interface GoogleTaskProjection {
  provider: 'google-tasks';
  externalId?: string;
  title: string;
  status: 'needsAction' | 'completed';
  notes: string;
  metadata: { robbTaskId: string; revision: number };
}

export interface TemporalWorkflowProjection {
  provider: 'temporal';
  workflowId: string;
  taskQueue: 'robb-tasks';
  searchAttributes: {
    RobbTaskId: string;
    RobbTaskRevision: number;
    RobbProjectId?: string;
    RobbRunId?: string;
  };
  memo: { title: string; acceptanceCriteria: string; evidenceRefs: string[] };
}

export interface DurableTaskCockpitProjections {
  craft: CraftTaskProjection;
  googleTasks: GoogleTaskProjection;
  temporal: TemporalWorkflowProjection;
}

function externalStatus(task: DurableTaskSnapshot): CraftTaskProjection['status'] {
  if (task.status === 'completed') return 'done';
  if (task.status === 'stopped' || task.status === 'archived') return 'cancelled';
  if (task.status === 'ready') return 'todo';
  return 'in-progress';
}

function cockpitDescription(task: DurableTaskSnapshot): string {
  const lines = [
    task.description,
    '',
    `Acceptance criteria: ${task.acceptanceCriteria}`,
    `Robb status: ${task.status}`,
    `Next action: ${task.nextAction}`,
    `Progress: ${task.visualState.progressPercent}%`,
    task.latestRunId ? `Latest run: ${task.latestRunId}` : '',
    '',
    `Verification: ${task.userEvidence.userVerification}`,
    ...(task.userEvidence.remainingLimitations.length
      ? ['', 'Remaining limitations:', ...task.userEvidence.remainingLimitations.map((item) => `- ${item}`)]
      : []),
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}

/**
 * Produce provider-shaped cockpit objects without transferring source-of-truth
 * ownership away from Robb. Connector workers may upsert these projections and
 * then persist returned ids in DurableTask.externalRefs.
 */
export function projectDurableTaskToCockpits(task: DurableTaskSnapshot): DurableTaskCockpitProjections {
  const description = cockpitDescription(task);
  const craftStatus = externalStatus(task);
  return {
    craft: {
      provider: 'craft',
      externalId: task.externalRefs.craftTaskId,
      title: task.title,
      status: craftStatus,
      descriptionMarkdown: description,
      metadata: {
        robbTaskId: task.id,
        revision: task.revision,
        latestRunId: task.latestRunId,
      },
    },
    googleTasks: {
      provider: 'google-tasks',
      externalId: task.externalRefs.googleTaskId,
      title: task.title,
      // Google Tasks has no cancelled/archive state; completed is the only
      // non-actionable projection and prevents archived work resurfacing.
      status: craftStatus === 'done' || craftStatus === 'cancelled' ? 'completed' : 'needsAction',
      notes: description,
      metadata: { robbTaskId: task.id, revision: task.revision },
    },
    temporal: {
      provider: 'temporal',
      workflowId: task.externalRefs.temporalWorkflowId ?? `robb-task/${task.id}/${task.latestRunId ?? `revision-${task.revision}`}`,
      taskQueue: 'robb-tasks',
      searchAttributes: {
        RobbTaskId: task.id,
        RobbTaskRevision: task.revision,
        RobbProjectId: task.projectId,
        RobbRunId: task.latestRunId,
      },
      memo: {
        title: task.title,
        acceptanceCriteria: task.acceptanceCriteria,
        evidenceRefs: [...task.evidenceRefs],
      },
    },
  };
}
