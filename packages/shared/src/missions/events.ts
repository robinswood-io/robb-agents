import { z } from 'zod';
import {
  MissionSpecSchema,
  MissionExecutionBindingSchema,
  MissionAttemptTelemetrySchema,
  MissionWorkItemSchema,
  StructuredMissionVerdictSchema,
  WorkSubmissionSchema,
  type MissionSpec,
  type MissionExecutionBinding,
  type MissionAttemptTelemetry,
  type MissionStatus,
  type MissionWorkItem,
  type StructuredMissionVerdict,
  type WorkItemStatus,
  type WorkSubmission,
} from './schema.ts';
import { previewMissionReplan, type MissionReplanPreview } from './digital-twin.ts';

const EventBaseSchema = z.object({ at: z.string().datetime() });

const MissionReplanPreviewSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().min(1),
  baseRevision: z.number().int().positive(),
  previousPlanVersion: z.number().int().positive(),
  nextPlanVersion: z.number().int().positive(),
  previousFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  proposedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  addedWorkItemIds: z.array(z.string().min(1)),
  removedWorkItemIds: z.array(z.string().min(1)),
  changedWorkItemIds: z.array(z.string().min(1)),
  invalidatedWorkItemIds: z.array(z.string().min(1)),
  preservedAcceptedWorkItemIds: z.array(z.string().min(1)),
}).strict();

