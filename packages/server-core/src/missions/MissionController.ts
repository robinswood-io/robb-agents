import {
  MissionEventSchema,
  MissionSpecSchema,
  StructuredMissionVerdictSchema,
  WorkSubmissionSchema,
  appendMissionEvents,
  loadMissionSnapshot,
  readMissionEvents,
  reduceMissionEvents,
  previewMissionReplan,
  type MissionEvent,
  type MissionExecutionBinding,
  type MissionAttemptTelemetry,
  type MissionSnapshot,
  type MissionSpec,
  type MissionWorkItem,
  type MissionWorkItemRuntime,
  type StructuredMissionVerdict,
  type WorkSubmission,
  type MissionReplanPreview,
} from '@craft-agent/shared/missions';

const EXECUTION_KINDS = new Set(['task', 'subtask', 'integration', 'correction']);
const REVIEW_KINDS = new Set(['objective-review', 'final-review']);
const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface MissionControllerOptions {
  workspaceRoot: string;
  now?: () => Date;
  /** Optional host boundary that resolves and hashes model-authored evidence. */
  resolveSubmissionEvidence?: (item: MissionWorkItem, submission: WorkSubmission) => WorkSubmission;
}

export interface ReadyMissionWork {
  item: MissionWorkItem;
  agentProfileId: string;
}

export interface MissionDispatchReservation {
  dispatchId: string;
  binding: MissionExecutionBinding;
}

export interface MissionReplanInput {
  expectedRevision: number;
  proposedWorkItems: MissionWorkItem[];
  actorId: string;
  reason: string;
}

function runtimeItems(snapshot: MissionSnapshot): MissionWorkItemRuntime[] {
  return Object.values(snapshot.workItems);
}

function isExecution(item: MissionWorkItem): boolean {
  return EXECUTION_KINDS.has(item.kind);
}

function isReview(item: MissionWorkItem): boolean {
  return REVIEW_KINDS.has(item.kind);
}

function profileFor(snapshot: MissionSnapshot, item: MissionWorkItem): string {
  if (item.kind === 'objective-review') return snapshot.spec.reviewerProfileId;
  if (item.kind === 'final-review') return snapshot.spec.supervisorProfileId;
  return item.agentProfileId ?? snapshot.spec.defaultWorkerProfileId;
}

function replacementFor(snapshot: MissionSnapshot, workItemId: string): MissionWorkItemRuntime | undefined {
  return runtimeItems(snapshot).find((candidate) => candidate.definition.correctsWorkItemId === workItemId);
}

function currentReplacement(snapshot: MissionSnapshot, workItemId: string): MissionWorkItemRuntime {
  let current = snapshot.workItems[workItemId];
  if (!current) throw new Error(`Unknown work item "${workItemId}"`);
  const seen = new Set<string>();
  while (current.status === 'superseded') {
    if (seen.has(current.definition.id)) throw new Error(`Correction lineage cycle at "${current.definition.id}"`);
    seen.add(current.definition.id);
    const replacement = replacementFor(snapshot, current.definition.id);
    if (!replacement) throw new Error(`Superseded work item "${current.definition.id}" has no correction`);
    current = replacement;
  }
  return current;
}

function dependencySatisfied(snapshot: MissionSnapshot, dependencyId: string): boolean {
  const dependency = currentReplacement(snapshot, dependencyId);
  if (dependency.definition.kind === 'objective') return dependency.status === 'accepted';
  return dependency.status === 'submitted' || dependency.status === 'accepted';
}

function currentObjectiveExecution(snapshot: MissionSnapshot, objectiveId: string): MissionWorkItemRuntime[] {
  return runtimeItems(snapshot).filter((runtime) =>
    runtime.definition.objectiveId === objectiveId && isExecution(runtime.definition) && runtime.status !== 'superseded',
  );
}

function objectiveIds(snapshot: MissionSnapshot): string[] {
  return runtimeItems(snapshot)
    .filter((runtime) => runtime.definition.kind === 'objective')
    .map((runtime) => runtime.definition.id);
}

function objectiveForWork(snapshot: MissionSnapshot, workItemId: string): string {
  const item = snapshot.workItems[workItemId];
  if (!item || !isExecution(item.definition) || !item.definition.objectiveId) {
    throw new Error(`Affected work item "${workItemId}" is not executable objective work`);
  }
  return item.definition.objectiveId;
}

function uniqueId(snapshot: MissionSnapshot, base: string, reserved: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (snapshot.workItems[candidate] || reserved.has(candidate)) candidate = `${base}-${suffix++}`;
  reserved.add(candidate);
  return candidate;
}

