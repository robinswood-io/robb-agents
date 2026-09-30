import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/files.ts';
import type { TaskSpec } from './schema.ts';
import {
  listRunIds,
  readNodeOutput,
  readRunLog,
  readRunSpecSnapshot,
  taskDir,
  taskYamlPath,
  type NodeRunState,
  type RunLogEntry,
} from './storage.ts';
import { buildMissionControlSnapshot, planMissionReplay } from './mission-control.ts';
import type {
  ExecutionProofVerificationDecision,
  SignedExecutionProof,
  TaskExecutionProofBinding,
} from '../governance/execution-proof.ts';

const TASK_METADATA_FILE = 'task-meta.json';

export const DurableTaskExternalRefsSchema = z.object({
  craftTaskId: z.string().min(1).optional(),
  googleTaskId: z.string().min(1).optional(),
  temporalWorkflowId: z.string().min(1).optional(),
}).default({});

export const DurableTaskMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  archivedAt: z.string().datetime({ offset: true }).optional(),
  nextAction: z.string().min(1).optional(),
  orchestratorSessionId: z.string().min(1).optional(),
  externalRefs: DurableTaskExternalRefsSchema,
});

export type DurableTaskMetadata = z.infer<typeof DurableTaskMetadataSchema>;
export type DurableTaskExternalRefs = z.infer<typeof DurableTaskExternalRefsSchema>;

export type DurableTaskStatus =
  | 'ready'
  | 'running'
  | 'paused'
  | 'waiting-approval'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'archived';

export interface DurableTaskGraphNode {
  id: string;
  title: string;
  kind: string;
  dependsOn: string[];
  state: NodeRunState;
  attempt: number;
  sessionId?: string;
  model?: string;
  connectionSlug?: string;
  effect: 'read' | 'workspace-write' | 'external-mutation';
  outputAvailable: boolean;
  evidenceRefs: string[];
  proofHash?: string;
  repair: { allowed: boolean; reason: string };
}

export interface DurableTaskUserEvidence {
  actionRequested: string;
  actionAttempted: string[];
  mutationsApplied: string[];
  userVerification: string;
  remainingLimitations: string[];
}