export const MissionEventSchema = z.discriminatedUnion('kind', [
  EventBaseSchema.extend({ kind: z.literal('mission-created'), spec: MissionSpecSchema }),
  EventBaseSchema.extend({
    kind: z.literal('mission-replanned'),
    actorId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    proposedWorkItems: z.array(MissionWorkItemSchema).min(2),
    preview: MissionReplanPreviewSchema,
  }),
  EventBaseSchema.extend({
    kind: z.literal('mission-status-changed'),
    status: z.enum([
      'draft', 'running', 'correcting', 'objective-review', 'final-review',
      'paused', 'blocked', 'waiting-approval', 'completed', 'failed', 'cancelled',
    ]),
    reason: z.string().min(1).optional(),
  }),
  EventBaseSchema.extend({ kind: z.literal('work-item-added'), item: MissionWorkItemSchema }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-status-changed'),
    workItemId: z.string().min(1),
    status: z.enum([
      'pending', 'running', 'submitted', 'verifying', 'accepted',
      'reserved', 'rejected', 'superseded', 'blocked', 'cancelled',
    ]),
    reason: z.string().min(1).optional(),
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-dispatch-reserved'),
    workItemId: z.string().min(1),
    dispatchId: z.string().min(1),
    agentProfileId: z.string().min(1),
    binding: MissionExecutionBindingSchema,
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-dispatched'),
    workItemId: z.string().min(1),
    dispatchId: z.string().min(1),
    sessionId: z.string().min(1),
    agentProfileId: z.string().min(1),
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-session-bound'),
    workItemId: z.string().min(1),
    dispatchId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-turn-accepted'),
    workItemId: z.string().min(1),
    dispatchId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-attempt-failed'),
    workItemId: z.string().min(1),
    dispatchId: z.string().min(1),
    reason: z.string().min(1),
    retryable: z.boolean(),
    ambiguousMutation: z.boolean().default(false),
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-attempt-metered'),
    workItemId: z.string().min(1),
    dispatchId: z.string().min(1),
    telemetry: MissionAttemptTelemetrySchema,
  }),
  EventBaseSchema.extend({
    kind: z.literal('work-item-submitted'),
    workItemId: z.string().min(1),
    sessionId: z.string().min(1),
    submission: WorkSubmissionSchema,
  }),
  EventBaseSchema.extend({
    kind: z.literal('verdict-recorded'),
    workItemId: z.string().min(1),
    sessionId: z.string().min(1),
    verdict: StructuredMissionVerdictSchema,
  }),
  EventBaseSchema.extend({
    kind: z.literal('correction-cycle-started'),
    objectiveId: z.string().min(1),
    cycle: z.number().int().positive(),
  }),
  EventBaseSchema.extend({
    kind: z.literal('mission-report-dispatch-reserved'),
    reportId: z.string().min(1),
    originSessionId: z.string().min(1),
  }),
  EventBaseSchema.extend({
    kind: z.literal('mission-report-turn-accepted'),
    reportId: z.string().min(1),
    originSessionId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  EventBaseSchema.extend({
    kind: z.literal('mission-report-delivered'),
    reportId: z.string().min(1),
    originSessionId: z.string().min(1),
    finalMessageId: z.string().min(1),
  }),
  EventBaseSchema.extend({
    kind: z.literal('mission-report-failed'),
    reportId: z.string().min(1),
    originSessionId: z.string().min(1),
    reason: z.string().min(1),
  }),
]);

export type MissionEvent = z.infer<typeof MissionEventSchema>;

export interface MissionReplanJournalRecord extends MissionReplanPreview {
  actorId: string;
  reason: string;
  at: string;
}

export interface MissionWorkItemRuntime {
  definition: MissionWorkItem;
  status: WorkItemStatus;
  attempt: number;
  sessionId?: string;
  agentProfileId?: string;
  dispatchId?: string;
  executionBinding?: MissionExecutionBinding;
  executionHistory: string[];
  externalSessionId?: string;
  externalSessionHistory: string[];
  acceptedMessageId?: string;
  attemptTelemetry: Array<MissionAttemptTelemetry & { dispatchId: string }>;
  submission?: WorkSubmission;
  verdict?: StructuredMissionVerdict;
  statusReason?: string;
  /** Host failure classification used to gate safe replanning of connector work. */
  lastAttemptAmbiguousMutation?: boolean;
}

export interface MissionSnapshot {
  spec: MissionSpec;
  status: MissionStatus;
  statusReason?: string;
  report?: {
    reportId: string;
    originSessionId: string;
    status: 'reserved' | 'accepted' | 'delivered' | 'failed';
    messageId?: string;
    finalMessageId?: string;
    reason?: string;
  };
  workItems: Record<string, MissionWorkItemRuntime>;
  correctionCycles: Record<string, number>;
  planVersion: number;
  replans: MissionReplanJournalRecord[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function requireItem(snapshot: MissionSnapshot, id: string): MissionWorkItemRuntime {
  const item = snapshot.workItems[id];
  if (!item) throw new Error(`Mission journal references unknown work item "${id}"`);
  return item;
}

/** Pure projection: the journal is the source of truth, never an in-memory chat. */
export function reduceMissionEvents(events: readonly MissionEvent[]): MissionSnapshot {
  const parsedEvents = events.map((event) => MissionEventSchema.parse(event));
  if (parsedEvents.length === 0 || parsedEvents[0]?.kind !== 'mission-created') {
    throw new Error('Mission journal must start with mission-created');
  }

  const first = parsedEvents[0];
  const workItems: Record<string, MissionWorkItemRuntime> = {};
  for (const definition of first.spec.workItems) {
    workItems[definition.id] = {
      definition,
      status: 'pending',
      attempt: 0,
      executionHistory: [],
      externalSessionHistory: [],
      attemptTelemetry: [],
    };
  }
  const snapshot: MissionSnapshot = {
    spec: first.spec,
    status: 'draft',
    workItems,
    correctionCycles: {},
    planVersion: 1,
    replans: [],
    revision: 1,
    createdAt: first.at,
    updatedAt: first.at,
  };

  for (const event of parsedEvents.slice(1)) {
    if (event.kind === 'mission-created') throw new Error('Mission journal contains multiple mission-created events');
    const reportEvent = event.kind.startsWith('mission-report-');
    if (['completed', 'failed', 'cancelled'].includes(snapshot.status) && !reportEvent) {
      throw new Error(`Mission journal contains an event after terminal status ${snapshot.status}`);
    }
    if (reportEvent && snapshot.status !== 'completed') {
      throw new Error(`Mission report event requires completed status, found ${snapshot.status}`);
    }
    snapshot.revision += 1;
    snapshot.updatedAt = event.at;

    switch (event.kind) {
      case 'mission-replanned': {
        const beforeRevision = snapshot.revision - 1;
        if (event.preview.baseRevision !== beforeRevision) {
          throw new Error(
            `Mission replan base revision mismatch: expected ${beforeRevision}, found ${event.preview.baseRevision}`,
          );
        }
        const expected = previewMissionReplan({
          snapshot: { ...snapshot, revision: beforeRevision },
          expectedRevision: beforeRevision,
          currentPlanVersion: snapshot.planVersion,
          proposedWorkItems: event.proposedWorkItems,
        });
        assertExactReplanPreview(event.preview, expected);

        const previousPlanIds = new Set(snapshot.spec.workItems.map((item) => item.id));
        const proposed = new Map(event.proposedWorkItems.map((item) => [item.id, item]));
        const invalidated = new Set(event.preview.invalidatedWorkItemIds);
        const nextWorkItems: Record<string, MissionWorkItemRuntime> = {};

        for (const [id, definition] of proposed) {
          const current = snapshot.workItems[id];
          if (current && !invalidated.has(id)) {
            nextWorkItems[id] = { ...current, definition };
            continue;
          }
          nextWorkItems[id] = resetRuntimeForReplan(definition, current);
        }
        // Controller-owned reviews/corrections are not members of spec.workItems.
        // Preserve only those whose derivation remains valid; impacted derived
        // work is removed so the controller can deterministically recreate it.
        for (const [id, current] of Object.entries(snapshot.workItems)) {
          if (previousPlanIds.has(id) || proposed.has(id) || invalidated.has(id)) continue;
          nextWorkItems[id] = current;
        }

        snapshot.spec = MissionSpecSchema.parse({
          ...snapshot.spec,
          workItems: event.proposedWorkItems,
        });
        snapshot.workItems = nextWorkItems;
        snapshot.planVersion = event.preview.nextPlanVersion;
        snapshot.replans.push({
          ...event.preview,
          actorId: event.actorId,
          reason: event.reason,
          at: event.at,
        });
        for (const objectiveId of Object.keys(snapshot.correctionCycles)) {
          if (invalidated.has(objectiveId)) delete snapshot.correctionCycles[objectiveId];
        }
        break;
      }
      case 'mission-status-changed':
        snapshot.status = event.status;
        snapshot.statusReason = event.reason;
        break;
      case 'work-item-added':
        if (snapshot.workItems[event.item.id]) throw new Error(`Duplicate work item "${event.item.id}" in mission journal`);
        snapshot.workItems[event.item.id] = {
          definition: event.item,
          status: 'pending',
          attempt: 0,
          executionHistory: [],
          externalSessionHistory: [],
          attemptTelemetry: [],
        };
        break;
      case 'work-item-status-changed': {
        const item = requireItem(snapshot, event.workItemId);
        item.status = event.status;
        item.statusReason = event.reason;
        if (event.status === 'pending') {
          item.dispatchId = undefined;
          item.executionBinding = undefined;
          item.sessionId = undefined;
          item.agentProfileId = undefined;
          item.externalSessionId = undefined;
          item.acceptedMessageId = undefined;
        }
        break;
      }
      case 'work-item-dispatch-reserved': {
        const item = requireItem(snapshot, event.workItemId);
        if (item.status !== 'pending') throw new Error(`Work item "${event.workItemId}" was reserved from ${item.status}`);
        item.status = 'reserved';
        item.dispatchId = event.dispatchId;
        item.executionBinding = event.binding;
        item.agentProfileId = event.agentProfileId;
        break;
      }
      case 'work-item-dispatched': {
        const item = requireItem(snapshot, event.workItemId);
        if (item.status !== 'reserved' || item.dispatchId !== event.dispatchId) {
          throw new Error(`Work item "${event.workItemId}" dispatch does not match its reservation`);
        }
        item.status = 'running';
        item.attempt += 1;
        item.sessionId = event.sessionId;
        item.agentProfileId = event.agentProfileId;
        item.executionHistory.push(event.sessionId);
        break;
      }
      case 'work-item-session-bound': {
        const item = requireItem(snapshot, event.workItemId);
        if ((item.status !== 'reserved' && item.status !== 'running') || item.dispatchId !== event.dispatchId) {
          throw new Error(`Session binding for "${event.workItemId}" does not match its active dispatch`);
        }
        if (item.externalSessionId && item.externalSessionId !== event.sessionId) {
          throw new Error(`Work item "${event.workItemId}" was rebound to another session`);
        }
        item.externalSessionId = event.sessionId;
        if (!item.externalSessionHistory.includes(event.sessionId)) item.externalSessionHistory.push(event.sessionId);
        break;
      }
      case 'work-item-turn-accepted': {
        const item = requireItem(snapshot, event.workItemId);
        if (item.status !== 'running' || item.dispatchId !== event.dispatchId ||
            item.externalSessionId !== event.sessionId) {
          throw new Error(`Accepted turn for "${event.workItemId}" does not match its bound session`);
        }
        if (item.acceptedMessageId && item.acceptedMessageId !== event.messageId) {
          throw new Error(`Work item "${event.workItemId}" accepted multiple message identities`);
        }
        item.acceptedMessageId = event.messageId;
        break;
      }
      case 'work-item-submitted': {
        const item = requireItem(snapshot, event.workItemId);
        if (item.status !== 'running' || item.sessionId !== event.sessionId) {
          throw new Error(`Work item "${event.workItemId}" submission does not match its running session`);
        }
        item.status = 'submitted';
        item.submission = event.submission;
        break;
      }
      case 'verdict-recorded':
        {
          const item = requireItem(snapshot, event.workItemId);
          if (item.status !== 'running' || item.sessionId !== event.sessionId ||
              (item.definition.kind !== 'objective-review' && item.definition.kind !== 'final-review')) {
            throw new Error(`Verdict for "${event.workItemId}" does not match a running review session`);
          }
          item.verdict = event.verdict;
        }
        break;
      case 'work-item-attempt-failed': {
        const item = requireItem(snapshot, event.workItemId);
        if ((item.status !== 'reserved' && item.status !== 'running') || item.dispatchId !== event.dispatchId) {
          throw new Error(`Failure for "${event.workItemId}" does not match its active dispatch`);
        }
        item.statusReason = event.reason;
        item.lastAttemptAmbiguousMutation = event.ambiguousMutation;
        break;
      }
      case 'work-item-attempt-metered': {
        const item = requireItem(snapshot, event.workItemId);
        if ((item.status !== 'reserved' && item.status !== 'running') || item.dispatchId !== event.dispatchId) {
          throw new Error(`Telemetry for "${event.workItemId}" does not match its active dispatch`);
        }
        if (item.attemptTelemetry.some((entry) => entry.dispatchId === event.dispatchId)) {
          throw new Error(`Telemetry for dispatch "${event.dispatchId}" was recorded more than once`);
        }
        item.attemptTelemetry.push({ dispatchId: event.dispatchId, ...event.telemetry });
        break;
      }
      case 'correction-cycle-started':
        if (event.cycle !== (snapshot.correctionCycles[event.objectiveId] ?? 0) + 1) {
          throw new Error(`Non-monotonic correction cycle for objective "${event.objectiveId}"`);
        }
        snapshot.correctionCycles[event.objectiveId] = event.cycle;
        break;
      case 'mission-report-dispatch-reserved':
        if (snapshot.report) throw new Error('Mission report was reserved more than once');
        snapshot.report = {
          reportId: event.reportId,
          originSessionId: event.originSessionId,
          status: 'reserved',
        };
        break;
      case 'mission-report-turn-accepted':
        if (!snapshot.report || snapshot.report.reportId !== event.reportId ||
            snapshot.report.originSessionId !== event.originSessionId) {
          throw new Error('Mission report acceptance does not match its reservation');
        }
        if (snapshot.report.messageId && snapshot.report.messageId !== event.messageId) {
          throw new Error('Mission report accepted multiple message identities');
        }
        snapshot.report.status = 'accepted';
        snapshot.report.messageId = event.messageId;
        snapshot.report.reason = undefined;
        break;
      case 'mission-report-delivered':
        if (!snapshot.report || snapshot.report.reportId !== event.reportId ||
            snapshot.report.originSessionId !== event.originSessionId || !snapshot.report.messageId) {
          throw new Error('Mission report delivery does not match an accepted turn');
        }
        snapshot.report.status = 'delivered';
        snapshot.report.finalMessageId = event.finalMessageId;
        snapshot.report.reason = undefined;
        break;
      case 'mission-report-failed':
        if (!snapshot.report || snapshot.report.reportId !== event.reportId ||
            snapshot.report.originSessionId !== event.originSessionId || snapshot.report.status === 'delivered') {
          throw new Error('Mission report failure does not match an undelivered reservation');
        }
        snapshot.report.status = 'failed';
        snapshot.report.reason = event.reason;
        break;
    }
  }
  return snapshot;
}

function resetRuntimeForReplan(
  definition: MissionWorkItem,
  current?: MissionWorkItemRuntime,
): MissionWorkItemRuntime {
  return {
    definition,
    status: 'pending',
    attempt: current?.attempt ?? 0,
    executionHistory: current?.executionHistory ?? [],
    externalSessionHistory: current?.externalSessionHistory ?? [],
    attemptTelemetry: current?.attemptTelemetry ?? [],
    statusReason: current ? 'Invalidated by a journaled Mission replan' : undefined,
    lastAttemptAmbiguousMutation: undefined,
  };
}

function assertExactReplanPreview(
  actual: MissionReplanPreview,
  expected: MissionReplanPreview,
): void {
  const scalarKeys = [
    'schemaVersion',
    'missionId',
    'baseRevision',
    'previousPlanVersion',
    'nextPlanVersion',
    'previousFingerprint',
    'proposedFingerprint',
  ] as const;
  for (const key of scalarKeys) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Mission replan preview drift at ${key}`);
    }
  }
  const listKeys = [
    'addedWorkItemIds',
    'removedWorkItemIds',
    'changedWorkItemIds',
    'invalidatedWorkItemIds',
    'preservedAcceptedWorkItemIds',
  ] as const;
  for (const key of listKeys) {
    if (actual[key].length !== expected[key].length
        || actual[key].some((value, index) => value !== expected[key][index])) {
      throw new Error(`Mission replan preview drift at ${key}`);
    }
  }
}