function hasReconciledMutationReceipt(runtime: MissionWorkItemRuntime): boolean {
  const requirementId = runtime.definition.connectorInvocation?.receiptRequirementId;
  if (!requirementId || !runtime.submission) return false;
  return runtime.submission.evidence.some((evidence) =>
    evidence.requirementId === requirementId
    && evidence.kind === 'receipt'
    && typeof evidence.sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(evidence.sha256));
}

function sameConnectorInvocation(left: MissionWorkItem, right: MissionWorkItem): boolean {
  return JSON.stringify(left.connectorInvocation) === JSON.stringify(right.connectorInvocation);
}

/**
 * Side-effect-free admission check shared by replan preview and commit.
 *
 * Keeping this check outside MissionController lets host RPC preview a plan
 * without constructing an executor or any connector transport.
 */
export function previewAdmissibleMissionReplan(input: {
  snapshot: MissionSnapshot;
  expectedRevision: number;
  proposedWorkItems: MissionWorkItem[];
}): MissionReplanPreview {
  const { snapshot, expectedRevision, proposedWorkItems } = input;
  const missionId = snapshot.spec.id;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error('Mission replan expectedRevision must be a positive integer');
  }
  if (TERMINAL_MISSION_STATUSES.has(snapshot.status)) {
    throw new Error(`Mission "${missionId}" is terminal and cannot be replanned`);
  }
  const active = runtimeItems(snapshot).filter((runtime) =>
    runtime.status === 'reserved' || runtime.status === 'running');
  if (active.length > 0) {
    throw new Error(
      `Mission replan refused while work leases are active: ${active.map(({ definition }) => definition.id).sort().join(', ')}`,
    );
  }

  const preview = previewMissionReplan({
    snapshot,
    expectedRevision,
    currentPlanVersion: snapshot.planVersion,
    proposedWorkItems,
  });
  const proposed = new Map(proposedWorkItems.map((item) => [item.id, item]));
  const invalidated = new Set(preview.invalidatedWorkItemIds);
  for (const runtime of runtimeItems(snapshot)) {
    if (runtime.definition.effect !== 'external-mutation' || runtime.attempt === 0) continue;
    if (!hasReconciledMutationReceipt(runtime)) {
      if (runtime.lastAttemptAmbiguousMutation === false) continue;
      throw new Error(
        `Mission replan refused: external mutation "${runtime.definition.id}" is not durably reconciled`,
      );
    }
    if (!invalidated.has(runtime.definition.id)) continue;
    const replacement = proposed.get(runtime.definition.id);
    if (!replacement || !sameConnectorInvocation(runtime.definition, replacement)) {
      throw new Error(
        `Mission replan refused: reconciled mutation "${runtime.definition.id}" requires explicit compensation before removal or invocation change`,
      );
    }
  }
  return preview;
}

export class MissionController {
  private readonly workspaceRoot: string;
  private readonly now: () => Date;
  private readonly resolveSubmissionEvidence?: MissionControllerOptions['resolveSubmissionEvidence'];

  constructor(options: MissionControllerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.now = options.now ?? (() => new Date());
    this.resolveSubmissionEvidence = options.resolveSubmissionEvidence;
  }

  private at(): string {
    return this.now().toISOString();
  }

  private event<T extends Omit<MissionEvent, 'at'>>(event: T): MissionEvent {
    return MissionEventSchema.parse({ ...event, at: this.at() });
  }

  private telemetryEvent(
    workItemId: string,
    dispatchId: string,
    telemetry?: MissionAttemptTelemetry,
  ): MissionEvent[] {
    return telemetry
      ? [this.event({ kind: 'work-item-attempt-metered', workItemId, dispatchId, telemetry })]
      : [];
  }

  private requireMission(missionId: string): MissionSnapshot {
    const snapshot = loadMissionSnapshot(this.workspaceRoot, missionId);
    if (!snapshot) throw new Error(`Unknown mission "${missionId}"`);
    return snapshot;
  }

  private preview(missionId: string, events: readonly MissionEvent[]): MissionSnapshot {
    return reduceMissionEvents([...readMissionEvents(this.workspaceRoot, missionId), ...events]);
  }

  private commit(missionId: string, revision: number, events: readonly MissionEvent[]): MissionSnapshot {
    appendMissionEvents(this.workspaceRoot, missionId, events, revision);
    return this.requireMission(missionId);
  }

  createMission(input: MissionSpec): MissionSnapshot {
    const spec = MissionSpecSchema.parse(input);
    if (loadMissionSnapshot(this.workspaceRoot, spec.id)) throw new Error(`Mission "${spec.id}" already exists`);
    const event = this.event({ kind: 'mission-created', spec });
    appendMissionEvents(this.workspaceRoot, spec.id, [event], 0);
    return this.requireMission(spec.id);
  }