export interface DurableTaskSnapshot {
  schemaVersion: 1;
  id: string;
  slug: string;
  revision: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  sources: string[];
  projectId?: string;
  executor: {
    runner: 'conduct' | 'orchestrate';
    agent: string;
    wrapper: string;
    model?: string;
    llmConnection?: string;
  };
  status: DurableTaskStatus;
  archived: boolean;
  archivedAt?: string;
  graph: { nodes: DurableTaskGraphNode[]; edges: Array<{ from: string; to: string }> };
  linkedSessions: {
    orchestratorSessionId?: string;
    nodes: Array<{ nodeId: string; sessionId: string }>;
  };
  latestRunId?: string;
  result: {
    verification: 'not-verified' | 'verified' | 'rejected' | 'inconclusive';
    summary: string;
    /** Latest available terminal-node output; evidence refs remain canonical. */
    output?: string;
  };
  evidenceRefs: string[];
  userEvidence: DurableTaskUserEvidence;
  nextAction: string;
  externalRefs: DurableTaskExternalRefs;
  visualState: {
    tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'muted';
    label: string;
    progressPercent: number;
    attentionRequired: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DurableTaskMetadataPatch {
  /** Optimistic concurrency guard for external cockpit synchronizers. */
  expectedRevision?: number;
  archived?: boolean;
  nextAction?: string | null;
  orchestratorSessionId?: string;
  externalRefs?: Partial<DurableTaskExternalRefs>;
}

export interface DurableTaskBuildOptions {
  runId?: string;
  verifyExecutionProof?: (
    proof: SignedExecutionProof,
    binding: TaskExecutionProofBinding,
  ) => ExecutionProofVerificationDecision;
  workspaceId?: string;
}

export function taskMetadataPath(workspaceRoot: string, slug: string): string {
  return join(taskDir(workspaceRoot, slug), TASK_METADATA_FILE);
}

function isoFromTaskFile(workspaceRoot: string, slug: string): string {
  try {
    return statSync(taskYamlPath(workspaceRoot, slug)).birthtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export function loadDurableTaskMetadata(workspaceRoot: string, slug: string): DurableTaskMetadata | null {
  try {
    const parsed = DurableTaskMetadataSchema.safeParse(
      JSON.parse(readFileSync(taskMetadataPath(workspaceRoot, slug), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Lazily materialize metadata for legacy task.yaml folders without rewriting their spec. */
export function ensureDurableTaskMetadata(
  workspaceRoot: string,
  slug: string,
  seed: Partial<Pick<DurableTaskMetadata, 'orchestratorSessionId'>> = {},
): DurableTaskMetadata {
  const existing = loadDurableTaskMetadata(workspaceRoot, slug);
  if (existing) {
    if (seed.orchestratorSessionId && !existing.orchestratorSessionId) {
      return updateDurableTaskMetadata(workspaceRoot, slug, {
        orchestratorSessionId: seed.orchestratorSessionId,
      });
    }
    return existing;
  }
  const createdAt = isoFromTaskFile(workspaceRoot, slug);
  const metadata: DurableTaskMetadata = {
    schemaVersion: 1,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    externalRefs: {},
    ...seed,
  };
  atomicWriteFileSync(taskMetadataPath(workspaceRoot, slug), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function updateDurableTaskMetadata(
  workspaceRoot: string,
  slug: string,
  patch: DurableTaskMetadataPatch,
  now = new Date().toISOString(),
): DurableTaskMetadata {
  const current = ensureDurableTaskMetadata(workspaceRoot, slug);
  if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
    throw new Error(
      `Durable task revision conflict for "${slug}": expected ${patch.expectedRevision}, current ${current.revision}`,
    );
  }
  const externalRefs = { ...current.externalRefs, ...patch.externalRefs };
  for (const key of Object.keys(externalRefs) as Array<keyof DurableTaskExternalRefs>) {
    if (!externalRefs[key]?.trim()) delete externalRefs[key];
  }
  const next: DurableTaskMetadata = {
    ...current,
    revision: current.revision + 1,
    updatedAt: now,
    externalRefs,
    ...(patch.orchestratorSessionId ? { orchestratorSessionId: patch.orchestratorSessionId } : {}),
  };
  if (patch.archived === true) next.archivedAt = current.archivedAt ?? now;
  else if (patch.archived === false) delete next.archivedAt;
  if (patch.nextAction === null || patch.nextAction?.trim() === '') delete next.nextAction;
  else if (patch.nextAction) next.nextAction = patch.nextAction.trim();
  const parsed = DurableTaskMetadataSchema.parse(next);
  atomicWriteFileSync(taskMetadataPath(workspaceRoot, slug), `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

function foldRunStatus(log: RunLogEntry[]): Exclude<DurableTaskStatus, 'ready' | 'archived'> {
  let status: Exclude<DurableTaskStatus, 'ready' | 'archived'> = 'running';
  for (const entry of log) {
    if (entry.kind === 'run-paused') status = 'paused';
    else if (entry.kind === 'run-resumed' || entry.kind === 'run-started') status = 'running';
    else if (entry.kind === 'approval-requested') status = 'waiting-approval';
    else if (entry.kind === 'approval-resolved') status = entry.decision === 'approved' ? 'running' : 'failed';
    else if (entry.kind === 'run-verifying') status = 'verifying';
    else if (entry.kind === 'run-completed') status = 'completed';
    else if (entry.kind === 'run-failed') status = 'failed';
    else if (entry.kind === 'run-stopped' || entry.kind === 'kill-switch') status = 'stopped';
  }
  return status;
}

function visualState(status: DurableTaskStatus, progressPercent: number): DurableTaskSnapshot['visualState'] {
  if (status === 'completed') return { tone: 'success', label: 'Verified complete', progressPercent, attentionRequired: false };
  if (status === 'failed') return { tone: 'danger', label: 'Repair required', progressPercent, attentionRequired: true };
  if (status === 'waiting-approval') return { tone: 'warning', label: 'Approval required', progressPercent, attentionRequired: true };
  if (status === 'paused' || status === 'stopped') return { tone: 'warning', label: status, progressPercent, attentionRequired: true };
  if (status === 'archived') return { tone: 'muted', label: 'Archived', progressPercent, attentionRequired: false };
  if (status === 'running' || status === 'verifying') return { tone: 'info', label: status, progressPercent, attentionRequired: false };
  return { tone: 'neutral', label: 'Ready', progressPercent, attentionRequired: false };
}

/** Build the product-level durable object from the executable spec + immutable run evidence. */
export function buildDurableTaskSnapshot(
  workspaceRoot: string,
  slug: string,
  liveSpec: TaskSpec,
  options: DurableTaskBuildOptions = {},
): DurableTaskSnapshot {
  const metadata = ensureDurableTaskMetadata(workspaceRoot, slug);
  const runIds = listRunIds(workspaceRoot, slug);
  const runId = options.runId ?? runIds.at(-1);
  const log = runId ? readRunLog(workspaceRoot, slug, runId) : [];
  const spec = (runId ? readRunSpecSnapshot(workspaceRoot, slug, runId) : null) ?? liveSpec;
  const state = new Map<string, NodeRunState>(spec.nodes.map((node) => [node.id, 'pending']));
  const attempts = new Map<string, number>();
  const sessions = new Map<string, string>();
  const routes = new Map<string, { model?: string; connectionSlug?: string }>();
  const proofs = new Map<string, string>();
  const actionAttempted: string[] = [];
  const mutationsApplied: string[] = [];
  let orchestratorSessionId = metadata.orchestratorSessionId;
  for (const entry of log) {
    if (entry.kind === 'run-started') orchestratorSessionId = entry.orchestratorSessionId ?? orchestratorSessionId;
    else if (entry.kind === 'node-scheduled') {
      state.set(entry.nodeId, 'running');
      attempts.set(entry.nodeId, (attempts.get(entry.nodeId) ?? 0) + 1);
      actionAttempted.push(`Scheduled ${entry.nodeId}`);
    } else if (entry.kind === 'node-spawned') {
      state.set(entry.nodeId, 'running');
      sessions.set(entry.nodeId, entry.sessionId);
    } else if (entry.kind === 'node-routed') {
      routes.set(entry.nodeId, { model: entry.model, connectionSlug: entry.connectionSlug });
    } else if (entry.kind === 'node-finished') {
      state.set(entry.nodeId, entry.state);
      if (entry.sessionId) sessions.set(entry.nodeId, entry.sessionId);
    } else if (entry.kind === 'node-reused') {
      state.set(entry.nodeId, 'done');
      proofs.set(entry.nodeId, entry.proofHash ?? 'reused-confirmed-output');
      actionAttempted.push(`Reused confirmed ${entry.nodeId}`);
    } else if (entry.kind === 'approval-requested') {
      state.set(entry.nodeId, 'waiting-approval');
    } else if (entry.kind === 'node-checkpoint' && entry.status === 'confirmed') {
      if (entry.proofHash) proofs.set(entry.nodeId, entry.proofHash);
      const effect = spec.nodes.find((node) => node.id === entry.nodeId)?.effect;
      if (effect && effect !== 'read') mutationsApplied.push(`Confirmed ${effect} at ${entry.nodeId}`);
    }
  }
  const replayPlan = runId
    ? planMissionReplay(spec, runId, log, (nodeId) => readNodeOutput(workspaceRoot, slug, runId, nodeId), {
        workspaceId: options.workspaceId,
        verifyExecutionProof: options.verifyExecutionProof,
      })
    : undefined;
  const replayByNode = new Map(replayPlan?.nodes.map((node) => [node.nodeId, node]));
  const nodeOutputs = new Map(
    runId
      ? spec.nodes.map((node) => [node.id, readNodeOutput(workspaceRoot, slug, runId, node.id)] as const)
      : [],
  );
  const graphNodes: DurableTaskGraphNode[] = spec.nodes.map((node) => {
    const replay = replayByNode.get(node.id);
    const outputAvailable = Boolean(nodeOutputs.get(node.id));
    const route = routes.get(node.id);
    const nodeEvidenceRefs = runId
      ? [
          `tasks/${slug}/runs/${runId}/run-log.jsonl#node=${node.id}`,
          ...(outputAvailable ? [`tasks/${slug}/runs/${runId}/nodes/${node.id}.json`] : []),
        ]
      : [];
    return {
      id: node.id,
      title: node.title ?? node.id,
      kind: node.kind,
      dependsOn: [...(node.depends_on ?? [])],
      state: state.get(node.id) ?? 'pending',
      attempt: attempts.get(node.id) ?? 0,
      sessionId: sessions.get(node.id),
      model: route?.model ?? node.model ?? spec.defaults?.model,
      connectionSlug: route?.connectionSlug ?? node.llmConnection ?? spec.defaults?.llmConnection,
      effect: node.effect,
      outputAvailable,
      evidenceRefs: nodeEvidenceRefs,
      proofHash: proofs.get(node.id),
      repair: {
        allowed: replay ? replay.action !== 'block' : node.effect === 'read',
        reason: replay?.reason ?? (node.effect === 'read' ? 'Node can be run safely.' : 'No reconciled proof is available.'),
      },
    };
  });
  const edges = spec.nodes.flatMap((node) =>
    (node.depends_on ?? []).map((dependency) => ({ from: dependency, to: node.id })),
  );
  const status: DurableTaskStatus = metadata.archivedAt
    ? 'archived'
    : log.length > 0
      ? foldRunStatus(log)
      : 'ready';
  const mission = runId ? buildMissionControlSnapshot(spec, runId, log) : undefined;
  const verdict = [...log].reverse().find((entry) => entry.kind === 'verdict');
  const verification = verdict?.kind !== 'verdict'
    ? 'not-verified'
    : verdict.result === 'pass'
      ? 'verified'
      : verdict.result === 'fail'
        ? 'rejected'
        : 'inconclusive';
  const limitations = [...(mission?.evaluation.failures ?? [])];
  if (replayPlan?.blockedNodeIds.length) limitations.push(`Replay blocked for: ${replayPlan.blockedNodeIds.join(', ')}`);
  const nextAction = metadata.nextAction
    ?? mission?.nextActions[0]
    ?? (status === 'ready' ? 'Start the first run' : status === 'completed' ? 'Archive or export the verified result' : 'Inspect task state');
  const evidenceRefs = [
    `tasks/${slug}/task.yaml`,
    ...(runId ? [`tasks/${slug}/runs/${runId}/run-log.jsonl`] : []),
    ...graphNodes.flatMap((node) => node.evidenceRefs.filter((ref) => ref.endsWith('.json'))),
  ];
  const progressPercent = mission?.progress.percent ?? 0;
  const agentResult = [...spec.nodes]
    .reverse()
    .map((node) => nodeOutputs.get(node.id)?.text?.trim())
    .find((text): text is string => Boolean(text));
  return {
    schemaVersion: 1,
    id: spec.id,
    slug,
    revision: metadata.revision,
    title: spec.title,
    description: spec.description ?? spec.goal,
    acceptanceCriteria: spec.acceptance_criteria ?? spec.goal,
    sources: [...(spec.sources ?? [])],
    projectId: spec.project,
    executor: {
      runner: spec.runner,
      agent: spec.executor?.agent ?? (spec.runner === 'conduct' ? 'conductor' : 'orchestrator'),
      wrapper: spec.executor?.wrapper ?? spec.runner,
      model: spec.executor?.model ?? spec.defaults?.model,
      llmConnection: spec.executor?.llmConnection ?? spec.defaults?.llmConnection,
    },
    status,
    archived: Boolean(metadata.archivedAt),
    archivedAt: metadata.archivedAt,
    graph: { nodes: graphNodes, edges },
    linkedSessions: {
      orchestratorSessionId,
      nodes: [...sessions].map(([nodeId, sessionId]) => ({ nodeId, sessionId })),
    },
    latestRunId: runId,
    result: {
      verification,
      summary: verdict?.kind === 'verdict'
        ? verdict.reason ?? `Acceptance verdict: ${verdict.result}`
        : 'No verified result has been recorded.',
      ...(agentResult ? { output: agentResult } : {}),
    },
    evidenceRefs: [...new Set(evidenceRefs)],
    userEvidence: {
      actionRequested: spec.goal,
      actionAttempted: [...new Set(actionAttempted)],
      mutationsApplied: [...new Set(mutationsApplied)],
      userVerification: verdict?.kind === 'verdict'
        ? `${verdict.result.toUpperCase()}: ${verdict.reason ?? 'acceptance gate recorded'}`
        : 'No user-facing acceptance verdict recorded.',
      remainingLimitations: [...new Set(limitations)],
    },
    nextAction,
    externalRefs: metadata.externalRefs,
    visualState: visualState(status, progressPercent),
    createdAt: metadata.createdAt,
    updatedAt: mission?.latestEventAt ?? metadata.updatedAt,
  };
}
