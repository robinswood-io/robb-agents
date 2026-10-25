import { previewMissionReplan, type MissionExecutionBinding, type MissionAttemptTelemetry, type MissionSnapshot, type MissionWorkItem, type MissionWorkItemRuntime, type WorkSubmission, type MissionReplanPreview } from "@craft-agent/shared/missions";

export const EXECUTION_KINDS = new Set(['task', 'subtask', 'integration', 'correction']);

export const REVIEW_KINDS = new Set(['objective-review', 'final-review']);

export const TERMINAL_MISSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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

export interface MissionRuntimeLimitAttempt {
    workItemId: string;
    dispatchId: string;
    telemetry: MissionAttemptTelemetry;
}

export function runtimeItems(snapshot: MissionSnapshot): MissionWorkItemRuntime[] {
    return Object.values(snapshot.workItems);
}

export function isExecution(item: MissionWorkItem): boolean {
    return EXECUTION_KINDS.has(item.kind);
}

export function isReview(item: MissionWorkItem): boolean {
    return REVIEW_KINDS.has(item.kind);
}

export function profileFor(snapshot: MissionSnapshot, item: MissionWorkItem): string {
    if (item.kind === 'objective-review')
        return snapshot.spec.reviewerProfileId;
    if (item.kind === 'final-review')
        return snapshot.spec.supervisorProfileId;
    return item.agentProfileId ?? snapshot.spec.defaultWorkerProfileId;
}

export function replacementFor(snapshot: MissionSnapshot, workItemId: string): MissionWorkItemRuntime | undefined {
    return runtimeItems(snapshot).find((candidate) => candidate.definition.correctsWorkItemId === workItemId);
}

export function currentReplacement(snapshot: MissionSnapshot, workItemId: string): MissionWorkItemRuntime {
    let current = snapshot.workItems[workItemId];
    if (!current)
        throw new Error(`Unknown work item "${workItemId}"`);
    const seen = new Set<string>();
    while (current.status === 'superseded') {
        if (seen.has(current.definition.id))
            throw new Error(`Correction lineage cycle at "${current.definition.id}"`);
        seen.add(current.definition.id);
        const replacement = replacementFor(snapshot, current.definition.id);
        if (!replacement)
            throw new Error(`Superseded work item "${current.definition.id}" has no correction`);
        current = replacement;
    }
    return current;
}

export function dependencySatisfied(snapshot: MissionSnapshot, dependencyId: string): boolean {
    const dependency = currentReplacement(snapshot, dependencyId);
    if (dependency.definition.kind === 'objective')
        return dependency.status === 'accepted';
    return dependency.status === 'submitted' || dependency.status === 'accepted';
}

export function currentObjectiveExecution(snapshot: MissionSnapshot, objectiveId: string): MissionWorkItemRuntime[] {
    return runtimeItems(snapshot).filter((runtime) => runtime.definition.objectiveId === objectiveId && isExecution(runtime.definition) && runtime.status !== 'superseded');
}

export function objectiveIds(snapshot: MissionSnapshot): string[] {
    return runtimeItems(snapshot)
        .filter((runtime) => runtime.definition.kind === 'objective')
        .map((runtime) => runtime.definition.id);
}

export function objectiveForWork(snapshot: MissionSnapshot, workItemId: string): string {
    const item = snapshot.workItems[workItemId];
    if (!item || !isExecution(item.definition) || !item.definition.objectiveId) {
        throw new Error(`Affected work item "${workItemId}" is not executable objective work`);
    }
    return item.definition.objectiveId;
}

export function uniqueId(snapshot: MissionSnapshot, base: string, reserved: Set<string>): string {
    let candidate = base;
    let suffix = 2;
    while (snapshot.workItems[candidate] || reserved.has(candidate))
        candidate = `${base}-${suffix++}`;
    reserved.add(candidate);
    return candidate;
}

export function hasReconciledMutationReceipt(runtime: MissionWorkItemRuntime): boolean {
    const requirementId = runtime.definition.connectorInvocation?.receiptRequirementId;
    if (!requirementId || !runtime.submission)
        return false;
    return runtime.submission.evidence.some((evidence) => evidence.requirementId === requirementId
        && evidence.kind === 'receipt'
        && typeof evidence.sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(evidence.sha256));
}

export function sameConnectorInvocation(left: MissionWorkItem, right: MissionWorkItem): boolean {
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
    const active = runtimeItems(snapshot).filter((runtime) => runtime.status === 'reserved' || runtime.status === 'running');
    if (active.length > 0) {
        throw new Error(`Mission replan refused while work leases are active: ${active.map(({ definition }) => definition.id).sort().join(', ')}`);
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
        if (runtime.definition.effect !== 'external-mutation' || runtime.attempt === 0)
            continue;
        if (!hasReconciledMutationReceipt(runtime)) {
            if (runtime.lastAttemptAmbiguousMutation === false)
                continue;
            throw new Error(`Mission replan refused: external mutation "${runtime.definition.id}" is not durably reconciled`);
        }
        if (!invalidated.has(runtime.definition.id))
            continue;
        const replacement = proposed.get(runtime.definition.id);
        if (!replacement || !sameConnectorInvocation(runtime.definition, replacement)) {
            throw new Error(`Mission replan refused: reconciled mutation "${runtime.definition.id}" requires explicit compensation before removal or invocation change`);
        }
    }
    return preview;
}