  getMission(missionId: string): MissionSnapshot {
    return this.requireMission(missionId);
  }

  previewReplan(
    missionId: string,
    expectedRevision: number,
    proposedWorkItems: MissionWorkItem[],
  ): MissionReplanPreview {
    const snapshot = this.requireMission(missionId);
    return previewAdmissibleMissionReplan({
      snapshot,
      expectedRevision,
      proposedWorkItems,
    });
  }

  replanMission(missionId: string, input: MissionReplanInput): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    if (!input.actorId.trim()) throw new Error('Mission replan actor identity is required');
    if (!input.reason.trim()) throw new Error('Mission replan reason is required');
    const preview = previewAdmissibleMissionReplan({
      snapshot,
      expectedRevision: input.expectedRevision,
      proposedWorkItems: input.proposedWorkItems,
    });

    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'mission-replanned',
      actorId: input.actorId.trim(),
      reason: input.reason.trim(),
      proposedWorkItems: input.proposedWorkItems,
      preview,
    })]);
  }

  startMission(missionId: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    if (snapshot.status !== 'draft' && snapshot.status !== 'paused') {
      throw new Error(`Mission "${missionId}" cannot start from ${snapshot.status}`);
    }
    return this.commit(missionId, snapshot.revision, [this.event({ kind: 'mission-status-changed', status: 'running' })]);
  }

  pauseMission(missionId: string, reason: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    if (TERMINAL_MISSION_STATUSES.has(snapshot.status)) throw new Error(`Mission "${missionId}" is terminal`);
    return this.commit(missionId, snapshot.revision, [
      this.event({ kind: 'mission-status-changed', status: 'paused', reason }),
    ]);
  }

  waitForWorkItemApproval(
    missionId: string,
    workItemId: string,
    dispatchId: string,
    reason: string,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || runtime.status !== 'running' || runtime.dispatchId !== dispatchId ||
        runtime.definition.effect !== 'external-mutation') {
      throw new Error(`Work item "${workItemId}" has no matching brokered mutation awaiting approval`);
    }
    if (snapshot.status === 'waiting-approval' && snapshot.statusReason === reason) return snapshot;
    return this.commit(missionId, snapshot.revision, [
      this.event({ kind: 'mission-status-changed', status: 'waiting-approval', reason }),
    ]);
  }

  resumeAfterApproval(missionId: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    if (snapshot.status !== 'waiting-approval') {
      throw new Error(`Mission "${missionId}" is not waiting for approval`);
    }
    return this.commit(missionId, snapshot.revision, [
      this.event({ kind: 'mission-status-changed', status: 'running', reason: 'Host approval resolved' }),
    ]);
  }

  listReadyWork(missionId: string): ReadyMissionWork[] {
    const snapshot = this.requireMission(missionId);
    if (['draft', 'paused', 'blocked', 'waiting-approval', 'completed', 'failed', 'cancelled'].includes(snapshot.status)) return [];
    const running = runtimeItems(snapshot).filter((item) =>
      item.status === 'reserved' || item.status === 'running').length;
    const available = Math.max(0, snapshot.spec.policy.maxConcurrentAgents - running);
    return runtimeItems(snapshot)
      .filter((runtime) =>
        runtime.status === 'pending' &&
        (isExecution(runtime.definition) || isReview(runtime.definition)) &&
        runtime.definition.dependsOn.every((id) => dependencySatisfied(snapshot, id)),
      )
      .slice(0, available)
      .map((runtime) => ({ item: runtime.definition, agentProfileId: profileFor(snapshot, runtime.definition) }));
  }

  dispatchWorkItem(missionId: string, workItemId: string, sessionId: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const ready = this.listReadyWork(missionId).find(({ item }) => item.id === workItemId);
    if (!ready) throw new Error(`Work item "${workItemId}" is not ready or concurrency is exhausted`);
    this.assertIndependentSession(snapshot, ready.item, sessionId);
    const dispatchId = `manual-${workItemId}-${snapshot.workItems[workItemId]!.attempt + 1}`;
    return this.commit(missionId, snapshot.revision, [
      this.event({
        kind: 'work-item-dispatch-reserved',
        workItemId,
        dispatchId,
        agentProfileId: ready.agentProfileId,
        binding: { executorKind: 'session', executionId: sessionId },
      }),
      this.event({
        kind: 'work-item-dispatched',
        workItemId,
        dispatchId,
        sessionId,
        agentProfileId: ready.agentProfileId,
      }),
    ]);
  }

  reserveWorkItem(
    missionId: string,
    workItemId: string,
    reservation: MissionDispatchReservation,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const ready = this.listReadyWork(missionId).find(({ item }) => item.id === workItemId);
    if (!ready) throw new Error(`Work item "${workItemId}" is not ready or concurrency is exhausted`);
    if (!reservation.dispatchId.trim()) throw new Error('dispatchId is required');
    const binding = reservation.binding;
    if (runtimeItems(snapshot).some((runtime) =>
      runtime.dispatchId === reservation.dispatchId ||
      runtime.executionBinding?.executionId === binding.executionId)) {
      throw new Error(`Mission dispatch or execution identity already exists for "${workItemId}"`);
    }
    this.assertIndependentSession(snapshot, ready.item, binding.executionId);
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'work-item-dispatch-reserved',
      workItemId,
      dispatchId: reservation.dispatchId,
      agentProfileId: ready.agentProfileId,
      binding,
    })]);
  }

  confirmWorkItemDispatch(missionId: string, workItemId: string, dispatchId: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || runtime.status !== 'reserved' || runtime.dispatchId !== dispatchId ||
        !runtime.executionBinding || !runtime.agentProfileId) {
      throw new Error(`Work item "${workItemId}" has no matching dispatch reservation`);
    }
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'work-item-dispatched',
      workItemId,
      dispatchId,
      sessionId: runtime.executionBinding.executionId,
      agentProfileId: runtime.agentProfileId,
    })]);
  }

  bindWorkItemSession(
    missionId: string,
    workItemId: string,
    dispatchId: string,
    sessionId: string,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || (runtime.status !== 'reserved' && runtime.status !== 'running') ||
        runtime.dispatchId !== dispatchId) {
      throw new Error(`Work item "${workItemId}" has no matching active dispatch`);
    }
    if (runtime.externalSessionId === sessionId) return snapshot;
    if (runtime.externalSessionId) {
      throw new Error(`Work item "${workItemId}" is already bound to session "${runtime.externalSessionId}"`);
    }
    this.assertIndependentSession(snapshot, runtime.definition, sessionId, true);
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'work-item-session-bound', workItemId, dispatchId, sessionId,
    })]);
  }

  recordWorkItemTurnAccepted(
    missionId: string,
    workItemId: string,
    dispatchId: string,
    sessionId: string,
    messageId: string,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || runtime.status !== 'running' || runtime.dispatchId !== dispatchId ||
        runtime.externalSessionId !== sessionId) {
      throw new Error(`Work item "${workItemId}" has no matching bound session turn`);
    }
    if (runtime.acceptedMessageId === messageId) return snapshot;
    if (runtime.acceptedMessageId) {
      throw new Error(`Work item "${workItemId}" already accepted message "${runtime.acceptedMessageId}"`);
    }
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'work-item-turn-accepted', workItemId, dispatchId, sessionId, messageId,
    })]);
  }

  cancelMission(missionId: string, reason: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    if (TERMINAL_MISSION_STATUSES.has(snapshot.status)) {
      if (snapshot.status === 'cancelled') return snapshot;
      throw new Error(`Mission "${missionId}" is terminal`);
    }
    const events: MissionEvent[] = runtimeItems(snapshot)
      .filter((runtime) => !['accepted', 'rejected', 'superseded', 'cancelled'].includes(runtime.status))
      .map((runtime) => this.event({
        kind: 'work-item-status-changed',
        workItemId: runtime.definition.id,
        status: 'cancelled',
        reason,
      }));
    events.push(this.event({ kind: 'mission-status-changed', status: 'cancelled', reason }));
    return this.commit(missionId, snapshot.revision, events);
  }

  reserveMissionReport(missionId: string, reportId: string, originSessionId: string): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    if (snapshot.status !== 'completed') throw new Error(`Mission "${missionId}" is not completed`);
    if (snapshot.report) {
      if (snapshot.report.reportId === reportId && snapshot.report.originSessionId === originSessionId) return snapshot;
      throw new Error(`Mission "${missionId}" already has a report reservation`);
    }
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'mission-report-dispatch-reserved', reportId, originSessionId,
    })]);
  }

  recordMissionReportAccepted(
    missionId: string,
    reportId: string,
    originSessionId: string,
    messageId: string,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const report = snapshot.report;
    if (!report || report.reportId !== reportId || report.originSessionId !== originSessionId) {
      throw new Error(`Mission "${missionId}" has no matching report reservation`);
    }
    if (report.messageId === messageId) return snapshot;
    if (report.messageId) throw new Error(`Mission "${missionId}" report already accepted another message`);
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'mission-report-turn-accepted', reportId, originSessionId, messageId,
    })]);
  }

  recordMissionReportDelivered(
    missionId: string,
    reportId: string,
    originSessionId: string,
    finalMessageId: string,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const report = snapshot.report;
    if (!report || report.reportId !== reportId || report.originSessionId !== originSessionId || !report.messageId) {
      throw new Error(`Mission "${missionId}" has no matching accepted report turn`);
    }
    if (report.status === 'delivered') {
      if (report.finalMessageId === finalMessageId) return snapshot;
      throw new Error(`Mission "${missionId}" report already delivered another message`);
    }
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'mission-report-delivered', reportId, originSessionId, finalMessageId,
    })]);
  }

  recordMissionReportFailed(
    missionId: string,
    reportId: string,
    originSessionId: string,
    reason: string,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const report = snapshot.report;
    if (!report || report.reportId !== reportId || report.originSessionId !== originSessionId || report.status === 'delivered') {
      throw new Error(`Mission "${missionId}" has no matching undelivered report`);
    }
    return this.commit(missionId, snapshot.revision, [this.event({
      kind: 'mission-report-failed', reportId, originSessionId, reason,
    })]);
  }

  failWorkItemAttempt(
    missionId: string,
    workItemId: string,
    dispatchId: string,
    failure: {
      reason: string;
      retryable: boolean;
      ambiguousMutation?: boolean;
      telemetry?: MissionAttemptTelemetry;
    },
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || (runtime.status !== 'reserved' && runtime.status !== 'running') ||
        runtime.dispatchId !== dispatchId) {
      throw new Error(`Work item "${workItemId}" has no matching active dispatch`);
    }
    const ambiguousMutation = failure.ambiguousMutation ?? false;
    const canRetry = failure.retryable && !ambiguousMutation && runtime.definition.effect === 'read' &&
      runtime.attempt < snapshot.spec.policy.maxTechnicalAttempts;
    const events: MissionEvent[] = [
      ...this.telemetryEvent(workItemId, dispatchId, failure.telemetry),
      this.event({
      kind: 'work-item-attempt-failed',
      workItemId,
      dispatchId,
      reason: failure.reason,
      retryable: failure.retryable,
      ambiguousMutation,
      }),
    ];
    if (canRetry) {
      events.push(this.event({
        kind: 'work-item-status-changed', workItemId, status: 'pending', reason: failure.reason,
      }));
      const correcting = runtimeItems(snapshot).some((item) =>
        item.definition.kind === 'correction' && !['accepted', 'superseded', 'cancelled'].includes(item.status));
      events.push(this.event({
        kind: 'mission-status-changed', status: correcting ? 'correcting' : 'running', reason: failure.reason,
      }));
    } else {
      events.push(this.event({
        kind: 'work-item-status-changed', workItemId, status: 'blocked', reason: failure.reason,
      }));
      events.push(this.event({
        kind: 'mission-status-changed', status: 'blocked',
        reason: ambiguousMutation
          ? `Mutation outcome is ambiguous for "${workItemId}": ${failure.reason}`
          : failure.reason,
      }));
    }
    this.preservePause(missionId, snapshot, events);
    return this.commit(missionId, snapshot.revision, events);
  }

  submitWorkItem(
    missionId: string,
    workItemId: string,
    sessionId: string,
    input: WorkSubmission,
    telemetry?: MissionAttemptTelemetry,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || !isExecution(runtime.definition)) throw new Error(`Work item "${workItemId}" is not executable work`);
    if (runtime.status !== 'running' || runtime.sessionId !== sessionId) {
      throw new Error(`Work item "${workItemId}" is not running in session "${sessionId}"`);
    }
    let submission = WorkSubmissionSchema.parse(input);
    const required = new Set(runtime.definition.requiredEvidence.map((requirement) => requirement.id));
    const supplied = new Set(submission.evidence.map((evidence) => evidence.requirementId));
    const missing = [...required].filter((id) => !supplied.has(id));
    if (missing.length > 0) throw new Error(`Missing required evidence: ${missing.join(', ')}`);
    if (this.resolveSubmissionEvidence) {
      submission = WorkSubmissionSchema.parse(
        this.resolveSubmissionEvidence(runtime.definition, submission),
      );
    }

    const events: MissionEvent[] = [
      ...this.telemetryEvent(workItemId, runtime.dispatchId!, telemetry),
      this.event({ kind: 'work-item-submitted', workItemId, sessionId, submission }),
    ];
    this.addReadyReviews(missionId, events);
    this.preservePause(missionId, snapshot, events);
    return this.commit(missionId, snapshot.revision, events);
  }

  recordVerdict(
    missionId: string,
    reviewWorkItemId: string,
    sessionId: string,
    input: StructuredMissionVerdict,
    telemetry?: MissionAttemptTelemetry,
  ): MissionSnapshot {
    const snapshot = this.requireMission(missionId);
    const review = snapshot.workItems[reviewWorkItemId];
    if (!review || !isReview(review.definition)) throw new Error(`Work item "${reviewWorkItemId}" is not a review`);
    if (review.status !== 'running' || review.sessionId !== sessionId) {
      throw new Error(`Review "${reviewWorkItemId}" is not running in session "${sessionId}"`);
    }
    const verdict = StructuredMissionVerdictSchema.parse(input);
    this.assertVerdictContract(snapshot, review.definition, verdict);

    const events: MissionEvent[] = [
      ...this.telemetryEvent(reviewWorkItemId, review.dispatchId!, telemetry),
      this.event({ kind: 'verdict-recorded', workItemId: reviewWorkItemId, sessionId, verdict }),
    ];
    if (verdict.result === 'pass') {
      this.applyPass(missionId, snapshot, review.definition, events);
    } else if (verdict.result === 'inconclusive') {
      events.push(this.event({ kind: 'work-item-status-changed', workItemId: reviewWorkItemId, status: 'blocked', reason: verdict.summary }));
      if (review.definition.kind === 'objective-review') {
        events.push(this.event({ kind: 'work-item-status-changed', workItemId: verdict.targetId, status: 'blocked', reason: verdict.summary }));
      }
      events.push(this.event({ kind: 'mission-status-changed', status: 'blocked', reason: verdict.summary }));
    } else {
      this.applyFailure(missionId, snapshot, review.definition, verdict, events);
    }
    this.preservePause(missionId, snapshot, events);
    return this.commit(missionId, snapshot.revision, events);
  }

  private preservePause(
    missionId: string,
    before: MissionSnapshot,
    events: MissionEvent[],
  ): void {
    if (before.status !== 'paused') return;
    const projected = this.preview(missionId, events);
    if (TERMINAL_MISSION_STATUSES.has(projected.status) ||
        projected.status === 'blocked' || projected.status === 'waiting-approval') return;
    events.push(this.event({
      kind: 'mission-status-changed',
      status: 'paused',
      reason: before.statusReason ?? 'Pause preserved after in-flight work settled',
    }));
  }

  private assertIndependentSession(
    snapshot: MissionSnapshot,
    item: MissionWorkItem,
    sessionId: string,
    external = false,
  ): void {
    if (!isReview(item)) return;
    const forbidden = new Set<string>();
    if (snapshot.spec.originSessionId) forbidden.add(snapshot.spec.originSessionId);
    if (snapshot.spec.plannerSessionId) forbidden.add(snapshot.spec.plannerSessionId);
    for (const runtime of runtimeItems(snapshot)) {
      if (runtime.definition.id === item.id) continue;
      if (item.kind === 'final-review' ||
          (isExecution(runtime.definition) && runtime.definition.objectiveId === item.reviewTargetId)) {
        const history = external ? runtime.externalSessionHistory : runtime.executionHistory;
        for (const executionId of history) forbidden.add(executionId);
      }
    }
    if (forbidden.has(sessionId)) {
      throw new Error(`${item.kind} requires an independent session; "${sessionId}" already participated in scope`);
    }
  }

  private assertVerdictContract(
    snapshot: MissionSnapshot,
    review: MissionWorkItem,
    verdict: StructuredMissionVerdict,
  ): void {
    const final = review.kind === 'final-review';
    const expectedType = final ? 'mission' : 'objective';
    const expectedTarget = final ? snapshot.spec.id : review.reviewTargetId;
    if (verdict.targetType !== expectedType || verdict.targetId !== expectedTarget) {
      throw new Error(`Verdict target must be ${expectedType} "${expectedTarget}"`);
    }
    const rubric = final
      ? snapshot.spec.acceptanceCriteria
      : snapshot.workItems[expectedTarget!]?.definition.acceptanceCriteria;
    if (!rubric) throw new Error(`Unknown review target "${expectedTarget}"`);
    const expectedIds = new Set(rubric.map((criterion) => criterion.id));
    const actualIds = verdict.criteria.map((criterion) => criterion.criterionId);
    if (new Set(actualIds).size !== actualIds.length || actualIds.length !== expectedIds.size ||
        actualIds.some((id) => !expectedIds.has(id))) {
      throw new Error(`Verdict must cover each target criterion exactly once: ${[...expectedIds].join(', ')}`);
    }
    for (const affectedId of verdict.affectedWorkItemIds) {
      const affected = snapshot.workItems[affectedId];
      if (!affected || !isExecution(affected.definition) || affected.status === 'superseded') {
        throw new Error(`Affected work item "${affectedId}" is not current executable work`);
      }
      if (!final && affected.definition.objectiveId !== expectedTarget) {
        throw new Error(`Affected work item "${affectedId}" is outside objective "${expectedTarget}"`);
      }
    }
    const affectedSet = new Set(verdict.affectedWorkItemIds);
    for (const correction of verdict.corrections) {
      if (!affectedSet.has(correction.correctsWorkItemId)) {
        throw new Error(`Correction brief references unaffected work item "${correction.correctsWorkItemId}"`);
      }
      if (correction.agentProfileId) {
        const profile = snapshot.spec.agentProfiles.find(({ id }) => id === correction.agentProfileId);
        if (!profile || profile.role !== 'worker') throw new Error(`Correction profile "${correction.agentProfileId}" is not a worker`);
      }
    }
  }

  private addReadyReviews(missionId: string, events: MissionEvent[]): void {
    let snapshot = this.preview(missionId, events);
    const reserved = new Set<string>();
    let addedObjectiveReview = false;
    for (const objectiveId of objectiveIds(snapshot)) {
      const objective = snapshot.workItems[objectiveId];
      if (objective.status === 'accepted' || objective.status === 'blocked') continue;
      const frontier = currentObjectiveExecution(snapshot, objectiveId);
      if (frontier.length === 0 || frontier.some((item) => item.status !== 'submitted' && item.status !== 'accepted')) continue;
      const cycle = snapshot.correctionCycles[objectiveId] ?? 0;
      const expectedBase = `review-${objectiveId}-${cycle}`;
      if (runtimeItems(snapshot).some((item) => item.definition.kind === 'objective-review' && item.definition.id.startsWith(expectedBase))) continue;
      if (runtimeItems(snapshot).length + 1 > snapshot.spec.policy.maxWorkItems) {
        events.push(this.event({
          kind: 'mission-status-changed', status: 'failed',
          reason: 'Mission maxWorkItems exceeded by objective review',
        }));
        return;
      }
      const item: MissionWorkItem = {
        id: uniqueId(snapshot, expectedBase, reserved),
        kind: 'objective-review',
        title: `Contrôle de l'objectif : ${objective.definition.title}`,
        prompt: `Évaluer indépendamment l'objectif "${objective.definition.title}" et rendre un verdict structuré fondé sur les preuves.`,
        parentId: objectiveId,
        objectiveId,
        dependsOn: frontier.map((candidate) => candidate.definition.id),
        reviewTargetId: objectiveId,
        acceptanceCriteria: objective.definition.acceptanceCriteria,
        requiredEvidence: [],
        agentProfileId: snapshot.spec.reviewerProfileId,
        effect: 'read',
      };
      events.push(this.event({ kind: 'work-item-added', item }));
      addedObjectiveReview = true;
      snapshot = this.preview(missionId, events);
    }
    if (addedObjectiveReview) {
      events.push(this.event({ kind: 'mission-status-changed', status: 'objective-review' }));
    }
  }

  private applyPass(
    missionId: string,
    before: MissionSnapshot,
    review: MissionWorkItem,
    events: MissionEvent[],
  ): void {
    events.push(this.event({ kind: 'work-item-status-changed', workItemId: review.id, status: 'accepted' }));
    if (review.kind === 'final-review') {
      events.push(this.event({ kind: 'mission-status-changed', status: 'completed' }));
      return;
    }
    const objectiveId = review.reviewTargetId!;
    for (const runtime of currentObjectiveExecution(before, objectiveId)) {
      if (runtime.status === 'submitted') {
        events.push(this.event({ kind: 'work-item-status-changed', workItemId: runtime.definition.id, status: 'accepted' }));
      }
    }
    events.push(this.event({ kind: 'work-item-status-changed', workItemId: objectiveId, status: 'accepted' }));
    const snapshot = this.preview(missionId, events);
    if (objectiveIds(snapshot).every((id) => snapshot.workItems[id]?.status === 'accepted')) {
      this.addFinalReview(missionId, events);
    } else {
      events.push(this.event({ kind: 'mission-status-changed', status: 'running' }));
    }
  }

  private addFinalReview(missionId: string, events: MissionEvent[]): void {
    const snapshot = this.preview(missionId, events);
    if (runtimeItems(snapshot).length + 1 > snapshot.spec.policy.maxWorkItems) {
      events.push(this.event({
        kind: 'mission-status-changed', status: 'failed',
        reason: 'Mission maxWorkItems exceeded by final review',
      }));
      return;
    }
    const count = runtimeItems(snapshot).filter((runtime) => runtime.definition.kind === 'final-review').length;
    const item: MissionWorkItem = {
      id: uniqueId(snapshot, `final-review-${count}`, new Set()),
      kind: 'final-review',
      title: `Supervision finale : ${snapshot.spec.title}`,
      prompt: 'Contrôler indépendamment la mission complète, ses preuves et ses critères, puis rendre un verdict structuré.',
      dependsOn: objectiveIds(snapshot),
      reviewTargetId: snapshot.spec.id,
      acceptanceCriteria: snapshot.spec.acceptanceCriteria,
      requiredEvidence: [],
      agentProfileId: snapshot.spec.supervisorProfileId,
      effect: 'read',
    };
    events.push(this.event({ kind: 'work-item-added', item }));
    events.push(this.event({ kind: 'mission-status-changed', status: 'final-review' }));
  }

  private applyFailure(
    missionId: string,
    before: MissionSnapshot,
    review: MissionWorkItem,
    verdict: StructuredMissionVerdict,
    events: MissionEvent[],
  ): void {
    events.push(this.event({
      kind: 'work-item-status-changed', workItemId: review.id, status: 'rejected', reason: verdict.summary,
    }));
    const affected = this.expandAffectedFrontier(before, verdict.affectedWorkItemIds);
    const affectedObjectives = new Set(affected.map((id) => objectiveForWork(before, id)));
    const cycles = new Map<string, number>();
    for (const objectiveId of affectedObjectives) {
      const cycle = (before.correctionCycles[objectiveId] ?? 0) + 1;
      if (cycle > before.spec.policy.maxCorrectionCycles) {
        events.push(this.event({
          kind: 'mission-status-changed', status: 'failed',
          reason: `Correction limit exceeded for objective "${objectiveId}"`,
        }));
        return;
      }
      cycles.set(objectiveId, cycle);
      events.push(this.event({ kind: 'correction-cycle-started', objectiveId, cycle }));
      events.push(this.event({ kind: 'work-item-status-changed', workItemId: objectiveId, status: 'rejected', reason: verdict.summary }));
    }
    if (runtimeItems(before).length + affected.length > before.spec.policy.maxWorkItems) {
      events.push(this.event({ kind: 'mission-status-changed', status: 'failed', reason: 'Mission maxWorkItems exceeded by corrections' }));
      return;
    }

    const reserved = new Set<string>();
    const replacements = new Map<string, string>();
    for (const id of affected) {
      const cycle = cycles.get(objectiveForWork(before, id))!;
      replacements.set(id, uniqueId(before, `${id}-fix-${cycle}`, reserved));
    }
    const briefs = new Map(verdict.corrections.map((brief) => [brief.correctsWorkItemId, brief]));
    for (const id of affected) {
      events.push(this.event({ kind: 'work-item-status-changed', workItemId: id, status: 'superseded', reason: verdict.summary }));
      const original = before.workItems[id]!.definition;
      const brief = briefs.get(id);
      const item: MissionWorkItem = {
        ...original,
        id: replacements.get(id)!,
        kind: 'correction',
        title: brief?.title ?? `Correction : ${original.title}`,
        prompt: brief?.prompt ?? `Corriger le travail "${original.title}" après ce rejet : ${verdict.summary}\n\nConsigne initiale : ${original.prompt ?? original.title}`,
        dependsOn: original.dependsOn.map((dependency) => replacements.get(dependency) ?? currentReplacement(before, dependency).definition.id),
        correctsWorkItemId: id,
        reviewTargetId: undefined,
        acceptanceCriteria: brief?.acceptanceCriteria ?? original.acceptanceCriteria,
        agentProfileId: brief?.agentProfileId ?? original.agentProfileId ?? before.spec.defaultWorkerProfileId,
      };
      events.push(this.event({ kind: 'work-item-added', item }));
    }
    events.push(this.event({ kind: 'mission-status-changed', status: 'correcting', reason: verdict.summary }));
  }

  private expandAffectedFrontier(snapshot: MissionSnapshot, initial: readonly string[]): string[] {
    const affected = new Set(initial);
    let changed = true;
    while (changed) {
      changed = false;
      for (const runtime of runtimeItems(snapshot)) {
        if (!isExecution(runtime.definition) || runtime.status === 'superseded' || affected.has(runtime.definition.id)) continue;
        if (runtime.definition.dependsOn.some((dependency) => affected.has(currentReplacement(snapshot, dependency).definition.id))) {
          affected.add(runtime.definition.id);
          changed = true;
        }
      }
    }
    return runtimeItems(snapshot)
      .map((runtime) => runtime.definition.id)
      .filter((id) => affected.has(id));
  }
}
