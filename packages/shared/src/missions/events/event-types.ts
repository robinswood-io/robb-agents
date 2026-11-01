import { z } from "zod";
import { MissionSpecSchema, MissionExecutionBindingSchema, MissionAttemptTelemetrySchema, MissionWorkItemSchema, StructuredMissionVerdictSchema, WorkSubmissionSchema, type MissionSpec, type MissionExecutionBinding, type MissionAttemptTelemetry, type MissionStatus, type MissionWorkItem, type StructuredMissionVerdict, type WorkItemStatus, type WorkSubmission } from "../schema.ts";
import { type MissionReplanPreview } from "../digital-twin.ts";

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
