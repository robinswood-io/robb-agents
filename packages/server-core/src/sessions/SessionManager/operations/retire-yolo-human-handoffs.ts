import type { PendingTurnRecovery } from '../../../../../shared/src/sessions/types/turn-recovery.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import type { ManagedSession } from '../managed-session.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo, stopYoloHumanHandoff as sessionOpStopYoloHumanHandoff } from './is-managed-session-yolo.ts';
import { cancelPendingAuthForHumanContinuation as sessionOpCancelPendingAuthForHumanContinuation } from './downgrade-cold-auth-resume-permission.ts';
import { markPermissionToolNotExecuted as sessionOpMarkPermissionToolNotExecuted } from './expire-pending-permission-request.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { emitUserInputChanged as sessionOpEmitUserInputChanged } from './perform-request-user-input.ts';

async function sessionOpRetireYoloHumanHandoffs(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<boolean> {
    if (!sessionOpIsManagedSessionYolo(sessionOperationContext, managed) || managed.stopRequested
        || managed.isProcessing || managed.agent?.isProcessing())
        return false;
    const questions = (managed.userInputRequests ?? []).filter(request => request.status === 'pending'
        && request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id
        && !request.responseMessageId && !request.answers && !sessionOperationContext.state.userInputResponsesInFlight.has(request.id));
    const hasAuth = !!managed.pendingAuthRequestId || !!managed.pendingAuthRequest;
    const permissionWait = managed.pendingTurnRecovery?.waitingForPermission;
    if (questions.length === 0 && !hasAuth && !permissionWait)
        return false;
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || !sessionOpIsManagedSessionYolo(sessionOperationContext, managed)
        || managed.stopRequested || managed.isProcessing || managed.agent?.isProcessing())
        return false;
    const objective = managed.activeObjective;
    let cancelled = 0;
    for (const request of questions) {
        if (request.status !== 'pending' || request.responseMessageId || request.answers
            || sessionOperationContext.state.userInputResponsesInFlight.has(request.id))
            continue;
        request.status = 'cancelled';
        request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
        cancelled++;
    }
    const authCancelled = sessionOpCancelPendingAuthForHumanContinuation(sessionOperationContext, managed);
    if (permissionWait && managed.pendingTurnRecovery?.waitingForPermission === permissionWait) {
        sessionOpMarkPermissionToolNotExecuted(sessionOperationContext, managed, permissionWait);
        managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({ ...managed.pendingTurnRecovery, waitingForPermission: undefined });
    }
    if (!cancelled && !authCancelled && !permissionWait)
        return false;
    const pending = managed.pendingTurnRecovery;
    const resumable = !!objective && (objective.terminalState === 'active' || objective.terminalState === 'blocked_human')
        && !!pending && !pending.exhaustedAt && !pending.budgetHistoryUnavailable
        && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending);
    if (resumable) {
        objective.terminalState = 'active';
        delete objective.completedAt;
        managed.pendingTurnRecovery = { ...pending, continuationRequired: true, lastCause: 'app_restart' };
    }
    else if (objective?.terminalState === 'blocked_human') {
        objective.terminalState = 'exhausted';
        objective.completedAt = Date.now();
    }
    sessionOpRecordAutonomyEvent(sessionOperationContext, managed, { phase: 'diagnosis',
        message: 'YOLO cancelled an unanswered legacy human handoff without manufacturing a response, access or authority. Existing recovery budgets and tool results were retained.' });
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOpEmitUserInputChanged(sessionOperationContext, managed);
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.activeObjective !== objective
        || !sessionOpIsManagedSessionYolo(sessionOperationContext, managed) || managed.isProcessing || managed.stopRequested)
        return true;
    if (resumable) {
        const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'app_restart');
        if (queued)
            return true;
    }
    await sessionOpStopYoloHumanHandoff(sessionOperationContext, managed, 'YOLO legacy handoff was closed, but no authorized recovery allowance remains. The objective is incomplete and existing effects were not replayed.');
    return true;
}

export { sessionOpRetireYoloHumanHandoffs as retireYoloHumanHandoffs };
